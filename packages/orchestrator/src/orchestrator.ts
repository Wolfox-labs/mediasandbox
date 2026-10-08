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
import type { EnvType, SandboxErrorCode, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import { SandboxError } from '@mediasandbox/sandbox';
import type { DecisionClient, DecisionContext } from './decision/types.js';
import type { LlmClient } from './llm/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { ToolError } from './tools/types.js';
import { PlanAssembler, type AssembleResult } from './plan/assembler.js';
import type { BlockInstance, PageSpec } from './structured/page-spec.js';
import type { StructureStep } from './structured/planner.js';
import type { BlockRegistry } from './structured/block-spec.js';
import type { TemplateSpec } from './structured/template-spec.js';
import {
  PlanExecutor,
  type ExecutionEvent,
  type ExecutionResult,
  type NodeErrorInfo,
} from './plan/executor.js';
import { PlanError, type ExecutionPlan } from './plan/types.js';
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

  // ── 以下仅 `webpage` 环境（结构化链路）使用 ──────────────────────────
  /**
   * 本次候选 block 类型——用户从 block 池里选出来的。
   *
   * 省略时用池子全集（这样默认就能跑通）。给出时**决策模型只在这里面选**，
   * 与"候选集来自工具注册表"是同一条原则：扩展 block 词表 = 改池子，不重训模型。
   */
  readonly candidateBlockIds?: readonly string[] | undefined;
  /** 页面 block 数上限。防止"要不要继续"永远答是。 */
  readonly maxBlocks?: number | undefined;
  /** 站点名。由用户或确定性代码给，不让模型编。 */
  readonly brand?: string | undefined;
  /** 文案是否走生成层。**默认 false**——零成本是默认值。 */
  readonly useGenerative?: boolean | undefined;
  /** 页面上是否标注每块的来源（生成式/确定性/用户），便于演示与排查。 */
  readonly annotate?: boolean | undefined;
  /**
   * 套用的模板。由调用方从模板池解析后传入——模板池属于服务层，
   * 编排层只认"这一个模板长什么样"，不认"模板从哪来"。
   */
  readonly template?: TemplateSpec | undefined;
  /**
   * block 池。省略则结构化链路退回内置池。
   *
   * 装了外部来源（模型提议/手打/导入）的 block 时**必须传**：
   * 否则那些 block 在 `/api/blocks` 里列得出来、却永远进不了候选集。
   */
  readonly blocks?: BlockRegistry | undefined;
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
  | {
      readonly type: 'plan_assembled';
      readonly plan: ExecutionPlan;
      readonly at: number;
      /**
       * 结构化链路专有：定稿的页面结构与逐轮决策留痕。
       *
       * 带上它是为了让前端能**在填充开始之前**就把结构画出来——
       * 结构是数据，本来就可以先展示再执行；单链链路给不出这个，
       * 它的结构要等生成完才知道。
       */
      readonly structure?: { readonly page: PageSpec; readonly steps: readonly StructureStep[] } | undefined;
    }
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
  /**
   * **结构化链路专有**：逐块决策定稿的页面与每一轮的决策留痕。
   *
   * 单链链路没有这个东西——它的结构藏在生成出来的字符串里，拿不出来。
   * 结构化链路的结构是数据，所以能作为**产出**交出来，而不是只作为过程事件。
   */
  readonly structure?:
    | { readonly page: PageSpec; readonly steps: readonly StructureStep[] }
    | undefined;
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

/**
 * 把执行结果回填进结构留痕：**让"结构"说的是最终形态，而不是计划形态**。
 *
 * ## 为什么必须做
 *
 * `structure` 来自组装阶段，那时每个块的 `status` 都是 `pending`（结构定了、还没填）。
 * 不回填的话，界面上永远显示"三块都未填充"，而页面其实早就渲染好了——
 * 数据、产物、日志三处都正常，只有这一处**说反了**。这正是本项目最在意的那类缺陷。
 *
 * ## 为什么按键对齐而不是按数组顺序
 *
 * `assembleStructured` 给每个块生成一个 `fill-block` 节点，**顺序与 `page.blocks`
 * 一致**，所以按计划里的节点顺序对齐是准确的。`execution.outcomes` 的数组顺序
 * 没有这个保证（并发执行，完成顺序不定）。
 *
 * ## 为什么只回填 status 与 sources，不复制 slots
 *
 * 内容已经在 `src/blocks/<id>.json` 与产物里了。复制进来有两个代价：
 * 图是 data URI，一份页面的图集能让 `meta.json` 膨胀几十上百 KB；
 * 而且内容会有两个真相来源，改了产物里的、忘了改记录里的，就对不上了。
 */
function mergeBlockStatuses(
  structure: AssembleResult['structure'],
  plan: ExecutionPlan | undefined,
  execution: ExecutionResult | undefined,
): AssembleResult['structure'] {
  if (structure === undefined || plan === undefined || execution === undefined) return structure;

  const fillNodeIds = plan.nodes.filter((n) => n.toolId === 'fill-block').map((n) => n.id);
  const byNode = new Map(execution.outcomes.map((o) => [o.nodeId, o]));

  const blocks = structure.page.blocks.map((block, index) => {
    const nodeId = fillNodeIds[index];
    const outcome = nodeId === undefined ? undefined : byNode.get(nodeId);
    if (outcome === undefined) return block;

    if (outcome.status === 'failed') {
      return { ...block, status: 'failed' as const, error: outcome.error ?? '填充失败' };
    }
    if (outcome.status === 'skipped') {
      return { ...block, status: 'skipped' as const };
    }

    const raw = outcome.result?.outputs['block'];
    if (typeof raw !== 'string') return block;
    try {
      const filled = JSON.parse(raw) as BlockInstance;
      return { ...block, status: filled.status, sources: filled.sources };
    } catch {
      // 填块的产出解析不了不该让整次运行失败：留痕回填是**锦上添花**。
      return block;
    }
  });

  return { ...structure, page: { ...structure.page, blocks } };
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
    /**
     * 最后一次定稿的结构。
     *
     * 它**必须出现在 `RunResult` 上**，不能只躺在 `plan_assembled` 事件里：
     * 事件是"过程"，结果是"产出"。调用方（服务层）要把它存进运行记录、
     * 要能刷新页面后仍然拿得到——只靠订阅事件的话，错过那一刻就永远没了。
     */
    let lastStructure: AssembleResult['structure'];
    /** 换方案时要排除的工具——已试过且失败的主工具。 */
    const excludeTools = new Set<string>();

    let attemptNumber = 0;

    try {
      for (;;) {
        if (signal?.aborted === true) {
          return this.finish('failed', lastExecution, lastPlan, lastStructure, handle, attempts, startedAt, '调用方已取消', emit);
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
        let structure: AssembleResult['structure'];
        try {
          const assembler = new PlanAssembler(registry, decision, {
            excludeTools: [...excludeTools],
          });
          const assembled = await assembler.assemble({
            context,
            envType: request.envType,
            goal: request.goal,
            projectId: request.projectId,
            ...(request.tone !== undefined ? { tone: request.tone } : {}),
            ...(request.minArtifacts !== undefined ? { minArtifacts: request.minArtifacts } : {}),
            ...(request.candidateBlockIds !== undefined
              ? { candidateBlockIds: request.candidateBlockIds }
              : {}),
            ...(request.maxBlocks !== undefined ? { maxBlocks: request.maxBlocks } : {}),
            ...(request.brand !== undefined ? { brand: request.brand } : {}),
            ...(request.useGenerative !== undefined ? { useGenerative: request.useGenerative } : {}),
            ...(request.annotate !== undefined ? { annotate: request.annotate } : {}),
            ...(request.template !== undefined ? { template: request.template } : {}),
            ...(request.blocks !== undefined ? { blocks: request.blocks } : {}),
            ...(decisionTimeoutMs !== undefined ? { decisionTimeoutMs } : {}),
          });
          plan = assembled.plan;
          structure = assembled.structure;
          lastStructure = assembled.structure;
        } catch (error) {
          // **attemptNumber，不是写死的 1。**
          //
          // 这里曾经传 `1`。后果不是"少重试几次"，而是**无限循环**：
          // `onFailure` 里 `attempt <= maxRetries` 判定用的是传入的尝试号，
          // 恒为 1 时永远成立，于是 `action` 永远是 `retry`，
          // 而 `retry` 分支只 `continue`、不改变任何状态——转一整圈又回到这里，
          // 再次传 1。实测跑满 300 秒、2107 个事件、一个 block 都没产出。
          const decisionResult = fallback.onFailure(error, attemptNumber);
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
          return this.finish('escalated', lastExecution, lastPlan, lastStructure, handle, attempts, startedAt, decisionResult.detail, emit);
        }

        lastPlan = plan;
        const planKey = planKeyOf(plan);
        fallback.markTried(planKey);
        emit({
          type: 'plan_assembled',
          plan,
          at: Date.now(),
          ...(structure !== undefined ? { structure } : {}),
        });

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
          return this.finish('succeeded', execution, plan, structure, handle, attempts, startedAt, undefined, emit);
        }

        // ── 3. 失败 → 兜底 ────────────────────────────────────────────
        const failedNode = execution.outcomes.find((o) => o.status === 'failed');
        const failureDetail = failedNode?.error ?? '执行失败';
        // 归类靠 `errorInfo` 里的类型与错误码，不去猜 `failureDetail` 的措辞。
        const classified = fallback.onFailure(
          rehydrateToolError(failedNode ?? { error: failureDetail }),
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
          structure,
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
    structure: AssembleResult['structure'],
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
    const finalStructure = mergeBlockStatuses(structure, plan, execution);
    return {
      status,
      ...(execution !== undefined ? { execution } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(finalStructure !== undefined ? { structure: finalStructure } : {}),
      handle,
      attempts,
      durationMs,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

/**
 * 把执行器带出来的结构化错误信息还原成真正的错误实例，供 `classifyFailure` 归类。
 *
 * **优先用 `errorInfo`（按类型判断），不猜消息文本。**
 * 旧实现靠正则匹配错误消息前缀（`/命令退出码/` 之类），那是个脆弱点：
 * 谁改一句措辞，分类就静默退化成 `unknown`，重试策略跟着错——
 * 而且这种退化在结果里看不出来。
 *
 * `errorInfo` 缺失时才回落到文本匹配，兼容外部直接构造 `NodeOutcome` 的调用方。
 */
function rehydrateToolError(outcome: {
  readonly error?: string | undefined;
  readonly errorInfo?: NodeErrorInfo | undefined;
}): Error {
  const detail = outcome.error ?? '执行失败';
  const info = outcome.errorInfo;
  if (info === undefined) return rehydrateFromText(detail);

  const toolId = info.toolId ?? '(rehydrated)';
  switch (info.kind) {
    case 'tool':
      return new ToolError(
        detail,
        info.code === 'UNKNOWN_TOOL' ? 'UNKNOWN_TOOL' : 'EXECUTION_FAILED',
        toolId,
      );
    case 'plan':
      return new PlanError(detail, info.code === 'BAD_PORT_REF' ? 'BAD_PORT_REF' : 'MISSING_INPUT');
    case 'sandbox':
      return new SandboxError(detail, sandboxCodeOf(info.code));
    case 'unknown':
      return new Error(detail);
  }
}

/** 把 `SandboxErrorCode` 字符串收敛回合法值；无法识别时给一个保守的默认。 */
function sandboxCodeOf(code: string | undefined): SandboxErrorCode {
  switch (code) {
    case 'PATH_ESCAPE':
    case 'NO_SUCH_SANDBOX':
    case 'NO_SUCH_FILE':
    case 'UNSUPPORTED':
    case 'CREATE_FAILED':
      return code;
    default:
      return 'UNSUPPORTED';
  }
}

/**
 * 兼容路径：`NodeOutcome` 没带 `errorInfo` 时按消息前缀猜。
 *
 * 保留它是为了不破坏外部直接构造 `NodeOutcome` 的调用方；
 * 编排层自己的执行器**总会**填 `errorInfo`，所以正常路径不走这里。
 */
function rehydrateFromText(detail: string): Error {
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
