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
  BlueprintOutcome,
  OrchestrationEvent,
  PageSpec,
  RunResult,
  StructureStep,
} from '@mediasandbox/orchestrator';
import type { RunPersist } from './persist.js';

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
  /**
   * 这次运行用的沙盒 id。
   *
   * **必须落盘**：句柄在内存里，重启就没了，而沙盒本身（容器 / 工作区目录）比
   * 服务进程活得久。不记下来的话，重启后"接着用那个沙盒"就无从谈起——
   * 只能靠猜前缀，而本地实现的 id 带随机后缀，猜不出来。
   */
  sandboxId?: string | undefined;
  attempts: readonly AttemptRecord[];
  reason?: string | undefined;
  /** 计划摘要，便于前端展示"排布了什么"。 */
  planSummary?: { readonly nodeId: string; readonly toolId: string; readonly note: string }[] | undefined;
  /**
   * **结构化链路定稿的结构**（结构化中间表示 + 逐轮决策留痕）。
   *
   * 存**完整形态**（含 slot 内容与原始概率分布），因为它同时是：
   *   - 落盘沉淀成模板的原料（P8 要的是完整结构，不是压缩版）
   *   - 前端"先看结构再执行"的数据源
   *
   * 对外的 REST 响应走 `compactStructure()` 压缩，与 WebSocket 推的是同一个形状——
   * 两条通道形状不一致的话，前端刷新一次就得写两套解析。
   */
  structure?: { readonly page: PageSpec; readonly steps: readonly StructureStep[] } | undefined;
  /**
   * **统筹规划那份计划**（大语言模型出的）。
   *
   * 与 `structure` 分开存：一个是"打算讲哪几段"，一个是"实际排了哪几块"。
   * 合成一个字段就没法回答"决策模型有没有照计划走"——而那正是两个模型
   * 分工之后唯一值得看的东西。
   */
  blueprint?: BlueprintOutcome | undefined;
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

  /**
   * 落盘钩子。省略即纯内存——既有测试与"不配 dataDir"的部署不必被迫提供它。
   *
   * 刻意只认这个窄接口而不是文件系统：`RunStore` 的职责是"记住运行状态"，
   * 存到哪、怎么存是另一个模块的事。这样它可以被单独测，也换得掉。
   */
  constructor(private readonly persist?: RunPersist | undefined) {}

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
    this.persist?.saveMeta(record);
    return record;
  }

  /**
   * 启动时装载一条已落盘的运行记录。
   *
   * 与 `create` 的区别：**不回写**。装载本身就是从盘上读出来的，
   * 再写一遍只会把刚读到的内容原样覆盖一次。
   */
  adopt(record: RunRecord, events: readonly OrchestrationEvent[]): void {
    record.events.push(...events);
    this.runs.set(record.id, record);
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
    this.persist?.appendEvent(runId, event);
  }

  update(runId: string, patch: Partial<RunRecord>): void {
    const record = this.runs.get(runId);
    if (record === undefined) return;
    Object.assign(record, patch);
    this.persist?.saveMeta(record);
  }

  registerController(runId: string, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  /**
   * 运行结束（跑完、失败、被取消都算），释放取消开关。
   *
   * 不释放的话每跑一次就在表里留一个 AbortController——进程活得够久时，
   * `cancel()` 会去 abort 一个早已结束的运行的开关，看起来"取消成功"，
   * 实际什么都没发生。
   */
  finishRun(runId: string): void {
    this.controllers.delete(runId);
  }

  /**
   * 请求取消。返回 false 表示该 run 已不在执行中（也不在排队中）。
   *
   * **状态推进由调用方决定**：排队中的取消要先把任务从队列里摘出来，否则它会
   * 在名额空出时照常开跑——用户点了取消，运行却开始了。
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (controller === undefined) return false;
    controller.abort();
    const record = this.runs.get(runId);
    if (record !== undefined && (record.status === 'running' || record.status === 'queued')) {
      record.status = 'cancelled';
      record.finishedAt = Date.now();
      this.persist?.saveMeta(record);
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
 * 压缩结构化链路的结构与决策留痕，供 WebSocket 推送与 REST 详情共用。
 *
 * **刻意丢掉每轮的原始概率分布**：那是给排查用的，几百个浮点数对前端毫无价值，
 * 而它会让消息体积翻十倍。前端要的是"这一轮问了什么、选了哪块、为什么"。
 * 原始答案仍留在编排层的事件流里，需要时从 `GET /api/runs/:id` 拿。
 *
 * **REST 与 WebSocket 共用同一个压缩函数**：两条通道形状不一致的话，
 * 前端刷新一次页面就得写两套解析——而"刷新后结构还在"正是持久化要解决的问题。
 */
export function compactStructure(structure: {
  readonly page: PageSpec;
  readonly steps: readonly StructureStep[];
}): Record<string, unknown> {
  return {
    page: {
      projectId: structure.page.projectId,
      goal: structure.page.goal,
      templateId: structure.page.templateId,
      candidateBlockIds: structure.page.candidateBlockIds,
      qualityScore: structure.page.qualityScore,
      blocks: structure.page.blocks.map((b) => ({
        id: b.id,
        type: b.type,
        status: b.status,
        slotNames: Object.keys(b.slots),
      })),
    },
    steps: structure.steps.map((s) => ({
      round: s.round,
      kind: s.kind,
      questionIds: s.questionIds,
      pickedBlockId: s.pickedBlockId,
      continueProbability: s.continueProbability,
      continued: s.continued,
      counts: s.counts,
      score: s.score,
      latencyMs: s.latencyMs,
      rationale: s.rationale,
    })),
  };
}

/**
 * 压缩统筹规划的结果，供 WebSocket 推送与 REST 详情共用。
 *
 * 与 `compactStructure` 同一个理由：**原始模型输出**（`raw` 字段）几百到几千字，
 * 对界面没有价值，但它会让每条消息都背上一个没人读的正文。留痕另有落盘，
 * 要排查时从运行记录里取。
 *
 * `ok: false` 原样带 `detail`：规划失败的原因必须能显示出来，
 * 否则用户看到的就是"这一栏空着"，而空着和没做是两件事。
 */
export function compactBlueprint(outcome: BlueprintOutcome): Record<string, unknown> {
  if (!outcome.ok) return { ok: false, detail: outcome.detail };
  const blueprint = outcome.blueprint;
  return {
    ok: true,
    title: blueprint.title,
    positioning: blueprint.positioning,
    audience: blueprint.audience,
    tone: blueprint.tone,
    status: blueprint.status,
    model: blueprint.model,
    latencyMs: blueprint.latencyMs,
    sections: blueprint.sections.map((section) => ({
      purpose: section.purpose,
      detail: section.detail,
      blockIds: section.blockIds,
    })),
    notes: blueprint.notes,
  };
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
        // 结构化链路的结构与逐轮留痕。**在填充开始之前就推给前端**——
        // 结构是数据，本来就能先展示再执行；单链链路给不出这个，
        // 它的结构要等生成完才存在。
        ...(event.structure !== undefined ? { structure: compactStructure(event.structure) } : {}),
        // 统筹规划与结构**同时**推出去：前端把"计划"排在"决策"上面，
        // 两个模型的分工才看得出来。只推结构的话，计划就只是一段日志。
        ...(event.blueprint !== undefined ? { blueprint: compactBlueprint(event.blueprint) } : {}),
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
    case 'env_classified':
      return {
        ...base,
        type: 'env_classified',
        envType: event.envType,
        source: event.source,
        detail: event.detail,
      };
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
