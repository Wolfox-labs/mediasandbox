/**
 * DAG 执行器。
 *
 * 按计划的依赖顺序执行节点：同层节点**并发**，跨层串行。
 *
 * 三条刻意的设计：
 *   1. **执行前先静态校验**。结构性问题（环、悬空依赖）一次查清，
 *      避免"跑到一半才发现计划是坏的"。
 *   2. **失败立即停止后续节点**，但已并发的兄弟节点允许跑完——
 *      强行中断正在写文件的工具会留下半成品，比让它跑完更糟。
 *   3. **状态回调是纯观察**。回调抛错不会影响执行结果。
 */
import type { Artifact, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { LlmClient } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolError, type ToolResult } from '../tools/types.js';
import {
  PlanError,
  planLayers,
  validatePlan,
  type ExecutionPlan,
  type PlanInput,
  type PlanNode,
} from './types.js';

/** 节点执行状态。 */
export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface NodeState {
  readonly nodeId: string;
  readonly toolId: string;
  readonly status: NodeStatus;
  readonly attempts: number;
  readonly startedAt?: number | undefined;
  readonly finishedAt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  /** 该节点产出的文件。 */
  readonly artifacts: readonly Artifact[];
}

/** 执行进度事件。前端据此渲染实时状态。 */
export type ExecutionEvent =
  | { readonly type: 'plan_started'; readonly nodeCount: number; readonly at: number }
  | { readonly type: 'node_started'; readonly nodeId: string; readonly toolId: string; readonly attempt: number; readonly at: number }
  | { readonly type: 'node_log'; readonly nodeId: string; readonly message: string; readonly fields?: Readonly<Record<string, unknown>> | undefined; readonly at: number }
  | { readonly type: 'node_succeeded'; readonly nodeId: string; readonly summary: string; readonly durationMs: number; readonly at: number }
  | { readonly type: 'node_failed'; readonly nodeId: string; readonly error: string; readonly attempt: number; readonly willRetry: boolean; readonly at: number }
  | { readonly type: 'node_skipped'; readonly nodeId: string; readonly reason: string; readonly at: number }
  | { readonly type: 'plan_finished'; readonly status: 'succeeded' | 'failed'; readonly durationMs: number; readonly at: number };

export type ExecutionListener = (event: ExecutionEvent) => void;

export interface ExecuteOptions {
  readonly plan: ExecutionPlan;
  readonly registry: ToolRegistry;
  readonly sandbox: SandboxProvider;
  readonly handle: SandboxHandle;
  readonly llm?: LlmClient | undefined;
  /** 单个节点的超时毫秒。默认 120_000。 */
  readonly nodeTimeoutMs?: number | undefined;
  /** 同层并发上限。默认 4——沙盒里的工具多是 IO 密集，不需要开太多。 */
  readonly maxConcurrency?: number | undefined;
  /** 进度回调。抛错会被吞掉，不影响执行。 */
  readonly onEvent?: ExecutionListener | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * 单节点重试上限。默认 0——重试策略由兜底状态机决定，执行器本身不做决策。
   * 需要执行器内建重试时显式传入。
   */
  readonly maxRetries?: number | undefined;
}

export interface NodeOutcome {
  readonly nodeId: string;
  readonly toolId: string;
  readonly status: Exclude<NodeStatus, 'pending' | 'running'>;
  readonly result?: ToolResult | undefined;
  readonly error?: string | undefined;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface ExecutionResult {
  readonly status: 'succeeded' | 'failed';
  readonly outcomes: readonly NodeOutcome[];
  readonly states: Readonly<Record<string, NodeState>>;
  /** 全部节点的产物并集，按路径去重。 */
  readonly artifacts: readonly Artifact[];
  /** 各节点 summary 按执行顺序拼成，供后续决策当 evidence。 */
  readonly evidence: readonly string[];
  readonly durationMs: number;
}

/** 已停产的取消信号。 */
class ExecutionAbortedError extends Error {
  override readonly name = 'ExecutionAbortedError';
}

export class PlanExecutor {
  async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    const {
      plan,
      registry,
      sandbox,
      handle,
      llm,
      nodeTimeoutMs = 120_000,
      maxConcurrency = 4,
      onEvent,
      signal,
      maxRetries = 0,
    } = options;

    // 执行前先校验。计划是坏的就不该开始跑。
    validatePlan(plan);
    const layers = planLayers(plan);
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));

    const startedAt = Date.now();
    const emit = (event: ExecutionEvent): void => {
      if (onEvent === undefined) return;
      // 回调是纯观察：它抛错不该影响执行。
      try {
        onEvent(event);
      } catch {
        /* 忽略 */
      }
    };

    emit({ type: 'plan_started', nodeCount: plan.nodes.length, at: startedAt });

    const states = new Map<string, NodeState>();
    const results = new Map<string, ToolResult>();
    for (const node of plan.nodes) {
      states.set(node.id, {
        nodeId: node.id,
        toolId: node.toolId,
        status: 'pending',
        attempts: 0,
        artifacts: [],
      });
    }

    let aborted = false;

    for (const layer of layers) {
      if (aborted) break;
      if (signal?.aborted === true) {
        aborted = true;
        break;
      }

      // 同层并发，但限制并发度。用简单的分块调度，保持确定性。
      for (let i = 0; i < layer.length; i += maxConcurrency) {
        if (aborted) break;
        const chunk = layer.slice(i, i + maxConcurrency);

        const settled = await Promise.all(
          chunk.map(async (nodeId) => {
            const node = byId.get(nodeId)!;

            // 上游失败则跳过本节点。
            const blockedBy = node.dependsOn.find(
              (dep) => states.get(dep)?.status !== 'succeeded',
            );
            if (blockedBy !== undefined) {
              const reason = `上游节点 ${blockedBy} 未成功`;
              states.set(nodeId, { ...states.get(nodeId)!, status: 'skipped' });
              emit({ type: 'node_skipped', nodeId, reason, at: Date.now() });
              return { nodeId, ok: false as const, reason };
            }

            try {
              const outcome = await this.runNode({
                node,
                registry,
                sandbox,
                handle,
                llm,
                nodeTimeoutMs,
                maxRetries,
                maxConcurrency,
                results,
                states,
                emit,
                ...(signal !== undefined ? { signal } : {}),
              });
              if (outcome.result !== undefined) results.set(nodeId, outcome.result);
              return { nodeId, ok: outcome.status === 'succeeded' };            } catch (error) {
              if (error instanceof ExecutionAbortedError) {
                aborted = true;
                return { nodeId, ok: false as const, reason: '已取消' };
              }
              // runNode 内部已把失败写进 states；这里只负责让本层停止推进。
              return { nodeId, ok: false as const, reason: String(error) };
            }
          }),
        );

        // 本层有一块失败，就不再继续后面的块。
        if (settled.some((s) => !s.ok)) {
          aborted = true;
          break;
        }
      }
    }

    // 计划失败后，把还没处理的节点标成 skipped，让状态完整。
    for (const node of plan.nodes) {
      const state = states.get(node.id)!;
      if (state.status === 'pending') {
        states.set(node.id, { ...state, status: 'skipped' });
        emit({ type: 'node_skipped', nodeId: node.id, reason: '计划已中止', at: Date.now() });
      }
    }

    const durationMs = Date.now() - startedAt;
    const outcomes: NodeOutcome[] = plan.nodes.map((node) => {
      const state = states.get(node.id)!;
      const result = results.get(node.id);
      return {
        nodeId: node.id,
        toolId: node.toolId,
        status: state.status === 'succeeded' ? 'succeeded' : state.status === 'failed' ? 'failed' : 'skipped',
        ...(result !== undefined ? { result } : {}),
        ...(state.error !== undefined ? { error: state.error } : {}),
        attempts: state.attempts,
        durationMs: state.durationMs ?? 0,
      };
    });

    const anyFailed = outcomes.some((o) => o.status !== 'succeeded');
    const status = anyFailed ? 'failed' : 'succeeded';

    // 产物去重：同一路径取首次出现（后面的覆盖不改变交付内容）。
    const artifactMap = new Map<string, Artifact>();
    for (const node of plan.nodes) {
      for (const artifact of states.get(node.id)?.artifacts ?? []) {
        if (!artifactMap.has(artifact.path)) artifactMap.set(artifact.path, artifact);
      }
    }

    emit({ type: 'plan_finished', status, durationMs, at: Date.now() });

    return {
      status,
      outcomes,
      states: Object.fromEntries(states),
      artifacts: [...artifactMap.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
      evidence: plan.nodes
        .map((n) => states.get(n.id)?.summary)
        .filter((s): s is string => typeof s === 'string' && s !== ''),
      durationMs,
    };
  }

  private async runNode(args: {
    node: PlanNode;
    registry: ToolRegistry;
    sandbox: SandboxProvider;
    handle: SandboxHandle;
    llm: LlmClient | undefined;
    nodeTimeoutMs: number;
    maxRetries: number;
    maxConcurrency: number;
    results: Map<string, ToolResult>;
    states: Map<string, NodeState>;
    emit: (event: ExecutionEvent) => void;
    signal?: AbortSignal;
  }): Promise<NodeOutcome> {
    const {
      node,
      registry,
      sandbox,
      handle,
      llm,
      nodeTimeoutMs,
      maxRetries,
      results,
      states,
      emit,
    } = args;

    const registration = registry.get(node.toolId); // 未注册会抛 UNKNOWN_TOOL
    const nodeStartedAt = Date.now();

    // 入参解析失败（引用不存在的上游产出等）属于节点自身的失败，
    // 必须记成 failed 并带上原因，否则会被误标为 skipped，排查时看不到真实错误。
    let inputs: Record<string, unknown>;
    try {
      inputs = resolveInputs(node, results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      states.set(node.id, {
        ...states.get(node.id)!,
        status: 'failed',
        attempts: 0,
        finishedAt: Date.now(),
        durationMs: Date.now() - nodeStartedAt,
        error: message,
      });
      emit({
        type: 'node_failed',
        nodeId: node.id,
        error: message,
        attempt: 0,
        willRetry: false,
        at: Date.now(),
      });
      return {
        nodeId: node.id,
        toolId: node.toolId,
        status: 'failed',
        error: message,
        attempts: 0,
        durationMs: Date.now() - nodeStartedAt,
      };
    }

    const attemptLimit = node.retryable ? maxRetries + 1 : 1;

    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      attempts = attempt;
      const attemptStartedAt = Date.now();
      states.set(node.id, {
        ...states.get(node.id)!,
        status: 'running',
        attempts: attempt,
        startedAt: attemptStartedAt,
      });
      emit({
        type: 'node_started',
        nodeId: node.id,
        toolId: node.toolId,
        attempt,
        at: attemptStartedAt,
      });

      try {
        const result = await withTimeout(
          registration.execute({
            sandbox,
            handle,
            llm,
            inputs,
            signal: args.signal,
            timeoutMs: nodeTimeoutMs,
            log: (message, fields) => {
              emit({
                type: 'node_log',
                nodeId: node.id,
                message,
                ...(fields !== undefined ? { fields } : {}),
                at: Date.now(),
              });
            },
          }),
          nodeTimeoutMs,
        );

        const durationMs = Date.now() - attemptStartedAt;
        states.set(node.id, {
          ...states.get(node.id)!,
          status: 'succeeded',
          finishedAt: Date.now(),
          durationMs,
          summary: result.summary,
          artifacts: result.artifacts,
        });
        emit({
          type: 'node_succeeded',
          nodeId: node.id,
          summary: result.summary,
          durationMs,
          at: Date.now(),
        });
        return {
          nodeId: node.id,
          toolId: node.toolId,
          status: 'succeeded',
          result,
          attempts,
          durationMs: Date.now() - nodeStartedAt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const willRetry = attempt < attemptLimit;
        emit({
          type: 'node_failed',
          nodeId: node.id,
          error: lastError,
          attempt,
          willRetry,
          at: Date.now(),
        });
        if (!willRetry) break;
        // 重试前短暂退避，给下游服务恢复的机会。
        await sleep(Math.min(200 * attempt, 1_000));
      }
    }

    const durationMs = Date.now() - nodeStartedAt;
    states.set(node.id, {
      ...states.get(node.id)!,
      status: 'failed',
      finishedAt: Date.now(),
      durationMs,
      ...(lastError !== undefined ? { error: lastError } : {}),
    });
    return {
      nodeId: node.id,
      toolId: node.toolId,
      status: 'failed',
      ...(lastError !== undefined ? { error: lastError } : {}),
      attempts,
      durationMs,
    };
  }
}

/** 把节点的入参解析成实际值：字面量直接用，引用从上游结果取。 */
function resolveInputs(
  node: PlanNode,
  results: ReadonlyMap<string, ToolResult>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [portName, input] of Object.entries(node.inputs)) {
    out[portName] = resolveInput(node.id, portName, input, results);
  }
  return out;
}

function resolveInput(
  nodeId: string,
  portName: string,
  input: PlanInput,
  results: ReadonlyMap<string, ToolResult>,
): unknown {
  if (input.kind === 'literal') return input.value;

  const upstream = results.get(input.nodeId);
  if (upstream === undefined) {
    throw new PlanError(
      `节点 ${nodeId} 的入参 ${portName} 引用了 ${input.nodeId}，但它没有产出（可能已失败）`,
      'BAD_PORT_REF',
    );
  }
  const value = upstream.outputs[input.port];
  if (value === undefined) {
    throw new PlanError(
      `节点 ${nodeId} 的入参 ${portName} 引用了 ${input.nodeId} 的产出端口 ${input.port}，` +
        `但该节点只产出了 [${Object.keys(upstream.outputs).join(', ')}]`,
      'MISSING_INPUT',
    );
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给工具执行加超时。超时抛 ToolError，交由上层按失败处理。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ToolError(`工具执行超时（${timeoutMs}ms）`, 'EXECUTION_FAILED', '(timeout)'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
