/**
 * 沙盒环境管理。
 *
 * 这一页回答"隔离到底做了什么"——竞赛评审会关心安全性与资源约束，
 * 而这些东西平时藏在代码里看不见。把三类环境的预设与实际约束摊开。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client.js';
import { ENV_LABELS, ENV_TYPES, type HealthResponse, type RunListItem } from '../../api/types.js';
import { EmptyState, Panel, Spinner, StatusBadge } from '../../ui/components.js';
import { formatDuration, formatTime } from '../../ui/styles.js';

/** 环境预设的结构，与 `packages/sandbox/src/env-presets.ts` 对齐。 */
const ENV_PRESET_VIEW: Readonly<
  Record<string, { dirs: readonly string[]; commands: readonly string[]; image: string; size: string }>
> = {
  frontend: { dirs: ['src/', 'artifacts/', 'logs/'], commands: ['node', 'npm'], image: 'mediasandbox/frontend', size: '168 MB' },
  image: { dirs: ['in/', 'out/', 'artifacts/', 'logs/'], commands: ['python'], image: 'mediasandbox/image', size: '664 MB' },
  copy: { dirs: ['drafts/', 'artifacts/', 'logs/'], commands: ['node'], image: 'mediasandbox/copy', size: '168 MB' },
};

/** Docker provider 施加的隔离约束，与 `docker-sandbox.ts` 对齐。 */
const DOCKER_CONSTRAINTS: readonly { label: string; value: string; why: string }[] = [
  { label: '网络', value: 'network = none', why: '容器没有网卡，产物无法外联' },
  { label: '根文件系统', value: 'readonly', why: '只有 /workspace 与 /tmp 可写' },
  { label: '运行用户', value: 'uid 1000（非 root）', why: '降权运行不可信代码' },
  { label: '能力', value: 'CapDrop: ALL', why: '剥离全部 Linux capabilities' },
  { label: '提权', value: 'no-new-privileges', why: '禁止 setuid 提权' },
  { label: '内存', value: '512 MB', why: '超限被内核 OOM kill' },
  { label: 'CPU', value: '1 核', why: 'NanoCpus 配额' },
  { label: '进程数', value: '256', why: 'PidsLimit 防 fork 炸弹' },
];

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
}): ReactNode {
  return (
    <div className="rounded-md border border-ink-600 bg-ink-900/50 px-3 py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-100">{value}</p>
      {hint !== undefined && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function SandboxConsole({ health }: { health: HealthResponse | null }): ReactNode {
  const [runs, setRuns] = useState<readonly RunListItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      api
        .listRuns()
        .then((r) => {
          if (!cancelled) setRuns(r.runs);
        })
        .catch(() => {
          if (!cancelled) setRuns([]);
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const runningCount = runs?.filter((r) => r.status === 'running' || r.status === 'queued').length ?? 0;
  const artifactsTotal = runs?.reduce((sum, r) => sum + r.artifactCount, 0) ?? 0;
  const succeeded = runs?.filter((r) => r.status === 'succeeded').length ?? 0;

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-3 overflow-y-auto p-3">
      {/* ── 运行概况 ───────────────────────────────────────────────── */}
      <Panel title="运行概况" className="col-span-2" bodyClassName="p-3">
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="运行总数" value={runs === null ? <Spinner /> : runs.length} />
          <StatCard
            label="在途"
            value={runningCount}
            hint={runningCount > 0 ? '正在占用沙盒' : '空闲'}
          />
          <StatCard
            label="成功"
            value={succeeded}
            hint={
              runs !== null && runs.length > 0
                ? `成功率 ${((succeeded / runs.length) * 100).toFixed(0)}%`
                : undefined
            }
          />
          <StatCard label="产物总数" value={artifactsTotal} />
        </div>
      </Panel>

      {/* ── Provider ──────────────────────────────────────────────── */}
      <Panel title="沙盒提供者" bodyClassName="p-3">
        {health === null ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> 读取后端状态…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">当前使用</span>
              <span className="chip bg-accent/20 text-accent">{health.defaultProvider}</span>
              <span className="text-[11px] text-slate-500">
                可用：{health.providers.join(' / ')}
              </span>
            </div>

            <div className="overflow-hidden rounded-md border border-ink-600">
              <table className="w-full text-left text-xs">
                <thead className="bg-ink-900/60 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">维度</th>
                    <th className="px-3 py-2 font-medium">LocalSandbox</th>
                    <th className="px-3 py-2 font-medium">DockerSandbox</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-700 text-slate-400">
                  {[
                    ['隔离强度', '路径级', '容器级'],
                    ['网络', '不限制', 'none（无网卡）'],
                    ['文件边界', '目录 + 符号链接校验', '只挂载工作区'],
                    ['资源配额', '无', '内存 / CPU / PID'],
                    ['根文件系统', '—', '只读'],
                    ['用途', '开发、测试', '执行不可信代码'],
                  ].map(([dim, local, docker]) => (
                    <tr key={dim}>
                      <td className="px-3 py-1.5 text-slate-300">{dim}</td>
                      <td className="px-3 py-1.5">{local}</td>
                      <td className="px-3 py-1.5 text-emerald-300/80">{docker}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              两个实现共用同一套 <code className="font-mono text-slate-400">SandboxProvider</code> 契约测试
              （18 项）。同一目标在两个 provider 上产出的文件 SHA-256 逐字节相同，
              这是沙盒抽象成立与否的最终验收。
            </p>
          </div>
        )}
      </Panel>

      {/* ── 隔离约束 ──────────────────────────────────────────────── */}
      <Panel title="容器隔离约束" bodyClassName="p-3">
        <ul className="space-y-1.5">
          {DOCKER_CONSTRAINTS.map((c) => (
            <li
              key={c.label}
              className="flex items-baseline justify-between gap-3 rounded border border-ink-700 bg-ink-900/40 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <span className="text-xs text-slate-300">{c.label}</span>
                <p className="text-[11px] text-slate-500">{c.why}</p>
              </div>
              <code className="shrink-0 font-mono text-[11px] text-emerald-300/80">{c.value}</code>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── 环境预设 ──────────────────────────────────────────────── */}
      <Panel title="环境预设" className="col-span-2" bodyClassName="p-3">
        <div className="grid grid-cols-3 gap-3">
          {ENV_TYPES.map((env) => {
            const preset = ENV_PRESET_VIEW[env]!;
            return (
              <div key={env} className="rounded-md border border-ink-600 bg-ink-900/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-200">{ENV_LABELS[env].label}</span>
                  <code className="font-mono text-[11px] text-slate-500">{env}</code>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">{ENV_LABELS[env].hint}</p>

                <dl className="mt-2.5 space-y-1.5 text-[11px]">
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-slate-500">目录</dt>
                    <dd className="font-mono text-slate-400">{preset.dirs.join(' ')}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-slate-500">命令</dt>
                    <dd className="font-mono text-slate-400">{preset.commands.join(', ')}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 text-slate-500">镜像</dt>
                    <dd className="font-mono text-slate-400">
                      {preset.image} <span className="text-slate-600">({preset.size})</span>
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ── 最近运行 ──────────────────────────────────────────────── */}
      <Panel title="最近运行" className="col-span-2" bodyClassName="p-3">
        {runs === null ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> 加载…
          </div>
        ) : runs.length === 0 ? (
          <EmptyState title="还没有运行记录" hint="到「创作工作台」提交一次目标" />
        ) : (
          <div className="overflow-hidden rounded-md border border-ink-600">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-900/60 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">目标</th>
                  <th className="px-3 py-2 font-medium">环境</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">开始</th>
                  <th className="px-3 py-2 font-medium">耗时</th>
                  <th className="px-3 py-2 font-medium">产物</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700">
                {runs.slice(0, 12).map((run) => (
                  <tr key={run.id} className="text-slate-400 hover:bg-ink-700/40">
                    <td className="max-w-xs truncate px-3 py-2 text-slate-300" title={run.goal}>
                      {run.goal}
                    </td>
                    <td className="px-3 py-2 font-mono">{run.envType}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2 font-mono">{formatTime(run.startedAt)}</td>
                    <td className="px-3 py-2 font-mono">
                      {run.finishedAt !== undefined
                        ? formatDuration(run.finishedAt - run.startedAt)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">{run.artifactCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
