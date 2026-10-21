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
import { argmaxDeterministic } from '../decision/types.js';
import { PlanError, validatePlan, type ExecutionPlan, type PlanInput, type PlanNode } from '../plan/types.js';
import { describeAlignment, planBlueprint, type BlueprintOutcome } from '../plan/blueprint.js';
import { createSlideRegistry } from './deck-spec.js';
import { DECK_TOOLS } from './deck-tools.js';
import {
  DECK_COMPOSITION_QUESTION,
  DECK_THEME_QUESTION,
  DEFAULT_DECK_COMPOSITION,
  DEFAULT_DECK_THEME_ID,
  deckCompositionCriteria,
  deckThemeCriteria,
  resolveDeckTheme,
  type DeckTheme,
} from './deck-theme.js';
import { normalizePageSpec, validatePageSpec, type BlockInstance, type PageSpec } from './page-spec.js';
import { writeDeck, type DeckWriteOutcome } from './deck-write.js';
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

  // ── 0.5 视觉方向：也是决策层的事 ───────────────────────────────────────
  //
  // 版式决定**信息结构**（这页讲几件事、怎么排），主题决定**视觉气质**
  // （冷暖、轻重、疏密）。后者同样是"这次要什么"的封闭问题，代码不该替它答——
  // 替它答的结果就是所有文稿长得一模一样。
  //
  // 代价只有一次 `choice`，而它换来的差别是用户一眼能看出来的。
  const visual = await decideTheme(request, decision, rationale);
  const theme = visual.theme;

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
          // 演示文稿的正文是**一次执笔**：不再逐 slot 问"这一格由谁写"。
          // 那一问属于"谁写"，而决策模型只该做结构选择（见 docs/执笔与决策的分工.md）。
          // 不问也意味着填充时没有 slotPlans，所有可写 slot 都交给执笔/兜底。
          askSlotSource: false,
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
  // ── 1.5 一次执笔：整份文稿的文案一口气写完 ─────────────────────────────
  //
  // 放在页序定稿之后、建节点之前：只有这时才知道每页用什么版式、每个 slot
  // 要几项。写好的文案作为**字面量**进入各页的 fill-slide 节点——它是这一次
  // 执笔的结果，不该在执行期再问一遍（否则同一份计划会写出两种文案）。
  const written = await resolveWrittenDeck(request, deck, theme, blueprint, layouts, rationale);
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
    const writtenPage = written?.ok === true ? written.deck.pages[index] : undefined;
    const writtenJson =
      writtenPage !== undefined && Object.keys(writtenPage.slots).length > 0
        ? JSON.stringify(writtenPage.slots)
        : undefined;
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
        // 执笔写好的该页文案。缺省时 fill-slide 会回落到逐 slot 生成。
        ...(writtenJson !== undefined
          ? { written: { kind: 'literal', value: writtenJson } }
          : {}),
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
      // 主题作为**字面量**传给渲染节点：它是这一次决策的结果，
      // 不该在执行期再问一次（那样同一份计划可能渲染成两种样子）。
      themeId: { kind: 'literal', value: theme.id },
      composition: { kind: 'literal', value: visual.composition },
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
      ...(written !== undefined
        ? {
            copy: written.ok
              ? {
                  mode: 'one-shot',
                  pages: written.deck.pages.filter((page) => Object.keys(page.slots).length > 0)
                    .length,
                  model: written.deck.model,
                  latencyMs: written.deck.latencyMs,
                }
              : { mode: 'fallback', detail: written.detail },
          }
        : {}),
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
 * 一次执笔：把整份文稿的文案交给大模型一次写完。
 *
 * 没有生成层、或调用方明确关了生成时返回 `undefined`——这不是失败，
 * 只是"这条路不适用"，不该在依据里留下"执笔失败"的噪声。
 */
async function resolveWrittenDeck(
  request: AssembleRequest,
  deck: PageSpec,
  theme: DeckTheme,
  blueprint: BlueprintOutcome | undefined,
  layouts: BlockRegistry,
  rationale: string[],
): Promise<DeckWriteOutcome | undefined> {
  if (request.useGenerative !== true || request.llm === undefined) return undefined;

  const pages = deck.blocks.map((page, index) => ({
    index,
    spec: layouts.get(page.type),
    counts: plannedCounts(page),
  }));

  const outcome = await writeDeck({
    llm: request.llm,
    goal: request.goal,
    pages,
    ...(blueprint !== undefined && blueprint.ok ? { blueprint: blueprint.blueprint } : {}),
    themeLabel: theme.label,
    themeDescription: theme.description,
    ...(request.tone !== undefined ? { tone: request.tone } : {}),
    ...(request.context.constraints !== undefined
      ? { constraints: request.context.constraints }
      : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });

  if (outcome.ok) {
    const writtenPages = outcome.deck.pages.filter(
      (page) => Object.keys(page.slots).length > 0,
    ).length;
    rationale.push(
      `执笔：一次写出 ${writtenPages}/${deck.blocks.length} 页文案` +
        `（模型 ${outcome.deck.model}，${outcome.deck.latencyMs}ms）`,
    );
  } else {
    rationale.push(`执笔不可用：${outcome.detail}。本次回落到逐 slot 生成`);
  }
  return outcome;
}

/** 从 planner 放的形状占位里读出每个 slot 的项数（与 fill-slide 的 counts 同义）。 */
function plannedCounts(page: BlockInstance): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(page.slots)) {
    counts[name] =
      value.kind === 'list'
        ? value.items.length
        : value.kind === 'list-image'
          ? value.refs.length
          : 1;
  }
  return counts;
}

/**
 * 问一次"这次要什么视觉气质"，并把结果写进依据。
 *
 * ## 弃权与失败都回落到默认主题
 *
 * 主题是纯视觉参数：它不影响结构、不影响产物能不能用。所以这一问
 * **失败即回落**（并如实记下原因），不该让它把整次运行打挂——
 * 与其"因为选不出颜色而做不出文稿"，不如用默认主题做出来再说明。
 */
async function decideTheme(
  request: AssembleRequest,
  decision: DecisionClient,
  rationale: string[],
): Promise<{ theme: DeckTheme; composition: 'parallel' | 'ranked' }> {
  const fallback = resolveDeckTheme(DEFAULT_DECK_THEME_ID);
  const fallbackComposition: 'parallel' | 'ranked' = DEFAULT_DECK_COMPOSITION;
  try {
    const decided = await decision.decide(
      {
        goal: request.goal,
        envType: 'slides',
        ...(request.context.constraints !== undefined
          ? { constraints: request.context.constraints }
          : {}),
        facts: { 交付格式: '多页演示文稿（一页一屏，16:9）' },
      },
      {
        [DECK_THEME_QUESTION]: {
          type: 'choice',
          instructions:
            '这份演示文稿该用哪种视觉气质？看场合与内容：技术方案要显得硬，' +
            '品牌故事要读得下去，内部汇报要信息密度，对外宣讲要抓眼球。',
          criteria: deckThemeCriteria(),
        },
        // 与主题同批问：两者都是"整体气质"层面的决定，同一次 prefill 里权衡。
        [DECK_COMPOSITION_QUESTION]: {
          type: 'choice',
          instructions:
            '整份文稿的节奏要多"齐"？正式汇报通常整齐划一，' +
            '对外宣讲或创意提案更适合一页重一页轻。',
          criteria: deckCompositionCriteria(),
        },
      },
      request.decisionTimeoutMs !== undefined ? { timeoutMs: request.decisionTimeoutMs } : {},
    );

    // 构图：与主题同批拿到，弃权/没答都按默认。
    let composition: 'parallel' | 'ranked' = fallbackComposition;
    const compAnswer = decided.answers[DECK_COMPOSITION_QUESTION];
    if (compAnswer !== undefined && compAnswer.type === 'choice') {
      const pickedComp =
        compAnswer.value ?? argmaxDeterministic(Object.keys(compAnswer.probabilities), compAnswer.probabilities);
      composition = pickedComp === 'parallel' ? 'parallel' : 'ranked';
      rationale.push(
        `构图节奏：${composition === 'parallel' ? '统一平静' : '有节奏起伏'}` +
          (compAnswer.value === null ? '（弃权，按概率回落）' : ''),
      );
    } else {
      rationale.push(
        `构图节奏：决策层未回答，回落「${fallbackComposition === 'parallel' ? '统一平静' : '有节奏起伏'}」`,
      );
    }

    const answer = decided.answers[DECK_THEME_QUESTION];
    if (answer === undefined || answer.type !== 'choice') {
      rationale.push(`视觉主题：决策层未回答，回落默认「${fallback.label}」`);
      return { theme: fallback, composition };
    }
    const picked = answer.value ?? argmaxDeterministic(Object.keys(answer.probabilities), answer.probabilities);
    const theme = resolveDeckTheme(picked ?? undefined);
    rationale.push(
      `视觉主题：${theme.label}` +
        (answer.value === null ? '（决策层弃权，按概率回落）' : `（${theme.description.slice(0, 24)}…）`),
    );
    return { theme, composition };
  } catch (error) {
    rationale.push(
      `视觉主题：决策层调用失败（${error instanceof Error ? error.message : String(error)}），回落默认「${fallback.label}」`,
    );
    return { theme: fallback, composition: fallbackComposition };
  }
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
