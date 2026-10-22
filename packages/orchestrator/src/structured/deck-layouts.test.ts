/**
 * 版式池 ↔ 渲染器的一一对应。
 *
 * 为什么单独立一条：真正的故障不是「渲染得难看」，而是**注册了却没有渲染器**
 * （表里少一行），或反过来。前者会让一页静默退化成兜底排版，肉眼很难发现；
 * 上一次会话就栽在 RENDERERS 表被吃掉一行上。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSlideRegistry } from './deck-spec.js';
import { renderDeck } from './deck-renderer.js';
import type { BlockInstance, PageSpec, SlotValue } from './page-spec.js';
import type { SlotSpec } from './block-spec.js';

function slotValue(slot: SlotSpec): SlotValue {
  if (slot.type === 'list-image') {
    const min = slot.countRange?.min ?? 1;
    const refs = Array.from({ length: min }, () => ({ ref: 'data:image/png;base64,AA==', alt: '' }));
    return { kind: 'list-image', refs };
  }
  if (slot.type === 'list-text') {
    const min = slot.countRange?.min ?? 1;
    return { kind: 'list', items: Array.from({ length: min }, (_, i) => '甲' + (i + 1) + '|乙|丙') };
  }
  return { kind: 'text', text: '示例文案' };
}

function blockFor(type: string, slots: readonly SlotSpec[]): BlockInstance {
  const filled: Record<string, SlotValue> = {};
  for (const slot of slots) filled[slot.name] = slotValue(slot);
  return { id: 'b1', type: type as BlockInstance['type'], status: 'filled', sources: {}, slots: filled };
}

function specWith(blocks: BlockInstance[]): PageSpec {
  return {
    projectId: 'layout-check',
    goal: '版式覆盖检查',
    templateId: null,
    candidateBlockIds: blocks.map((b) => b.type),
    blocks,
    qualityScore: 0,
    createdAt: 0,
  };
}

describe('演示文稿版式池：每个版式都有自己的渲染器', () => {
  const layouts = createSlideRegistry().specs();

  it('池子非空，且覆盖了 deck 组', () => {
    assert.ok(layouts.length >= 20, '版式数量应不少于 20，实际 ' + layouts.length);
    assert.ok(layouts.every((spec) => spec.group === 'deck'));
  });

  for (const layout of layouts) {
    it(layout.id + ' 渲染成自己的版式，而不是兜底', () => {
      const block = blockFor(layout.id, layout.slots);
      const html = renderDeck(specWith([block]), { themeId: 'deep-navy' });
      assert.ok(
        html.includes('data-ms-layout="' + layout.id + '"'),
        layout.id + ' 没有出现在产物里',
      );
      assert.ok(
        !html.includes('class="sk-fallback"'),
        layout.id + ' 退化成兜底排版了——检查 RENDERERS 表里有没有这一项',
      );
    });
  }

  it('带母版渲染时，母版只出现在非封面页', () => {
    const blocks = [blockFor('cover', createSlideRegistry().get('cover').slots), blockFor('icon-grid', createSlideRegistry().get('icon-grid').slots)];
    const html = renderDeck(specWith(blocks), {
      themeId: 'deep-navy',
      chrome: { brand: '演示', sections: ['一', '二'], pages: [{}, { section: '二', sectionIndex: 1, note: '结论' }] },
    });
    assert.equal((html.match(/class="sk-chrome sk-chrome--top"/g) ?? []).length, 1);
    assert.ok(html.includes('data-chrome="band"'));
    assert.ok(html.includes('sk-chrome__note'));
  });
});