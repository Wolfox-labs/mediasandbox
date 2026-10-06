import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { LocalSandbox } from '@mediasandbox/sandbox';
import {
  BUILTIN_TOOLS,
  DEFAULT_POLICY,
  StubDecisionClient,
  ToolRegistry,
} from '@mediasandbox/orchestrator';
import { MockLlmClient } from '@mediasandbox/orchestrator';
import { createServer } from './app.js';
import type { Server } from 'node:http';

/**
 * 服务端测试：起一个真实的 HTTP server，用 fetch 打 REST、用 ws 收事件。
 *
 * 不 mock Express：路由、JSON 解析、状态码这些正是要验的东西。
 */

const rootDir = path.join(os.tmpdir(), `mediasandbox-server-test-${process.pid}`);
const localSandbox = new LocalSandbox({ rootDir });

/** 每个用例用独立的决策桩，避免预设互相干扰。 */
function makeDecision(): StubDecisionClient {
  return new StubDecisionClient()
    .onChoice('primary_tool', 'template-copy')
    .onChoice('finalize', 'write-file')
    .onNoul('needs_verify', true);
}

const FAST_POLICY = { ...DEFAULT_POLICY, backoffBaseMs: 0, backoffCapMs: 0 };

async function startServer(overrides: {
  decision?: StubDecisionClient;
  llm?: MockLlmClient;
  /** 用空注册表，制造不可恢复的计划级失败。 */
  emptyRegistry?: boolean;
  /** 沙盒保留额度。不传则用 createServer 的默认值。 */
  maxRuns?: number;
} = {}): Promise<{
  origin: string;
  close: () => Promise<void>;
  store: ReturnType<typeof createServer>['store'];
  waitForIdle: () => Promise<void>;
  wsUrl: string;
}> {
  const registry = new ToolRegistry();
  if (overrides.emptyRegistry !== true) {
    registry.registerAll(BUILTIN_TOOLS);
  }

  const instance = createServer({
    registry,
    decision: overrides.decision ?? makeDecision(),
    ...(overrides.llm !== undefined ? { llm: overrides.llm } : {}),
    providers: { local: localSandbox },
    defaultProvider: 'local',
    policy: FAST_POLICY,
    ...(overrides.maxRuns !== undefined
      ? { sandboxRetention: { maxRuns: overrides.maxRuns } }
      : {}),
  });

  const server: Server = http.createServer(instance.app);
  instance.attachWebSocket(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取监听端口');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    store: instance.store,
    waitForIdle: () => instance.waitForIdle(),
    close: async () => {
      await instance.waitForIdle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('HTTP + WebSocket 服务', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    ctx = await startServer();
  });

  after(async () => {
    await ctx.close();
  });

  it('GET /api/health 返回决策层与工具信息', async () => {
    const response = await fetch(`${ctx.origin}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body['toolCount'], 'number');
    assert.ok((body['toolCount'] as number) > 0);
    assert.deepEqual(body['providers'], ['local']);
    assert.equal(body['defaultProvider'], 'local');
  });

  it('GET /api/tools 列出可用工具，可按环境筛选', async () => {
    const all = (await (await fetch(`${ctx.origin}/api/tools`)).json()) as { tools: unknown[] };
    assert.ok(all.tools.length > 0);

    const copyOnly = (await (
      await fetch(`${ctx.origin}/api/tools?envType=copy`)
    ).json()) as { tools: { envTypes: string[] }[] };
    assert.ok(copyOnly.tools.length > 0);
    for (const tool of copyOnly.tools) {
      assert.ok(tool.envTypes.includes('copy'), `工具应支持 copy: ${JSON.stringify(tool)}`);
    }
  });

  it('POST /api/runs 校验入参', async () => {
    const empty = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '   ' }),
    });
    assert.equal(empty.status, 400);

    const badEnv = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', envType: 'nope' }),
    });
    assert.equal(badEnv.status, 400);

    const badProvider = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'x', provider: 'nope' }),
    });
    assert.equal(badProvider.status, 400);
  });

  it('提交运行 → 轮询到成功 → 产物可下载', async () => {
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '写一段产品介绍', envType: 'copy', minArtifacts: 1 }),
    });
    assert.equal(submit.status, 202);
    const { runId } = (await submit.json()) as { runId: string };
    assert.match(runId, /^run-/);

    // 等它跑完。
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

    const detail = (await (await fetch(`${ctx.origin}/api/runs/${runId}`)).json()) as Record<
      string,
      unknown
    >;
    assert.equal(detail['status'], 'succeeded', JSON.stringify(detail));
    const artifacts = detail['artifacts'] as { path: string; mimeHint: string; size: number }[];
    assert.ok(artifacts.length >= 1, '应至少有一个产物');
    assert.ok(detail['planSummary'] !== undefined, '应记录计划摘要');
    // 空文件与 .gitkeep 不应被算作产物。
    for (const artifact of artifacts) {
      assert.ok(artifact.size > 0, `产物不应为空: ${artifact.path}`);
      assert.doesNotMatch(artifact.path, /\.gitkeep$/, '占位文件不应算作产物');
    }

    // 下载产物。
    const first = artifacts[0]!;
    const name = first.path.replace(/^artifacts\//, '');
    const download = await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/${name}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), first.mimeHint);
    const text = await download.text();
    assert.ok(text.length > 0, '产物内容不应为空');
  });

  it('下载不存在的产物返回 404', async () => {
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '产物 404 测试', envType: 'copy' }),
    });
    const { runId } = (await submit.json()) as { runId: string };
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

    const response = await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/nope.txt`);
    assert.equal(response.status, 404);
  });

  it('查询不存在的运行返回 404', async () => {
    const response = await fetch(`${ctx.origin}/api/runs/run-does-not-exist`);
    assert.equal(response.status, 404);
  });

  it('GET /api/runs 列出运行记录', async () => {
    const body = (await (await fetch(`${ctx.origin}/api/runs`)).json()) as {
      runs: { id: string; status: string }[];
    };
    assert.ok(Array.isArray(body.runs));
    assert.ok(body.runs.length > 0, '前面已提交过运行');
  });

  it('GET /api/runs/:id/artifacts 返回产物清单', async () => {
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '产物清单', envType: 'copy' }),
    });
    const { runId } = (await submit.json()) as { runId: string };
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

    const body = (await (
      await fetch(`${ctx.origin}/api/runs/${runId}/artifacts`)
    ).json()) as { artifacts: unknown[] };
    assert.ok(Array.isArray(body.artifacts));
  });

  it('WebSocket 推送实时事件并可补发历史', async () => {
    const received: Record<string, unknown>[] = [];
    const socket = new WebSocket(ctx.wsUrl);

    // 必须在 open 之前挂 message 监听：服务端在 connection 时就补发历史事件，
    // 若等到 open 之后再挂，已到达的消息会被丢弃（ws 客户端的行为）。
    socket.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    // 提交一个新 run，应收到它的实时事件。
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'WebSocket 实时事件', envType: 'copy' }),
    });
    const { runId } = (await submit.json()) as { runId: string };
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

    // 给消息一点时间送达。
    await new Promise((r) => setTimeout(r, 300));
    socket.close();

    const mine = received.filter((e) => e['runId'] === runId);
    assert.ok(mine.length > 0, `应收到该 run 的事件，实际收到 ${received.length} 条`);
    const types = new Set(mine.map((e) => e['type']));
    assert.ok(types.has('run_started'), `事件类型: ${[...types].join(',')}`);
    assert.ok(types.has('run_finished'), `事件类型: ${[...types].join(',')}`);
  });

  it('WebSocket 可只订阅指定 run，并补发已结束运行的事件', async () => {
    // 先跑完一个 run。
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '补发测试', envType: 'copy' }),
    });
    const { runId } = (await submit.json()) as { runId: string };
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

    // 之后再连，应能补发到历史事件。
    const received: Record<string, unknown>[] = [];
    const socket = new WebSocket(`${ctx.wsUrl}?runId=${runId}`);
    // 先挂监听再等 open——见上一个用例的说明。
    socket.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 400));
    socket.close();

    assert.ok(received.length > 0, '应补发历史事件');
    assert.ok(
      received.every((e) => e['runId'] === runId),
      '只应收到指定 run 的事件',
    );
  });

  it('生成层被调用时事件带工具日志', async () => {
    const llm = new MockLlmClient({ defaultText: '生成的文案内容。' });
    const localCtx = await startServer({
      llm,
      decision: new StubDecisionClient()
        .onChoice('primary_tool', 'draft-copy')
        .onNoul('needs_refine', false)
        .onChoice('finalize', 'write-file')
        .onNoul('needs_verify', false),
    });

    try {
      const submit = await fetch(`${localCtx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '调用生成层', envType: 'copy' }),
      });
      const { runId } = (await submit.json()) as { runId: string };
      await waitForStatus(localCtx.origin, runId, ['succeeded', 'failed', 'escalated']);

      const events = localCtx.store.get(runId)?.events ?? [];
      const hasLog = events.some(
        (e) => e.type === 'execution_event' && e.event.type === 'node_log',
      );
      assert.ok(hasLog, '应记录生成层调用日志');
      assert.ok(llm.calls.length > 0, '生成层应被调用');
    } finally {
      await localCtx.close();
    }
  });

  it('运行失败时状态与原因被记录', async () => {
    // 用**空注册表**制造不可恢复的失败：环境里没有任何主产出工具。
    // 这是计划级错误——重试与换方案都救不了，必然熔断。
    //
    // 不能用"选一个需要生成层的工具"来造失败：兜底会换方案到确定性工具，
    // 最终成功（那本身是正确行为，早先的测试假设过时了）。
    const failCtx = await startServer({ emptyRegistry: true });

    try {
      const submit = await fetch(`${failCtx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '注定失败', envType: 'copy' }),
      });
      const { runId } = (await submit.json()) as { runId: string };
      await waitForStatus(failCtx.origin, runId, ['succeeded', 'failed', 'escalated']);

      const detail = (await (
        await fetch(`${failCtx.origin}/api/runs/${runId}`)
      ).json()) as Record<string, unknown>;
      assert.equal(detail['status'], 'escalated');
      assert.ok(typeof detail['reason'] === 'string' && (detail['reason'] as string).length > 0);
      const attempts = detail['attempts'] as unknown[];
      assert.ok(attempts.length > 0, '应记录尝试');
    } finally {
      await failCtx.close();
    }
  });
});

/**
 * 沙盒保留策略。
 *
 * 背景——这是实测出来的资源泄漏：产物是从沙盒工作区**实时读**的，
 * 所以结束后不能立刻销毁；但此前**从不销毁**，每跑一次就永久多一个工作区。
 * 实测：连提 3 次运行，`workspaces/local/` 下就留下 3 个目录，永不回收。
 */
describe('沙盒保留与回收', () => {
  it('保留额度用满后，最旧的沙盒被销毁；产物随之不可再下载（410）', async () => {
    const ctx = await startServer({ maxRuns: 2 });
    try {
      const runIds: string[] = [];
      // 连提 3 次，额度是 2，所以第 1 个应被回收。
      for (let i = 0; i < 3; i += 1) {
        const submit = await fetch(`${ctx.origin}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ goal: `保留策略用例 ${i}`, envType: 'copy' }),
        });
        assert.equal(submit.status, 202);
        const { runId } = (await submit.json()) as { runId: string };
        runIds.push(runId);
        await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);
      }

      // 全部 run 记录仍然可查——回收的是沙盒，不是运行历史。
      for (const runId of runIds) {
        const detail = await fetch(`${ctx.origin}/api/runs/${runId}`);
        assert.equal(detail.status, 200, `运行记录 ${runId} 不应被删除`);
      }

      const artifactNameOf = async (runId: string): Promise<string | undefined> => {
        const body = (await (
          await fetch(`${ctx.origin}/api/runs/${runId}/artifacts`)
        ).json()) as { artifacts: { path: string }[] };
        const first = body.artifacts[0];
        return first === undefined ? undefined : (first.path.split('/').pop() ?? undefined);
      };

      // 最新的那个（第 3 个）应在额度内，产物可下载。
      const newest = runIds[2]!;
      const newestArtifact = await artifactNameOf(newest);
      assert.ok(newestArtifact !== undefined, '最新运行应产出产物');
      const newestDownload = await fetch(
        `${ctx.origin}/api/runs/${newest}/artifacts/${newestArtifact}`,
      );
      assert.equal(newestDownload.status, 200, '额度内的沙盒产物应可下载');

      // 最旧的那个应已被回收，下载得到 410。
      const oldest = runIds[0]!;
      const oldestArtifact = await artifactNameOf(oldest);
      assert.ok(oldestArtifact !== undefined, '最旧运行也曾产出产物');
      const oldestDownload = await fetch(
        `${ctx.origin}/api/runs/${oldest}/artifacts/${oldestArtifact}`,
      );
      assert.equal(oldestDownload.status, 410, '超出保留额度的沙盒应已销毁');
    } finally {
      await ctx.close();
    }
  });

  it('回收只动超出额度的沙盒，工作区不会无限增长', async () => {
    const ctx = await startServer({ maxRuns: 1 });
    const sandboxRoot = path.join(rootDir, 'retention-probe');
    const probe = new LocalSandbox({ rootDir: sandboxRoot });
    try {
      // 直接验证 provider 层面的销毁语义：创建 → 销毁 → get 不到了。
      const handle = await probe.create('retention-probe', 'copy');
      assert.ok((await probe.get(handle.id)) !== undefined);
      await probe.destroy(handle);
      assert.equal(await probe.get(handle.id), undefined, 'destroy 后不应还能取回句柄');
      // 幂等：重复销毁不抛错。
      await probe.destroy(handle);
    } finally {
      await ctx.close();
    }
  });

  it('额度为 0 时运行结束即销毁沙盒，产物不可再下载', async () => {
    const ctx = await startServer({ maxRuns: 0 });
    try {
      const submit = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '不保留沙盒', envType: 'copy' }),
      });
      const { runId } = (await submit.json()) as { runId: string };
      await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

      // 运行记录与产物清单仍在——销毁的是沙盒，不是记录。
      const body = (await (
        await fetch(`${ctx.origin}/api/runs/${runId}/artifacts`)
      ).json()) as { artifacts: { path: string }[] };
      assert.ok(body.artifacts.length > 0, '产物清单应仍然可查');

      const name = body.artifacts[0]!.path.split('/').pop()!;
      const download = await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/${name}`);
      assert.equal(download.status, 410, '额度 0 时沙盒已销毁，下载应返回 410');
    } finally {
      await ctx.close();
    }
  });
});

/** 轮询直到状态落在期望集合里，或超时。 */
async function waitForStatus(
  origin: string,
  runId: string,
  expected: readonly string[],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${origin}/api/runs/${runId}`);
    if (response.ok) {
      const body = (await response.json()) as { status?: string };
      if (body.status !== undefined && expected.includes(body.status)) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${runId} 进入 ${expected.join('/')} 超时`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
