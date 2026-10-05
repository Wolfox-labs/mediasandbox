import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from './types.js';
import { OpenAiCompatibleClient, PROVIDERS } from './openai-client.js';

/** 造一个可编程的假 fetch。 */
function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const actualInit = init ?? {};
    calls.push({ url, init: actualInit });
    return await handler(url, actualInit);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 生成一个 SSE 响应流。 */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAiCompatibleClient', () => {
  it('解析正常的 chat completion 响应', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({
        model: 'test-model',
        choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-x',
      fetchImpl,
    });

    const response = await client.complete({
      messages: [{ role: 'user', content: '打招呼' }],
    });

    assert.equal(response.text, '你好');
    assert.equal(response.model, 'test-model');
    assert.equal(response.finishReason, 'stop');
    assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 2 });
    assert.equal(calls[0]?.url, 'https://example.test/v1/chat/completions');
  });

  it('带上鉴权头与自定义头', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      extraHeaders: { 'x-custom': 'yes' },
      fetchImpl,
    });

    await client.complete({ messages: [{ role: 'user', content: 'x' }] });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer secret');
    assert.equal(headers['x-custom'], 'yes');
  });

  it('无 apiKey 时不发鉴权头', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({ baseUrl: 'http://127.0.0.1:8080/v1', fetchImpl });
    await client.complete({ messages: [{ role: 'user', content: 'x' }] });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], undefined);
  });

  it('把请求参数正确映射到 wire 格式', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://example.test/v1',
      defaultModel: 'default-m',
      fetchImpl,
    });

    await client.complete({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      temperature: 0.3,
      maxTokens: 100,
      responseFormat: 'json',
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'default-m');
    assert.equal(body['temperature'], 0.3);
    assert.equal(body['max_tokens'], 100);
    assert.deepEqual(body['response_format'], { type: 'json_object' });
    assert.equal(body['stream'], false);
    assert.equal((body['messages'] as unknown[]).length, 2);
  });

  it('请求里的 model 覆盖默认值', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://example.test/v1',
      defaultModel: 'a',
      fetchImpl,
    });
    await client.complete({ messages: [{ role: 'user', content: 'x' }], model: 'b' });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'b');
  });

  it('缺少 choices 时报 BAD_RESPONSE', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ model: 'm' }));
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 0 });
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.reason, 'BAD_RESPONSE');
        return true;
      },
    );
  });

  it('content 不是字符串时报 BAD_RESPONSE，不静默返回空串', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: null } }] }),
    );
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 0 });
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof LlmError && error.reason === 'BAD_RESPONSE',
    );
  });

  it('401 归类为 UNAUTHORIZED 且不重试', async () => {
    let count = 0;
    const { fetchImpl } = fakeFetch(() => {
      count += 1;
      return new Response('unauthorized', { status: 401 });
    });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 3 });

    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof LlmError && error.reason === 'UNAUTHORIZED',
    );
    assert.equal(count, 1, '鉴权失败不该重试');
  });

  it('429 归类为 RATE_LIMITED 且会重试', async () => {
    let count = 0;
    const { fetchImpl } = fakeFetch(() => {
      count += 1;
      if (count < 3) return new Response('slow down', { status: 429 });
      return jsonResponse({ choices: [{ message: { content: '终于成功' } }] });
    });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 3 });

    const response = await client.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(response.text, '终于成功');
    assert.equal(count, 3, '限流应重试');
  });

  it('5xx 会重试，重试耗尽后抛出', async () => {
    let count = 0;
    const { fetchImpl } = fakeFetch(() => {
      count += 1;
      return new Response('boom', { status: 500 });
    });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 2 });

    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof LlmError && error.reason === 'BAD_STATUS',
    );
    assert.equal(count, 3, '应为 1 次初始 + 2 次重试');
  });

  it('网络异常归类为 UNREACHABLE', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl, maxRetries: 0 });
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => error instanceof LlmError && error.reason === 'UNREACHABLE',
    );
  });

  it('超时归类为 TIMEOUT', async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // 模拟真实 fetch 在 abort 时 reject。
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = new OpenAiCompatibleClient({
      baseUrl: 'https://e.test/v1',
      fetchImpl,
      timeoutMs: 150,
      maxRetries: 0,
    });

    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'x' }] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.reason, 'TIMEOUT');
        return true;
      },
    );
  });

  it('流式：逐块产出增量，最后带 usage 结束', async () => {
    const { fetchImpl } = fakeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl });

    const chunks: string[] = [];
    let finalUsage: unknown;
    let sawDone = false;
    for await (const chunk of client.stream({ messages: [{ role: 'user', content: 'x' }] })) {
      if (chunk.done) {
        sawDone = true;
        finalUsage = chunk.usage;
      } else {
        chunks.push(chunk.delta);
      }
    }

    assert.deepEqual(chunks, ['你', '好']);
    assert.equal(sawDone, true);
    assert.deepEqual(finalUsage, { inputTokens: 5, outputTokens: 2 });
  });

  it('流式：请求体带 stream:true', async () => {
    const { fetchImpl, calls } = fakeFetch(() => sseResponse(['data: [DONE]\n\n']));
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl });
    for await (const _ of client.stream({ messages: [{ role: 'user', content: 'x' }] })) {
      // 消费完
    }
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['stream'], true);
  });

  it('流式：单个坏事件不中断整条流', async () => {
    const { fetchImpl } = fakeFetch(() =>
      sseResponse([
        'data: {坏 JSON\n\n',
        'data: {"choices":[{"delta":{"content":"仍然可用"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl });

    const chunks: string[] = [];
    for await (const chunk of client.stream({ messages: [{ role: 'user', content: 'x' }] })) {
      if (!chunk.done) chunks.push(chunk.delta);
    }
    assert.deepEqual(chunks, ['仍然可用']);
  });

  it('流式：HTTP 错误抛出', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('nope', { status: 503 }));
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl });
    await assert.rejects(async () => {
      for await (const _ of client.stream({ messages: [{ role: 'user', content: 'x' }] })) {
        // 应在这里抛
      }
    }, (error: unknown) => error instanceof LlmError);
  });

  it('用 provider 预置配置', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({ provider: 'deepseek', apiKey: 'k', fetchImpl });
    assert.equal(client.kind, 'deepseek');
    await client.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(calls[0]?.url, 'https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body['model'], 'deepseek-chat');
  });

  it('baseUrl 与 provider 都不给时构造即失败', () => {
    assert.throws(
      () => new OpenAiCompatibleClient({ provider: 'not-a-provider' }),
      (error: unknown) => error instanceof LlmError && error.reason === 'BAD_REQUEST',
    );
  });

  it('baseUrl 末尾斜杠被规范化，不产生双斜杠', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1///', fetchImpl });
    await client.complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(calls[0]?.url, 'https://e.test/v1/chat/completions');
  });

  it('health 在 /models 可达时为 ok', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ data: [] }));
    const client = new OpenAiCompatibleClient({ baseUrl: 'https://e.test/v1', fetchImpl });
    const health = await client.health();
    assert.equal(health.ok, true);
  });

  it('预置表里的 local 指向回环地址', () => {
    assert.match(PROVIDERS['local']!.baseUrl, /127\.0\.0\.1|localhost/);
  });
});
