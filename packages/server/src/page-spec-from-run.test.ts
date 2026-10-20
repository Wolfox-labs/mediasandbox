/**
 * W6：`pageSpec: { fromRunId }` —— 按"那一次运行的结构"再跑一遍。
 *
 * 这条能力的价值是**结构留在服务端**：新开的客户端、或者跨会话想重跑某次跑通的
 * 结构时，不必先把整页结构拉下来再整份传回去。
 *
 * 测试盯四件事：
 *   1. 结构确实被复用（两次运行的块类型序列一致）
 *   2. 身份确实是新的（新 runId、新 projectId 由服务端重新投影）
 *   3. 找不到的运行回 404，而不是收下再跑成 failed
 *   4. `fromRunId` 与完整结构**混着传要拒**（歧义不猜）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './testing/harness.js';

interface RunDetail {
  status: string;
  structure: { page: { blocks: { id: string; type: string }[] } } | null;
}

async function submit(origin: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForStatus(origin: string, runId: string): Promise<RunDetail> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as RunDetail;
    if (['succeeded', 'failed', 'escalated', 'cancelled'].includes(detail.status)) return detail;
    if (Date.now() > deadline) throw new Error(`运行 ${runId} 超时（${detail.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('pageSpec.fromRunId', () => {
  it('复用那次运行的结构，但身份是新的', async () => {
    const ctx = await startServer({ structured: true });
    try {
      // 第一次：显式点名起手块，得到一份可预期的结构
      const first = await submit(ctx.origin, {
        goal: '做一个产品介绍页',
        envType: 'webpage',
        seedBlocks: ['hero', 'cta'],
        useBlueprint: false,
      });
      assert.equal(first.status, 202);
      const firstId = ((await first.json()) as { runId: string }).runId;
      const firstDetail = await waitForStatus(ctx.origin, firstId);
      assert.equal(firstDetail.status, 'succeeded', '第一次运行应当成功');
      const firstTypes = firstDetail.structure?.page.blocks.map((b) => b.type) ?? [];
      assert.deepEqual(firstTypes, ['hero', 'cta'], '种子块应按序先铺');
      const firstProject = ctx.store.get(firstId)?.projectId;
      assert.ok(firstProject !== undefined);

      // 第二次：只给 fromRunId
      const second = await submit(ctx.origin, {
        goal: '换个目标，沿用同一套结构',
        envType: 'webpage',
        pageSpec: { fromRunId: firstId },
      });
      assert.equal(second.status, 202, `复用结构应当被接受；实际体：${await second.clone().text()}`);
      const secondId = ((await second.json()) as { runId: string }).runId;
      const secondDetail = await waitForStatus(ctx.origin, secondId);
      assert.equal(secondDetail.status, 'succeeded');

      const secondTypes = secondDetail.structure?.page.blocks.map((b) => b.type) ?? [];
      assert.deepEqual(secondTypes, firstTypes, '块类型序列应当与来源运行一致');

      // 身份必须是新的：新 runId、新 projectId（由服务端重新投影，不继承来源的）
      assert.notEqual(secondId, firstId);
      const secondProject = ctx.store.get(secondId)?.projectId;
      assert.notEqual(secondProject, firstProject, 'projectId 不能沿用来源运行');
      assert.equal(ctx.store.get(secondId)?.goal, '换个目标，沿用同一套结构');
    } finally {
      await ctx.close();
    }
  });

  it('来源运行不存在时回 404，且不留下运行记录', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const countBefore = ctx.store.list().length;
      const response = await submit(ctx.origin, {
        goal: '引用一个不存在的运行',
        envType: 'webpage',
        pageSpec: { fromRunId: 'run-not-exist-000000' },
      });
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error?: string };
      assert.match(JSON.stringify(body), /run-not-exist-000000/);
      // 关键：400/404 不该在服务端留下一条永远 queued 的记录
      assert.equal(ctx.store.list().length, countBefore, '被拒的提交不该创建运行记录');
    } finally {
      await ctx.close();
    }
  });

  it('fromRunId 与完整结构混着传要拒（歧义不猜）', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await submit(ctx.origin, {
        goal: '两个来源都给',
        envType: 'webpage',
        pageSpec: { fromRunId: 'run-whatever', blocks: [] },
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: string; detail?: string };
      assert.match(JSON.stringify(body), /blocks/);
    } finally {
      await ctx.close();
    }
  });

  it('空字符串或非字符串的 fromRunId 回 400', async () => {
    const ctx = await startServer({ structured: true });
    try {
      for (const bad of ['', 42, null]) {
        const response = await submit(ctx.origin, {
          goal: 'fromRunId 不合法',
          envType: 'webpage',
          pageSpec: { fromRunId: bad },
        });
        assert.equal(response.status, 400, `fromRunId=${JSON.stringify(bad)} 应当 400`);
      }
    } finally {
      await ctx.close();
    }
  });
});
