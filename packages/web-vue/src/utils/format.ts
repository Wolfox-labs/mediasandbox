/**
 * 展示层的统一格式化与状态映射。
 *
 * 移植自 React 版的 `ui/styles.ts`：那里把"状态 → 颜色/文案"集中映射，
 * 避免各页面各写一套，改一处就能全局一致。Vue 版沿用这个思路，
 * 但把 Tailwind 类名换成了 Naive UI 的 `type`，因为本项目在 Vue 里
 * 用的是 Naive UI 的标签体系（`NTag type="success|warning|error|info|default"`）。
 */
import type { RunStatus } from '@/api/types';

/** Naive UI 的标签类型。 */
export type NTagType = 'default' | 'error' | 'info' | 'success' | 'warning';

/** 运行状态 → 中文名 + 标签类型。 */
export const STATUS_STYLE: Readonly<
  Record<RunStatus | 'unknown', { label: string; type: NTagType }>
> = {
  queued: { label: '排队中', type: 'default' },
  running: { label: '执行中', type: 'info' },
  succeeded: { label: '成功', type: 'success' },
  failed: { label: '失败', type: 'error' },
  escalated: { label: '转人工', type: 'warning' },
  cancelled: { label: '已取消', type: 'default' },
  unknown: { label: '未知', type: 'default' }
};

/** 节点状态 → 中文名 + 标签类型。 */
export const NODE_STATUS_STYLE: Readonly<
  Record<'pending' | 'running' | 'succeeded' | 'failed' | 'skipped', { label: string; type: NTagType }>
> = {
  pending: { label: '待执行', type: 'default' },
  running: { label: '执行中', type: 'info' },
  succeeded: { label: '成功', type: 'success' },
  failed: { label: '失败', type: 'error' },
  skipped: { label: '已跳过', type: 'warning' }
};

/** 工具角色 → 中文名。 */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  generate: '生成式',
  transform: '变换',
  verify: '校验',
  execute: '执行'
};

/** 失败归类的中文名（后端 attempt_failed.kind）。 */
export const FAILURE_KIND_LABEL: Readonly<Record<string, string>> = {
  plan: '计划错误',
  tool: '工具错误',
  decision_unavailable: '决策层不可用',
  transient: '瞬时故障',
  abstained: '模型弃权',
  unknown: '未归类'
};

/** 兜底动作的中文名（后端 action_taken.action）。 */
export const FALLBACK_ACTION_LABEL: Readonly<Record<string, string>> = {
  retry: '重试',
  switch_plan: '换方案',
  escalate: '熔断转人工',
  continue: '继续'
};

/** 毫秒转人类可读。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 时间戳转 HH:MM:SS。 */
export function formatTime(ts: number | undefined): string {
  if (ts === undefined) return '—';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 时间戳转「月-日 时:分」。 */
export function formatDateTime(ts: number | undefined): string {
  if (ts === undefined) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/** 字节数转人类可读。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
