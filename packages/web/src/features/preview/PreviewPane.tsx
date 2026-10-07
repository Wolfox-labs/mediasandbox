/**
 * 「实时预览」：按产物类型选渲染方式。
 *
 *   - 网页 → iframe（用沙盒 iframe + srcDoc 隔离，不让产物脚本碰到工作台）
 *   - 图片 → img
 *   - 文本 → 源码 / 渲染 Markdown 两种视图
 *
 * 内容通过 `fetch` 取回后渲染，而不是让 iframe 直接指向下载地址——
 * 后者会让产物页面拿到同源上下文（`/api` 就在旁边）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, isHtmlArtifact, isImageArtifact, isTextArtifact } from '../../api/client.js';
import type { Artifact } from '../../api/types.js';
import { EmptyState, Spinner } from '../../ui/components.js';
import { formatBytes } from '../../ui/styles.js';

type ViewMode = 'rendered' | 'source';

function Markdownish({ text }: { text: string }): ReactNode {
  // 极简渲染：够展示文案产物的层次，不引入 Markdown 依赖。
  const lines = text.split('\n');
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed === '') return <div key={i} className="h-1" />;
        if (trimmed.startsWith('### ')) {
          return (
            <h4 key={i} className="text-sm font-semibold text-slate-200">
              {trimmed.slice(4)}
            </h4>
          );
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h3 key={i} className="text-base font-semibold text-slate-100">
              {trimmed.slice(3)}
            </h3>
          );
        }
        if (trimmed.startsWith('# ')) {
          return (
            <h2 key={i} className="text-lg font-bold text-white">
              {trimmed.slice(2)}
            </h2>
          );
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <p key={i} className="flex gap-2 pl-2 text-sm leading-relaxed text-slate-300">
              <span className="text-accent">•</span>
              <span>{trimmed.slice(2)}</span>
            </p>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed text-slate-300">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

function ArtifactPreview({ runId, artifact }: { runId: string; artifact: Artifact }): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('rendered');

  const url = api.artifactUrl(runId, artifact.path);
  const isHtml = isHtmlArtifact(artifact);
  const isImage = isImageArtifact(artifact);
  const isText = isTextArtifact(artifact);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!isText || isImage) return;

    let cancelled = false;
    api
      .artifactText(runId, artifact.path)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [runId, artifact.path, isText, isImage]);

  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        <img
          src={url}
          alt={artifact.path}
          className="max-h-full max-w-full rounded border border-ink-600 object-contain"
        />
      </div>
    );
  }

  if (error !== null) {
    return <EmptyState title="读取产物失败" hint={error} />;
  }

  if (text === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2">
        <Spinner />
        <span className="text-sm text-slate-500">加载产物…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(isHtml || isText) && (
        <div className="flex shrink-0 items-center gap-1 border-b border-ink-600 px-3 py-1.5">
          {isHtml && (
            <button
              type="button"
              onClick={() => setMode('rendered')}
              className={`rounded px-2 py-0.5 text-xs ${
                mode === 'rendered' ? 'bg-accent text-white' : 'text-slate-400 hover:bg-ink-700'
              }`}
            >
              渲染
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode('source')}
            className={`rounded px-2 py-0.5 text-xs ${
              mode === 'source' || !isHtml ? 'bg-accent text-white' : 'text-slate-400 hover:bg-ink-700'
            }`}
          >
            源码
          </button>
          <span className="ml-auto font-mono text-[11px] text-slate-500">
            {formatBytes(artifact.size)}
          </span>
        </div>
      )}

      {isHtml && mode === 'rendered' ? (
        <iframe
          title={artifact.path}
          // 沙盒化：产物里的脚本不许访问工作台上下文。
          sandbox="allow-scripts"
          srcDoc={text}
          className="min-h-0 flex-1 bg-white"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {isHtml || artifact.mimeHint.includes('markdown') || artifact.path.endsWith('.md') ? (
            <Markdownish text={text} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-300">
              {text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function PreviewPane({
  runId,
  artifacts,
  selected,
  onSelect,
}: {
  runId: string | undefined;
  artifacts: readonly Artifact[];
  selected: string | undefined;
  onSelect: (path: string) => void;
}): ReactNode {
  if (runId === undefined || artifacts.length === 0) {
    return (
      <EmptyState
        title="暂无产物可预览"
        hint="运行成功后，这里会渲染网页、图片或文案"
      />
    );
  }

  const current = artifacts.find((a) => a.path === selected) ?? artifacts[0]!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {artifacts.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink-600 px-2 py-1.5">
          {artifacts.map((a) => (
            <button
              key={a.path}
              type="button"
              onClick={() => onSelect(a.path)}
              className={`shrink-0 rounded px-2 py-0.5 font-mono text-[11px] ${
                a.path === current.path
                  ? 'bg-accent text-white'
                  : 'text-slate-400 hover:bg-ink-700'
              }`}
            >
              {a.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ArtifactPreview runId={runId} artifact={current} />
      </div>
    </div>
  );
}
