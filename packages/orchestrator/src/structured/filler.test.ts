/**
 * 确定性填充器的测试。
 *
 * ## 这些测试的验收标准
 *
 * P2 的硬要求是"**零成本跑通**"。所以这里最重要的断言只有一条：
 *
 * > 不接生成层时，`generativeCalls` 必须**等于 0**。
 *
 * 它保证"跑一遍结构化链路"不花一分钱、不依赖任何外部服务、结果逐字节可复现。
 * 其余测试都围绕"填出来的东西是完整且合法的"展开——因为确定性内容再朴素，
 * 也不能是残缺的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBlockRegistry, BUILTIN_BLOCKS } from './block-spec.js';
import {
  createPageSpec,
  validatePageSpec,
  type BlockInstance,
  type PageSpec,
} from './page-spec.js';
import {
  deriveBrand,
  fillBlock,
  fillPage,
  placeholderImageDataUri,
  shorten,
} from './filler.js';
import { renderPage } from './renderer.js';

const reg = createBlockRegistry();

/** 造一个 pending 块，可选地带上 planner 问出来的数量。 */
function pending(type: string, slots: Record<string, unknown> = {}): BlockInstance {
  return {
    id: 'b1',
    type,
    slots: slots as BlockInstance['slots'],
    status: 'pending',
    sources: {},
  };
}

function specOf(type: string) {
  return reg.get(type);
}

describe('填充器：零成本是默认值', () => {
  it('不接生成层时，一页 15 个块全部填完且生成调用为 0', async () => {
    const page: PageSpec = {
      ...createPageSpec({ projectId: 'p', goal: '做一个产品介绍落地页', candidateBlockIds: [] }),
      blocks: BUILTIN_BLOCKS.map((spec, i) => ({
        id: `b${i + 1}`,
        type: spec.id,
        slots: {},
        status: 'pending' as const,
        sources: {},
      })),
    };
    const result = await fillPage({ page, blocks: reg });
    assert.equal(result.generativeCalls, 0, '确定性填充不该有任何生成调用');
    assert.equal(result.warnings.length, 0);
    assert.ok(result.page.blocks.every((b) => b.status === 'filled'));
    // 填完之后结构必须合法——这是"填出来的东西是完整的"的硬证明。
    validatePageSpec(result.page, reg);
  });

  it('同样的输入填两次，结果逐字节相同', async () => {
    const make = (): PageSpec => ({
      ...createPageSpec({ projectId: 'p', goal: '稳定的目标', candidateBlockIds: [] }),
      blocks: BUILTIN_BLOCKS.map((spec, i) => ({
        id: `b${i + 1}`,
        type: spec.id,
        slots: {},
        status: 'pending' as const,
        sources: {},
      })),
    });
    const a = await fillPage({ page: make(), blocks: reg });
    const b = await fillPage({ page: make(), blocks: reg });
    // 只比 **block 内容**，不比 `createdAt`：它是记录用的时间戳，不是内容。
    // 把它算进来，等于要求两次调用发生在同一毫秒内——那是假失败。
    assert.equal(JSON.stringify(a.page.blocks), JSON.stringify(b.page.blocks));
  });

  it('渲染出来的 HTML 也逐字节相同——确定性要一路走到产物', async () => {
    const makePage = (): PageSpec => ({
      ...createPageSpec({ projectId: 'p', goal: '稳定的目标', candidateBlockIds: [] }),
      blocks: BUILTIN_BLOCKS.map((spec, i) => ({
        id: `b${i + 1}`,
        type: spec.id,
        slots: {},
        status: 'pending' as const,
        sources: {},
      })),
    });
    const [a, b] = await Promise.all([
      fillPage({ page: makePage(), blocks: reg }),
      fillPage({ page: makePage(), blocks: reg }),
    ]);
    assert.equal(renderPage(a.page, { title: 'x' }), renderPage(b.page, { title: 'x' }));
  });

  it('每个 slot 都被标成确定性来源', async () => {
    const filled = await fillBlock({
      spec: specOf('hero'),
      block: pending('hero'),
      goal: '做一个落地页',
      brand: '测试站',
      options: {},
      index: 0,
      counts: {},
    });
    assert.equal(filled.generativeCalls, 0);
    for (const source of Object.values(filled.sources)) {
      assert.equal(source, 'deterministic');
    }
  });
});

describe('填充器：填出来的内容是完整的', () => {
  it('每个内置 block 填完都满足自己的 slot 声明', async () => {
    for (const spec of BUILTIN_BLOCKS) {
      const filled = await fillBlock({
        spec,
        block: pending(spec.id),
        goal: '为竞赛做作品介绍页',
        brand: '沙盒',
        options: {},
        index: 0,
        counts: {},
      });
      assert.equal(filled.block.status, 'filled', `${spec.id} 没填成 filled`);
      for (const slot of spec.slots) {
        const value = filled.block.slots[slot.name];
        assert.ok(value !== undefined, `${spec.id}.${slot.name} 没有值`);
        // 非空断言：确定性内容不该是空串。
        if (value.kind === 'text') {
          assert.ok(value.text.trim() !== '', `${spec.id}.${slot.name} 是空文本`);
        }
        if (value.kind === 'list') {
          assert.ok(value.items.length > 0, `${spec.id}.${slot.name} 是空列表`);
          assert.ok(
            value.items.every((s) => s.trim() !== ''),
            `${spec.id}.${slot.name} 有空项`,
          );
        }
      }
    }
  });

  it('列表型 slot 的长度落在声明区间内', async () => {
    for (const spec of BUILTIN_BLOCKS) {
      for (const slot of spec.slots) {
        if (slot.countRange === undefined) continue;
        // 故意给一个越界的数量，看填充器是否夹回区间。
        const filled = await fillBlock({
          spec,
          block: pending(spec.id),
          goal: 'g',
          brand: 'b',
          options: {},
          index: 0,
          counts: { [slot.name]: 999 },
        });
        const value = filled.block.slots[slot.name];
        const actual =
          value?.kind === 'list'
            ? value.items.length
            : value?.kind === 'list-image'
              ? value.refs.length
              : null;
        assert.ok(actual !== null, `${spec.id}.${slot.name} 不是列表形态：${String(value?.kind)}`);
        assert.ok(
          actual <= slot.countRange.max,
          `${spec.id}.${slot.name} 长度 ${actual} 超过上限 ${slot.countRange.max}`,
        );
        assert.ok(actual >= slot.countRange.min);
      }
    }
  });

  it('planner 放进 slots 的数量被保留——不然那一问就白问了', async () => {
    const block = pending('features', {
      heading: { kind: 'text', text: '预置标题' },
      items: { kind: 'list', items: ['', '', '', ''] },
    });
    const filled = await fillBlock({
      spec: specOf('features'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 4 },
    });
    const items = filled.block.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') assert.equal(items.items.length, 4);
  });

  /**
   * 回归：**planner 的占位只该贡献"长度"，不该贡献"内容"。**
   *
   * planner 为问数量而放进 `block.slots` 的是 `{ kind:'list', items:['','',''] }`
   * ——长度对、内容全空。填充器曾经把 `block.slots` 里的值**整体覆盖**上去，
   * 于是列表型 slot 落盘成一串空字符串，而 `status` 写着 `filled`、
   * 来源还标成 `user`（用户根本没参与）。
   *
   * 表现最明显的是 `gallery`：图集变成五个空 ref，页面上是五个破图占位，
   * 而产物清单、状态、来源三处都看不出问题。
   */
  it('planner 的空占位不得覆盖内容，只取其长度（gallery 回归）', async () => {
    const block = pending('gallery', {
      heading: { kind: 'text', text: '' },
      // 典型的 planner 占位：长度 5，内容全空。
      images: {
        kind: 'list-image',
        refs: Array.from({ length: 5 }, () => ({ ref: '', alt: '' })),
      },
    });
    const filled = await fillBlock({
      spec: specOf('gallery'),
      block,
      goal: '做一个产品介绍落地页',
      brand: '演示站',
      options: {},
      index: 0,
      counts: { images: 5 },
    });

    const images = filled.block.slots['images'];
    assert.equal(images?.kind, 'list-image');
    if (images?.kind !== 'list-image') return;

    // 长度来自决策层问出来的数量。
    assert.equal(images.refs.length, 5);
    // **每一张都必须真的有 ref** —— 这是这个回归的核心。
    for (const [i, ref] of images.refs.entries()) {
      assert.ok(ref.ref.trim() !== '', `第 ${i + 1} 张图的 ref 是空的（占位覆盖了内容）`);
      assert.ok(ref.ref.startsWith('data:image/svg+xml'), `第 ${i + 1} 张不是内联占位图`);
      assert.ok(ref.alt.trim() !== '', `第 ${i + 1} 张图的 alt 是空的`);
    }
    // 来源必须是确定性，不是 user —— 用户没有提供任何东西。
    assert.equal(filled.sources['images'], 'deterministic');
  });

  it('列表型占位同样只贡献长度（features 回归）', async () => {
    const block = pending('features', {
      heading: { kind: 'text', text: '' },
      items: { kind: 'list', items: ['', '', ''] },
    });
    const filled = await fillBlock({
      spec: specOf('features'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 3 },
    });
    const items = filled.block.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind !== 'list') return;
    assert.equal(items.items.length, 3);
    for (const [i, item] of items.items.entries()) {
      assert.ok(item.trim() !== '', `第 ${i + 1} 项是空的（占位覆盖了内容）`);
    }
    assert.equal(filled.sources['items'], 'deterministic');
  });

  it('数量与占位长度不一致时以数量为准', async () => {
    // 占位给 5 个、counts 说 3 —— 决策层问出来的数量是权威。
    const block = pending('gallery', {
      heading: { kind: 'text', text: '' },
      images: {
        kind: 'list-image',
        refs: Array.from({ length: 5 }, () => ({ ref: '', alt: '' })),
      },
    });
    const filled = await fillBlock({
      spec: specOf('gallery'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { images: 3 },
    });
    const images = filled.block.slots['images'];
    if (images?.kind !== 'list-image') return assert.fail('应当是图集');
    assert.equal(images.refs.length, 3);
    for (const ref of images.refs) assert.ok(ref.ref.startsWith('data:image/svg+xml'));
  });

  it('用户已经给过的值不被确定性内容覆盖', async () => {
    const block = pending('quote', {
      text: { kind: 'text', text: '用户写好的引述' },
      attribution: { kind: 'text', text: '用户' },
    });
    const filled = await fillBlock({
      spec: specOf('quote'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: {},
    });
    const text = filled.block.slots['text'];
    assert.equal(text?.kind, 'text');
    if (text?.kind === 'text') assert.equal(text.text, '用户写好的引述');
    assert.equal(filled.sources['text'], 'user');
  });

  it('列表型 slot 的真实内容被保留——此前它被静默丢掉，来源却标着 user', async () => {
    // 这条区分两种"已有值"：空占位（planner 为问数量放的壳）与真实内容
    // （模板预置 / 用户手填 / 上游产出）。早先两种都走"内容一律重新生成"，
    // 于是真实内容被丢掉，而 `sources` 还写着 `user` —— 状态说"这是你给的"，
    // 内容却是系统编的。
    const block = pending('features', {
      items: { kind: 'list', items: ['用户写的特性一', '用户写的特性二'] },
    });
    const filled = await fillBlock({
      spec: specOf('features'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 2 },
    });
    const items = filled.block.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') {
      assert.deepEqual(items.items, ['用户写的特性一', '用户写的特性二']);
    }
    assert.equal(filled.sources['items'], 'user');
  });

  it('真实内容项数不足时用确定性内容补齐，而不是把已有条目复制一遍', async () => {
    const block = pending('features', {
      items: { kind: 'list', items: ['唯一一条真实内容'] },
    });
    const filled = await fillBlock({
      spec: specOf('features'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 3 },
    });
    const items = filled.block.slots['items'];
    assert.equal(items?.kind, 'list');
    if (items?.kind === 'list') {
      assert.equal(items.items.length, 3);
      assert.equal(items.items[0], '唯一一条真实内容');
      assert.notEqual(
        items.items[1],
        '唯一一条真实内容',
        '循环取模会把第 1 条复制成第 2 条，页面上看起来就是"同一条说了两遍"',
      );
    }
  });

  it('真实内容超出问出来的项数时截断', async () => {
    const block = pending('features', {
      items: { kind: 'list', items: ['一', '二', '三'] },
    });
    const filled = await fillBlock({
      spec: specOf('features'),
      block,
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 2 },
    });
    const items = filled.block.slots['items'];
    if (items?.kind === 'list') assert.deepEqual(items.items, ['一', '二']);
  });

  it('决策层指定"确定性"的 slot 不调生成层——`slot_source` 那一问要有下文', async () => {
    let calls = 0;
    const generate = async (): Promise<{ text: string }> => {
      calls += 1;
      return { text: '生成层写的内容' };
    };
    const block: BlockInstance = {
      ...pending('quote', {}),
      slotPlans: { text: 'deterministic', attribution: 'generative' },
    };
    const filled = await fillBlock({
      spec: specOf('quote'),
      block,
      goal: 'g',
      brand: 'b',
      options: { generate },
      index: 0,
      counts: {},
    });
    // 只有标了 generative 的 attribution 走了生成层。
    assert.equal(calls, 1);
    assert.equal(filled.sources['attribution'], 'generative');
    assert.equal(filled.sources['text'], 'deterministic');
  });

  it('没问过 slotPlans 时保持原行为（零成本默认路径不受影响）', async () => {
    let calls = 0;
    const generate = async (): Promise<{ text: string }> => {
      calls += 1;
      return { text: '生成层写的内容' };
    };
    const filled = await fillBlock({
      spec: specOf('quote'),
      block: pending('quote', {}),
      goal: 'g',
      brand: 'b',
      options: { generate },
      index: 0,
      counts: {},
    });
    // quote 的 text 与 attribution 都是文本类 → 两个都过生成层。
    assert.equal(calls, 2);
    assert.equal(filled.sources['text'], 'generative');
  });

  it('slotPlans 全标确定性时一次生成层都不调', async () => {
    let calls = 0;
    const generate = async (): Promise<{ text: string }> => {
      calls += 1;
      return { text: '不该被调用' };
    };
    const block: BlockInstance = {
      ...pending('quote', {}),
      slotPlans: { text: 'deterministic', attribution: 'deterministic' },
    };
    const filled = await fillBlock({
      spec: specOf('quote'),
      block,
      goal: 'g',
      brand: 'b',
      options: { generate },
      index: 0,
      counts: {},
    });
    assert.equal(calls, 0);
    assert.equal(filled.generativeCalls, 0);
    // 页面依然是完整的：不生成不等于留空。
    assert.ok(filled.block.slots['text'] !== undefined);
  });

  it('标签页的标签与面板一一对应', async () => {
    const filled = await fillBlock({
      spec: specOf('tabs'),
      block: pending('tabs', { tabs: { kind: 'list', items: ['', '', ''] }, panels: { kind: 'list', items: ['', '', ''] } }),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { tabs: 3, panels: 3 },
    });
    const tabs = filled.block.slots['tabs'];
    const panels = filled.block.slots['panels'];
    if (tabs?.kind === 'list' && panels?.kind === 'list') {
      assert.equal(tabs.items.length, panels.items.length);
      // 每个面板的内容要提到对应的标签名，否则"一一对应"只是数量对上。
      for (const [i, name] of tabs.items.entries()) {
        assert.ok(
          panels.items[i]!.includes(name),
          `面板 ${i} 没有提到标签「${name}」`,
        );
      }
    } else {
      assert.fail('tabs/panels 应当是列表');
    }
  });

  it('表格行是竖线分隔的两列', async () => {
    const filled = await fillBlock({
      spec: specOf('table'),
      block: pending('table'),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { rows: 4 },
    });
    const rows = filled.block.slots['rows'];
    if (rows?.kind === 'list') {
      assert.equal(rows.items.length, 4);
      for (const row of rows.items) assert.ok(row.includes('|'), `表格行缺少分隔符: ${row}`);
    } else {
      assert.fail('rows 应当是列表');
    }
  });

  it('折叠面板是"问 | 答"形态', async () => {
    const filled = await fillBlock({
      spec: specOf('accordion'),
      block: pending('accordion'),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { items: 3 },
    });
    const items = filled.block.slots['items'];
    if (items?.kind === 'list') {
      for (const item of items.items) assert.ok(item.includes('|'), `问答缺少分隔符: ${item}`);
    }
  });

  it('代码块的 language 是确定性常量，不由模型编', async () => {
    const filled = await fillBlock({
      spec: specOf('code'),
      block: pending('code'),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: {},
    });
    const lang = filled.block.slots['language'];
    assert.equal(lang?.kind, 'text');
    if (lang?.kind === 'text') assert.equal(lang.text, 'ts');
  });
});

describe('填充器：图片真的能嵌进页面', () => {
  it('image slot 填成内联 SVG 的 data URI——不是空 src，也不需要网络', async () => {
    const filled = await fillBlock({
      spec: specOf('image'),
      block: pending('image'),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: {},
    });
    const prompt = filled.block.slots['prompt'];
    assert.equal(prompt?.kind, 'image');
    if (prompt?.kind === 'image') {
      assert.ok(prompt.ref.startsWith('data:image/svg+xml'), '占位图应当是内联 SVG');
      assert.ok(prompt.alt.trim() !== '', 'alt 不能为空');
    }
  });

  it('图集每张都有独立的 data URI', async () => {
    const filled = await fillBlock({
      spec: specOf('gallery'),
      block: pending('gallery'),
      goal: 'g',
      brand: 'b',
      options: {},
      index: 0,
      counts: { images: 3 },
    });
    const images = filled.block.slots['images'];
    assert.equal(images?.kind, 'list-image');
    if (images?.kind === 'list-image') {
      assert.equal(images.refs.length, 3);
      for (const ref of images.refs) {
        assert.ok(ref.ref.startsWith('data:image/svg+xml'));
        assert.ok(ref.alt.trim() !== '');
      }
    }
  });

  it('占位图对标签里的尖括号做转义——slot 内容来自用户目标，不转义就是注入点', () => {
    const uri = placeholderImageDataUri('<script>alert(1)</script>');
    const decoded = decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    assert.ok(!decoded.includes('<script>'), '未转义的标签进了 SVG');
    assert.ok(decoded.includes('&lt;script&gt;'));
  });

  it('不同序号的占位图配色不同，但同一序号永远一样', () => {
    const a = placeholderImageDataUri('x', 0);
    const b = placeholderImageDataUri('x', 1);
    assert.notEqual(a, b);
    assert.equal(a, placeholderImageDataUri('x', 0));
  });
});

describe('填充器：生成层是可选的增强，不是依赖', () => {
  it('接了生成层时，文本 slot 的来源标成 generative', async () => {
    const filled = await fillBlock({
      spec: specOf('hero'),
      block: pending('hero'),
      goal: '做一个落地页',
      brand: '测试站',
      options: {
        generate: async (req) =>
          req.slot.type === 'list-text' ? { items: ['a', 'b'] } : { text: `生成：${req.slot.name}` },
      },
      index: 0,
      counts: {},
    });
    assert.ok(filled.generativeCalls > 0);
    assert.ok(Object.values(filled.sources).includes('generative'));
  });

  it('生成层抛错时回落到确定性内容，页面依然完整', async () => {
    const filled = await fillBlock({
      spec: specOf('hero'),
      block: pending('hero'),
      goal: 'g',
      brand: 'b',
      options: {
        generate: async () => {
          throw new Error('上游 502');
        },
      },
      index: 0,
      counts: {},
    });
    assert.equal(filled.block.status, 'filled');
    assert.ok(filled.warnings.length > 0);
    assert.match(filled.warnings[0]!, /502/);
    // 每个必需 slot 仍然有值。
    for (const slot of specOf('hero').slots) {
      assert.ok(filled.block.slots[slot.name] !== undefined, `${slot.name} 丢了`);
    }
  });

  it('生成结果条数不符时忽略，不硬凑也不硬截', async () => {
    const filled = await fillBlock({
      spec: specOf('features'),
      block: pending('features'),
      goal: 'g',
      brand: 'b',
      options: {
        // features.items 的区间是 2..6，这里只给 1 条。
        generate: async (req) => (req.slot.type === 'list-text' ? { items: ['只有一条'] } : null),
      },
      index: 0,
      counts: { items: 3 },
    });
    const items = filled.block.slots['items'];
    if (items?.kind === 'list') {
      assert.equal(items.items.length, 3, '应当保留确定性内容');
      assert.ok(filled.warnings.some((w) => w.includes('形态与声明不符')));
    }
  });

  it('生成层对图片 slot 返回文本时被忽略，仍保留占位图', async () => {
    let askedForImage = false;
    const filled = await fillBlock({
      spec: specOf('image'),
      block: pending('image'),
      goal: 'g',
      brand: 'b',
      options: {
        generate: async (req) => {
          if (req.slot.type === 'image') askedForImage = true;
          return { text: 'x' };
        },
      },
      index: 0,
      counts: {},
    });
    // 生成器**会被调用**（是否该调用由调用方决定，`makeSlotGenerator` 里
    // 就对 image 直接返回 null）。这条守的是：即便它返回了一段文本，
    // 也不能让 image slot 变成一段文字——那样页面上的图就没了，
    // 而且产物清单里会出现一个"后缀是图但不是图"的东西。
    const value = filled.block.slots['prompt'];
    assert.equal(value?.kind, 'image');
    if (value?.kind === 'image') assert.ok(value.ref.startsWith('data:image/svg+xml'));
    assert.equal(askedForImage, true);
    // 并且明确记了原因，而不是静默丢弃。
    assert.ok(filled.warnings.some((w) => w.includes('prompt')));
  });
});

describe('填充器：单块失败不拖垮整页', () => {
  it('未注册的 block 类型让这一块失败，其余照填', async () => {
    const page: PageSpec = {
      ...createPageSpec({ projectId: 'p', goal: 'g', candidateBlockIds: [] }),
      blocks: [
        { id: 'b1', type: 'hero', slots: {}, status: 'pending', sources: {} },
        { id: 'b2', type: 'nonexistent', slots: {}, status: 'pending', sources: {} },
        { id: 'b3', type: 'cta', slots: {}, status: 'pending', sources: {} },
      ],
    };
    const result = await fillPage({ page, blocks: reg });
    assert.equal(result.page.blocks[0]?.status, 'filled');
    assert.equal(result.page.blocks[1]?.status, 'failed');
    assert.ok(result.page.blocks[1]?.error !== undefined);
    assert.equal(result.page.blocks[2]?.status, 'filled');
    assert.ok(result.warnings.some((w) => w.includes('b2')));
  });

  it('失败信息里带 block id 与类型，便于定点重做', async () => {
    const page: PageSpec = {
      ...createPageSpec({ projectId: 'p', goal: 'g', candidateBlockIds: [] }),
      blocks: [{ id: 'b7', type: 'unknown-type', slots: {}, status: 'pending', sources: {} }],
    };
    const result = await fillPage({ page, blocks: reg });
    const failed = result.page.blocks[0]!;
    assert.equal(failed.id, 'b7');
    assert.match(result.warnings[0]!, /b7/);
    assert.match(result.warnings[0]!, /unknown-type/);
  });
});

describe('填充器：文本派生', () => {
  it('shorten 截断并加省略号', () => {
    assert.equal(shorten('短', 10), '短');
    const long = shorten('一'.repeat(50), 10);
    assert.equal(long.length, 10);
    assert.ok(long.endsWith('…'));
  });

  it('shorten 折叠空白', () => {
    assert.equal(shorten('  a   b  ', 10), 'a b');
  });

  it('deriveBrand 去掉动词性前缀', () => {
    assert.equal(deriveBrand('帮我做一个产品落地页'), '产品落地页');
    assert.equal(deriveBrand('生成一份竞赛介绍'), '竞赛介绍');
    assert.equal(deriveBrand('产品落地页'), '产品落地页');
  });

  it('deriveBrand 在全是前缀时不返回空串', () => {
    assert.ok(deriveBrand('做').length > 0);
    assert.ok(deriveBrand('帮我').length > 0);
  });

  /**
   * 回归：品牌名不能切在词中间。
   *
   * 实测目标是「做一个产品介绍落地页，含首屏、特性与行动号召」时，
   * 剥掉"做一个"后按 16 字硬截得到「含首屏、特」——一句读不通的残句，
   * 直接顶在页面导航栏和页脚上。按标点断开才得到「产品介绍落地页」。
   */
  it('deriveBrand 在标点处断开，不切在词中间', () => {
    const brand = deriveBrand('做一个产品介绍落地页，含首屏、特性与行动号召');
    assert.equal(brand, '产品介绍落地页');
    // 不该留一个悬空的开括号或半个词。
    assert.ok(!brand.endsWith('、'), '结尾不该是顿号');
    assert.ok(!brand.endsWith('，'), '结尾不该是逗号');
  });

  it('deriveBrand 对小句边界都生效', () => {
    assert.equal(deriveBrand('帮我做产品主页，包含三栏'), '产品主页');
    assert.equal(deriveBrand('生成竞赛展示页、含图集'), '竞赛展示页');
    assert.equal(deriveBrand('创建作品集：图片与说明'), '作品集');
  });

  it('deriveBrand 没有标点时退回截断，并带省略号', () => {
    const brand = deriveBrand('这是一个没有标点但是非常非常长的目标描述');
    assert.ok(brand.length <= 16);
    assert.ok(brand.endsWith('…'), '硬截时必须带省略号，表明它被截断了');
  });

  it('标题长度受控——太长会撑破版式，也会把决策层的 state 撑大', async () => {
    const filled = await fillBlock({
      spec: specOf('hero'),
      block: pending('hero'),
      goal: '这是一个非常非常非常非常非常非常非常非常长的目标描述用于测试标题截断',
      brand: '这是一个非常非常非常非常非常长的品牌名',
      options: {},
      index: 0,
      counts: {},
    });
    const title = filled.block.slots['title'];
    if (title?.kind === 'text') {
      assert.ok(title.text.length <= 29, `标题长 ${title.text.length}`);
    }
  });
});

/**
 * 这批用例盯的是**内容形态**，不是内容对错。
 *
 * 前两类缺陷（图集空 ref、导航长句）都没有让任何断言失败、也没有让状态变红：
 * `status` 是 `filled`、来源是 `deterministic`、产物大小正常。它们只在
 * **渲染出来的页面上**才看得出来。所以这里按 block 逐个检查形态。
 */
describe('填充器：内容形态要合乎块的性质', () => {
  it('导航项是短标签，不是整句', async () => {
    const filled = await fillBlock({
      spec: specOf('nav'),
      block: pending('nav'),
      goal: '做一个产品介绍落地页，含首屏、特性与行动号召',
      brand: '演示站',
      options: {},
      index: 0,
      counts: { links: 4 },
    });
    const links = filled.block.slots['links'];
    assert.equal(links?.kind, 'list');
    if (links?.kind !== 'list') return;
    assert.equal(links.items.length, 4);
    for (const item of links.items) {
      // 真实导航项就是几个字。超过 8 个字的"链接"在页面上会折行成一句。
      assert.ok(
        item.length <= 8,
        `导航项「${item}」有 ${item.length} 字，太长了——页面上会折行`,
      );
      assert.ok(!item.includes('：'), `导航项不该带说明性冒号：「${item}」`);
    }
  });

  it('页脚链接同样是短标签', async () => {
    const filled = await fillBlock({
      spec: specOf('footer'),
      block: pending('footer'),
      goal: '做一个产品介绍落地页',
      brand: '演示站',
      options: {},
      index: 0,
      counts: { links: 3 },
    });
    const links = filled.block.slots['links'];
    if (links?.kind !== 'list') return assert.fail('应当是列表');
    for (const item of links.items) {
      assert.ok(item.length <= 8, `页脚链接「${item}」太长`);
    }
  });

  it('特性条目是说明性短语，不是空壳', async () => {
    const filled = await fillBlock({
      spec: specOf('features'),
      block: pending('features'),
      goal: '做一个产品介绍落地页',
      brand: '演示站',
      options: {},
      index: 0,
      counts: { items: 3 },
    });
    const items = filled.block.slots['items'];
    if (items?.kind !== 'list') return assert.fail('应当是列表');
    for (const item of items.items) {
      assert.ok(item.trim().length >= 4, `特性条目「${item}」太短，像占位`);
    }
  });

  it('导航与特性用的是不同的文案形态（同一套模板会串味）', async () => {
    const nav = await fillBlock({
      spec: specOf('nav'), block: pending('nav'), goal: '做一个落地页', brand: '站',
      options: {}, index: 0, counts: { links: 3 },
    });
    const features = await fillBlock({
      spec: specOf('features'), block: pending('features'), goal: '做一个落地页', brand: '站',
      options: {}, index: 0, counts: { items: 3 },
    });
    const navItems = nav.block.slots['links'];
    const featureItems = features.block.slots['items'];
    if (navItems?.kind !== 'list' || featureItems?.kind !== 'list') return assert.fail('应当是列表');
    // 导航项必须明显短于特性条目。
    const navMax = Math.max(...navItems.items.map((s) => s.length));
    const featureMin = Math.min(...featureItems.items.map((s) => s.length));
    assert.ok(
      navMax < featureMin,
      `导航最长 ${navMax} 字，特性最短 ${featureMin} 字——两者用了同一种形态`,
    );
  });
});
