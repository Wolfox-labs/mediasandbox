import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError, type ToolExecutor, type ToolSpec } from './types.js';
import { ToolRegistry } from './registry.js';
import { BUILTIN_TOOLS } from './builtin.js';
import { MAX_OPTIONS_PER_QUESTION } from '../decision/types.js';

function makeSpec(id: string, overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    id,
    label: `工具 ${id}`,
    description: `用于测试的工具 ${id}`,
    envTypes: ['copy'],
    role: 'generate',
    category: 'test',
    inputs: [],
    outputs: [{ name: 'out', type: 'text', required: true, description: '产出' }],
    ...overrides,
  };
}

const noop: ToolExecutor = async () => ({ outputs: {}, artifacts: [], summary: 'ok' });

describe('ToolRegistry', () => {
  it('注册后可取回 spec 与执行器', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('alpha'), noop);
    assert.equal(registry.size, 1);
    assert.equal(registry.has('alpha'), true);
    assert.equal(registry.getSpec('alpha').id, 'alpha');
    assert.equal(typeof registry.get('alpha').execute, 'function');
  });

  it('未注册的工具抛 UNKNOWN_TOOL', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.get('nope'),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'UNKNOWN_TOOL');
        return true;
      },
    );
  });

  it('重复 id 抛 DUPLICATE_TOOL，不静默覆盖', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('dup'), noop);
    assert.throws(
      () => registry.register(makeSpec('dup'), noop),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'DUPLICATE_TOOL');
        return true;
      },
    );
  });

  it('非法 id 格式抛 BAD_SPEC', () => {
    const registry = new ToolRegistry();
    for (const bad of ['', 'Has-Upper', 'has space', 'has_underscore', '-leading']) {
      assert.throws(
        () => registry.register(makeSpec(bad), noop),
        (error: unknown) => {
          assert.ok(error instanceof ToolError, `id=${JSON.stringify(bad)} 应被拒`);
          assert.equal(error.code, 'BAD_SPEC');
          return true;
        },
      );
    }
  });

  it('declared 端口重名抛 BAD_SPEC', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () =>
        registry.register(
          makeSpec('dup-port', {
            inputs: [
              { name: 'x', type: 'text', required: true, description: 'a' },
              { name: 'x', type: 'text', required: false, description: 'b' },
            ],
          }),
          noop,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'BAD_SPEC');
        return true;
      },
    );
  });

  it('无产出或无环境类型抛 BAD_SPEC', () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register(makeSpec('no-out', { outputs: [] }), noop), /未声明任何产出/);
    assert.throws(() => registry.register(makeSpec('no-env', { envTypes: [] }), noop), /未声明任何环境类型/);
  });

  it('批量注册整体成功或整体失败', () => {
    const registry = new ToolRegistry();
    registry.registerAll([
      { spec: makeSpec('b1'), execute: noop },
      { spec: makeSpec('b2'), execute: noop },
    ]);
    assert.equal(registry.size, 2);

    const registry2 = new ToolRegistry();
    assert.throws(
      () =>
        registry2.registerAll([
          { spec: makeSpec('c1'), execute: noop },
          { spec: makeSpec('c1'), execute: noop },
        ]),
      /重复 id/,
    );
    assert.equal(registry2.size, 0, '失败时不应留下部分注册');
  });

  it('specs() 按 id 排序，保证确定性', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('zulu'), noop);
    registry.register(makeSpec('alpha'), noop);
    registry.register(makeSpec('mike'), noop);
    assert.deepEqual(
      registry.specs().map((s) => s.id),
      ['alpha', 'mike', 'zulu'],
    );
  });

  it('filter 支持环境、角色、分组、排除', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('fe-gen', { envTypes: ['frontend'], role: 'generate', category: 'fe' }), noop);
    registry.register(makeSpec('fe-build', { envTypes: ['frontend'], role: 'execute', category: 'fe' }), noop);
    registry.register(makeSpec('cp-gen', { envTypes: ['copy'], role: 'generate', category: 'cp' }), noop);
    registry.register(makeSpec('multi', { envTypes: ['frontend', 'copy'], role: 'generate', category: 'x' }), noop);

    assert.deepEqual(
      registry.filter({ envType: 'frontend' }).map((s) => s.id),
      ['fe-build', 'fe-gen', 'multi'],
    );
    assert.deepEqual(
      registry.filter({ role: 'generate' }).map((s) => s.id),
      ['cp-gen', 'fe-gen', 'multi'],
    );
    assert.deepEqual(registry.filter({ category: 'cp' }).map((s) => s.id), ['cp-gen']);
    assert.deepEqual(
      registry.filter({ envType: 'frontend', exclude: ['multi'] }).map((s) => s.id),
      ['fe-build', 'fe-gen'],
    );
  });

  it('candidatesFor 导出决策层候选集', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('one'), noop);
    registry.register(makeSpec('two'), noop);
    const options = registry.candidatesFor();
    assert.deepEqual(options.map((o) => o.id), ['one', 'two']);
    assert.ok(options[0]!.label.length > 0);
    assert.ok(options[0]!.detail.length > 0);
  });

  it('候选集为空时抛错，不返回空数组', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('only'), noop);
    assert.throws(
      () => registry.candidatesFor({ envType: 'image' }),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'BAD_SPEC');
        return true;
      },
    );
  });

  it('候选集超过决策层单问上限时抛错，不静默截断', () => {
    const registry = new ToolRegistry();
    for (let i = 0; i < MAX_OPTIONS_PER_QUESTION + 1; i += 1) {
      registry.register(makeSpec(`tool-${String(i).padStart(3, '0')}`), noop);
    }
    assert.throws(
      () => registry.candidatesFor(),
      (error: unknown) => {
        assert.ok(error instanceof ToolError);
        assert.match(error.message, /category/);
        return true;
      },
      '超出上限必须抛错并提示分层',
    );
    // 按分组查就能拿到合法候选集
    const grouped = registry.candidatesFor({ category: 'test', exclude: ['tool-000'] });
    assert.equal(grouped.length, MAX_OPTIONS_PER_QUESTION);
  });

  it('criteriaFor 生成 id → 描述，可直接喂给决策层', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('alpha'), noop);
    const criteria = registry.criteriaFor();
    assert.equal(Object.keys(criteria).length, 1);
    assert.match(criteria['alpha']!, /用于测试的工具 alpha/);
  });

  it('categories() 返回去重排序后的分组', () => {
    const registry = new ToolRegistry();
    registry.register(makeSpec('a', { category: 'zeta' }), noop);
    registry.register(makeSpec('b', { category: 'alpha' }), noop);
    registry.register(makeSpec('c', { category: 'alpha' }), noop);
    assert.deepEqual(registry.categories(), ['alpha', 'zeta']);
  });
});

describe('内置工具集', () => {
  it('能整体注册，且 id 唯一', () => {
    const registry = new ToolRegistry();
    registry.registerAll(BUILTIN_TOOLS);
    assert.equal(registry.size, BUILTIN_TOOLS.length);
    const ids = BUILTIN_TOOLS.map((t) => t.spec.id);
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  });

  it('覆盖三类环境，且每个环境都有可用工具', () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    for (const env of ['frontend', 'image', 'copy'] as const) {
      const tools = registry.filter({ envType: env });
      assert.ok(tools.length > 0, `环境 ${env} 应至少有一个工具`);
    }
  });

  it('每个环境的候选集都不超过决策层单问上限', () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    for (const env of ['frontend', 'image', 'copy'] as const) {
      const options = registry.candidatesFor({ envType: env });
      assert.ok(
        options.length <= MAX_OPTIONS_PER_QUESTION,
        `环境 ${env} 的候选集有 ${options.length} 项，超上限`,
      );
    }
  });

  it('三类环境都具备产出与校验能力', () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    for (const env of ['frontend', 'image', 'copy'] as const) {
      const roles = new Set(registry.filter({ envType: env }).map((s) => s.role));
      assert.ok(roles.has('verify'), `环境 ${env} 缺少校验工具`);
      assert.ok(
        roles.has('generate') || roles.has('transform'),
        `环境 ${env} 缺少产出工具`,
      );
    }
  });

  it('工具声明的命令依赖只出现在该环境内', () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const processImage = registry.getSpec('process-image');
    assert.deepEqual(processImage.requiresCommands, ['python']);
    assert.deepEqual(processImage.envTypes, ['image']);
  });
});
