/**
 * 演示文稿链路的组装器：**决策答案 → 多页 DAG**。
 *
 * 形状与网页链路同构，只是节点换了：
 *
 * ```
 * fill-slide(第1页) ┐
 * fill-slide(第2页) ├─→ assemble-deck → verify-artifact
 * fill-slide(第3页) ┘
 * ```
 *
 * ## 与网页链路真正不同的三件事
 *
 * 1. **单元是版式，不是页面区块**。候选池是 `createSlideRegistry()`，
 *    决策层回答的是"下一**页**用什么版式"。
 * 2. **一页一块的映射是 1:1**。网页上"多块拼成一页"，这里"一页就是一个版式"——
 *    所以没有 `assemble-page` 那种"把 N 块按顺序拼"的语义，
 *    只有"把 N 页按顺序排成一份文稿"。
 * 3. **产物是两件**：`artifacts/deck.html`（可放映）与 `artifacts/deck.json`（结构）。
 *
 * ## 统筹规划照旧先跑
 *
 * 大语言模型先出"这份文稿要讲哪几段"，决策模型再按计划逐页选版式。
 * 两个模型的分工与网页链路完全一致——这是加模态时**不该变**的那部分。
 */
import type { ToolRegistry } from '../tools/registry.js';
import type { DecisionClient } from '../decision/types.js';
import { PlanError, validatePlan, type ExecutionPlan, type PlanInput, type PlanNode } from '../plan/types.js';
import { describeAlignment, planBlueprint, type BlueprintOutcome } from '../plan/blueprint.js';
import { createSlideRegistry } from './deck-spec.js';
import { DECK_TOOLS } from './deck-tools.js';
import { normalizePageSpec, validatePageSpec, type PageSpec } from './page-spec.js';
import { StructurePlanner, type PlanStructureResult } from './planner.js';
import type { BlockRegistry, BlockSpec } from './block-spec.js';
import type { AssembleRequest, AssembleResult } from '../plan/assembler.js';

/** 生成节点 id：按序号 + 工具 id，稳定可读。 */
function nodeId(index: number, toolId: string): string {
  return `n${index + 1}-${toolId}`;
}

/**
 * 执行演示文稿链路。
 *
 * 步骤与网页链路一一对应，便于对照阅读：
 *   1. 统筹规划（大语言模型出整体计划）
 *   2. 逐页问决策模型：这一页用什么版式（结构是数据）
 *   3. 每页一个 `fill-slide` 节点，彼此**无依赖** → 并发跑
 *   4. 一个 `assemble-deck` 节点扇入全部页
 *   5. `verify-artifact` 确认产物非空
 *   6. **显式要求**才追加 `screenshot-deck`
 */
export async function assembleDeck(args: {
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly request: AssembleRequest;
  readonly excludeTools?: readonly string[];
}): Promise<AssembleResult> {
  const { registry, decision, request } = args;

  for (const id of [DECK_TOOLS.fillSlide, DECK_TOOLS.assembleDeck]) {
    if (!registry.has(id)) {
      throw new PlanError(
        `slides 环境需要工具 ${id}，但它未注册。演示文稿链路必须注册 createDeckTools()`,
        'UNKNOWN_TOOL',
      );
    }
  }

  const layouts = request.slideLayouts ?? createSlideRegistry();

  // ── 0. 统筹规划 ────────────────────────────────────────────────────────
  const blueprint = await resolveBlueprint(request, layouts);
  const rationale: string[] = [];
  if (blueprint !== undefined) {
    rationale.push(
      blueprint.ok
        ? `统筹规划（${blueprint.blueprint.model}）：${blueprint.blueprint.status === 'lenient' ? '按非 JSON 返回宽松解析' : 'JSON 契约'}，` +
            `${blueprint.blueprint.sections.length} 段 —— ${blueprint.blueprint.sections.map((s) => s.purpose).join(' → ')}`
        : `统筹规划不可用：${blueprint.detail}。本次直接逐页决策，没有整体计划`,
    );
  }

  // ── 1. 定稿页序：给定的照用，没给才逐页问决策模型 ──────────────────────
  const planner = new StructurePlanner(layouts, decision);
  const planned: PlanStructureResult =
    request.pageSpec !== undefined
      ? planDeckFromGivenSpec(request.pageSpec, request, layouts)
      : await planner.plan({
          projectId: request.projectId ?? '(unset)',
          goal: request.goal,
          envType: 'slides',
          // 文稿的页数上限比网页的块数上限宽：一份演示文稿十几页很正常。
          maxBlocks: request.maxBlocks ?? 12,
          candidateBlockIds: resolveCandidates(request.candidateBlockIds, layouts),
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

  const deck = planned.page;
  rationale.push(...planned.rationale);
  if (blueprint !== undefined && blueprint.ok) {
    rationale.push(describeAlignment(blueprint.blueprint, deck.blocks.length).detail);
  }
  rationale.push(`演示文稿链路：${deck.blocks.length} 个页节点并发填充，扇入 assemble-deck`);

  // ── 2. 每页一个节点，无依赖 → 同层并发 ────────────────────────────────
  const nodes: PlanNode[] = [];
  let cursor = 0;
  const pageNodeIds: string[] = [];
  const skeleton = JSON.stringify(deck);

  for (const [index, page] of deck.blocks.entries()) {
    const id = nodeId(cursor, DECK_TOOLS.fillSlide);
    pageNodeIds.push(id);
    nodes.push({
      id,
      toolId: DECK_TOOLS.fillSlide,
      inputs: {
        // 该页的 JSON 由 planner 产出后**冻结**成字面量：它是一条决策记录。
        slideJson: { kind: 'literal', value: JSON.stringify(page) },
        goal: { kind: 'literal', value: request.goal },
        brand: { kind: 'literal', value: request.brand ?? '' },
        index: { kind: 'literal', value: index },
        useGenerative: { kind: 'literal', value: request.useGenerative === true },
      },
      dependsOn: [],
      retryable: true,
      note: `填充第 ${index + 1} 页（${page.type}）`,
    });
    cursor += 1;
  }

  // ── 3. 扇入组装 ────────────────────────────────────────────────────────
  const assembleNodeId = nodeId(cursor, DECK_TOOLS.assembleDeck);
  const slidesInput: PlanInput = {
    kind: 'refs',
    // **数组顺序就是页序**。执行器按声明顺序取值，不做排序。
    refs: pageNodeIds.map((id) => ({ kind: 'ref', nodeId: id, port: 'slide' })),
  };
  nodes.push({
    id: assembleNodeId,
    toolId: DECK_TOOLS.assembleDeck,
    inputs: {
      deckJson: { kind: 'literal', value: skeleton },
      slides: slidesInput,
      title: { kind: 'literal', value: request.goal },
    },
    dependsOn: [...pageNodeIds],
    retryable: false,
    note: '按页序组装为一份可放映的演示文稿',
  });
  cursor += 1;

  // ── 4. 校验 ────────────────────────────────────────────────────────────
  if (registry.has('verify-artifact')) {
    nodes.push({
      id: nodeId(cursor, 'verify-artifact'),
      toolId: 'verify-artifact',
      inputs: { minFiles: { kind: 'literal', value: Math.max(1, request.minArtifacts ?? 2) } },
      dependsOn: [assembleNodeId],
      retryable: false,
      note: '校验产物非空',
    });
    rationale.push('追加 verify-artifact：确认 artifacts/ 下有非空产物');
    cursor += 1;
  }

  // ── 5. 首屏截图（**显式要求才挂**） ────────────────────────────────────
  if (request.screenshot === true && registry.has(DECK_TOOLS.screenshot)) {
    nodes.push({
      id: nodeId(cursor, DECK_TOOLS.screenshot),
      toolId: DECK_TOOLS.screenshot,
      inputs: { file: { kind: 'literal', value: 'artifacts/deck.html' } },
      dependsOn: [assembleNodeId],
      retryable: false,
      note: '把文稿首页截成一张图',
    });
    rationale.push('追加 screenshot-deck：按要求把首页截图写入 artifacts/');
    cursor += 1;
  }

  const plan: ExecutionPlan = { envType: 'slides', nodes, rationale, createdAt: Date.now() };
  validatePlan(plan, registry);

  return {
    plan,
    answers: {
      structure: {
        blocks: deck.blocks.map((b) => ({ id: b.id, type: b.type })),
        qualityScore: deck.qualityScore,
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
    structure: { page: deck, steps: planned.steps },
    ...(blueprint !== undefined ? { blueprint } : {}),
  };
}

/**
 * 既定结构 → 与规划器等价的产出。
 *
 * 与网页链路同一条纪律：**不绕过校验与规范化**，也不再多问一轮决策问题——
 * "照给定结构重跑"的全部意义就是结构不由模型决定。
 */
function planDeckFromGivenSpec(
  given: PageSpec,
  request: AssembleRequest,
  layouts: BlockRegistry,
): PlanStructureResult {
  const page: PageSpec = {
    ...given,
    projectId: request.projectId ?? given.projectId,
    goal: request.goal,
  };

  validatePageSpec(page, layouts);
  const { page: normalized, fixes } = normalizePageSpec(page, layouts);

  return {
    page: normalized,
    steps: [],
    rationale: [
      `页序由调用方给定（${normalized.blocks.length} 页），本次不向决策层提问`,
      ...fixes.map((fix) => `版式规范化：${fix.detail}`),
    ],
    decisionLatencyMs: 0,
    decisionCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    fixes,
  };
}

/** 候选版式的解析。未指定时用池子全集，指定时逐个校验存在性。 */
function resolveCandidates(
  requested: readonly string[] | undefined,
  registry: BlockRegistry,
): string[] {
  if (requested === undefined || requested.length === 0) {
    return registry.specs().map((spec: BlockSpec) => spec.id);
  }
  for (const id of requested) {
    if (!registry.has(id)) {
      throw new PlanError(
        `候选版式 ${id} 未注册。演示文稿只能从版式池里选`,
        'UNKNOWN_TOOL',
      );
    }
  }
  return [...requested];
}

/**
 * 拿到统筹规划。规则与网页链路完全一致，逐条对齐见 `structured/assembler.ts`
 * 里同名函数的注释；这里只重复一条最容易搞错的地方：
 *
 * `undefined` = "这条路不适用（没配生成层）"，`ok:false` = "试了但没成/被关掉"。
 * 两者在界面上要说不同的话，所以不能合并。
 */
async function resolveBlueprint(
  request: AssembleRequest,
  layouts: BlockRegistry,
): Promise<BlueprintOutcome | undefined> {
  if (request.blueprint !== undefined) return { ok: true, blueprint: request.blueprint };
  if (request.llm === undefined) return undefined;
  if (request.useBlueprint === false) {
    return { ok: false, detail: '本次按要求关闭了统筹规划' };
  }

  const candidateIds = resolveCandidates(request.candidateBlockIds, layouts);
  return await planBlueprint({
    llm: request.llm,
    goal: request.goal,
    envType: 'slides',
    blocks: candidateIds.map((id) => layouts.get(id)),
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
