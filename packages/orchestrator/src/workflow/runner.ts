/**
 * 工作流执行：校验 → 转计划 → 交给 `PlanExecutor`。
 *
 * 只有三步，因为**执行器只有一个**。工作流不是第二套运行时，
 * 而是"同一张图的一种持久化写法"——这样并发、重试、超时、取消、事件、
 * 缓存全部自动共享，不会出现"两条链路行为不一致"的经典问题。
 */
import type { SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { LlmClient } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { NodeCache } from '../plan/cache.js';
import { PlanExecutor, type ExecutionEvent, type ExecutionResult } from '../plan/executor.js';
import { toPlan, type WorkflowDef } from './types.js';
import { validateWorkflow } from './validate.js';

export interface RunWorkflowOptions {
  readonly registry: ToolRegistry;
  readonly sandbox: SandboxProvider;
  readonly handle: SandboxHandle;
  readonly llm?: LlmClient | undefined;
  readonly cache?: NodeCache | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
  readonly nodeTimeoutMs?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxRetries?: number | undefined;
  /** 是否放行按次计费的工具。默认 false。 */
  readonly allowPaid?: boolean | undefined;
}

export interface WorkflowRunResult {
  readonly execution: ExecutionResult;
  /** 校验得到的稳定拓扑序，便于前端按"从头到尾"展示。 */
  readonly order: readonly string[];
}

export async function runWorkflow(
  def: WorkflowDef,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const order = validateWorkflow(def, {
    registry: options.registry,
    ...(options.allowPaid !== undefined ? { allowPaid: options.allowPaid } : {}),
  });
  const plan = toPlan(def);
  const executor = new PlanExecutor();
  const execution = await executor.execute({
    plan,
    registry: options.registry,
    sandbox: options.sandbox,
    handle: options.handle,
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    ...(options.nodeTimeoutMs !== undefined ? { nodeTimeoutMs: options.nodeTimeoutMs } : {}),
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
  return { execution, order };
}
