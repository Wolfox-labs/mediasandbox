/**
 * 模板层的测试。
 *
 * 三块重点：
 *   1. **注册期就把坏模板挡掉** —— 模板是"沉淀的经验"，一个排错的模板
 *      会把这个错误复制到之后每一个用它的项目上
 *   2. **起手结构真的被铺上，且模型还能继续排** —— "起手 ≠ 定死"
 *   3. **限定范围真的收窄了候选集** —— 这是模板防跑偏的主要手段
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBlockRegistry, type BlockRegistry } from './block-spec.js';
import { createPageSpec, type PageSpec } from './page-spec.js';
import {
  applyTemplate,
  builtinTemplates,
  createTemplateRegistry,
  extractTemplate,
  narrowCandidates,
  TemplateError,
  TemplateRegistry,
  validateTemplate,
  type TemplateSpec,
} from './template-spec.js';

const blocks: BlockRegistry = createBlockRegistry();

function template(patch: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    id: 't1',
    label: '测试模板',
    description: '用于测试',
    blocks: [{ type: 'hero' }],
    builtin: false,
    ...patch,
  };
}

function page(): PageSpec {
  return createPageSpec({ projectId: 'p', goal: '做一个产品介绍落地页', candidateBlockIds: [] });
}

describe('模板：内置词表', () => {
  it('内置模板都能注册，且模板池建得起来', () => {
    const registry = createTemplateRegistry(blocks);
    assert.equal(registry.size, builtinTemplates().length);
    assert.ok(registry.size >= 3, '至少要有几种能覆盖常见目标形态');
  });

  it('内置模板都是**起手前缀**，没有一个是排满整页的', () => {
    for (const spec of builtinTemplates()) {
      assert.ok(spec.blocks.length >= 1, `${spec.id} 应当至少给一块起手`);
      assert.ok(
        spec.blocks.length <= 2,
        `${spec.id} 起手 ${spec.blocks.length} 块太多了——起手太长，模型就没得可排`,
      );
      assert.equal(spec.builtin, true);
    }
  });

  it('内置模板的起手结构都以能当首块的块开头', () => {
    for (const spec of builtinTemplates()) {
      const first = spec.blocks[0]!;
      assert.equal(
        blocks.get(first.type).canLead,
        true,
        `${spec.id} 的首块 ${first.type} 不能当首块`,
      );
    }
  });

  it('内置模板的 allowedBlockIds 都真的在池子里', () => {
    for (const spec of builtinTemplates()) {
      for (const id of spec.allowedBlockIds ?? []) {
        assert.ok(blocks.has(id), `${spec.id} 引用了不存在的 block: ${id}`);
      }
    }
  });
});

describe('模板：注册与校验', () => {
  it('id 非法抛 BAD_TEMPLATE', () => {
    for (const bad of ['T1', '-x', '有中文', '']) {
      assert.throws(
        () => createTemplateRegistry(blocks, [template({ id: bad })]),
        (e: unknown) => e instanceof TemplateError && e.code === 'BAD_TEMPLATE',
        `id=${bad} 应该被拒绝`,
      );
    }
  });

  it('label 或 description 为空抛错——模板要给人看，说不清是什么就不该存在', () => {
    assert.throws(() => createTemplateRegistry(blocks, [template({ label: '  ' })]), TemplateError);
    assert.throws(
      () => createTemplateRegistry(blocks, [template({ description: '' })]),
      TemplateError,
    );
  });

  it('引用未注册的 block 抛错——注册期就拦，不留到执行期', () => {
    assert.throws(
      () => createTemplateRegistry(blocks, [template({ blocks: [{ type: 'no-such-block' }] })]),
      (e: unknown) => e instanceof TemplateError && e.code === 'BAD_TEMPLATE',
    );
  });

  it('不可重复的块在模板里出现两次抛错', () => {
    assert.throws(
      () =>
        createTemplateRegistry(blocks, [
          template({ blocks: [{ type: 'hero' }, { type: 'text' }, { type: 'hero' }] }),
        ]),
      TemplateError,
    );
  });

  it('可重复的块在模板里出现两次是允许的', () => {
    const registry = createTemplateRegistry(blocks, [
      template({ blocks: [{ type: 'text' }, { type: 'text' }] }),
    ]);
    assert.ok(registry.has('t1'));
  });

  it('placement 约束在注册期就校验：nav 不能在第二位、footer 不能在中间', () => {
    assert.throws(
      () =>
        createTemplateRegistry(blocks, [
          template({ blocks: [{ type: 'hero' }, { type: 'nav' }] }),
        ]),
      (e: unknown) => e instanceof TemplateError && /placement='first'/.test(e.message),
    );
    assert.throws(
      () =>
        createTemplateRegistry(blocks, [
          template({ blocks: [{ type: 'hero' }, { type: 'footer' }, { type: 'text' }] }),
        ]),
      (e: unknown) => e instanceof TemplateError && /placement='last'/.test(e.message),
    );
  });

  it('首块不能当首块时抛错', () => {
    assert.throws(
      () => createTemplateRegistry(blocks, [template({ blocks: [{ type: 'footer' }] })]),
      TemplateError,
    );
  });

  it('id 重复注册抛 DUPLICATE_TEMPLATE，不静默覆盖', () => {
    const registry = createTemplateRegistry(blocks);
    assert.throws(
      () => registry.register(template({ id: 'product-launch' })),
      (e: unknown) => e instanceof TemplateError && e.code === 'DUPLICATE_TEMPLATE',
    );
  });

  it('批量注册整体成功或整体失败', () => {
    const registry = new TemplateRegistry(blocks);
    assert.throws(() =>
      registry.registerAll([
        { ...template({ id: 'ok-one' }) },
        { ...template({ id: 'ok-one' }) },
      ]),
    );
    assert.equal(registry.size, 0, '失败时一个都不该进去');
  });

  it('get 未注册的模板抛 UNKNOWN_TEMPLATE', () => {
    assert.throws(
      () => createTemplateRegistry(blocks).get('nope'),
      (e: unknown) => e instanceof TemplateError && e.code === 'UNKNOWN_TEMPLATE',
    );
  });

  it('allowedBlockIds 引用未注册的 block 也抛错', () => {
    assert.throws(
      () => createTemplateRegistry(blocks, [template({ allowedBlockIds: ['nope'] })]),
      TemplateError,
    );
  });
});

describe('模板：起手结构', () => {
  it('applyTemplate 把块铺成 pending，并记下 templateId', () => {
    const spec = template({ blocks: [{ type: 'hero' }, { type: 'features' }] });
    const applied = applyTemplate(page(), spec);
    assert.equal(applied.templateId, 't1');
    assert.deepEqual(applied.blocks.map((b) => b.type), ['hero', 'features']);
    assert.deepEqual(
      applied.blocks.map((b) => b.status),
      ['pending', 'pending'],
      '模板给的是结构，内容归填充器',
    );
  });

  it('块 id 连续且不复用', () => {
    const applied = applyTemplate(page(), template({ blocks: [{ type: 'hero' }, { type: 'text' }] }));
    assert.deepEqual(applied.blocks.map((b) => b.id), ['b1', 'b2']);
  });

  it('模板预置的 slot 值被带上', () => {
    const spec = template({
      blocks: [{ type: 'cta', slots: { buttonText: { kind: 'text', text: '立即预约' } } }],
    });
    const applied = applyTemplate(page(), spec);
    assert.deepEqual(applied.blocks[0]?.slots['buttonText'], {
      kind: 'text',
      text: '立即预约',
    });
  });

  it('不改原页面对象', () => {
    const p0 = page();
    applyTemplate(p0, template());
    assert.equal(p0.blocks.length, 0);
    assert.equal(p0.templateId, null);
  });
});

describe('模板：限定范围', () => {
  it('模板没给 allowedBlockIds 时，候选集原样返回', () => {
    assert.deepEqual(narrowCandidates(['hero', 'text'], template()), ['hero', 'text']);
    assert.deepEqual(narrowCandidates(['hero', 'text'], undefined), ['hero', 'text']);
  });

  it('给了就取交集', () => {
    const spec = template({ allowedBlockIds: ['hero', 'cta'] });
    assert.deepEqual(narrowCandidates(['hero', 'text', 'cta'], spec), ['hero', 'cta']);
  });

  it('交集为空时抛错，而不是把空候选集丢给规划器', () => {
    const spec = template({ allowedBlockIds: ['hero'] });
    assert.throws(
      () => narrowCandidates(['text', 'cta'], spec),
      (e: unknown) => e instanceof TemplateError && /没有交集/.test(e.message),
    );
  });
});

describe('模板：从历史沉淀', () => {
  it('只沉淀结构，不沉淀内容——上个项目的文案抄过来会串味', () => {
    const finished: PageSpec = {
      ...page(),
      qualityScore: 0.82,
      blocks: [
        { id: 'b1', type: 'nav', slots: { brand: { kind: 'text', text: '某某品牌' } }, status: 'filled', sources: {} },
        { id: 'b2', type: 'hero', slots: { title: { kind: 'text', text: '上个项目的标题' } }, status: 'filled', sources: {} },
        { id: 'b3', type: 'footer', slots: {}, status: 'filled', sources: {} },
      ],
    };
    const spec = extractTemplate(finished, { id: 'from-history' });

    assert.deepEqual(spec.blocks.map((b) => b.type), ['nav', 'hero', 'footer']);
    for (const entry of spec.blocks) {
      assert.equal(entry.slots, undefined, '沉淀出来的模板不该带任何 slot 内容');
    }
    assert.equal(spec.builtin, false, '沉淀出来的不是内置模板');
  });

  it('allowedBlockIds 按首次出现去重', () => {
    const finished: PageSpec = {
      ...page(),
      blocks: [
        { id: 'b1', type: 'text', slots: {}, status: 'filled', sources: {} },
        { id: 'b2', type: 'text', slots: {}, status: 'filled', sources: {} },
      ],
    };
    assert.deepEqual(extractTemplate(finished, { id: 'x' }).allowedBlockIds, ['text']);
  });

  it('description 带上块数与结构评分，便于在界面上认出它从哪来', () => {
    const finished: PageSpec = {
      ...page(),
      qualityScore: 0.75,
      blocks: [{ id: 'b1', type: 'hero', slots: {}, status: 'filled', sources: {} }],
    };
    const spec = extractTemplate(finished, { id: 'x' });
    assert.match(spec.description, /hero/);
    assert.match(spec.description, /0\.750/);
  });

  it('沉淀出来的模板能直接注册 —— 闭环', () => {
    const finished: PageSpec = {
      ...page(),
      blocks: [
        { id: 'b1', type: 'nav', slots: {}, status: 'filled', sources: {} },
        { id: 'b2', type: 'hero', slots: {}, status: 'filled', sources: {} },
        { id: 'b3', type: 'footer', slots: {}, status: 'filled', sources: {} },
      ],
    };
    const spec = extractTemplate(finished, { id: 'recycled' });
    // "跑过的项目变成下次的起手经验"——这句话要能真的跑通，不能只是说说。
    const registry = createTemplateRegistry(blocks, [spec]);
    assert.ok(registry.has('recycled'));
  });

  it('结构不合规时沉淀出的模板注册会被拒（规范化才是合规的来源）', () => {
    const messy: PageSpec = {
      ...page(),
      blocks: [
        { id: 'b1', type: 'hero', slots: {}, status: 'filled', sources: {} },
        { id: 'b2', type: 'footer', slots: {}, status: 'filled', sources: {} },
        { id: 'b3', type: 'text', slots: {}, status: 'filled', sources: {} },
      ],
    };
    const spec = extractTemplate(messy, { id: 'messy' });
    assert.throws(() => validateTemplate(spec, blocks), TemplateError);
  });
});
