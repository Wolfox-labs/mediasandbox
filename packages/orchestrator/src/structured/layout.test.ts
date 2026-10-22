/**
 * 版式层与页面壳的测试。
 *
 * 这一层解决的是"结构对了，但页面上只是把块堆起来"：版式让同一份内容
 * 能有不同摆法（决策层选），页面壳让缺 nav/footer 的结构也有完整首尾。
 *
 * 两条纪律在这里各有一个守卫：
 *   - 版式是**决策**，不是渲染器的隐式默认值：选了要写进结构留痕；
 *   - 页面壳**只补缺**：结构里已经有 nav/footer 时不许再叠一条。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Answer,
  DecisionBatchResult,
  DecisionClient,
  DecisionContext,
  Question,
} from '../decision/types.js';
import { createBlockRegistry } from './block-spec.js';
import { createPageSpec, validatePageSpec, type BlockInstance, type PageSpec } from './page-spec.js';
import { renderPage } from './renderer.js';
import { STRUCTURE_QUESTIONS, StructurePlanner } from './planner.js';

/** 只回答版式、其余走默认的假决策层。 */
class LayoutDecision implements DecisionClient {
  readonly kind = 'stub' as const;

  constructor(private readonly layout: string | null) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'stub' };
  }

  async decide(
    _context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
  ): Promise<DecisionBatchResult> {
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (id === STRUCTURE_QUESTIONS.blockLayout && question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        const value = this.layout;
        answers[id] = {
          type: 'choice',
          value,
          probabilities: Object.fromEntries(ids.map((option) => [option, 1 / ids.length])),
        };
        continue;
      }
      if (id === STRUCTURE_QUESTIONS.structureQuality) {
        answers[id] = { type: 'score', value: 0.7 };
        continue;
      }
      if (question.type === 'choice') {
        const ids = Object.keys(question.criteria);
        answers[id] = {
          type: 'choice',
          value: ids[0]!,
          probabilities: Object.fromEntries(ids.map((option) => [option, 1 / ids.length])),
        };
        continue;
      }
      if (question.type === 'numeric') {
        answers[id] = { type: 'numeric', value: question.range?.min ?? 2 };
        continue;
      }
      answers[id] = { type: 'noul', value: false, yesProbability: 0.05 };
    }
    return {
      answers,
      meta: { latencyMs: 1, source: 'stub' },
      usage: { inputTokens: 1, outputTokens: 0 },
      raw: {},
    };
  }
}

const REQUEST = { projectId: 'proj-layout', goal: '做一个产品介绍落地页' };

function heroBlock(layout?: string): BlockInstance {
  return {
    id: 'b1',
    type: 'hero',
    slots: {
      title: { kind: 'text', text: '一眼看懂的产品' },
      subtitle: { kind: 'text', text: '一句话说明它解决什么问题' },
      actionText: { kind: 'text', text: '立即体验' },
    },
    status: 'filled',
    sources: {},
    ...(layout === undefined ? {} : { layout }),
  };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return {
    ...createPageSpec({ projectId: 'proj-layout', goal: '做一个产品介绍落地页', candidateBlockIds: [] }),
    blocks,
  };
}

describe('版式：由决策层选，并写进结构', () => {
  it('决策层答 center，结构里记的就是 center，留痕里说得出理由', async () => {
    const decision = new LayoutDecision('center');
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero'],
    });

    assert.equal(result.page.blocks[0]?.layout, 'center');
    const step = result.steps.find((s) => s.kind === 'layout');
    assert.ok(step !== undefined, '没有版式轮次');
    assert.match(step.rationale, /版式=center/);
  });

  it('答了不认识的版式时回落默认，并在依据里说明——不静默吞掉', async () => {
    const decision = new LayoutDecision('neon');
    const result = await new StructurePlanner(createBlockRegistry(), decision).plan({
      ...REQUEST,
      candidateBlockIds: ['hero'],
    });

    assert.equal(result.page.blocks[0]?.layout, 'split');
    const step = result.steps.find((s) => s.kind === 'layout');
    assert.match(step?.rationale ?? '', /未知版式/);
  });

  it('结构里写了未声明的版式会被校验拦住，而不是渲染时静默降级', () => {
    assert.throws(
      () => validatePageSpec(page([heroBlock('neon')]), createBlockRegistry()),
      /版式 neon 未声明/,
    );
  });
});

describe('渲染：版式真的改变了摆法', () => {
  it('hero 分栏与居中输出不同的版式类', () => {
    const split = renderPage(page([heroBlock('split')]));
    const center = renderPage(page([heroBlock('center')]));
    assert.ok(split.includes('class="ms-hero ms-hero--split"'));
    assert.ok(center.includes('class="ms-hero ms-hero--center"'));
  });

  it('features 的 rows 版式输出列表行结构与对应类名', () => {
    const html = renderPage(
      page([
        {
          id: 'b2',
          type: 'features',
          slots: {
            heading: { kind: 'text', text: '能做什么' },
            items: { kind: 'list', items: ['A | 说明 A', 'B | 说明 B', 'C | 说明 C', 'D | 说明 D'] },
          },
          status: 'filled',
          sources: {},
          layout: 'rows',
        },
      ]),
    );
    assert.ok(html.includes('class="ms-features ms-features--rows"'));
    assert.ok(html.includes('ms-features__row'));
    assert.ok(!html.includes('ms-features__item"'), 'rows 版式不该再输出卡片项');
  });

  it('hero 镜像分栏输出 mirror 类', () => {
    const html = renderPage(page([heroBlock('mirror')]));
    assert.ok(html.includes('class="ms-hero ms-hero--mirror"'));
  });

  it('features 的 bento 版式输出混排类', () => {
    const html = renderPage(
      page([
        {
          id: 'b9',
          type: 'features',
          slots: {
            heading: { kind: 'text', text: '重点' },
            items: { kind: 'list', items: ['A | 甲', 'B | 乙', 'C | 丙', 'D | 丁'] },
          },
          status: 'filled',
          sources: {},
          layout: 'bento',
        },
      ]),
    );
    assert.ok(html.includes('class="ms-features ms-features--bento"'));
  });

  it('gallery 的 collage 版式输出拼贴类', () => {
    const html = renderPage(
      page([
        {
          id: 'b10',
          type: 'gallery',
          slots: {
            heading: { kind: 'text', text: '图集' },
            images: {
              kind: 'list-image',
              refs: [
                { ref: '', alt: '' },
                { ref: '', alt: '' },
                { ref: '', alt: '' },
              ],
            },
          },
          status: 'filled',
          sources: {},
          layout: 'collage',
        },
      ]),
    );
    assert.ok(html.includes('class="ms-gallery ms-gallery--collage"'));
  });

  it('cta 的 card 版式与 banner 版式不同', () => {    const cta = (layout: string): BlockInstance => ({
      id: 'b3',
      type: 'cta',
      slots: {
        text: { kind: 'text', text: '现在就试试' },
        buttonText: { kind: 'text', text: '开始' },
      },
      status: 'filled',
      sources: {},
      layout,
    });
    assert.ok(renderPage(page([cta('card')])).includes('class="ms-cta ms-cta--card"'));
    assert.ok(renderPage(page([cta('banner')])).includes('class="ms-cta ms-cta--banner"'));
  });
});

describe('页面壳：缺什么补什么，不重复', () => {
  it('没有 nav/footer 时补顶栏与页脚，锚点指向真实小节', () => {
    const html = renderPage(page([heroBlock()]));
    assert.ok(html.includes('<header class="ms-topbar">'), '缺顶栏');
    assert.ok(html.includes('<footer class="ms-footer ms-footer--shell">'), '缺页脚');
    assert.ok(html.includes('href="#ms-s1"'), '锚点没有指向首块');
    assert.ok(html.includes('id="ms-s1"'), '首块没有锚点 id');
    assert.ok(html.includes('一眼看懂的产品'), '顶栏锚点标签应取真实标题');
  });

  it('结构里已经有 nav 时不再叠一条顶栏', () => {
    const nav: BlockInstance = {
      id: 'b0',
      type: 'nav',
      slots: {
        brand: { kind: 'text', text: '品牌' },
        links: { kind: 'list', items: ['产品', '文档'] },
      },
      status: 'filled',
      sources: {},
    };
    const html = renderPage(page([nav, heroBlock()]));
    assert.ok(!html.includes('<header class="ms-topbar">'), 'nav 块已经在，壳不该再补顶栏');
    assert.ok(html.includes('<footer class="ms-footer ms-footer--shell">'), '页脚仍然该补');
  });

  it('同样的输入逐字节相同（页面壳不引入时间/随机）', () => {
    const spec = page([heroBlock(), { ...heroBlock('center'), id: 'b2' }]);
    assert.equal(renderPage(spec), renderPage(spec));
  });
});
