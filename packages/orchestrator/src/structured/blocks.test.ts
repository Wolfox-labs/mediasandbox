/**
 * block 池与结构化中间表示的测试。
 *
 * 重点验三件事：
 *   1. **池子本身是良构的** —— 15 类、3 组、slot 声明自洽
 *   2. **校验真的会拦错** —— 不是"能跑就行"，而是构造坏的输入看它报不报
 *   3. **不能当首块的真的当不了** —— 这条约束是"不让模型犯错"的关键
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BlockError,
  BlockRegistry,
  BLOCK_GROUPS,
  BUILTIN_BLOCKS,
  builtinBlockIds,
  createBlockRegistry,
  type BlockSpec,
} from './block-spec.js';
import {
  appendBlock,
  blockTypesOf,
  createPageSpec,
  describePageSpec,
  nextBlockId,
  normalizePageSpec,
  PageSpecError,
  insertBlock,
  moveBlock,
  removeBlock,
  replaceBlock,
  validatePageSpec,
  valueKindFor,
  type BlockInstance,
  type PageSpec,
} from './page-spec.js';
import { MAX_OPTIONS_PER_QUESTION } from '../decision/types.js';

function block(id: string, type: string, status: BlockInstance['status'] = 'pending'): BlockInstance {
  return { id, type, slots: {}, status, sources: {} };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return { ...createPageSpec({ projectId: 'p', goal: 'g', candidateBlockIds: [] }), blocks };
}

describe('block 池：内置词表', () => {
  it('恰好 15 类，分 3 组', () => {
    assert.equal(BUILTIN_BLOCKS.length, 15);
    const groups = new Set(BUILTIN_BLOCKS.map((b) => b.group));
    assert.equal(groups.size, 3);
    for (const g of groups) assert.ok(BLOCK_GROUPS.includes(g), `未知分组 ${g}`);
  });

  it('低于决策层单问上限，因此不需要分层提问', () => {
    // 这条是设计稿里"15 < 26，单问即可"那个结论的守卫：
    // 词表一旦涨过 26，`criteriaFor` 会直接抛错，而不是静默截断。
    assert.ok(
      BUILTIN_BLOCKS.length <= MAX_OPTIONS_PER_QUESTION,
      `block 词表 ${BUILTIN_BLOCKS.length} 项已超过单问上限 ${MAX_OPTIONS_PER_QUESTION}`,
    );
  });

  it('组内 id 唯一，且按 id 排序保证确定性', () => {
    const ids = builtinBlockIds();
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, [...ids].sort());
  });

  it('每个 block 至少有一个能当首块的', () => {
    // 否则"首轮候选集为空"会让规划器直接抛 NO_CANDIDATES。
    assert.ok(BUILTIN_BLOCKS.some((b) => b.canLead));
  });

  it('列表型 slot 都声明了 countRange，非列表型都没声明', () => {
    for (const spec of BUILTIN_BLOCKS) {
      for (const slot of spec.slots) {
        const isList = slot.type === 'list-text' || slot.type === 'list-image';
        if (isList) {
          assert.ok(slot.countRange !== undefined, `${spec.id}.${slot.name} 缺 countRange`);
        } else {
          assert.equal(slot.countRange, undefined, `${spec.id}.${slot.name} 不该有 countRange`);
        }
      }
    }
  });

  it('slot 类型都能映射到一种取值形态', () => {
    for (const spec of BUILTIN_BLOCKS) {
      for (const slot of spec.slots) {
        assert.ok(typeof valueKindFor(slot.type) === 'string');
      }
    }
  });
});

describe('block 池：注册与校验', () => {
  const ok: BlockSpec = {
    id: 'demo',
    label: '演示',
    description: 'd',
    group: 'content',
    slots: [{ name: 'body', type: 'text', required: true, description: '正文' }],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  };

  it('重复注册抛错，不静默覆盖', () => {
    const reg = createBlockRegistry();
    assert.throws(() => reg.register(BUILTIN_BLOCKS[0]!), /已被注册/);
  });

  it('id 非法抛错', () => {
    const reg = new BlockRegistry();
    assert.throws(() => reg.register({ ...ok, id: 'Bad_ID' }), /只允许小写字母/);
  });

  it('没有任何 slot 抛错', () => {
    const reg = new BlockRegistry();
    assert.throws(() => reg.register({ ...ok, slots: [] }), /未声明任何 slot/);
  });

  it('列表型 slot 缺 countRange 抛错——否则问不出"要几个"', () => {
    const reg = new BlockRegistry();
    assert.throws(
      () =>
        reg.register({
          ...ok,
          slots: [{ name: 'items', type: 'list-text', required: true, description: 'i' }],
        }),
      /必须声明 countRange/,
    );
  });

  it('countRange 非法抛错', () => {
    const reg = new BlockRegistry();
    assert.throws(
      () =>
        reg.register({
          ...ok,
          slots: [
            {
              name: 'items',
              type: 'list-text',
              required: true,
              description: 'i',
              countRange: { min: 5, max: 2 },
            },
          ],
        }),
      /countRange 非法/,
    );
  });

  it('slot 重名抛错', () => {
    const reg = new BlockRegistry();
    assert.throws(
      () =>
        reg.register({
          ...ok,
          slots: [
            { name: 'body', type: 'text', required: true, description: 'a' },
            { name: 'body', type: 'text', required: true, description: 'b' },
          ],
        }),
      /slot 重名/,
    );
  });

  it('get 未注册的 block 抛 UNKNOWN_BLOCK', () => {
    const reg = createBlockRegistry();
    assert.throws(
      () => reg.get('nope'),
      (e: unknown) => e instanceof BlockError && e.code === 'UNKNOWN_BLOCK',
    );
  });

  it('外部来源（模型提议/手打/导入）走同一套校验后入池', () => {
    const reg = createBlockRegistry([{ ...ok, id: 'proposed-banner' }]);
    assert.ok(reg.has('proposed-banner'));
    assert.equal(reg.size, BUILTIN_BLOCKS.length + 1);
    // 提议进来的同样参与候选集，与内置无差别。
    assert.ok(reg.candidatesFor({}).some((c) => c.id === 'proposed-banner'));
  });

  it('不合法的提议进不了池子', () => {
    assert.throws(() => createBlockRegistry([{ ...ok, id: 'UPPER' }]), BlockError);
  });

  it('placement 与 canLead 矛盾时拒绝注册——"必须在最前"和"不能当首块"不能同时成立', () => {
    assert.throws(
      () => createBlockRegistry([{ ...ok, id: 'weird', placement: 'first', canLead: false }]),
      (e: unknown) => e instanceof BlockError && e.code === 'BAD_SPEC',
    );
    // 反过来是合法的：nav 就是 canLead=true + placement='first'。
    const reg = createBlockRegistry([{ ...ok, id: 'banner', placement: 'first', canLead: true }]);
    assert.ok(reg.has('banner'));
  });

  it('内置词表里只有 nav 与 footer 声明了位置约束，其余一律 any', () => {
    const constrained = BUILTIN_BLOCKS.filter((b) => b.placement !== undefined);
    assert.deepEqual(
      constrained.map((b) => [b.id, b.placement]),
      [
        ['footer', 'last'],
        ['nav', 'first'],
      ],
      '把中间位置钉死会夺走决策模型的判断空间',
    );
  });
});

describe('block 池：候选集与分组查询', () => {
  it('按组筛选', () => {
    const reg = createBlockRegistry();
    for (const group of BLOCK_GROUPS) {
      const specs = reg.filter({ group });
      assert.ok(specs.length > 0, `${group} 组为空`);
      assert.ok(specs.every((s) => s.group === group));
    }
  });

  it('leadOnly 只给能当首块的', () => {
    const reg = createBlockRegistry();
    const leads = reg.filter({ leadOnly: true });
    assert.ok(leads.length > 0);
    assert.ok(leads.every((s) => s.canLead));
    assert.ok(leads.length < reg.size, '不该所有 block 都能当首块');
  });

  it('criteria 里带分组标签，让决策模型看得见分组', () => {
    const reg = createBlockRegistry();
    const criteria = reg.criteriaFor({ group: 'interactive' });
    for (const text of Object.values(criteria)) {
      assert.match(text, /\[交互块\]/);
    }
  });

  it('exclude 生效', () => {
    const reg = createBlockRegistry();
    const without = reg.filter({ exclude: ['hero', 'footer'] });
    assert.ok(!without.some((s) => s.id === 'hero' || s.id === 'footer'));
  });
});

describe('结构化中间表示：校验', () => {
  const reg = createBlockRegistry();

  it('空页面抛 EMPTY_PAGE', () => {
    assert.throws(
      () => validatePageSpec(page([]), reg),
      (e: unknown) => e instanceof PageSpecError && e.code === 'EMPTY_PAGE',
    );
  });

  it('block id 重复抛错', () => {
    assert.throws(
      () => validatePageSpec(page([block('b1', 'hero'), block('b1', 'cta')]), reg),
      /block id 重复/,
    );
  });

  it('未注册的类型抛 UNKNOWN_BLOCK', () => {
    assert.throws(
      () => validatePageSpec(page([block('b1', 'nonexistent')]), reg),
      (e: unknown) => e instanceof PageSpecError && e.code === 'UNKNOWN_BLOCK',
    );
  });

  it('不可重复的 block 出现两次抛错', () => {
    // hero 声明为 repeatable: false。
    assert.throws(
      () => validatePageSpec(page([block('b1', 'hero'), block('b2', 'hero')]), reg),
      /不可重复/,
    );
  });

  it('可重复的 block 出现两次没问题', () => {
    validatePageSpec(page([block('b1', 'text'), block('b2', 'text')]), reg);
  });

  it('已 filled 的块缺必需 slot 抛错', () => {
    assert.throws(
      () => validatePageSpec(page([block('b1', 'hero', 'filled')]), reg),
      /必需 slot title 缺失/,
    );
  });

  it('pending 的块缺 slot 是正常的——结构定了但还没填', () => {
    validatePageSpec(page([block('b1', 'hero', 'pending')]), reg);
  });

  it('slot 名未声明抛错', () => {
    const b: BlockInstance = {
      ...block('b1', 'quote', 'filled'),
      slots: {
        text: { kind: 'text', text: 't' },
        attribution: { kind: 'text', text: 'a' },
        bogus: { kind: 'text', text: 'x' },
      },
    };
    assert.throws(() => validatePageSpec(page([b]), reg), /未声明的 slot/);
  });

  it('取值形态与声明不符抛 SLOT_TYPE_MISMATCH', () => {
    const b: BlockInstance = {
      ...block('b1', 'hero', 'filled'),
      slots: {
        // hero.title 声明为 title（文本），这里给列表。
        title: { kind: 'list', items: ['a', 'b'] },
        subtitle: { kind: 'text', text: 's' },
        actionText: { kind: 'text', text: 'a' },
      },
    };
    assert.throws(
      () => validatePageSpec(page([b]), reg),
      (e: unknown) => e instanceof PageSpecError && e.code === 'SLOT_TYPE_MISMATCH',
    );
  });

  it('列表长度越界抛 COUNT_OUT_OF_RANGE', () => {
    // features.items 的区间是 2..6。
    const b: BlockInstance = {
      ...block('b1', 'features', 'filled'),
      slots: {
        heading: { kind: 'text', text: 'h' },
        items: { kind: 'list', items: ['只有一条'] },
      },
    };
    assert.throws(
      () => validatePageSpec(page([b]), reg),
      (e: unknown) => e instanceof PageSpecError && e.code === 'COUNT_OUT_OF_RANGE',
    );
  });

  it('不传 registry 时只做自洽校验', () => {
    // 不查类型是否存在，但 id 唯一性照查。
    validatePageSpec(page([block('b1', 'whatever')]));
    assert.throws(() => validatePageSpec(page([block('b1', 'x'), block('b1', 'y')])));
  });
});

describe('结构化中间表示：操作', () => {
  it('appendBlock 不改原对象', () => {
    const p0 = page([]);
    const p1 = appendBlock(p0, block('b1', 'hero'));
    assert.equal(p0.blocks.length, 0);
    assert.equal(p1.blocks.length, 1);
  });

  it('replaceBlock 定点替换', () => {
    const p = page([block('b1', 'hero'), block('b2', 'cta')]);
    const next = replaceBlock(p, 'b2', { ...block('b2', 'footer'), status: 'filled' });
    assert.equal(next.blocks[1]?.type, 'footer');
    assert.equal(next.blocks[0]?.type, 'hero', '别的块不该被动到');
  });

  it('replaceBlock 找不到目标时抛错——静默忽略会让"定点重做"失效却看不出来', () => {
    assert.throws(() => replaceBlock(page([block('b1', 'hero')]), 'nope', block('b9', 'cta')));
  });

  it('nextBlockId 只增不减，删块后不复用 id', () => {
    const p = page([block('b1', 'hero'), block('b2', 'text')]);
    assert.equal(nextBlockId(p), 'b3');
    // 即便中间空了一个，也不复用——复用会让"定点重做"打到别的块上。
    const sparse = page([block('b1', 'hero'), block('b5', 'text')]);
    assert.equal(nextBlockId(sparse), 'b6');
  });

  it('describePageSpec 给出可读的结构摘要', () => {
    const text = describePageSpec(page([block('b1', 'hero'), block('b2', 'cta')]));
    assert.match(text, /hero#b1/);
    assert.match(text, /cta#b2/);
    assert.match(text, /→/);
  });

  it('describePageSpec 对空页面有专门说法', () => {
    assert.equal(describePageSpec(page([])), '（空页面）');
  });

  it('describePageSpec 的列表型 slot 带项数——"要几个"那一问要能回喂进 state', () => {
    const p = page([
      {
        id: 'b1',
        type: 'features',
        slots: { items: { kind: 'list', items: ['', '', ''] } },
        status: 'pending',
        sources: {},
      },
    ]);
    assert.match(describePageSpec(p), /items:3/);
  });

  it('describePageSpec 对已填内容给一小段预览，并截断', () => {
    const p = page([
      {
        id: 'b1',
        type: 'hero',
        slots: { title: { kind: 'text', text: '这是一个特别特别长的标题需要被截断掉' } },
        status: 'filled',
        sources: {},
      },
    ]);
    const text = describePageSpec(p);
    assert.match(text, /title="/);
    assert.match(text, /…/);
    // 不截断的话，这一句每轮都进 state、进 rationale、进前端。
    assert.ok(!text.includes('需要被截断掉'), `预览没截断: ${text}`);
  });

  it('describePageSpec 对图集说"几张图"，而不是把 data URI 倒出来', () => {
    const p = page([
      {
        id: 'b1',
        type: 'gallery',
        slots: {
          images: {
            kind: 'list-image',
            refs: [
              { ref: 'data:image/svg+xml;base64,AAAA', alt: '图一' },
              { ref: 'data:image/svg+xml;base64,BBBB', alt: '图二' },
            ],
          },
        },
        status: 'filled',
        sources: {},
      },
    ]);
    const text = describePageSpec(p);
    assert.match(text, /images:2/);
    assert.ok(!text.includes('base64'), `不该把图片内容倒进 state: ${text}`);
  });

  it('blockTypesOf 按首次出现顺序去重', () => {
    const p = page([block('b1', 'text'), block('b2', 'hero'), block('b3', 'text')]);
    assert.deepEqual(blockTypesOf(p), ['text', 'hero']);
  });
});

describe('结构化中间表示：位置操作', () => {
  const three = (): PageSpec => page([block('b1', 'hero'), block('b2', 'text'), block('b3', 'cta')]);

  it('insertBlock 能插到中间，且不改原对象', () => {
    const p0 = three();
    const p1 = insertBlock(p0, 1, block('b9', 'quote'));
    assert.deepEqual(p1.blocks.map((b) => b.id), ['b1', 'b9', 'b2', 'b3']);
    assert.deepEqual(p0.blocks.map((b) => b.id), ['b1', 'b2', 'b3'], '原对象不该被动到');
  });

  it('insertBlock 允许 index 等于长度（等价于追加）', () => {
    const p1 = insertBlock(three(), 3, block('b9', 'quote'));
    assert.deepEqual(p1.blocks.map((b) => b.id), ['b1', 'b2', 'b3', 'b9']);
  });

  it('insertBlock 越界抛错，不静默夹取——夹取会让"插到第 3 位"与"插到最后"看起来一样', () => {
    for (const bad of [-1, 4, 1.5, Number.NaN]) {
      assert.throws(
        () => insertBlock(three(), bad, block('b9', 'quote')),
        (e: unknown) => e instanceof PageSpecError && e.code === 'INDEX_OUT_OF_RANGE',
        `index=${String(bad)} 应该被拒绝`,
      );
    }
  });

  it('removeBlock 删掉指定块，其余顺序不变', () => {
    const p1 = removeBlock(three(), 'b2');
    assert.deepEqual(p1.blocks.map((b) => b.id), ['b1', 'b3']);
  });

  it('removeBlock 找不到目标时抛错，不静默返回原结构', () => {
    assert.throws(
      () => removeBlock(three(), 'nope'),
      (e: unknown) => e instanceof PageSpecError && e.code === 'UNKNOWN_BLOCK',
    );
  });

  it('moveBlock 的 toIndex 是"移动完成后"所在的下标（向后移）', () => {
    const p1 = moveBlock(three(), 'b1', 2);
    assert.deepEqual(p1.blocks.map((b) => b.id), ['b2', 'b3', 'b1']);
  });

  it('moveBlock 向前移同样成立', () => {
    const p1 = moveBlock(three(), 'b3', 0);
    assert.deepEqual(p1.blocks.map((b) => b.id), ['b3', 'b1', 'b2']);
  });

  it('moveBlock 位置没变时返回原对象——调用方靠它判断"有没有动过"', () => {
    const p = three();
    assert.equal(moveBlock(p, 'b2', 1), p);
  });

  it('moveBlock 越界抛错（下标不能等于长度，那里没有位置可占）', () => {
    for (const bad of [-1, 3, 0.5]) {
      assert.throws(
        () => moveBlock(three(), 'b1', bad),
        (e: unknown) => e instanceof PageSpecError && e.code === 'INDEX_OUT_OF_RANGE',
      );
    }
  });

  it('moveBlock 找不到目标时抛错', () => {
    assert.throws(() => moveBlock(three(), 'nope', 0));
  });
});

describe('版式规范化：把两端块挪回该在的位置', () => {
  const registry = createBlockRegistry();

  it('footer 排在中间时被移到最后——页脚后面不该还有正文', () => {
    const p = page([block('b1', 'hero'), block('b2', 'footer'), block('b3', 'features')]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.deepEqual(fixed.blocks.map((b) => b.type), ['hero', 'features', 'footer']);
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0]?.kind, 'moved');
    assert.match(fixes[0]!.detail, /placement='last'/);
  });

  it('nav 不在最前时被移到最前——它是"顶部导航"', () => {
    const p = page([block('b1', 'hero'), block('b2', 'features'), block('b3', 'nav')]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.deepEqual(fixed.blocks.map((b) => b.type), ['nav', 'hero', 'features']);
    assert.equal(fixes.length, 1);
    assert.match(fixes[0]!.detail, /placement='first'/);
  });

  it('nav 与 footer 同时跑偏时，一头一尾都归位', () => {
    const p = page([
      block('b1', 'hero'),
      block('b2', 'footer'),
      block('b3', 'features'),
      block('b4', 'nav'),
    ]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.deepEqual(fixed.blocks.map((b) => b.type), ['nav', 'hero', 'features', 'footer']);
    assert.equal(fixes.length, 2);
  });

  it('不可重复的块重复出现时保留第一个——后面那个更可能是模型忘了自己放过', () => {
    const p = page([block('b1', 'hero'), block('b2', 'text'), block('b3', 'hero')]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.deepEqual(fixed.blocks.map((b) => b.id), ['b1', 'b2']);
    assert.equal(fixes[0]?.kind, 'removed');
  });

  it('可重复的块重复出现不动它——text 出现两次很正常', () => {
    const p = page([block('b1', 'text'), block('b2', 'text'), block('b3', 'text')]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.equal(fixed.blocks.length, 3);
    assert.equal(fixes.length, 0);
  });

  it('本来就合规的结构一个字节都不动，且返回原对象', () => {
    const p = page([block('b1', 'nav'), block('b2', 'hero'), block('b3', 'footer')]);
    const { page: fixed, fixes } = normalizePageSpec(p, registry);
    assert.equal(fixed, p, '没修正时不该产生无意义的复制');
    assert.equal(fixes.length, 0);
  });

  it('未注册的类型跳过，不在这里抢着报错——那是 validatePageSpec 的活', () => {
    const p = page([block('b1', 'hero'), block('b2', 'no-such-block')]);
    const { page: fixed } = normalizePageSpec(p, registry);
    assert.equal(fixed.blocks.length, 2);
  });

  it('规范化之后，不可重复重复的结构能通过校验（它是校验的前置补丁）', () => {
    const p = page([block('b1', 'hero'), block('b2', 'hero')]);
    assert.throws(() => validatePageSpec(p, registry), /不可重复/);
    const { page: fixed } = normalizePageSpec(p, registry);
    validatePageSpec(fixed, registry); // 不该抛
  });
});
