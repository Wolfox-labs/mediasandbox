/**
 * 元素池预览：`/api/blocks/:id/preview`、`/api/slide-layouts/:id/preview`、
 * `/api/templates/:id/preview`。
 *
 * 这三条接口的价值全在"**预览与产物出自同一套渲染器**"，所以用例不验
 * "返回 200 就通过"，而是逐条盯住：
 *   1. 返回的是完整 HTML，里面能找到该元素的锚点与**专属版式** className；
 *   2. slot 真的被填上了示例内容，列表条数还落在 `countRange` 内；
 *   3. 未知 id 回 404、池子没装配回 503——**不静默给一份空页面**；
 *   4. **逐字节可复现**：同一请求两次、乃至两台独立服务实例，字节完全一致。
 *      这条同时锁住"预览没调生成层"的成本红线：真调了模型，它绝不会两次
 *      吐出同一个字节。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { startServer } from './testing/harness.js';

/** 三条接口共同的响应约定。大小写与空格都放宽，但必须是 html + utf-8。 */
const HTML_CONTENT_TYPE = /^text\/html; ?charset=utf-8$/i;

/** 一个合法的自定义 block：预览要能按 slot 声明走通用渲染。 */
const CUSTOM_BLOCK = {
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
    { name: 'links', type: 'list-text', required: false, description: '辅助链接', countRange: { min: 1, max: 4 } },
  ],
};

describe('元素池预览', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  /** 起一台服务。`structured: false` 用来造"没装配池子"的部署。 */
  async function boot(structured: boolean) {
    const ctx = await startServer(structured ? { structured: true } : {});
    started.push(ctx);
    return ctx;
  }

  async function getHtml(origin: string, path: string): Promise<{ status: number; type: string; html: string }> {
    const response = await fetch(`${origin}${path}`);
    return {
      status: response.status,
      type: String(response.headers.get('content-type')),
      html: await response.text(),
    };
  }

  it('单个 block：完整自包含 HTML，锚点、专属版式与示例内容都在', async () => {
    const ctx = await boot(true);
    const page = await getHtml(ctx.origin, '/api/blocks/hero/preview');

    assert.equal(page.status, 200);
    assert.match(page.type, HTML_CONTENT_TYPE);
    assert.match(page.html, /^<!DOCTYPE html>/i);
    assert.match(page.html, /<\/html>\s*$/);

    // 锚点与版式：这才是"与产物同一套渲染器"的证据，光有 200 说明不了。
    assert.match(page.html, /data-ms-block="b1"/);
    assert.match(page.html, /data-ms-type="hero"/);
    assert.match(page.html, /class="ms-block ms-block--hero"/);
    assert.match(page.html, /class="ms-hero__title"/);

    // 内容真的填了，而且**已经不是待填充态**。
    assert.match(page.html, /示例标题/);
    assert.match(page.html, /示例按钮/);
    assert.doesNotMatch(page.html, /待填充/);

    // 样式内联：塞进 iframe 就能独立看，不依赖任何外部资源。
    assert.match(page.html, /<style>/);
    assert.match(page.html, /\.ms-hero__title\s*\{/);
    assert.doesNotMatch(page.html, /<link[^>]+stylesheet/);
  });

  it('自定义 block 也能预览：走通用渲染，而不是"未支持的类型"', async () => {
    const ctx = await boot(true);
    const created = await fetch(`${ctx.origin}/api/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CUSTOM_BLOCK),
    });
    assert.equal(created.status, 201);

    const page = await getHtml(ctx.origin, '/api/blocks/promo-banner/preview');
    assert.equal(page.status, 200);
    assert.match(page.html, /class="ms-block ms-block--promo-banner"/);
    // 按 slot 声明推出来的版式：title 出小标题、list-text 出列表。
    assert.match(page.html, /class="ms-generic__title"/);
    assert.match(page.html, /class="ms-generic__list"/);
    assert.match(page.html, /示例标题/);
    assert.equal((page.html.match(/<li>/g) ?? []).length, 3, 'links 的条数应当是 3');
  });

  it('列表条数服从 countRange：取 min 与 3 的较大者，且图片走内联 SVG 占位', async () => {
    const ctx = await boot(true);

    // features.items 2..6 → 3 张卡片
    const features = await getHtml(ctx.origin, '/api/blocks/features/preview');
    assert.equal((features.html.match(/class="ms-features__item"/g) ?? []).length, 3);
    // 卡片是"标题 | 说明"两段，说明部分不该丢。
    assert.match(features.html, /class="ms-features__item-detail"/);

    // gallery.images 2..8 → 3 张图，且**不是空 src**：ref 留空，占位图由渲染器生成。
    const gallery = await getHtml(ctx.origin, '/api/blocks/gallery/preview');
    assert.equal((gallery.html.match(/class="ms-gallery__item"/g) ?? []).length, 3);
    assert.match(gallery.html, /data:image\/svg\+xml/);
    assert.doesNotMatch(gallery.html, /src=""/);

    // table.rows 2..8 → 3 行（1 表头 + 2 正文），竖线切两列。
    const table = await getHtml(ctx.origin, '/api/blocks/table/preview');
    assert.equal((table.html.match(/<tr>/g) ?? []).length, 3);
    assert.match(table.html, /示例指标 1/);

    // footer.links 1..5 → 3 条短标签（长句塞进页脚，版式一眼就不对）。
    const footer = await getHtml(ctx.origin, '/api/blocks/footer/preview');
    assert.equal((footer.html.match(/<li><a href="#">/g) ?? []).length, 3);
    assert.match(footer.html, /© 示例站点 版权所有/);
  });

  it('演示文稿版式：用 deck 渲染器，版式锚点与翻页锚点都在', async () => {
    const ctx = await boot(true);
    const page = await getHtml(ctx.origin, '/api/slide-layouts/bullets/preview');

    assert.equal(page.status, 200);
    assert.match(page.type, HTML_CONTENT_TYPE);
    assert.match(page.html, /data-ms-layout="bullets"/);
    assert.match(page.html, /data-ms-panel="deck:1"/);
    assert.match(page.html, /data-ms-tab="deck:1"/);
    assert.match(page.html, /class="sk-bullets__title"/);
    assert.match(page.html, /示例小节标题/);
    assert.equal((page.html.match(/class="sk-bullets__item"/g) ?? []).length, 3);
    // 一份文稿只放这一页：版式预览不是"把网页改个名"。
    assert.equal((page.html.match(/class="slide"/g) ?? []).length, 1);

    // 一个用图的版式：留空也要有占位，不能是破图。
    const image = await getHtml(ctx.origin, '/api/slide-layouts/image-slide/preview');
    assert.equal(image.status, 200);
    assert.match(image.html, /data-ms-layout="image-slide"/);
    assert.match(image.html, /class="sk-image__figure"/);
  });

  it('模板预览：模板里的每一块都按模板给定的顺序出现', async () => {
    const ctx = await boot(true);
    const list = (await (await fetch(`${ctx.origin}/api/templates`)).json()) as {
      templates: { id: string; blocks: { type: string }[] }[];
    };
    assert.ok(list.templates.length >= 4, `内置模板应不少于 4 套，实际 ${list.templates.length}`);

    for (const template of list.templates) {
      const page = await getHtml(ctx.origin, `/api/templates/${template.id}/preview`);
      assert.equal(page.status, 200, `模板 ${template.id} 的预览应当成功`);
      assert.match(page.type, HTML_CONTENT_TYPE);

      // 每块都在，且**顺序就是模板给的顺序**（不是按 id 排的另一套结构）。
      const order = [...page.html.matchAll(/data-ms-type="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(
        order,
        template.blocks.map((b) => b.type),
        `模板 ${template.id} 的块序应与模板一致`,
      );
      for (const [i, block] of template.blocks.entries()) {
        assert.match(
          page.html,
          new RegExp(`data-ms-block="b${i + 1}"[^>]*data-ms-type="${block.type}"`),
          `${template.id} 的第 ${i + 1} 块（${block.type}）应当出现在预览里`,
        );
      }
    }

    // 内容也验一遍：product-launch = hero + features。
    const launch = await getHtml(ctx.origin, '/api/templates/product-launch/preview');
    assert.match(launch.html, /class="ms-hero__title"/);
    assert.match(launch.html, /示例标题/);
    assert.match(launch.html, /示例要点 1/);
    assert.match(launch.html, /用一句话说明它能解决什么问题/);
  });

  it('未知 id 一律 404，并说清可用的有哪些', async () => {
    const ctx = await boot(true);
    const paths = [
      '/api/blocks/no-such-block/preview',
      '/api/slide-layouts/no-such-layout/preview',
      '/api/templates/no-such-template/preview',
    ];
    for (const path of paths) {
      const response = await fetch(`${ctx.origin}${path}`);
      assert.equal(response.status, 404, `${path} 应当是 404`);
      const body = (await response.json()) as { error?: string; detail?: string };
      assert.match(String(body.error), /no-such/, `${path} 的 error 里该说清是哪个 id`);
      assert.match(String(body.detail), /可用: /, `${path} 的 detail 该列出可用 id`);
      // 404 必须是 JSON 错误体，而不是一份"看起来能用"的空 HTML。
      assert.match(String(response.headers.get('content-type')), /application\/json/);
    }
  });

  it('没装配池子时回 503，而不是给一份空页面', async () => {
    const ctx = await boot(false);
    const paths = [
      '/api/blocks/hero/preview',
      '/api/slide-layouts/bullets/preview',
      '/api/templates/product-launch/preview',
    ];
    for (const path of paths) {
      const response = await fetch(`${ctx.origin}${path}`);
      assert.equal(response.status, 503, `${path} 在未装配池子时应当是 503`);
      const body = (await response.json()) as { error?: string; detail?: string };
      assert.match(String(body.error), /未装配/, `${path} 的错误该说清是"这次部署没装"`);
      assert.ok(body.detail, '503 也要给出可读的 detail');
    }
  });

  it('确定性：同一请求两次、两台独立实例，字节完全一致', async () => {
    const first = await boot(true);
    const second = await boot(true);

    const paths = [
      '/api/blocks/hero/preview',
      '/api/blocks/gallery/preview',
      '/api/slide-layouts/two-col/preview',
      '/api/templates/doc-page/preview',
    ];
    for (const path of paths) {
      const a = (await getHtml(first.origin, path)).html;
      const b = (await getHtml(first.origin, path)).html;
      assert.equal(a, b, `${path} 的两次请求应当逐字节相同`);
      const c = (await getHtml(second.origin, path)).html;
      assert.equal(a, c, `${path} 在两台独立实例上应当逐字节相同`);
    }
  });
});
