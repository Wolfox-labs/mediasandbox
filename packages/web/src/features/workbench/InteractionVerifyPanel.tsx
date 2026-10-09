/**
 * 「交互验证」：对一次已完成的网页运行点一下真浏览器，并给出可复核的结论。
 *
 * 为什么是**按钮触发**而不是随运行自动跑：这一步要起真浏览器，耗时 3–10 秒，
 * 而大多数运行并不需要。自动跑等于给每次运行都加上这段开销。
 *
 * 三种"没通过"必须能被分辨，否则界面只能含糊地说"失败了"：
 *   - 点成了但页面没变化 → 结论是"未通过"，附上尝试记录；
 *   - 页面上没有可点元素 → 如实说"未做点击验证"，**不是失败也不是成功**；
 *   - 本机点不了（没有 Docker） → 503，界面照实说"本机点不了"。
 * 最后一种最容易做错：给它显示一个灰色的"通过"等于骗人。
 */
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client.js';
import type { InteractionVerdict } from '../../api/types.js';

/** 把 HTTP 状态翻译成"这台机器/这次运行为什么点不了"。 */
function explain(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.detail !== undefined ? `（${error.detail}）` : '';
    switch (error.status) {
      case 503:
        return `本机没有可用的点击驱动：${error.message}${detail}`;
      case 410:
        return `页面已经取不到了：${error.message}${detail}`;
      case 409:
        return `这次运行没有可点的页面：${error.message}${detail}`;
      default:
        return `${error.message}${detail}`;
    }
  }
  return String(error);
}

export function InteractionVerifyPanel({ runId }: { runId: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<InteractionVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setVerdict(null);
    try {
      setVerdict(await api.verifyInteraction(runId));
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="btn-ghost disabled:opacity-50"
        >
          {busy ? '正在点…' : '交互验证'}
        </button>
        <span className="text-[11px] text-slate-500">
          挑一个可点元素真点一下，判定变化是否发生（约 3–10 秒）
        </span>
      </div>

      {error !== null && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
          {error}
        </p>
      )}

      {verdict !== null && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={`chip ${
                verdict.passed
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : verdict.targetCount === 0
                    ? 'bg-slate-500/15 text-slate-300'
                    : 'bg-rose-500/15 text-rose-300'
              }`}
            >
              {/* 三种结论分开写：没可点元素既不是通过也不是失败。 */}
              {verdict.passed ? '通过' : verdict.targetCount === 0 ? '未做验证' : '未通过'}
            </span>
            <span className="font-mono text-[11px] text-slate-500">
              驱动 {verdict.driver}
              {verdict.placeholder ? '（占位，结论不可信）' : ''} · 候选 {verdict.targetCount} 个
            </span>
          </div>

          <p className="text-xs leading-relaxed text-slate-300">{verdict.detail}</p>

          {verdict.attempts !== undefined && verdict.attempts.length > 0 && (
            <ul className="space-y-0.5 font-mono text-[11px] text-slate-500">
              {verdict.attempts.map((line, i) => (
                <li key={i}>· {line}</li>
              ))}
            </ul>
          )}

          {verdict.screenshotPath !== undefined && (
            <a
              className="inline-block text-[11px] text-accent underline"
              href={api.artifactUrl(runId, verdict.screenshotPath)}
              target="_blank"
              rel="noreferrer"
            >
              点击后截图 {verdict.screenshotPath}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
