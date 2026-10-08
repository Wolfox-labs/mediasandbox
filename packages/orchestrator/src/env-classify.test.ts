/**
 * 目标分类的测试。
 *
 * 这条能力此前**根本不存在**：`envType` 从请求体直接读，不传就默认 `copy`，
 * 于是一个图像需求会被静默当成文案任务处理。设计稿 §3.2 的第一问就是它。
 *
 * 验收标准有两条，都不能省：
 *   1. **决策层真的在判断** —— 它答什么就是什么，不被代码覆盖
 *   2. **判断不出来时链路照样跑** —— 分类是第一步，它失败等于整个目标做不了
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolRegistry } from './tools/registry.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import { STRUCTURED_TOOLS } from './structured/tools.js';
import { StubDecisionClient } from './decision/stub-client.js';
import { ENV_QUESTION_ID, ENV_TYPE_LABELS, candidateEnvs, classifyEnvType } from './env-classify.js';
import type { DecisionClient } from './decision/types.js';

/** 只有通用工具：`webpage` 没有主产出工具，不该进候选。 */
function baseRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll(BUILTIN_TOOLS);
}

/** 带上结构化工具：这时 `webpage` 才是一个真正可选项。 */
function fullRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll(BUILTIN_TOOLS).registerAll(STRUCTURED_TOOLS);
}

describe('目标分类：候选集来自注册表', () => {
  it('没有主产出工具的环境不进候选——选了就必然失败，那是给模型挖坑', () => {
    const withoutStructured = candidateEnvs(baseRegistry());
    assert.ok(!withoutStructured.includes('webpage'), 'webpage 这时没有工具，不该在候选里');

    const withStructured = candidateEnvs(fullRegistry());
    assert.ok(withStructured.includes('webpage'), '装了结构化工具之后它才可选');
    assert.ok(withStructured.includes('copy'));
    assert.ok(withStructured.includes('image'));
    assert.ok(withStructured.includes('frontend'));
  });

  it('每个候选都有说明文案，且 frontend 与 webpage 的差别写清了', () => {
    for (const env of candidateEnvs(fullRegistry())) {
      assert.ok((ENV_TYPE_LABELS[env] ?? '').length > 0, `${env} 没有说明文案`);
    }
    // 两个都能做网页，只说"网页"模型没法选。
    assert.match(ENV_TYPE_LABELS.frontend, /整页生成/);
    assert.match(ENV_TYPE_LABELS.webpage, /结构化制作/);
    assert.notEqual(ENV_TYPE_LABELS.frontend, ENV_TYPE_LABELS.webpage);
  });
});

describe('目标分类：决策层真的在判断', () => {
  it('决策层答什么就用什么', async () => {
    const decision = new StubDecisionClient().onChoice(ENV_QUESTION_ID, 'image');
    const result = await classifyEnvType({
      goal: '做一套产品图',
      registry: fullRegistry(),
      decision,
    });
    assert.equal(result.envType, 'image');
    assert.equal(result.source, 'decision');
    assert.equal(result.calls, 1);
    assert.match(result.rationale, /image/);
  });

  it('问题里带的是候选集与说明，而不是环境名字列表', async () => {
    let seenCriteria: Record<string, string> = {};
    const spy: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: true, detail: 'spy' }),
      decide: async (_ctx, questions) => {
        const q = questions[ENV_QUESTION_ID];
        seenCriteria = q !== undefined && q.type === 'choice' ? { ...q.criteria } : {};
        return {
          answers: { [ENV_QUESTION_ID]: { type: 'choice', value: 'copy', probabilities: { copy: 0.9 } } },
          meta: { latencyMs: 1, source: 'stub' },
          usage: { inputTokens: 1, outputTokens: 0 },
          raw: {},
        };
      },
    };
    await classifyEnvType({ goal: '写一段文案', registry: fullRegistry(), decision: spy });
    assert.deepEqual(Object.keys(seenCriteria).sort(), candidateEnvs(fullRegistry()).sort());
    assert.match(seenCriteria['webpage'] ?? '', /结构化制作/);
  });

  it('分类那一问**不带 envType**——填一个进去等于先给了答案', async () => {
    let seenEnvType: unknown = 'not-called';
    const spy: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: true, detail: 'spy' }),
      decide: async (ctx) => {
        seenEnvType = ctx.envType;
        return {
          answers: { [ENV_QUESTION_ID]: { type: 'choice', value: 'copy', probabilities: { copy: 0.9 } } },
          meta: { latencyMs: 1, source: 'stub' },
          usage: { inputTokens: 1, outputTokens: 0 },
          raw: {},
        };
      },
    };
    await classifyEnvType({ goal: '写一段文案', registry: fullRegistry(), decision: spy });
    assert.equal(seenEnvType, undefined);
  });

  it('候选唯一时不提问——问一个只有一个选项的问题没有意义', async () => {
    // 造一个只服务 copy 的最小注册表。
    //
    // 不能拿内置工具来凑：`draft-copy` 声明的是 `envTypes: ['copy', 'frontend']`，
    // 于是 frontend 也会被算成"有主产出工具"——候选就不止一个了。
    const onlyCopy = new ToolRegistry().register(
      {
        id: 'only-copy',
        label: '只做文案',
        description: '测试用的最小主产出工具',
        envTypes: ['copy'],
        role: 'generate',
        category: 'copy',
        inputs: [{ name: 'goal', type: 'text', required: true, description: '目标' }],
        outputs: [{ name: 'text', type: 'text', required: true, description: '正文' }],
        costHint: 'fast',
      },
      async () => ({ outputs: { text: 'x' }, artifacts: [], summary: 'x' }),
    );
    assert.deepEqual(candidateEnvs(onlyCopy), ['copy'], '这个池子应当只有一个候选');

    let called = 0;
    const spy: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: true, detail: 'spy' }),
      decide: async () => {
        called += 1;
        throw new Error('不该被调用');
      },
    };
    const result = await classifyEnvType({ goal: '写文案', registry: onlyCopy, decision: spy });
    assert.equal(called, 0);
    assert.equal(result.envType, 'copy');
    assert.equal(result.calls, 0);
    assert.match(result.rationale, /无需决策/);
  });
});

describe('目标分类：判断不出来时链路照样跑', () => {
  it('决策层不可达 → 回落到 copy，并说明原因', async () => {
    const down: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: false, detail: 'down' }),
      decide: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const result = await classifyEnvType({ goal: '做一套产品图', registry: fullRegistry(), decision: down });
    assert.equal(result.envType, 'copy');
    assert.equal(result.source, 'fallback');
    assert.match(result.rationale, /不可达/);
    assert.match(result.rationale, /ECONNREFUSED/);
  });

  it('弃权且没有概率分布 → 回落，而不是抛错', async () => {
    // 分类是第一步，它抛错等于整个目标做不了——回落到改动前的默认行为，
    // 最坏情况不比从前差。
    const decision = new StubDecisionClient().onAbstain(ENV_QUESTION_ID, 'choice');
    const result = await classifyEnvType({ goal: 'g', registry: fullRegistry(), decision });
    assert.equal(result.envType, 'copy');
    assert.equal(result.source, 'fallback');
    assert.match(result.rationale, /弃权/);
    assert.equal(result.calls, 1);
  });

  it('弃权但带概率分布 → 按概率取最大', async () => {
    let called = 0;
    const spy: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: true, detail: 'spy' }),
      decide: async () => {
        called += 1;
        return {
          answers: {
            [ENV_QUESTION_ID]: {
              type: 'choice',
              value: null,
              probabilities: { frontend: 0.2, image: 0.7, copy: 0.1 },
            },
          },
          meta: { latencyMs: 1, source: 'stub' },
          usage: { inputTokens: 1, outputTokens: 0 },
          raw: {},
        };
      },
    };
    const result = await classifyEnvType({ goal: 'g', registry: fullRegistry(), decision: spy });
    assert.equal(called, 1);
    assert.equal(result.envType, 'image');
    assert.equal(result.source, 'decision');
    assert.match(result.rationale, /弃权/);
  });

  it('决策层选了候选外的值 → 不采信，按概率回落并留痕', async () => {
    const decision = new StubDecisionClient().onChoice(ENV_QUESTION_ID, 'no-such-env', {
      'no-such-env': 0.1,
      copy: 0.8,
    });
    const result = await classifyEnvType({ goal: 'g', registry: fullRegistry(), decision });
    assert.equal(result.envType, 'copy');
    assert.match(result.rationale, /候选外/);
  });

  it('注册表里一个主产出工具都没有 → 回落并说明配置有问题', async () => {
    const empty = new ToolRegistry();
    const decision = new StubDecisionClient().onChoice(ENV_QUESTION_ID, 'copy');
    const result = await classifyEnvType({ goal: 'g', registry: empty, decision });
    assert.equal(result.envType, 'copy');
    assert.equal(result.source, 'fallback');
    assert.match(result.rationale, /没有任何环境/);
  });

  it('回落目标可以指定', async () => {
    const down: DecisionClient = {
      kind: 'stub',
      health: async () => ({ ok: false, detail: 'down' }),
      decide: async () => {
        throw new Error('boom');
      },
    };
    const result = await classifyEnvType({
      goal: 'g',
      registry: fullRegistry(),
      decision: down,
      fallbackEnv: 'frontend',
    });
    assert.equal(result.envType, 'frontend');
  });
});
