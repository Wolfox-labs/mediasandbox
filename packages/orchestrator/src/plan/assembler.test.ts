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
