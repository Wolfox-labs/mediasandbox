/**
 * Agent 创作工作台：输入目标 → 看决策 → 看步骤 → 看产物。
 *
 * 这是主界面。布局刻意做成三栏，把"过程"和"结果"同时摆在眼前：
 *   左：输入与运行历史
 *   中：决策过程 + 执行步骤（本项目的差异化点）
 *   右：实时预览
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client.js';
import {
  ENV_LABELS,
  ENV_TYPES,
  isTerminal,
  type Artifact,
  type EnvType,
  type RunListItem,
} from '../../api/types.js';
import { useRunStream } from '../../hooks/useRunStream.js';
import { foldEvents } from '../../state/run-view-model.js';
import { Panel, Spinner, StatusBadge, EmptyState } from '../../ui/components.js';
import { formatTime } from '../../ui/styles.js';
import { DecisionPanel } from './DecisionPanel.js';
import { StepFlow } from './StepFlow.js';
import { PreviewPane } from '../preview/PreviewPane.js';

/** 示例目标：降低演示门槛，点一下就能跑。 */
const EXAMPLES: Readonly<Record<EnvType, readonly string[]>> = {
  copy: ['为通用 Agent 沙盒平台写一段产品介绍，面向高校竞赛评委', '写一份数字媒体竞赛的项目摘要'],
  image: ['生成一张科技感的作品封面图', '做一张产品海报底图'],
  frontend: ['做一个产品介绍落地页，含标题、特性列表和页脚', '做一个竞赛作品的展示页'],
};

export function Workbench(): ReactNode {
  const [goal, setGoal] = useState('');
  const [envType, setEnvType] = useState<EnvType>('copy');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<readonly RunListItem[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | undefined>(undefined);

  const { events, connection, reset } = useRunStream(activeRunId);
  const vm = useMemo(() => foldEvents(events), [events]);

  /** 终态到达后刷新历史与产物列表。用 ref 防重复触发。 */
  const refreshedFor = useRef<string | undefined>(undefined);

  const refreshRuns = (): void => {
    void api
      .listRuns()
      .then((r) => setRuns(r.runs))
      .catch(() => {
        /* 列表刷新失败不打断主流程 */
      });
  };

  useEffect(() => {
    refreshRuns();
  }, []);

  useEffect(() => {
    if (activeRunId === undefined) return;
    if (!isTerminal(vm.status)) return;
    if (refreshedFor.current === activeRunId) return;
    refreshedFor.current = activeRunId;
    refreshRuns();
  }, [activeRunId, vm.status]);

  // 切换运行时清掉上一次的预览选择。
  useEffect(() => {
    setSelectedArtifact(undefined);
  }, [activeRunId]);

  /**
   * 产物列表来自详情接口——`GET /api/runs` 只给数量，不给清单。
   * 只在运行进入终态后拉取：执行中的产物清单是不完整的。
   */
  const [artifactList, setArtifactList] = useState<readonly Artifact[]>([]);
  useEffect(() => {
    if (activeRunId === undefined || !isTerminal(vm.status)) {
      setArtifactList([]);
      return;
    }
    let cancelled = false;
    api
      .listArtifacts(activeRunId)
      .then((r) => {
        if (!cancelled) setArtifactList(r.artifacts);
      })
      .catch(() => {
        if (!cancelled) setArtifactList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRunId, vm.status]);

  const onSubmit = async (): Promise<void> => {
    const trimmed = goal.trim();
    if (trimmed === '' || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const { runId } = await api.createRun({ goal: trimmed, envType });
      reset();
      refreshedFor.current = undefined;
      setActiveRunId(runId);
      refreshRuns();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? `${error.message}${error.detail !== undefined ? `（${error.detail}）` : ''}`
          : String(error);
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = async (): Promise<void> => {
    if (activeRunId === undefined) return;
    try {
      await api.cancelRun(activeRunId);
      refreshRuns();
    } catch {
      /* 取消失败通常是无害的（已经结束了） */
    }
  };

  const running = vm.status === 'running' || vm.status === 'queued';

  return (
    <div className="grid h-full min-h-0 grid-cols-[19rem_1fr_26rem] gap-3 p-3">
      {/* ── 左栏：输入 + 历史 ─────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="创作目标" bodyClassName="flex flex-col gap-3 p-3">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd + Enter 提交，普通 Enter 换行。
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void onSubmit();
            }}
            rows={3}
            placeholder="描述你想做的作品…（Ctrl+Enter 提交）"
            className="field resize-none"
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">环境类型</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ENV_TYPES.map((env) => (
                <button
                  key={env}
                  type="button"
                  onClick={() => setEnvType(env)}
                  title={ENV_LABELS[env].hint}
                  className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    envType === env
                      ? 'border-accent bg-accent/15 text-white'
                      : 'border-ink-500 text-slate-400 hover:bg-ink-700'
                  }`}
                >
                  {ENV_LABELS[env].label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">{ENV_LABELS[envType].hint}</p>
          </div>

          <div className="flex flex-wrap gap-1">
            {EXAMPLES[envType].map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setGoal(example)}
                className="rounded border border-ink-600 px-2 py-1 text-[11px] text-slate-400 hover:bg-ink-700 hover:text-slate-300"
              >
                {example.slice(0, 16)}…
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={submitting || goal.trim() === ''}
              className="btn-primary flex-1"
            >
              {submitting ? <Spinner className="border-white/60" /> : '开始创作'}
            </button>
            {running && (
              <button type="button" onClick={() => void onCancel()} className="btn-ghost">
                取消
              </button>
            )}
          </div>

          {submitError !== null && (
            <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
              {submitError}
            </p>
          )}
        </Panel>

        <Panel
          title="运行历史"
          className="min-h-0 flex-1"
          actions={
            <button
              type="button"
              onClick={refreshRuns}
              className="text-[11px] text-slate-500 hover:text-slate-300"
            >
              刷新
            </button>
          }
          bodyClassName="overflow-y-auto"
        >
          {runs.length === 0 ? (
            <EmptyState title="还没有运行记录" />
          ) : (
            <ul className="divide-y divide-ink-700">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setActiveRunId(run.id)}
                    className={`w-full px-3 py-2 text-left transition-colors hover:bg-ink-700/60 ${
                      run.id === activeRunId ? 'bg-accent/10' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-slate-300">{run.goal}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-slate-500">
                      <span>{formatTime(run.startedAt)}</span>
                      <span>·</span>
                      <span>{run.envType}</span>
                      {run.artifactCount > 0 && (
                        <>
                          <span>·</span>
                          <span>{run.artifactCount} 个产物</span>
                        </>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── 中栏：决策 + 步骤 ─────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2 px-1">
          <StatusBadge status={vm.status} />
          <span
            className={`chip ${
              connection === 'open'
                ? 'bg-emerald-500/15 text-emerald-300'
                : connection === 'connecting'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-rose-500/15 text-rose-300'
            }`}
          >
            实时通道 {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中' : '已断开'}
          </span>
          {vm.finished !== undefined && (
            <span className="font-mono text-[11px] text-slate-500">
              {(vm.finished.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {vm.goal !== undefined && (
            <span className="ml-auto truncate text-xs text-slate-500" title={vm.goal}>
              {vm.goal}
            </span>
          )}
        </div>

        {vm.reason !== undefined && (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {vm.reason}
          </p>
        )}

        <Panel title="决策过程" className="min-h-0 flex-[2]" bodyClassName="min-h-0">
          <DecisionPanel attempts={vm.attempts} />
        </Panel>

        <Panel title="执行步骤" className="min-h-0 flex-[3]" bodyClassName="min-h-0">
          {vm.current === undefined ? (
            <EmptyState
              title={activeRunId === undefined ? '选择或新建一次创作' : '等待计划…'}
              hint={activeRunId === undefined ? '左侧输入目标后点「开始创作」' : undefined}
            />
          ) : (
            <StepFlow nodes={vm.current.nodes} />
          )}
        </Panel>
      </div>

      {/* ── 右栏：预览 ─────────────────────────────────────────────── */}
      <Panel
        title="实时预览"
        className="min-h-0"
        actions={
          artifactList.length > 0 ? (
            <span className="font-mono text-[11px] text-slate-500">
              {artifactList.length} 个产物
            </span>
          ) : undefined
        }
        bodyClassName="min-h-0"
      >
        <PreviewPane
          runId={activeRunId}
          artifacts={artifactList}
          selected={selectedArtifact}
          onSelect={setSelectedArtifact}
        />
      </Panel>
    </div>
  );
}
