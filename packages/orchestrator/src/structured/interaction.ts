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
import { describeClickTargets, parseClickTargets } from '../render/click-targets.js';
import type { ClickDriver, ClickResult } from '../render/click.js';
import { CLICK_VIEWPORT } from '../render/click.js';
import type { PageSpec } from './page-spec.js';
import { renderPage } from './renderer.js';

/** 决策层一次能看多少候选。与 `MAX_OPTIONS_PER_QUESTION` 对齐，多出来的截断并说明。 */
const MAX_CANDIDATES = 26;
/** 候选标签截断长度：模型只需要认得出是哪个元素。 */
const LABEL_LIMIT = 40;
/**
 * 最多点几次。
 *
 * 2 次是刻意的：第一次给决策层挑，挑到"点了也看不出变化"的目标时再给一次机会；
 * 再多就变成拿浏览器时间碰运气了，而失败原因本来就已经写清楚了。
 */
const MAX_ATTEMPTS = 2;
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
  /** 每一次尝试的一句话记录（第一次挑错时，这里能看出发生过什么）。 */
  readonly attempts?: readonly string[] | undefined;
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
  const viewport = {
    width: request.width ?? CLICK_VIEWPORT.width,
    height: request.height ?? CLICK_VIEWPORT.height,
  };

  const tried = new Set<string>();
  const attempts: string[] = [];
  let picked: ClickTarget | undefined;
  let result: ClickResult | undefined;
  let abstained = false;
  /** 只有一个候选、压根没问过决策层——报告里要说清，别让人以为模型参与了。 */
  let noChoiceNeeded = false;

  // 决策层可能挑一个"点了也不会有变化"的目标（比如本来就选中的第一个标签页）。
  // 那是一次**可诊断的**挑错，不该把整次验证判死：换一个候选再点一次，
  // 但只多试一轮——再点下去就成了拿预算碰运气。
  for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
    const remaining = candidates.filter((t) => !tried.has(t.key));
    if (remaining.length === 0) break;

    let chosen: ClickTarget;
    if (remaining.length === 1) {
      // **只剩一个候选时不能问**：决策层的 choice 问题至少要 2 个候选
      // （`assertChoiceCriteria` 直接拒），硬问只会换来一次 422。
      // 没得挑就别假装在挑。
      chosen = remaining[0]!;
      if (round === 0) noChoiceNeeded = true;
    } else {
      const answer = await askChoice(request.decision, {
        context: {
          goal: request.goal,
          envType: 'webpage',
          facts: {
            可点元素数: String(all.length),
            ...(all.length > candidates.length ? { 候选已截断至: String(candidates.length) } : {}),
            ...(round > 0 ? { 本轮是第几次尝试: String(round + 1) } : {}),
          },
          ...(request.evidence !== undefined ? { evidence: request.evidence } : {}),
        },
        question: [
          round === 0
            ? '这是网页上可点击的元素。挑一个最值得做交互验证的（挑**当前不是默认激活状态**的那个，否则点了看不出变化）。'
            : '上一个候选点了没有可观察的变化。请在剩下的候选里再挑一个。',
          describeClickTargets(remaining),
        ].join('\n'),
        options: remaining.map((t) => ({
          id: t.key,
          label: `${(t.label || '(无文本)').slice(0, LABEL_LIMIT)}（${t.kind}${t.initiallyActive ? '，已激活' : ''}）`,
        })),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });

      // 弃权也要有结论：按文档顺序取第一个是确定性的兜底，并在 detail 里说清是兜底。
      if (round === 0) abstained = answer.value === null;
      chosen =
        answer.value === null
          ? remaining[0]!
          : (remaining.find((t) => t.key === answer.value) ?? remaining[0]!);
    }

    picked = chosen;
    tried.add(picked.key);
    result = await request.driver.click({
      target: picked,
      width: viewport.width,
      height: viewport.height,
      ...(request.pagePath !== undefined ? { pagePath: request.pagePath } : {}),
      sandbox: request.sandbox,
    });
    attempts.push(`${picked.key}（${picked.label || '无文本'}）：${result.changed ? '观察到变化' : result.detail}`);
    if (result.changed) break;
  }

  if (picked === undefined || result === undefined) {
    return {
      targets: all,
      detail: `发现 ${all.length} 个可点元素，但没有可用的候选`,
      driver: request.driver.name,
      placeholder: request.driver.placeholder,
    };
  }

  const prefix = noChoiceNeeded
    ? '页面上只有一个可点元素，没有可挑的，直接点它；'
    : abstained
      ? '决策层弃权，按文档顺序取第一个候选；'
      : '';
  // 试了几轮也照实说：只报"通过/未通过"会把"第一次挑错了"这件事藏起来。
  const triedNote = attempts.length > 1 ? `尝试 ${attempts.length} 次：${attempts.join('；')}。` : '';
  const verdict = result.changed
    ? `${prefix}交互验证通过${attempts.length > 1 ? `（第 ${attempts.length} 次尝试生效）` : ''}`
    : `${prefix}交互验证未通过`;
  const shot = result.screenshot !== undefined ? `；点击后截图 ${result.screenshot.path}` : '';
  return {
    targets: all,
    picked,
    result,
    attempts,
    detail: `${verdict}：${result.detail}${shot}（驱动 ${result.driver}）${triedNote === '' ? '' : ` ${triedNote}`}`,
    driver: request.driver.name,
    placeholder: result.placeholder,
  };
}
