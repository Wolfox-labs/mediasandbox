/**
 * 结构面板：把"决策模型逐块决定结构"这件事**画出来**。
 *
 * ## 为什么要有这个面板
 *
 * 结构化链路最大的风险不是做不出来，而是**做出来了却看不出来它与"调一次大模型"
 * 有什么区别**。这个面板就是那个区别的可视化：
 *
 * | 展示内容 | 对应的主张 |
 * |---|---|
 * | 每一轮的提问与答案 | 结构是**逐块问出来**的，不是一次生成的 |
 * | 四个原语的标记（choice/noul/numeric/score） | 决策模型真的在决策，不是装饰 |
 * | 每轮的继续概率与判定 | "停在哪"有依据、可解释 |
 * | 块序列与状态 | 结构是数据，可枚举、可干预 |
 * | 结构评分 | `score` 原语的落点 |
 *
 * ## 关于"是概率"的显示
 *
 * 把原始概率显示出来是刻意的：它让"滞回带"这个设计变得可见——
 * 用户能看到某些轮次的判定来自确定性规则（标了"滞回带"），
 * 而不是在 0.5 上抛硬币。这比给一个漂亮的结论更有说服力。
 */
import type { ReactNode } from 'react';
import { EmptyState } from '../../ui/components.js';
import type { StructureView } from '../../api/types.js';

export type { StructureView };

/** `kind` 的中文说法。 */
const STEP_KIND_LABEL: Readonly<Record<StructureView['steps'][number]['kind'], string>> = {
  select: '选块',
  count_only: '问数量',
  quality: '评分',
};

/** 问题 id → 原语与中文说明。这是"四个原语都用上了"的直观证据。 */
const QUESTION_META: Readonly<Record<string, { primitive: string; label: string }>> = {
  next_block: { primitive: 'choice', label: '下一块放什么' },
  continue_structuring: { primitive: 'noul', label: '还要再来一块吗' },
  structure_quality: { primitive: 'score', label: '这个结构好不好' },
};

/** 原语的配色，让四个原语在界面上一眼分得开。 */
const PRIMITIVE_STYLE: Readonly<Record<string, string>> = {
  choice: 'bg-sky-500/15 text-sky-300',
  noul: 'bg-violet-500/15 text-violet-300',
  numeric: 'bg-emerald-500/15 text-emerald-300',
  score: 'bg-amber-500/15 text-amber-300',
};

/** block 状态的中文与配色。 */
const STATUS_META: Readonly<Record<string, { label: string; className: string }>> = {
  pending: { label: '待填充', className: 'bg-slate-500/15 text-slate-400' },
  filled: { label: '已填充', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: '失败', className: 'bg-rose-500/15 text-rose-300' },
  skipped: { label: '跳过', className: 'bg-slate-600/20 text-slate-500' },
};

export function StructurePanel({ structure }: { structure: StructureView | undefined }): ReactNode {
  if (structure === undefined) {
    return (
      <EmptyState
        title="还没有结构"
        hint="选择「结构化网页」环境并提交目标后，这里会显示决策模型逐块排出的页面结构"
      />
    );
  }

  const { page, steps } = structure;
  const leadStep = steps.find((s) => s.kind === 'select');

  return (
    <div className="flex min-h-0 flex-col">
      {/* ── 结构概览 ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600 px-3 py-2">
        <span className="text-xs text-slate-400">
          <strong className="text-slate-200">{page.blocks.length}</strong> 块
        </span>
        <span className="text-xs text-slate-400">
          候选中 <strong className="text-slate-200">{page.candidateBlockIds.length}</strong> 类
        </span>
        {page.qualityScore !== null && (
          <span className="text-xs text-slate-400">
            结构评分{' '}
            <strong
              className={
                page.qualityScore >= 0.7
                  ? 'text-emerald-300'
                  : page.qualityScore >= 0.4
                    ? 'text-amber-300'
                    : 'text-rose-300'
              }
            >
              {page.qualityScore.toFixed(2)}
            </strong>
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          决策 {steps.length} 轮
        </span>
      </div>

      {/* ── 块序列：结构的可视化 ─────────────────────────────────── */}
      <div className="border-b border-ink-600 px-3 py-2">
        <p className="mb-1.5 text-[11px] font-medium text-slate-500">
          页面结构（顺序即版式顺序）
        </p>
        <ol className="flex flex-wrap items-center gap-1">
          {page.blocks.map((block, i) => {
            const meta = STATUS_META[block.status] ?? STATUS_META['pending']!;
            return (
              <li key={block.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-slate-600">→</span>}
                <span
                  className="flex items-center gap-1 rounded border border-ink-600 bg-ink-700/40 px-1.5 py-0.5"
                  title={`${block.id}｜${block.slotNames.join(', ')}`}
                >
                  <span className="text-[11px] text-slate-300">{block.type}</span>
                  <span className="font-mono text-[10px] text-slate-600">{block.id}</span>
                  <span className={`chip text-[10px] ${meta.className}`}>{meta.label}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* ── 逐轮决策留痕 ─────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p className="mb-1.5 text-[11px] font-medium text-slate-500">
          逐块决策过程（生成层一次都没有决定过结构）
        </p>
        <ol className="space-y-1.5">
          {steps.map((step, i) => (
            <li
              key={`${step.round}-${step.kind}-${i}`}
              className="rounded border border-ink-700 bg-ink-800/40 px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] text-slate-600">
                  第 {step.round + 1} 轮
                </span>
                <span className="chip bg-ink-600 text-[10px] text-slate-400">
                  {STEP_KIND_LABEL[step.kind]}
                </span>

                {/* 问题 id → 原语标记。四个原语看得见，才说明它们真在用。 */}
                {step.questionIds.map((qid) => {
                  const base = qid.split(':')[0] ?? qid;
                  const meta = QUESTION_META[base];
                  const primitive =
                    meta?.primitive ?? (qid.startsWith('slot_count') ? 'numeric' : '?');
                  const slotName = qid.includes(':') ? qid.split(':')[1] : undefined;
                  return (
                    <span
                      key={qid}
                      className={`chip text-[10px] ${PRIMITIVE_STYLE[primitive] ?? 'bg-ink-600 text-slate-400'}`}
                      title={`原语 ${primitive}`}
                    >
                      {primitive}
                      <span className="ml-1 text-slate-400">
                        {meta?.label ?? `要几个${slotName !== undefined ? `（${slotName}）` : ''}`}
                      </span>
                    </span>
                  );
                })}

                {step.pickedBlockId !== null && (
                  <span className="ml-auto font-mono text-[10px] text-accent-soft">
                    {step.pickedBlockId}
                  </span>
                )}
              </div>

              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{step.rationale}</p>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-600">
                {step.continueProbability !== null && (
                  <span>是概率 {step.continueProbability.toFixed(2)}</span>
                )}
                {step.continued !== null && (
                  <span className={step.continued ? 'text-emerald-400/70' : 'text-amber-400/70'}>
                    {step.continued ? '继续' : '停止'}
                  </span>
                )}
                {Object.entries(step.counts).length > 0 && (
                  <span>
                    {Object.entries(step.counts)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' ')}
                  </span>
                )}
                {step.score !== null && <span>score {step.score.toFixed(2)}</span>}
                <span>{step.latencyMs}ms</span>
              </div>
            </li>
          ))}
        </ol>

        {leadStep === undefined && (
          <p className="mt-2 text-[11px] text-slate-500">
            这次运行没有留下选块记录（可能结构来自模板）。
          </p>
        )}
      </div>
    </div>
  );
}
