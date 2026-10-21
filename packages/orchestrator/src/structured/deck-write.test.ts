/**
 * 一次执笔的测试。
 *
 * 盯三件事：
 *   1. 一页的文案确实来自**同一次调用**（不是逐 slot 拼的）
 *   2. 输出形状不对时**不硬塞**——未知 slot、空页都丢掉，让填充器回落
 *   3. 失败不抛错，返回 `ok:false`，调用方才有机会走兜底
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockLlmClient } from '../testing/mock-llm.js';
import { createSlideRegistry } from './deck-spec.js';
import { writeDeck, type DeckWritePagePlan } from './deck-write.js';

const layouts = createSlideRegistry();

function page(
  index: number,
  layoutId: string,
  counts: Readonly<Record<string, number>> = {},
): DeckWritePagePlan {
  return { index, spec: layouts.get(layoutId), counts };
}

describe('一次执笔：整份文稿一口气写完', () => {
  it('三页文案来自同一次调用，且按页序对齐', async () => {
    const llm = new MockLlmClient({
      rules: [
        {
          match: '演示文稿的执笔',
          text: JSON.stringify({
            pages: [
              { slots: { title: '季度复盘', subtitle: '把三个月的进展讲清楚' } },
              {
                slots: {
                  heading: '增长来自复购',
                  lede: '新增用户持平，复购贡献了主要增量',
                  items: ['复购率 38%', '老客带新占比 21%', '退货率降到 4%'],
                },
              },
              { slots: { headline: '下一步：把复购做成常态' } },
            ],
          }),
        },
      ],
    });

    const outcome = await writeDeck({
      llm,
      goal: '做一份季度复盘演示文稿',
      pages: [page(0, 'cover'), page(1, 'bullets', { items: 3 }), page(2, 'closing')],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(llm.calls.length, 1, '整份文稿只该有一次执笔调用');
    assert.equal(outcome.deck.pages.length, 3);
    assert.deepEqual(outcome.deck.pages[0]?.slots, {
      title: '季度复盘',
      subtitle: '把三个月的进展讲清楚',
    });
    assert.deepEqual(outcome.deck.pages[1]?.slots.items, [
      '复购率 38%',
      '老客带新占比 21%',
      '退货率降到 4%',
    ]);
    assert.equal(outcome.deck.pages[2]?.slots.headline, '下一步：把复购做成常态');
  });

  it('提示词里带着页序、版式与 slot 名，模型不用猜结构', async () => {
    const llm = new MockLlmClient({
      rules: [{ match: '演示文稿的执笔', text: '{"pages":[{"slots":{"title":"A"}}]}' }],
    });
    await writeDeck({
      llm,
      goal: '季度复盘',
      pages: [page(0, 'cover'), page(1, 'bullets', { items: 4 })],
    });

    const prompt = llm.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    assert.match(prompt, /共 2 页/);
    assert.match(prompt, /第 1 页 \[cover \/ 封面页\]/);
    assert.match(prompt, /第 2 页 \[bullets \/ 要点页\]/);
    assert.match(prompt, /items（必填，字符串数组，3~6 项）/);
  });

  it('宽松收取：slot 直接放在页面对象上、列表用换行分隔也能读', async () => {
    const llm = new MockLlmClient({
      rules: [
        {
          match: '演示文稿的执笔',
          text: JSON.stringify({
            pages: [
              { title: '封面标题', bogus: '模型编出来的 slot 应当被丢掉' },
              { heading: '这一页讲什么', items: '第一条\n第二条\n第三条' },
            ],
          }),
        },
      ],
    });

    const outcome = await writeDeck({
      llm,
      goal: '测试宽松解析',
      pages: [page(0, 'cover'), page(1, 'bullets', { items: 3 })],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.deck.pages[0]?.slots, { title: '封面标题' });
    assert.deepEqual(outcome.deck.pages[1]?.slots.items, ['第一条', '第二条', '第三条']);
  });

  it('图片类 slot 不归执笔写', async () => {
    const llm = new MockLlmClient({
      rules: [
        {
          match: '演示文稿的执笔',
          text: JSON.stringify({
            pages: [{ slots: { heading: '一张图', image: 'data:image/png;base64,xxx' } }],
          }),
        },
      ],
    });

    const outcome = await writeDeck({
      llm,
      goal: '图文页',
      pages: [page(0, 'image-slide')],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.deck.pages[0]?.slots, { heading: '一张图' });
  });

  it('读不出任何页面时返回 ok:false，不编假文案', async () => {
    const llm = new MockLlmClient({ defaultText: '这不是 JSON，只是一段解释。' });
    const outcome = await writeDeck({
      llm,
      goal: '季度复盘',
      pages: [page(0, 'cover')],
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.detail, /读不出任何一页文案/);
  });

  it('模型返回空 pages 时也判失败', async () => {
    const llm = new MockLlmClient({
      rules: [{ match: '演示文稿的执笔', text: '{"pages":[]}' }],
    });
    const outcome = await writeDeck({
      llm,
      goal: '季度复盘',
      pages: [page(0, 'cover')],
    });
    assert.equal(outcome.ok, false);
  });

  it('生成层抛错时返回 ok:false，而不是把整次运行打挂', async () => {
    const llm = new MockLlmClient({
      rules: [{ match: '演示文稿的执笔', fail: '模型不可达' }],
    });
    const outcome = await writeDeck({
      llm,
      goal: '季度复盘',
      pages: [page(0, 'cover')],
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.detail, /执笔模型调用失败：模型不可达/);
  });

  it('没有页面时不调用模型', async () => {
    const llm = new MockLlmClient();
    const outcome = await writeDeck({ llm, goal: '空文稿', pages: [] });
    assert.equal(outcome.ok, false);
    assert.equal(llm.calls.length, 0);
  });
});
