import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { LocalSandbox } from '@mediasandbox/sandbox';
import {
  BUILTIN_TOOLS,
  createBlockRegistry,
  createStructuredTools,
  createTemplateRegistry,
  DEFAULT_POLICY,
  StubDecisionClient,
  ToolRegistry,
  type BlockRegistry,
  type TemplateRegistry,
} from '@mediasandbox/orchestrator';
import { MockLlmClient } from '@mediasandbox/orchestrator';
import { createServer } from './app.js';
import { JsonPersist } from './persist.js';
import { loadPersistedPools, type LoadedPools } from './boot.js';
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
  /** 装配结构化链路：block 池 + 模板池 + 两个结构化工具。 */
  structured?: boolean;
  /** 落盘目录。给了就启用持久化，并从这里读回历史运行记录。 */
  dataDir?: string;
  /** 预先装好的池子（模拟重启时的装载结果）。省略则用内置池。 */
  pools?: LoadedPools;
  /** 交付物落定目录。给了之后产物不随沙盒回收消失。 */
  projectsDir?: string;
} = {}): Promise<{
  origin: string;
  close: () => Promise<void>;
  store: ReturnType<typeof createServer>['store'];
  blocks: BlockRegistry;
  templates: TemplateRegistry;
  waitForIdle: () => Promise<void>;
  flushPersist: () => Promise<void>;
  wsUrl: string;
}> {
  const registry = new ToolRegistry();
  if (overrides.emptyRegistry !== true) {
    registry.registerAll(BUILTIN_TOOLS);
  }

  // block 池与工具必须成对出现：工具装在哪个池子上，规划器就得用哪个池子。
  const blocks =
    overrides.pools?.blocks ??
    (overrides.structured === true ? createBlockRegistry() : undefined);
  if (blocks !== undefined) {
    registry.registerAll(createStructuredTools(blocks));
  }
  const templates =
    blocks !== undefined
      ? createTemplateRegistry(blocks, [...(overrides.pools?.userTemplates ?? [])])
      : undefined;

  const persist =
    overrides.dataDir !== undefined ? new JsonPersist({ rootDir: overrides.dataDir }) : undefined;

  const instance = createServer({
    registry,
    ...(blocks !== undefined ? { blocks } : {}),
    ...(templates !== undefined ? { templates } : {}),
    ...(persist !== undefined ? { persist } : {}),
    ...(overrides.projectsDir !== undefined ? { projectsDir: overrides.projectsDir } : {}),
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

  // 与 main.ts 一样：**listen 之前**把历史运行记录装回来。
  await instance.loadPersisted();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取监听端口');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    store: instance.store,
    blocks: blocks ?? createBlockRegistry(),
    templates: templates ?? createTemplateRegistry(createBlockRegistry()),
    waitForIdle: () => instance.waitForIdle(),
    flushPersist: () => instance.flushPersist(),
    close: async () => {
      await instance.waitForIdle();
      await instance.flushPersist();
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
describe('沙盒保留与回收（未配 projectsDir 的旧行为）', () => {
  it('保留额度用满后，最旧的沙盒被销毁；没有落定副本时产物不可再下载（410）', async () => {
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

  it('额度为 0 时运行结束即销毁沙盒；没有落定副本时产物不可再下载', async () => {
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

describe('交付物落定：产物不随沙盒回收消失', () => {
  let projectsRoot = '';

  before(async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    projectsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-projects-'));
  });

  after(async () => {
    const fsp = await import('node:fs/promises');
    if (projectsRoot !== '') await fsp.rm(projectsRoot, { recursive: true, force: true });
  });

  async function runOnce(ctx: Awaited<ReturnType<typeof startServer>>, goal: string): Promise<string> {
    const submit = await fetch(`${ctx.origin}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal, envType: 'copy', projectId: 'proj-settle' }),
    });
    assert.equal(submit.status, 202);
    const { runId } = (await submit.json()) as { runId: string };
    await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);
    return runId;
  }

  it('沙盒额度 0（运行一结束就销毁）时，产物**仍然下得下来**', async () => {
    const ctx = await startServer({
      maxRuns: 0,
      projectsDir: path.join(projectsRoot, 'zero'),
    });
    try {
      const runId = await runOnce(ctx, '落定用例：额度 0');
      const body = (await (
        await fetch(`${ctx.origin}/api/runs/${runId}/artifacts`)
      ).json()) as { artifacts: { path: string; settled: boolean }[] };
      assert.ok(body.artifacts.length > 0);
      assert.equal(body.artifacts[0]?.settled, true, '应当已落定一份');

      const name = body.artifacts[0]!.path.split('/').pop()!;
      const download = await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/${name}`);
      // 这条是本次改动的核心：沙盒已经销毁了，但交付物还在。
      assert.equal(download.status, 200, '沙盒销毁不该让交付物消失');
      const text = await download.text();
      assert.ok(text.length > 0, '落定副本要有内容');
    } finally {
      await ctx.close();
    }
  });

  it('超出保留额度被淘汰之后，产物照样可下载', async () => {
    const ctx = await startServer({
      maxRuns: 1,
      projectsDir: path.join(projectsRoot, 'evict'),
    });
    try {
      const first = await runOnce(ctx, '落定用例：第一个');
      const second = await runOnce(ctx, '落定用例：第二个');

      for (const runId of [first, second]) {
        const body = (await (
          await fetch(`${ctx.origin}/api/runs/${runId}/artifacts`)
        ).json()) as { artifacts: { path: string }[] };
        const name = body.artifacts[0]!.path.split('/').pop()!;
        const download = await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/${name}`);
        // 第一个的沙盒已被回收，但它落定过——所以仍然是 200。
        assert.equal(download.status, 200, `${runId} 的产物应当仍可下载`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('导出 ZIP 也走落定副本：被淘汰的项目仍能导出', async () => {
    const ctx = await startServer({
      maxRuns: 0,
      projectsDir: path.join(projectsRoot, 'zip'),
    });
    try {
      await runOnce(ctx, '落定用例：导出');
      const response = await fetch(`${ctx.origin}/api/projects/proj-settle/export`);
      assert.equal(response.status, 200, '沙盒都销毁了，导出仍应成功');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.byteLength > 0);
      // ZIP 魔数，确认拿到的是个压缩包而不是错误页。
      assert.equal(String.fromCharCode(bytes[0]!, bytes[1]!), 'PK');
    } finally {
      await ctx.close();
    }
  });

  it('落定副本按项目与运行分目录，不会互相覆盖', async () => {
    const dir = path.join(projectsRoot, 'layout');
    const ctx = await startServer({ maxRuns: 5, projectsDir: dir });
    try {
      const runId = await runOnce(ctx, '落定用例：目录结构');
      const fsp = await import('node:fs/promises');
      const entries = await fsp.readdir(path.join(dir, 'proj-settle', 'runs'));
      assert.ok(entries.includes(runId), `落定目录里应有 ${runId}，实际 ${entries.join(', ')}`);
    } finally {
      await ctx.close();
    }
  });
});

/** 轮询直到状态落在期望集合里，或超时。 */async function waitForStatus(
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

describe('目标分类（envType=auto）', () => {
  it('不传 envType 时默认 auto，运行记录里写的是**判出来的那个**', async () => {
    const ctx = await startServer({ decision: makeDecision().onChoice('env_type', 'copy') });
    try {
      const created = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // **刻意不传 envType**：从前这里会默认成 copy，
        // 一个图像需求会被静默当成文案任务处理。
        body: JSON.stringify({ goal: '写一段产品介绍' }),
      });
      assert.equal(created.status, 202);
      const { runId } = (await created.json()) as { runId: string };
      await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

      const detail = (await (await fetch(`${ctx.origin}/api/runs/${runId}`)).json()) as {
        status: string;
        envType: string;
      };
      assert.equal(detail.status, 'succeeded');
      // 记的必须是实际用的环境。停在 "auto" 的话，事后没法回答"这次走的哪条链路"。
      assert.equal(detail.envType, 'copy');
    } finally {
      await ctx.close();
    }
  });

  it('显式传 auto 也认，效果与不传一致', async () => {
    const ctx = await startServer({ decision: makeDecision().onChoice('env_type', 'copy') });
    try {
      const created = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '写一段产品介绍', envType: 'auto' }),
      });
      assert.equal(created.status, 202);
    } finally {
      await ctx.close();
    }
  });

  it('非法 envType 返回 400，并列出可用项（含 auto）', async () => {
    const ctx = await startServer();
    try {
      const response = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'g', envType: 'video' }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: string };
      assert.match(body.error ?? '', /auto/);
    } finally {
      await ctx.close();
    }
  });

  it('GET /api/tools?envType=auto 返回全部工具，而不是被 auto 过滤成空', async () => {
    const ctx = await startServer();
    try {
      const all = (await (await fetch(`${ctx.origin}/api/tools`)).json()) as { tools: unknown[] };
      const auto = (await (await fetch(`${ctx.origin}/api/tools?envType=auto`)).json()) as {
        tools: unknown[];
      };
      assert.equal(auto.tools.length, all.tools.length);
      assert.ok(auto.tools.length > 0);
    } finally {
      await ctx.close();
    }
  });
});

describe('模板目录与 templateId 参数', () => {
  it('GET /api/templates 列出内置模板，含起手结构与限定范围', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const body = (await (await fetch(`${ctx.origin}/api/templates`)).json()) as {
        templates: {
          id: string;
          label: string;
          builtin: boolean;
          blocks: { type: string }[];
          allowedBlockIds: string[] | null;
        }[];
      };
      assert.ok(body.templates.length >= 3, '内置模板应当有几种');
      const launch = body.templates.find((t) => t.id === 'product-launch');
      assert.ok(launch !== undefined, '缺少 product-launch');
      assert.equal(launch.builtin, true);
      assert.ok(launch.blocks.length > 0, '起手结构不能是空的');
      assert.ok(Array.isArray(launch.allowedBlockIds), '限定范围要带出来');
    } finally {
      await ctx.close();
    }
  });

  it('未装配模板池时返回 503，而不是空列表', async () => {
    const ctx = await startServer();
    try {
      const response = await fetch(`${ctx.origin}/api/templates`);
      assert.equal(response.status, 503);
    } finally {
      await ctx.close();
    }
  });

  it('POST /api/runs 带未知 templateId 时 400，并列出可用的', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '做落地页', envType: 'webpage', templateId: 'no-such' }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { detail?: string };
      assert.match(body.detail ?? '', /product-launch/);
    } finally {
      await ctx.close();
    }
  });

  it('带合法 templateId 的 webpage 运行能跑通，结构记下 templateId', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const created = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做一个产品介绍落地页',
          envType: 'webpage',
          projectId: 'proj-tpl',
          templateId: 'product-launch',
          maxBlocks: 4,
        }),
      });
      assert.equal(created.status, 202);
      const { runId } = (await created.json()) as { runId: string };
      await waitForStatus(ctx.origin, runId, ['succeeded', 'failed', 'escalated']);

      const detail = (await (await fetch(`${ctx.origin}/api/runs/${runId}`)).json()) as {
        status: string;
        structure?: { page: { templateId: string | null; blocks: { type: string }[] } };
      };
      assert.equal(detail.status, 'succeeded', JSON.stringify(detail).slice(0, 400));
      // 模板的起手结构必须真的出现在页面上，否则"选了模板"只是个摆设。
      assert.deepEqual(
        detail.structure?.page.blocks.slice(0, 2).map((b) => b.type),
        ['hero', 'features'],
      );
      assert.equal(detail.structure?.page.templateId, 'product-launch');
    } finally {
      await ctx.close();
    }
  });

  it('GET /api/blocks 带出 placement，前端能提示"这个块固定在末尾"', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const body = (await (await fetch(`${ctx.origin}/api/blocks`)).json()) as {
        blocks: { id: string; placement: string }[];
      };
      const footer = body.blocks.find((b) => b.id === 'footer');
      const nav = body.blocks.find((b) => b.id === 'nav');
      const hero = body.blocks.find((b) => b.id === 'hero');
      assert.equal(footer?.placement, 'last');
      assert.equal(nav?.placement, 'first');
      assert.equal(hero?.placement, 'any');
    } finally {
      await ctx.close();
    }
  });
});

describe('block 池与模板池的增删', () => {
  const PROMO = {
    id: 'promo-banner',
    label: '促销横幅',
    description: '一条限时促销提示',
    group: 'skeleton',
    slots: [{ name: 'text', type: 'title', description: '促销语' }],
    canLead: false,
    repeatable: false,
    costHint: 'fast',
  };

  it('POST /api/blocks 把自定义 block 注册进池子，并说明它会怎么渲染', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PROMO),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as { note?: string };
      assert.match(body.note ?? '', /通用渲染/, '渲染方式要主动说，而不是让用户自己撞上');
      assert.ok(ctx.blocks.has('promo-banner'));

      const list = (await (await fetch(`${ctx.origin}/api/blocks`)).json()) as {
        blocks: { id: string }[];
      };
      assert.ok(list.blocks.some((b) => b.id === 'promo-banner'));
    } finally {
      await ctx.close();
    }
  });

  it('POST /api/blocks 拒绝形态不对的声明，并说清是哪个字段', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...PROMO, group: 'nope' }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: string };
      assert.match(body.error ?? '', /group/);
    } finally {
      await ctx.close();
    }
  });

  it('POST /api/blocks 拒绝与内置重名的 id', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...PROMO, id: 'hero' }),
      });
      assert.equal(response.status, 400);
    } finally {
      await ctx.close();
    }
  });

  it('内置模板不能删（删了下次启动还在，徒增困惑）', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/templates/product-launch`, {
        method: 'DELETE',
      });
      assert.equal(response.status, 409);
    } finally {
      await ctx.close();
    }
  });
});

describe('持久化：重启之后东西还在', () => {
  let dataRoot = '';

  before(async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ms-restart-'));
  });

  after(async () => {
    const fsp = await import('node:fs/promises');
    if (dataRoot !== '') await fsp.rm(dataRoot, { recursive: true, force: true });
  });

  /** 模拟一次完整的重启：关服务 → 按 boot.ts 装池子 → 起新服务。 */
  async function restart(dataDir: string): Promise<Awaited<ReturnType<typeof startServer>>> {
    const persist = new JsonPersist({ rootDir: dataDir });
    const pools = await loadPersistedPools(persist);
    return await startServer({ structured: true, dataDir, pools });
  }

  it('运行记录、产物清单与结构留痕，重启后全部还在', async () => {
    const dir = `${dataRoot}/runs`;
    const first = await startServer({ structured: true, dataDir: dir });
    let runId = '';
    try {
      const created = await fetch(`${first.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做一个产品介绍落地页',
          envType: 'webpage',
          projectId: 'proj-persist',
          candidateBlockIds: ['hero', 'features'],
          maxBlocks: 2,
        }),
      });
      assert.equal(created.status, 202);
      ({ runId } = (await created.json()) as { runId: string });
      await waitForStatus(first.origin, runId, ['succeeded', 'failed', 'escalated']);
    } finally {
      await first.close();
    }

    const second = await restart(dir);
    try {
      // 重启前那次运行必须还在，而且状态是**终态**——不能永远显示"运行中"。
      const detail = (await (await fetch(`${second.origin}/api/runs/${runId}`)).json()) as {
        status: string;
        goal: string;
        artifacts: unknown[];
        structure: { page: { blocks: { type: string }[] } } | null;
      };
      assert.equal(detail.status, 'succeeded');
      assert.equal(detail.goal, '做一个产品介绍落地页');
      assert.ok(detail.artifacts.length > 0, '产物清单也该在');
      // 结构是**产出**：刷新页面/重启服务之后仍然拿得到，
      // 只靠 WebSocket 推一次的话，错过那一刻就永远没了。
      assert.ok(detail.structure !== null, '结构留痕丢了');
      // 桩决策层对"还要再来一块"默认答否，所以结构就是起手的第一块。
      // 这里断言的是"结构原样回来了"，不绑定具体块数。
      assert.ok(detail.structure.page.blocks.length >= 1);
      assert.equal(detail.structure.page.blocks[0]?.type, 'hero');

      const list = (await (await fetch(`${second.origin}/api/runs`)).json()) as {
        runs: { id: string }[];
      };
      assert.ok(list.runs.some((r) => r.id === runId), '运行列表里也该有它');
    } finally {
      await second.close();
    }
  });

  it('自定义 block 与沉淀出来的模板，重启后还在', async () => {
    const dir = `${dataRoot}/pools`;
    const first = await startServer({ structured: true, dataDir: dir });
    let runId = '';
    try {
      const blockResponse = await fetch(`${first.origin}/api/blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'promo-banner',
          label: '促销横幅',
          description: '一条限时促销提示',
          group: 'skeleton',
          slots: [{ name: 'text', type: 'title', description: '促销语' }],
          canLead: false,
          repeatable: false,
          costHint: 'fast',
        }),
      });
      assert.equal(blockResponse.status, 201);

      // 跑一次 webpage，好有一个结构可以沉淀。
      const created = await fetch(`${first.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做一个产品介绍落地页',
          envType: 'webpage',
          candidateBlockIds: ['hero', 'promo-banner'],
          maxBlocks: 2,
        }),
      });
      ({ runId } = (await created.json()) as { runId: string });
      await waitForStatus(first.origin, runId, ['succeeded', 'failed', 'escalated']);

      const tpl = await fetch(`${first.origin}/api/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromRunId: runId, id: 'my-recycled', label: '我的沉淀' }),
      });
      assert.equal(tpl.status, 201, await tpl.text());
    } finally {
      await first.close();
    }

    const second = await restart(dir);
    try {
      // block 装回来了，而且**工具装的是同一个池子**——否则会重现
      // "选得到、填不了"的断链。
      assert.ok(second.blocks.has('promo-banner'), '自定义 block 没装回来');
      assert.ok(second.templates.has('my-recycled'), '沉淀的模板没装回来');
      const list = (await (await fetch(`${second.origin}/api/templates`)).json()) as {
        templates: { id: string; builtin: boolean; blocks: { type: string }[] }[];
      };
      const recycled = list.templates.find((t) => t.id === 'my-recycled');
      assert.ok(recycled !== undefined);
      assert.equal(recycled.builtin, false, '沉淀出来的不该被当成内置');
      assert.ok(recycled.blocks.length > 0, '起手结构要带回来');

      // 拿它起手跑一次，闭环。
      const created = await fetch(`${second.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做另一个产品的落地页',
          envType: 'webpage',
          templateId: 'my-recycled',
        }),
      });
      assert.equal(created.status, 202);
      const { runId: secondRun } = (await created.json()) as { runId: string };
      await waitForStatus(second.origin, secondRun, ['succeeded', 'failed', 'escalated']);
      const detail = (await (await fetch(`${second.origin}/api/runs/${secondRun}`)).json()) as {
        status: string;
        structure: { page: { templateId: string | null } } | null;
      };
      assert.equal(detail.status, 'succeeded');
      assert.equal(detail.structure?.page.templateId, 'my-recycled');
    } finally {
      await second.close();
    }
  });

  it('删掉沉淀的模板后会落盘，重启不再出现', async () => {
    const dir = `${dataRoot}/delete`;
    const first = await startServer({ structured: true, dataDir: dir });
    try {
      const created = await fetch(`${first.origin}/api/templates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'temp-tpl',
          label: '临时',
          description: '待删',
          blocks: [{ type: 'hero' }],
        }),
      });
      assert.equal(created.status, 201);
      const removed = await fetch(`${first.origin}/api/templates/temp-tpl`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.ok(!first.templates.has('temp-tpl'));
    } finally {
      await first.close();
    }

    const second = await restart(dir);
    try {
      assert.ok(!second.templates.has('temp-tpl'), '删掉的模板重启后不该复活');
    } finally {
      await second.close();
    }
  });

  it('不配 dataDir 时一切照旧（既有部署不该被迫提供存储）', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const list = (await (await fetch(`${ctx.origin}/api/runs`)).json()) as { runs: unknown[] };
      assert.deepEqual(list.runs, []);
    } finally {
      await ctx.close();
    }
  });
});
