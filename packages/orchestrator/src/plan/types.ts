/**
 * 执行计划（DAG）的数据结构。
 *
 * 计划由**确定性代码**从决策答案组装而成，模型本身不产出这个结构。
 * 这条边界是刻意的：模型的输出是有限值域里的选择，而计划是可复现、可测试、可静态校验的。
 */
import type { EnvType } from '@mediasandbox/sandbox';

/** 计划里的一个节点，对应一次工具调用。 */
export interface PlanNode {
  /** 节点 id。组装器按 `序号-工具id` 生成，稳定可读。 */
  readonly id: string;
  readonly toolId: string;
  /**
   * 入参来源。
   * 值为 `PortRef` 时表示取自上游节点的产出；为字面量时直接使用。
   */
  readonly inputs: Readonly<Record<string, PlanInput>>;
  /** 依赖的节点 id。执行器据此做拓扑排序。 */
  readonly dependsOn: readonly string[];
  /** 该节点失败时是否允许重试。校验类节点通常不允许。 */
  readonly retryable: boolean;
  /** 人类可读的用途说明，用于前端展示与日志。 */
  readonly note: string;
}

/** 入参的两种来源。 */
export type PlanInput = PortRef | LiteralInput;

export interface PortRef {
  readonly kind: 'ref';
  /** 上游节点 id。 */
  readonly nodeId: string;
  /** 上游节点的产出端口名。 */
  readonly port: string;
}

export interface LiteralInput {
  readonly kind: 'literal';
  readonly value: string | number | boolean;
}

export interface ExecutionPlan {
  readonly envType: EnvType;
  readonly nodes: readonly PlanNode[];
  /** 组装依据的决策摘要，便于复现与排查。 */
  readonly rationale: readonly string[];
  /** 计划生成时间戳。 */
  readonly createdAt: number;
}

export class PlanError extends Error {
  override readonly name = 'PlanError';
  constructor(
    message: string,
    readonly code: PlanErrorCode,
  ) {
    super(message);
  }
}

export type PlanErrorCode =
  /** 节点引用了不存在的依赖。 */
  | 'DANGLING_DEPENDENCY'
  /** 计划里出现环。 */
  | 'CYCLE'
  /** 引用了不存在的工具。 */
  | 'UNKNOWN_TOOL'
  /** 端口引用指向不存在的产出。 */
  | 'BAD_PORT_REF'
  /** 节点入参缺失。 */
  | 'MISSING_INPUT'
  /** 计划为空。 */
  | 'EMPTY_PLAN'
  /** 工具与环境不匹配。 */
  | 'ENV_MISMATCH';

/**
 * 静态校验计划。
 *
 * 在执行之前把所有结构性问题一次性查清。这样执行器可以假设计划是良构的，
 * 不必在每个节点里重复做防御性检查——也避免"跑到一半才发现环"这种浪费。
 */
export function validatePlan(plan: ExecutionPlan): void {
  if (plan.nodes.length === 0) {
    throw new PlanError('执行计划为空', 'EMPTY_PLAN');
  }

  const byId = new Map<string, PlanNode>();
  for (const node of plan.nodes) {
    if (byId.has(node.id)) {
      throw new PlanError(`节点 id 重复: ${node.id}`, 'DANGLING_DEPENDENCY');
    }
    byId.set(node.id, node);
  }

  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new PlanError(`节点 ${node.id} 依赖不存在的节点 ${dep}`, 'DANGLING_DEPENDENCY');
      }
      if (dep === node.id) {
        throw new PlanError(`节点 ${node.id} 依赖自身`, 'CYCLE');
      }
    }
    for (const [portName, input] of Object.entries(node.inputs)) {
      if (input.kind !== 'ref') continue;
      if (!byId.has(input.nodeId)) {
        throw new PlanError(
          `节点 ${node.id} 的入参 ${portName} 引用不存在的节点 ${input.nodeId}`,
          'DANGLING_DEPENDENCY',
        );
      }
      if (!node.dependsOn.includes(input.nodeId)) {
        throw new PlanError(
          `节点 ${node.id} 的入参 ${portName} 引用了 ${input.nodeId}，但未声明依赖`,
          'DANGLING_DEPENDENCY',
        );
      }
    }
  }

  // 拓扑排序同时检测环。
  topologicalOrder(plan);
}

/**
 * 拓扑排序。同一层内按节点声明顺序返回，保证**确定性**——
 * 同样的计划永远得到同样的执行顺序，便于复现与测试。
 */
export function topologicalOrder(plan: ExecutionPlan): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of plan.nodes) {
    indegree.set(node.id, node.dependsOn.length);
    for (const dep of node.dependsOn) {
      const list = dependents.get(dep);
      if (list === undefined) dependents.set(dep, [node.id]);
      else list.push(node.id);
    }
  }

  // 保持声明顺序：按 plan.nodes 的顺序入队。
  const queue = plan.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== plan.nodes.length) {
    const stuck = plan.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    throw new PlanError(`执行计划存在环，涉及节点: ${stuck.join(', ')}`, 'CYCLE');
  }
  return order;
}

/**
 * 按依赖分层。同层节点之间无依赖，**可以并发执行**。
 * 执行器用这个结果来安排并发。
 */
export function planLayers(plan: ExecutionPlan): string[][] {
  const order = topologicalOrder(plan);
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();

  for (const id of order) {
    const node = byId.get(id)!;
    const d = node.dependsOn.length === 0
      ? 0
      : Math.max(...node.dependsOn.map((dep) => (depth.get(dep) ?? 0) + 1));
    depth.set(id, d);
  }

  const maxDepth = Math.max(...[...depth.values()], 0);
  const layers: string[][] = [];
  for (let i = 0; i <= maxDepth; i += 1) {
    layers.push(order.filter((id) => depth.get(id) === i));
  }
  return layers.filter((layer) => layer.length > 0);
}
