/**
 * rizzo-flow 决策层客户端。对接 `POST /v1/systemone`。
 *
 * 官方响应示例（值仅为示意）：
 *   { "model": "rizzo-spark-x2.5-4b-q8",
 *     "answers": { "is_urgent": { "type":"noul", "noul": 0.99 },
 *                  "team": { "type":"choice", "choice":"billing",
 *                            "probabilities": {"billing":0.99,"technical":0.01},
 *                            "confidence": 0.98 } },
 *     "usage": { "input_tokens": 212, "output_tokens": 0 } }
 *
 * 注意：服务端只接受**单个 state**。多问题共享同一个 state 一次提交，这是
 * 官方推荐的批量方式（21 问批量 1.0s vs 逐问 8.1s）。
 */
import {
  DecisionError,
  RIZZO_DEFAULT_BASE_URL,
  assertChoiceCriteria,
  argmaxDeterministic,
  serializeContext,
  validateProbabilities,
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

export interface RizzoFlowClientOptions {
  readonly baseUrl?: string;
  /** 请求的模型名。`rizzo-latest` 由服务端解析到本地权重。 */
  readonly model?: string;
  /** 单次请求超时毫秒。默认 60_000。 */
  readonly timeoutMs?: number;
  /** 注入的 fetch，便于测试。 */
  readonly fetchImpl?: typeof fetch;
}

interface RizzoRawResponse {
  readonly model?: unknown;
  readonly answers?: unknown;
  readonly usage?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 把请求侧问题编译成 wire 格式。 */
function compileQuestions(
  questions: Readonly<Record<string, Question>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    switch (question.type) {
      case 'noul':
        out[id] = { type: 'noul', instructions: question.instructions };
        break;
      case 'choice':
        assertChoiceCriteria(id, question.criteria);
        out[id] = {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        };
        break;
      case 'score':
        out[id] = { type: 'score', instructions: question.instructions };
        break;
      case 'numeric': {
        const payload: Record<string, unknown> = {
          type: 'numeric',
          instructions: question.instructions,
        };
        if (question.range !== undefined) {
          payload['range'] = [question.range.min, question.range.max];
        }
        out[id] = payload;
        break;
      }
    }
  }
  return out;
}

/** 解析单个答案。结构不符即抛 BAD_RESPONSE，不做静默兜底。 */
function parseAnswer(questionId: string, question: Question, raw: unknown): Answer {
  const record = asRecord(raw);
  if (record === undefined) {
    throw new DecisionError(`问题 ${questionId} 的答案不是对象`, 'BAD_RESPONSE');
  }

  // 弃权：值为 null + status。
  const status = asString(record['status']);
  const declaredType = asString(record['type']) ?? question.type;
  if (declaredType !== question.type) {
    throw new DecisionError(
      `问题 ${questionId} 期望类型 ${question.type}，服务端返回 ${declaredType}`,
      'BAD_RESPONSE',
    );
  }

  switch (question.type) {
    case 'noul': {
      const rawValue = record['noul'];
      if (rawValue === null) {
        const answer: NoulAnswer = {
          type: 'noul',
          value: null,
          yesProbability: null,
          ...(status !== undefined ? { abstention: { status } } : {}),
        };
        return answer;
      }
      const probability = asNumber(rawValue);
      if (probability === undefined) {
        throw new DecisionError(
          `问题 ${questionId} 的 noul 字段不是数字: ${JSON.stringify(rawValue)}`,
          'BAD_RESPONSE',
        );
      }
      if (probability < 0 || probability > 1) {
        throw new DecisionError(
          `问题 ${questionId} 的 noul 概率 ${probability} 不在 [0,1] 内`,
          'INVALID_PROBABILITIES',
        );
      }
      return { type: 'noul', value: probability >= 0.5, yesProbability: probability };
    }

    case 'choice': {
      const rawProbabilities = asRecord(record['probabilities']);
      const rawChoice = record['choice'];
      if (rawChoice === null) {
        const answer: ChoiceAnswer = {
          type: 'choice',
          value: null,
          probabilities: {},
          ...(status !== undefined ? { abstention: { status } } : {}),
        };
        return answer;
      }
      if (rawProbabilities === undefined) {
        throw new DecisionError(`问题 ${questionId} 缺少 probabilities 字段`, 'BAD_RESPONSE');
      }
      const probabilities: Record<string, number> = {};
      for (const [key, value] of Object.entries(rawProbabilities)) {
        const num = asNumber(value);
        if (num === undefined) {
          throw new DecisionError(
            `问题 ${questionId} 的候选 ${key} 概率不是数字`,
            'BAD_RESPONSE',
          );
        }
        probabilities[key] = num;
      }
      validateProbabilities(probabilities, (d) => `问题 ${questionId}: ${d}`);

      const candidateIds = Object.keys(question.criteria);
      // 服务端给出的 choice 必须落在候选集内；否则说明协议不一致，不能猜。
      const chosen = asString(rawChoice);
      const known = Object.keys(probabilities);
      if (chosen !== undefined && !candidateIds.includes(chosen)) {
        throw new DecisionError(
          `问题 ${questionId} 返回的 choice=${chosen} 不在候选集 [${candidateIds.join(',')}] 内`,
          'BAD_RESPONSE',
        );
      }
      // 候选集里没出现在概率里的项补 0，保证调用方看到的分布完整可判定。
      for (const id of candidateIds) {
        if (probabilities[id] === undefined) probabilities[id] = 0;
      }
      const value = chosen ?? argmaxDeterministic(candidateIds, probabilities);
      const answer: ChoiceAnswer = {
        type: 'choice',
        value,
        probabilities,
        ...(known.length > 0 ? {} : {}),
      };
      return answer;
    }

    case 'score': {
      const rawValue = record['score'];
      if (rawValue === null) {
        const answer: ScoreAnswer = {
          type: 'score',
          value: null,
          ...(status !== undefined ? { abstention: { status } } : {}),
        };
        return answer;
      }
      const value = asNumber(rawValue);
      if (value === undefined) {
        throw new DecisionError(
          `问题 ${questionId} 的 score 字段不是数字: ${JSON.stringify(rawValue)}`,
          'BAD_RESPONSE',
        );
      }
      if (value < 0 || value > 1) {
        throw new DecisionError(
          `问题 ${questionId} 的 score=${value} 不在 [0,1] 内`,
          'INVALID_PROBABILITIES',
        );
      }
      return { type: 'score', value };
    }

    case 'numeric': {
      const rawValue = record['numeric'];
      if (rawValue === null) {
        const answer: NumericAnswer = {
          type: 'numeric',
          value: null,
          ...(status !== undefined ? { abstention: { status } } : {}),
        };
        return answer;
      }
      const value = asNumber(rawValue);
      if (value === undefined) {
        throw new DecisionError(
          `问题 ${questionId} 的 numeric 字段不是数字: ${JSON.stringify(rawValue)}`,
          'BAD_RESPONSE',
        );
      }
      return { type: 'numeric', value };
    }
  }
}

export class RizzoFlowClient implements DecisionClient {
  readonly kind = 'systemone' as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RizzoFlowClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? RIZZO_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model ?? 'rizzo-latest';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async decide(
    context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<DecisionBatchResult> {
    const ids = Object.keys(questions);
    if (ids.length === 0) {
      throw new DecisionError('至少需要一个决策问题', 'BAD_REQUEST');
    }

    const body = {
      state: serializeContext(context),
      model: this.model,
      questions: compileQuestions(questions),
    };

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new DecisionError(
        aborted
          ? `决策请求超时（${timeoutMs}ms）`
          : `无法连接决策服务 ${this.baseUrl}: ${String(error)}`,
        aborted ? 'TIMEOUT' : 'UNREACHABLE',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DecisionError(
        `决策服务返回 HTTP ${response.status}: ${text.slice(0, 500)}`,
        'BAD_RESPONSE',
      );
    }

    let raw: RizzoRawResponse;
    try {
      raw = (await response.json()) as RizzoRawResponse;
    } catch (error) {
      throw new DecisionError('决策服务返回的不是合法 JSON', 'BAD_RESPONSE', { cause: error });
    }

    const rawAnswers = asRecord(raw.answers);
    if (rawAnswers === undefined) {
      throw new DecisionError('决策响应缺少 answers 字段', 'BAD_RESPONSE');
    }

    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(questions)) {
      const entry = rawAnswers[id];
      if (entry === undefined) {
        throw new DecisionError(`决策响应缺少问题 ${id} 的答案`, 'BAD_RESPONSE');
      }
      answers[id] = parseAnswer(id, question, entry);
    }

    const usage = asRecord(raw.usage);
    return {
      answers,
      meta: {
        latencyMs: Date.now() - startedAt,
        source: 'systemone',
        ...(asString(raw.model) !== undefined ? { model: asString(raw.model)! } : {}),
      },
      usage: {
        inputTokens: asNumber(usage?.['input_tokens']) ?? 0,
        outputTokens: asNumber(usage?.['output_tokens']) ?? 0,
      },
      raw,
    };
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (response.ok) {
        return { ok: true, detail: `${this.baseUrl} 可达` };
      }
      // 有些实现不暴露 /v1/models，回落到根路径探测。
      const root = await this.fetchImpl(`${this.baseUrl}/`, { method: 'GET' });
      return {
        ok: root.ok,
        detail: `/v1/models 返回 ${response.status}，根路径返回 ${root.status}`,
      };
    } catch (error) {
      return { ok: false, detail: `不可达: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
