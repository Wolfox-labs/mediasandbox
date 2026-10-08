/**
 * 可点元素发现的测试。
 *
 * 这里的输入是**渲染器真实输出**，不是手写的 HTML 片段——
 * 否则锚点改名（`data-ms-tab` 之类）时测试还绿着，实际已经点不动了。
 * 断言的重点是"点哪儿、点了应该发生什么"这两件事都被代码写死，
 * 而不是留给模型临场猜。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPageSpec } from '../structured/page-spec.js';
import type { BlockInstance, PageSpec } from '../structured/page-spec.js';
import { renderPage } from '../structured/renderer.js';
import { cssAttrValue, describeClickTargets, findClickTarget, parseClickTargets } from './click-targets.js';

function block(id: string, type: string, slots: BlockInstance['slots']): BlockInstance {
  const sources: Record<string, 'deterministic'> = {};
  for (const name of Object.keys(slots)) sources[name] = 'deterministic';
  return { id, type, slots, status: 'filled', sources };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return { ...createPageSpec({ projectId: 'proj', goal: '测试目标', candidateBlockIds: [] }), blocks };
}

const tabsPage = page([
  block('b1', 'tabs', {
    tabs: { kind: 'list', items: ['概览', '参数 & 价格'] },
    panels: { kind: 'list', items: ['概览正文', '参数正文'] },
  }),
]);

describe('可点元素发现：从渲染结果里解析候选', () => {
  it('标签页的每个标签都成为候选，key/序号/选择器齐全', () => {
    const targets = parseClickTargets(renderPage(tabsPage)).filter((t) => t.kind === 'tab');
    assert.equal(targets.length, 2, '标签数不对');
    assert.deepEqual(
      targets.map((t) => t.key),
      ['b1:1', 'b1:2'],
    );
    assert.deepEqual(
      targets.map((t) => t.blockId),
      ['b1', 'b1'],
    );
    assert.deepEqual(
      targets.map((t) => t.part),
      [1, 2],
    );
    assert.equal(targets[0]!.label, '概览');
    assert.equal(targets[0]!.selector, '[data-ms-tab="b1:1"]');
    assert.match(targets[0]!.effect, /aria-selected/);
  });

  it('候选文本里的 HTML 实体被还原', () => {
    const targets = parseClickTargets(renderPage(tabsPage)).filter((t) => t.kind === 'tab');
    assert.equal(targets[1]!.label, '参数 & 价格', '实体没还原，模型看到的是乱码');
  });

  it('折叠面板指向 summary，点了要知道是切换 open', () => {
    const targets = parseClickTargets(
      renderPage(
        page([block('b9', 'accordion', { items: { kind: 'list', items: ['怎么退款|走原路', '多久到账|三天'] } })]),
      ),
    ).filter((t) => t.kind === 'accordion');
    assert.equal(targets.length, 2, '折叠项数不对');
    assert.equal(targets[0]!.selector, '[data-ms-accordion="b9:1"] > summary');
    assert.equal(targets[0]!.label, '怎么退款');
    assert.match(targets[0]!.effect, /open/);
  });

  it('表单提交按钮是候选，效果是提示可见', () => {
    const targets = parseClickTargets(
      renderPage(
        page([
          block('b7', 'form', {
            heading: { kind: 'text', text: '联系我们' },
            fields: { kind: 'list', items: ['邮箱'] },
            submitText: { kind: 'text', text: '发送' },
          }),
        ]),
      ),
    ).filter((t) => t.kind === 'submit');
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.key, 'b7');
    assert.equal(targets[0]!.selector, '[data-ms-submit="b7"]');
    assert.equal(targets[0]!.label, '发送');
    assert.match(targets[0]!.effect, /ms-form__note/);
  });

  it('纯静态页没有候选，不硬凑', () => {
    const targets = parseClickTargets(
      renderPage(page([block('b1', 'text', { body: { kind: 'text', text: '只有一段话' } })])),
    );
    assert.deepEqual(targets, [], '静态页不该冒出可点元素');
  });

  it('按文档顺序排列，多块混排时不乱序', () => {
    const targets = parseClickTargets(
      renderPage(
        page([
          block('b1', 'tabs', {
            tabs: { kind: 'list', items: ['甲'] },
            panels: { kind: 'list', items: ['甲正文'] },
          }),
          block('b2', 'form', {
            heading: { kind: 'text', text: '表单' },
            fields: { kind: 'list', items: ['姓名'] },
            submitText: { kind: 'text', text: '提交' },
          }),
          block('b3', 'accordion', { items: { kind: 'list', items: ['问|答'] } }),
        ]),
      ),
    );
    assert.deepEqual(
      targets.map((t) => t.kind),
      ['tab', 'submit', 'accordion'],
    );
  });
});

describe('可点元素发现：辅助函数', () => {
  it('findClickTarget 按 key 精确取，取不到返回 undefined', () => {
    const targets = parseClickTargets(renderPage(tabsPage));
    assert.equal(findClickTarget(targets, 'b1:2')?.part, 2);
    assert.equal(findClickTarget(targets, 'b1:1')?.part, 1, '前缀相同被误匹配');
    assert.equal(findClickTarget(targets, 'b1:9'), undefined);
  });

  it('属性值里的引号被转义，选择器撑不破', () => {
    assert.equal(cssAttrValue('a"b\\c'), 'a\\"b\\\\c');
  });

  it('给决策模型的选项文本带着"点了会怎样"', () => {
    const text = describeClickTargets(parseClickTargets(renderPage(tabsPage)));
    assert.match(text, /b1:1：概览（tab；点击后 .*aria-selected/);
    assert.match(text, /b1:2：参数 & 价格/);
  });
});
