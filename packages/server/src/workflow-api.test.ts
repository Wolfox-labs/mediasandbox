/**
 * 工作流 API 的 HTTP 层验收。
 *
 * 钉三件事：
 *   1. 内置预设（海报）能列出来、能跑、产物能下载；
 *   2. 用户自建工作流能存、能跑，**校验不通过就不许存**；
 *   3. 删除后列表里不再出现。
 *
 * 用占位截图驱动：这里验的是"接口与工作流引擎接上了没有"，
 * 真浏览器渲染由 orchestrator 侧与手工样例覆盖。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { MockLlmClient } from '@mediasandbox/orchestrator';
import { WorkflowStore } from './workflows.js';
import { startServer } from './testing/harness.js';

const dataDir = path.join(os.tmpdir(), `mediasandbox-workflow-api-${process.pid}`);

async function waitDone(origin: string, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const body = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as Record<string, unknown>;
    const status = String(body['status']);
    if (status !== 'queued' && status !== 'running') {
      if (status !== 'succeeded') {
        throw new Error(`运行停在 ${status}：${String(body['error'] ?? body['reason'] ?? '')}`);
      }
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('运行没有在 30s 内结束');
}

describe('工作流 API', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  async function boot(): Promise<{ origin: string; workflows: WorkflowStore }> {
    const workflows = new WorkflowStore(path.join(dataDir, 'workflows'));
    const ctx = await startServer({
      poster: true,
      workflows,
      nodeCacheDir: path.join(dataDir, 'node-cache'),
      llm: new MockLlmClient({
        rules: [
          {
            match: '海报目标',
            text: JSON.stringify({
              headline: '校园二手市集',
              subheadline: '周六上午九点，东区操场',
              points: ['闲置书本与电器', '当面验货', '现场回收'],
              cta: '来摆摊',
              footer: '学生会',
            }),
          },
        ],
      }),
    });
    started.push(ctx);
    return { origin: ctx.origin, workflows };
  }

  it('列出内置预设：海报', async () => {
    const { origin } = await boot();
    const body = (await (await fetch(`${origin}/api/workflows`)).json()) as {
      workflows: { id: string; builtin: boolean }[];
    };
    const poster = body.workflows.find((item) => item.id === 'poster');
    assert.ok(poster !== undefined, '应当列出海报预设');
    assert.equal(poster.builtin, true);
  });

  it('运行海报预设：产出四个尺寸的 HTML 与 PNG', async () => {
    const { origin } = await boot();
    const response = await fetch(`${origin}/api/workflows/poster/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '校园二手市集' }),
    });
    assert.equal(response.status, 202);
    const { runId } = (await response.json()) as { runId: string };
    const detail = await waitDone(origin, runId);
    const paths = (detail['artifacts'] as { path: string }[]).map((artifact) => artifact.path);
    for (const id of ['story', 'square', 'banner', 'a4']) {
      assert.ok(paths.includes(`artifacts/poster-${id}.png`), `缺 ${id} 的 PNG，实际：${paths.join(' ')}`);
    }

    const png = await fetch(`${origin}/api/runs/${runId}/artifacts/poster-story.png`);
    assert.equal(png.status, 200);
    assert.ok((await png.arrayBuffer()).byteLength > 0);
  });

  it('自建工作流：先校验再存，坏图存不进去', async () => {
    const { origin } = await boot();

    const broken = await fetch(`${origin}/api/workflows/my-flow`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '坏流程',
        envType: 'image',
        // 缺 brief 这个必填输入。
        nodes: [{ id: 'render', toolId: 'poster-render', inputs: {} }],
      }),
    });
    assert.equal(broken.status, 400);

    const ok = await fetch(`${origin}/api/workflows/my-flow`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '单尺寸海报',
        envType: 'image',
        nodes: [
          {
            id: 'render',
            toolId: 'poster-render',
            inputs: { brief: { value: '{"headline":"测试海报"}' }, sizeId: { value: 'square' } },
          },
          {
            id: 'export',
            toolId: 'poster-export',
            inputs: { file: { from: 'render', port: 'file' }, sizeId: { value: 'square' } },
          },
        ],
      }),
    });
    assert.equal(ok.status, 201, await ok.text());

    const list = (await (await fetch(`${origin}/api/workflows`)).json()) as {
      workflows: { id: string }[];
    };
    assert.ok(list.workflows.some((item) => item.id === 'my-flow'));

    const run = await fetch(`${origin}/api/workflows/my-flow/run`, { method: 'POST' });
    assert.equal(run.status, 202);
    const { runId } = (await run.json()) as { runId: string };
    const detail = await waitDone(origin, runId);
    const paths = (detail['artifacts'] as { path: string }[]).map((artifact) => artifact.path);
    assert.ok(paths.includes('artifacts/poster-square.png'), paths.join(' '));

    const del = await fetch(`${origin}/api/workflows/my-flow`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    const after = (await (await fetch(`${origin}/api/workflows`)).json()) as {
      workflows: { id: string }[];
    };
    assert.ok(!after.workflows.some((item) => item.id === 'my-flow'));
  });

  it('内置预设不能覆盖、不能删', async () => {
    const { origin } = await boot();
    const put = await fetch(`${origin}/api/workflows/poster`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envType: 'image', nodes: [] }),
    });
    assert.equal(put.status, 409);
    const del = await fetch(`${origin}/api/workflows/poster`, { method: 'DELETE' });
    assert.equal(del.status, 409);
  });

  it('缺 goal 不让跑海报；未知工作流 404', async () => {
    const { origin } = await boot();
    const missing = await fetch(`${origin}/api/workflows/poster/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const unknown = await fetch(`${origin}/api/workflows/nope/run`, { method: 'POST' });
    assert.equal(unknown.status, 404);
  });
});
