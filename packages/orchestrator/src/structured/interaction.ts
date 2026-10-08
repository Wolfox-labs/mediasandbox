/**
 * 交互验证：把"页面上点得动"这件事**跑一遍并给出可复核的结论**。
 *
 * 顺序是刻意排的：
 *
 *   1. 由页面结构**自己渲染**出 HTML（不是读旁边那个文件）——
 *      解析锚点和真正被点击的必须是同一份字节，否则
 *      "我们在验证另一个版本的页面"这种错很难被发现；
 *   2. 解析出可点元素（`click-targets.ts`）；
 *   3. 让**决策层**在候选里挑一个（它擅长挑"最值得验证"的那个）；
 *   4. 交给**真驱动**去点（`click.ts` / `chromium-click.ts`）；
 *   5. 结论由代码判定（`judgeClick`），不采信模型的说法。
 *
 * 没有可点元素时不问决策层：给它一道没有选项的题只会换来一次无意义的调用。
 */
import type { SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { DecisionClient } from '../decision/types.js';
import { askChoice } from '../decision/types.js';
import type { ClickTarget } from '../render/click-targets.js';
import { parseClickTargets } from '../render/click-targets.js';
import type { ClickDriver, ClickResult } from '../render/click.js';
import { CLICK_VIEWPORT } from '../render/click.js';
import type { PageSpec } from './page-spec.js';
import { renderPage } from './renderer.js';

/** 决策层一次能看多少候选。与 `MAX_OPTIONS_PER_QUESTION` 对齐，多出来的截断并说明。 */
const MAX_CANDIDATES = 26;
/** 候选标签截断长度：模型只需要认得出是哪个元素。 */
const LABEL_LIMIT = 40;
/** 页面在工作区里的默认相对路径，与截图工具约定一致。 */
const DEFAULT_PAGE_PATH = 'artifacts/index.html';

export interface VerifyInteractionRequest {
  readonly structure: PageSpec;
  readonly decision: DecisionClient;
  readonly driver: ClickDriver;
  readonly sandbox: { readonly provider: SandboxProvider; readonly handle: SandboxHandle };
  /** 页面在工作区里的相对路径。默认 `artifacts/index.html`。 */
  readonly pagePath?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** 决策上下文用：用户目标原文。 */
  readonly goal: string;
  readonly evidence?: readonly string[] | undefined;
}

export interface InteractionVerification {
  /** 页面上发现的可点元素（可能为空）。 */
  readonly targets: readonly ClickTarget[];
  /** 决策层挑中的那个；没有候选或弃权时为 undefined。 */
  readonly picked?: ClickTarget | undefined;
  /** 真驱动的结果；没点成时为 undefined。 */
  readonly result?: ClickResult | undefined;
  /** 人话总结，直接可以进报告。 */
  readonly detail: string;
  readonly driver: string;
  /** `true` = 没真点（占位驱动），结论不可信。 */
  readonly placeholder: boolean;
}

export async function verifyInteraction(
  request: VerifyInteractionRequest,
): Promise<InteractionVerification> {
  const html = renderPage(request.structure);
  const pagePath = request.pagePath ?? DEFAULT_PAGE_PATH;
  // 渲染结果**写回工作区**：驱动是从文件系统读页面去点的，
  // 只有把"我们解析的那份 HTML"落成文件，解析与点击才是同一份字节。
  await request.sandbox.provider.writeFile(request.sandbox.handle, pagePath, html);
  const all = parseClickTargets(html);
  if (all.length === 0) {
    return {
      targets: [],
      detail: '页面上没有可点元素（没有交互块），未做点击验证',
      driver: request.driver.name,
      placeholder: request.driver.placeholder,
    };
  }

  const candidates = all.slice(0, MAX_CANDIDATES);
  const answer = await askChoice(request.decision, {
    context: {
      goal: request.goal,
      envType: 'webpage',
      facts: {
        可点元素数: String(all.length),
        ...(all.length > candidates.length ? { 候选已截断至: String(candidates.length) } : {}),
      },
      ...(request.evidence !== undefined ? { evidence: request.evidence } : {}),
    },
    question: [
      '这是网页上可点击的元素。挑一个最值得做交互验证的（一般是主交互，比如第一个非默认标签页、折叠项或提交按钮）。',
      ...candidates.map((t) => `${t.key}：${t.label || '(无文本)'}（${t.kind}；点击后 ${t.effect}）`),
    ].join('\n'),
    options: candidates.map((t) => ({
      id: t.key,
      label: `${(t.label || '(无文本)').slice(0, LABEL_LIMIT)}（${t.kind}）`,
    })),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });

  // 弃权也要有结论：按文档顺序取第一个是确定性的兜底，并在 detail 里说清是兜底。
  const abstained = answer.value === null;
  const picked = abstained
    ? candidates[0]
    : (candidates.find((t) => t.key === answer.value) ?? candidates[0]);
  if (picked === undefined) {
    return {
      targets: all,
      detail: `发现 ${all.length} 个可点元素，但没有可用的候选`,
      driver: request.driver.name,
      placeholder: request.driver.placeholder,
    };
  }

  const viewport = {
    width: request.width ?? CLICK_VIEWPORT.width,
    height: request.height ?? CLICK_VIEWPORT.height,
  };
  const result = await request.driver.click({
    target: picked,
    width: viewport.width,
    height: viewport.height,
    ...(request.pagePath !== undefined ? { pagePath: request.pagePath } : {}),
    sandbox: request.sandbox,
  });

  const prefix = abstained ? '决策层弃权，按文档顺序取第一个候选；' : '';
  const verdict = result.changed ? '交互验证通过' : '交互验证未通过';
  const shot = result.screenshot !== undefined ? `；点击后截图 ${result.screenshot.path}` : '';
  return {
    targets: all,
    picked,
    result,
    detail: `${prefix}${verdict}：${result.detail}${shot}（驱动 ${result.driver}）`,
    driver: request.driver.name,
    placeholder: result.placeholder,
  };
}
