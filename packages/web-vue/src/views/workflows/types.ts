/**
 * 工作流定义的前端类型。
 *
 * 与后端 `@mediasandbox/orchestrator` 的 `WorkflowDef` 一一对应，但**故意不复用**：
 * 前端构建时不希望把编排包（含 node 侧依赖）打进产物。形状变化由接口测试兜底
 * （`packages/server/src/workflow-api.test.ts` 会校验端口与节点）。
 */
export type WorkflowInput =
  | { readonly from: string; readonly port: string }
  | { readonly from: readonly { readonly nodeId: string; readonly port: string }[] }
  | { readonly value: string | number | boolean };

export interface WorkflowNodeDef {
  readonly id: string;
  readonly toolId: string;
  readonly inputs?: Record<string, WorkflowInput>;
  readonly dependsOn?: readonly string[];
  readonly note?: string;
  readonly position?: { readonly x: number; readonly y: number };
}

export interface WorkflowDef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly envType: string;
  readonly nodes: readonly WorkflowNodeDef[];
  readonly builtin?: boolean;
  readonly dynamic?: boolean;
}
