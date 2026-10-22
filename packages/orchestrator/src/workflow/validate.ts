/**
 * 工作流静态校验：**在任何副作用发生之前**把定义里的坏数据拦下来。
 *
 * 与 `validatePlan` 同一条纪律，但检查的对象不同：
 *
 * | 校验 | 管什么 |
 * |---|---|
 * | `validatePlan` | 运行时计划：依赖、环、端口引用 |
 * | `validateWorkflow` | 持久化定义：节点 id、工具是否存在、输入来源是否接得上、付费闸门 |
 *
 * 为什么不合并：定义是**用户可编辑**的，报错要能直接指到"第几个节点、哪个输入"；
 * 而计划是代码生成的，报错指向 id 就够了。混在一起会让两边的错误消息都变模糊。
 */
import type { ToolRegistry } from '../tools/registry.js';
import { dependenciesOf, isRef, isRefs, type WorkflowDef, type WorkflowInput } from './types.js';

export type WorkflowErrorCode =
  /** 没有节点。 */
  | 'EMPTY'
  /** 节点 id 重复。 */
  | 'DUPLICATE_ID'
  /** 工具不在注册表里。 */
  | 'UNKNOWN_TOOL'
  /** 工具不支持这个环境。 */
  | 'ENV_MISMATCH'
  /** 输入指向不存在的节点。 */
  | 'DANGLING_DEPENDENCY'
  /** 输入指向了上游没有声明的端口。 */
  | 'UNKNOWN_PORT'
  /** 必填输入没有接。 */
  | 'MISSING_INPUT'
  /** 图里有环。 */
  | 'CYCLE'
  /** 会按次计费的工具，但这次没放行。 */
  | 'PAID_BLOCKED';

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';
  constructor(
    message: string,
    readonly code: WorkflowErrorCode,
    readonly nodeId?: string,
  ) {
    super(message);
  }
}

export interface ValidateWorkflowOptions {
  readonly registry: ToolRegistry;
  /** 是否放行 `requiresPermission` 的工具。默认 false。 */
  readonly allowPaid?: boolean;
}

/**
 * 校验一份工作流定义。通过则返回按拓扑排好序的节点 id，失败抛 `WorkflowError`。
 *
 * 返回值顺序用于画布"从头跑到尾"的默认顺序：稳定的拓扑序，同层保持声明顺序。
 */
export function validateWorkflow(def: WorkflowDef, options: ValidateWorkflowOptions): string[] {
  if (def.nodes.length === 0) {
    throw new WorkflowError('工作流里没有任何节点', 'EMPTY');
  }

  const byId = new Map<string, WorkflowDef['nodes'][number]>();
  for (const node of def.nodes) {
    if (byId.has(node.id)) {
      throw new WorkflowError(`节点 id 重复: ${node.id}`, 'DUPLICATE_ID', node.id);
    }
    byId.set(node.id, node);
  }

  for (const node of def.nodes) {
    const tool = requireTool(options.registry, node);
    if (!tool.spec.envTypes.includes(def.envType)) {
      throw new WorkflowError(
        `工具 ${node.toolId} 不支持环境 ${def.envType}（支持 ${tool.spec.envTypes.join('/')}）`,
        'ENV_MISMATCH',
        node.id,
      );
    }
    if (tool.spec.requiresPermission === true && options.allowPaid !== true) {
      throw new WorkflowError(
        `节点 ${node.id} 用了按次计费的工具 ${node.toolId}，本次没有放行。` +
          `要么删掉它，要么允许付费生成`,
        'PAID_BLOCKED',
        node.id,
      );
    }
  }

  // 依赖与端口引用
  for (const node of def.nodes) {
    const tool = requireTool(options.registry, node);
    const declaredInputs = new Map(tool.spec.inputs.map((port) => [port.name, port]));

    for (const [name, input] of Object.entries(node.inputs ?? {})) {
      const declared = declaredInputs.get(name);
      if (declared === undefined) {
        throw new WorkflowError(
          `节点 ${node.id} 的输入 ${name} 不是工具 ${node.toolId} 的端口`,
          'UNKNOWN_PORT',
          node.id,
        );
      }
      for (const source of sourcesOf(input)) {
        const upstream = byId.get(source.nodeId);
        if (upstream === undefined) {
          throw new WorkflowError(
            `节点 ${node.id} 的输入 ${name} 指向不存在的节点 ${source.nodeId}`,
            'DANGLING_DEPENDENCY',
            node.id,
          );
        }
        const upstreamTool = requireTool(options.registry, upstream);
        if (!upstreamTool.spec.outputs.some((port) => port.name === source.port)) {
          throw new WorkflowError(
            `节点 ${node.id} 的输入 ${name} 引用了 ${source.nodeId} 没有声明的端口 ${source.port}`,
            'UNKNOWN_PORT',
            node.id,
          );
        }
      }
    }

    for (const port of tool.spec.inputs) {
      if (!port.required) continue;
      const input = node.inputs?.[port.name];
      if (input === undefined) {
        throw new WorkflowError(
          `节点 ${node.id} 缺少必填输入 ${port.name}（${port.description}）`,
          'MISSING_INPUT',
          node.id,
        );
      }
      if ('value' in input && input.value === '') {
        throw new WorkflowError(
          `节点 ${node.id} 的必填输入 ${port.name} 是空字符串`,
          'MISSING_INPUT',
          node.id,
        );
      }
      if (isRef(input) && input.from === '') {
        throw new WorkflowError(`节点 ${node.id} 的必填输入 ${port.name} 没有选择来源`, 'MISSING_INPUT', node.id);
      }
      if (isRefs(input) && input.from.length === 0) {
        throw new WorkflowError(`节点 ${node.id} 的必填输入 ${port.name} 没有选择来源`, 'MISSING_INPUT', node.id);
      }
    }
  }

  return topologicalOrder(def);
}

function sourcesOf(input: WorkflowInput): readonly { readonly nodeId: string; readonly port: string }[] {
  if (isRefs(input)) return input.from;
  if (isRef(input)) return [{ nodeId: input.from, port: input.port }];
  return [];
}

/** 查工具；查不到统一转成 `UNKNOWN_TOOL`，而不是把注册表自己的异常抛出去。 */
function requireTool(
  registry: ToolRegistry,
  node: WorkflowDef['nodes'][number],
): ReturnType<ToolRegistry['get']> {
  if (!registry.has(node.toolId)) {
    throw new WorkflowError(
      `节点 ${node.id} 用了未注册的工具 ${node.toolId}`,
      'UNKNOWN_TOOL',
      node.id,
    );
  }
  return registry.get(node.toolId);
}

/** 稳定拓扑序：同层按定义里的先后。 */
function topologicalOrder(def: WorkflowDef): string[] {
  const byId = new Map(def.nodes.map((node) => [node.id, node]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of def.nodes) {
    indegree.set(node.id, 0);
  }
  for (const node of def.nodes) {
    for (const dep of dependenciesOf(node)) {
      if (!byId.has(dep)) {
        throw new WorkflowError(
          `节点 ${node.id} 依赖不存在的节点 ${dep}`,
          'DANGLING_DEPENDENCY',
          node.id,
        );
      }
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const queue = def.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  if (order.length !== def.nodes.length) {
    const stuck = def.nodes.map((node) => node.id).filter((id) => !order.includes(id));
    throw new WorkflowError(`工作流里有环：${stuck.join(' → ')}`, 'CYCLE', stuck[0]);
  }
  return order;
}
