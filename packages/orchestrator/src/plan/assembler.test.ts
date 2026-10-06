import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import { StubDecisionClient } from '../decision/stub-client.js';
import { PlanAssembler } from './assembler.js';
import { PlanError, planLayers, topologicalOrder, validatePlan, type ExecutionPlan } from './types.js';
import type { DecisionContext } from '../decision/types.js';

const CONTEXT: DecisionContext = {
  goal: '做一个产品介绍网页',
  envType: 'frontend',
};

function makeRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll(BUILTIN_TOOLS);
}

function makeAssembler(client: StubDecisionClient): PlanAssembler {
  return new PlanAssembler(makeRegistry(), client);
}

describe('DAG 静态校验', () => {
  it('拒绝空计划', () => {
    assert.throws(
      () => validatePlan({ envType: 'copy', nodes: [], rationale: [], createdAt: 0 }),
      (e: unknown) => e instanceof PlanError && e.code === 'EMPTY_PLAN',
    );
  });

  it('拒绝悬空依赖', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        {
          id: 'a',
          toolId: 'write-file',
          inputs: {},
          dependsOn: ['ghost'],
          retryable: false,
          note: '',
        },
      ],
    };
    assert.throws(
      () => validatePlan(plan),
      (e: unknown) => e instanceof PlanError && e.code === 'DANGLING_DEPENDENCY',
    );
  });

  it('拒绝自依赖', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        { id: 'a', toolId: 'write-file', inputs: {}, dependsOn: ['a'], retryable: false, note: '' },
      ],
    };
    assert.throws(
      () => validatePlan(plan),
      (e: unknown) => e instanceof PlanError && (e.code === 'CYCLE' || e.code === 'DANGLING_DEPENDENCY'),
    );
  });

  it('拒绝成环', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        { id: 'a', toolId: 'write-file', inputs: {}, dependsOn: ['b'], retryable: false, note: '' },
        { id: 'b', toolId: 'write-file', inputs: {}, dependsOn: ['a'], retryable: false, note: '' },
      ],
    };
    assert.throws(
      () => validatePlan(plan),
      (e: unknown) => e instanceof PlanError && e.code === 'CYCLE',
    );
  });

  it('拒绝引用上游但未声明依赖', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        { id: 'a', toolId: 'write-file', inputs: {}, dependsOn: [], retryable: false, note: '' },
        {
          id: 'b',
          toolId: 'refine-copy',
          inputs: { text: { kind: 'ref', nodeId: 'a', port: 'text' } },
          dependsOn: [], // 漏了
          retryable: false,
          note: '',
        },
      ],
    };
    assert.throws(
      () => validatePlan(plan),
      (e: unknown) => e instanceof PlanError && e.code === 'DANGLING_DEPENDENCY',
    );
  });

  it('拓扑排序对同层节点保持声明顺序（确定性）', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        { id: 'z', toolId: 'write-file', inputs: {}, dependsOn: [], retryable: false, note: '' },
        { id: 'a', toolId: 'write-file', inputs: {}, dependsOn: [], retryable: false, note: '' },
        {
          id: 'm',
          toolId: 'write-file',
          inputs: {},
          dependsOn: ['z', 'a'],
          retryable: false,
          note: '',
        },
      ],
    };
    assert.deepEqual(topologicalOrder(plan), ['z', 'a', 'm']);
  });

  it('planLayers 把无依赖的节点放进同一层', () => {
    const plan: ExecutionPlan = {
      envType: 'copy',
      rationale: [],
      createdAt: 0,
      nodes: [
        { id: 'a', toolId: 'write-file', inputs: {}, dependsOn: [], retryable: false, note: '' },
        { id: 'b', toolId: 'write-file', inputs: {}, dependsOn: [], retryable: false, note: '' },
        { id: 'c', toolId: 'write-file', inputs: {}, dependsOn: ['a', 'b'], retryable: false, note: '' },
      ],
    };
    assert.deepEqual(planLayers(plan), [['a', 'b'], ['c']]);
  });
});

describe('PlanAssembler', () => {
  it('文案环境：产出 → 打磨 → 收尾 → 校验，链路完整', async () => {
    const client = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onNoul('needs_refine', true)
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', true);

    const assembler = makeAssembler(client);
    const { plan } = await assembler.assemble({
      context: { ...CONTEXT, envType: 'copy' },
      envType: 'copy',
      goal: '写一段产品介绍',
    });

    const toolIds = plan.nodes.map((n) => n.toolId);
    assert.deepEqual(toolIds, ['draft-copy', 'refine-copy', 'write-file', 'verify-artifact']);

    // 依赖链必须是串起来的，不能出现孤立节点。
    assert.deepEqual(plan.nodes[0]!.dependsOn, []);
    assert.deepEqual(plan.nodes[1]!.dependsOn, [plan.nodes[0]!.id]);
    assert.deepEqual(plan.nodes[3]!.dependsOn, [plan.nodes[2]!.id]);

    // 打磨节点的 text 入参必须指向上游产出。
    const refineInput = plan.nodes[1]!.inputs['text'];
    assert.equal(refineInput?.kind, 'ref');
    if (refineInput?.kind === 'ref') {
      assert.equal(refineInput.nodeId, plan.nodes[0]!.id);
    }

    // 计划本身必须通过静态校验。
    validatePlan(plan);
    assert.ok(plan.rationale.length > 0, '应记录组装依据');
  });

  it('相同决策答案得到完全相同的计划（确定性）', async () => {
    const build = async () => {
      const client = new StubDecisionClient()
        .onChoice('primary_tool', 'scaffold-frontend')
        .onChoice('finalize', 'build-frontend')
        .onNoul('needs_verify', true);
      return await makeAssembler(client).assemble({
        context: CONTEXT,
        envType: 'frontend',
        goal: '做一个落地页',
      });
    };

    const first = await build();
    const second = await build();
    // createdAt 会不同，比较结构本身。
    assert.equal(
      JSON.stringify(first.plan.nodes),
      JSON.stringify(second.plan.nodes),
      '同样答案必须得到同样节点与依赖',
    );
    assert.deepEqual(first.plan.rationale, second.plan.rationale);
  });

  it('决策层弃权时回落到确定性默认，而不是失败', async () => {
    const client = new StubDecisionClient()
      .onAbstain('primary_tool', 'choice')
      .onAbstain('needs_verify', 'noul')
      .onAbstain('finalize', 'choice');

    const { plan } = await makeAssembler(client).assemble({
      context: { ...CONTEXT, envType: 'copy' },
      envType: 'copy',
      goal: '写点什么',
    });

    assert.ok(plan.nodes.length > 0, '弃权不应导致空计划');
    validatePlan(plan);
    assert.ok(
      plan.rationale.some((r) => r.includes('弃权')),
      '应在依据里标明发生了回落',
    );
  });

  it('决策层选了候选集外的工具时抛 ENV_MISMATCH', async () => {
    const registry = new ToolRegistry();
    const mkSpec = (id: string, env: 'copy' | 'image') => ({
      id,
      label: id,
      description: `${id} 工具`,
      envTypes: [env] as ('copy' | 'image')[],
      role: 'generate' as const,
      category: 'x',
      inputs: [{ name: 'goal', type: 'text' as const, required: true, description: '目标' }],
      outputs: [{ name: 'text', type: 'text' as const, required: true, description: '文本' }],
    });
    const ok = async () => ({ outputs: { text: 'x' }, artifacts: [], summary: 'x' });
    // copy 环境下有 2 个合法候选，使决策真的会发起。
    registry.register(mkSpec('copy-a', 'copy'), ok);
    registry.register(mkSpec('copy-b', 'copy'), ok);
    // image-only 不在 copy 候选集里，但桩会照答不误——组装器必须识别出越界。
    registry.register(mkSpec('image-only', 'image'), ok);

    const client = new StubDecisionClient().onChoice('primary_tool', 'image-only');
    const assembler = new PlanAssembler(registry, client);
    await assert.rejects(
      () => assembler.assemble({ context: CONTEXT, envType: 'copy', goal: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof PlanError, `应抛 PlanError，实际 ${String(error)}`);
        assert.equal(error.code, 'ENV_MISMATCH');
        return true;
      },
    );
  });

  it('候选唯一时不必问模型，直接采用并记录依据', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        id: 'only-one',
        label: '唯一',
        description: '唯一工具',
        envTypes: ['copy'],
        role: 'generate',
        category: 'x',
        inputs: [{ name: 'goal', type: 'text', required: true, description: '目标' }],
        outputs: [{ name: 'text', type: 'text', required: true, description: '文本' }],
      },
      async () => ({ outputs: { text: 'x' }, artifacts: [], summary: 'x' }),
    );
    const { plan } = await new PlanAssembler(registry, new StubDecisionClient()).assemble({
      context: CONTEXT,
      envType: 'copy',
      goal: 'x',
    });
    assert.equal(plan.nodes[0]!.toolId, 'only-one');
    assert.ok(
      plan.rationale.some((r) => r.includes('唯一候选')),
      '唯一候选应在依据里说明未做决策',
    );
  });

  it('完全没有主产出工具时拒绝组装', async () => {
    const assembler = new PlanAssembler(new ToolRegistry(), new StubDecisionClient());
    await assert.rejects(
      () => assembler.assemble({ context: CONTEXT, envType: 'copy', goal: 'x' }),
      /没有任何可作为主产出的工具/,
    );
  });

  it('三类环境都能组装出通过校验的计划', async () => {
    for (const envType of ['frontend', 'image', 'copy'] as const) {
      const client = new StubDecisionClient()
        .onNoul('needs_refine', false)
        .onNoul('needs_verify', true);
      const { plan } = await makeAssembler(client).assemble({
        context: { goal: '做一个作品', envType },
        envType,
        goal: '做一个作品',
        minArtifacts: 1,
      });
      validatePlan(plan);
      assert.equal(plan.envType, envType);
      assert.ok(plan.nodes.length >= 1);
      // 每个节点引用的工具都必须真实注册过。
      const registry = makeRegistry();
      for (const node of plan.nodes) {
        assert.ok(registry.has(node.toolId), `节点引用了未注册工具 ${node.toolId}`);
      }
    }
  });

  it('不需要校验时计划里不出现 verify-artifact', async () => {
    const client = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onNoul('needs_refine', false)
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', false);

    const { plan } = await makeAssembler(client).assemble({
      context: { ...CONTEXT, envType: 'copy' },
      envType: 'copy',
      goal: '写一段话',
    });

    assert.ok(
      !plan.nodes.some((n) => n.toolId === 'verify-artifact'),
      '决策层说不校验时不应插入校验节点',
    );
  });

  it('保留决策层原始答案用于存证', async () => {
    const client = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', true);

    const { answers, decisionLatencyMs } = await makeAssembler(client).assemble({
      context: { ...CONTEXT, envType: 'copy' },
      envType: 'copy',
      goal: 'x',
    });

    assert.ok('primary_tool' in answers);
    assert.equal(typeof decisionLatencyMs, 'number');
  });
});

/**
 * 回归测试：端口引用必须指向上游**真实声明**的产出。
 *
 * 背景——这是一个真实缺陷，此前 183 项测试全绿却没发现它：
 * `buildFinalizeInputs` 把上游产出统一接成 `port: 'text'`，但
 *   - `render-image` / `solid-image` 产出 `prompt, file`
 *   - `static-page-from-template` / `scaffold-frontend` 产出 `html, file`
 * 三者都没有 `text` 端口，于是 frontend 环境下 3 个主产出候选配上收尾或打磨就必挂。
 *
 * 之所以漏掉：候选集是**笛卡尔积**，而原有测试只覆盖了少数几条对角线——
 * 唯二用 html 类工具当主产出的用例都没预设 `needs_refine`，桩默认返回 false，
 * 打磨节点从未被插入。
 *
 * 下面这个用例**穷举整个笛卡尔积**，任何一条组合出现非法端口引用都会失败。
 */
describe('端口引用回归：穷举 envType × 主产出 × 打磨 × 收尾', () => {
  const FINALIZE_CHOICES = ['write-file', 'build-frontend', 'process-image'] as const;

  it('所有可组装组合都不出现非法端口引用', async () => {
    const registry = makeRegistry();
    let combinations = 0;

    for (const envType of ['copy', 'image', 'frontend'] as const) {
      const primaries = registry
        .filter({ envType, role: 'generate' })
        .map((spec) => spec.id);
      assert.ok(primaries.length > 0, `${envType} 环境应有主产出候选`);

      for (const primary of primaries) {
        for (const needsRefine of [false, true]) {
          for (const finalize of FINALIZE_CHOICES) {
            combinations += 1;
            const client = new StubDecisionClient()
              .onChoice('primary_tool', primary)
              .onNoul('needs_refine', needsRefine)
              .onNoul('needs_verify', true)
              .onChoice('finalize', finalize);

            const { plan } = await new PlanAssembler(registry, client).assemble({
              context: { goal: '回归用例', envType },
              envType,
              goal: '回归用例',
              minArtifacts: 1,
            });

            // 组装器自己会带上 registry 校验一遍，这里再独立验一次：
            // 逐个 ref 入参去查上游工具的 outputs 声明。
            for (const node of plan.nodes) {
              for (const [portName, input] of Object.entries(node.inputs)) {
                if (input.kind !== 'ref') continue;
                const upstream = plan.nodes.find((n) => n.id === input.nodeId);
                assert.ok(upstream !== undefined, `${node.id} 引用了不存在的节点`);
                const upstreamOutputs = registry
                  .getSpec(upstream.toolId)
                  .outputs.map((p) => p.name);
                assert.ok(
                  upstreamOutputs.includes(input.port),
                  `${envType} / 主产出=${primary} / 打磨=${needsRefine} / 收尾=${finalize}：` +
                    `${node.id} 的入参 ${portName} 引用了 ${input.nodeId} 的端口 ${input.port}，` +
                    `但 ${upstream.toolId} 只产出 [${upstreamOutputs.join(', ')}]`,
                );
              }
            }
          }
        }
      }
    }

    assert.ok(combinations >= 40, `应覆盖足够多的组合，实际 ${combinations}`);
  });

  it('上游没有文案产出时，不插入 refine-copy（而不是插一个必挂的）', async () => {
    const registry = makeRegistry();
    // 模板路线产出 html/file，没有可打磨的 text。
    const client = new StubDecisionClient()
      .onChoice('primary_tool', 'static-page-from-template')
      .onNoul('needs_refine', true)
      .onNoul('needs_verify', false)
      .onChoice('finalize', 'build-frontend');

    const { plan } = await new PlanAssembler(registry, client).assemble({
      context: { ...CONTEXT },
      envType: 'frontend',
      goal: 'x',
    });

    assert.ok(
      !plan.nodes.some((n) => n.toolId === 'refine-copy'),
      '上游无 text 产出时不应插入 refine-copy',
    );
    assert.ok(
      plan.rationale.some((r) => r.includes('跳过 refine-copy')),
      '跳过打磨必须在 rationale 里留下依据',
    );
    validatePlan(plan, registry);
  });

  it('上游产出 html 时，收尾节点连的是 html 端口而不是 text', async () => {
    const registry = makeRegistry();
    const client = new StubDecisionClient()
      .onChoice('primary_tool', 'static-page-from-template')
      .onNoul('needs_refine', false)
      .onNoul('needs_verify', false)
      .onChoice('finalize', 'write-file');

    const { plan } = await new PlanAssembler(registry, client).assemble({
      context: { ...CONTEXT },
      envType: 'frontend',
      goal: 'x',
    });

    const sink = plan.nodes.find((n) => n.toolId === 'write-file');
    assert.ok(sink !== undefined, '应插入 write-file 收尾节点');
    const content = sink.inputs['content'];
    assert.equal(content?.kind, 'ref');
    if (content?.kind === 'ref') {
      assert.equal(content.port, 'html', '应连上游真实存在的 html 端口');
    }
  });

  it('validatePlan 带上 registry 后，非法端口在执行前就被拒绝', () => {
    const registry = makeRegistry();
    const plan: ExecutionPlan = {
      envType: 'frontend',
      rationale: [],
      createdAt: 0,
      nodes: [
        {
          id: 'a',
          toolId: 'static-page-from-template',
          inputs: { goal: { kind: 'literal', value: 'x' } },
          dependsOn: [],
          retryable: true,
          note: '',
        },
        {
          id: 'b',
          toolId: 'write-file',
          inputs: {
            path: { kind: 'literal', value: 'artifacts/x.md' },
            // static-page-from-template 产出 html/file，没有 text
            content: { kind: 'ref', nodeId: 'a', port: 'text' },
          },
          dependsOn: ['a'],
          retryable: false,
          note: '',
        },
      ],
    };

    // 纯结构校验查不出端口不存在——这正是缺陷能溜到执行期的原因。
    validatePlan(plan);

    // 带上 registry 就能查出来。
    assert.throws(
      () => validatePlan(plan, registry),
      (e: unknown) => e instanceof PlanError && e.code === 'BAD_PORT_REF',
    );
  });
});

