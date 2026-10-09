/**
 * 与后端 REST / WebSocket 对齐的类型定义。
 *
 * 这些形状来自 `packages/server/src/app.ts` 与 `run-store.ts`，
 * **手工保持同步**——后端是纯 TS、未导出可复用的 API schema，
 * 所以这里宁可写死也不要 `any`，字段对不上时在编译期就能发现。
 */

/**
 * 沙盒环境类型。
 *
 * `webpage` 与 `frontend` 并存：后者是整页生成（工具是交付物级），
 * 前者是**结构化制作**（工具是 block 级，结构由决策模型逐块决定）。
 */
export type EnvType = 'frontend' | 'image' | 'copy' | 'webpage';

export const ENV_TYPES: readonly EnvType[] = ['frontend', 'image', 'copy', 'webpage'];

/** 环境的中文说明，界面展示用。 */
export const ENV_LABELS: Readonly<Record<EnvType, { label: string; hint: string }>> = {
  frontend: { label: '前端 / 网页', hint: '产出 HTML 页面与静态站点（整页生成）' },
  image: { label: '图像', hint: '产出图片类作品' },
  copy: { label: '文案', hint: '产出 Markdown 文稿' },
  webpage: {
    label: '结构化网页',
    hint: '结构由决策模型逐块决定，可选取 block 候选集，逐块填充并组装成整页',
  },
};

/** block 分组。 */
export type BlockGroup = 'skeleton' | 'content' | 'interactive';

/** block 的 slot 类型。决定**由谁来填**。 */
export type SlotType =
  | 'text'
  | 'title'
  | 'image'
  | 'code'
  | 'link'
  | 'literal'
  | 'list-text'
  | 'list-image';

/** 一个具名 slot 的声明。 */
export interface SlotSpecDto {
  readonly name: string;
  readonly type: SlotType;
  readonly required: boolean;
  readonly description: string;
  /** `list-*` 型才有：项数区间。 */
  readonly countRange?: { readonly min: number; readonly max: number } | undefined;
}

/** block 池里的一项（`GET /api/blocks`）。 */
export interface BlockSpecDto {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: BlockGroup;
  readonly groupLabel: string;
  readonly canLead: boolean;
  readonly repeatable: boolean;
  readonly costHint: 'fast' | 'medium' | 'slow';
  readonly slots: readonly SlotSpecDto[];
}

export interface BlockGroupDto {
  readonly id: BlockGroup;
  readonly label: string;
  readonly count: number;
}

/** 运行状态。 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'escalated'
  | 'cancelled';

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'escalated',
  'cancelled',
];

export function isTerminal(status: RunStatus | 'unknown'): boolean {
  // 'unknown' 表示还没收到任何状态事件，不算终态。
  return status !== 'unknown' && TERMINAL_STATUSES.includes(status);
}

/** 产物。 */
export interface Artifact {
  readonly path: string;
  readonly size: number;
  readonly mimeHint: string;
}

/** 计划节点摘要（`plan_assembled` 事件里带的裁剪版）。 */
export interface PlanNodeSummary {
  readonly id: string;
  readonly toolId: string;
  readonly note: string;
  readonly dependsOn: readonly string[];
}

/** 运行记录（`GET /api/runs/:id`）。 */
export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifacts: readonly Artifact[];
  readonly attempts: readonly AttemptRecord[];
  readonly reason?: string | undefined;
  readonly error?: string | undefined;
  readonly planSummary?: readonly PlanNodeSummary[] | undefined;
  readonly eventCount: number;
  /**
   * 排队位次（1 起）。**只有正在排队的运行才有这个字段**——在跑与已结束的没有。
   *
   * 用可选字段而不是 `queuePosition: 0`：0 会被读成"排在第 0 位"，
   * 而它想表达的是"不在排队"。
   */
  readonly queuePosition?: number | undefined;
}

/** 一次尝试（重试 / 换方案）。 */
export interface AttemptRecord {
  readonly attempt: number;
  readonly switches: number;
  readonly planKey: string;
  readonly status: string;
  readonly detail: string;
}

/** 运行列表项（`GET /api/runs`，比详情少若干字段）。 */
export interface RunListItem {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifactCount: number;
  /** 排队位次（1 起），不在排队时缺省。与详情同名字段，前端只写一套解析。 */
  readonly queuePosition?: number | undefined;
}

/** 项目内的单次运行（`GET /api/projects` 里嵌的裁剪版）。 */
export interface ProjectRunDto {
  readonly id: string;
  readonly goal: string;
  readonly envType: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifactCount: number;
}

/**
 * 项目（`GET /api/projects`）。
 *
 * 与 `RunListItem` 的区别是**视角**：那里是"每次运行"的流水，
 * 这里是"每个项目"的集合 —— 一个项目可能跑过多次。
 */
export interface ProjectDto {
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly runCount: number;
  readonly artifactCount: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly runs: readonly ProjectRunDto[];
}

/** 工具规格（`GET /api/tools`）。 */
export interface ToolSpecDto {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly envTypes: readonly string[];
  readonly role: 'generate' | 'transform' | 'verify' | 'execute';
  readonly category: string;
  readonly inputs?: readonly { name: string; type: string; required: boolean; description: string }[];
  readonly outputs?: readonly { name: string; type: string; required: boolean; description: string }[];
  readonly costHint?: string | undefined;
}

/**
 * 结构化链路的页面结构（`plan_assembled` 事件里带的裁剪版）。
 *
 * 后端刻意丢掉了每轮的**原始概率分布**——那是排查用的，
 * 几百个浮点数对界面毫无价值，还会让消息体积翻十倍。
 * 这里要的是"这一轮问了什么、选了哪块、为什么"。
 */
export interface StructureView {
  readonly page: {
    readonly projectId: string;
    readonly goal: string;
    readonly templateId: string | null;
    readonly candidateBlockIds: readonly string[];
    readonly qualityScore: number | null;
    readonly blocks: readonly {
      readonly id: string;
      readonly type: string;
      readonly status: string;
      readonly slotNames: readonly string[];
    }[];
  };
  readonly steps: readonly {
    readonly round: number;
    readonly kind: 'select' | 'count_only' | 'quality';
    readonly questionIds: readonly string[];
    readonly pickedBlockId: string | null;
    readonly continueProbability: number | null;
    readonly continued: boolean | null;
    readonly counts: Readonly<Record<string, number>>;
    readonly score: number | null;
    readonly latencyMs: number;
    readonly rationale: string;
  }[];
}

/** 健康检查（`GET /api/health`）。 */
export interface HealthResponse {
  readonly ok: boolean;
  readonly decision: { readonly ok: boolean; readonly detail: string };
  readonly llm: { readonly ok: boolean; readonly detail: string };
  readonly providers: readonly string[];
  readonly defaultProvider: string;
  readonly toolCount: number;
}

/**
 * WebSocket 推送的事件（`toWireEvent()` 的输出）。
 *
 * 每个事件都带 `runId` 与 `at`；`type` 是判别字段。
 * 执行器内部事件被包在 `execution_event` 里，内层判别字段是 `innerType`。
 */
export type WireEvent =
  | { readonly runId: string; readonly at: number; readonly type: 'run_started'; readonly goal: string; readonly projectId: string }
  | { readonly runId: string; readonly at: number; readonly type: 'attempt_started'; readonly attempt: number; readonly switches: number }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: 'plan_assembled';
      readonly nodes: readonly PlanNodeSummary[];
      readonly rationale: readonly string[];
      /** 仅结构化链路（`webpage` 环境）带这个字段。 */
      readonly structure?: StructureView | undefined;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: 'execution_event';
      readonly innerType: string;
      readonly inner: Record<string, unknown>;
    }
  | { readonly runId: string; readonly at: number; readonly type: 'attempt_failed'; readonly detail: string; readonly kind: string }
  | { readonly runId: string; readonly at: number; readonly type: 'action_taken'; readonly action: string; readonly detail: string }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: 'run_finished';
      readonly status: RunStatus;
      readonly attempts: number;
      readonly durationMs: number;
    }
  /** 连上时对已结束运行补发的终态。 */
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: 'run_state';
      readonly status: RunStatus;
      readonly artifacts: readonly Artifact[];
      readonly reason?: string | undefined;
    };

/** 执行器内层事件（`execution_event.inner`）。 */export interface InnerExecutionEvent {
  readonly type: string;
  readonly nodeId?: string | undefined;
  readonly toolId?: string | undefined;
  readonly attempt?: number | undefined;
  readonly summary?: string | undefined;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly willRetry?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly status?: string | undefined;
  readonly nodeCount?: number | undefined;
  readonly at?: number | undefined;
}

/**
 * `POST /api/runs` 的受理结果。
 *
 * 202 的语义是"收下了，还没结束"，所以立刻开跑与排队都报 `queued`；
 * 区别由 `queuePosition` 说清楚——**别让人去猜自己是不是在排队**。
 */
export interface CreateRunResult {
  readonly runId: string;
  readonly status: string;
  /** 排队位次（1 起）。立刻开跑时缺省。 */
  readonly queuePosition?: number | undefined;
  readonly note?: string | undefined;
}

/** `GET /api/runs` 里带出的队列状态：同时能跑几个、现在几个在跑/在排。 */
export interface QueueSnapshot {
  readonly running: number;
  readonly waiting: number;
  readonly maxConcurrent: number;
  readonly limit: number;
}
