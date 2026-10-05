/**
 * 运行记录：一次「跑一个目标」的完整状态。
 *
 * 服务端需要把编排过程中的事件**留存下来**，因为：
 *   1. WebSocket 客户端可能中途才连上，要能补发历史事件
 *   2. REST 查询要能拿到最终结果与产物清单
 *   3. 产物在 run 结束后仍要可下载
 */
import type { Artifact } from '@mediasandbox/sandbox';
import type {
  AttemptRecord,
  OrchestrationEvent,
  RunResult,
} from '@mediasandbox/orchestrator';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'escalated' | 'cancelled';

export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  status: RunStatus;
  readonly startedAt: number;
  finishedAt?: number | undefined;
  /** 全部事件，按时间序。WebSocket 客户端连上后会补发已有的。 */
  readonly events: OrchestrationEvent[];
  /** 最终执行的产物清单。 */
  artifacts: Artifact[];
  attempts: readonly AttemptRecord[];  reason?: string | undefined;
  /** 计划摘要，便于前端展示"排布了什么"。 */
  planSummary?: { readonly nodeId: string; readonly toolId: string; readonly note: string }[] | undefined;
  error?: string | undefined;
}

/** 队列里待执行的任务。 */
export interface QueuedRun {
  readonly record: RunRecord;
  readonly execute: (signal: AbortSignal) => Promise<RunResult>;
  readonly controller: AbortController;
}

/** 事件订阅者。run 每次产生事件都会推给它。 */
export type EventSubscriber = (runId: string, event: OrchestrationEvent) => void;

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly controllers = new Map<string, AbortController>();

  create(input: {
    id: string;
    projectId: string;
    goal: string;
    envType: string;
    provider: string;
  }): RunRecord {
    const record: RunRecord = {
      id: input.id,
      projectId: input.projectId,
      goal: input.goal,
      envType: input.envType,
      provider: input.provider,
      status: 'queued',
      startedAt: Date.now(),
      events: [],
      artifacts: [],
      attempts: [],
    };
    this.runs.set(input.id, record);
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 记录一个事件。run 结束后仍保留，供补发。 */
  appendEvent(runId: string, event: OrchestrationEvent): void {
    const record = this.runs.get(runId);
    if (record === undefined) return;
    record.events.push(event);
  }

  update(runId: string, patch: Partial<RunRecord>): void {
    const record = this.runs.get(runId);
    if (record === undefined) return;
    Object.assign(record, patch);
  }

  registerController(runId: string, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  /** 请求取消。返回 false 表示该 run 已不在执行中。 */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (controller === undefined) return false;
    controller.abort();
    const record = this.runs.get(runId);
    if (record !== undefined && (record.status === 'running' || record.status === 'queued')) {
      record.status = 'cancelled';
    }
    return true;
  }

  /** 清掉一个 run（含产物引用）。 */
  remove(runId: string): boolean {
    this.controllers.delete(runId);
    return this.runs.delete(runId);
  }
}

/** 生成 run id：时间戳 + 随机后缀，可读且不冲突。 */
export function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run-${stamp}-${suffix}`;
}

/**
 * 把编排事件压缩成前端需要的最小形态。
 *
 * 不在 WebSocket 上直接推原始事件：`plan_assembled` 带整个计划对象，
 * 而前端只需要"有哪些节点、用什么工具"。压缩后消息体积可控。
 */
export function toWireEvent(runId: string, event: OrchestrationEvent): Record<string, unknown> {
  const base = { runId, at: Date.now() };
  switch (event.type) {
    case 'run_started':
      return { ...base, type: 'run_started', goal: event.goal, projectId: event.projectId };
    case 'attempt_started':
      return { ...base, type: 'attempt_started', attempt: event.attempt, switches: event.switches };
    case 'plan_assembled':
      return {
        ...base,
        type: 'plan_assembled',
        nodes: event.plan.nodes.map((n) => ({
          id: n.id,
          toolId: n.toolId,
          note: n.note,
          dependsOn: n.dependsOn,
        })),
        rationale: event.plan.rationale,
      };
    case 'execution_event':
      return {
        ...base,
        type: 'execution_event',
        innerType: event.event.type,
        inner: event.event,
      };
    case 'attempt_failed':
      return { ...base, type: 'attempt_failed', detail: event.detail, kind: event.kind };
    case 'action_taken':
      return { ...base, type: 'action_taken', action: event.action, detail: event.detail };
    case 'run_finished':
      return {
        ...base,
        type: 'run_finished',
        status: event.status,
        attempts: event.attempts,
        durationMs: event.durationMs,
      };
    default: {
      // 穷尽性检查：新增事件类型时这里会编译报错，而不是运行时静默丢弃。
      const exhaustive: never = event;
      return { ...base, type: 'unknown', raw: exhaustive };
    }
  }
}
