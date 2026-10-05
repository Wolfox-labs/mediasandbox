/**
 * 生成层测试替身。
 *
 * 让编排层的测试不依赖任何外部服务。默认返回一段可预期的文本，
 * 也可以按提示词关键词定制响应，或注入失败来验兜底路径。
 */
import {
  LlmError,
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
}

export class MockLlmClient implements LlmClient {
  readonly kind = 'mock';
  private readonly defaultText: string;
  private readonly rules: MockRule[];
  private readonly model: string;
  /** 调用记录，便于断言"确实调了生成层"或"没调"。 */
  readonly calls: LlmRequest[] = [];
  private healthy = true;
  private latencyMs = 0;

  constructor(options: MockLlmOptions = {}) {
    this.defaultText = options.defaultText ?? '这是一段由测试替身生成的文本。';
    this.rules = [...(options.rules ?? [])];
    this.model = options.model ?? 'mock-model';
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
