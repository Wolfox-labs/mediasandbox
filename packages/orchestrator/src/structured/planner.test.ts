/**
 * 逐块决策规划器的测试。
 *
 * ## 这些测试要证明什么
 *
 * 设计稿的地基是"**结构由决策模型决定，不由大模型决定**"。这条主张如果不测，
 * 它就只是一句话。这里用一个**能记账的假决策层**去验：
 *
 *   1. 每一个 `next_block` 真的是问出来的（而不是代码里写死的）
 *   2. 决策层选的块真的变成页面上的块（选择生效，不是装饰）
 *   3. `noul` / `numeric` / `score` 三个此前从未被用到的原语**真的被用到了**
 *   4. 决策层弃权时**回落是确定性的**，且不丢块
 *   5. 一批请求打包多个问题（共享 prefill），而不是一次一问
 *
 * 第 3、5 条尤其重要：它们是"决策模型当廉价判断器"这个用法能否成立的实测依据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Answer,
  ChoiceAnswer,
  DecisionBatchResult,
  DecisionClient,
  DecisionContext,
  Question,
} from '../decision/types.js';
import { DecisionError } from '../decision/types.js';
import { createBlockRegistry } from './block-spec.js';
import {
  CONTINUE_NO_THRESHOLD,
  CONTINUE_YES_THRESHOLD,
  STRUCTURE_QUESTIONS,
  StructureError,
  StructurePlanner,
  blockTypeSequence,
} from './planner.js';

/**
 * 可编程的假决策层。
 *
 * 记录**每一次请求的问题集合**与**每次 choice 的候选 id**，这样才能断言
 * "批量"而不是"逐问"、以及"候选集确实被限制了"。
 */
class ScriptedDecision implements DecisionClient {
  readonly kind = 'stub' as const;
  /** 每次 decide 请求的问题 id 列表，按调用顺序。 */
  readonly batches: string[][] = [];
  /** 每次 choice 问题的候选 id，按调用顺序。 */
  readonly criteria: string[][] = [];

  constructor(
    private readonly responder: (id: string, question: Question, callIndex: number) => Answer,
  ) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'scripted' };
  }

  async decide(
    _context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
    _options: { timeoutMs?: number } = {},
  ): Promise<DecisionBatchResult> {
    const callIndex = this.batches.length;
    const ids = Object.keys(questions);
    this.batches.push(ids);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'choice') this.criteria.push(Object.keys(question.criteria));
      answers[id] = this.responder(id, question, callIndex);
    }
    return {
      answers,
      meta: { latencyMs: 1, source: 'stub' },
      usage: { inputTokens: 10, outputTokens: 0 },
      raw: { scripted: true },
    };
  }
}

/** 造一个合法概率分布，把 `value` 抬到最高。 */
function spread(ids: readonly string[], value: string): Record<string, number> {
  const others = ids.filter((id) => id !== value);
  const share = others.length > 0 ? 0.3 / others.length : 0;
  return Object.fromEntries(ids.map((id) => [id, id === value ? 0.7 : share]));
}

/**
 * 按给定的块序列逐轮作答。
 *
 * **游标会跳过不在本次候选里的项**：规划器在"只有一个可用候选"时不提问
 * （问一个只有一项的问题没有意义），直接采用；这种轮次不消耗游标，
 * 所以游标必须按"实际可选项"对齐，而不是按调用次数对齐。
 */
function picker(
  choices: readonly string[],
  opts: { continueUntil?: number } = {},
): ScriptedDecision {
  let cursor = 0;
  let placed = 0;
  const stopAt = opts.continueUntil ?? choices.length;
  return new ScriptedDecision((id, question) => {
    if (id === STRUCTURE_QUESTIONS.nextBlock && question.type === 'choice') {
      const available = Object.keys(question.criteria);
      while (cursor < choices.length && !available.includes(choices[cursor]!)) cursor += 1;
      const next = choices[cursor] ?? available[0]!;
      cursor += 1;
      placed += 1;
      return { type: 'choice', value: next, probabilities: spread(available, next) } satisfies ChoiceAnswer;
    }
    if (id === STRUCTURE_QUESTIONS.continueStruct) {
      const go = placed < stopAt;
      return { type: 'noul', value: go, yesProbability: go ? 0.9 : 0.05 };
    }
    if (id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`) && question.type === 'numeric') {
      const range = question.range ?? { min: 1, max: 4 };
      return { type: 'numeric', value: range.min + 1 };
    }
    if (id === STRUCTURE_QUESTIONS.structureQuality) {
      return { type: 'score', value: 0.75 };
    }
    return { type: 'noul', value: false, yesProbability: 0.1 };
  });
}

/**
 * 按"选块 + 数量"两个可编程钩子造一个假决策层，并自动处理继续/停止：
 * 只要还有轮次可走就答继续，走完就停。
 *
 * 抽出来是因为好几组用例都需要"跑满 N 轮"，而每处各写一遍
 * 极易写成"第一轮就问停"，于是只拿到一块、断言全部落空——
 * 这种假失败会掩盖真实缺陷。
 */
function rounds(args: {
  readonly rounds: number;
  readonly pick?: (ids: readonly string[], round: number) => string;
  readonly count?: (range: { min: number; max: number } | undefined, slotName: string) => number | null;
  readonly quality?: number;
  readonly continueAnswer?: (round: number, placedCount: number) => { value: boolean | null; prob: number | null };
}): ScriptedDecision {
  const seenContinue = { n: 0 };
  return new ScriptedDecision((id, question) => {
    if (id === STRUCTURE_QUESTIONS.nextBlock && question.type === 'choice') {
      const ids = Object.keys(question.criteria);
      // 默认取候选里的第一个（策略由调用方给，以覆盖"必须选某个类型"的场景）。
      const target = args.pick?.(ids, seenContinue.n) ?? ids[0]!;
      return { type: 'choice', value: target, probabilities: spread(ids, target) };
    }
    if (id === STRUCTURE_QUESTIONS.continueStruct) {
      seenContinue.n += 1;
      const round = seenContinue.n;
      if (args.continueAnswer !== undefined) {
        const { value, prob } = args.continueAnswer(round, round);
        return { type: 'noul', value, yesProbability: prob };
      }
      const go = round < args.rounds;
      return { type: 'noul', value: go, yesProbability: go ? 0.9 : 0.05 };
    }
    if (id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`)) {
      const slotName = id.split(':')[1] ?? '';
      // 注意：**按实际问句类型作答**，不能只看 id 前缀。
      // 降级路径下同一个 id 会是 `choice` 而不是 `numeric`，
      // 只认前缀会让降级后的请求拿到一个类型不符的答案。
      if (question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        const target = ids[Math.floor(ids.length / 2)] ?? ids[0]!;
        return { type: 'choice', value: target, probabilities: spread(ids, target) };
      }
      if (question.type === 'numeric') {
        // 不能用 `??`——`null` 是合法返回值，表示"决策层弃权"。
        // 用 `??` 会把弃权悄悄变成"取区间下限"，于是弃权路径根本测不到。
        const value =
          args.count !== undefined ? args.count(question.range, slotName) : (question.range?.min ?? 2);
        return { type: 'numeric', value };
      }
    }
    return { type: 'score', value: args.quality ?? 0.5 };
  });
}

const REQUEST = { projectId: 'proj-test', goal: '做一个产品介绍落地页' };

/**
 * 候选集。
 *
 * 刻意放**两个**能当首块的（`hero` 与 `text`）：这样首轮就真的会提一个问题，
 * 测试里的游标才能与"实际决策次数"一一对应。只有一个候选时规划器不提问
 * （这是刻意的优化，另有专门用例覆盖）。
 */
const CANDIDATES = ['hero', 'text', 'features', 'cta', 'footer'] as const;

describe('结构规划器：结构确实由决策模型决定', () => {
  it('决策层选的块，真的按顺序出现在页面上', async () => {
    const decision = picker(['hero', 'features', 'cta']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });

    assert.deepEqual(blockTypeSequence(result.page), ['hero', 'features', 'cta']);
    // 每个块都有稳定 id 与状态，这是"可定点重做"的前提。
    assert.deepEqual(
      result.page.blocks.map((b) => b.id),
      ['b1', 'b2', 'b3'],
    );
    assert.ok(result.page.blocks.every((b) => b.status === 'pending'));
  });

  it('换一组选择，结构跟着变——说明结构不是写死的', async () => {
    const registry = createBlockRegistry();
    const a = await new StructurePlanner(registry, picker(['hero', 'features', 'cta'])).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const b = await new StructurePlanner(registry, picker(['text', 'features', 'footer'])).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.notDeepEqual(blockTypeSequence(a.page), blockTypeSequence(b.page));
    assert.deepEqual(blockTypeSequence(b.page), ['text', 'features', 'footer']);
  });

  it('候选集限制了决策模型能选的——不在集合里的选不出来', async () => {
    // 一律答 gallery，而候选集里没有它。
    const decision = new ScriptedDecision((id, question) => {
      if (id === STRUCTURE_QUESTIONS.nextBlock && question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        return { type: 'choice', value: 'gallery', probabilities: spread(ids, ids[0]!) };
      }
      return { type: 'score', value: 0.5 };
    });
    await assert.rejects(
      () => new StructurePlanner(createBlockRegistry(), decision).plan({
        ...REQUEST,
        candidateBlockIds: ['hero', 'text', 'cta'],
      }),
      (e: unknown) => e instanceof StructureError && e.code === 'PICK_OUT_OF_CANDIDATES',
    );
    // 而且 criteria 里从头到尾都没放开过 gallery。
    assert.ok(decision.criteria.length > 0, '一个 choice 问题都没问');
    for (const ids of decision.criteria) {
      assert.ok(!ids.includes('gallery'), `候选集里出现了 gallery: ${ids.join(',')}`);
    }
  });

  it('未注册的候选直接拦下，不让它进候选集', async () => {
    const planner = new StructurePlanner(createBlockRegistry(), picker([]));
    await assert.rejects(
      () => planner.plan({ ...REQUEST, candidateBlockIds: ['hero', 'not-registered'] }),
      /不在 block 池中/,
    );
  });

  it('首轮的候选里只有 canLead 的——footer / cta 开不了头', async () => {
    const decision = picker(['hero', 'cta']);
    await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const firstBatch = decision.batches[0] ?? [];
    assert.ok(firstBatch.includes(STRUCTURE_QUESTIONS.nextBlock), '首轮没有问下一块');
    const firstCriteria = decision.criteria[0]!;
    assert.ok(firstCriteria.includes('hero'), '首轮候选里应当有 hero');
    assert.ok(firstCriteria.includes('text'), '首轮候选里应当有 text（它也能当首块）');
    for (const blocked of ['cta', 'footer', 'features']) {
      assert.ok(
        !firstCriteria.includes(blocked),
        `首轮候选里不该出现 ${blocked}——它不能当首块，就不该给模型这个选项`,
      );
    }
  });

  it('首轮候选集里没有任何 canLead 时报错，而不是随便选一个', async () => {
    const planner = new StructurePlanner(createBlockRegistry(), picker([]));
    await assert.rejects(
      () => planner.plan({ ...REQUEST, candidateBlockIds: ['footer', 'cta'] }),
      (e: unknown) => e instanceof StructureError && e.code === 'NO_CANDIDATES',
    );
  });

  it('唯一可用候选时不提问，直接采用——问一个只有一项的问题没有意义', async () => {
    // footer / cta 都不能当首块，能当首块的只有 hero。
    const decision = picker(['hero', 'footer']);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero', 'footer'],
    });
    assert.equal(result.page.blocks[0]?.type, 'hero');
    // 首轮**没有** choice 问题：直接采用了唯一候选。
    const firstBatch = decision.batches[0] ?? [];
    assert.ok(
      !firstBatch.includes(STRUCTURE_QUESTIONS.nextBlock),
      `首轮不该提问，实际问了 ${firstBatch.join(',')}`,
    );
    assert.ok(result.rationale.some((r) => r.includes('唯一可用候选')));
  });

  it('不可重复的 block 用过一次后不再出现在后续候选里', async () => {
    const decision = picker(['hero', 'features', 'text', 'gallery']);
    await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    // hero 是 repeatable: false。它被选过之后，候选里不该再出现。
    const seenAfterHero = decision.criteria.slice(1);
    for (const ids of seenAfterHero) {
      assert.ok(!ids.includes('hero'), `hero 用过之后又出现了: ${ids.join(',')}`);
    }
  });
});

describe('结构规划器：四个原语都用上了', () => {
  it('choice / noul / numeric / score 四类问题都真的提出来过', async () => {
    const decision = picker(['hero', 'features', 'footer']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });

    const asked = new Set(decision.batches.flat());
    assert.ok(asked.has(STRUCTURE_QUESTIONS.nextBlock), '没问过 choice: next_block');
    assert.ok(asked.has(STRUCTURE_QUESTIONS.continueStruct), '没问过 noul: continue_structuring');
    assert.ok(
      [...asked].some((k) => k.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`)),
      '没问过 numeric: slot_count',
    );
    assert.ok(asked.has(STRUCTURE_QUESTIONS.structureQuality), '没问过 score: structure_quality');
  });

  it('决策层输出 0 个 token——它不生成文本', async () => {
    const decision = picker(['hero', 'cta']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });
    assert.equal(result.usage.outputTokens, 0);
  });

  it('一轮里的多个问题打包成一次请求（共享 prefill）', async () => {
    const decision = picker(['hero', 'cta']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });

    // 第二轮之后的 select 请求应当同时带 continue_structuring 与 next_block。
    const packed = decision.batches.filter(
      (ids) =>
        ids.includes(STRUCTURE_QUESTIONS.nextBlock) &&
        ids.includes(STRUCTURE_QUESTIONS.continueStruct),
    );
    assert.ok(packed.length > 0, '没有一轮把"继续吗"和"放哪块"打包在一起');
  });

  it('数量问题单独一批——它依赖"选中了哪块"，与选择有因果关系', async () => {
    const decision = picker(['hero', 'features']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });

    const countBatches = decision.batches.filter(
      (ids) => ids.length > 0 && ids.every((id) => id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`)),
    );
    assert.ok(countBatches.length > 0, '没有单独问过数量');
    for (const batch of decision.batches) {
      const hasPick = batch.includes(STRUCTURE_QUESTIONS.nextBlock);
      const hasCount = batch.some((id) => id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`));
      assert.ok(!(hasPick && hasCount), '数量问题不该与选择问题同批');
    }
  });

  it('决策层报出的数量真的变成列表长度', async () => {
    // 首轮选一个能当首块的，第二轮选 features，数量答 5。
    const decision = rounds({
      rounds: 2,
      pick: (ids) => (ids.includes('features') ? 'features' : 'text'),
      count: () => 5,
    });
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const features = result.page.blocks.find((b) => b.type === 'features');
    assert.ok(features !== undefined, '没有选中 features');
    const items = features.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') assert.equal(items.items.length, 5);
  });

  it('score 的结果记在页面上，并出现在留痕里', async () => {
    const decision = picker(['hero', 'cta']);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.equal(result.page.qualityScore, 0.75);
    const qualityStep = result.steps.find((s) => s.kind === 'quality');
    assert.ok(qualityStep !== undefined);
    assert.equal(qualityStep.score, 0.75);
  });
});

describe('结构规划器：数量问题的边界处理', () => {
  /**
   * 选到 `features` 并问出数量。
   *
   * **必须跑两轮**：`features` 声明了 `canLead: false`，所以它不在首轮候选里。
   * 首轮先选一个能当首块的（`text`），第二轮才轮得到它。
   * 这一点本身就是"不让模型犯错"那条设计在起作用。
   */
  function numericAnswer(value: number | null): ScriptedDecision {
    return rounds({
      rounds: 2,
      pick: (ids) => (ids.includes('features') ? 'features' : 'text'),
      count: () => value,
    });
  }

  it('features 不进首轮候选——canLead 的约束在起作用', async () => {
    const decision = numericAnswer(3);
    await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const first = decision.criteria[0]!;
    assert.ok(!first.includes('features'), 'features 不该出现在首轮候选里');
    assert.ok(first.includes('text'), '首轮该有能当首块的 text');
    // 第二轮它才出现。
    assert.ok(decision.criteria[1]?.includes('features'), '第二轮该出现 features');
  });

  it('决策层给的数量越界时被夹进声明区间（否则结构校验会直接失败）', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), numericAnswer(99)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const items = result.page.blocks.find((b) => b.type === 'features')?.slots['items'];
    assert.equal(items?.kind, 'list', '没有拿到 features 的列表 slot');
    // features.items 的区间是 2..6。
    if (items?.kind === 'list') assert.equal(items.items.length, 6);
  });

  it('数量给 0 也被夹到下限', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), numericAnswer(0)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const items = result.page.blocks.find((b) => b.type === 'features')?.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') assert.equal(items.items.length, 2);
  });

  it('决策层弃权时用确定性回落，且不丢块', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), numericAnswer(null)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const items = result.page.blocks.find((b) => b.type === 'features')?.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') {
      assert.ok(items.items.length >= 2 && items.items.length <= 6);
      // 弃权时占位为空串，等填充器补内容。
      assert.ok(items.items.every((s) => s === ''));
    }
    const step = result.steps.find((s) => s.kind === 'count_only');
    assert.match(step?.rationale ?? '', /弃权回落/);
  });
});

describe('结构规划器：继续/停止的判定', () => {
  /**
   * 第 1 轮用给定答案，之后一律停。
   *
   * 刻意**不**用"value/概率都给不出"的那次去答停——弃权路径下有它自己的规则。
   */
  function noulAnswer(value: boolean | null, prob: number | null): ScriptedDecision {
    return rounds({
      rounds: 1,
      continueAnswer: (round) =>
        round === 1 ? { value, prob } : { value: false, prob: 0.05 },
    });
  }

  it('明确答"停"就停', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), noulAnswer(false, 0.1)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.equal(result.page.blocks.length, 1);
  });

  it('明确答"继续"就继续', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), noulAnswer(true, 0.9)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.ok(result.page.blocks.length > 1);
  });

  it('continue 的判定依据也会留痕——否则"为什么又多了一块"永远无从解释', async () => {
    const result = await new StructurePlanner(createBlockRegistry(), noulAnswer(true, 0.9)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    // 第 2 轮的 rationale 里必须同时有"继续的判定"与"选了哪块"。
    const secondRound = result.steps.find((s) => s.round === 1 && s.kind === 'select');
    assert.ok(secondRound !== undefined);
    assert.match(secondRound.rationale, /是概率 0\.90/);
    assert.match(secondRound.rationale, /选中/);
    assert.equal(secondRound.continued, true);
    assert.equal(secondRound.continueProbability, 0.9);
  });

  it('概率落在滞回带时，交给确定性规则判——而不是在 0.5 上抛硬币', async () => {
    // 0.5 恰在 CONTINUE_NO_THRESHOLD..CONTINUE_YES_THRESHOLD 之间。
    assert.ok(0.5 > CONTINUE_NO_THRESHOLD && 0.5 < CONTINUE_YES_THRESHOLD);
    const result = await new StructurePlanner(createBlockRegistry(), noulAnswer(null, 0.5)).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const step = result.steps.find((s) => /滞回带/.test(s.rationale));
    assert.ok(step !== undefined, '没有一轮走进滞回带');
    assert.ok(result.page.blocks.length >= 1, '不该因为落在滞回带就丢块');
    // 滞回带里的结论来自确定性规则，因此必须能说清楚依据。
    assert.ok(step.continued !== null);
    assert.match(step.rationale, /是概率 0\.50/);
  });

  it('滞回带里的判定取决于页面是否已收尾，而不是抛硬币', async () => {
    // 第一轮选 cta（收尾块），第二轮再进滞回带时应判停。
    const decision = rounds({
      rounds: 3,
      pick: (ids, round) => (round === 0 && ids.includes('cta') ? 'cta' : ids[0]!),
      continueAnswer: (round) => (round === 2 ? { value: null, prob: 0.5 } : { value: true, prob: 0.9 }),
    });
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero', 'cta', 'features'],
    });
    const band = result.steps.find((s) => /滞回带/.test(s.rationale));
    assert.ok(band !== undefined, '没有走进滞回带');
    assert.equal(band.continued, false, '页面已有收尾块时滞回带应判停');
    assert.match(band.rationale, /已有收尾块/);
  });

  it('value 与概率都给不出时也给出确定性结论，且说明是弃权', async () => {
    // 全程弃权：靠 maxBlocks 收尾，不该崩。
    const decision = rounds({
      rounds: 99,
      continueAnswer: () => ({ value: null, prob: null }),
    });
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
      maxBlocks: 3,
    });
    assert.ok(result.page.blocks.length >= 2);
    assert.ok(
      result.steps.some((s) => /弃权/.test(s.rationale)),
      '弃权没有被记录成可读的依据',
    );
  });

  it('maxBlocks 是硬上限——不让"要不要继续"无限答是', async () => {
    const decision = rounds({
      rounds: 99,
      continueAnswer: () => ({ value: true, prob: 0.99 }),
    });
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero', 'text'],
      maxBlocks: 3,
    });
    assert.equal(result.page.blocks.length, 3);
  });

  it('候选集用尽时自然收尾，不报错', async () => {
    const decision = rounds({
      rounds: 99,
      continueAnswer: () => ({ value: true, prob: 0.99 }),
    });
    // hero 与 form 都不可重复，用完就没了；两者都不带位置约束。
    //
    // 这里**刻意不用 footer**：它声明了 `placement: 'last'`，会在放下它的那一刻
    // 直接收尾（那是另一条路径，另有专门用例覆盖），走不到"候选集用尽"这一支。
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero', 'form'],
      maxBlocks: 10,
    });
    assert.equal(result.page.blocks.length, 2);
    assert.ok(result.rationale.some((r) => r.includes('已用尽')));
  });
});

describe('结构规划器：末尾块收尾与版式规范化', () => {
  it('放下末尾块（footer）之后立即收尾，不再问"要不要继续"', async () => {
    // 模型第 2 轮就挑了 footer，第 3 轮本来还想再放一块 features。
    const decision = picker(['hero', 'footer', 'features']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: CANDIDATES });

    // 页脚之后不该还有正文。`canLead` 只挡得住"第一块放 footer"，
    // 挡不住"第二块放 footer"——所以必须有这条。
    assert.deepEqual(blockTypeSequence(result.page), ['hero', 'footer']);
    assert.ok(
      result.rationale.some((r) => r.includes('末尾块')),
      '收尾原因要留痕，否则看不出"为什么只有两块"',
    );
  });

  it('nav 被排到中间时挪回最前，且修正记录出现在 fixes 与 rationale 里', async () => {
    const candidates = ['hero', 'nav', 'features'] as const;
    const decision = picker(['hero', 'features', 'nav']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: candidates });

    assert.deepEqual(blockTypeSequence(result.page), ['nav', 'hero', 'features']);
    assert.equal(result.fixes.length, 1);
    assert.equal(result.fixes[0]?.kind, 'moved');
    assert.match(result.fixes[0]!.detail, /placement='first'/);
    assert.ok(
      result.rationale.some((r) => r.includes('版式规范化')),
      '规范化不能是悄悄发生的——界面上要看得见结构被动过',
    );
  });

  it('模型排出来本来就合规时，fixes 为空（不制造无意义的修正记录）', async () => {
    // 候选里多留一个 features：否则最后一轮只剩 cta 一个可选项时，
    // 规划器不提问、直接采用，测试游标就不会前进。
    const candidates = ['nav', 'hero', 'cta', 'features'] as const;
    const decision = picker(['nav', 'hero', 'cta']);
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: candidates });

    assert.deepEqual(blockTypeSequence(result.page), ['nav', 'hero', 'cta']);
    assert.equal(result.fixes.length, 0);
  });

  it('规范化发生在评分之前——score 看到的结构里 nav 已经在最前', async () => {
    const candidates = ['hero', 'nav', 'features'] as const;
    const picks = ['hero', 'features', 'nav'];
    let cursor = 0;
    let qualityInstructions = '';
    const decision = new ScriptedDecision((id, question) => {
      if (id === STRUCTURE_QUESTIONS.nextBlock && question.type === 'choice') {
        const available = Object.keys(question.criteria);
        while (cursor < picks.length && !available.includes(picks[cursor]!)) cursor += 1;
        const next = picks[cursor] ?? available[0]!;
        cursor += 1;
        return { type: 'choice', value: next, probabilities: spread(available, next) };
      }
      if (id === STRUCTURE_QUESTIONS.continueStruct) {
        return { type: 'noul', value: cursor < picks.length, yesProbability: 0.9 };
      }
      if (id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`) && question.type === 'numeric') {
        return { type: 'numeric', value: question.range?.min ?? 2 };
      }
      if (id === STRUCTURE_QUESTIONS.structureQuality && question.type === 'score') {
        qualityInstructions = question.instructions;
        return { type: 'score', value: 0.75 };
      }
      return { type: 'noul', value: false, yesProbability: 0.1 };
    });
    const planner = new StructurePlanner(createBlockRegistry(), decision);
    const result = await planner.plan({ ...REQUEST, candidateBlockIds: candidates });

    assert.deepEqual(blockTypeSequence(result.page), ['nav', 'hero', 'features']);
    // 评分那一次请求的 instructions 里嵌了结构摘要；第一个块应当是 nav。
    // 若规范化排在评分之后，这里看到的还是 hero 开头 —— 评的就是一个要被改掉的中途状态。
    assert.match(qualityInstructions, /结构：1\. nav/);
  });
});

describe('结构规划器：决策层弃权与异常', () => {
  it('选块弃权时按概率回落，且记录依据', async () => {
    const decision = new ScriptedDecision((id, question) => {
      if (id === STRUCTURE_QUESTIONS.nextBlock && question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        // 明确弃权（value=null），但给出倾向 hero 的概率分布。
        return { type: 'choice', value: null, probabilities: spread(ids, 'hero') };
      }
      if (id === STRUCTURE_QUESTIONS.continueStruct) {
        return { type: 'noul', value: false, yesProbability: 0.05 };
      }
      if (id.startsWith(`${STRUCTURE_QUESTIONS.slotCount}:`) && question.type === 'numeric') {
        return { type: 'numeric', value: question.range?.min ?? 2 };
      }
      return { type: 'score', value: 0.5 };
    });
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.equal(result.page.blocks[0]?.type, 'hero', '弃权时应按概率取最大项');
    assert.ok(result.rationale.some((r) => r.includes('弃权')));
  });

  it('决策层不返回 next_block 答案时报错', async () => {
    const decision = new ScriptedDecision(() => ({ type: 'score', value: 0.5 }));
    await assert.rejects(
      () =>
        new StructurePlanner(createBlockRegistry(), decision).plan({
          ...REQUEST,
          candidateBlockIds: CANDIDATES,
        }),
      StructureError,
    );
  });

  it('决策层抛错时向上传播，不被吞掉', async () => {
    const failing: DecisionClient = {
      kind: 'stub',
      async health() {
        return { ok: false, detail: 'down' };
      },
      async decide() {
        throw new DecisionError('决策层不可达', 'UNREACHABLE');
      },
    };
    await assert.rejects(
      () =>
        new StructurePlanner(createBlockRegistry(), failing).plan({
          ...REQUEST,
          candidateBlockIds: CANDIDATES,
        }),
      DecisionError,
    );
  });

  it('空候选集直接拒绝', async () => {
    const planner = new StructurePlanner(createBlockRegistry(), picker([]));
    await assert.rejects(
      () => planner.plan({ ...REQUEST, candidateBlockIds: [] }),
      (e: unknown) => e instanceof StructureError && e.code === 'NO_CANDIDATES',
    );
  });
});

describe('结构规划器：环境降级（决策层不支持 numeric）', () => {
  /**
   * 模拟 rizzo-flow：收到 `numeric` 就抛 `UNSUPPORTED_PRIMITIVE`，
   * 其余正常作答。
   *
   * 这不是假想——实测该服务只接受 noul / choice / score，
   * 所以**每一个带列表的 block 都会撞上它**，即整条链路必挂。
   */
  class NumericHostileDecision implements DecisionClient {
    readonly kind = 'stub' as const;
    readonly seen: string[][] = [];
    readonly numericAttempts: string[] = [];

    constructor(private readonly fallback: ScriptedDecision) {}

    async health(): Promise<{ ok: boolean; detail: string }> {
      return { ok: true, detail: 'numeric-hostile' };
    }

    async decide(
      context: DecisionContext,
      questions: Readonly<Record<string, Question>>,
      options: { timeoutMs?: number } = {},
    ): Promise<DecisionBatchResult> {
      const ids = Object.keys(questions);
      this.seen.push(ids);
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'numeric') {
          this.numericAttempts.push(id);
          throw new DecisionError(
            `决策服务不支持原语 numeric（HTTP 422）`,
            'UNSUPPORTED_PRIMITIVE',
          );
        }
      }
      return await this.fallback.decide(context, questions, options);
    }
  }

  /** 只接受 choice 档位的降级目标。 */
  function choiceOnlyFallback(): ScriptedDecision {
    return rounds({
      rounds: 2,
      pick: (ids) => (ids.includes('features') ? 'features' : 'text'),
      // 数量在降级后是 choice，候选 id 就是数字字符串，这里选中间的档位。
      count: (range) => (range === undefined ? 3 : Math.round((range.min + range.max) / 2)),
    });
  }

  it('numeric 被拒时自动降级成 choice 档位，链路不失败', async () => {
    const inner = choiceOnlyFallback();
    const decision = new NumericHostileDecision(inner);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });

    // 真的撞上过 numeric。
    assert.ok(decision.numericAttempts.length > 0, '没有触发 numeric 路径，用例失去意义');
    // 但链路仍然跑通，并产出了结构。
    assert.ok(result.page.blocks.length >= 2, '降级后应当照样产出结构');
    // 数量落在声明区间内——否则结构校验会失败。
    const features = result.page.blocks.find((b) => b.type === 'features');
    const items = features?.slots['items'];
    if (items?.kind === 'list') {
      assert.ok(items.items.length >= 2 && items.items.length <= 6);
    }
  });

  it('降级会被记录在留痕里，不是悄悄发生', async () => {
    const decision = new NumericHostileDecision(choiceOnlyFallback());
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    const countStep = result.steps.find((s) => s.kind === 'count_only');
    assert.ok(countStep !== undefined, '没有数量轮次');
    assert.match(countStep.rationale, /降级/);
    assert.match(countStep.rationale, /numeric 不可用/);
  });

  it('降级后的数量问题确实用的是 choice 原语', async () => {
    const inner = choiceOnlyFallback();
    const decision = new NumericHostileDecision(inner);
    await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    // 第二次带 slot_count 的请求应当是 choice。从 inner 的 criteria 记录里看。
    const countCriteria = inner.criteria.filter((ids) =>
      ids.every((id) => /^\d+$/.test(id)),
    );
    assert.ok(countCriteria.length > 0, '降级后没有用数字档位当 choice 候选');
    // 档位至少两档，否则 choice 本身就不合法。
    for (const ids of countCriteria) assert.ok(ids.length >= 2, `档位只有 ${ids.length} 个`);
  });

  it('其他错误照旧向上传播，不被降级逻辑吞掉', async () => {
    const failing: DecisionClient = {
      kind: 'stub',
      async health() {
        return { ok: true, detail: 'x' };
      },
      async decide() {
        throw new DecisionError('决策层不可达', 'UNREACHABLE');
      },
    };
    await assert.rejects(
      () =>
        new StructurePlanner(createBlockRegistry(), failing).plan({
          ...REQUEST,
          candidateBlockIds: CANDIDATES,
        }),
      (e: unknown) => e instanceof DecisionError && e.reason === 'UNREACHABLE',
    );
  });
});

describe('结构规划器：留痕', () => {
  it('每一轮都有可读的依据，供前端展示与沉淀', async () => {
    const decision = picker(['hero', 'features', 'cta']);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.ok(result.rationale.length >= 3);
    for (const line of result.rationale) {
      assert.ok(line.trim().length > 0);
    }
    assert.ok(result.steps.length >= 3);
    for (const step of result.steps) {
      assert.ok(typeof step.round === 'number');
      assert.ok(step.rationale.length > 0);
    }
    // 结构摘要进得了 state —— 不进 state 就等于决策模型不知道自己在给什么排版。
    assert.ok(result.rationale.length > 0);
  });

  it('决策调用次数与轮数一致量级，不是每问一次', async () => {
    const decision = picker(['hero', 'features', 'cta']);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
    });
    assert.equal(result.decisionCalls, decision.batches.length);
    // 3 轮选块 + 1 次数量 + 1 次评分。
    assert.ok(result.decisionCalls <= 6, `调了 ${result.decisionCalls} 次，超出预期`);
  });

  it('onStep 回调抛错不影响规划', async () => {
    const decision = picker(['hero', 'cta']);
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: CANDIDATES,
      onStep: () => {
        throw new Error('回调故意抛错');
      },
    });
    assert.equal(result.page.blocks.length, 2);
  });
});
