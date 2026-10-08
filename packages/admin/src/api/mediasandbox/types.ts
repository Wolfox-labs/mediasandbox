/**
 * 与后端 REST / WebSocket 对齐的类型定义（MediaSandbox 管理端）。
 *
 * 从 `packages/web/src/api/types.ts` 移植而来 —— 那份是**已验证可用**的契约，
 * 后端 REST 契约稳定，所以照搬而不是重新推导。差别只在下面这几处新增：
 *
 *   - `EnvChoice` 多了 `'auto'`（目标分类交给决策层，见 F2）
 *   - `env_classified` 事件（分类留痕）
 *   - `RunRecord.structure`（结构从 P1 起就是产出）
 *   - `Artifact.settled`（交付物是否已落定副本）
 *   - 模板 / block 的写入入参（F4）
 *   - 结构编辑的 op 与结果（F5）
 *
 * 形状来自 `packages/server/src/app.ts`、`run-store.ts`、`structure-input.ts`，
 * **手工保持同步**：字段对不上时宁可编译期报错，也不要 `any` 蒙过去。
 */

/** 沙盒环境类型。`webpage` 是结构化制作，`frontend` 是整页生成。 */
export type EnvType = "frontend" | "image" | "copy" | "webpage";

/** 环境选择：`auto` 表示**由决策层判定**属于哪一类任务。 */
export type EnvChoice = EnvType | "auto";

export const ENV_TYPES: readonly EnvType[] = [
  "frontend",
  "image",
  "copy",
  "webpage"
];

export const ENV_LABELS: Readonly<Record<EnvType, { label: string; hint: string }>> = {
  frontend: { label: "前端 / 网页", hint: "产出 HTML 页面与静态站点（整页生成）" },
  image: { label: "图像", hint: "产出图片类作品" },
  copy: { label: "文案", hint: "产出 Markdown 文稿" },
  webpage: {
    label: "结构化网页",
    hint: "结构由决策模型逐块决定，可选取 block 候选集，逐块填充并组装成整页"
  }
};

export const AUTO_ENV_LABEL = {
  label: "自动判定",
  hint: "把目标交给决策层判定属于哪一类任务，并在流水里留下判定依据"
} as const;

/** 目标分类的来源：决策层判定，还是判定失败后的兜底。 */
export type EnvClassifiedSource = "decision" | "fallback";

/** block 分组。 */
export type BlockGroup = "skeleton" | "content" | "interactive";

/** block 的版式位置约束：`first` / `last` 会被规范化强制归位。 */
export type BlockPlacement = "any" | "first" | "last";

/** block 的 slot 类型。决定**由谁来填**。 */
export type SlotType =
  | "text"
  | "title"
  | "image"
  | "code"
  | "link"
  | "literal"
  | "list-text"
  | "list-image";

/** 一个具名 slot 的声明。 */
export interface SlotSpec {
  readonly name: string;
  readonly type: SlotType;
  readonly required: boolean;
  readonly description: string;
  /** `list-*` 型才有：项数区间。 */
  readonly countRange?: { readonly min: number; readonly max: number } | undefined;
}

/** block 池里的一项（`GET /api/blocks`）。 */
export interface BlockSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: BlockGroup;
  readonly groupLabel: string;
  readonly canLead: boolean;
  readonly repeatable: boolean;
  /** 版式位置约束。前端据此提示"这个块会固定在页面开头/末尾"。 */
  readonly placement: BlockPlacement;
  readonly costHint: "fast" | "medium" | "slow";
  readonly slots: readonly SlotSpec[];
}

export interface BlockGroupSummary {
  readonly id: BlockGroup;
  readonly label: string;
  readonly count: number;
}

/** 新建 block 的入参（`POST /api/blocks`）。走与内置完全相同的校验。 */
export interface BlockInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: BlockGroup;
  readonly canLead: boolean;
  readonly repeatable: boolean;
  readonly costHint?: "fast" | "medium" | "slow" | undefined;
  readonly placement?: BlockPlacement | undefined;
  readonly slots: readonly {
    readonly name: string;
    readonly type: SlotType;
    readonly description: string;
    readonly required?: boolean | undefined;
    readonly countRange?: { readonly min: number; readonly max: number } | undefined;
  }[];
}

/** 模板目录里的一项（`GET /api/templates`）。 */
export interface TemplateItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 我们提供的（true）还是从项目里沉淀的（false）。 */
  readonly builtin: boolean;
  readonly blocks: readonly { readonly type: string }[];
  /** 限定候选范围时给出；为 null 表示不限定。 */
  readonly allowedBlockIds: readonly string[] | null;
}

/** 沉淀模板的入参：给 `fromRunId`（从历史）或给 `blocks`（手工定义）。 */
export interface TemplateInput {
  readonly fromRunId?: string | undefined;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly blocks?: readonly string[] | undefined;
  readonly allowedBlockIds?: readonly string[] | undefined;
}

/** 运行状态。 */
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "escalated"
  | "cancelled";

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "escalated",
  "cancelled"
];

export function isTerminal(status: RunStatus | "unknown"): boolean {
  return status !== "unknown" && TERMINAL_STATUSES.includes(status);
}

/** 产物。`settled` 是**派生**字段（落定副本还在不在），不是存下来的。 */
export interface Artifact {
  readonly path: string;
  readonly size: number;
  readonly mimeHint: string;
  readonly settled?: boolean | undefined;
}

/** 计划节点摘要（`plan_assembled` 事件里带的裁剪版）。 */
export interface PlanNodeSummary {
  readonly id: string;
  readonly toolId: string;
  readonly note: string;
  readonly dependsOn: readonly string[];
}

/** block 在结构里的状态。 */
export type BlockStatus = "pending" | "filled" | "failed" | "skipped";

/** 结构视图里的一块。**压缩视图刻意不带 slot 内容**——见 `structure-input.ts` 的说明。 */
export interface StructureBlockView {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly slotNames: readonly string[];
}

/** 逐轮决策留痕里的一轮。 */
export interface StructureStepView {
  readonly round: number;
  readonly kind: "select" | "count_only" | "quality";
  readonly questionIds: readonly string[];
  readonly pickedBlockId: string | null;
  readonly continueProbability: number | null;
  readonly continued: boolean | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly score: number | null;
  readonly latencyMs: number;
  readonly rationale: string;
}

/**
 * 结构化链路的页面结构与逐轮留痕。
 *
 * 刻意没有每轮的**原始概率分布**：那是排查用的，几百个浮点数对界面毫无价值。
 */
export interface StructureView {
  readonly page: {
    readonly projectId: string;
    readonly goal: string;
    readonly templateId: string | null;
    readonly candidateBlockIds: readonly string[];
    readonly qualityScore: number | null;
    readonly blocks: readonly StructureBlockView[];
  };
  readonly steps: readonly StructureStepView[];
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
  /** 仅结构化链路有。**刷新后仍在**，这是持久化要解决的问题。 */
  readonly structure?: StructureView | undefined;
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
}

/** 项目内的单次运行（`GET /api/projects` 里嵌的裁剪版）。 */
export interface ProjectRunItem {
  readonly id: string;
  readonly goal: string;
  readonly envType: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifactCount: number;
}

/** 项目（`GET /api/projects`）：**项目**视角，一个项目可能跑过多次。 */
export interface ProjectItem {
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: RunStatus;
  readonly runCount: number;
  readonly artifactCount: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly runs: readonly ProjectRunItem[];
}

/** 工具规格（`GET /api/tools`）。 */
export interface ToolSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly envTypes: readonly string[];
  readonly role: "generate" | "transform" | "verify" | "execute";
  readonly category: string;
  readonly inputs?: readonly { name: string; type: string; required: boolean; description: string }[];
  readonly outputs?: readonly { name: string; type: string; required: boolean; description: string }[];
  readonly costHint?: string | undefined;
  /** 需要逐次授权的工具（例如真实生图）。成本闸门就是照它拦的。 */
  readonly requiresPermission?: boolean | undefined;
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

/** WebSocket 推送的事件（`toWireEvent()` 的输出）。 */
export type WireEvent =
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "run_started";
      readonly goal: string;
      readonly projectId: string;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "attempt_started";
      readonly attempt: number;
      readonly switches: number;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "plan_assembled";
      readonly nodes: readonly PlanNodeSummary[];
      readonly rationale: readonly string[];
      readonly structure?: StructureView | undefined;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "execution_event";
      readonly innerType: string;
      readonly inner: Record<string, unknown>;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "attempt_failed";
      readonly detail: string;
      readonly kind: string;
    }
  /** 目标分类的判定留痕（`envType: 'auto'` 时才有）。 */
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "env_classified";
      readonly envType: string;
      readonly source: EnvClassifiedSource;
      readonly detail: string;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "action_taken";
      readonly action: string;
      readonly detail: string;
    }
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "run_finished";
      readonly status: RunStatus;
      readonly attempts: number;
      readonly durationMs: number;
    }
  /** 连上时对已结束运行补发的终态。 */
  | {
      readonly runId: string;
      readonly at: number;
      readonly type: "run_state";
      readonly status: RunStatus;
      readonly artifacts: readonly Artifact[];
      readonly reason?: string | undefined;
    };

/** 执行器内层事件（`execution_event.inner`）。 */
export interface InnerExecutionEvent {
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

// ── 结构编辑（F5） ──────────────────────────────────────────────────────

/** 一个 slot 的取值。形态必须与编排层的 `SlotValue` 完全一致。 */
export type SlotValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "image"; readonly ref: string; readonly alt: string }
  | {
      readonly kind: "list-image";
      readonly refs: readonly { readonly ref: string; readonly alt: string }[];
    };

export type SlotValueMap = Readonly<Record<string, SlotValue>>;

/**
 * 结构编辑指令。
 *
 * 为什么是 op 列表而不是整份覆盖：前端拿到的是压缩视图（只有 id/type/status/slotNames），
 * 覆盖式提交会把它**没看见的** slot 内容一并抹掉，也绕过增删移的语义校验。
 */
export type StructureOp =
  | { readonly op: "append"; readonly type: string; readonly slots?: SlotValueMap; readonly status?: BlockStatus }
  | {
      readonly op: "insert";
      readonly index: number;
      readonly type: string;
      readonly slots?: SlotValueMap;
      readonly status?: BlockStatus;
    }
  | { readonly op: "remove"; readonly blockId: string }
  | { readonly op: "move"; readonly blockId: string; readonly toIndex: number }
  | {
      readonly op: "replace";
      readonly blockId: string;
      readonly patch: { readonly type?: string; readonly slots?: SlotValueMap; readonly status?: BlockStatus };
    };

/** 一次版式修正的记录。规范化不静默——改了什么必须能被读出来。 */
export interface StructureFix {
  readonly kind: "moved" | "removed";
  readonly blockId: string;
  readonly detail: string;
}
