/**
 * 把原始事件流折叠成界面要的步骤模型。
 *
 * 这是工作台的核心：**决策过程可见**是本项目区别于普通聊天框的地方，
 * 所以要把"选了哪个工具、为什么选、每步什么状态"从事件流里还原出来。
 *
 * 设计要点：
 *   - 纯函数，不依赖 React，便于单测
 *   - 按 `nodeId` 归并同一节点的多次事件（started → log → succeeded/failed）
 *   - 保留 rationale（组装依据）与 attempt（重试/换方案），它们是"可解释"的证据
 */
import type { InnerExecutionEvent, PlanNodeSummary, RunStatus, WireEvent } from '../api/types.js';

/** 单个节点的界面状态。 */
export interface StepView {
  readonly nodeId: string;
  readonly toolId: string;
  readonly note: string;
  readonly dependsOn: readonly string[];
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  /** 已经试了几次（重试时累加）。 */
  attempts: number;
  summary?: string | undefined;
  error?: string | undefined;
  /** 节点执行期间的日志行。 */
  logs: string[];
  startedAt?: number | undefined;
  durationMs?: number | undefined;
}

/** 一次尝试（重试 / 换方案）的界面状态。 */
export interface AttemptView {
  readonly attempt: number;
  readonly switches: number;
  status: 'running' | 'failed' | 'succeeded';
  detail?: string | undefined;
  /** 该次尝试用的计划节点。换方案后会被整批替换。 */
  nodes: StepView[];
  rationale: string[];
}

/** 折叠后的完整视图模型。 */
export interface RunViewModel {
  runId: string | undefined;
  goal: string | undefined;
  status: RunStatus | 'unknown';
  attempts: AttemptView[];
  /** 当前正在展示的那次尝试（最后一条）。 */
  current: AttemptView | undefined;
  /** 由决策层回答、组装器记录的排布依据。 */
  rationale: readonly string[];
  reason?: string | undefined;
  finished?: { status: RunStatus; durationMs: number } | undefined;
}

function emptyViewModel(): RunViewModel {
  return {
    runId: undefined,
    goal: undefined,
    status: 'unknown',
    attempts: [],
    current: undefined,
    rationale: [],
  };
}

/** 按 nodeId 找节点，找不到就补一个占位（事件可能先于 plan_assembled 到达）。 */
function ensureNode(nodes: StepView[], nodeId: string, toolId: string): StepView {
  const found = nodes.find((n) => n.nodeId === nodeId);
  if (found !== undefined) return found;
  const created: StepView = {
    nodeId,
    toolId,
    note: '',
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    logs: [],
  };
  nodes.push(created);
  return created;
}

/** 用计划摘要替换当前尝试的节点列表，保留已经收到的事件状态。 */
function applyPlan(attempt: AttemptView, planNodes: readonly PlanNodeSummary[], rationale: readonly string[]): void {
  const previous = new Map(attempt.nodes.map((n) => [n.nodeId, n]));
  attempt.nodes = planNodes.map((p) => {
    const old = previous.get(p.id);
    return {
      nodeId: p.id,
      toolId: p.toolId,
      note: p.note,
      dependsOn: p.dependsOn,
      // 换方案后同一 nodeId 可能换了工具，那就别继承旧状态。
      status: old !== undefined && old.toolId === p.toolId ? old.status : 'pending',
      attempts: old !== undefined && old.toolId === p.toolId ? old.attempts : 0,
      ...(old?.summary !== undefined ? { summary: old.summary } : {}),
      ...(old?.error !== undefined ? { error: old.error } : {}),
      logs: old?.logs ?? [],
      ...(old?.startedAt !== undefined ? { startedAt: old.startedAt } : {}),
      ...(old?.durationMs !== undefined ? { durationMs: old.durationMs } : {}),
    };
  });
  attempt.rationale = [...rationale];
}

function applyInner(attempt: AttemptView, inner: InnerExecutionEvent): void {
  const nodeId = inner.nodeId;

  switch (inner.type) {
    case 'plan_started':
      // 计划开始：把所有节点置为 pending，准备跑。
      for (const node of attempt.nodes) node.status = 'pending';
      break;

    case 'node_started': {
      if (nodeId === undefined) return;
      const node = ensureNode(attempt.nodes, nodeId, inner.toolId ?? '');
      // attempt 递增表示这是一次重试；首次是 1。
      node.attempts = Math.max(node.attempts, inner.attempt ?? 1);
      node.status = 'running';
      node.startedAt = inner.at ?? Date.now();
      node.error = undefined;
      break;
    }

    case 'node_log': {
      if (nodeId === undefined) return;
      const node = ensureNode(attempt.nodes, nodeId, inner.toolId ?? '');
      if (inner.message !== undefined) node.logs.push(inner.message);
      break;
    }

    case 'node_succeeded': {
      if (nodeId === undefined) return;
      const node = ensureNode(attempt.nodes, nodeId, inner.toolId ?? '');
      node.status = 'succeeded';
      node.summary = inner.summary;
      node.durationMs = inner.durationMs;
      break;
    }

    case 'node_failed': {
      if (nodeId === undefined) return;
      const node = ensureNode(attempt.nodes, nodeId, inner.toolId ?? '');
      node.status = 'failed';
      node.error = inner.error;
      break;
    }

    case 'node_skipped': {
      if (nodeId === undefined) return;
      const node = ensureNode(attempt.nodes, nodeId, inner.toolId ?? '');
      node.status = 'skipped';
      if (inner.reason !== undefined) node.logs.push(`跳过：${inner.reason}`);
      break;
    }

    case 'plan_finished':
      attempt.status = inner.status === 'succeeded' ? 'succeeded' : 'failed';
      break;

    default:
      break;
  }
}

/**
 * 折叠事件流。
 *
 * 每次调用都从零折叠（而不是增量 apply）——事件量很小（一次运行几十条），
 * 全量折叠换来的是**无状态**：不用管乱序、不用管重连补发重复，
 * 同样的输入永远得到同样的视图。
 */
export function foldEvents(events: readonly WireEvent[]): RunViewModel {
  const vm = emptyViewModel();
  // 用可变对象折叠，最后再交给 React；每轮都新建避免共享引用。
  const mutable: {
    runId?: string;
    goal?: string;
    status: RunStatus | 'unknown';
    attempts: AttemptView[];
    rationale: string[];
    reason?: string;
    finished?: { status: RunStatus; durationMs: number };
  } = { status: 'unknown', attempts: [], rationale: [] };

  /** 当前尝试；没有就补一个（attempt_started 可能是第一条）。 */
  const currentAttempt = (): AttemptView => {
    let attempt = mutable.attempts[mutable.attempts.length - 1];
    if (attempt === undefined) {
      attempt = { attempt: 1, switches: 0, status: 'running', nodes: [], rationale: [] };
      mutable.attempts.push(attempt);
    }
    return attempt;
  };

  for (const event of events) {
    if (mutable.runId === undefined) mutable.runId = event.runId;

    switch (event.type) {
      case 'run_started':
        mutable.goal = event.goal;
        mutable.status = 'running';
        break;

      case 'attempt_started': {
        // 新尝试：开一个新的 attempt 容器。重试与换方案都走这里。
        const isFirst = mutable.attempts.length === 0;
        if (!isFirst) {
          mutable.attempts.push({
            attempt: event.attempt,
            switches: event.switches,
            status: 'running',
            nodes: [],
            rationale: [],
          });
        } else {
          const attempt = currentAttempt();
          (attempt as { attempt: number }).attempt = event.attempt;
          (attempt as { switches: number }).switches = event.switches;
        }
        break;
      }

      case 'plan_assembled': {
        const attempt = currentAttempt();
        applyPlan(attempt, event.nodes, event.rationale);
        mutable.rationale = [...event.rationale];
        break;
      }

      case 'execution_event': {
        applyInner(currentAttempt(), event.inner as unknown as InnerExecutionEvent);
        break;
      }

      case 'attempt_failed': {
        const attempt = currentAttempt();
        attempt.status = 'failed';
        attempt.detail = event.detail;
        break;
      }

      case 'action_taken': {
        const attempt = currentAttempt();
        attempt.detail = `${event.action}：${event.detail}`;
        break;
      }

      case 'run_finished':
        mutable.status = event.status;
        mutable.finished = { status: event.status, durationMs: event.durationMs };
        break;

      case 'run_state':
        mutable.status = event.status;
        if (event.reason !== undefined) mutable.reason = event.reason;
        break;

      default:
        break;
    }
  }

  vm.runId = mutable.runId;
  vm.goal = mutable.goal;
  vm.status = mutable.status;
  vm.attempts = mutable.attempts.map((a) => ({ ...a, nodes: [...a.nodes] }));
  vm.current = vm.attempts[vm.attempts.length - 1];
  vm.rationale = mutable.rationale;
  if (mutable.reason !== undefined) vm.reason = mutable.reason;
  if (mutable.finished !== undefined) vm.finished = mutable.finished;
  return vm;
}
