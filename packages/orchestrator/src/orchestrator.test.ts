import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalSandbox } from '@mediasandbox/sandbox';
import { ToolRegistry } from './tools/registry.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import type { ToolExecutor, ToolSpec } from './tools/types.js';
import { StubDecisionClient } from './decision/stub-client.js';
import { MockLlmClient } from './testing/mock-llm.js';
import { Orchestrator, type OrchestrationEvent } from './orchestrator.js';
import { DEFAULT_POLICY } from './fallback/state-machine.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-e2e-${process.pid}`);
const sandbox = new LocalSandbox({ rootDir });
const created: string[] = [];

/** 跑完后记录句柄，便于统一清理。 */
function keep(projectId: string): string {
  created.push(projectId);
  return projectId;
}

after(async () => {
  // LocalSandbox 的 id 带随机后缀，这里按已知前缀逐个尝试销毁。
  for (const projectId of created) {
    for (const envType of ['copy', 'frontend', 'image'] as const) {
      const found = await sandbox
        .adopt(`${projectId}-${envType}`, projectId, envType)
        .catch(() => undefined);
      if (found !== undefined) await sandbox.destroy(found);
    }
  }
});

function registry(): ToolRegistry {
  return new ToolRegistry().registerAll(BUILTIN_TOOLS);
}

/** 不含退避等待的策略，让测试跑得快。 */
const FAST_POLICY = { ...DEFAULT_POLICY, backoffBaseMs: 0, backoffCapMs: 0 };

describe('编排端到端', () => {
  it('文案环境：目标 → 决策 → 组装 → 执行 → 产物落盘', async () => {
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onNoul('needs_refine', false)
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', true);
    const llm = new MockLlmClient({ defaultText: '这是一段产品介绍文案。' });

    const result = await new Orchestrator().run(
      {
        projectId: keep(`e2e${process.pid}a`),
        goal: '写一段产品介绍',
        envType: 'copy',
        minArtifacts: 1,
      },
      { registry: registry(), decision, sandbox, llm, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded', result.reason ?? '');
    assert.ok(result.plan !== undefined, '应产出计划');
    assert.ok(result.execution !== undefined, '应产出执行结果');
    assert.ok(result.execution.artifacts.length >= 1, '应至少有一个产物');

    // 真的落到了磁盘上。
    const text = new TextDecoder().decode(await sandbox.readFile(result.handle, 'artifacts/copy.md'));
    assert.match(text, /这是一段产品介绍文案/);
  });

  it('前端环境：模板路线不调用生成层也能完成', async () => {
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'static-page-from-template')
      .onChoice('finalize', 'build-frontend')
      .onNoul('needs_verify', true);
    const llm = new MockLlmClient();

    const result = await new Orchestrator().run(
      {
        projectId: keep(`e2e${process.pid}b`),
        goal: '做一个产品落地页',
        envType: 'frontend',
        minArtifacts: 1,
      },
      { registry: registry(), decision, sandbox, llm, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded', JSON.stringify(result.attempts));
    assert.equal(llm.calls.length, 0, '模板路线不该调用生成层');

    const html = new TextDecoder().decode(await sandbox.readFile(result.handle, 'artifacts/index.html'));
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /做一个产品落地页/);
  });

  it('图像环境：模板路线产出真实 PNG 文件', async (t) => {
    // 该工具依赖可用的 python。本机 `python` 可能指向 WindowsApps 的存根
    // （转跳 Microsoft Store 的空壳），此时工具压根跑不起来。
    // 这不是代码缺陷而是环境缺失——检出后跳过，不假装通过。
    const probeHandle = await sandbox.create(`e2e${process.pid}probe`, 'image');
    const probe = await sandbox
      .exec(probeHandle, 'python -c "print(1)"', { timeoutMs: 15_000 })
      .catch(() => undefined);
    await sandbox.destroy(probeHandle);
    if (probe === undefined || probe.exitCode !== 0) {
      t.skip('本机 python 不可用（WindowsApps 存根），跳过');
      return;
    }

    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'solid-image')
      .onNoul('needs_verify', true);
    const llm = new MockLlmClient();

    const result = await new Orchestrator().run(
      {
        projectId: keep(`e2e${process.pid}c`),
        goal: '生成一张占位图',
        envType: 'image',
        minArtifacts: 1,
      },
      { registry: registry(), decision, sandbox, llm, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded', JSON.stringify(result.attempts));

    const bytes = await sandbox.readFile(result.handle, 'artifacts/image.png');
    // PNG 魔数：89 50 4E 47
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], '应是真实 PNG');
  });

  it('依赖 python 的工具失败时，兜底换方案而不是整条链路崩掉', async () => {
    // 无论 python 是否可用，这条都成立：
    //   - 可用   → solid-image 直接成功
    //   - 不可用 → 失败后换方案，改用不依赖 python 的 render-image
    // 两种情况都不应抛异常给调用方。
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'solid-image')
      .onNoul('needs_verify', false);
    const llm = new MockLlmClient({ defaultText: 'data:image/png;base64,iVBORw0KGgo=' });

    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}cp`), goal: '图像兜底', envType: 'image' },
      {
        registry: registry(),
        decision,
        sandbox,
        llm,
        policy: { ...FAST_POLICY, maxRetries: 1, maxSwitches: 1 },
      },
    );

    assert.ok(
      result.status === 'succeeded' || result.status === 'escalated',
      `不应抛异常，实际 ${result.status}`,
    );
    assert.ok(result.plan !== undefined, '应保留最终计划');
  });

  it('主工具失败后换方案：排除失败工具，改用另一个', async () => {
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onNoul('needs_refine', false)
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', false);

    // 不传 llm → draft-copy 会失败；换方案后应选到不需要生成层的 template-copy。
    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}d`), goal: '写一段介绍', envType: 'copy' },
      {
        registry: registry(),
        decision,
        sandbox,
        policy: { ...FAST_POLICY, maxRetries: 1, maxSwitches: 1 },
      },
    );

    assert.ok(result.attempts.length >= 2, `应至少有两次尝试，实际 ${result.attempts.length}`);
    assert.ok(
      result.attempts.some((a) => a.status === 'failed'),
      '应有一次失败记录',
    );
    assert.equal(result.status, 'succeeded', JSON.stringify(result.attempts, null, 2));
    assert.ok(
      result.plan!.nodes.some((n) => n.toolId === 'template-copy'),
      '换方案后应改用模板工具',
    );
  });

  it('始终失败时最终熔断转人工，并带出原因', async () => {
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'draft-copy')
      .onNoul('needs_refine', false)
      .onNoul('needs_verify', false);

    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}e`), goal: '无法完成的目标', envType: 'copy' },
      {
        registry: registry(),
        decision,
        sandbox,
        policy: { ...FAST_POLICY, maxRetries: 2, maxSwitches: 0 },
      },
    );

    assert.equal(result.status, 'escalated');
    assert.ok(result.reason !== undefined && result.reason.length > 0, '应给出原因');
    assert.match(result.reason!, /转人工|上限/);
    assert.ok(result.attempts.length >= 2, '应记录多次尝试');
  });

  it('决策层弃权时按确定性默认继续，不报错', async () => {
    const decision = new StubDecisionClient()
      .onAbstain('primary_tool', 'choice')
      .onAbstain('needs_verify', 'noul')
      .onAbstain('finalize', 'choice');
    // 必须提供生成层：否则 draft-copy 失败会触发换方案，
    // 候选被排除到只剩一个后走"无需决策"路径，就看不到弃权记录了。
    const llm = new MockLlmClient({ defaultText: '弃权回落路径产出的文案。' });

    const result = await new Orchestrator().run(
      {
        projectId: keep(`e2e${process.pid}f`),
        goal: '写点东西',
        envType: 'copy',
        minArtifacts: 1,
      },
      { registry: registry(), decision, sandbox, llm, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded', JSON.stringify(result.attempts));
    assert.ok(
      result.plan!.rationale.some((r) => r.includes('弃权')),
      `应记录弃权回落，实际依据: ${result.plan!.rationale.join(' | ')}`,
    );
  });

  it('发出完整的编排事件序列', async () => {
    const events: OrchestrationEvent[] = [];
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'template-copy')
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', false);

    await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}g`), goal: '事件测试', envType: 'copy' },
      {
        registry: registry(),
        decision,
        sandbox,
        policy: FAST_POLICY,
        onEvent: (e) => events.push(e),
      },
    );

    const types = events.map((e) => e.type);
    for (const expected of [
      'run_started',
      'attempt_started',
      'plan_assembled',
      'execution_event',
      'run_finished',
    ]) {
      assert.ok(types.includes(expected as OrchestrationEvent['type']), `缺少事件 ${expected}`);
    }

    const finished = events.find((e) => e.type === 'run_finished');
    assert.equal(finished?.type === 'run_finished' ? finished.status : '', 'succeeded');

    const assembled = events.find((e) => e.type === 'plan_assembled');
    if (assembled?.type === 'plan_assembled') {
      assert.ok(assembled.plan.nodes.length > 0);
    }
  });

  it('取消信号生效，不会跑完整条链路', async () => {
    const controller = new AbortController();
    controller.abort(); // 一开始就取消
    const decision = new StubDecisionClient().onChoice('primary_tool', 'template-copy');

    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}h`), goal: '取消测试', envType: 'copy' },
      {
        registry: registry(),
        decision,
        sandbox,
        policy: FAST_POLICY,
        signal: controller.signal,
      },
    );

    assert.equal(result.status, 'failed');
    assert.match(result.reason ?? '', /取消/);
  });

  it('没有可用工具时熔断，而不是抛异常给调用方', async () => {
    const empty = new ToolRegistry();
    const decision = new StubDecisionClient();

    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}i`), goal: '无工具可用', envType: 'copy' },
      { registry: empty, decision, sandbox, policy: { ...FAST_POLICY, maxSwitches: 0 } },
    );

    assert.equal(result.status, 'escalated');
    assert.match(result.reason ?? '', /没有任何可作为主产出的工具/);
  });

  it('自定义工具能接入编排并被决策层选中', async () => {
    // 验证"扩展工具链 = 改注册表，不重训模型"这个设计承诺。
    const custom: ToolSpec = {
      id: 'my-custom-tool',
      label: '自定义工具',
      description: '验证注册表可扩展',
      envTypes: ['copy'],
      role: 'generate',
      category: 'custom',
      inputs: [{ name: 'goal', type: 'text', required: true, description: '目标' }],
      outputs: [{ name: 'text', type: 'text', required: true, description: '文本' }],
    };
    const execute: ToolExecutor = async (rt) => {
      await rt.sandbox.writeFile(
        rt.handle,
        'artifacts/custom.txt',
        `custom:${String(rt.inputs['goal'])}`,
      );
      return { outputs: { text: 'custom' }, artifacts: [], summary: '自定义工具完成' };
    };

    const reg = registry();
    reg.register(custom, execute);

    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'my-custom-tool')
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', false);

    const result = await new Orchestrator().run(
      { projectId: keep(`e2e${process.pid}j`), goal: '走自定义路径', envType: 'copy' },
      { registry: reg, decision, sandbox, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded', JSON.stringify(result.attempts));
    const text = new TextDecoder().decode(await sandbox.readFile(result.handle, 'artifacts/custom.txt'));
    assert.equal(text, 'custom:走自定义路径');
  });

  it('相同输入两次运行得到相同的计划结构（可复现）', async () => {
    const build = async (suffix: string) => {
      const decision = new StubDecisionClient()
        .onChoice('primary_tool', 'template-copy')
        .onChoice('finalize', 'write-file')
        .onNoul('needs_verify', true);
      return await new Orchestrator().run(
        { projectId: keep(`e2e${process.pid}${suffix}`), goal: '可复现测试', envType: 'copy' },
        { registry: registry(), decision, sandbox, policy: FAST_POLICY },
      );
    };

    const first = await build('k');
    const second = await build('l');
    assert.equal(
      JSON.stringify(first.plan!.nodes.map((n) => [n.toolId, n.dependsOn])),
      JSON.stringify(second.plan!.nodes.map((n) => [n.toolId, n.dependsOn])),
      '相同输入应得到相同的工具顺序与依赖',
    );
  });

  it('产物收集包含全部节点产出，且路径唯一', async () => {
    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'template-copy')
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', true);

    const result = await new Orchestrator().run(
      {
        projectId: keep(`e2e${process.pid}m`),
        goal: '产物去重',
        envType: 'copy',
        minArtifacts: 1,
      },
      { registry: registry(), decision, sandbox, policy: FAST_POLICY },
    );

    assert.equal(result.status, 'succeeded');
    const paths = result.execution!.artifacts.map((a) => a.path);
    assert.equal(new Set(paths).size, paths.length, '产物路径应唯一');
  });
});
