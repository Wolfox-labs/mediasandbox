/**
 * 「工具链」：把决策层的候选集摊开。
 *
 * 这一页对应设计里最关键的一句话——**扩充工具链只需改注册表，不需重训模型**。
 * 所以把注册表的实际内容（每个工具的环境、角色、输入输出端口）显示出来，
 * 让人看到"模型能选的东西就是这个列表"。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client.js';
import { ENV_LABELS, ENV_TYPES, type EnvType, type ToolSpecDto } from '../../api/types.js';
import { EmptyState, Panel, Spinner } from '../../ui/components.js';
import { ROLE_STYLE } from '../../ui/styles.js';

/** 每类环境的"两条路线"说明——这是刻意的设计。 */
const ROUTE_NOTE: Readonly<Record<EnvType, { generative: string; deterministic: string }>> = {
  copy: { generative: 'draft-copy（调生成模型写）', deterministic: 'template-copy（拼 Markdown）' },
  image: { generative: 'render-image（调生成模型画）', deterministic: 'solid-image（Pillow 画纯色图）' },
  frontend: {
    generative: 'scaffold-frontend（调生成模型写 HTML）',
    deterministic: 'static-page-from-template（内置模板）',
  },
};

export function ToolCatalog(): ReactNode {
  const [tools, setTools] = useState<readonly ToolSpecDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EnvType | 'all'>('all');

  useEffect(() => {
    let cancelled = false;
    api
      .tools()
      .then((r) => {
        if (!cancelled) setTools(r.tools);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (tools === null) return [];
    if (filter === 'all') return tools;
    return tools.filter((t) => t.envTypes.includes(filter));
  }, [tools, filter]);

  /** 按角色分组展示，便于看出"生成式 / 确定性"两条路线。 */
  const grouped = useMemo(() => {
    const map = new Map<string, ToolSpecDto[]>();
    for (const tool of filtered) {
      const list = map.get(tool.category) ?? [];
      list.push(tool);
      map.set(tool.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <div className="space-y-3">
        {/* ── 说明 ─────────────────────────────────────────────────── */}
        <Panel title="候选集从哪来" bodyClassName="p-3">
          <p className="text-xs leading-relaxed text-slate-400">
            决策层**只在有限候选集里选一个值**，候选集由工具注册表按
            <code className="mx-1 font-mono text-slate-300">envType + role</code>
            现算导出。因此<span className="text-slate-200">扩充工具链 = 往注册表加一条，不需要重训模型</span>
            —— 这是该设计可维护的前提。
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {ENV_TYPES.map((env) => (
              <div key={env} className="rounded border border-ink-600 bg-ink-900/50 p-2.5">
                <p className="text-xs font-medium text-slate-300">{ENV_LABELS[env].label}</p>
                <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed">
                  <li className="text-violet-300/80">生成式：{ROUTE_NOTE[env].generative}</li>
                  <li className="text-cyan-300/80">确定性：{ROUTE_NOTE[env].deterministic}</li>
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
            两条路线是刻意设计：有两条，<code className="font-mono">choice</code> 才有真实的选择可做；
            而且生成层不可用时，确定性路线就是降级方案。
          </p>
        </Panel>

        {/* ── 筛选 ─────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-slate-500">按环境筛选</span>
          {(['all', ...ENV_TYPES] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded px-2 py-0.5 text-xs ${
                filter === key ? 'bg-accent text-white' : 'text-slate-400 hover:bg-ink-700'
              }`}
            >
              {key === 'all' ? '全部' : ENV_LABELS[key].label}
            </button>
          ))}
          {tools !== null && (
            <span className="ml-auto font-mono text-[11px] text-slate-500">
              共 {tools.length} 个工具，当前显示 {filtered.length} 个
            </span>
          )}
        </div>

        {/* ── 列表 ─────────────────────────────────────────────────── */}
        {error !== null ? (
          <Panel bodyClassName="p-6">
            <EmptyState title="读取工具清单失败" hint={error} />
          </Panel>
        ) : tools === null ? (
          <Panel bodyClassName="flex items-center justify-center p-10">
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> 加载工具清单…
            </div>
          </Panel>
        ) : (
          grouped.map(([category, list]) => (
            <Panel
              key={category}
              title={
                <span className="flex items-center gap-2">
                  <span className="font-mono text-slate-300">{category}</span>
                  <span className="text-[11px] font-normal text-slate-500">{list.length} 个</span>
                </span>
              }
              bodyClassName="p-3"
            >
              <div className="grid grid-cols-2 gap-2.5">
                {list.map((tool) => {
                  const role = ROLE_STYLE[tool.role] ?? {
                    label: tool.role,
                    className: 'bg-slate-500/15 text-slate-400',
                  };
                  return (
                    <article
                      key={tool.id}
                      className="rounded-md border border-ink-600 bg-ink-900/50 p-2.5"
                    >
                      <header className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <code className="font-mono text-xs text-slate-200">{tool.id}</code>
                          <p className="text-[11px] text-slate-400">{tool.label}</p>
                        </div>
                        <span className={`chip shrink-0 ${role.className}`}>{role.label}</span>
                      </header>

                      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                        {tool.description}
                      </p>

                      <div className="mt-2 flex flex-wrap gap-1">
                        {tool.envTypes.map((env) => (
                          <span
                            key={env}
                            className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                          >
                            {env}
                          </span>
                        ))}
                        {tool.costHint !== undefined && (
                          <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                            {tool.costHint}
                          </span>
                        )}
                      </div>

                      {(tool.inputs !== undefined || tool.outputs !== undefined) && (
                        <div className="mt-2 space-y-1 border-t border-ink-700 pt-2 font-mono text-[10px]">
                          {tool.inputs !== undefined && tool.inputs.length > 0 && (
                            <p className="text-slate-500">
                              <span className="text-slate-600">入参 </span>
                              {tool.inputs.map((p) => (
                                <span key={p.name} className="mr-1.5 text-slate-400">
                                  {p.name}
                                  {p.required ? '' : '?'}
                                  <span className="text-slate-600">:{p.type}</span>
                                </span>
                              ))}
                            </p>
                          )}
                          {tool.outputs !== undefined && tool.outputs.length > 0 && (
                            <p className="text-slate-500">
                              <span className="text-slate-600">产出 </span>
                              {tool.outputs.map((p) => (
                                <span key={p.name} className="mr-1.5 text-emerald-300/70">
                                  {p.name}
                                  <span className="text-slate-600">:{p.type}</span>
                                </span>
                              ))}
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </Panel>
          ))
        )}
      </div>
    </div>
  );
}
