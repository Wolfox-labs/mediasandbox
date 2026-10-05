/**
 * 编排入口：把决策层、工具注册表、DAG 组装、执行器、兜底状态机串成一条链路。
 *
 * 一次「跑一个目标」的完整流程：
 *
 *   1. 决策层批量回答封闭问题（选主工具、要不要校验、怎么收尾）
 *   2. 组装器把答案拼成执行计划，并做静态校验
 *   3. 执行器按依赖顺序执行，同层并发
 *   4. 任一步失败 → 兜底状态机决定：重试 / 换方案 / 熔断转人工
 *
 * 三条边界：
 *   - **决策层只回答封闭问题**，不产出计划；计划由确定性代码拼。
 *   - **重试与换方案的次数由兜底状态机控制**，执行器本身不做这个决策。
 *   - **换方案**的做法是：把已试过的工具加入 `exclude`，让决策层重选。
 */
import type { EnvType, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { DecisionClient, DecisionContext } from './decision/types.js';
import type { LlmClient } from './llm/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { ToolError } from './tools/types.js';
import { PlanAssembler } from './plan/assembler.js';
import { PlanExecutor, type ExecutionEvent, type ExecutionResult } from './plan/executor.js';
import type { ExecutionPlan } from './plan/types.js';
import {
  DEFAULT_POLICY,
  FallbackStateMachine,
  waitBackoff,
  type FallbackPolicy,
} from './fallback/state-machine.js';

export interface RunRequest {
  /** 项目 id。用于建沙盒与日志。 */
  readonly projectId: string;
  /** 用户目标原文。 */
  readonly goal: string;
  readonly envType: EnvType;
  /** 语气等自由文本参数。 */
  readonly tone?: string | undefined;
  /** 交付前至少要有几个产物。 */
  readonly minArtifacts?: number | undefined;
  /** 决策层追加上下文（事实、约束等）。 */
  readonly constraints?: readonly string[] | undefined;
  readonly facts?: Readonly<Record<string, string>> | undefined;
}

export interface RunOptions {
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly sandbox: SandboxProvider;
  readonly llm?: LlmClient | undefined;
  readonly policy?: FallbackPolicy | undefined;
  readonly nodeTimeoutMs?: number | undefined;
  readonly decisionTimeoutMs?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly onEvent?: ((event: OrchestrationEvent) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 编排层事件：执行器事件的超集，额外带阶段信息。 */
export type OrchestrationEvent =
  | { readonly type: 'run_started'; readonly projectId: string; readonly goal: string; readonly at: number }
  | { readonly type: 'attempt_started'; readonly attempt: number; readonly switches: number; readonly at: number }
  | { readonly type: 'plan_assembled'; readonly plan: ExecutionPlan; readonly at: number }
  | { readonly type: 'execution_event'; readonly event: ExecutionEvent }
  | { readonly type: 'attempt_failed'; readonly detail: string; readonly kind: string; readonly at: number }
  | { readonly type: 'action_taken'; readonly action: string; readonly detail: string; readonly at: number }
  | {
      readonly type: 'run_finished';
      readonly status: 'succeeded' | 'failed' | 'escalated';
      readonly attempts: number;
      readonly switches: number;
      readonly durationMs: number;
      readonly at: number;
    };

export interface RunResult {
  readonly status: 'succeeded' | 'failed' | 'escalated';
  /** 最终生效的执行结果。熔断且从未跑通时为 undefined。 */
  readonly execution?: ExecutionResult | undefined;
  /** 最终使用的计划。 */
  readonly plan?: ExecutionPlan | undefined;
  /** 本次运行使用的沙盒。调用方据此读取产物、决定何时销毁。 */
  readonly handle: SandboxHandle;
  /** 每次尝试的记录，便于排查与前端展示。 */
  readonly attempts: readonly AttemptRecord[];
  readonly durationMs: number;
  /** 熔断或失败时的人可读原因。 */
  readonly reason?: string | undefined;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly switches: number;
  readonly planKey: string;
  readonly status: 'succeeded' | 'failed';
  readonly detail: string;
}

/** 从计划里提取一个稳定的标识，用于"已试过哪些方案"的去重。 */
function planKeyOf(plan: ExecutionPlan): string {
  return plan.nodes.map((n) => n.toolId).join('>');
}

export class Orchestrator {
  async run(request: RunRequest, options: RunOptions): Promise<RunResult> {
    const {
      registry,
      decision,
      sandbox,
      llm,
      policy = DEFAULT_POLICY,
      nodeTimeoutMs,
      decisionTimeoutMs,
      maxConcurrency,
      onEvent,
      signal,
    } = options;

    const startedAt = Date.now();
    const emit = (event: OrchestrationEvent): void => {
      if (onEvent === undefined) return;
      try {
        onEvent(event);
      } catch {
        /* 回调是纯观察，抛错不影响执行 */
      }
    };

    emit({
      type: 'run_started',
      projectId: request.projectId,
      goal: request.goal,
      at: startedAt,
    });

    const handle: SandboxHandle = await sandbox.create(request.projectId, request.envType);
    const fallback = new FallbackStateMachine(policy);
    const attempts: AttemptRecord[] = [];

    let lastPlan: ExecutionPlan | undefined;
    let lastExecution: ExecutionResult | undefined;
    /** 换方案时要排除的工具——已试过且失败的主工具。 */
    const excludeTools = new Set<string>();

    let attemptNumber = 0;

    try {
      for (;;) {
        if (signal?.aborted === true) {
          return this.finish('failed', lastExecution, lastPlan, handle, attempts, startedAt, '调用方已取消', emit);
        }

        attemptNumber += 1;
        emit({
          type: 'attempt_started',
          attempt: attemptNumber,
          switches: fallback.switchCount,
          at: Date.now(),
        });

        // ── 1. 组装计划 ────────────────────────────────────────────────
        const context: DecisionContext = {
          goal: request.goal,
          envType: request.envType,
          ...(request.constraints !== undefined ? { constraints: request.constraints } : {}),
          ...(request.facts !== undefined ? { facts: request.facts } : {}),
        };

        let plan: ExecutionPlan;
        try {
          const assembler = new PlanAssembler(registry, decision, {
            excludeTools: [...excludeTools],
          });
          const assembled = await assembler.assemble({
            context,
            envType: request.envType,
            goal: request.goal,
            ...(request.tone !== undefined ? { tone: request.tone } : {}),
            ...(request.minArtifacts !== undefined ? { minArtifacts: request.minArtifacts } : {}),
            ...(decisionTimeoutMs !== undefined ? { decisionTimeoutMs } : {}),
          });
          plan = assembled.plan;
        } catch (error) {
          const decisionResult = fallback.onFailure(error, 1);
          const detail = error instanceof Error ? error.message : String(error);
          attempts.push({
            attempt: attemptNumber,
            switches: fallback.switchCount,
            planKey: '(组装失败)',
            status: 'failed',
            detail,
          });
          emit({ type: 'attempt_failed', detail, kind: decisionResult.kind, at: Date.now() });

          if (decisionResult.action === 'retry') {
            emit({ type: 'action_taken', action: 'retry', detail: decisionResult.detail, at: Date.now() });
            await waitBackoff(decisionResult.delayMs);
            continue;
          }
          if (decisionResult.action === 'switch_plan') {
            emit({
              type: 'action_taken',
              action: 'switch_plan',
              detail: decisionResult.detail,
              at: Date.now(),
            });
            continue;
          }
          return this.finish('escalated', lastExecution, lastPlan, handle, attempts, startedAt, decisionResult.detail, emit);
        }

        lastPlan = plan;
        const planKey = planKeyOf(plan);
        fallback.markTried(planKey);
        emit({ type: 'plan_assembled', plan, at: Date.now() });

        // ── 2. 执行计划 ────────────────────────────────────────────────
        const executor = new PlanExecutor();
        const execution = await executor.execute({
          plan,
          registry,
          sandbox,
          handle,
          ...(llm !== undefined ? { llm } : {}),
          ...(nodeTimeoutMs !== undefined ? { nodeTimeoutMs } : {}),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
          onEvent: (event) => emit({ type: 'execution_event', event }),
          ...(signal !== undefined ? { signal } : {}),
        });

        lastExecution = execution;

        if (execution.status === 'succeeded') {
          fallback.onSuccess();
          attempts.push({
            attempt: attemptNumber,
            switches: fallback.switchCount,
            planKey,
            status: 'succeeded',
            detail: `产出 ${execution.artifacts.length} 个产物`,
          });
          return this.finish('succeeded', execution, plan, handle, attempts, startedAt, undefined, emit);
        }

        // ── 3. 失败 → 兜底 ────────────────────────────────────────────
        const failedNode = execution.outcomes.find((o) => o.status === 'failed');
        const failureDetail = failedNode?.error ?? '执行失败';
        const failureError = new Error(failureDetail);
        // 让归类能认出工具错误：执行器把 ToolError 压成了字符串，这里用前缀还原。
        const classified = fallback.onFailure(
          rehydrateToolError(failureDetail),
          attemptNumber,
        );

        attempts.push({
          attempt: attemptNumber,
          switches: fallback.switchCount,
          planKey,
          status: 'failed',
          detail: failureDetail,
        });
        emit({
          type: 'attempt_failed',
          detail: failureDetail,
          kind: classified.kind,
          at: Date.now(),
        });
        void failureError;

        // 换方案时把失败节点用到的工具排除掉，逼决策层换一个。
        if (classified.action === 'switch_plan') {
          for (const outcome of execution.outcomes) {
            if (outcome.status === 'failed') excludeTools.add(outcome.toolId);
          }
        }

        if (classified.action === 'retry') {
          emit({ type: 'action_taken', action: 'retry', detail: classified.detail, at: Date.now() });
          await waitBackoff(classified.delayMs);
          continue;
        }
        if (classified.action === 'switch_plan') {
          emit({
            type: 'action_taken',
            action: 'switch_plan',
            detail: `${classified.detail}；排除已失败工具: ${[...excludeTools].join(', ')}`,
            at: Date.now(),
          });
          continue;
        }
        return this.finish(
          'escalated',
          execution,
          plan,
          handle,
          attempts,
          startedAt,
          classified.detail,
          emit,
        );
      }
    } finally {
      // 沙盒默认保留产物，因此不在这里 destroy。
      // 生命周期由调用方管理（M5 会在产物收集完成后销毁）。
    }
  }

  private finish(
    status: 'succeeded' | 'failed' | 'escalated',
    execution: ExecutionResult | undefined,
    plan: ExecutionPlan | undefined,
    handle: SandboxHandle,
    attempts: AttemptRecord[],
    startedAt: number,
    reason: string | undefined,
    emit: (event: OrchestrationEvent) => void,
  ): RunResult {
    const durationMs = Date.now() - startedAt;
    emit({
      type: 'run_finished',
      status,
      attempts: attempts.length,
      switches: attempts.filter((a) => a.switches > 0).length,
      durationMs,
      at: Date.now(),
    });
    return {
      status,
      ...(execution !== undefined ? { execution } : {}),
      ...(plan !== undefined ? { plan } : {}),
      handle,
      attempts,
      durationMs,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

/**
 * 从执行器的错误字符串还原成真正的错误对象，让归类能判断该不该重试。
 *
 * 执行器为了保持 NodeOutcome 可序列化，把异常压成了 message 字符串。
 * 这里**必须构造真实的错误实例**（而不是设一下 name）——因为 `classifyFailure`
 * 用 `instanceof` 判类型，只改 name 会被归成 unknown，重试策略就错了。
 */
function rehydrateToolError(detail: string): Error {
  if (/超时|timeout/i.test(detail)) {
    return new ToolError(detail, 'EXECUTION_FAILED', '(rehydrated)');
  }
  if (/未提供 LlmClient|生成层调用失败|命令退出码/.test(detail)) {
    return new ToolError(detail, 'EXECUTION_FAILED', '(rehydrated)');
  }
  if (/产物校验失败/.test(detail)) {
    return new ToolError(detail, 'EXECUTION_FAILED', '(rehydrated)');
  }
  if (/未注册的工具/.test(detail)) {
    return new ToolError(detail, 'UNKNOWN_TOOL', '(rehydrated)');
  }
  return new Error(detail);
}
