/**
 * 固定回答的决策层桩实现。
 *
 * 存在意义：编排层（工具注册表 / DAG 组装 / 执行器 / 兜底）必须先能独立跑通并测试，
 * 不能被第 2 项（决策层后训练与调用）的进度阻塞。桩与真实客户端实现同一接口，
 * 因此替换时上层零改动。
 *
 * 预设按 `类型:id` 记录，未预设时回落到该类型的默认答案。之所以要按类型区分：
 * 同一个问题 id 在不同上下文里可能是不同类型，只按 id 记录会串味。
 */
import {
  DecisionError,
  assertChoiceCriteria,
  type Answer,
  type ChoiceAnswer,
  type DecisionBatchResult,
  type DecisionClient,
  type DecisionContext,
  type NoulAnswer,
  type NumericAnswer,
  type Question,
  type ScoreAnswer,
} from './types.js';

interface Preset {
  readonly answers: Map<string, Answer>;
  readonly fallbacks: Map<Question['type'], (question: Question) => Answer>;
}

function presetKey(type: Question['type'], id: string): string {
  return `${type}:${id}`;
}

export class StubDecisionClient implements DecisionClient {
  readonly kind = 'stub' as const;
  private readonly preset: Preset = { answers: new Map(), fallbacks: new Map() };
  private healthy = true;
  private latencyMs = 0;

  /** 让 health() 返回不可达，用于测试降级路径。 */
  setHealthy(ok: boolean): this {
    this.healthy = ok;
    return this;
  }

  /** 模拟耗时，用于测试并发与超时相关行为。 */
  setLatency(ms: number): this {
    this.latencyMs = ms;
    return this;
  }

  onNoul(questionId: string, value: boolean, yesProbability?: number): this {
    const answer: NoulAnswer = {
      type: 'noul',
      value,
      yesProbability: yesProbability ?? (value ? 0.95 : 0.05),
    };
    this.preset.answers.set(presetKey('noul', questionId), answer);
    return this;
  }

  onChoice(
    questionId: string,
    value: string,
    probabilities?: Readonly<Record<string, number>>,
  ): this {
    const answer: ChoiceAnswer = {
      type: 'choice',
      value,
      probabilities: probabilities ?? { [value]: 0.9 },
    };
    this.preset.answers.set(presetKey('choice', questionId), answer);
    return this;
  }

  /** 预设弃权回答，用于测试兜底状态机对「模型不知道」的处理。 */
  onAbstain(questionId: string, type: Question['type'], status = 'unknown'): this {
    const abstention = { status };
    const answer: Answer =
      type === 'noul'
        ? { type: 'noul', value: null, yesProbability: null, abstention }
        : type === 'choice'
          ? { type: 'choice', value: null, probabilities: {}, abstention }
          : type === 'score'
            ? { type: 'score', value: null, abstention }
            : { type: 'numeric', value: null, abstention };
    this.preset.answers.set(presetKey(type, questionId), answer);
    return this;
  }

  onScore(questionId: string, value: number): this {
    const answer: ScoreAnswer = { type: 'score', value };
    this.preset.answers.set(presetKey('score', questionId), answer);
    return this;
  }

  onNumeric(questionId: string, value: number): this {
    const answer: NumericAnswer = { type: 'numeric', value };
    this.preset.answers.set(presetKey('numeric', questionId), answer);
    return this;
  }

  /** 覆盖某类型的默认答案。 */
  setFallback(type: Question['type'], factory: (question: Question) => Answer): this {
    this.preset.fallbacks.set(type, factory);
    return this;
  }

  /** 未预设问题的默认答案：全部可判定，且与输入无关，保证确定性。 */
  private defaultAnswer(question: Question): Answer {
    const custom = this.preset.fallbacks.get(question.type);
    if (custom !== undefined) return custom(question);
    switch (question.type) {
      case 'noul':
        return { type: 'noul', value: false, yesProbability: 0.1 };
      case 'choice': {
        const first = Object.keys(question.criteria)[0];
        if (first === undefined) {
          throw new DecisionError('候选集为空，无法给出默认答案', 'BAD_REQUEST');
        }
        const probabilities: Record<string, number> = {};
        const ids = Object.keys(question.criteria);
        for (const id of ids) probabilities[id] = id === first ? 0.8 : 0.2 / (ids.length - 1);
        return { type: 'choice', value: first, probabilities };
      }
      case 'score':
        return { type: 'score', value: 0.5 };
      case 'numeric': {
        const range = question.range;
        const value = range === undefined ? 0 : Math.round((range.min + range.max) / 2);
        return { type: 'numeric', value };
      }
    }
  }

  async decide(
    _context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
    _options: { readonly timeoutMs?: number } = {},
  ): Promise<DecisionBatchResult> {
    const startedAt = Date.now();
    if (Object.keys(questions).length === 0) {
      throw new DecisionError('至少需要一个决策问题', 'BAD_REQUEST');
    }
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(questions)) {
      // 与真实客户端保持同一套入参校验，否则契约测试在桩上会漏掉这些分支。
      if (question.type === 'choice') assertChoiceCriteria(id, question.criteria);
      const preset = this.preset.answers.get(presetKey(question.type, id));
      answers[id] = preset ?? this.defaultAnswer(question);
    }

    return {
      answers,
      meta: { latencyMs: Date.now() - startedAt, source: 'stub' },
      usage: { inputTokens: 0, outputTokens: 0 },
      raw: { stub: true },
    };
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    return this.healthy
      ? { ok: true, detail: 'stub 决策层' }
      : { ok: false, detail: 'stub 被显式置为不可用' };
  }
}

export type { NoulAnswer, ChoiceAnswer, ScoreAnswer, NumericAnswer };
