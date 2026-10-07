import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalSandbox } from '@mediasandbox/sandbox';
import { ToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import type { ToolExecutor, ToolSpec } from '../tools/types.js';
import { ToolError } from '../tools/types.js';
import { MockLlmClient } from '../testing/mock-llm.js';
import { PlanExecutor } from './executor.js';
import type { ExecutionEvent } from './executor.js';
import type { ExecutionPlan, PlanNode } from './types.js';
import { PlanError } from './types.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-exec-test-${process.pid}`);
const sandbox = new LocalSandbox({ rootDir });
const handles: string[] = [];

async function makeHandle(envType: 'frontend' | 'image' | 'copy' = 'copy') {
  const handle = await sandbox.create(`exec${process.pid}${handles.length}`, envType);
  handles.push(handle.id);
  return handle;
}

after(async () => {
  for (const id of handles) {
    const handle = await sandbox.get(id);
    if (handle !== undefined) await sandbox.destroy(handle);
  }
});

/** 注册一个最小可控工具，避免测试依赖内置工具的具体实现。 */
function reg(
  registry: ToolRegistry,
  id: string,
  execute: ToolExecutor,
  overrides: Partial<ToolSpec> = {},
): ToolRegistry {
  registry.register(
    {
      id,
      label: id,
      description: `测试工具 ${id}`,
      envTypes: ['copy'],
      role: 'transform',
      category: 'test',
      inputs: [],
      outputs: [{ name: 'out', type: 'text', required: true, description: '产出' }],
      ...overrides,
    },
    execute,
  );
  return registry;
}

function node(id: string, toolId: string, extra: Partial<PlanNode> = {}): PlanNode {
  return { id, toolId, inputs: {}, dependsOn: [], retryable: false, note: '', ...extra };
}

function planOf(nodes: PlanNode[]): ExecutionPlan {
  return { envType: 'copy', nodes, rationale: [], createdAt: 0 };
}

describe('PlanExecutor', () => {
  it('按拓扑顺序执行，并把上游产出接到下游', async () => {
    const order: string[] = [];
    const registry = reg(new ToolRegistry(), 'first', async () => {
      order.push('first');
      return { outputs: { out: 'hello' }, artifacts: [], summary: '第一' };
    });
    reg(
      registry,
      'second',
      async (rt) => {
        order.push('second');
        return {
          outputs: { out: `${String(rt.inputs['in'])}-world` },
          artifacts: [],
          summary: `收到 ${String(rt.inputs['in'])}`,
        };
      },
      { inputs: [{ name: 'in', type: 'text', required: true, description: '上游' }] },
    );

    const handle = await makeHandle();
    const plan = planOf([
      node('a', 'first'),
      node('b', 'second', {
        inputs: { in: { kind: 'ref', nodeId: 'a', port: 'out' } },
        dependsOn: ['a'],
      }),
    ]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(order, ['first', 'second']);
    assert.deepEqual(result.evidence, ['第一', '收到 hello']);
  });

  it('同层节点并发执行', async () => {
    let running = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    for (const id of ['p1', 'p2', 'p3']) {
      reg(registry, id, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 60));
        running -= 1;
        return { outputs: { out: id }, artifacts: [], summary: id };
      });
    }

    const handle = await makeHandle();
    const plan = planOf(['p1', 'p2', 'p3'].map((id) => node(id, id)));

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      maxConcurrency: 4,
    });
    assert.equal(result.status, 'succeeded');
    assert.ok(peak >= 2, `应并发执行，实际峰值 ${peak}`);
  });

  it('并发度受限，不超过 maxConcurrency', async () => {
    let running = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    for (const id of ids) {
      reg(registry, id, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 50));
        running -= 1;
        return { outputs: { out: id }, artifacts: [], summary: id };
      });
    }

    const handle = await makeHandle();
    const plan = planOf(ids.map((id) => node(id, id)));

    await new PlanExecutor().execute({ plan, registry, sandbox, handle, maxConcurrency: 2 });
    assert.ok(peak <= 2, `并发峰值 ${peak} 不应超过上限 2`);
  });

  it('节点失败时其后继被跳过而非执行', async () => {
    const registry = reg(new ToolRegistry(), 'boom', async () => {
      throw new Error('故意失败');
    });
    reg(registry, 'after', async () => ({
      outputs: { out: 'x' },
      artifacts: [],
      summary: '不该跑',
    }));

    const handle = await makeHandle();
    const plan = planOf([node('a', 'boom'), node('b', 'after', { dependsOn: ['a'] })]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.equal(result.status, 'failed');
    assert.equal(result.states['a']?.status, 'failed');
    assert.equal(result.states['b']?.status, 'skipped');
    assert.match(result.states['a']?.error ?? '', /故意失败/);
  });

  /**
   * 回归：归类**不该靠正则猜错误消息**。
   *
   * 旧实现按前缀匹配（`/命令退出码/`、`/生成层调用失败/`…）。谁改一句措辞，
   * 分类就静默退化成 unknown，重试策略跟着错——而且结果里看不出来。
   *
   * 现在执行器把错误的**类型与错误码**结构化带出去，与本用例里那句
   * "毫无提示性的错误消息"无关。
   */
  it('失败结果带结构化 errorInfo，归类不依赖错误消息措辞', async () => {
    const registry = reg(new ToolRegistry(), 'boom', async () => {
      // 刻意用一句完全不含任何已知关键词的消息。
      throw new ToolError('zzz 无关键词 zzz', 'EXECUTION_FAILED', 'boom');
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'boom')]);
    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });

    const outcome = result.outcomes.find((o) => o.nodeId === 'a');
    assert.equal(outcome?.status, 'failed');
    assert.equal(outcome?.errorInfo?.kind, 'tool', '应按异常类型归类，而不是匹配消息');
    assert.equal(outcome?.errorInfo?.code, 'EXECUTION_FAILED');
    assert.equal(outcome?.errorInfo?.toolId, 'boom');
  });

  it('未注册工具的失败也带结构化 errorInfo（kind=plan）', async () => {
    const registry = new ToolRegistry();
    const handle = await makeHandle();
    const plan = planOf([node('a', 'ghost')]);
    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });

    const outcome = result.outcomes.find((o) => o.nodeId === 'a');
    assert.equal(outcome?.errorInfo?.code, 'UNKNOWN_TOOL');
  });

  it('retryable 节点按 maxRetries 重试，成功即停', async () => {
    let attempts = 0;
    const registry = reg(new ToolRegistry(), 'flaky', async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`第 ${attempts} 次失败`);
      return { outputs: { out: 'ok' }, artifacts: [], summary: `第 ${attempts} 次成功` };
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'flaky', { retryable: true })]);

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      maxRetries: 2,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(attempts, 3);
    assert.equal(result.states['a']?.attempts, 3);
  });

  it('retryable 为 false 的节点不重试', async () => {
    let attempts = 0;
    const registry = reg(new ToolRegistry(), 'no-retry', async () => {
      attempts += 1;
      throw new Error('失败');
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'no-retry')]);

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      maxRetries: 5,
    });
    assert.equal(result.status, 'failed');
    assert.equal(attempts, 1, 'retryable=false 时不应重试');
  });

  it('重试耗尽后置为 failed', async () => {
    let attempts = 0;
    const registry = reg(new ToolRegistry(), 'always-fail', async () => {
      attempts += 1;
      throw new Error('永远失败');
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'always-fail', { retryable: true })]);

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      maxRetries: 2,
    });
    assert.equal(result.status, 'failed');
    assert.equal(attempts, 3, '应为 1 次初始 + 2 次重试');
    assert.equal(result.states['a']?.attempts, 3);
  });

  it('工具超时被识别为失败', async () => {
    const registry = reg(new ToolRegistry(), 'slow', async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { outputs: { out: 'x' }, artifacts: [], summary: '不该到这里' };
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'slow')]);

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      nodeTimeoutMs: 300,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.states['a']?.error ?? '', /超时/);
  });

  it('发出完整的进度事件序列', async () => {
    const events: ExecutionEvent[] = [];
    const registry = reg(new ToolRegistry(), 'evt', async (rt) => {
      rt.log('内部日志', { k: 1 });
      return { outputs: { out: 'x' }, artifacts: [], summary: '完成' };
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'evt')]);

    await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      onEvent: (e) => events.push(e),
    });

    const types = events.map((e) => e.type);
    for (const expected of ['plan_started', 'node_started', 'node_log', 'node_succeeded', 'plan_finished']) {
      assert.ok(types.includes(expected as ExecutionEvent['type']), `缺少事件 ${expected}`);
    }

    const log = events.find((e) => e.type === 'node_log');
    assert.equal(log?.type === 'node_log' ? log.message : '', '内部日志');
  });

  it('进度回调抛错不影响执行结果', async () => {
    const registry = reg(new ToolRegistry(), 'ok', async () => ({
      outputs: { out: 'x' },
      artifacts: [],
      summary: 'ok',
    }));

    const handle = await makeHandle();
    const plan = planOf([node('a', 'ok')]);

    const result = await new PlanExecutor().execute({
      plan,
      registry,
      sandbox,
      handle,
      onEvent: () => {
        throw new Error('回调故意抛错');
      },
    });
    assert.equal(result.status, 'succeeded', '回调抛错不应影响执行');
  });

  it('产物按路径去重并排序', async () => {
    const registry = reg(new ToolRegistry(), 'w1', async (rt) => {
      await rt.sandbox.writeFile(rt.handle, 'artifacts/a.txt', 'a');
      return {
        outputs: { out: 'a' },
        artifacts: [{ path: 'artifacts/a.txt', size: 1, mimeHint: 'text/plain' }],
        summary: 'w1',
      };
    });
    reg(registry, 'w2', async (rt) => {
      await rt.sandbox.writeFile(rt.handle, 'artifacts/b.txt', 'b');
      return {
        outputs: { out: 'b' },
        artifacts: [
          { path: 'artifacts/b.txt', size: 1, mimeHint: 'text/plain' },
          // 与 w1 同样的路径，应被去重
          { path: 'artifacts/a.txt', size: 99, mimeHint: 'text/plain' },
        ],
        summary: 'w2',
      };
    });

    const handle = await makeHandle();
    const plan = planOf([node('a', 'w1'), node('b', 'w2')]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.deepEqual(
      result.artifacts.map((x) => x.path),
      ['artifacts/a.txt', 'artifacts/b.txt'],
    );
    assert.equal(result.artifacts[0]?.size, 1, '去重后应保留首次出现的记录');
  });

  it('执行前校验计划，坏计划直接拒绝', async () => {
    const handle = await makeHandle();
    const plan = planOf([node('a', 'nope', { dependsOn: ['ghost'] })]);

    await assert.rejects(
      () => new PlanExecutor().execute({ plan, registry: new ToolRegistry(), sandbox, handle }),
      /依赖不存在的节点/,
    );
  });

  it('引用不存在的产出端口时，在执行前就被拒绝', async () => {
    let executed = false;
    const registry = reg(new ToolRegistry(), 'src', async () => {
      executed = true;
      return { outputs: { out: 'x' }, artifacts: [], summary: 's' };
    });
    reg(registry, 'sink', async () => ({ outputs: { out: 'y' }, artifacts: [], summary: 'k' }), {
      inputs: [{ name: 'in', type: 'text', required: true, description: '上游' }],
    });

    const handle = await makeHandle();
    const plan = planOf([
      node('a', 'src'),
      node('b', 'sink', {
        // 引用了一个 src 并没有产出的端口名
        inputs: { in: { kind: 'ref', nodeId: 'a', port: 'nonexistent' } },
        dependsOn: ['a'],
      }),
    ]);

    // 这是**结构错误**，不是运行时意外：必须在任何节点跑起来之前拦下，
    // 否则前面节点已经写完文件、花完生成层的钱才发现引用错了。
    await assert.rejects(
      () => new PlanExecutor().execute({ plan, registry, sandbox, handle }),
      (error: unknown) =>
        error instanceof PlanError &&
        error.code === 'BAD_PORT_REF' &&
        /nonexistent/.test(error.message),
    );
    assert.equal(executed, false, '端口校验失败时不应执行任何节点');
  });

  it('用真实内置工具跑通文案链路，产物落到 artifacts/', async () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const handle = await makeHandle('copy');
    const llm = new MockLlmClient({ defaultText: '这是生成的产品介绍文案。' });

    const plan = planOf([
      node('n1-draft-copy', 'draft-copy', {
        inputs: {
          goal: { kind: 'literal', value: '介绍我们的沙盒系统' },
          tone: { kind: 'literal', value: '专业' },
        },
        retryable: true,
      }),
      node('n2-verify-artifact', 'verify-artifact', {
        inputs: { minFiles: { kind: 'literal', value: 1 } },
        dependsOn: ['n1-draft-copy'],
      }),
    ]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle, llm });
    assert.equal(result.status, 'succeeded', JSON.stringify(result.states, null, 2));
    assert.equal(llm.calls.length, 1, '应调用一次生成层');

    const text = new TextDecoder().decode(await sandbox.readFile(handle, 'artifacts/copy.md'));
    assert.match(text, /这是生成的产品介绍文案。/);
    assert.ok(result.artifacts.some((a) => a.path === 'artifacts/copy.md'));
  });

  it('确定性工具不调用生成层', async () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const handle = await makeHandle('copy');
    const llm = new MockLlmClient();

    const plan = planOf([
      node('n1-template-copy', 'template-copy', {
        inputs: {
          goal: { kind: 'literal', value: '标题' },
          points: { kind: 'literal', value: '要点一\n要点二' },
        },
      }),
    ]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle, llm });
    assert.equal(result.status, 'succeeded');
    assert.equal(llm.calls.length, 0, '模板工具不该调用生成层');
  });

  /**
   * 回归：模型不返回图像数据时，**不能**把它的文字回复当成图片落盘。
   *
   * 原实现是"否则落盘占位文本"，于是接一个纯文本模型时，模型回复
   * "我无法生成图像…"会被写成 `artifacts/image.png`——产物清单里出现一个
   * 后缀是 .png 但不是图片的文件，预览打不开、下载是乱码，且没有任何报错。
   */
  it('生成层未返回图像数据时明确失败，不产出伪装成图片的文本', async () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const handle = await makeHandle('image');
    // 模拟纯文本模型的回复：不含 data URL。
    const llm = new MockLlmClient({ defaultText: '我无法生成图像，但可以给你一段提示词…' });

    const plan = planOf([
      node('n1-render-image', 'render-image', {
        inputs: { prompt: { kind: 'literal', value: '科技感封面' } },
      }),
    ]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle, llm });
    assert.equal(result.status, 'failed');
    assert.match(result.states['n1-render-image']?.error ?? '', /未返回图像数据/);
    assert.equal(
      await sandbox.exists(handle, 'artifacts/image.png'),
      false,
      '失败时不该留下任何 .png 文件',
    );
  });

  it('生成层完全不可用时，确定性工具仍能完成任务', async () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const handle = await makeHandle('copy');
    const plan = planOf([
      node('n1-template-copy', 'template-copy', {
        inputs: { goal: { kind: 'literal', value: '降级路径' } },
      }),
    ]);

    // 不传 llm，模拟生成层不可用。
    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.equal(result.status, 'succeeded', '无生成层时确定性工具应仍可用');
  });

  it('生成式工具在缺少生成层时明确失败，而不是静默产出空文件', async () => {
    const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
    const handle = await makeHandle('copy');
    const plan = planOf([
      node('n1-draft-copy', 'draft-copy', {
        inputs: { goal: { kind: 'literal', value: 'x' } },
      }),
    ]);

    const result = await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.equal(result.status, 'failed');
    assert.match(result.states['n1-draft-copy']?.error ?? '', /未提供 LlmClient/);
  });
});
