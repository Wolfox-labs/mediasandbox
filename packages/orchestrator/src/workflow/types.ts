/**
 * 工作流定义：把执行计划从"代码拼出来的"变成"可存、可改、可复用"的数据。
 *
 * ## 与现有 DAG 的关系
 *
 * `plan/types.ts` 里的 `ExecutionPlan` 是**运行时**结构：节点、端口引用、
 * 依赖、重试。它一直由代码（`assembler.ts`）在每次运行时拼出来，
 * 所以"改一个块"只能重跑整条链路，"把这一套换个标题再用一次"也做不到。
 *
 * 工作流定义是同一张图的**持久化形态**：节点一样是工具 + 端口，
 * 只是输入用 `from` 指向上游节点而不是运行时对象。两者之间是一次
 * 无信息损失的转换（`toPlan()`），所以执行器、校验、事件全都能复用。
 *
 * ## 为什么不直接用 ComfyUI 的格式
 *
 * ComfyUI 的 `links` 是扁平数组（`[id, fromNode, fromSlot, toNode, toSlot, type]`），
 * 位置耦合、读起来靠数下标。这里用"输入端口上写来源"的写法：
 *
 * ```json
 * { "id": "assemble", "toolId": "assemble-page",
 *   "inputs": { "blocks": { "from": [{"nodeId":"fill-hero","port":"block"}] } } }
 * ```
 *
 * 同样的图，边由输入隐式表达：**不可能出现"边连着但输入没接上"的非法状态**，
 * 而后者是扁平 links 格式最常见的坏数据。
 */
import type { EnvType } from '@mediasandbox/sandbox';
import type { ExecutionPlan, PlanInput, PlanNode } from '../plan/types.js';

/** 一个输入端口的值来源：上游节点、多个上游、或字面量。 */
export type WorkflowInput =
  /** 取某个上游节点的某个产出端口。 */
  | { readonly from: string; readonly port: string }
  /** 多个上游扇入成一个数组（顺序即声明顺序）。 */
  | { readonly from: readonly { readonly nodeId: string; readonly port: string }[] }
  /** 字面量。参数、目标、开关都走这里。 */
  | { readonly value: string | number | boolean };

/** 单上游引用。 */
export interface RefSource {
  readonly from: string;
  readonly port: string;
}

/** 多上游扇入。 */
export interface RefsSources {
  readonly from: readonly { readonly nodeId: string; readonly port: string }[];
}

export function isRefs(input: WorkflowInput): input is RefsSources {
  return 'from' in input && Array.isArray((input as RefsSources).from);
}

export function isRef(input: WorkflowInput): input is RefSource {
  return 'from' in input && typeof (input as RefSource).from === 'string';
}

/** 工作流里的一个节点。 */
export interface WorkflowNodeDef {
  /** 画布内唯一。保存后不再变（改了就等于换了一个节点）。 */
  readonly id: string;
  /** 工具 id，必须能在注册表里查到。 */
  readonly toolId: string;
  /** 输入端口 → 来源。没写的端口按工具的 `required` 规则校验。 */
  readonly inputs?: Readonly<Record<string, WorkflowInput>>;
  /** 人读的说明，也用于画布上的副标题。 */
  readonly note?: string;
  /**
   * 显式依赖：给"不靠端口取值、但必须先跑完"的节点用。
   *
   * 典型是 `verify-artifact` 与 `screenshot-page`——它们读的是沙盒里的文件，
   * 入参里没有上游产出，所以从输入推导不出"必须等组装完成"。
   * 没有这个字段，它们会被排进第一层，于是"还没组装就校验"，整条链路一跑就中止。
   */
  readonly dependsOn?: readonly string[];
  /** 画布坐标。只影响展示，不参与执行。 */
  readonly position?: { readonly x: number; readonly y: number };
}

export interface WorkflowDef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly envType: EnvType;
  readonly nodes: readonly WorkflowNodeDef[];
  /** 内置预设的标记：不可删，但可以"另存为"改。 */
  readonly builtin?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/** 从节点输入推导出的依赖关系（执行器与画布都用它）。 */
export function dependenciesOf(node: WorkflowNodeDef): string[] {
  const deps: string[] = [...(node.dependsOn ?? [])];
  const add = (id: string): void => {
    if (!deps.includes(id)) deps.push(id);
  };
  for (const input of Object.values(node.inputs ?? {})) {
    if (isRef(input)) add(input.from);
    else if (isRefs(input)) for (const source of input.from) add(source.nodeId);
  }
  return deps;
}

/**
 * 工作流定义 → 执行计划。
 *
 * 只做结构与引用的翻译，不做任何校验——校验在 `validateWorkflow` 里，
 * 因为"定义坏了"和"计划坏了"要报不同的错、给不同的修法。
 */
export function toPlan(def: WorkflowDef): ExecutionPlan {
  const nodes: PlanNode[] = def.nodes.map((node) => ({
    id: node.id,
    toolId: node.toolId,
    inputs: mapInputs(node),
    dependsOn: dependenciesOf(node),
    // 与结构化链路同一条纪律：**编排类节点不重试**，重试由工具自己决定；
    // 生成类节点默认重试一次（模型端点偶发失败是常态）。
    retryable: !node.toolId.startsWith('assemble') && !node.toolId.startsWith('verify'),
    note: node.note ?? node.toolId,
  }));
  return {
    envType: def.envType,
    nodes,
    rationale: [`工作流 ${def.name}：${def.nodes.length} 个节点`],
    createdAt: Date.now(),
  };
}

function mapInputs(node: WorkflowNodeDef): Record<string, PlanInput> {
  const out: Record<string, PlanInput> = {};
  for (const [port, input] of Object.entries(node.inputs ?? {})) {
    if (isRefs(input)) {
      out[port] = {
        kind: 'refs',
        refs: input.from.map((source) => ({ kind: 'ref', nodeId: source.nodeId, port: source.port })),
      };
      continue;
    }
    if (isRef(input)) {
      out[port] = { kind: 'ref', nodeId: input.from, port: input.port };
      continue;
    }
    out[port] = { kind: 'literal', value: input.value };
  }
  return out;
}
