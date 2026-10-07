/**
 * 「执行步骤」面板：按依赖层级展示 DAG 的实时状态。
 *
 * 分层展示而不是平铺列表——同层节点是可以并发的，这个信息对理解
 * 执行器行为有意义（也解释了"为什么失败时兄弟节点会跑完"）。
 */
import type { ReactNode } from 'react';
import type { StepView } from '../../state/run-view-model.js';
import { NodeStatusBadge } from '../../ui/components.js';
import { formatDuration } from '../../ui/styles.js';

/** 按 dependsOn 计算层级。同层可并发。 */
function toLayers(nodes: readonly StepView[]): StepView[][] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const depth = new Map<string, number>();

  const compute = (node: StepView, seen: Set<string>): number => {
    const cached = depth.get(node.nodeId);
    if (cached !== undefined) return cached;
    // 环保护：计划若成环，这里不能死循环。
    if (seen.has(node.nodeId)) return 0;
    seen.add(node.nodeId);
    const parents = node.dependsOn
      .map((id) => byId.get(id))
      .filter((n): n is StepView => n !== undefined);
    const value = parents.length === 0 ? 0 : Math.max(...parents.map((p) => compute(p, seen) + 1));
    depth.set(node.nodeId, value);
    return value;
  };

  for (const node of nodes) compute(node, new Set());

  const layers: StepView[][] = [];
  for (const node of nodes) {
    const d = depth.get(node.nodeId) ?? 0;
    (layers[d] ??= []).push(node);
  }
  return layers;
}

function StepCard({ node }: { node: StepView }): ReactNode {
  return (
    <article
      className={`rounded-md border px-3 py-2 transition-colors ${
        node.status === 'running'
          ? 'border-accent/50 bg-accent/5'
          : node.status === 'failed'
            ? 'border-rose-500/40 bg-rose-500/5'
            : node.status === 'succeeded'
              ? 'border-emerald-500/25 bg-emerald-500/5'
              : 'border-ink-600 bg-ink-900/50'
      }`}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono text-xs text-slate-300">{node.nodeId}</code>
          <NodeStatusBadge status={node.status} />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-slate-500">
          {formatDuration(node.durationMs)}
        </span>
      </header>

      {node.note !== '' && <p className="mt-1 text-xs text-slate-400">{node.note}</p>}

      {node.attempts > 1 && (
        <p className="mt-1 text-[11px] text-amber-300/80">已尝试 {node.attempts} 次</p>
      )}

      {node.summary !== undefined && (
        <p className="mt-1 text-xs text-emerald-300/90">{node.summary}</p>
      )}

      {node.error !== undefined && (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-rose-500/20 bg-rose-950/30 px-2 py-1 font-mono text-[11px] leading-relaxed text-rose-200/90">
          {node.error}
        </pre>
      )}

      {node.logs.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-400">
            日志（{node.logs.length}）
          </summary>
          <ul className="mt-1 space-y-0.5">
            {node.logs.map((line, i) => (
              <li key={i} className="font-mono text-[11px] text-slate-500">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

export function StepFlow({ nodes }: { nodes: readonly StepView[] }): ReactNode {
  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-slate-500">等待计划生成…</p>
      </div>
    );
  }

  const layers = toLayers(nodes);

  return (
    <div className="space-y-3 overflow-y-auto p-3">
      {layers.map((layer, index) => (
        <div key={index}>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-500">第 {index + 1} 层</span>
            {layer.length > 1 && (
              <span className="text-[11px] text-slate-600">并发 {layer.length} 个</span>
            )}
          </div>
          <div className="space-y-2">
            {layer.map((node) => (
              <StepCard key={node.nodeId} node={node} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
