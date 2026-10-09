/**
 * 自定义 block 的改 / 停用 / 物理删除（W8）。
 *
 * block 池本身早就做完了（内置 15 类 + `POST /api/blocks` 能注册自定义的），
 * 缺的是**后半程**：建错了不能改，想下线只能手改 `data/blocks.json` 再重启——
 * 那不是可交付的运维方式。
 *
 * 这组用例锁住四条：
 *   1. 改完立刻生效，**重启后仍在**；
 *   2. 内置 block 一律拒绝修改与删除（改了下次部署会被覆盖，是最难查的那类问题）；
 *   3. 停用 = 不再参与新页面的候选，但**历史结构照样能渲染**；
 *   4. 物理删除只允许"从未被任何运行用过"的。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startServer } from './testing/harness.js';

/** 一个合法的自定义 block 声明。 */
function customBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'promo-banner',
    label: '促销横幅',
    description: '页面顶部的促销条',
    group: 'content',
    canLead: false,
    repeatable: false,
    costHint: 'fast',
    slots: [
      { name: 'title', type: 'title', required: true, description: '横幅标题' },
      { name: 'body', type: 'text', required: false, description: '横幅正文' },
    ],
    ...overrides,
  };
}

describe('自定义 block 的改与删', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  async function boot(dataDir?: string) {
    const ctx = await startServer({
      structured: true,
      ...(dataDir !== undefined ? { dataDir } : {}),
    });
    started.push(ctx);
    return ctx;
  }

  async function post(origin: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('建一个自定义 block：入池、可见、落盘', async () => {
    const ctx = await boot();
    const created = await post(ctx.origin, '/api/blocks', customBlock());
    assert.equal(created.status, 201);

    const list = (await (await fetch(`${ctx.origin}/api/blocks`)).json()) as {
      blocks: { id: string; label: string }[];
    };
    const found = list.blocks.find((b) => b.id === 'promo-banner');
    assert.equal(found?.label, '促销横幅');
  });

  it('改一个自定义 block 的 label 与 slot 声明：立刻生效，重启后仍在', async () => {
    const dataDir = `${process.env['TMPDIR'] ?? '.'}\\ms-blocks-${process.pid}-1`;
    const logs: string[] = [];
    const first = await startServer({ structured: true, dataDir, onLog: (m) => logs.push(m) });
    started.push(first);
    await post(first.origin, '/api/blocks', customBlock());

    const updated = await fetch(`${first.origin}/api/blocks/promo-banner`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customBlock({ label: '改过的横幅' })),
    });
    assert.equal(updated.status, 200);

    // 立刻生效
    const list = (await (await fetch(`${first.origin}/api/blocks`)).json()) as {
      blocks: { id: string; label: string }[];
    };
    assert.equal(list.blocks.find((b) => b.id === 'promo-banner')?.label, '改过的横幅');

    // 落盘是**排队异步**的（故意不 await，免得请求被写盘拖慢），
    // 所以"重启"前要把它等干净——真实场景里这一步由正常关停完成。
    await first.flushPersist();

    // 重启后仍在：换一台服务读同一个 dataDir
    const secondLogs: string[] = [];
    const second = await startServer({
      structured: true,
      dataDir,
      onLog: (m) => secondLogs.push(m),
    });
    started.push(second);
    const after = (await (await fetch(`${second.origin}/api/blocks`)).json()) as {
      blocks: { id: string; label: string }[];
    };
    assert.equal(
      after.blocks.find((b) => b.id === 'promo-banner')?.label,
      '改过的横幅',
      `改动没有落盘；第一台日志=${JSON.stringify(logs)} 第二台日志=${JSON.stringify(secondLogs)}`,
    );
  });

  it('内置 block 一律拒绝修改与删除', async () => {
    const ctx = await boot();
    const put = await fetch(`${ctx.origin}/api/blocks/hero`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customBlock({ id: 'hero' })),
    });
    assert.equal(put.status, 400);
    assert.match(String(((await put.json()) as { error?: string }).error), /内置 block 不可修改/);

    const del = await fetch(`${ctx.origin}/api/blocks/hero`, { method: 'DELETE' });
    assert.equal(del.status, 400);
    assert.match(String(((await del.json()) as { error?: string }).error), /内置 block 不可删除/);
  });

  it('改 id 被拒绝：结构里存的是旧 id，换 id 会变成悬空引用', async () => {
    const ctx = await boot();
    await post(ctx.origin, '/api/blocks', customBlock());
    const renamed = await fetch(`${ctx.origin}/api/blocks/promo-banner`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customBlock({ id: 'promo-banner-v2' })),
    });
    assert.equal(renamed.status, 400);
    assert.match(String(((await renamed.json()) as { error?: string }).error), /不允许改 id/);
  });

  it('停用：默认不再出现在候选里，但 ?includeDisabled=1 能看到', async () => {
    const ctx = await boot();
    await post(ctx.origin, '/api/blocks', customBlock());

    const disabled = await fetch(`${ctx.origin}/api/blocks/promo-banner`, { method: 'DELETE' });
    assert.equal(disabled.status, 200);

    const visible = (await (await fetch(`${ctx.origin}/api/blocks`)).json()) as {
      blocks: { id: string }[];
    };
    assert.equal(
      visible.blocks.some((b) => b.id === 'promo-banner'),
      false,
      '停用的 block 不该出现在默认候选里',
    );

    const all = (await (
      await fetch(`${ctx.origin}/api/blocks?includeDisabled=1`)
    ).json()) as { blocks: { id: string; disabled?: boolean }[] };
    const row = all.blocks.find((b) => b.id === 'promo-banner');
    assert.equal(row?.disabled, true, '应当能以 includeDisabled=1 看到它并标明已停用');
  });

  it('停用过的 block 仍然认得出：历史结构照常渲染，不会变成悬空引用', async () => {
    const ctx = await boot();
    await post(ctx.origin, '/api/blocks', customBlock());
    // 造一条"用过它"的历史运行
    const record = ctx.store.create({
      id: 'run-used-promo',
      projectId: 'proj',
      goal: '测试目标',
      envType: 'webpage',
      provider: 'local',
    });
    ctx.store.update(record.id, {
      status: 'succeeded' as never,
      finishedAt: Date.now(),
      structure: {
        page: {
          projectId: 'proj',
          goal: '测试目标',
          templateId: null,
          candidateBlockIds: ['promo-banner'],
          blocks: [
            {
              id: 'b1',
              type: 'promo-banner',
              slots: { title: { kind: 'text', text: '限时' } },
              status: 'filled',
              sources: { title: 'deterministic' },
            },
          ],
          qualityScore: 0.8,
          createdAt: Date.now(),
        },
        steps: [],
      },
    });

    const disabled = await fetch(`${ctx.origin}/api/blocks/promo-banner`, { method: 'DELETE' });
    assert.equal(disabled.status, 200);
    const body = (await disabled.json()) as { usedByRuns?: number };
    assert.equal(body.usedByRuns, 1, '停用时要能说清影响面');

    // 池子里仍然认识它 —— 历史结构因此还能渲染。
    assert.equal(ctx.blocks.has('promo-banner'), true);
    assert.equal(ctx.blocks.get('promo-banner').disabled, true);
    // 但候选集里没有了。
    assert.equal(
      ctx.blocks.filter({}).some((s) => s.id === 'promo-banner'),
      false,
      '停用后不该再进候选集',
    );
  });

  it('物理删除：没被用过就能删；用过的拒绝并说明是哪次运行', async () => {
    const ctx = await boot();
    await post(ctx.origin, '/api/blocks', customBlock());

    // 没人用过 → 允许彻底删掉
    const purged = await fetch(`${ctx.origin}/api/blocks/promo-banner?purge=1`, {
      method: 'DELETE',
    });
    assert.equal(purged.status, 200);
    const list = (await (
      await fetch(`${ctx.origin}/api/blocks?includeDisabled=1`)
    ).json()) as { blocks: { id: string }[] };
    assert.equal(list.blocks.some((b) => b.id === 'promo-banner'), false);

    // 建一个新的，造一条用过的运行，再试图物理删除
    await post(ctx.origin, '/api/blocks', customBlock({ id: 'promo-banner2' }));
    const record = ctx.store.create({
      id: 'run-used-promo2',
      projectId: 'proj',
      goal: '测试目标',
      envType: 'webpage',
      provider: 'local',
    });
    ctx.store.update(record.id, {
      status: 'succeeded' as never,
      finishedAt: Date.now(),
      structure: {
        page: {
          projectId: 'proj',
          goal: '测试目标',
          templateId: null,
          candidateBlockIds: ['promo-banner2'],
          blocks: [
            { id: 'b1', type: 'promo-banner2', slots: {}, status: 'filled', sources: {} },
          ],
          qualityScore: 0.8,
          createdAt: Date.now(),
        },
        steps: [],
      },
    });
    const refused = await fetch(`${ctx.origin}/api/blocks/promo-banner2?purge=1`, {
      method: 'DELETE',
    });
    assert.equal(refused.status, 400);
    const detail = (await refused.json()) as { error?: string; detail?: string };
    assert.match(String(detail.error), /已被历史运行引用/);
    assert.match(String(detail.detail), /run-used-promo2/);
  });

  it('改一个不存在的 block 回 404，参数非法回 400', async () => {
    const ctx = await boot();
    const missing = await fetch(`${ctx.origin}/api/blocks/nope`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(customBlock({ id: 'nope' })),
    });
    assert.equal(missing.status, 404);

    await post(ctx.origin, '/api/blocks', customBlock());
    const bad = await fetch(`${ctx.origin}/api/blocks/promo-banner`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'promo-banner', label: '缺一堆字段' }),
    });
    assert.equal(bad.status, 400);
  });
});
