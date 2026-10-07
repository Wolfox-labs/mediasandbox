/**
 * 「决策过程」面板：把决策层与兜底状态机的判断摊开给人看。
 *
 * 这是本项目的差异化点——普通聊天框只给结果，这里给出**为什么这样排布**：
 *   - 组装依据（rationale）：决策层选了哪个工具、为什么
 *   - 重试与换方案：失败后状态机做了什么决定
 */
import type { ReactNode } from 'react';
import type { AttemptView } from '../../state/run-view-model.js';
import { FALLBACK_ACTION_LABEL } from '../../ui/styles.js';
import { Chip, EmptyState } from '../../ui/components.js';

export function DecisionPanel({ attempts }: { attempts: readonly AttemptView[] }): ReactNode {
  if (attempts.length === 0) {
    return (
      <EmptyState
        title="尚无决策记录"
        hint="提交目标后，这里会展示决策层选择的工具与组装依据"
      />
    );
  }

  return (
    <div className="space-y-3 overflow-y-auto p-3">
      {attempts.map((attempt, index) => (
        <article key={`${attempt.attempt}-${index}`} className="rounded-md border border-ink-600 bg-ink-900/60">
          <header className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-300">
                第 {attempt.attempt} 次尝试
              </span>
              {attempt.switches > 0 && (
                <Chip className="bg-amber-500/15 text-amber-300">
                  换方案第 {attempt.switches} 次
                </Chip>
              )}
            </div>
            {attempt.status === 'failed' && (
              <span className="chip bg-rose-500/15 text-rose-300">失败</span>
            )}
          </header>

          <div className="space-y-2 px-3 py-2.5">
            {attempt.rationale.length > 0 ? (
              <ul className="space-y-1">
                {attempt.rationale.map((line, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-400">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">该次尝试没有产生组装依据</p>
            )}

            {attempt.detail !== undefined && (
              <p className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200/90">
                {attempt.detail}
              </p>
            )}
          </div>
        </article>
      ))}

      {/* 兜底动作说明：让"熔断转人工"这类结论有出处 */}
      <p className="px-1 text-[11px] leading-relaxed text-slate-500">
        兜底策略由确定性状态机执行，不依赖模型：
        {Object.entries(FALLBACK_ACTION_LABEL)
          .filter(([key]) => key !== 'continue')
          .map(([, label]) => label)
          .join(' → ')}
      </p>
    </div>
  );
}
