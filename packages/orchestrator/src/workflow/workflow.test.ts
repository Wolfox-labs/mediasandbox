import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalSandbox } from '@mediasandbox/sandbox';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor, ToolSpec } from '../tools/types.js';
import { ToolError } from '../tools/types.js';
import type { NodeCache } from '../plan/cache.js';
import { cacheKeyFor, stableStringify } from '../plan/cache.js';
import { PlanExecutor } from '../plan/executor.js';
import { FileNodeCache } from './node-cache.js';
import { dependenciesOf, toPlan, type WorkflowDef } from './types.js';
import { deckWorkflow } from './presets.js';
import { validateWorkflow, WorkflowError } from './validate.js';
import { runWorkflow } from './runner.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-workflow-test-${process.pid}`);
const sandbox = new LocalSandbox({ rootDir });
const handles: string[] = [];

async function makeHandle() {
  const handle = await sandbox.create(`wf${process.pid}${handles.length}`, 'copy');
  handles.push(handle.id);
  return handle;
}

after(async () => {
  for (const id of handles) {
    const handle = await sandbox.get(id);
    if (handle !== undefined) await sandbox.destroy(handle);
  }
});

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

function def(nodes: WorkflowDef['nodes']): WorkflowDef {
  return { id: 'wf', name: '测试工作流', envType: 'copy', nodes };
}

describe('工作流预设', () => {
  it('演示文稿预设：每页一个填充节点，全部扇入组装', () => {
    const workflow = deckWorkflow({ goal: '路演', layouts: ['cover', 'bullets', 'closing'] });
    const fills = workflow.nodes.filter((node) => node.toolId === 'fill-slide');
    assert.equal(fills.length, 3);
    const assemble = workflow.nodes.find((node) => node.toolId === 'assemble-deck');
    assert.deepEqual(dependenciesOf(assemble!), ['fill-b1', 'fill-b2', 'fill-b3']);
    // 幻灯片环境没有 verify-artifact（它只支持 copy/image/frontend/webpage）。
    assert.ok(!workflow.nodes.some((node) => node.toolId === 'verify-artifact'));
  });

  it('演示文稿预设：截图节点带 HTML 指纹，且显式依赖组装', () => {
    const workflow = deckWorkflow({ goal: '路演', screenshot: true });
    const shot = workflow.nodes.find((node) => node.toolId === 'screenshot-deck');
    assert.deepEqual(shot?.inputs?.['html'], { from: 'assemble', port: 'html' });
    assert.deepEqual(shot?.dependsOn, ['assemble']);
  });
});

describe('工作流定义', () => {
  it('把 from 翻译成 ref / refs / literal，并按输入推导依赖', () => {
    const workflow = def([
      { id: 'a', toolId: 'echo', inputs: { seed: { value: 'hi' } } },
      { id: 'b', toolId: 'wrap', inputs: { in: { from: 'a', port: 'out' } } },
      {
        id: 'c',
        toolId: 'join',
        inputs: {
          parts: {
            from: [
              { nodeId: 'a', port: 'out' },
              { nodeId: 'b', port: 'out' },
            ],
          },
        },
      },
    ]);

    const plan = toPlan(workflow);
    const byId = new Map(plan.nodes.map((node) => [node.id, node]));
    assert.deepEqual(byId.get('b')?.inputs, {
      in: { kind: 'ref', nodeId: 'a', port: 'out' },
    });
    assert.equal(byId.get('c')?.inputs['parts']?.kind, 'refs');
    assert.deepEqual(dependenciesOf(workflow.nodes[2]!), ['a', 'b']);
    assert.deepEqual(byId.get('c')?.dependsOn, ['a', 'b']);
  });

  it('拒绝重复 id、未知工具、未知端口、缺必填、成环', () => {
    const registry = reg(new ToolRegistry(), 'echo', async () => ({
      outputs: { out: 'x' },
      artifacts: [],
      summary: 'echo',
    }), { inputs: [{ name: 'seed', type: 'text', required: true, description: '种子' }] });

    const duplicate = def([
      { id: 'a', toolId: 'echo', inputs: { seed: { value: '1' } } },
      { id: 'a', toolId: 'echo', inputs: { seed: { value: '2' } } },
    ]);
    assert.throws(() => validateWorkflow(duplicate, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'DUPLICATE_ID');

    const unknownTool = def([{ id: 'a', toolId: 'nope' }]);
    assert.throws(() => validateWorkflow(unknownTool, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'UNKNOWN_TOOL');

    const unknownPort = def([{ id: 'a', toolId: 'echo', inputs: { seed: { from: 'b', port: 'out' } } }]);
    assert.throws(() => validateWorkflow(unknownPort, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'DANGLING_DEPENDENCY');

    const missing = def([{ id: 'a', toolId: 'echo' }]);
    assert.throws(() => validateWorkflow(missing, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'MISSING_INPUT');

    const cycle = def([
      { id: 'a', toolId: 'echo', inputs: { seed: { from: 'b', port: 'out' } } },
      { id: 'b', toolId: 'echo', inputs: { seed: { from: 'a', port: 'out' } } },
    ]);
    assert.throws(() => validateWorkflow(cycle, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'CYCLE');
  });

  it('付费工具默认不放行，放行后才通过', () => {
    const registry = reg(
      new ToolRegistry(),
      'paid',
      async () => ({ outputs: { out: 'x' }, artifacts: [], summary: 'paid' }),
      { requiresPermission: true },
    );
    const workflow = def([{ id: 'a', toolId: 'paid' }]);
    assert.throws(() => validateWorkflow(workflow, { registry }), (error: unknown) =>
      error instanceof WorkflowError && error.code === 'PAID_BLOCKED');
    assert.deepEqual(validateWorkflow(workflow, { registry, allowPaid: true }), ['a']);
  });

  it('拓扑序稳定：同层保持声明顺序', () => {
    const registry = reg(
      new ToolRegistry(),
      'echo',
      async () => ({ outputs: { out: 'x' }, artifacts: [], summary: 'e' }),
      { inputs: [{ name: 'seed', type: 'text', required: true, description: '种子' }] },
    );
    const workflow = def([
      { id: 'a', toolId: 'echo', inputs: { seed: { value: '1' } } },
      { id: 'b', toolId: 'echo', inputs: { seed: { value: '2' } } },
      { id: 'c', toolId: 'echo', inputs: { seed: { from: 'a', port: 'out' } } },
    ]);
    assert.deepEqual(validateWorkflow(workflow, { registry }), ['a', 'b', 'c']);
  });
});

describe('节点缓存', () => {
  it('稳定序列化与键：键顺序无关，入参变化即换键', () => {
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
    const node = toPlan(def([{ id: 'a', toolId: 'echo' }])).nodes[0]!;
    assert.notEqual(cacheKeyFor(node, { x: 1 }), cacheKeyFor(node, { x: 2 }));
    assert.equal(cacheKeyFor(node, { x: 1 }), cacheKeyFor(node, { x: 1 }));
  });

  it('同一计划跑两次：第二次全命中缓存，工具只执行一次', async () => {
    let calls = 0;
    const registry = reg(new ToolRegistry(), 'echo', async () => {
      calls += 1;
      return { outputs: { out: 'hello' }, artifacts: [], summary: 'echo 执行' };
    });

    const handle = await makeHandle();
    const cacheRoot = path.join(os.tmpdir(), `mediasandbox-node-cache-${process.pid}`);
    const makeCache = (): NodeCache => new FileNodeCache({ root: cacheRoot, sandbox, handle });

    const workflow = def([{ id: 'a', toolId: 'echo' }]);
    const first = await runWorkflow(workflow, {
      registry,
      sandbox,
      handle,
      cache: makeCache(),
    });
    assert.equal(first.execution.status, 'succeeded');
    assert.equal(calls, 1);

    const second = await runWorkflow(workflow, { registry, sandbox, handle, cache: makeCache() });
    assert.equal(second.execution.status, 'succeeded');
    assert.equal(calls, 1, '第二次应当全部命中缓存');
    assert.equal(second.execution.states['a']?.cached, true);
  });

  it('改一个节点的参数：它和它的下游重跑，旁支继续命中', async () => {
    let echoCalls = 0;
    let wrapCalls = 0;
    const registry = reg(new ToolRegistry(), 'echo', async (runtime) => {
      echoCalls += 1;
      return { outputs: { out: String(runtime.inputs['seed']) }, artifacts: [], summary: 'echo' };
    }, { inputs: [{ name: 'seed', type: 'text', required: true, description: '种子' }] });
    reg(registry, 'wrap', async (runtime) => {
      wrapCalls += 1;
      return { outputs: { out: `${String(runtime.inputs['in'])}!` }, artifacts: [], summary: 'wrap' };
    }, { inputs: [{ name: 'in', type: 'text', required: true, description: '上游' }] });

    const handle = await makeHandle();
    const cacheRoot = path.join(os.tmpdir(), `mediasandbox-node-cache-branch-${process.pid}`);
    const makeCache = (): NodeCache => new FileNodeCache({ root: cacheRoot, sandbox, handle });

    const seed = (value: string): WorkflowDef =>
      def([
        { id: 'a', toolId: 'echo', inputs: { seed: { value } } },
        { id: 'b', toolId: 'wrap', inputs: { in: { from: 'a', port: 'out' } } },
      ]);

    await runWorkflow(seed('one'), { registry, sandbox, handle, cache: makeCache() });
    assert.equal(echoCalls, 1);
    assert.equal(wrapCalls, 1);

    const second = await runWorkflow(seed('one'), { registry, sandbox, handle, cache: makeCache() });
    assert.equal(echoCalls, 1, '参数没变，上游应当命中');
    assert.equal(wrapCalls, 1, '参数没变，下游也应当命中');
    assert.equal(second.execution.states['b']?.cached, true);

    const third = await runWorkflow(seed('two'), { registry, sandbox, handle, cache: makeCache() });
    assert.equal(echoCalls, 2, '参数变了，上游应当重跑');
    assert.equal(wrapCalls, 2, '上游产出变了，下游应当跟着重跑');
    assert.equal(third.execution.status, 'succeeded');
  });

  it('产物文件随缓存恢复：下游能读到上游写的文件', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register(
      {
        id: 'write',
        label: '写文件',
        description: '写一个文件',
        envTypes: ['copy'],
        role: 'transform',
        category: 'test',
        inputs: [{ name: 'text', type: 'text', required: true, description: '内容' }],
        outputs: [{ name: 'path', type: 'file', required: true, description: '路径' }],
      },
      async (runtime) => {
        calls += 1;
        await runtime.sandbox.writeFile(runtime.handle, 'artifacts/out.txt', String(runtime.inputs['text']));
        return {
          outputs: { path: 'artifacts/out.txt' },
          artifacts: [{ path: 'artifacts/out.txt', size: 3, mimeHint: 'text/plain' }],
          summary: '写了 out.txt',
        };
      },
    );

    const handle = await makeHandle();
    const cacheRoot = path.join(os.tmpdir(), `mediasandbox-node-cache-files-${process.pid}`);
    const workflow = def([{ id: 'w', toolId: 'write', inputs: { text: { value: 'abc' } } }]);

    await runWorkflow(workflow, {
      registry,
      sandbox,
      handle,
      cache: new FileNodeCache({ root: cacheRoot, sandbox, handle }),
    });

    // 模拟"新的一次运行"：把沙盒里那份删掉，只留缓存。
    await sandbox.writeFile(handle, 'artifacts/out.txt', '');
    const second = await runWorkflow(workflow, {
      registry,
      sandbox,
      handle,
      cache: new FileNodeCache({ root: cacheRoot, sandbox, handle }),
    });
    assert.equal(calls, 1, '第二次应当命中缓存');
    assert.equal(second.execution.states['w']?.cached, true);
    const restored = await sandbox.readFile(handle, 'artifacts/out.txt');
    assert.equal(new TextDecoder().decode(restored), 'abc', '产物文件应当被缓存恢复');
  });

  it('缓存损坏时如实重跑，不把错误抛给调用方', async () => {
    let calls = 0;
    const registry = reg(new ToolRegistry(), 'echo', async () => {
      calls += 1;
      return { outputs: { out: 'x' }, artifacts: [], summary: 'echo' };
    });
    const handle = await makeHandle();
    const cache: NodeCache = {
      get: async () => {
        throw new Error('磁盘坏了');
      },
      put: async () => {
        throw new Error('磁盘坏了');
      },
    };
    const result = await runWorkflow(def([{ id: 'a', toolId: 'echo' }]), {
      registry,
      sandbox,
      handle,
      cache,
    });
    assert.equal(result.execution.status, 'succeeded');
    assert.equal(calls, 1);
  });
});

describe('执行器本身不受缓存影响', () => {
  it('不传 cache 时照旧执行', async () => {
    let calls = 0;
    const registry = reg(new ToolRegistry(), 'echo', async () => {
      calls += 1;
      return { outputs: { out: 'x' }, artifacts: [], summary: 'echo' };
    });
    const handle = await makeHandle();
    const plan = toPlan(def([{ id: 'a', toolId: 'echo' }]));
    await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    await new PlanExecutor().execute({ plan, registry, sandbox, handle });
    assert.equal(calls, 2);
  });
});

describe('工具错误不被工作流吞掉', () => {
  it('工具抛错时节点失败，工作流返回 failed', async () => {
    const registry = reg(new ToolRegistry(), 'boom', async () => {
      throw new ToolError('炸了', 'EXECUTION_FAILED', 'boom');
    });
    const handle = await makeHandle();
    const result = await runWorkflow(def([{ id: 'a', toolId: 'boom' }]), {
      registry,
      sandbox,
      handle,
    });
    assert.equal(result.execution.status, 'failed');
    assert.equal(result.execution.states['a']?.status, 'failed');
  });
});
