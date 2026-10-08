/**
 * 模拟点击：**点哪个由决策层挑，点完算不算成功由代码判**。
 *
 * 拆成两半是有原因的：
 *
 *   - 挑目标需要"看懂页面"，那是模型的长处，也允许它挑错（挑错就是一次可观察的失败）；
 *   - 判定成功必须确定：点击前后各取一次快照，比对快照得出的结论与模型无关。
 *
 * 于是"验证"这件事不会退化成"模型说它点成功了"。
 *
 * 本文件只放**不需要浏览器**的部分（契约 + 页面内脚本 + 判定 + 占位驱动），
 * 真驱动见 `chromium-click.ts`。这样才能在没有 Docker 的机器上测判定逻辑。
 */
import type { SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { ClickTarget } from './click-targets.js';
import { DEFAULT_VIEWPORT } from './screenshot.js';

/** 点击之后我们关心的、可观察的状态。 */
export interface ClickObservation {
  /** 被选中的标签页 key（tab 类）。 */
  readonly selectedTabs?: readonly string[];
  /** 展开着的折叠项 key（accordion 类）。 */
  readonly openAccordions?: readonly string[];
  /** 表单提示是否可见（submit 类）。 */
  readonly formNoteVisible?: boolean;
}

export interface ClickRequest {
  readonly target: ClickTarget;
  readonly width: number;
  readonly height: number;
  /** 页面在工作区里的相对路径，与 `screenshot-page` 约定一致。 */
  readonly pagePath?: string | undefined;
  readonly sandbox?:
    | { readonly provider: SandboxProvider; readonly handle: SandboxHandle }
    | undefined;
}

export interface ClickResult {
  readonly target: ClickTarget;
  /** 点击前的快照。 */
  readonly before: ClickObservation;
  /** 点击后的快照。 */
  readonly after: ClickObservation;
  /** `true` = 观察到了该目标"应该发生"的变化。 */
  readonly changed: boolean;
  /** 人话结论，直接进 summary；失败时说明差在哪。 */
  readonly detail: string;
  /** 点击之后的截图（如果驱动支持），路径与截图驱动一致。 */
  readonly screenshot?: { readonly bytes: Uint8Array; readonly path: string } | undefined;
  readonly driver: string;
  /** `true` = 没真点（占位驱动），结论不可信，调用方必须照实说明。 */
  readonly placeholder: boolean;
}

export interface ClickDriver {
  readonly name: string;
  readonly placeholder: boolean;
  click(request: ClickRequest): Promise<ClickResult>;
}

/**
 * 页面内脚本：取快照 → 点击 → 再取快照，一次性带回。
 *
 * 为什么要在一个 evaluate 里做完：标签页切换、`<details>` 开合、表单提示
 * 都是同步生效的，同一次执行里前后取快照才能把"点击导致的差异"
 * 与"页面自己动"区分开。跨两次 evaluate 就可能有别的因素混进来。
 */
export function buildClickScript(target: ClickTarget): string {
  const selector = JSON.stringify(target.selector);
  const key = JSON.stringify(target.key);
  return `(() => {
  const snap = () => {
    const out = {};
    const tabs = Array.from(document.querySelectorAll('[data-ms-tab]'))
      .filter((el) => el.getAttribute('aria-selected') === 'true')
      .map((el) => el.getAttribute('data-ms-tab'));
    if (document.querySelector('[data-ms-tab]')) out.selectedTabs = tabs;
    const acc = Array.from(document.querySelectorAll('[data-ms-accordion]'))
      .filter((el) => el.hasAttribute('open'))
      .map((el) => el.getAttribute('data-ms-accordion'));
    if (document.querySelector('[data-ms-accordion]')) out.openAccordions = acc;
    const note = document.querySelector('.ms-form__note');
    if (note) out.formNoteVisible = !note.hidden;
    return out;
  };
  const el = document.querySelector(${selector});
  if (!el) return JSON.stringify({ found: false });
  const before = snap();
  el.click();
  const after = snap();
  return JSON.stringify({ found: true, key: ${key}, before, after });
})()`;
}

/**
 * 判定：看"该发生的变化"有没有发生。
 *
 * 只说"快照不同就算成功"是不够的——点错元素也可能让页面变（比如点到别的标签），
 * 所以必须核对**目标本身**的状态；反过来，只核对目标状态也不够，
 * 那会漏掉"状态本来就对、点了没反应"的情况。
 */
export function judgeClick(
  target: ClickTarget,
  before: ClickObservation,
  after: ClickObservation,
): { readonly changed: boolean; readonly detail: string } {
  switch (target.kind) {
    case 'tab': {
      const wasSelected = (before.selectedTabs ?? []).includes(target.key);
      const nowSelected = (after.selectedTabs ?? []).includes(target.key);
      if (nowSelected && !wasSelected) {
        return { changed: true, detail: `点击后标签页 ${target.key} 变为选中` };
      }
      if (wasSelected) {
        return { changed: false, detail: `标签页 ${target.key} 点击前就已经是选中状态，无法判断点击是否生效` };
      }
      return { changed: false, detail: `点击后标签页 ${target.key} 仍未选中（当前选中：${(after.selectedTabs ?? []).join('、') || '无'}）` };
    }
    case 'accordion': {
      const wasOpen = (before.openAccordions ?? []).includes(target.key);
      const nowOpen = (after.openAccordions ?? []).includes(target.key);
      if (wasOpen !== nowOpen) {
        return { changed: true, detail: `点击后折叠项 ${target.key} ${nowOpen ? '展开' : '收起'}` };
      }
      return { changed: false, detail: `折叠项 ${target.key} 的展开状态没有变化（点击前${wasOpen ? '展开' : '收起'}）` };
    }
    case 'submit': {
      const wasVisible = before.formNoteVisible === true;
      const nowVisible = after.formNoteVisible === true;
      if (nowVisible && !wasVisible) {
        return { changed: true, detail: '点击提交后表单提示变为可见' };
      }
      return { changed: false, detail: `点击提交后表单提示没有变为可见（点击前${wasVisible ? '已可见' : '隐藏'}）` };
    }
    default: {
      // 类型上是穷尽的；真出现新种类时宁可说不认识，也不要说成功。
      return { changed: false, detail: `不认识的可点元素种类：${String(target.kind)}` };
    }
  }
}

/** 页面内脚本的返回结构。 */
export interface ClickScriptResult {
  readonly found: boolean;
  readonly before?: ClickObservation | undefined;
  readonly after?: ClickObservation | undefined;
}

export function parseClickScriptResult(raw: unknown): ClickScriptResult {
  if (typeof raw !== 'string') throw new Error('点击脚本没有返回字符串结果');
  const parsed = JSON.parse(raw) as ClickScriptResult;
  if (typeof parsed.found !== 'boolean') throw new Error('点击脚本返回结构不对：缺 found');
  return parsed;
}

/**
 * 占位驱动：**不假装点过**。它存在的意义是让"没装浏览器"的环境
 * 也能把链路跑通并明确报告"这一步没有被验证"。
 */
export class PlaceholderClickDriver implements ClickDriver {
  readonly name = 'placeholder';
  readonly placeholder = true;

  async click(request: ClickRequest): Promise<ClickResult> {
    return {
      target: request.target,
      before: {},
      after: {},
      changed: false,
      detail: `占位驱动：没有真点击 ${request.target.key}，交互未经验证`,
      driver: this.name,
      placeholder: true,
    };
  }
}

export function defaultClickDriver(): ClickDriver {
  return new PlaceholderClickDriver();
}

export const CLICK_VIEWPORT = DEFAULT_VIEWPORT;
