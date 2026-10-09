/**
 * 并发上限与排队：HTTP 层的验收。
 *
 * 队列本身的行为在 `run-queue.test.ts` 里已经锁住了，这里验的是**接线**：
 * 超限的运行真的排上了、跑完真的自动放行、队列满真的回 429、
 * 排队中的取消真的不会在名额空出后偷偷开跑。
 *
 * 要让"排队"这个状态可观测，就得让一次运行**停得住**：用一个把 `create()` 挡在
 * 闸门后面的 provider 包一层，测试自己决定什么时候放行。真实链路里
 * 这一步是"起沙盒"，本来就要花时间——卡在这里不改变被测的语义。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { LocalSandbox, type SandboxHandle, type SandboxProvider } from '@mediasandbox/sandbox';
import type { EnvType } from '@mediasandbox/sandbox';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './testing/harness.js';

/** 每次 `create()` 领一张票，测试按票放行。 */
function gatedProvider(inner: SandboxProvider): {
  provider: SandboxProvider;
  /** 当前被挡住的一次运行；没有则返回 undefined。 */
  pendingCount: () => number;
  /** 放行最早被挡住的那一次。 */
  releaseOne: () => void;
  /** 放行全部（含之后新来的，直到再次被挡）。 */
  releaseAll: () => void;
} {
  const gates: (() => void)[] = [];
  let open = false;

  const provider: SandboxProvider = {
    kind: 'local',
    async create(projectId: string, envType: EnvType): Promise<SandboxHandle> {
      if (!open) {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      return inner.create(projectId, envType);
    },
    get: (id) => inner.get(id),
    adopt: (id, hint) => inner.adopt(id, hint),
    exec: (handle, command, options) => inner.exec(handle, command, options),
    start: (handle, command, options) => inner.start(handle, command, options),
    writeFile: (handle, relPath, data) => inner.writeFile(handle, relPath, data),
    readFile: (handle, relPath) => inner.readFile(handle, relPath),
    exists: (handle, relPath) => inner.exists(handle, relPath),
    listFiles: (handle, pattern) => inner.listFiles(handle, pattern),
    collectArtifacts: (handle) => inner.collectArtifacts(handle),
    stats: (handle) => inner.stats(handle),
    destroy: (handle) => inner.destroy(handle),
  };

  return {
    provider,
    pendingCount: () => gates.length,
    releaseOne: () => gates.shift()?.(),
    releaseAll: () => {
      open = true;
      while (gates.length > 0) gates.shift()?.();
    },
  };
}

async function postRun(origin: string, goal: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal, envType: 'copy' }),
  });
  return { status: response.status, body: await response.json() };
}

/** 等到某个 runId 的状态变成期望值，最多等 timeoutMs。 */
async function waitForStatus(
  origin: string,
  runId: string,
  want: string[],
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '?';
  while (Date.now() < deadline) {
    const body = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as { status: string };
    last = body.status;
    if (want.includes(last)) return last;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等 ${runId} 变成 ${want.join('/')} 超时，实际停在 ${last}`);
}

describe('并发上限与队列', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  async function boot(options: Parameters<typeof startServer>[0] & { gate?: boolean } = {}) {
    const rootDir = path.join(os.tmpdir(), `mediasandbox-queue-test-${process.pid}-${started.length}`);
    const gate = gatedProvider(new LocalSandbox({ rootDir }));
    const ctx = await startServer({
      ...options,
      providers: { local: gate.provider },
    });
    started.push(ctx);
    return { ctx, gate };
  }

  it('超过并发上限的运行进入排队，并在放行后自动开始', async () => {
    const { ctx, gate } = await boot({ concurrency: { maxConcurrentRuns: 1, queueLimit: 4 } });

    const first = await postRun(ctx.origin, '第一个');
    const second = await postRun(ctx.origin, '第二个');
    const third = await postRun(ctx.origin, '第三个');
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 202);

    // 第二个、第三个应当报出排队位次；第一个立刻开跑，没有位次。
    assert.equal(second.body.queuePosition, 1, '第二个应当排在第 1 位');
    assert.equal(third.body.queuePosition, 2, '第三个应当排在第 2 位');
    assert.equal(first.body.queuePosition, undefined, '立刻开跑的不该报位次');

    // 列表与详情都能看到排队状态与位次。
    const list = (await (await fetch(`${ctx.origin}/api/runs`)).json()) as {
      queue: { running: number; waiting: number; maxConcurrent: number };
      runs: { id: string; status: string; queuePosition?: number }[];
    };
    assert.equal(list.queue.maxConcurrent, 1);
    assert.equal(list.queue.waiting, 2);
    const secondRow = list.runs.find((r) => r.id === second.body.runId);
    assert.equal(secondRow?.status, 'queued');
    assert.equal(secondRow?.queuePosition, 1);

    const detail = (await (
      await fetch(`${ctx.origin}/api/runs/${third.body.runId}`)
    ).json()) as { status: string; queuePosition?: number };
    assert.equal(detail.status, 'queued');
    assert.equal(detail.queuePosition, 2);

    // 放行一次：第一个开跑并结束，第二个自动补位（不需要重新提交）。
    gate.releaseAll();
    await waitForStatus(ctx.origin, first.body.runId, ['succeeded', 'failed', 'escalated']);
    await waitForStatus(ctx.origin, second.body.runId, ['succeeded', 'failed', 'escalated']);
    await waitForStatus(ctx.origin, third.body.runId, ['succeeded', 'failed', 'escalated']);
  });

  it('队列满时回 429，并说明上限；被拒的运行不在列表里', async () => {
    const { ctx, gate } = await boot({ concurrency: { maxConcurrentRuns: 1, queueLimit: 1 } });

    const first = await postRun(ctx.origin, '在跑的');
    const second = await postRun(ctx.origin, '排队的');
    const overflow = await postRun(ctx.origin, '被拒的');
    assert.equal(overflow.status, 429);
    assert.match(String(overflow.body.error), /队列已满/);
    assert.match(String(overflow.body.error), /同时最多 1 个/);

    const list = (await (await fetch(`${ctx.origin}/api/runs`)).json()) as {
      runs: { id: string }[];
    };
    assert.equal(
      list.runs.some((r) => r.id === overflow.body.runId),
      false,
      '被 429 拒掉的运行不该留下记录',
    );

    gate.releaseAll();
    await waitForStatus(ctx.origin, first.body.runId, ['succeeded', 'failed', 'escalated']);
    await waitForStatus(ctx.origin, second.body.runId, ['succeeded', 'failed', 'escalated']);
  });

  it('取消排队中的运行：它不会在名额空出后偷偷开跑', async () => {
    const { ctx, gate } = await boot({ concurrency: { maxConcurrentRuns: 1, queueLimit: 4 } });

    const first = await postRun(ctx.origin, '在跑的');
    const queued = await postRun(ctx.origin, '排队的');
    const cancel = await fetch(`${ctx.origin}/api/runs/${queued.body.runId}/cancel`, {
      method: 'POST',
    });
    assert.equal(cancel.status, 200);
    const cancelled = (await cancel.json()) as { cancelled: boolean; wasQueued?: boolean };
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.wasQueued, true, '应当说明它是从队列里摘掉的');

    const status = await waitForStatus(ctx.origin, queued.body.runId, ['cancelled']);
    assert.equal(status, 'cancelled');

    // 放行之后它必须**仍然**是 cancelled：只置状态不摘队列的话，这里会变成 running。
    gate.releaseAll();
    await waitForStatus(ctx.origin, first.body.runId, ['succeeded', 'failed', 'escalated']);
    await new Promise((r) => setTimeout(r, 200));
    const after = (await (
      await fetch(`${ctx.origin}/api/runs/${queued.body.runId}`)
    ).json()) as { status: string };
    assert.equal(after.status, 'cancelled', '被取消的排队运行不该自己复活');
  });
});
