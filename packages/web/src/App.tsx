/**
 * 应用外壳：四个模块的切换。
 *
 * 刻意用极简的本地状态做路由，不引入 react-router——
 * 只有四个平级页面，没有嵌套路由与 URL 深链需求。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api/client.js';
import type { HealthResponse } from './api/types.js';
import { Workbench } from './features/workbench/Workbench.js';
import { SandboxConsole } from './features/sandbox/SandboxConsole.js';
import { ToolCatalog } from './features/tools/ToolCatalog.js';
import { ProjectManager } from './features/projects/ProjectManager.js';
import { Spinner } from './ui/components.js';

type Tab = 'workbench' | 'projects' | 'sandbox' | 'tools';

const TABS: readonly { id: Tab; label: string; hint: string }[] = [
  { id: 'workbench', label: '创作工作台', hint: '输入目标，看排布与产出' },
  { id: 'projects', label: '项目与产物', hint: '文件树、成果导出、内置模板' },
  { id: 'sandbox', label: '沙盒环境', hint: '隔离环境与资源约束' },
  { id: 'tools', label: '工具链', hint: '决策层的候选集来自这里' },
];

/**
 * 从 URL hash 解析出标签与（可选的）运行 id。
 *
 * 两种形态：
 *   `#workbench`                 只看标签
 *   `#workbench/run-2026...`     直接定位到某次运行
 *
 * 为什么要支持后者：运行结果此前**不可分享、不可直达**——
 * 刷新一下就回到空白工作台，演示时得手点一遍，无头截图也没法指向某次运行。
 * 加上之后，"把这次结果发给别人看一眼"就是给一个 URL。
 */
function readLocationFromHash(): { tab: Tab; runId: string | undefined } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const slash = raw.indexOf('/');
  const tabPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const runIdPart = slash >= 0 ? raw.slice(slash + 1) : '';
  return {
    tab: TABS.some((t) => t.id === tabPart) ? (tabPart as Tab) : 'workbench',
    runId: runIdPart === '' ? undefined : decodeURIComponent(runIdPart),
  };
}

export function App(): ReactNode {
  const initial = readLocationFromHash();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [deepLinkRunId, setDeepLinkRunId] = useState<string | undefined>(initial.runId);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // 标签与 URL hash 双向同步：这样每个页面都可被直接链接
  // （也用得上浏览器前进/后退，以及无头截图时按 URL 直达）。
  useEffect(() => {
    const onHashChange = (): void => {
      const next = readLocationFromHash();
      setTab(next.tab);
      setDeepLinkRunId(next.runId);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const selectTab = (next: Tab): void => {
    setTab(next);
    // 切标签时丢掉运行 id —— 它是工作台的概念，带到别的标签上没有意义。
    setDeepLinkRunId(undefined);
    window.location.hash = next;
  };

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      api
        .health()
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
          setHealthError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setHealth(null);
          setHealthError(error instanceof Error ? error.message : String(error));
        });
    };
    load();
    // 后端可能晚于前端启动，定期重试；成功后就慢下来。
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-ink-600 bg-ink-800 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold text-white">MediaSandbox</h1>
          <span className="text-[11px] text-slate-500">通用 Agent 沙盒基建</span>
        </div>

        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTab(t.id)}
              title={t.hint}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === t.id
                  ? 'bg-ink-600 text-white'
                  : 'text-slate-400 hover:bg-ink-700 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* 后端状态常驻右上角：演示时一眼看出链路通不通 */}
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          {health === null ? (
            healthError === null ? (
              <span className="flex items-center gap-1.5 text-slate-400">
                <Spinner /> 连接后端…
              </span>
            ) : (
              <span className="chip bg-rose-500/15 text-rose-300">
                后端未连接（请启动服务）
              </span>
            )
          ) : (
            <>
              <span
                className={`chip ${
                  health.decision.ok
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
                title={health.decision.detail}
              >
                决策层 {health.decision.ok ? '就绪' : '降级'}
              </span>
              <span
                className={`chip ${
                  health.llm.detail.includes('未配置')
                    ? 'bg-slate-500/15 text-slate-400'
                    : 'bg-emerald-500/15 text-emerald-300'
                }`}
                title={health.llm.detail}
              >
                生成层 {health.llm.detail.includes('未配置') ? '未配置' : '就绪'}
              </span>
              <span className="chip bg-ink-600 text-slate-400" title={`可用 provider: ${health.providers.join(', ')}`}>
                {health.defaultProvider}
              </span>
            </>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {tab === 'workbench' && <Workbench initialRunId={deepLinkRunId} />}
        {tab === 'projects' && <ProjectManager />}
        {tab === 'sandbox' && <SandboxConsole health={health} />}
        {tab === 'tools' && <ToolCatalog />}
      </main>
    </div>
  );
}
