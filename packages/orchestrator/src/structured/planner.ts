/**
 * 逐块结构规划器：**决策模型决定页面结构**。
 *
 * ## 这是整条链路的地基
 *
 * 现有链路的病根是"让大模型吐一个完整 HTML 字符串"——结构藏在文本里，
 * 决策模型只回答"选哪个工具"（5 选 1，答案几乎注定），机械全在空转。
 *
 * 这里把结构决策**逐块**交给决策模型，用满四个原语：
 *
 * | 问题 | 原语 | 什么时候问 |
 * |---|---|---|
 * | `next_block` | `choice` | 每一轮 |
 * | `continue_structuring` | `noul` | 每轮（除首块） |
 * | `slot_count` | `numeric` | 该 block 有列表型 slot 时 |
 * | `structure_quality` | `score` | 结构定稿后 |
 *
 * **生成层一次都没有决定过结构。** 它只在 P2 里被调去实现已经定好的 block。
 * 这条边界是刻意的：如果让大模型"生成需要哪些 block"，选结构的就是生成层，
 * 决策模型只能干看着——正是现状的病根，不能在结构化之后重演。
 *
 * ## 批量提交是必须的，不是优化
 *
 * rizzo-flow 单模型常驻，并发请求会串行化。逐块决策意味着一轮多次提问，
 * 一次一问会把延迟累加得不可接受。因此**一轮的所有问题打包成一次请求**，
 * 共享同一次 prefill。
 *
 * 唯一的例外是 `slot_count`：它问的是"刚选中的那块要几项"，
 * 依赖"选中了哪块"这个答案，与选择问题有因果关系，**没法同批**。
 * 所以有列表型 slot 的 block 会多一次请求——但这一次只问数量，很便宜。
 * 反过来把"所有候选 block 的数量"都在同一批里先问一遍，是让模型回答一堆
 * 它不需要回答的问题，代价更高。
 */
import {
  DecisionError,
  DEFAULT_SCORE_CRITERIA,
  type DecisionBatchResult,
  type DecisionClient,
  type DecisionContext,
  type Question,
} from '../decision/types.js';
import { argmaxDeterministic } from '../decision/types.js';
import { blueprintFacts, type PageBlueprint } from '../plan/blueprint.js';
import { BLOCK_GROUP_LABELS, type BlockRegistry, type BlockSpec, type SlotSpec } from './block-spec.js';
import { applyTemplate, narrowCandidates, type TemplateSpec } from './template-spec.js';
import {
  appendBlock,
  createPageSpec,
  describePageSpec,
  nextBlockId,
  normalizePageSpec,
  validatePageSpec,
  type BlockInstance,
  type BlockStatus,
  type PageSpec,
  type SlotFillPlan,
  type SlotValue,
  type StructureFix,
} from './page-spec.js';

/** 逐块规划用的问题 id。集中定义，避免散落的字符串。 */
export const STRUCTURE_QUESTIONS = {
  nextBlock: 'next_block',
  continueStruct: 'continue_structuring',
  slotCount: 'slot_count',
  slotSource: 'slot_source',
  structureQuality: 'structure_quality',
} as const;

/**
 * 可能走生成层的 slot 类型。
 *
 * 图像类**不在里面**：生图逐张计费，必须由显式开关控制，
 * 不能因为"这个 slot 是图"就自动扣钱（与 `tools.ts` 的 slot 生成器同一条理由）。
 */
const GENERATIVE_ELIGIBLE: readonly SlotSpec['type'][] = ['text', 'title', 'code', 'list-text'];

/**
 * `noul` 判定阈值。**刻意避开 0.5**。
 *
 * rizzo-flow 官方警告：共享前缀打分会移动接近的判定（Q8_0 时 777 个里 13 个，
 * Q4 时 63 个里 2 个）。阈值压在 0.5 上，这些抖动会直接翻转"要不要继续"。
 * 因此用 0.6/0.4 双阈值：≥0.6 继续，≤0.4 停，**中间是滞回带**。
 */
export const CONTINUE_YES_THRESHOLD = 0.6;
export const CONTINUE_NO_THRESHOLD = 0.4;

/** 滞回带内判定"结构是否已收尾"时，认作收尾的 block。 */
const CLOSING_BLOCKS: readonly string[] = ['cta', 'footer'];

/** 默认页面上限。防止模型在"要不要继续"上永远答"是"。 */
export const DEFAULT_MAX_BLOCKS = 8;

/**
 * 结构评分低于它，就再给一轮补救机会。
 *
 * 0.4 与 `askQuality` 里"偏弱"的那一档对齐：那里把 `[0.4, 0.7)` 叫"一般"、
 * `< 0.4` 叫"偏弱"。取 0.4 而不是 0.7，是因为**"一般"是正常结果**——
 * 大多数页面结构就是"一般"，每次都补救会让这一问变成噪声。
 */
export const LOW_QUALITY_THRESHOLD = 0.4;

/** 数量问题的确定性回落值。决策层弃权时用它。 */
const FALLBACK_COUNT = 3;

export class StructureError extends Error {
  override readonly name = 'StructureError';
  constructor(
    message: string,
    readonly code: StructureErrorCode,
  ) {
    super(message);
  }
}

export type StructureErrorCode =
  /** 候选集为空或全部不可用。 */
  | 'NO_CANDIDATES'
  /** 决策层选了不在候选集里的 block。 */
  | 'PICK_OUT_OF_CANDIDATES'
  /** 页面结构校验不通过。 */
  | 'INVALID_PAGE';

/** 一轮决策的留痕。前端据此展示"决策过程"，也是沉淀模板的原始材料。 */
export interface StructureStep {
  /** 轮次，从 0 开始。 */
  readonly round: number;
  /** 本轮的决策来源。`counts` 单独一批时是 `count_only`。 */
  readonly kind: 'select' | 'count_only' | 'quality';
  /** 本轮问了哪些问题（键名）。 */
  readonly questionIds: readonly string[];
  /** 决策层给出的原始答案，按问题 id 索引。 */
  readonly answers: Readonly<Record<string, unknown>>;
  /** 本轮选中的 block 类型。`count_only` / `quality` 轮为 null。 */
  readonly pickedBlockId: string | null;
  /** `noul` 的原始判定概率，便于解释"为什么停了"。 */
  readonly continueProbability: number | null;
  /** 本轮决定继续吗。`select` 轮之外为 null。 */
  readonly continued: boolean | null;
  /** 本轮问出来的数量。键是 slot 名。 */
  readonly counts: Readonly<Record<string, number>>;
  /** 本轮得到的分值（`quality` 轮）。 */
  readonly score: number | null;
  readonly latencyMs: number;
  /** 人类可读的依据，进日志也进前端。 */
  readonly rationale: string;
}

export interface PlanStructureRequest {
  readonly projectId: string;
  readonly goal: string;
  /**
   * 本次是哪种模态。默认 `webpage`。
   *
   * 它进决策上下文的 `envType` 与 `交付格式` 两项：演示文稿的"下一块"与网页的
   * "下一块"是同一个问题、不同答案（一页幻灯片 vs 页面上的一个区块），
   * 不告诉决策层是哪种，它就会拿网页的版式逻辑去排幻灯片。
   */
  readonly envType?: 'webpage' | 'slides' | undefined;
  /** 交付格式的人话描述，进决策上下文。省略时按 `envType` 取默认。 */
  readonly deliverable?: string | undefined;
  /** 本次候选集——用户从 block 池里选出来的要用的类型。 */
  readonly candidateBlockIds: readonly string[];
  /**
   * 套用的模板。省略即不套模板。
   *
   * 模板同时起两个作用（设计稿 §7.1）：
   *   - **限定范围**：`allowedBlockIds` 与候选集取交集，防跑偏
   *   - **起手结构**：`blocks` 直接铺成已排好的前缀，规划器从它之后继续
   *
   * 注意 `maxBlocks` 是**整页**上限，模板占掉的块数算在里面 ——
   * 否则"套了模板"反而能把页面撑得比不套更长。
   */
  readonly template?: TemplateSpec | undefined;
  /** 页面 block 数上限。 */
  readonly maxBlocks?: number | undefined;
  /** 用户追加的硬约束，会进决策层的 state。 */
  readonly constraints?: readonly string[] | undefined;
  readonly decisionTimeoutMs?: number | undefined;
  /** 每轮结束回调。纯观察，抛错不影响规划。 */
  readonly onStep?: ((step: StructureStep) => void) | undefined;
  /**
   * **统筹规划**（由大语言模型出的那份计划）。
   *
   * 它只以 `facts` 的形式进入决策上下文——决策层每轮都能看到"计划里要讲这几段、
   * 现在排到哪了"。**规划器不替决策层选块**，红线不动。
   */
  readonly blueprint?: PageBlueprint | undefined;
  /**
   * 文案是否走生成层。
   *
   * **只影响一个问题**：值为 `true` 时才会向决策模型提 `slot_source`
   * （"这个 slot 由生成层写还是确定性拼"）。为 `false`（默认，零成本路径）时
   * 这一问根本不发——没有生成层可选的时候问"要不要生成式"是空问题。
   */
  readonly useGenerative?: boolean | undefined;
}

export interface PlanStructureResult {
  readonly page: PageSpec;
  readonly steps: readonly StructureStep[];
  /** 组装依据摘要，与 `ExecutionPlan.rationale` 同形。 */
  readonly rationale: readonly string[];
  /** 决策层累计耗时。 */
  readonly decisionLatencyMs: number;
  /** 决策层调用次数。用于验证"批量确实省了往返"。 */
  readonly decisionCalls: number;
  /** 决策层用量累计。`outputTokens` 应当恒为 0——模型不生成文本。 */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /**
   * 版式规范化做过的修正。空数组表示模型排出来就是合规的。
   *
   * 单独带出来而不是只写进 `rationale`：这是给测试与界面用的**结构化**事实，
   * 从一句中文里正则抠出来不算接口。
   */
  readonly fixes: readonly StructureFix[];
}

export class StructurePlanner {
  constructor(
    private readonly blocks: BlockRegistry,
    private readonly decision: DecisionClient,
  ) {}

  async plan(request: PlanStructureRequest): Promise<PlanStructureResult> {
    const { blocks, decision } = this;
    const maxBlocks = request.maxBlocks ?? DEFAULT_MAX_BLOCKS;
    if (maxBlocks < 1) {
      throw new StructureError('maxBlocks 至少为 1', 'NO_CANDIDATES');
    }

    // 候选集必须都真的在池子里。用户手打/导入的 block 若没注册过，
    // 在这里就拦下——让它进候选集等于把错误推迟到执行期。
    for (const id of request.candidateBlockIds) {
      if (!blocks.has(id)) {
        throw new StructureError(
          `候选集里的 ${id} 不在 block 池中。外部来源的 block 必须先注册校验`,
          'NO_CANDIDATES',
        );
      }
    }
    if (blocks.filter({ exclude: [] }).length === 0) {
      throw new StructureError('block 池为空', 'NO_CANDIDATES');
    }

    const candidateIds = narrowCandidates([...new Set(request.candidateBlockIds)], request.template);
    if (candidateIds.length === 0) {
      throw new StructureError('本次候选集为空，无法开始结构决策', 'NO_CANDIDATES');
    }

    const steps: StructureStep[] = [];
    const rationale: string[] = [];
    let decisionCalls = 0;
    let decisionLatencyMs = 0;
    const usage = { inputTokens: 0, outputTokens: 0 };

    let page = createPageSpec({
      projectId: request.projectId,
      goal: request.goal,
      candidateBlockIds: candidateIds,
    });

    // ── 模板的起手结构 ────────────────────────────────────────────────
    //
    // 它承载的是**用户已经决定的结构**，因此优先于模型的逐块决策 ——
    // 那正是"选了模板就只在这个范围里工作、不跑偏"的意思。
    //
    // 注意这与红线不冲突：红线管的是**生成层**不能决定结构（设计稿 §2.1），
    // 不是"用户不能决定结构"。用户选模板，本身就是 §6.2 列出的干预点之一。
    if (request.template !== undefined) {
      page = applyTemplate(page, request.template);
      rationale.push(
        `套用模板 ${request.template.id}（${request.template.label}）：` +
          `起手 ${page.blocks.length} 块 —— ${describePageSpec(page)}`,
      );
    }

    /** 已经用过的 block 类型，用于排除"不可重复"的那些。模板铺上的也算用过。 */
    const usedTypes: string[] = page.blocks.map((b) => b.type);
    /** 上一个被选中的 block 的 spec，用于补问数量。 */
    let lastSpec: BlockSpec | null = null;
    let lastBlockId: string | null = null;

    const emit = (step: StructureStep): void => {
      steps.push(step);
      if (request.onStep === undefined) return;
      try {
        request.onStep(step);
      } catch {
        /* 回调是纯观察 */
      }
    };

    // 模板给的结构**自己就收了尾**时，不再扩展。
    // 沉淀出来的模板是"跑完过的整页"，通常带 footer —— 那种情况下页面已经完整，
    // 再问"要不要再来一块"只会得到一块排在页脚后面的正文。
    const seededLast = page.blocks.at(-1);
    const structurallyClosed =
      seededLast !== undefined &&
      blocks.has(seededLast.type) &&
      isTerminal(blocks.get(seededLast.type));
    if (structurallyClosed) {
      rationale.push(
        `模板的起手结构已以 ${seededLast!.type}（页面末尾块）收尾，不再扩展`,
      );
    }

    // 循环条件是**整页块数**而不是轮数：套了模板之后，"还能排几块"
    // 取决于模板占掉多少，而不是还能问几轮。
    for (let round = 0; !structurallyClosed && page.blocks.length < maxBlocks; round += 1) {
      const available = this.availableSpecs(candidateIds, usedTypes);
      if (available.length === 0) {
        rationale.push(`第 ${round + 1} 轮：候选集里的 block 已用尽（不可重复的都已出现），结束`);
        break;
      }

      // 首块必须能当首块。`footer` 当页面第一块是明显的结构错误——
      // 与其让模型犯错再纠正，不如从一开始就不给它这个选项。
      const isFirst = page.blocks.length === 0;
      const pool = isFirst ? available.filter((s) => s.canLead) : available;
      if (pool.length === 0) {
        throw new StructureError(
          `候选集里没有任何 block 能作为首块（canLead 全为 false）`,
          'NO_CANDIDATES',
        );
      }

      const context = this.buildContext(request, page);
      const questions: Record<string, Question> = {};
      // 用词随模态走：幻灯片上问"再补一块"会得到"补一个页面区块"的答案。
      const unit = request.envType === 'slides' ? '页' : '块';
      const surface = request.envType === 'slides' ? '这份文稿' : '这个页面';

      // 首块没什么可"继续"的，不问。
      if (!isFirst) {
        questions[STRUCTURE_QUESTIONS.continueStruct] = {
          type: 'noul',
          instructions: `${surface}已经有 ${page.blocks.length} ${unit}（${describePageSpec(page)}）。` +
            `再补一${unit}能让它更完整吗？如果已经齐全，答否。`,
        };
      }

      // 只剩一个可选时不必问：问一个只有一个选项的问题没有意义，
      // 直接采用并记录依据，省一次决策往返。
      const singlePick = pool.length === 1 ? pool[0]! : null;
      if (singlePick === null) {
        // criteria 只放本次**真正可用**的项。把已经用过且不可重复的 block 也列进去，
        // 是给模型挖坑——它可能选一个已经被排除的，然后被判成越界。
        //
        // 问句里**必须带当前结构**：不带的话，决策模型每轮都是"看着一堆候选盲选"，
        // 不知道版式已经排到哪一步了，"逐块决策"就退化成"每块独立瞎猜"。
        questions[STRUCTURE_QUESTIONS.nextBlock] = {
          type: 'choice',
          instructions: isFirst
            ? `这是${surface}的第一${unit}，决定第一印象。选一个最合适的起始${unit === '页' ? '版式' : 'block'}。`
            : `${surface}已经有 ${page.blocks.length} ${unit}（${describePageSpec(page)}）。` +
              `选择紧接着要放的下一${unit}。考虑顺序：先讲清是什么，再展开细节，最后收尾。` +
              '不要重复放已经用过的版式，除非确实需要。',
          criteria: Object.fromEntries(
            pool.map((spec) => [
              spec.id,
              `[${BLOCK_GROUP_LABELS[spec.group]}] ${spec.label}：${spec.description}`,
            ]),
          ),
        };
      }

      // 只有真的发了请求才计数——把"没问"算成一次调用会让
      // "批量省了多少往返"这个指标失真。
      const asked = Object.keys(questions).length > 0;
      const decided = asked
        ? await decision.decide(
            context,
            questions,
            request.decisionTimeoutMs !== undefined ? { timeoutMs: request.decisionTimeoutMs } : {},
          )
        : noQuestionsAsked();
      if (asked) {
        decisionCalls += 1;
        decisionLatencyMs += decided.meta.latencyMs;
        usage.inputTokens += decided.usage.inputTokens;
        usage.outputTokens += decided.usage.outputTokens;
      }

      const answersOut: Record<string, unknown> = {};
      for (const key of Object.keys(questions)) answersOut[key] = decided.answers[key];

      // ── "还要不要再来一块" ─────────────────────────────────────────
      let continued: boolean | null = null;
      let continueProbability: number | null = null;
      let continueRationale: string | null = null;
      if (!isFirst) {
        const answer = decided.answers[STRUCTURE_QUESTIONS.continueStruct];
        if (answer === undefined || answer.type !== 'noul') {
          throw new StructureError('决策层未返回 continue_structuring 的答案', 'INVALID_PAGE');
        }
        const verdict = this.judgeContinue(answer.value, answer.yesProbability, page);
        continued = verdict.continued;
        continueProbability = verdict.probability;
        continueRationale = verdict.rationale;

        if (!verdict.continued) {
          const stopRationale = `第 ${round + 1} 轮：${verdict.rationale}，结构定稿`;
          emit({
            round,
            kind: 'select',
            questionIds: Object.keys(questions),
            answers: answersOut,
            pickedBlockId: null,
            continueProbability,
            continued: false,
            counts: {},
            score: null,
            latencyMs: decided.meta.latencyMs,
            rationale: verdict.rationale,
          });
          rationale.push(stopRationale);
          break;
        }
      }

      // ── "下一块放什么" ────────────────────────────────────────────
      let picked: BlockSpec;
      let pickRationale: string;
      if (singlePick !== null) {
        picked = singlePick;
        pickRationale = `唯一可用候选 ${picked.id}，无需决策`;
      } else {
        const answer = decided.answers[STRUCTURE_QUESTIONS.nextBlock];
        if (answer === undefined || answer.type !== 'choice') {
          throw new StructureError('决策层未返回 next_block 的答案', 'INVALID_PAGE');
        }
        picked = this.pickBlock(answer.value, answer.probabilities, pool);
        pickRationale =
          answer.value === null
            ? `决策层弃权，回落到 ${picked.id}`
            : `选中 ${picked.id}（${picked.label}）`;
      }

      // 本轮的依据 = "继续/停止"的判定 + "选了哪块"。
      // 两者都在同一轮的同一批请求里问出来的，拆开放到两个地方会让人
      // 只看得到结果、看不到理由。
      const roundRationale =
        continueRationale === null ? pickRationale : `${continueRationale}；${pickRationale}`;

      emit({
        round,
        kind: 'select',
        questionIds: Object.keys(questions),
        answers: answersOut,
        pickedBlockId: picked.id,
        continueProbability,
        continued,
        counts: {},
        score: null,
        latencyMs: decided.meta.latencyMs,
        rationale: roundRationale,
      });
      rationale.push(`第 ${round + 1} 轮：${roundRationale}`);

      const blockId = nextBlockId(page);
      // 先落一个 pending 块，再单独问数量——数量问题依赖"选中了哪块"，
      // 与选择问题有因果关系，没法同批。
      page = appendBlock(page, {
        id: blockId,
        type: picked.id,
        slots: {},
        status: 'pending',
        sources: {},
      });
      usedTypes.push(picked.id);
      lastSpec = picked;
      lastBlockId = blockId;

      // ── "要几个" 与 "由谁实现" ────────────────────────────────────
      //
      // 两者都以"选中了哪块"为前提，彼此没有依赖，所以**同批**问出去。
      const listSlots = picked.slots.filter((s) => s.countRange !== undefined);
      const sourceSlots =
        request.useGenerative === true
          ? picked.slots.filter((s) => GENERATIVE_ELIGIBLE.includes(s.type))
          : [];
      if (listSlots.length > 0 || sourceSlots.length > 0) {
        const blockResult = await this.askBlockQuestions({
          request,
          page,
          spec: picked,
          blockId,
          listSlots,
          sourceSlots,
        });
        decisionCalls += 1;
        decisionLatencyMs += blockResult.latencyMs;
        usage.inputTokens += blockResult.usage.inputTokens;
        usage.outputTokens += blockResult.usage.outputTokens;

        page = {
          ...page,
          blocks: page.blocks.map((b) =>
            b.id === blockId
              ? {
                  ...b,
                  slots: buildCountSlots(listSlots, blockResult.counts),
                  // 没问过就不写这个字段——"问过且都答确定性"与"没问过"
                  // 在填充器里是两种行为，不能混成一种。
                  ...(sourceSlots.length > 0 ? { slotPlans: blockResult.plans } : {}),
                }
              : b,
          ),
        };
        emit({
          round,
          kind: 'count_only',
          questionIds: [
            ...listSlots.map((s) => `${STRUCTURE_QUESTIONS.slotCount}:${s.name}`),
            ...sourceSlots.map((s) => `${STRUCTURE_QUESTIONS.slotSource}:${s.name}`),
          ],
          answers: blockResult.answers,
          pickedBlockId: picked.id,
          continueProbability: null,
          continued: null,
          counts: blockResult.counts,
          score: null,
          latencyMs: blockResult.latencyMs,
          rationale: blockResult.rationale,
        });
        rationale.push(`　└ ${blockResult.rationale}`);
      }

      // ── 末尾块之后不再排 ──────────────────────────────────────────
      //
      // 不指望模型自己判断"该停了"：它完全可以在第 2 轮就挑 `footer`，
      // 然后再挑一块，排出 `hero → footer → features` —— 页脚后面还有正文。
      // 每一块单独看都合法（类型在池子里、slot 齐全、不可重复的没重复），
      // 所以只能靠"放下末尾块即收尾"这条结构事实来挡。
      if (isTerminal(picked)) {
        rationale.push(
          `第 ${round + 1} 轮：放下 ${picked.id}（声明为页面末尾块），结构自然收尾`,
        );
        break;
      }
    }

    if (page.blocks.length === 0) {
      throw new StructureError('逐块决策没有产出任何 block', 'INVALID_PAGE');
    }

    // ── 版式规范化：把跑偏的两端块挪回去 ──────────────────────────────
    //
    // 放在**评分之前**：`structure_quality` 要评的应该是最终会渲染出来的那个结构，
    // 而不是一个马上要被改掉的中途状态。
    //
    // 也放在**校验之前**：规范化只处理"合法但不合语义"的顺序问题，
    // 真正非法的结构（未知类型、slot 不合规）留给 `validatePageSpec` 报，
    // 它报得比这里准。
    const normalized = normalizePageSpec(page, this.blocks);
    page = normalized.page;
    // 补救轮还会再规范化一次，两轮的修正合并成一个列表带出去。
    const fixes: StructureFix[] = [...normalized.fixes];
    for (const fix of fixes) {
      rationale.push(`版式规范化：${fix.detail}`);
    }

    // ── 结构定稿后评一次分（`score` 原语的落点） ──────────────────────
    //
    // 评分不是"留个念"：它低到一定程度会**触发一次补救轮**（见下）。
    // 否则这一问就是断头路——决策模型指出结构不好，然后什么也没发生。
    let quality = await this.askQuality(request, page);
    decisionCalls += 1;
    decisionLatencyMs += quality.latencyMs;
    usage.inputTokens += quality.usage.inputTokens;
    usage.outputTokens += quality.usage.outputTokens;

    emit({
      round: page.blocks.length,
      kind: 'quality',
      questionIds: [STRUCTURE_QUESTIONS.structureQuality],
      answers: { [STRUCTURE_QUESTIONS.structureQuality]: quality.raw },
      pickedBlockId: lastSpec?.id ?? null,
      continueProbability: null,
      continued: null,
      counts: {},
      score: quality.score,
      latencyMs: quality.latencyMs,
      rationale: quality.rationale,
    });
    rationale.push(quality.rationale);

    // ── 低分补救：最多一轮 ──────────────────────────────────────────
    //
    // 触发条件是"模型自己给的判断"：它先说结构够了（`noul` 答停），
    // 又给这个结构打了低分。两个答案互相矛盾，**以分数为准再给一轮机会**。
    //
    // 边界刻意收紧，避免变成"追求高分"的循环：
    //   - 分数为 null（弃权）不触发——没有判断依据就不该动
    //   - 已经因末尾块收尾 / 候选用尽 / 到 maxBlocks 而不触发
    //   - **只做一轮**，补完重评一次就结束，不管新分是多少
    const canRemediate =
      quality.score !== null &&
      quality.score < LOW_QUALITY_THRESHOLD &&
      !structurallyClosed &&
      page.blocks.length < maxBlocks;

    if (canRemediate) {
      rationale.push(
        `结构评分 ${quality.score!.toFixed(3)} 低于 ${LOW_QUALITY_THRESHOLD}，触发一轮补救`,
      );
      const added = await this.remediate({
        request,
        page,
        usedTypes,
        candidateIds,
        score: quality.score!,
        emit,
      });
      if (added === null) {
        rationale.push('补救轮：候选集里没有可补的块，放弃');
      } else {
        decisionCalls += added.calls;
        decisionLatencyMs += added.latencyMs;
        usage.inputTokens += added.usage.inputTokens;
        usage.outputTokens += added.usage.outputTokens;
        page = added.page;
        usedTypes.push(...added.addedTypes);

        // 补进来的块同样要过一遍规范化（它可能是 nav / footer），
        // 也要重新评一次分——分数必须反映**最终**结构，不是补救前的那个。
        const renorm = normalizePageSpec(page, this.blocks);
        page = renorm.page;
        for (const fix of renorm.fixes) {
          fixes.push(fix);
          rationale.push(`版式规范化：${fix.detail}`);
        }

        quality = await this.askQuality(request, page);
        decisionCalls += 1;
        decisionLatencyMs += quality.latencyMs;
        usage.inputTokens += quality.usage.inputTokens;
        usage.outputTokens += quality.usage.outputTokens;
        emit({
          round: page.blocks.length,
          kind: 'quality',
          questionIds: [STRUCTURE_QUESTIONS.structureQuality],
          answers: { [STRUCTURE_QUESTIONS.structureQuality]: quality.raw },
          pickedBlockId: added.addedTypes.at(-1) ?? null,
          continueProbability: null,
          continued: null,
          counts: {},
          score: quality.score,
          latencyMs: quality.latencyMs,
          rationale: quality.rationale,
        });
        rationale.push(quality.rationale);
      }
    }

    page = { ...page, qualityScore: quality.score };

    // 结构在交给填充之前先自校验一次。放到渲染后查，错误会埋进 HTML 里。
    validatePageSpec(page, this.blocks);

    if (lastBlockId !== null) {
      rationale.push(`结构定稿：${page.blocks.length} 块，末块 ${lastBlockId}`);
    }

    return {
      page,
      steps,
      rationale,
      decisionLatencyMs,
      decisionCalls,
      usage,
      fixes,
    };
  }

  /**
   * 低分补救：再问一轮"补一块什么"，把页面补完整。
   *
   * ## 为什么值得做
   *
   * `structure_quality` 此前是**断头路**：决策模型指出结构不好，然后什么也没发生。
   * 一个只被记录、从不影响行为的判断，等于没问。
   *
   * ## 为什么是"再问一次"而不是"自动补一块"
   *
   * 自动补意味着**由代码决定结构**——那正是这个项目要消灭的病根（设计稿 §2.1）。
   * 所以补救仍然走 `choice`：选什么由决策模型回答，只是把"你刚打了低分"这个
   * 信息如实告诉它。红线不动。
   *
   * ## 失败即放弃，不抛错
   *
   * 补救是**锦上添花**：原结构本身是合法的、可交付的。这一轮出任何问题
   * （候选空、模型不答）都应该退回原结构，而不是让整次运行失败。
   */
  private async remediate(args: {
    readonly request: PlanStructureRequest;
    readonly page: PageSpec;
    readonly usedTypes: readonly string[];
    readonly candidateIds: readonly string[];
    readonly score: number;
    readonly emit: (step: StructureStep) => void;
  }): Promise<{
    readonly page: PageSpec;
    readonly addedTypes: readonly string[];
    readonly calls: number;
    readonly latencyMs: number;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  } | null> {
    const available = this.availableSpecs(args.candidateIds, args.usedTypes);
    if (available.length === 0) return null;

    const pool = available;
    const questions: Record<string, Question> = {};

    const singlePick = pool.length === 1 ? pool[0]! : null;
    if (singlePick === null) {
      questions[STRUCTURE_QUESTIONS.nextBlock] = {
        type: 'choice',
        instructions:
          `这个页面的结构评分只有 ${args.score.toFixed(3)}（偏低）。` +
          `当前页面有 ${args.page.blocks.length} 块（${describePageSpec(args.page)}）。` +
          '补上哪一块能让页面更完整？缺少收尾就补收尾，内容单薄就补内容块。',
        criteria: Object.fromEntries(
          pool.map((spec) => [
            spec.id,
            `[${BLOCK_GROUP_LABELS[spec.group]}] ${spec.label}：${spec.description}`,
          ]),
        ),
      };
    }

    const asked = Object.keys(questions).length > 0;
    let decided: DecisionBatchResult;
    let calls = 0;
    let latencyMs = 0;
    const usage = { inputTokens: 0, outputTokens: 0 };
    if (asked) {
      try {
        decided = await this.decision.decide(
          this.buildContext(args.request, args.page),
          questions,
          args.request.decisionTimeoutMs !== undefined
            ? { timeoutMs: args.request.decisionTimeoutMs }
            : {},
        );
      } catch {
        return null; // 补救失败即放弃
      }
      calls += 1;
      latencyMs += decided.meta.latencyMs;
      usage.inputTokens += decided.usage.inputTokens;
      usage.outputTokens += decided.usage.outputTokens;
    } else {
      decided = noQuestionsAsked();
    }

    let picked: BlockSpec;
    let pickRationale: string;
    if (singlePick !== null) {
      picked = singlePick;
      pickRationale = `补救轮：唯一可用候选 ${picked.id}`;
    } else {
      const answer = decided.answers[STRUCTURE_QUESTIONS.nextBlock];
      if (answer === undefined || answer.type !== 'choice') return null;
      try {
        picked = this.pickBlock(answer.value, answer.probabilities, pool);
      } catch {
        return null; // 模型选了候选外的块：补救轮不值得为此让整次运行失败
      }
      pickRationale = `补救轮：补上 ${picked.id}（${picked.label}）`;
    }

    const blockId = nextBlockId(args.page);
    let page = appendBlock(args.page, {
      id: blockId,
      type: picked.id,
      slots: {},
      status: 'pending',
      sources: {},
    });

    args.emit({
      round: args.page.blocks.length,
      kind: 'select',
      questionIds: Object.keys(questions),
      answers: asked
        ? Object.fromEntries(Object.keys(questions).map((k) => [k, decided.answers[k]]))
        : {},
      pickedBlockId: picked.id,
      continueProbability: null,
      continued: null,
      counts: {},
      score: null,
      latencyMs: decided.meta.latencyMs,
      rationale: pickRationale,
    });

    // 补进来的块同样要问数量与"由谁实现"，否则它的列表型 slot 会缺项数。
    const listSlots = picked.slots.filter((s) => s.countRange !== undefined);
    const sourceSlots =
      args.request.useGenerative === true
        ? picked.slots.filter((s) => GENERATIVE_ELIGIBLE.includes(s.type))
        : [];
    if (listSlots.length > 0 || sourceSlots.length > 0) {
      try {
        const blockResult = await this.askBlockQuestions({
          request: args.request,
          page,
          spec: picked,
          blockId,
          listSlots,
          sourceSlots,
        });
        calls += 1;
        latencyMs += blockResult.latencyMs;
        usage.inputTokens += blockResult.usage.inputTokens;
        usage.outputTokens += blockResult.usage.outputTokens;
        page = {
          ...page,
          blocks: page.blocks.map((b) =>
            b.id === blockId
              ? {
                  ...b,
                  slots: buildCountSlots(listSlots, blockResult.counts),
                  ...(sourceSlots.length > 0 ? { slotPlans: blockResult.plans } : {}),
                }
              : b,
          ),
        };
        args.emit({
          round: args.page.blocks.length,
          kind: 'count_only',
          questionIds: [
            ...listSlots.map((s) => `${STRUCTURE_QUESTIONS.slotCount}:${s.name}`),
            ...sourceSlots.map((s) => `${STRUCTURE_QUESTIONS.slotSource}:${s.name}`),
          ],
          answers: blockResult.answers,
          pickedBlockId: picked.id,
          continueProbability: null,
          continued: null,
          counts: blockResult.counts,
          score: null,
          latencyMs: blockResult.latencyMs,
          rationale: blockResult.rationale,
        });
      } catch {
        return null;
      }
    }

    return { page, addedTypes: [picked.id], calls, latencyMs, usage };
  }

  /** 候选集里当前还能用的 block（排除已用过且不可重复的）。 */  private availableSpecs(candidateIds: readonly string[], usedTypes: readonly string[]): BlockSpec[] {
    const used = new Set(usedTypes);
    return this.blocks
      .filter({})
      .filter((spec) => candidateIds.includes(spec.id))
      .filter((spec) => spec.repeatable || !used.has(spec.id));
  }

  /**
   * 判定"要不要继续"。
   *
   * 三个区间，刻意不同：
   *   - `≥ 0.6` 继续
   *   - `≤ 0.4` 停
   *   - 中间是**滞回带**，改由确定性规则判：页面已有收尾块就停，否则继续。
   *
   * 为什么中间不取 0.5 一刀切：官方数据里共享前缀会让接近的判定发生移动，
   * 阈值压在 0.5 上，这点抖动会直接翻转结论。滞回带把这段不确定性交给
   * 一条**看得懂、可复现**的规则，而不是交给一次抛硬币。
   */
  private judgeContinue(
    value: boolean | null,
    yesProbability: number | null,
    page: PageSpec,
  ): { readonly continued: boolean; readonly probability: number | null; readonly rationale: string } {
    const prob = yesProbability;
    if (value !== null) {
      return {
        continued: value,
        probability: prob,
        rationale:
          `决策层判定${value ? '继续' : '停止'}结构扩展` +
          (prob === null ? '' : `（是概率 ${prob.toFixed(2)}）`),
      };
    }    if (prob === null) {
      // 弃权且无概率：按结构是否收尾判，这是最保守的确定性回落。
      const closed = page.blocks.some((b) => CLOSING_BLOCKS.includes(b.type));
      return {
        continued: !closed,
        probability: null,
        rationale: closed
          ? '决策层弃权（无可用的概率），页面已有收尾块，判定结构完成'
          : '决策层弃权（无可用的概率），页面尚无收尾块，继续补块',
      };
    }
    if (prob >= CONTINUE_YES_THRESHOLD) {
      return { continued: true, probability: prob, rationale: `是概率 ${prob.toFixed(2)} ≥ ${CONTINUE_YES_THRESHOLD}，继续` };
    }
    if (prob <= CONTINUE_NO_THRESHOLD) {
      return { continued: false, probability: prob, rationale: `是概率 ${prob.toFixed(2)} ≤ ${CONTINUE_NO_THRESHOLD}，停止` };
    }
    const closed = page.blocks.some((b) => CLOSING_BLOCKS.includes(b.type));
    return {
      continued: !closed,
      probability: prob,
      rationale:
        `是概率 ${prob.toFixed(2)} 落在滞回带（${CONTINUE_NO_THRESHOLD}..${CONTINUE_YES_THRESHOLD}），` +
        (closed ? '页面已有收尾块，判定结构完成' : '页面尚无收尾块，判为继续'),
    };
  }

  /** 从 `choice` 答案里取出选中的 block。弃权时按概率返回，再弃权则取候选首位。 */
  private pickBlock(
    value: string | null,
    probabilities: Readonly<Record<string, number>>,
    pool: readonly BlockSpec[],
  ): BlockSpec {
    const ids = pool.map((s) => s.id);
    if (value !== null) {
      const hit = pool.find((s) => s.id === value);
      if (hit === undefined) {
        throw new StructureError(
          `决策层选了 ${value}，但它不在本次候选集 [${ids.join(', ')}] 内`,
          'PICK_OUT_OF_CANDIDATES',
        );
      }
      return hit;
    }
    const usable = Object.keys(probabilities).filter((id) => ids.includes(id));
    const fallbackId = usable.length > 0 ? argmaxDeterministic(usable, probabilities) : ids[0]!;
    const hit = pool.find((s) => s.id === fallbackId)!;
    return hit;
  }

  /**
   * 问"各列表型 slot 要几项"与"各 slot 由谁实现"。一次请求问全，共享 prefill。
   *
   * 两个问题**同批**：它们都以"选中了哪块"为前提，彼此没有依赖。
   * 分成两批只会白白多一次往返。
   */
  private async askBlockQuestions(args: {
    readonly request: PlanStructureRequest;
    readonly page: PageSpec;
    readonly spec: BlockSpec;
    readonly blockId: string;
    readonly listSlots: readonly SlotSpec[];
    readonly sourceSlots: readonly SlotSpec[];
  }): Promise<{
    readonly counts: Record<string, number>;
    readonly plans: Record<string, SlotFillPlan>;
    readonly answers: Record<string, unknown>;
    readonly latencyMs: number;
    readonly rationale: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }> {
    const questions: Record<string, Question> = {};
    for (const slot of args.listSlots) {
      const range = slot.countRange!;
      questions[`${STRUCTURE_QUESTIONS.slotCount}:${slot.name}`] = {
        type: 'numeric',
        instructions:
          `页面上 ${args.spec.label}（${args.spec.id}）的「${slot.description}」应该有几项？` +
          `范围 ${range.min} 到 ${range.max}。内容单薄就取少，内容丰富就取多。`,
        range,
      };
    }
    for (const slot of args.sourceSlots) {
      questions[`${STRUCTURE_QUESTIONS.slotSource}:${slot.name}`] = {
        type: 'choice',
        instructions:
          `页面上 ${args.spec.label}（${args.spec.id}）的「${slot.description}」` +
          `该由谁来写？「生成层」写得具体但要花生成额度；「确定性」零成本、` +
          `内容朴素但一定完整。需要贴合目标的表达就选生成层，套话够用就选确定性。`,
        criteria: {
          generative: '生成层写（调用模型，花生成额度，内容更贴合目标）',
          deterministic: '确定性拼（零成本，内容朴素但完整、可复现）',
        },
      };
    }

    // ── 发请求。`numeric` 不被支持时降级成 `choice` ───────────────────
    //
    // 实测 rizzo-flow 只接受 noul / choice / score，收到 numeric 会返 422。
    // 那种情况下**不能让整条链路失败**——"要几个"这个问题本身是合理的，
    // 只是问法要换。离散档位的候选集给出的信息量与数值问句几乎等价：
    // "3 项" 与 "中等（3 项左右）" 对结构决策是一回事。
    //
    // 降级时**保留 `slot_source` 问句**（它本来就是 choice），只把数量换成档位。
    const context = this.buildContext(args.request, args.page);
    const timeout =
      args.request.decisionTimeoutMs !== undefined
        ? { timeoutMs: args.request.decisionTimeoutMs }
        : {};

    let decided: DecisionBatchResult;
    let degraded = false;
    try {
      decided = await this.decision.decide(context, questions, timeout);
    } catch (error) {
      if (!isUnsupportedPrimitive(error)) throw error;
      degraded = true;
      decided = await this.decision.decide(
        context,
        { ...choiceQuestionsFor(args.listSlots), ...sourceQuestionsOf(questions) },
        timeout,
      );
    }

    const counts: Record<string, number> = {};
    const plans: Record<string, SlotFillPlan> = {};
    const answers: Record<string, unknown> = {};
    const notes: string[] = [];
    for (const slot of args.listSlots) {
      const key = `${STRUCTURE_QUESTIONS.slotCount}:${slot.name}`;
      const answer = decided.answers[key];
      answers[key] = answer;
      const range = slot.countRange!;

      if (degraded) {
        // 降级路径：答案是 choice，候选 id 就是档位值。
        if (answer === undefined || answer.type !== 'choice') {
          throw new StructureError(`决策层未返回数量问题 ${key} 的答案`, 'INVALID_PAGE');
        }
        const picked = answer.value ?? Object.keys(answer.probabilities)[0];
        const parsed = picked === null || picked === undefined ? Number.NaN : Number(picked);
        counts[slot.name] = Number.isFinite(parsed)
          ? clamp(parsed, range.min, range.max)
          : clamp(FALLBACK_COUNT, range.min, range.max);
        notes.push(
          `${slot.name}=${String(counts[slot.name])}（numeric 不可用，改用 choice 档位）`,
        );
        continue;
      }

      if (answer === undefined || answer.type !== 'numeric') {
        throw new StructureError(`决策层未返回数量问题 ${key} 的答案`, 'INVALID_PAGE');
      }
      if (answer.value === null) {
        // 弃权是合法输入。回落到确定性默认，并**夹进声明区间**——
        // 越界的数量会让 `validatePageSpec` 直接失败。
        const fallback = clamp(FALLBACK_COUNT, range.min, range.max);
        counts[slot.name] = fallback;
        notes.push(`${slot.name}=${String(fallback)}（弃权回落）`);
      } else {
        counts[slot.name] = clamp(answer.value, range.min, range.max);
        notes.push(`${slot.name}=${String(counts[slot.name])}`);
      }
    }

    for (const slot of args.sourceSlots) {
      const key = `${STRUCTURE_QUESTIONS.slotSource}:${slot.name}`;
      const answer = decided.answers[key];
      answers[key] = answer;
      if (answer === undefined || answer.type !== 'choice') {
        throw new StructureError(`决策层未返回 ${key} 的答案`, 'INVALID_PAGE');
      }
      // 弃权时取概率最高的那个；再没有就回落到确定性——**零成本是默认值**。
      const picked = answer.value ?? argmaxDeterministic(Object.keys(answer.probabilities), answer.probabilities);
      const plan: SlotFillPlan = picked === 'generative' ? 'generative' : 'deterministic';
      plans[slot.name] = plan;
      notes.push(`${slot.name}→${plan === 'generative' ? '生成层' : '确定性'}`);
    }

    return {
      counts,
      plans,
      answers,
      latencyMs: decided.meta.latencyMs,
      rationale:
        `问该块：${notes.join('，')}` +
        (degraded ? '（本次决策层不支持 numeric，数量已降级为离散档位）' : ''),
      usage: decided.usage,
    };
  }

  /** 结构定稿后评一次分。 */
  private async askQuality(
    request: PlanStructureRequest,
    page: PageSpec,
  ): Promise<{
    readonly score: number | null;
    readonly raw: unknown;
    readonly latencyMs: number;
    readonly rationale: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }> {
    const question: Question = {
      type: 'score',
      instructions:
        '评价这个网页结构的信息完整度与版式顺序合理性。' +
        '有清晰的起始、有内容主体、有收尾则得高分；顺序混乱或缺少收尾则得低分。\n' +
        `结构：${describePageSpec(page)}`,
      // 档位表从低到高。服务端按下标加权算出 0..1 的分数，
      // 所以顺序有意义——把"很好"放第一位会让高分变低分。
      criteria: [...DEFAULT_SCORE_CRITERIA],
    };
    const decided = await this.decision.decide(
      this.buildContext(request, page),
      { [STRUCTURE_QUESTIONS.structureQuality]: question },
      request.decisionTimeoutMs !== undefined ? { timeoutMs: request.decisionTimeoutMs } : {},
    );
    const answer = decided.answers[STRUCTURE_QUESTIONS.structureQuality];
    if (answer === undefined || answer.type !== 'score') {
      throw new StructureError('决策层未返回 structure_quality 的答案', 'INVALID_PAGE');
    }
    const score = answer.value;
    return {
      score,
      raw: answer,
      latencyMs: decided.meta.latencyMs,
      rationale:
        score === null
          ? '结构评分：决策层弃权'
          : `结构评分：${score.toFixed(3)}（${score >= 0.7 ? '良好' : score >= 0.4 ? '一般' : '偏弱'}）`,
      usage: decided.usage,
    };
  }

  /**
   * 组装决策层的 state。
   *
   * 结构性信息必须进 state——不进 state 就等于决策模型不知道自己在给什么页面排版，
   * 那样"逐块决策"退化成"每块独立瞎猜"。
   */
  private buildContext(request: PlanStructureRequest, page: PageSpec): DecisionContext {
    const envType = request.envType ?? 'webpage';
    const deliverable =
      request.deliverable ?? (envType === 'slides' ? '多页演示文稿（一页一屏，16:9）' : '单页 HTML');
    const facts: Record<string, string> = {
      交付格式: deliverable,
      候选block数: String(page.candidateBlockIds.length),
    };
    // 统筹规划的事实。放在结构事实**之前**：先给"要讲什么"，再给"排到哪了"，
    // 决策层读到的顺序与它做决定的顺序一致。
    if (request.blueprint !== undefined) {
      Object.assign(facts, blueprintFacts(request.blueprint));
      // 已排几块 / 计划几段：这是"还要不要继续"这一问最直接的依据。
      facts['已排块数'] = String(page.blocks.length);
    }
    if (page.blocks.length > 0) {
      facts['当前结构'] = describePageSpec(page);
    }
    return {
      goal: request.goal,
      envType,
      ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
      facts,
    };
  }
}

/** 把数量答案转成 pending 块的初始 slot 值（占位空串，等填充器补内容）。 */
function buildCountSlots(
  listSlots: readonly SlotSpec[],
  counts: Readonly<Record<string, number>>,
): Record<string, SlotValue> {
  const slots: Record<string, SlotValue> = {};
  for (const slot of listSlots) {
    const count = counts[slot.name] ?? slot.countRange!.min;
    slots[slot.name] =
      slot.type === 'list-image'
        ? { kind: 'list-image', refs: Array.from({ length: count }, () => ({ ref: '', alt: '' })) }
        : { kind: 'list', items: Array.from({ length: count }, () => '') };
  }
  return slots;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 判断是不是"服务端不认识这个原语"。 */
function isUnsupportedPrimitive(error: unknown): boolean {
  return error instanceof DecisionError && error.reason === 'UNSUPPORTED_PRIMITIVE';
}

/**
 * `numeric` 不被支持时的降级问法：把量程切成离散档位，用 `choice` 问。
 *
 * 为什么这样降级是**等价**而不是将就：`slot_count` 问的是"这块要几项"，
 * 它本来就不需要精确到个位——结构决策关心的是"两个还是五个"这种量级。
 * 档位候选把每一档都写成具体数字，模型选中的那个数字直接就是答案，
 * 所以下游代码一行都不用改。
 *
 * 为什么不用 `score` 代替：`score` 出的是 0..1 的连续值，再乘量程会得到
 * 一个需要二次解释的数；而 `choice` 的候选项就是数字本身，没有解释环节。
 */
function choiceQuestionsFor(listSlots: readonly SlotSpec[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const slot of listSlots) {
    const range = slot.countRange!;
    // 档位：下限、中位、上限。去重后至少 2 项，满足 choice 的下限要求。
    const mid = Math.round((range.min + range.max) / 2);
    const values = [...new Set([range.min, mid, range.max])].sort((a, b) => a - b);
    const criteria: Record<string, string> = {};
    for (const value of values) {
      const where = value === range.min ? '少' : value === range.max ? '多' : '中等';
      criteria[String(value)] = `${value} 项（${where}）`;
    }
    out[`${STRUCTURE_QUESTIONS.slotCount}:${slot.name}`] = {
      type: 'choice',
      instructions:
        `页面上 ${slot.description} 应该有几项？从下面几档里选一个。` +
        `内容单薄就选少的，内容丰富就选多的。`,
      criteria,
    };
  }
  return out;
}

/** 从一批问题里挑出 `slot_source` 那些。降级重发时用——它们本来就是 choice。 */
function sourceQuestionsOf(
  questions: Readonly<Record<string, Question>>,
): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (id.startsWith(`${STRUCTURE_QUESTIONS.slotSource}:`)) out[id] = question;
  }
  return out;
}

/**
 * 本轮没有可问的问题时的空结果。
 *
 * 这不是优化，是**正确性**：`DecisionClient.decide` 明确拒绝空问题集
 * （"至少需要一个决策问题"）。这一轮一个候选可选时，`next_block` 无需提问、
 * 首轮也没有"要不要继续"可问——凑不出任何问题。照发一个空请求，
 * 决策层会抛 `BAD_REQUEST`，整条链路被兜底状态机判成失败。
 *
 * 罕见但真实：候选集里只有一个 block 能当首块时就会走到这里。
 */
function noQuestionsAsked(): DecisionBatchResult {
  return {
    answers: {},
    meta: { latencyMs: 0, source: 'fallback' },
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: { skipped: '本轮没有问题可问' },
  };
}

/** 便于测试与展示：把一串 block 实例转成"类型序列"摘要。 */
export function blockTypeSequence(page: PageSpec): string[] {
  return page.blocks.map((b) => b.type);
}

/** 判断某个 block 是否已经填好。 */
export function isFilled(block: BlockInstance): boolean {
  return block.status === ('filled' satisfies BlockStatus);
}

/**
 * 该 block 是不是"页面末尾块"——放下它之后不可能再有内容。
 *
 * 判据取自 `placement`，而不是硬编码 `'footer'`：将来再加一个
 * "订阅栏"之类的末尾块，只要声明 `placement: 'last'` 就自动获得同样的行为。
 */
function isTerminal(spec: BlockSpec): boolean {
  return spec.placement === 'last';
}
