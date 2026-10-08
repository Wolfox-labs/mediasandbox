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
  PageSpecError,
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

  it('blockTypesOf 按首次出现顺序去重', () => {
    const p = page([block('b1', 'text'), block('b2', 'hero'), block('b3', 'text')]);
    assert.deepEqual(blockTypesOf(p), ['text', 'hero']);
  });
});
