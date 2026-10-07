/**
 * 「项目与产物」：项目维度的文件树、导出、模板。
 *
 * 与工作台的区别是**视角**：工作台盯"这一次运行"的过程，
 * 这里盯"我这个项目攒下了什么"—— 一个项目可能跑过多次
 * （重试、换方案、改目标重来），产物要按项目归到一起看。
 *
 * 设计文档 §5.4 要求的是"文件树管理、成果导出、内置模板"，
 * 这一页对应这三项。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client.js';
import { ENV_LABELS, type EnvType } from '../../api/types.js';
import { EmptyState, Panel, Spinner, StatusBadge } from '../../ui/components.js';
import { formatBytes, formatDuration, formatTime } from '../../ui/styles.js';

/** 项目视图（`GET /api/projects`）。 */
interface ProjectRun {
  readonly id: string;
  readonly goal: string;
  readonly envType: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'escalated' | 'cancelled';
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifactCount: number;
}

interface Project {
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: ProjectRun['status'];
  readonly runCount: number;
  readonly artifactCount: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly runs: readonly ProjectRun[];
}

/**
 * 内置模板。设计文档 §5.4 说模板"同时充当决策层的默认选型起点"。
 *
 * 这里如实标注：**当前实现里模板并不充当决策起点**，只是给用户的
 * 起手式示例（对应工具 `static-page-from-template` / `template-copy`）。
 * 写明这一点比含糊过去好 —— 免得读的人以为模板参与了决策。
 */
const TEMPLATES: readonly {
  readonly id: string;
  readonly name: string;
  readonly envType: EnvType;
  readonly goal: string;
  readonly tools: string;
}[] = [
  {
    id: 'product-page',
    name: '产品介绍页',
    envType: 'frontend',
    goal: '做一个产品介绍落地页，含标题、特性列表和页脚',
    tools: 'scaffold-frontend → build-frontend',
  },
  {
    id: 'static-page',
    name: '静态页（模板路线）',
    envType: 'frontend',
    goal: '用模板生成一个简洁的静态页面',
    tools: 'static-page-from-template → build-frontend',
  },
  {
    id: 'product-copy',
    name: '产品文案',
    envType: 'copy',
    goal: '为通用 Agent 沙盒平台写一段产品介绍，面向高校竞赛评委',
    tools: 'draft-copy → refine-copy → write-file',
  },
  {
    id: 'md-doc',
    name: 'Markdown 文稿（模板路线）',
    envType: 'copy',
    goal: '写一份数字媒体竞赛的项目摘要',
    tools: 'template-copy → write-file',
  },
  {
    id: 'cover-image',
    name: '封面图',
    envType: 'image',
    goal: '生成一张科技感的作品封面图',
    tools: 'render-image',
  },
];

/** 产物节点：按 run 分组后，再按目录层级铺开。 */
interface ArtifactNode {
  readonly runId: string;
  readonly path: string;
  readonly size: number;
  readonly mimeHint: string;
}

export function ProjectManager(): ReactNode {
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [artifacts, setArtifacts] = useState<readonly ArtifactNode[]>([]);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    void api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        // 首次加载自动选中第一个项目，省一次点击。
        setSelected((prev) =>
          prev === undefined || !r.projects.some((p) => p.projectId === prev)
            ? r.projects[0]?.projectId
            : prev,
        );
      })
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 8000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const project = useMemo(
    () => projects?.find((p) => p.projectId === selected),
    [projects, selected],
  );

  // 拉该项目的全部产物（跨所有 run）。列表接口只给数量，清单要逐个 run 取。
  useEffect(() => {
    if (project === undefined) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    setLoadingArtifacts(true);
    void Promise.all(
      project.runs.map(async (run) => {
        const r = await api.listArtifacts(run.id).catch(() => ({ artifacts: [] }));
        return r.artifacts.map((a) => ({
          runId: run.id,
          path: a.path,
          size: a.size,
          mimeHint: a.mimeHint,
        }));
      }),
    )
      .then((groups) => {
        if (!cancelled) setArtifacts(groups.flat());
      })
      .finally(() => {
        if (!cancelled) setLoadingArtifacts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const onExport = (): void => {
    if (project === undefined || exporting) return;
    setExporting(true);
    setNotice(null);
    // 用浏览器原生下载：导出是 GET，直接开 URL 即可，不必先取到内存再触发下载。
    window.location.href = api.exportProjectUrl(project.projectId);
    window.setTimeout(() => {
      setExporting(false);
      setNotice('已发起下载。若产物所在沙盒已被回收，包内会缺少对应文件。');
    }, 1500);
  };

  const useTemplate = (template: (typeof TEMPLATES)[number]): void => {
    // 复制到剪贴板后让用户去工作台粘贴 —— 不做"一键直接提交"，
    // 因为提交会真实调用生成层（有成本），应当由人确认目标后再发起。
    void navigator.clipboard
      ?.writeText(template.goal)
      .then(() => setNotice(`已复制目标到剪贴板，到「创作工作台」粘贴即可（环境选 ${ENV_LABELS[template.envType].label}）`))
      .catch(() => setNotice(`目标：${template.goal}`));
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[20rem_1fr_22rem] gap-3 p-3">
      {/* ── 左：项目列表 ──────────────────────────────────────────── */}
      <Panel
        title="项目"
        className="min-h-0"
        actions={
          <button
            type="button"
            onClick={refresh}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            刷新
          </button>
        }
        bodyClassName="overflow-y-auto"
      >
        {projects === null ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">
            <Spinner /> 加载项目…
          </div>
        ) : projects.length === 0 ? (
          <EmptyState title="还没有项目" hint="到「创作工作台」提交一次目标" />
        ) : (
          <ul className="divide-y divide-ink-700">
            {projects.map((p) => (
              <li key={p.projectId}>
                <button
                  type="button"
                  onClick={() => setSelected(p.projectId)}
                  className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-ink-700/60 ${
                    p.projectId === selected ? 'bg-accent/10' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-slate-200">{p.goal}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-slate-500">
                    <span>{p.envType}</span>
                    <span>·</span>
                    <span>{p.runCount} 次运行</span>
                    <span>·</span>
                    <span>{p.artifactCount} 产物</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-slate-600">
                    最近更新 {formatTime(p.updatedAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ── 中：文件树 ────────────────────────────────────────────── */}
      <Panel
        title={project === undefined ? '项目文件' : `项目文件 · ${project.projectId}`}
        className="min-h-0"
        actions={
          project !== undefined ? (
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              className="btn-primary px-2 py-1 text-xs"
            >
              {exporting ? '打包中…' : '导出 ZIP'}
            </button>
          ) : undefined
        }
        bodyClassName="overflow-y-auto"
      >
        {project === undefined ? (
          <EmptyState title="选择左侧的一个项目" />
        ) : loadingArtifacts ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500">
            <Spinner /> 读取产物…
          </div>
        ) : artifacts.length === 0 ? (
          <EmptyState
            title="该项目还没有产物"
            hint={
              project.status === 'succeeded'
                ? '运行成功但未产出文件'
                : '等运行成功后再看'
            }
          />
        ) : (
          <div className="p-2">
            {/* 按 run 分组：多次运行的产物放在一起才不会互相掩盖 */}
            {project.runs.map((run) => {
              const own = artifacts.filter((a) => a.runId === run.id);
              if (own.length === 0) return null;
              return (
                <div key={run.id} className="mb-3">
                  <div className="mb-1 flex items-center gap-2 px-1">
                    <span className="font-mono text-[11px] text-slate-400">
                      {run.id.replace(/^run-/, '')}
                    </span>
                    <StatusBadge status={run.status} />
                    <span className="text-[11px] text-slate-600">
                      {formatTime(run.startedAt)}
                      {run.finishedAt !== undefined &&
                        ` · ${formatDuration(run.finishedAt - run.startedAt)}`}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {own.map((a) => (
                      <li
                        key={`${a.runId}-${a.path}`}
                        className="flex items-center gap-2 rounded border border-ink-700 bg-ink-900/40 px-2.5 py-1.5"
                      >
                        <span className="text-slate-500">
                          {a.mimeHint.startsWith('image/') ? '🖼' : '📄'}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">
                          {a.path}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-slate-500">
                          {formatBytes(a.size)}
                        </span>
                        <a
                          href={api.artifactUrl(a.runId, a.path)}
                          download
                          className="shrink-0 text-[11px] text-accent hover:underline"
                        >
                          下载
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* ── 右：模板 + 运行历史 ───────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="内置模板" bodyClassName="p-3">
          <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
            点一下复制目标到剪贴板，再粘到工作台。**不直接提交** ——
            提交会真实调用生成层，应当由人确认目标后再发起。
          </p>
          <ul className="space-y-1.5">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => useTemplate(t)}
                  className="w-full rounded border border-ink-600 bg-ink-900/50 px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-ink-700/50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-200">{t.name}</span>
                    <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                      {t.envType}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-slate-500">{t.goal}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-slate-600">{t.tools}</p>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-ink-700 pt-2 text-[11px] leading-relaxed text-slate-600">
            注：模板当前只作起手式，**不充当决策起点** —— 设计文档 §5.4
            曾设想让它参与选型，实际未实现。
          </p>
        </Panel>

        <Panel
          title="运行历史"
          className="min-h-0 flex-1"
          bodyClassName="overflow-y-auto p-3"
        >
          {project === undefined ? (
            <EmptyState title="—" />
          ) : (
            <ol className="space-y-2">
              {project.runs.map((run) => (
                <li key={run.id} className="rounded border border-ink-700 bg-ink-900/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-slate-300">{run.goal}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-slate-500">
                    <span>{formatTime(run.startedAt)}</span>
                    <span>·</span>
                    <span>{run.envType}</span>
                    <span>·</span>
                    <span>{run.artifactCount} 产物</span>
                    {run.finishedAt !== undefined && (
                      <>
                        <span>·</span>
                        <span>{formatDuration(run.finishedAt - run.startedAt)}</span>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      {notice !== null && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-accent/40 bg-ink-800 px-4 py-2 text-xs text-slate-200 shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}
