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
 * 图像生成请求。
 *
 * 与 `LlmRequest` 分开而不是复用：图像生成走的是 `/images/generations`
 * 端点，参数语义完全不同（prompt / size / n），硬塞进 chat 请求会让
 * 实现层到处写条件分支。
 */
export interface ImageRequest {
  /** 图像描述。区别于 chat 的 messages —— 这里就是一段提示词。 */
  readonly prompt: string;
  /** 覆盖默认图像模型。 */
  readonly model?: string | undefined;
  /** 尺寸，如 `1024x1024`。 */
  readonly size?: string | undefined;
  /** 生成几张。默认 1。 */
  readonly n?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 生成出来的一张图。 */
export interface GeneratedImage {
  /** 图像字节。**已在客户端解码**，调用方不必关心供应商返回的是 b64 还是 URL。 */
  readonly bytes: Uint8Array;
  /** MIME 类型，如 `image/png`。用于决定落盘后缀。 */
  readonly mimeType: string;
  /**
   * 供应商原始返回形式。
   * 用于排查：gpt-image 系返回 b64_json，而部分网关返回 URL 需要再抓一次。
   */
  readonly source: 'b64' | 'url';
  /** 原始 URL（source 为 url 时）。 */
  readonly url?: string | undefined;
}

export interface ImageResponse {
  readonly images: readonly GeneratedImage[];
  readonly model: string;
  readonly latencyMs: number;
  readonly raw: unknown;
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

  /**
   * 图像生成。**可选能力**：不支持的实现不实现它，
   * 调用方（`render-image`）据此判断该走图像端点还是退回文本生成。
   */
  generateImage?(request: ImageRequest): Promise<ImageResponse>;

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
