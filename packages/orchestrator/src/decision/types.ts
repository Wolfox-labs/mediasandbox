/**
 * 决策层（System One）契约。
 *
 * 对接的是 rizzo-flow 的 Jev 兼容 API：`POST /v1/systemone`。
 * 官方文档：https://rizzo-ai-academy.github.io/rizzo-flow/
 *
 * 三条硬性事实决定了本文件的形状：
 *   1. 模型**不生成文本**，只回答封闭问题；答案是一组候选里的一个值加概率。
 *      因此确定性代码负责把答案组装成执行计划，模型不做自由形式的规划。
 *   2. **一次请求可带多个问题，共享一次 prefill**。官方数据：同一个 ~2000 token 的
 *      state 上问 21 个问题，批量 1.0s，逐问 8.1s。所以批量是主接口，单问是语法糖。
 *   3. **支持弃权**。模型可以答「不知道」，此时值为 null 并带 status。这不是错误，
 *      兜底状态机要把它当作合法输入处理。
 */
import type { EnvType } from '@mediasandbox/sandbox';

/** 每问候选数上限，rizzo-flow 官方限制。 */
export const MAX_OPTIONS_PER_QUESTION = 26;

/** rizzo-flow 默认端口。 */
export const RIZZO_DEFAULT_BASE_URL = 'http://127.0.0.1:8017';

/** 模型答不出来时的状态标记。 */
export type AbstentionStatus = string;

/** 每次决策都携带的处境信息，序列化后作为请求的 `state`。 */
export interface DecisionContext {
  /** 用户目标原文。 */
  readonly goal: string;
  /** 沙盒环境类型。 */
  readonly envType: EnvType;
  /** 硬约束，逐条列出。 */
  readonly constraints?: readonly string[];
  /** 已知事实键值对，例如 { 交付格式: '网页' }。 */
  readonly facts?: Readonly<Record<string, string>>;
  /** 前序步骤产出摘要，按执行顺序排列。 */
  readonly evidence?: readonly string[];
}

export interface DecisionMeta {
  /** 端到端耗时毫秒。 */
  readonly latencyMs: number;
  /** 决策来源。 */
  readonly source: 'systemone' | 'stub' | 'fallback';
  /** 模型自报置信度。非 choice 类型可能缺省。 */
  readonly confidence?: number;
  /** 模型返回的服务端模型名，例如 rizzo-spark-x2.5-4b-q8。 */
  readonly model?: string;
}

/** 弃权信息。value 为 null 时必然存在。 */
export interface Abstention {
  readonly status: AbstentionStatus;
}

// ── 问题定义（请求侧） ────────────────────────────────────────────────

export interface NoulQuestion {
  readonly type: 'noul';
  /** 封闭问句。 */
  readonly instructions: string;
}

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  /**
   * 候选集：id → 描述。至少 2 项，至多 MAX_OPTIONS_PER_QUESTION 项。
   * 候选来自工具注册表，因此扩展工具链只需改注册表，不需要重训模型。
   */
  readonly criteria: Readonly<Record<string, string>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
}

export interface NumericQuestion {
  readonly type: 'numeric';
  readonly instructions: string;
  /** 提示模型的量程。 */
  readonly range?: { readonly min: number; readonly max: number };
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion | NumericQuestion;

// ── 回答（响应侧） ────────────────────────────────────────────────────

export interface NoulAnswer {
  readonly type: 'noul';
  readonly value: boolean | null;
  /** 官方字段名为 `noul`，取值即「是」的概率。 */
  readonly yesProbability: number | null;
  readonly abstention?: Abstention;
}

export interface ChoiceAnswer {
  readonly type: 'choice';
  /** 命中的候选 id；弃权时为 null。 */
  readonly value: string | null;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly abstention?: Abstention;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /** 0..1；弃权时为 null。 */
  readonly value: number | null;
  readonly abstention?: Abstention;
}

export interface NumericAnswer {
  readonly type: 'numeric';
  readonly value: number | null;
  readonly abstention?: Abstention;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer | NumericAnswer;

/** 一次批量决策的结果：answers 的键与请求 questions 的键一一对应。 */
export interface DecisionBatchResult {
  readonly answers: Readonly<Record<string, Answer>>;
  readonly meta: DecisionMeta;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /** 原样保留服务端响应，便于排查与存证。 */
  readonly raw: unknown;
}

/**
 * 决策层客户端。
 *
 * 两个实现：
 *   - RizzoFlowClient      HTTP 对接本地 llama.cpp 上的 rizzo-flow
 *   - StubDecisionClient   固定/脚本化回答，让编排层不被决策层阻塞
 *
 * 二者必须通过同一套契约测试（testing/decision-contract.ts）。
 */
export interface DecisionClient {
  readonly kind: 'systemone' | 'stub';

  /**
   * 主接口：一次提交多个问题，共享同一个 state 的 prefill。
   * 问题顺序与键名会原样保留在结果的 answers 里。
   */
  decide(
    context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
    options?: { readonly timeoutMs?: number },
  ): Promise<DecisionBatchResult>;

  /** 探活。编排层启动时调用；失败则走 fallback 路径。 */
  health(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/**
 * 决策层错误。兜底状态机据此区分「模型不可用」与「工具执行失败」。
 *
 * **刻意不继承 `SandboxError`。** 决策层不是沙盒，把它挂进沙盒的错误体系会带来
 * 两个问题：
 *   1. 语义错位——`SandboxErrorCode` 里没有"决策层不可用"这一项，只能硬塞成
 *      `'UNSUPPORTED'`（"环境预设不支持该操作"），与真实原因无关。
 *   2. 判定顺序依赖——`classifyFailure` 里 `instanceof DecisionError` 必须排在
 *      `instanceof SandboxError` **之前**才不出错。谁调换顺序，决策层不可用就会被
 *      误判成工具错误，进而按错误的重试策略处理（不可重试的故障被反复重试）。
 *
 * 独立继承 `Error` 后，两条 `instanceof` 互不干扰，顺序不再重要。
 */
export class DecisionError extends Error {
  override readonly name = 'DecisionError';
  constructor(
    message: string,
    readonly reason: DecisionErrorReason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type DecisionErrorReason =
  /** 决策服务不可达。 */
  | 'UNREACHABLE'
  /** 响应结构不符合预期。 */
  | 'BAD_RESPONSE'
  /** 概率分布不合法。 */
  | 'INVALID_PROBABILITIES'
  /** 请求本身不合法（例如候选集少于 2 项或超过 26 项）。 */
  | 'BAD_REQUEST'
  /** 超出等待时间。 */
  | 'TIMEOUT';

/** 校验候选集规模。 */
export function assertChoiceCriteria(questionId: string, criteria: Readonly<Record<string, string>>): void {
  const count = Object.keys(criteria).length;
  if (count < 2) {
    throw new DecisionError(
      `问题 ${questionId} 的候选集只有 ${count} 项，至少需要 2 项`,
      'BAD_REQUEST',
    );
  }
  if (count > MAX_OPTIONS_PER_QUESTION) {
    throw new DecisionError(
      `问题 ${questionId} 的候选集有 ${count} 项，超过上限 ${MAX_OPTIONS_PER_QUESTION}`,
      'BAD_REQUEST',
    );
  }
}

/** 校验概率分布：每项在 [0,1]，总和为 1（容差 1e-3）。 */
export function validateProbabilities(
  probabilities: Readonly<Record<string, number>>,
  reason: (detail: string) => string,
): void {
  const entries = Object.entries(probabilities);
  if (entries.length === 0) {
    throw new DecisionError(reason('概率分布为空'), 'INVALID_PROBABILITIES');
  }
  let sum = 0;
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new DecisionError(
        reason(`概率 ${key}=${String(value)} 不在 [0,1] 内`),
        'INVALID_PROBABILITIES',
      );
    }
    sum += value;
  }
  if (Math.abs(sum - 1) > 1e-3) {
    throw new DecisionError(
      reason(`概率总和为 ${sum.toFixed(6)}，偏离 1 超过容差`),
      'INVALID_PROBABILITIES',
    );
  }
}

/** 从概率分布取最大项；并列时按候选声明顺序取先者，保证确定性可复现。 */
export function argmaxDeterministic(
  candidateIds: readonly string[],
  probabilities: Readonly<Record<string, number>>,
): string {
  let best: string | undefined;
  let bestValue = -Infinity;
  for (const id of candidateIds) {
    const value = probabilities[id] ?? 0;
    if (value > bestValue) {
      best = id;
      bestValue = value;
    }
  }
  if (best === undefined) {
    throw new DecisionError('候选集为空，无法取最大项', 'BAD_REQUEST');
  }
  return best;
}

/** 把上下文序列化成 state 文本。确定性输出，同样的输入永远得到同样的字符串。 */
export function serializeContext(context: DecisionContext): string {
  const lines: string[] = [`目标: ${context.goal}`, `环境: ${context.envType}`];
  if (context.constraints !== undefined && context.constraints.length > 0) {
    lines.push('硬性约束:');
    for (const c of context.constraints) lines.push(`  - ${c}`);
  }
  if (context.facts !== undefined) {
    const keys = Object.keys(context.facts).sort();
    if (keys.length > 0) {
      lines.push('已知事实:');
      for (const key of keys) lines.push(`  - ${key}: ${context.facts[key] ?? ''}`);
    }
  }
  if (context.evidence !== undefined && context.evidence.length > 0) {
    lines.push('前序产出:');
    context.evidence.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
  }
  return lines.join('\n');
}

// ── 单问语法糖（内部走 decide 批量接口） ──────────────────────────────

export interface NoulRequest {
  readonly context: DecisionContext;
  readonly question: string;
  readonly timeoutMs?: number;
}

export interface ChoiceRequest {
  readonly context: DecisionContext;
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly timeoutMs?: number;
}

export interface ScoreRequest {
  readonly context: DecisionContext;
  readonly subject: string;
  readonly rubric: string;
  readonly timeoutMs?: number;
}

export interface NumericRequest {
  readonly context: DecisionContext;
  readonly question: string;
  readonly min: number;
  readonly max: number;
  readonly timeoutMs?: number;
}

const SINGLE_KEY = 'q';

export async function askNoul(client: DecisionClient, request: NoulRequest): Promise<NoulAnswer> {
  const result = await client.decide(
    request.context,
    { [SINGLE_KEY]: { type: 'noul', instructions: request.question } },
    request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
  );
  return expectAnswer(result, SINGLE_KEY, 'noul');
}

export async function askChoice(client: DecisionClient, request: ChoiceRequest): Promise<ChoiceAnswer> {
  const criteria: Record<string, string> = {};
  for (const option of request.options) criteria[option.id] = option.label;
  assertChoiceCriteria(SINGLE_KEY, criteria);
  const result = await client.decide(
    request.context,
    { [SINGLE_KEY]: { type: 'choice', instructions: request.question, criteria } },
    request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
  );
  return expectAnswer(result, SINGLE_KEY, 'choice');
}

export async function askScore(client: DecisionClient, request: ScoreRequest): Promise<ScoreAnswer> {
  const result = await client.decide(
    request.context,
    {
      [SINGLE_KEY]: {
        type: 'score',
        instructions: `${request.rubric}\n待评分对象: ${request.subject}`,
      },
    },
    request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
  );
  return expectAnswer(result, SINGLE_KEY, 'score');
}

export async function askNumeric(client: DecisionClient, request: NumericRequest): Promise<NumericAnswer> {
  const result = await client.decide(
    request.context,
    {
      [SINGLE_KEY]: {
        type: 'numeric',
        instructions: request.question,
        range: { min: request.min, max: request.max },
      },
    },
    request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
  );
  return expectAnswer(result, SINGLE_KEY, 'numeric');
}

function expectAnswer<K extends Answer['type']>(
  result: DecisionBatchResult,
  key: string,
  type: K,
): Extract<Answer, { type: K }> {
  const answer = result.answers[key];
  if (answer === undefined) {
    throw new DecisionError(
      `响应缺少问题 ${key} 的答案，实际键: ${Object.keys(result.answers).join(',') || '(空)'}`,
      'BAD_RESPONSE',
    );
  }
  if (answer.type !== type) {
    throw new DecisionError(
      `问题 ${key} 期望类型 ${type}，实际 ${answer.type}`,
      'BAD_RESPONSE',
    );
  }
  return answer as Extract<Answer, { type: K }>;
}
