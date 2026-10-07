/**
 * 与后端 REST / WebSocket 对齐的类型定义。
 *
 * 这些形状来自 `packages/server/src/app.ts` 与 `run-store.ts`，
 * **手工保持同步**——后端是纯 TS、未导出可复用的 API schema，
 * 所以这里宁可写死也不要 `any`，字段对不上时在编译期就能发现。
 */

/** 沙盒环境类型。 */
export type EnvType = 'frontend' | 'image' | 'copy';

export const ENV_TYPES: readonly EnvType[] = ['frontend', 'image', 'copy'];

/** 环境的中文说明，界面展示用。 */
export const ENV_LABELS: Readonly<Record<EnvType, { label: string; hint: string }>> = {
  frontend: { label: '前端 / 网页', hint: '产出 HTML 页面与静态站点' },
  image: { label: '图像', hint: '产出图片类作品' },
  copy: { label: '文案', hint: '产出 Markdown 文稿' },
};

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
