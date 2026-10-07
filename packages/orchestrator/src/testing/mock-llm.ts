/**
 * 生成层测试替身。
 *
 * 让编排层的测试不依赖任何外部服务。默认返回一段可预期的文本，
 * 也可以按提示词关键词定制响应，或注入失败来验兜底路径。
 */
import {
  LlmError,
  type GeneratedImage,
  type ImageRequest,
  type ImageResponse,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
} from '../llm/types.js';

export interface MockRule {
  /** 提示词里包含该子串时命中。 */
  readonly match: string;
  /** 返回的文本。 */
  readonly text?: string | undefined;
  /** 设为 true 则命中时抛错。 */
  readonly fail?: string | undefined;
  /** 延迟毫秒，用于测试并发与超时。 */
  readonly delayMs?: number | undefined;
}

export interface MockLlmOptions {
  readonly defaultText?: string;
  readonly rules?: readonly MockRule[];
  readonly model?: string;
  /**
   * 是否实现 `generateImage`。
   *
   * 默认 **false** —— 这样默认替身模拟"没有图像端点"的供应商，
   * 走文本补全回落路径。要测图像端点就显式打开。
   */
  readonly withImage?: boolean | undefined;
  /** 图像端点返回的图。不传则给一张 1×1 的合法 PNG。 */
  readonly imageBytes?: Uint8Array | undefined;
  readonly imageMime?: string | undefined;
  /** 图像端点抛错时填这里，用于测失败路径。 */
  readonly imageFail?: string | undefined;
}

/** 1×1 透明 PNG。合法的最小图像，用于让产物判定为真图片。 */
const ONE_PIXEL_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

export class MockLlmClient implements LlmClient {
  readonly kind = 'mock';
  private readonly defaultText: string;
  private readonly rules: MockRule[];
  private readonly model: string;
  private readonly imageBytes: Uint8Array | undefined;
  private readonly imageMime: string;
  private readonly imageFail: string | undefined;
  /** 调用记录，便于断言"确实调了生成层"或"没调"。 */
  readonly calls: LlmRequest[] = [];
  /** 图像生成调用记录。 */
  readonly imageCalls: ImageRequest[] = [];
  private healthy = true;
  private latencyMs = 0;

  constructor(options: MockLlmOptions = {}) {
    this.defaultText = options.defaultText ?? '这是一段由测试替身生成的文本。';
    this.rules = [...(options.rules ?? [])];
    this.model = options.model ?? 'mock-model';
    this.imageBytes = options.imageBytes;
    this.imageMime = options.imageMime ?? 'image/png';
    this.imageFail = options.imageFail;
    // 只在显式要求时才挂上 generateImage：这样默认替身等价于
    // "供应商没有图像端点"，与真实情况里纯文本模型的行为一致。
    if (options.withImage === true) {
      this.generateImage = this.generateImageImpl.bind(this);
    }
  }

  /** 真正的实现。挂在实例上与否由构造参数决定。 */
  declare generateImage?: (request: ImageRequest) => Promise<ImageResponse>;

  private async generateImageImpl(request: ImageRequest): Promise<ImageResponse> {
    this.imageCalls.push(request);
    const startedAt = Date.now();
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.imageFail !== undefined) {
      throw new LlmError(this.imageFail, 'BAD_STATUS');
    }
    const image: GeneratedImage = {
      bytes: this.imageBytes ?? ONE_PIXEL_PNG,
      mimeType: this.imageMime,
      source: 'b64',
    };
    return {
      images: [image],
      model: 'mock-image-model',
      latencyMs: Date.now() - startedAt,
      raw: { mock: true },
    };
  }

  setHealthy(ok: boolean): this {
    this.healthy = ok;
    return this;
  }

  setLatency(ms: number): this {
    this.latencyMs = ms;
    return this;
  }

  addRule(rule: MockRule): this {
    this.rules.push(rule);
    return this;
  }

  /** 拼出这次请求的完整提示词，用于关键词匹配。 */
  private flatten(request: LlmRequest): string {
    return request.messages.map((m) => m.content).join('\n');
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const startedAt = Date.now();
    const prompt = this.flatten(request);

    const rule = this.rules.find((r) => prompt.includes(r.match));
    const delay = (rule?.delayMs ?? 0) + this.latencyMs;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (rule?.fail !== undefined) {
      throw new LlmError(rule.fail, 'BAD_STATUS');
    }

    const text = rule?.text ?? this.defaultText;
    return {
      text,
      model: this.model,
      usage: { inputTokens: prompt.length, outputTokens: text.length },
      finishReason: 'stop',
      latencyMs: Date.now() - startedAt,
      raw: { mock: true },
    };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const response = await this.complete(request);
    // 按字符切块，模拟流式增量。
    const chars = [...response.text];
    for (let i = 0; i < chars.length; i += 8) {
      yield { delta: chars.slice(i, i + 8).join(''), done: false };
    }
    yield { delta: '', done: true, usage: response.usage };
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    return this.healthy
      ? { ok: true, detail: 'mock 生成层' }
      : { ok: false, detail: 'mock 被显式置为不可用' };
  }
}
