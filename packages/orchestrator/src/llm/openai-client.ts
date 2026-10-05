/**
 * OpenAI 兼容的生成层客户端。
 *
 * "兼容"指请求/响应结构与 OpenAI 的 `/v1/chat/completions` 一致。绝大多数供应商
 * （OpenAI、DeepSeek、Moonshot、通义、本地 vLLM / llama.cpp / Ollama 的兼容端口）
 * 都遵这个协议，因此一个实现能接多家——只需换 baseUrl、apiKey、model。
 *
 * 而不是给每家写一个客户端：差异化部分（鉴权头、字段名怪癖）通过 providers 表描述。
 */
import {
  LlmError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmUsage,
} from './types.js';

export interface ProviderProfile {
  /** 供应商标识，用于日志与配置选择。 */
  readonly id: string;
  readonly baseUrl: string;
  /** 默认模型。请求里未指定时使用。 */
  readonly defaultModel: string;
  /** 鉴权头名称。默认 Authorization。 */
  readonly authHeader?: string | undefined;
  /** 鉴权值前缀。默认 'Bearer '。 */
  readonly authPrefix?: string | undefined;
  /** 额外请求头。 */
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
}

/** 预置的几个常见供应商。 */
export const PROVIDERS: Readonly<Record<string, ProviderProfile>> = {
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  deepseek: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  moonshot: {
    id: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  dashscope: {
    id: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  /** 本机 llama.cpp / Ollama 的 OpenAI 兼容端口。 */
  local: {
    id: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'local-model',
  },
};

export interface OpenAiCompatibleOptions {
  /** 用预置 profile。与 baseUrl 二选一。 */
  readonly provider?: keyof typeof PROVIDERS | string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
  /** 单次请求超时毫秒。默认 120_000。 */
  readonly timeoutMs?: number | undefined;
  /**
   * 失败重试次数（仅针对可重试的故障：限流、5xx、网络错误）。
   * 默认 2。注意这与编排层的兜底是两回事：这里只处理 HTTP 层面的抖动。
   */
  readonly maxRetries?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

interface ChatChoice {
  readonly message?: { readonly content?: unknown };
  readonly finish_reason?: unknown;
}

interface ChatResponse {
  readonly model?: unknown;
  readonly choices?: unknown;
  readonly usage?: unknown;
}

/** 从 HTTP 状态码判断是否值得重试。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** 这些原因下重试没有意义：请求本身有问题，或调用方未被授权。 */
const NON_RETRYABLE_REASONS: ReadonlySet<LlmError['reason']> = new Set([
  'BAD_RESPONSE',
  'UNAUTHORIZED',
  'BAD_REQUEST',
]);

/** 把状态码映射到错误原因。 */
function reasonForStatus(status: number): LlmError['reason'] {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  return 'BAD_STATUS';
}

function parseUsage(raw: unknown): LlmUsage {
  if (raw === null || typeof raw !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const record = raw as Record<string, unknown>;
  const num = (key: string): number => {
    const v = record[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    inputTokens: num('prompt_tokens'),
    outputTokens: num('completion_tokens'),
  };
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly kind: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultModel: string;
  private readonly authHeader: string;
  private readonly authPrefix: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    const profile =
      options.provider !== undefined ? PROVIDERS[options.provider as string] : undefined;

    const baseUrl = options.baseUrl ?? profile?.baseUrl;
    if (baseUrl === undefined) {
      throw new LlmError(
        `未指定 baseUrl，且 provider=${String(options.provider)} 不在预置表内`,
        'BAD_REQUEST',
      );
    }

    this.kind = profile?.id ?? 'openai-compatible';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? profile?.defaultModel ?? 'gpt-4o-mini';
    this.authHeader = profile?.authHeader ?? 'Authorization';
    this.authPrefix = profile?.authPrefix ?? 'Bearer ';
    this.headers = { ...(profile?.extraHeaders ?? {}), ...(options.extraHeaders ?? {}) };
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey !== undefined && this.apiKey !== '') {
      headers[this.authHeader] = `${this.authPrefix}${this.apiKey}`;
    }
    return headers;
  }

  private buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }
    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      // 每次尝试都用新的 AbortController：上一个已被 abort 的不能重用。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      // 调用方的取消信号要能传导进来。
      const onExternalAbort = (): void => controller.abort();
      request.signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(this.buildBody(request, false)),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          // 鉴权失败重试没有意义。
          if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
            lastError = new LlmError(
              `HTTP ${response.status}: ${text.slice(0, 300)}`,
              reasonForStatus(response.status),
            );
            await this.backoff(attempt);
            continue;
          }
          throw new LlmError(
            `生成请求失败 HTTP ${response.status}: ${text.slice(0, 300)}`,
            reasonForStatus(response.status),
          );
        }

        let raw: ChatResponse;
        try {
          raw = (await response.json()) as ChatResponse;
        } catch (error) {
          throw new LlmError('生成响应不是合法 JSON', 'BAD_RESPONSE', { cause: error });
        }

        const choices = Array.isArray(raw.choices) ? (raw.choices as ChatChoice[]) : [];
        const first = choices[0];
        if (first === undefined) {
          throw new LlmError('生成响应没有 choices', 'BAD_RESPONSE');
        }
        const content = first.message?.content;
        if (typeof content !== 'string') {
          throw new LlmError(
            `生成响应缺少文本内容（content 类型为 ${typeof content}）`,
            'BAD_RESPONSE',
          );
        }

        const finish = first.finish_reason;
        return {
          text: content,
          model: typeof raw.model === 'string' ? raw.model : this.defaultModel,
          usage: parseUsage(raw.usage),
          finishReason: finish === 'length' ? 'length' : 'stop',
          latencyMs: Date.now() - startedAt,
          raw,
        };
      } catch (error) {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onExternalAbort);

        // 明确不可重试的错误直接抛：重试一模一样的请求只会得到同样的结果。
        if (error instanceof LlmError && NON_RETRYABLE_REASONS.has(error.reason)) {
          throw error;
        }

        const aborted = controller.signal.aborted;
        const wrapped = aborted
          ? new LlmError(
              request.signal?.aborted === true
                ? '生成请求被调用方取消'
                : `生成请求超时（${this.timeoutMs}ms）`,
              request.signal?.aborted === true ? 'UNREACHABLE' : 'TIMEOUT',
              { cause: error },
            )
          : error instanceof LlmError
            ? error
            : new LlmError(`生成请求失败: ${String(error)}`, 'UNREACHABLE', { cause: error });

        lastError = wrapped;
        if (attempt < this.maxRetries && !NON_RETRYABLE_REASONS.has(wrapped.reason)) {
          await this.backoff(attempt);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onExternalAbort);
      }
    }

    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(`生成请求失败: ${String(lastError)}`, 'UNREACHABLE');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(request, true)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new LlmError(
          `流式生成失败 HTTP ${response.status}: ${text.slice(0, 300)}`,
          reasonForStatus(response.status),
        );
      }
      if (response.body === null) {
        throw new LlmError('流式响应没有 body', 'BAD_RESPONSE');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage: LlmUsage | undefined;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件。只处理完整事件，残缺的留到下一轮。
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              yield { delta: '', done: true, ...(usage !== undefined ? { usage } : {}) };
              return;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: { delta?: { content?: unknown } }[];
                usage?: unknown;
              };
              if (parsed.usage !== undefined) usage = parseUsage(parsed.usage);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta !== '') {
                yield { delta, done: false };
              }
            } catch {
              // 单个事件解析失败不中断整条流。
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      yield { delta: '', done: true, ...(usage !== undefined ? { usage } : {}) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(300 * 2 ** attempt, 3_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      return response.ok
        ? { ok: true, detail: `${this.baseUrl} 可达` }
        : { ok: false, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `不可达: ${String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
