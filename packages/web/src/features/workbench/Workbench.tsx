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
import { StructurePanel } from './StructurePanel.js';
import { BlockPoolPanel } from './BlockPoolPanel.js';
import { PreviewPane } from '../preview/PreviewPane.js';

/** 示例目标：降低演示门槛，点一下就能跑。 */
const EXAMPLES: Readonly<Record<EnvType, readonly string[]>> = {
  copy: ['为通用 Agent 沙盒平台写一段产品介绍，面向高校竞赛评委', '写一份数字媒体竞赛的项目摘要'],
  image: ['生成一张科技感的作品封面图', '做一张产品海报底图'],
  frontend: ['做一个产品介绍落地页，含标题、特性列表和页脚', '做一个竞赛作品的展示页'],
  webpage: [
    '做一个产品介绍落地页，含首屏、特性与行动号召',
    '做一个竞赛作品展示页，含图集与作品说明',
  ],
};

export interface WorkbenchProps {
  /**
   * 由 URL（`#workbench/<runId>`）指定的运行。
   *
   * 支持它是因为运行结果此前不可直达：刷新回空白、演示要手点、无头截图
   * 也没法指向某次运行。现在给一个 URL 就能打开同一次结果。
   */
  readonly initialRunId?: string | undefined;
}

export function Workbench({ initialRunId }: WorkbenchProps = {}): ReactNode {
  const [goal, setGoal] = useState('');
  const [envType, setEnvType] = useState<EnvType>('copy');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 提交成功但需要说明的事（例如"已排在第 N 位"）。与 error 分开，免得被当成失败。 */
  const [submitNote, setSubmitNote] = useState<string | null>(null);

  // ── 结构化制作（webpage 环境）专用输入 ────────────────────────────────
  //
  // 这几项**只在 webpage 环境提交**，其它环境带上它们没有意义，
  // 后端也不会读。放在同一个组件里而不是拆出第二个工作台，
  // 是因为"选环境"本来就是这里的一步——拆开会让用户先选页面再选环境，绕。
  const [candidateBlockIds, setCandidateBlockIds] = useState<readonly string[]>([]);
  const [maxBlocks, setMaxBlocks] = useState(6);
  const [useGenerative, setUseGenerative] = useState(false);
  const [annotate, setAnnotate] = useState(true);

  const [activeRunId, setActiveRunId] = useState<string | undefined>(initialRunId);
  const [runs, setRuns] = useState<readonly RunListItem[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<string | undefined>(undefined);

  const { events, connection, reset } = useRunStream(activeRunId);
  const vm = useMemo(() => foldEvents(events), [events]);

  // 深链进来的运行：跟进 URL 变化（同页内换 hash 时也要跟着走）。
  useEffect(() => {
    if (initialRunId !== undefined) setActiveRunId(initialRunId);
  }, [initialRunId]);

  /**
   * 选中一次运行时，把 id 写进 URL。
   *
   * 用 `replaceState` 而不是改 `location.hash`：改 hash 会触发 `hashchange`，
   * App 再把它当成"外部导航"回灌下来，来回抖动。`replaceState` 只改地址栏，
   * 不产生历史记录也不触发事件——选运行本来也不该是一次导航。
   *
   * 顺带的好处：刷新页面能回到同一次运行，链接可以直接发给别人。
   */
  const selectRun = (runId: string): void => {
    setActiveRunId(runId);
    window.history.replaceState(null, '', `#workbench/${encodeURIComponent(runId)}`);
  };

  /** 结构化链路的页面结构，由视图模型从 `plan_assembled` 事件里取。 */
  const structure = vm.structure;

  /**
   * 当前**查看的这次运行**是不是结构化链路。
   *
   * 必须看 `activeRunId` 对应那条记录，**不能看提交表单上的 `envType`**。
   * 两者是独立的：用户可能刚选了「结构化网页」但还没提交，
   * 也可能正在回看一条文案运行。用表单的值去决定右栏显示什么，
   * 会出现"看着结构化网页的运行、右栏却是 preview 且空着"这种错配
   * ——截图里就是这样：左侧环境停在「文案」，中间是网页运行。
   */
  const activeRun = runs.find((r) => r.id === activeRunId);
  const isStructuredRun = activeRun?.envType === 'webpage';
  /** 还没选运行时就按表单选的环境预览形态，避免空白。 */
  const showBlockPool = activeRunId === undefined ? envType === 'webpage' : isStructuredRun;

  /** 中间那块「页面结构」面板同理，跟着运行走。 */
  const showStructure = showBlockPool;

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
    setSubmitNote(null);
    try {
      const { runId, queuePosition } = await api.createRun({
        goal: trimmed,
        envType,
        // 结构化参数只在 webpage 环境提交。带上别的环境的参数没有意义，
        // 还会让请求体里出现一堆后端不读的字段。
        ...(envType === 'webpage'
          ? {
              candidateBlockIds: candidateBlockIds.length > 0 ? candidateBlockIds : undefined,
              maxBlocks,
              useGenerative,
              annotate,
            }
          : {}),
      });
      reset();
      refreshedFor.current = undefined;
      selectRun(runId);
      refreshRuns();
      // 排上了就说清楚排在第几位：只报"已提交"的话，用户在界面上看到
      // 一条排队中的运行却不知道要等多久，只能反复点提交。
      setSubmitNote(
        queuePosition !== undefined
          ? `已排入队列，当前第 ${queuePosition} 位；轮到时自动开始，不需要重新提交`
          : null,
      );
    } catch (error) {
      const message =
        error instanceof ApiError
          ? `${error.message}${error.detail !== undefined ? `（${error.detail}）` : ''}`
          : String(error);
      // 429 是"队列满了"，不是"参数错了"：说清楚可以稍后重试，
      // 免得用户去改一个本来没问题的目标描述。
      setSubmitError(error instanceof ApiError && error.status === 429 ? `队列已满：${message}` : message);
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

          {submitNote !== null && submitError === null && (
            <p className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1.5 text-xs text-sky-200">
              {submitNote}
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
                    onClick={() => selectRun(run.id)}
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
                      {/* 排队位次跟状态徽章一起看：光有"排队中"看不出还要等多久。 */}
                      {run.queuePosition !== undefined && (
                        <>
                          <span>·</span>
                          <span className="text-sky-300/80">队列第 {run.queuePosition} 位</span>
                        </>
                      )}
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

        {/*
          结构化链路多一块面板：**结构本身**。
          它排在这里而不是塞进"决策过程"，是因为两者回答的问题不同——
          前者是"决策层怎么选的"，后者是"选出来的结构长什么样"。
          混在一起会让结构淹没在事件流里，而结构恰恰是结构化制作的主角。
        */}
        {showStructure && (
          <Panel title="页面结构" className="min-h-0 flex-[3]" bodyClassName="min-h-0">
            <StructurePanel structure={structure} />
          </Panel>
        )}

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

      {/* ── 右栏：block 候选池（结构化）或预览 ─────────────────────── */}
      {showBlockPool ? (
        <Panel
          title="block 候选池"
          className="min-h-0"
          actions={
            <span className="text-[11px] text-slate-500">勾选后参与本次制作</span>
          }
          bodyClassName="min-h-0 overflow-y-auto"
        >
          <BlockPoolPanel
            selected={candidateBlockIds}
            onSelectionChange={setCandidateBlockIds}
            maxBlocks={maxBlocks}
            onMaxBlocksChange={setMaxBlocks}
            useGenerative={useGenerative}
            onUseGenerativeChange={setUseGenerative}
            annotate={annotate}
            onAnnotateChange={setAnnotate}
          />
        </Panel>
      ) : (
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
      )}
    </div>
  );
}
