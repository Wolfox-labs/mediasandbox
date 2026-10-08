/**
 * 结构化链路的组装器：**决策答案 → 扇入 DAG**。
 *
 * 与单链组装（`assembler.ts` 的 `assemble`）的区别，一句话说清：
 *
 * ```
 * 单链（frontend 等）：  gen → refine? → finalize → verify?
 *                        一个主产出，链式推进，没有可并发的对象
 *
 * 结构化（webpage）：    fill(b1) ┐
 *                        fill(b2) ├─→ assemble → verify?
 *                        fill(b3) ┘
 *                        N 个独立节点并发，每块独立重试，扇入成页
 * ```
 *
 * **结构不是这里决定的**——它由 `StructurePlanner` 逐块问决策模型得出。
 * 本文件只做一件事：把已经定稿的结构，翻译成可执行、可静态校验的计划。
 * 这条分工与既有架构一致：模型只回答封闭问题，计划由确定性代码拼。
 */
import type { ToolRegistry } from '../tools/registry.js';
import type { DecisionClient } from '../decision/types.js';
import { PlanError, validatePlan, type ExecutionPlan, type PlanInput, type PlanNode } from '../plan/types.js';
import { createBlockRegistry, type BlockSpec } from './block-spec.js';
import type { PageSpec } from './page-spec.js';
import { StructurePlanner } from './planner.js';
import type { AssembleRequest, AssembleResult } from '../plan/assembler.js';

/** 结构化链路用到的工具 id。 */
const T = {
  fillBlock: 'fill-block',
  assemblePage: 'assemble-page',
  verify: 'verify-artifact',
} as const;

/** 生成节点 id：按序号 + 工具 id，稳定可读。 */
function nodeId(index: number, toolId: string): string {
  return `n${index + 1}-${toolId}`;
}

/**
 * 执行结构化链路。
 *
 * 步骤：
 *   1. 逐块问决策模型，拿到 `PageSpec`（结构是数据）
 *   2. 每块一个 `fill-block` 节点，彼此**无依赖** → 执行器会并发跑
 *   3. 一个 `assemble-page` 节点，用 `refs` 扇入全部块的产出
 *   4. 决策层要校验就追加 `verify-artifact`
 *
 * 第 2 步的"彼此无依赖"是有意的：同一层的节点在 `PlanExecutor` 里并发执行。
 * 若把它们串起来，就等于回到了"一个块失败了后面全不做"，
 * 而结构化制作的要点恰恰是**某一块坏了只重做那一块**。
 */
export async function assembleStructured(args: {
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly request: AssembleRequest;
  readonly excludeTools?: readonly string[];
}): Promise<AssembleResult> {
  const { registry, decision, request } = args;

  for (const id of [T.fillBlock, T.assemblePage]) {
    if (!registry.has(id)) {
      throw new PlanError(
        `webpage 环境需要工具 ${id}，但它未注册。结构化链路必须注册 STRUCTURED_TOOLS`,
        'UNKNOWN_TOOL',
      );
    }
  }

  // block 池由调用方给就用自己的：服务层装了外部来源（模型提议/手打/导入）的
  // block 时，池子必须是**同一个**，否则那些 block 在 `/api/blocks` 里看得见、
  // 在候选集里却永远不存在。省略时退回内置池，保持"不配也能跑通"。
  const blocks = args.request.blocks ?? createBlockRegistry();
  const candidates = resolveCandidates(request.candidateBlockIds, blocks);

  // ── 1. 逐块决策，定稿结构 ────────────────────────────────────────────
  const planner = new StructurePlanner(blocks, decision);
  const planned = await planner.plan({
    projectId: request.projectId ?? '(unset)',
    goal: request.goal,
    candidateBlockIds: candidates,
    ...(request.maxBlocks !== undefined ? { maxBlocks: request.maxBlocks } : {}),
    // 让规划器知道"这次有没有生成层可用"：有才会去问 `slot_source`。
    // 没生成层的时候问"要不要生成式"是个空问题，白花一次决策往返。
    ...(request.useGenerative !== undefined ? { useGenerative: request.useGenerative } : {}),
    ...(request.template !== undefined ? { template: request.template } : {}),
    ...(request.context.constraints !== undefined
      ? { constraints: request.context.constraints }
      : {}),
    ...(request.decisionTimeoutMs !== undefined
      ? { decisionTimeoutMs: request.decisionTimeoutMs }
      : {}),
  });

  const page = planned.page;
  const rationale = [...planned.rationale];
  rationale.push(
    `结构化链路：${page.blocks.length} 个 block 节点并发填充，扇入 assemble-page`,
  );

  // ── 2. 每块一个节点，无依赖 → 同层并发 ───────────────────────────────
  const nodes: PlanNode[] = [];
  let cursor = 0;
  const fillNodeIds: string[] = [];
  const skeleton = serializeSkeleton(page);

  for (const [index, block] of page.blocks.entries()) {
    const id = nodeId(cursor, T.fillBlock);
    fillNodeIds.push(id);
    nodes.push({
      id,
      toolId: T.fillBlock,
      inputs: {
        // 该块的 JSON 由 planner 产出后**冻结**成字面量。它是一条决策记录：
        // 结构是什么、决策层问了几个、都留在这里，便于复现与排查。
        blockJson: { kind: 'literal', value: JSON.stringify(block) },
        goal: { kind: 'literal', value: request.goal },
        brand: { kind: 'literal', value: request.brand ?? '' },
        index: { kind: 'literal', value: index },
        useGenerative: { kind: 'literal', value: request.useGenerative === true },
      },
      // **空依赖**：块之间没有数据依赖，让执行器并发跑。
      dependsOn: [],
      retryable: true,
      note: `填充区块 ${block.id}（${block.type}）`,
    });
    cursor += 1;
  }

  // ── 3. 扇入组装 ──────────────────────────────────────────────────────
  const assembleNodeId = nodeId(cursor, T.assemblePage);
  const blocksInput: PlanInput = {
    kind: 'refs',
    // **数组顺序就是页面顺序**。执行器按声明顺序取值，不做排序。
    refs: fillNodeIds.map((id) => ({ kind: 'ref', nodeId: id, port: 'block' })),
  };
  nodes.push({
    id: assembleNodeId,
    toolId: T.assemblePage,
    inputs: {
      pageJson: { kind: 'literal', value: skeleton },
      blocks: blocksInput,
      title: { kind: 'literal', value: request.goal },
      annotate: { kind: 'literal', value: request.annotate === true },
    },
    dependsOn: [...fillNodeIds],
    retryable: false,
    note: '按顺序组装为完整页面',
  });
  cursor += 1;

  // ── 4. 校验 ──────────────────────────────────────────────────────────
  if (registry.has(T.verify)) {
    nodes.push({
      id: nodeId(cursor, T.verify),
      toolId: T.verify,
      inputs: { minFiles: { kind: 'literal', value: Math.max(1, request.minArtifacts ?? 1) } },
      dependsOn: [assembleNodeId],
      retryable: false,
      note: '校验产物非空',
    });
    rationale.push('追加 verify-artifact：确认 artifacts/ 下有非空产物');
    cursor += 1;
  }

  const plan: ExecutionPlan = { envType: 'webpage', nodes, rationale, createdAt: Date.now() };
  validatePlan(plan, registry);

  return {
    plan,
    answers: {
      structure: {
        blocks: page.blocks.map((b) => ({ id: b.id, type: b.type })),
        qualityScore: page.qualityScore,
      },
      steps: planned.steps,
      usage: planned.usage,
      decisionCalls: planned.decisionCalls,
    },
    decisionLatencyMs: planned.decisionLatencyMs,
    structure: { page, steps: planned.steps },
  };
}

/**
 * 候选 block 的解析。
 *
 * 未指定时用**池子里的全部**——这样默认就能跑通，不必先配一遍候选集。
 * 用户指定时逐个校验存在性：外部来源（模型提议/手打/导入）的 block 若没注册过，
 * 在这里就拦下，而不是让它进候选集、等决策模型选中、再到执行期才失败。
 */
function resolveCandidates(
  requested: readonly string[] | undefined,
  registry: ReturnType<typeof createBlockRegistry>,
): string[] {
  if (requested === undefined || requested.length === 0) {
    return registry.specs().map((s: BlockSpec) => s.id);
  }
  for (const id of requested) {
    if (!registry.has(id)) {
      throw new PlanError(
        `候选 block ${id} 未注册。模型提议、用户手打、导入的 block 都必须先经注册校验`,
        'UNKNOWN_TOOL',
      );
    }
  }
  return [...requested];
}

/**
 * 把页面骨架序列化给 `assemble-page`。
 *
 * 刻意**只带结构、不带已填内容**：块的内容由各 `fill-block` 节点产出，
 * 再扇入进来。若这里也塞一份内容，就有两个真相来源，
 * 而"谁覆盖谁"在并发下是不确定的。
 */
function serializeSkeleton(page: PageSpec): string {
  return JSON.stringify(page);
}
