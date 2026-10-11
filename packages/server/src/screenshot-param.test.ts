/**
 * `screenshot` 参数的 HTTP 层验收。
 *
 * 为什么单独测这一条：结构化链路里截图是**可选节点**——提交时带
 * `screenshot: true` 才会被加进计划。服务端一直支持这个参数，但 Web 工作台
 * 此前**没有**把它传出去，于是从界面提交的运行永远只有 `index.html`，
 * 用户在右栏怎么找都找不到 `artifacts/screenshot.png`。
 *
 * 也就是说：这不是"功能没做"，而是"入口没接"。这条用例钉住接口这一侧，
 * 界面那一侧的入口由 `BlockPoolPanel` 的勾选框提供。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { LocalSandbox } from '@mediasandbox/sandbox';
import { startServer } from './testing/harness.js';

interface RunBody {
  readonly runId: string;
  readonly status: string;
}

async function submit(
  origin: string,
  extra: Record<string, unknown>,
): Promise<RunBody> {
  const response = await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: '做一个产品介绍落地页，含首屏、特性与行动号召',
      envType: 'webpage',
      // 候选 block 必须给：webpage 链路没有候选就等于没有可组装的节点，
      // 计划为空会直接转人工（escalated），那样测的就不是 screenshot 参数了。
      candidateBlockIds: ['hero', 'features', 'cta'],
      maxBlocks: 3,
      ...extra,
    }),
  });
  assert.equal(response.status, 202, `提交应当被接受，实际 ${response.status}`);
  return (await response.json()) as RunBody;
}

async function waitDone(origin: string, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const body = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as Record<string, unknown>;
    const status = String(body['status']);
    if (status !== 'queued' && status !== 'running') {
      // 失败时把 reason/error 一起带出去：只报 "escalated != succeeded" 的话，
      // 排查要从别处再捞一次运行记录，白跑一趟。
      if (status !== 'succeeded') {
        const outcomes = (body['outcomes'] ?? []) as readonly { toolId: string; status: string; error?: string }[];
        throw new Error(
          `运行 ${runId} 停在 ${status}：reason=${String(body['reason'] ?? '')} ` +
            `error=${String(body['error'] ?? '')} ` +
            `outcomes=${outcomes.map((o) => `${o.toolId}:${o.status}${o.error ? `(${o.error})` : ''}`).join(' ')}`,
        );
      }
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`运行 ${runId} 没有在 20s 内结束`);
}

function toolIds(body: Record<string, unknown>): string[] {
  const plan = (body['planSummary'] ?? []) as readonly { toolId: string }[];
  return plan.map((node) => node.toolId);
}

describe('结构化提交的 screenshot 参数', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  async function boot(): Promise<string> {
    const rootDir = path.join(os.tmpdir(), `mediasandbox-screenshot-test-${process.pid}-${started.length}`);
    // `structured: true` 不能省：脚手架默认只装内置工具，而 webpage 链路需要
    // `fill-block` / `assemble-page` / `screenshot-page` 这些结构化工具。
    // 少了它，运行会以"计划错误（UNKNOWN_TOOL）"直接转人工，测不到本用例关注的东西。
    const ctx = await startServer({
      structured: true,
      providers: { local: new LocalSandbox({ rootDir }) },
    });
    started.push(ctx);
    return ctx.origin;
  }

  it('不带 screenshot 时计划里没有截图节点，产物只有页面', async () => {
    const origin = await boot();
    const created = await submit(origin, { screenshot: false });
    const body = await waitDone(origin, created.runId);

    assert.equal(body['status'], 'succeeded');
    assert.ok(
      !toolIds(body).includes('screenshot-page'),
      `不带 screenshot 时不该有截图节点，实际计划：${toolIds(body).join(' > ')}`,
    );
    const artifacts = (body['artifacts'] ?? []) as readonly { path: string }[];
    const paths = artifacts.map((a) => a.path);
    assert.ok(!paths.includes('artifacts/screenshot.png'), `不该有截图产物，实际：${paths.join(' ')}`);
  });

  it('带 screenshot 时截图节点进计划，并产出 artifacts/screenshot.png', async () => {
    const origin = await boot();
    const created = await submit(origin, { screenshot: true });
    const body = await waitDone(origin, created.runId);

    assert.equal(body['status'], 'succeeded');
    assert.ok(
      toolIds(body).includes('screenshot-page'),
      `带 screenshot 时计划里应当有截图节点，实际计划：${toolIds(body).join(' > ')}`,
    );
    const artifacts = (body['artifacts'] ?? []) as readonly { path: string; size: number }[];
    const shot = artifacts.find((a) => a.path === 'artifacts/screenshot.png');
    assert.ok(shot, `产物里应当有 artifacts/screenshot.png，实际：${artifacts.map((a) => a.path).join(' ')}`);
    // 测试环境没有真浏览器驱动，走的是占位驱动——但**必须仍是一个非空 PNG**，
    // 否则界面上会出现一个点不开的产物，而摘要里还写着"截图成功"。
    assert.ok((shot?.size ?? 0) > 0, '截图产物不该是 0 字节');
  });
});
