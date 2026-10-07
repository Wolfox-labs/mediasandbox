/** 状态与角色的统一视觉映射，避免各处各写一套颜色。 */
import type { RunStatus } from '../api/types.js';

export const STATUS_STYLE: Readonly<
  Record<RunStatus | 'unknown', { label: string; className: string; dot: string }>
> = {
  queued: { label: '排队中', className: 'bg-slate-500/15 text-slate-300', dot: 'bg-slate-400' },
  running: { label: '执行中', className: 'bg-blue-500/15 text-blue-300', dot: 'bg-blue-400 animate-pulse' },
  succeeded: { label: '成功', className: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  failed: { label: '失败', className: 'bg-rose-500/15 text-rose-300', dot: 'bg-rose-400' },
  escalated: { label: '转人工', className: 'bg-amber-500/15 text-amber-300', dot: 'bg-amber-400' },
  cancelled: { label: '已取消', className: 'bg-slate-500/15 text-slate-400', dot: 'bg-slate-500' },
  unknown: { label: '未知', className: 'bg-slate-500/15 text-slate-400', dot: 'bg-slate-500' },
};

/** 节点状态样式。 */
export const NODE_STATUS_STYLE: Readonly<
  Record<'pending' | 'running' | 'succeeded' | 'failed' | 'skipped', { label: string; className: string }>
> = {
  pending: { label: '待执行', className: 'bg-slate-500/15 text-slate-400' },
  running: { label: '执行中', className: 'bg-blue-500/15 text-blue-300' },
  succeeded: { label: '成功', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: '失败', className: 'bg-rose-500/15 text-rose-300' },
  skipped: { label: '已跳过', className: 'bg-slate-500/15 text-slate-500' },
};

/** 工具角色样式。 */
export const ROLE_STYLE: Readonly<Record<string, { label: string; className: string }>> = {
  generate: { label: '生成式', className: 'bg-violet-500/15 text-violet-300' },
  transform: { label: '变换', className: 'bg-cyan-500/15 text-cyan-300' },
  verify: { label: '校验', className: 'bg-teal-500/15 text-teal-300' },
  execute: { label: '执行', className: 'bg-orange-500/15 text-orange-300' },
};

/** 失败归类的中文名（后端 attempt_failed.kind）。 */
export const FAILURE_KIND_LABEL: Readonly<Record<string, string>> = {
  plan: '计划错误',
  tool: '工具错误',
  decision_unavailable: '决策层不可用',
  transient: '瞬时故障',
  abstained: '模型弃权',
  unknown: '未归类',
};

/** 兜底动作的中文名（后端 action_taken.action）。 */
export const FALLBACK_ACTION_LABEL: Readonly<Record<string, string>> = {
  retry: '重试',
  switch_plan: '换方案',
  escalate: '熔断转人工',
  continue: '继续',
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

/** 字节数转人类可读。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
