/**
 * 生成层客户端契约。
 *
 * 这一层负责**真正的生成**（文本 / 图像 / 代码），与决策层严格分开：
 *   决策层：封闭问题 → 一个值 + 概率，0 生成 token
 *   生成层：开放生成 → 文本 / 二进制产物
 *
 * 存在的理由：决策层选"用什么工具、什么技术栈"，生成层才去"写出来"。
 * 二者混在一起会让调度不可复现，所以接口层面就切开。
 */

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  /** 覆盖默认模型。多供应商场景下用于切换。 */
  readonly model?: string | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** 要求 JSON 输出。传 'json' 或具体 schema，由实现决定如何映射到供应商参数。 */
  readonly responseFormat?: 'text' | 'json' | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly finishReason: 'stop' | 'length' | 'error';
  readonly latencyMs: number;
  /** 原样保留供应商响应，便于排查与存证。 */
  readonly raw: unknown;
}

export interface LlmStreamChunk {
  /** 增量文本。 */
  readonly delta: string;
  /** 最后一个 chunk 为 true，此时 done 才带完整 usage。 */
  readonly done: boolean;
  readonly usage?: LlmUsage | undefined;
}

/**
 * 生成层客户端。实现可以是 OpenAI 兼容端点、多供应商路由、或测试用桩。
 */
export interface LlmClient {
  readonly kind: string;

  /** 一次完整生成。 */
  complete(request: LlmRequest): Promise<LlmResponse>;

  /** 流式生成。实现可选，不支持时编排层回落到 complete。 */
  stream?(request: LlmRequest): AsyncIterable<LlmStreamChunk>;

  /** 探活。 */
  health(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/** 生成层错误。 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  constructor(
    message: string,
    readonly reason: LlmErrorReason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type LlmErrorReason =
  /** 供应商不可达。 */
  | 'UNREACHABLE'
  /** HTTP 非 2xx。 */
  | 'BAD_STATUS'
  /** 响应结构不符预期。 */
  | 'BAD_RESPONSE'
  /** 请求本身不合法。 */
  | 'BAD_REQUEST'
  /** 鉴权失败。 */
  | 'UNAUTHORIZED'
  /** 超出等待时间。 */
  | 'TIMEOUT'
  /** 命中速率限制。 */
  | 'RATE_LIMITED';
