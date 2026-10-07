/** 小组件集合。刻意保持无状态、无业务逻辑，只做展示。 */
import type { ReactNode } from 'react';
import { STATUS_STYLE, NODE_STATUS_STYLE } from './styles.js';
import type { RunStatus } from '../api/types.js';

export function StatusBadge({ status }: { status: RunStatus | 'unknown' }): ReactNode {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  return (
    <span className={`chip ${style.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

export function NodeStatusBadge({
  status,
}: {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
}): ReactNode {
  const style = NODE_STATUS_STYLE[status];
  return <span className={`chip ${style.className}`}>{style.label}</span>;
}

export function Chip({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return <span className={`chip bg-ink-600 text-slate-300 ${className}`}>{children}</span>;
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): ReactNode {
  return (
    <section className={`panel flex min-h-0 flex-col ${className}`}>
      {title !== undefined && (
        <header className="panel-header shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string | undefined }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
      <p className="text-sm text-slate-400">{title}</p>
      {hint !== undefined && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }): ReactNode {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-500 border-t-transparent ${className}`}
      role="status"
      aria-label="加载中"
    />
  );
}
