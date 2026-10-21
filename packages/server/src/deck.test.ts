/**
 * 演示文稿模态（`slides`）的端到端验收。
 *
 * 这一批盯的是**"它是不是真的另一种模态"**，而不是"接口返回 200"：
 *   - 产物是多页的（页数 = 决策层定下的页数），而不是把网页改个名
 *   - 每页用的是**自己的版式**，页面上能读出 `data-ms-layout`
 *   - 翻页是真空的：`data-ms-tab` / `role="tabpanel"` 锚点齐全，
 *     于是同一个交互验证流程不用改就能点它
 *   - 打印成一页一张（`@page` + `page-break-after`）
 *   - 未知版式被**拒绝**，而不是静默降级成一个空页
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLlmClient, StubDecisionClient } from '@mediasandbox/orchestrator';
import { startServer } from './testing/harness.js';

/**
 * 一个会"往下排三页"的决策桩。
 *
 * `StubDecisionClient` 默认对 `continue_structuring` 答否，于是任何结构化链路
 * 都只排一块——那对"网页上一块"是正常结果，对"一份文稿"就不是了。
 * 这里显式让它继续，并按预设顺序选版式（选过的会被重复性约束排除）。
 */
function deckDecision(target = ['cover', 'bullets', 'closing']): StubDecisionClient {
  let step = 0;
  return new StubDecisionClient()
    .onNoul('continue_structuring', true)
    .setFallback('choice', (question) => {
      if (question.type !== 'choice') {
        throw new Error('choice 兜底收到了非 choice 问题，测试桩写错了');
      }
      const ids = Object.keys(question.criteria);
      const wanted = target[step] ?? ids[0]!;
      const pick = ids.includes(wanted) ? wanted : ids[0]!;
      step += 1;
      const probabilities: Record<string, number> = {};
      for (const id of ids) {
        probabilities[id] = id === pick ? 0.8 : 0.2 / Math.max(1, ids.length - 1);
      }
      return { type: 'choice', value: pick, probabilities };
    });
}

const PLAN_JSON = JSON.stringify({
  title: '季度复盘',
  positioning: '给管理层看的季度复盘',
  audience: '管理层',
  tone: '克制',
  sections: [
    { purpose: '开场', detail: '', blockIds: ['cover'] },
    { purpose: '讲结论', detail: '', blockIds: ['bullets'] },
    { purpose: '收尾', detail: '', blockIds: ['closing'] },
  ],
  notes: [],
});

async function waitForStatus(origin: string, runId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as {
      status: string;
      envType: string;
      artifacts: { path: string; size: number }[];
      structure: { page: { blocks: { id: string; type: string }[] } } | null;
      blueprint: unknown;
    };
    if (['succeeded', 'failed', 'escalated', 'cancelled'].includes(detail.status)) return detail;
    if (Date.now() > deadline) throw new Error(`运行 ${runId} 超时（${detail.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('演示文稿模态', () => {
  it('跑出来的是一份多页文稿，每页有版式，且能翻页', async () => {
    const llm = new MockLlmClient({ defaultText: PLAN_JSON });
    const ctx = await startServer({ structured: true, llm, decision: deckDecision() });

    try {
      const submit = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '做一份季度复盘演示文稿', envType: 'slides' }),
      });
      assert.equal(submit.status, 202);
      const { runId } = (await submit.json()) as { runId: string };

      const detail = await waitForStatus(ctx.origin, runId);
      assert.equal(detail.status, 'succeeded', `运行应当成功，实际 ${detail.status}`);
      assert.equal(detail.envType, 'slides');

      // ── 1. 结构：多页，每页一个版式 ──────────────────────────────────
      const pages = detail.structure?.page.blocks ?? [];
      assert.ok(pages.length >= 3, `一份文稿至少 3 页，实际 ${pages.length}`);

      // ── 2. 产物：HTML 与结构各一份 ───────────────────────────────────
      const paths = detail.artifacts.map((a) => a.path);
      assert.ok(paths.includes('artifacts/deck.html'), '应当产出 artifacts/deck.html');
      assert.ok(paths.includes('artifacts/deck.json'), '结构也要落盘，便于转格式与核对');

      // ── 3. 页面内容：页数对得上、锚点齐全、可打印 ────────────────────
      const html = await (await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/deck.html`)).text();
      const slideTags = html.match(/class="slide"/g) ?? [];
      assert.equal(slideTags.length, pages.length, 'HTML 里的页数要与结构一致');

      for (const [i, page] of pages.entries()) {
        const n = i + 1;
        assert.match(html, new RegExp(`data-ms-tab="deck:${n}"`), `第 ${n} 页要有翻页锚点`);
        assert.match(html, new RegExp(`data-ms-panel="deck:${n}"`), `第 ${n} 页要有面板锚点`);
        assert.ok(
          html.includes(`data-ms-layout="${page.type}"`),
          `第 ${n} 页应当用版式 ${page.type}`,
        );
      }
      assert.match(html, /role="tabpanel"/);
      assert.match(html, /aria-selected="true"/);
      // 视觉主题是**决策层选的**，必须能在产物本身里查到，而不是只活在日志里
      assert.match(html, /data-ms-theme="(midnight|editorial|mono|vivid)"/);
      assert.match(html, /--sk-accent:/, '主题变量要铺到页面上');
      // 调性与构图都要真的进产物：这两样是"不像模板"的载体，
      // 退化后肉眼只会觉得"又变单调了"，事后很难反查。
      assert.match(html, /data-tone="(accent|tinted|plain)"/);
      const tones = new Set([...html.matchAll(/data-tone="([a-z]+)"/g)].map((m) => m[1]));
      assert.ok(tones.size >= 2, `文稿里至少要有两种调性，实际只有 ${[...tones].join(',')}`);
      const sides = new Set([...html.matchAll(/data-side="([a-z]+)"/g)].map((m) => m[1]));
      assert.deepEqual([...sides].sort(), ['left', 'right'], '构图要左右交替');
      // 字号只允许来自六个统一档位：散落的 cqw 字号正是"字忽大忽小"的来源。
      assert.match(html, /--fs-(display|h1|h2|body|caption|metric):/);
      // 一页一张：打印规则必须在，否则导出的 PDF 会是一长条。
      assert.match(html, /@page\s*\{\s*size:\s*1280px 720px/);
      assert.match(html, /page-break-after:\s*always/);
      // 版面按容器宽度缩放（cqw），不是写死 px —— 否则大小屏比例会不一样。
      assert.match(html, /container-type:\s*inline-size/);
      assert.match(html, /cqw/);
      // 不自包含就会在断网沙盒里变成白屏。
      assert.doesNotMatch(html, /https?:\/\//, '文稿不应当引用任何外部资源');

      // ── 4. 统筹规划也在 ──────────────────────────────────────────────
      const blueprint = detail.blueprint as { ok: boolean; sections: unknown[] };
      assert.equal(blueprint.ok, true);
      assert.equal(blueprint.sections.length, 3);

      // ── 5. 决策留下的痕要出现在产物与依据里 ──────────────────────────
      // deck.json 不只是结构：主题（视觉方向）与页序都是决策层定的。
      const deckJson = (await (
        await fetch(`${ctx.origin}/api/runs/${runId}/artifacts/deck.json`)
      ).json()) as { themeId: string; themeLabel: string; layoutSequence: string[] };
      assert.equal(typeof deckJson.themeId, 'string');
      assert.ok(deckJson.themeLabel.length > 0);
      assert.deepEqual(
        deckJson.layoutSequence,
        pages.map((page) => page.type),
        '产物里记的页序要与结构一致',
      );

      const events = ctx.store.get(runId)?.events ?? [];
      const assembled = events.find((e) => e.type === 'plan_assembled');
      assert.ok(assembled !== undefined && assembled.type === 'plan_assembled');
      if (assembled !== undefined && assembled.type === 'plan_assembled') {
        assert.match(
          assembled.plan.rationale.join('\n'),
          /视觉主题：/,
          '主题是决策层选的，要留依据',
        );
      }
    } finally {
      await ctx.close();
    }
  });

  it('版式池单独一条端点，不与 block 池混在一起', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const layouts = (await (await fetch(`${ctx.origin}/api/slide-layouts`)).json()) as {
        layouts: { id: string; group: string; slots: unknown[] }[];
        groups: { id: string; count: number }[];
      };
      assert.ok(layouts.layouts.length >= 8, `内置版式应不少于 8 个，实际 ${layouts.layouts.length}`);
      assert.ok(layouts.layouts.every((l) => l.group === 'deck'));
      assert.deepEqual(
        layouts.groups.map((g) => g.id),
        ['deck'],
        '版式池里只该有 deck 这一组',
      );

      // 网页 block 池里不该出现幻灯片版式。
      const blocks = (await (await fetch(`${ctx.origin}/api/blocks`)).json()) as {
        blocks: { id: string }[];
      };
      const webIds = new Set(blocks.blocks.map((b) => b.id));
      for (const layout of layouts.layouts) {
        assert.ok(!webIds.has(layout.id), `版式 ${layout.id} 不该出现在网页 block 池里`);
      }

      const health = (await (await fetch(`${ctx.origin}/api/health`)).json()) as {
        pools: { webpageBlocks: number; slideLayouts: number };
      };
      assert.equal(health.pools.slideLayouts, layouts.layouts.length);
      assert.ok(health.pools.webpageBlocks > 0);
    } finally {
      await ctx.close();
    }
  });

  it('未知版式被拒绝，而不是静默产出一个空页', async () => {
    const ctx = await startServer({ structured: true });
    try {
      const response = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '随便做一份',
          envType: 'slides',
          candidateBlockIds: ['no-such-layout'],
        }),
      });
      // 候选集在入队前就被校验掉：不该让它跑起来再在执行期失败。
      assert.notEqual(response.status, 202);
      const body = (await response.json()) as { error?: string; detail?: string };
      assert.match(JSON.stringify(body), /no-such-layout/);
    } finally {
      await ctx.close();
    }
  });

  it('slides 与 webpage 两个池子不串：网页跑不出章节分隔页', async () => {
    const ctx = await startServer({ structured: true });
    try {
      // 章节分隔页只属于演示文稿版式池；拿它当网页的候选块必须被拒。
      const response = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做一个落地页',
          envType: 'webpage',
          candidateBlockIds: ['section'],
        }),
      });
      assert.notEqual(response.status, 202, '网页链路不该接受幻灯片版式');
    } finally {
      await ctx.close();
    }
  });
});
