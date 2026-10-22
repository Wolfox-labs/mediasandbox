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
import {
  describeAlignment,
  planBlueprint,
  type BlueprintOutcome,
} from '../plan/blueprint.js';
import { createBlockRegistry, type BlockRegistry, type BlockSpec } from './block-spec.js';
import { normalizePageSpec, validatePageSpec, type PageSpec } from './page-spec.js';
import { StructurePlanner, type PlanStructureResult } from './planner.js';
import type { AssembleRequest, AssembleResult } from '../plan/assembler.js';

/** 结构化链路用到的工具 id。 */
const T = {
  writePage: 'write-page-copy',
  fillBlock: 'fill-block',
  assemblePage: 'assemble-page',
  passthrough: 'passthrough-block',
  verify: 'verify-artifact',
  screenshot: 'screenshot-page',
} as const;

/** 生成节点 id：按序号 + 工具 id，稳定可读。 */
function nodeId(index: number, toolId: string): string {
  return `n${index + 1}-${toolId}`;
}

/** 统筹计划的纯文本摘要，给执笔当上下文。没有计划时返回空串。 */
function describeBlueprint(blueprint: BlueprintOutcome | undefined): string {
  if (blueprint === undefined || !blueprint.ok) return '';
  const { title, positioning, sections } = blueprint.blueprint;
  const parts: string[] = [];
  if (title !== '') parts.push(`标题：${title}`);
  if (positioning !== '') parts.push(`定位：${positioning}`);
  if (sections.length > 0) {
    parts.push(`段落：\n${sections.map((s, i) => `${i + 1}. ${s.purpose}`).join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * 执行结构化链路。
 *
 * 步骤：
 *   1. 逐块问决策模型，拿到 `PageSpec`（结构是数据）
 *   2. 每块一个 `fill-block` 节点，彼此**无依赖** → 执行器会并发跑
 *   3. 一个 `assemble-page` 节点，用 `refs` 扇入全部块的产出
 *   4. 决策层要校验就追加 `verify-artifact`
 *   5. **显式要求**才追加 `screenshot-page`（默认不跑：截图不是必需品）
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

  // ── 0. 统筹规划：大语言模型先出一份计划 ───────────────────────────────
  //
  // 放在逐块决策**之前**：决策模型的每一轮都带着这份计划（见 `buildContext`
  // 里的 facts），于是它的选择是"按计划排"，而不是"每轮自由发挥"。
  // 这一步不改结构——它只写"要讲哪几段"，选块仍然由决策层回答。
  const blueprint = request.template === undefined ? await resolveBlueprint(request, blocks) : undefined;
  const rationale: string[] = [];
  if (blueprint !== undefined) {
    rationale.push(
      blueprint.ok
        ? `统筹规划（${blueprint.blueprint.model}）：${blueprint.blueprint.status === 'lenient' ? '按非 JSON 返回宽松解析' : 'JSON 契约'}，` +
            `${blueprint.blueprint.sections.length} 段 —— ${blueprint.blueprint.sections
              .map((s) => s.purpose)
              .join(' → ')}`
        : `统筹规划不可用：${blueprint.detail}。本次直接逐块决策，没有整体计划`,
    );
  } else if (request.template !== undefined) {
    // 固定模板已经把块序定死了，统筹规划只能重复一遍模板里写好的东西。
    // 省掉这一趟：网页约 20 秒、演示文稿约 30 秒。
    rationale.push('固定模板：跳过统筹规划（块序来自模板，不需要再让模型分段）');
  }

  // ── 1. 定稿结构：给定的照用，没给才逐块问决策模型 ────────────────────
  //
  // 「带指定 PageSpec 重跑」走上面那条：用户改完结构（或只想按同一结构再跑一次）时，
  // 不该再让模型把结构决定一遍——那等于把用户的编辑丢掉。
  const planner = new StructurePlanner(blocks, decision);
  const planned: PlanStructureResult =
    request.pageSpec !== undefined
      ? planFromGivenSpec(request.pageSpec, request, blocks)
      : await planner.plan({
          projectId: request.projectId ?? '(unset)',
          goal: request.goal,
          candidateBlockIds: resolveCandidates(request.candidateBlockIds, blocks),
          ...(request.maxBlocks !== undefined ? { maxBlocks: request.maxBlocks } : {}),
          // 让规划器知道"这次有没有生成层可用"：有才会去问 `slot_source`。
          // 没生成层的时候问"要不要生成式"是个空问题，白花一次决策往返。
          ...(request.useGenerative !== undefined ? { useGenerative: request.useGenerative } : {}),
          ...(request.template !== undefined ? { template: request.template } : {}),
          ...(blueprint !== undefined && blueprint.ok ? { blueprint: blueprint.blueprint } : {}),
          ...(request.context.constraints !== undefined
            ? { constraints: request.context.constraints }
            : {}),
          ...(request.decisionTimeoutMs !== undefined
            ? { decisionTimeoutMs: request.decisionTimeoutMs }
            : {}),
        });

  const page = planned.page;
  rationale.push(...planned.rationale);

  // 计划与实际结构的对照。**只在真的规划过时算**——没有计划就无所谓对上不上。
  if (blueprint !== undefined && blueprint.ok) {
    rationale.push(describeAlignment(blueprint.blueprint, page.blocks.length).detail);
  }
  rationale.push(
    `结构化链路：${page.blocks.length} 个 block 节点并发填充，扇入 assemble-page`,
  );

  // ── 2. 每块一个节点，无依赖 → 同层并发 ───────────────────────────────
  //
  // **定点重做**：给了 `redoBlockIds` 时，只有被点名的块挂填充节点，
  // 其余块挂**透传**节点——它们的内容已经在结构里了，再填一遍既花钱又可能把
  // 好内容改坏。透传节点同样是"零依赖"，所以扇入顺序不变。
  const redo = request.redoBlockIds === undefined ? undefined : new Set(request.redoBlockIds);
  if (redo !== undefined && !registry.has(T.passthrough)) {
    throw new PlanError(
      `定点重做需要工具 ${T.passthrough}，但它未注册。结构化链路必须注册 STRUCTURED_TOOLS`,
      'UNKNOWN_TOOL',
    );
  }

  const nodes: PlanNode[] = [];
  let cursor = 0;
  const fillNodeIds: string[] = [];
  const skeleton = serializeSkeleton(page);

  // ── 1.5 一次执笔整页：一个节点写完整页文案 ──────────────────────────
  //
  // 逐 slot 调用是"11 次调用、两波并发"的根源：块内 4~5 个 slot 各自独立，
  // 模型看不到邻居，行文还不连贯。这里先花一次调用写整页，
  // 填充节点拿它的结果（`written`），只有没覆盖到的 slot 才回落到逐 slot。
  let writeNodeId: string | undefined;
  if (request.useGenerative === true) {
    const writeBlocks =
      redo === undefined ? page.blocks : page.blocks.filter((b) => redo.has(b.id));
    if (writeBlocks.length > 0) {
      writeNodeId = nodeId(cursor, T.writePage);
      cursor += 1;
      nodes.push({
        id: writeNodeId,
        toolId: T.writePage,
        inputs: {
          blocksJson: { kind: 'literal', value: JSON.stringify(writeBlocks) },
          goal: { kind: 'literal', value: request.goal },
          brand: { kind: 'literal', value: request.brand ?? '' },
          planText: { kind: 'literal', value: describeBlueprint(blueprint) },
        },
        dependsOn: [],
        retryable: true,
        note: '一次执笔整页文案',
      });
      rationale.push(
        `执笔：整页文案一次写完（1 次生成调用，替代 ${writeBlocks.length} 块的逐 slot 调用）`,
      );
    }
  }

  for (const [index, block] of page.blocks.entries()) {
    // 没给 `redoBlockIds` 时全部照常填充；给了就只填被点名的。
    const mustFill = redo === undefined || redo.has(block.id);
    const toolId = mustFill ? T.fillBlock : T.passthrough;
    const blockJson = JSON.stringify(block);
    const id = nodeId(cursor, toolId);
    fillNodeIds.push(id);
    nodes.push({
      id,
      toolId,
      inputs: mustFill
        ? {
            // 该块的 JSON 由 planner 产出后**冻结**成字面量。它是一条决策记录：
            // 结构是什么、决策层问了几个、都留在这里，便于复现与排查。
            blockJson: { kind: 'literal', value: blockJson },
            goal: { kind: 'literal', value: request.goal },
            brand: { kind: 'literal', value: request.brand ?? '' },
            index: { kind: 'literal', value: index },
            useGenerative: { kind: 'literal', value: request.useGenerative === true },
            ...(writeNodeId === undefined
              ? {}
              : { written: { kind: 'ref', nodeId: writeNodeId, port: 'written' } as const }),
          }
        : { blockJson: { kind: 'literal', value: blockJson } },
      // **空依赖**（没有执笔节点时）：块之间没有数据依赖，让执行器并发跑。
      // 有执笔节点时只依赖它一个——仍然是"块与块之间互不依赖"。
      dependsOn: mustFill && writeNodeId !== undefined ? [writeNodeId] : [],
      // 透传不会失败，不该占重试额度。
      retryable: mustFill,
      note: mustFill
        ? `填充区块 ${block.id}（${block.type}）`
        : `保留区块 ${block.id}（${block.type}）`,
    });
    cursor += 1;
  }

  if (redo !== undefined) {
    const kept = page.blocks.filter((b) => !redo.has(b.id)).length;
    rationale.push(
      `定点重做：只重填 ${page.blocks.length - kept} 块（${[...redo].join('、')}），` +
        `其余 ${kept} 块原样透传`,
    );
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

  // ── 5. 截图（**显式要求才挂**） ──────────────────────────────────────
  //
  // 默认不挂：截图要么花浏览器的钱（真驱动），要么多一个产物（占位驱动），
  // 而"默认零成本"是这个项目一贯的默认值。要求了就接在组装之后——
  // 它截的必须是**组装完成的那一页**。
  if (request.screenshot === true && registry.has(T.screenshot)) {
    nodes.push({
      id: nodeId(cursor, T.screenshot),
      toolId: T.screenshot,
      inputs: { file: { kind: 'literal', value: 'artifacts/index.html' } },
      dependsOn: [assembleNodeId],
      retryable: false,
      note: '把组装好的页面截成一张图',
    });
    rationale.push('追加 screenshot-page：按要求把页面截图写入 artifacts/');
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
        // 结构是谁定的，一行说清：重跑之后"模型是不是又改了结构"是必问的问题，
        // 而这个答案只能从留痕里读出来。
        source: request.pageSpec === undefined ? 'planned' : 'given',
      },
      steps: planned.steps,
      usage: planned.usage,
      decisionCalls: planned.decisionCalls,
      ...(blueprint !== undefined
        ? {
            blueprint: blueprint.ok
              ? {
                  title: blueprint.blueprint.title,
                  sections: blueprint.blueprint.sections.length,
                  status: blueprint.blueprint.status,
                  model: blueprint.blueprint.model,
                }
              : { unavailable: blueprint.detail },
          }
        : {}),
    },
    decisionLatencyMs: planned.decisionLatencyMs,
    structure: { page, steps: planned.steps },
    ...(blueprint !== undefined ? { blueprint } : {}),
  };
}

/**
 * 拿到统筹规划。
 *
 * 四种情况分开处理，不合并成"有/没有"：
 *
 *   1. 调用方已经给了一份 → 直接用，**不再花生成额度**
 *   2. 没有生成层（`llm` 未配置）→ 返回 `undefined`，这不是失败，
 *      零成本路径本来就没有大模型可调用
 *   3. 调用方明确关掉 → 返回 ok:false 并说明"按要求关闭"，
 *      让留痕里能看出"这里没有规划是人为的"
 *   4. 有生成层 → 真跑一次；失败也返回 ok:false 并带上原因
 *
 * 第 3/4 种都返回 `ok: false` 而不是 `undefined`：`undefined` 的意思是
 * "这条路不适用"，`ok:false` 是"试了但没成/被关掉"，两者在界面上要说不同的话。
 */
async function resolveBlueprint(
  request: AssembleRequest,
  blocks: BlockRegistry,
): Promise<BlueprintOutcome | undefined> {
  if (request.blueprint !== undefined) {
    return { ok: true, blueprint: request.blueprint };
  }
  if (request.llm === undefined) return undefined;
  if (request.useBlueprint === false) {
    return { ok: false, detail: '本次按要求关闭了统筹规划' };
  }

  const candidateIds = resolveCandidates(request.candidateBlockIds, blocks);
  return await planBlueprint({
    llm: request.llm,
    goal: request.goal,
    envType: 'webpage',
    blocks: candidateIds.map((id) => blocks.get(id)),
    ...(request.context.constraints !== undefined
      ? { constraints: request.context.constraints }
      : {}),
    ...(request.tone !== undefined ? { tone: request.tone } : {}),
    ...(request.template !== undefined
      ? { templateLabel: `${request.template.label}（${request.template.id}）` }
      : {}),
    ...(request.blueprintTimeoutMs !== undefined
      ? { timeoutMs: request.blueprintTimeoutMs }
      : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
}

/**
 * 既定结构 → 与规划器等价的产出。
 *
 * ## 不绕过校验与规范化
 *
 * 给定结构同样要过 `validatePageSpec`（类型在池子里、slot 形态对得上、
 * 不可重复的没重复）与 `normalizePageSpec`（两端块归位）。绕过它们，等于开了
 * 一条"手写结构就能排出版式错误"的后门——而用户手工编辑恰恰最需要这道兜底。
 *
 * ## 为什么一个决策问题都不问
 *
 * "照给定结构重跑"的全部意义就是**结构不由模型决定**。再问一轮 `slot_source`
 * 只会白花往返，还会让"这次重跑到底改没改结构"说不清。
 * 块里已经记着的 `slotPlans` 照常被填充器读走，所以生成式/确定性的选择不会丢。
 *
 * ## 三处对齐
 *
 * `projectId` 与 `goal` 对齐到**本次请求**：结构是上一次的产出，而这次要按这次的
 * 目标填内容、把页面写进这次的沙盒。不对齐的话，产物会带着上一个项目的标识、
 * 文案也停在旧目标上。`templateId` 与 `qualityScore` 是留痕，原样带过去。
 */
function planFromGivenSpec(
  given: PageSpec,
  request: AssembleRequest,
  blocks: BlockRegistry,
): PlanStructureResult {
  const page: PageSpec = {
    ...given,
    projectId: request.projectId ?? given.projectId,
    goal: request.goal,
  };

  validatePageSpec(page, blocks);
  const { page: normalized, fixes } = normalizePageSpec(page, blocks);

  const rationale = [
    `结构由调用方给定（${normalized.blocks.length} 块），本次不向决策层提问`,
    ...fixes.map((fix) => `版式规范化：${fix.detail}`),
  ];

  return {
    page: normalized,
    // **没有决策轮次就没有留痕**：编一条"问过了"只会让留痕骗人，
    // 而留痕的全部价值就是"它能解释这次结构是怎么来的"。
    steps: [],
    rationale,
    decisionLatencyMs: 0,
    decisionCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    fixes,
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
