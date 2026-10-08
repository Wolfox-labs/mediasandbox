/**
 * 可点元素发现：从渲染好的 HTML 里找出"点得动、且点完有可观察变化"的元素。
 *
 * 为什么单独一层：模拟点击必须先回答"点哪儿、点了应该发生什么"。
 * 如果交给模型猜 CSS 选择器，既不可复现也没法验收；
 * 这里改成从 `data-ms-*` 锚点确定性地解析出候选，
 * 模型只负责在候选里挑（决策层动作），真正的验收标准由代码写死。
 *
 * 纯字符串解析，不需要 Docker / 浏览器 —— 于是"候选对不对"这一半
 * 在没有真实驱动的环境里也能跑测试（驱动那一半见 render/click.ts）。
 */

/** 可点元素的种类。只有渲染器真的绑了行为的元素才会出现在这里。 */
export type ClickKind = 'tab' | 'accordion' | 'submit';

export interface ClickTarget {
  readonly kind: ClickKind;
  /** `data-ms-tab` 里的 block 前缀，等于外层 `data-ms-block` 的值。 */
  readonly blockId: string;
  /** 组内序号（tab/accordion）；submit 恒为 0。 */
  readonly part: number;
  /** `data-ms-*` 属性原文，如 `b2:1`；驱动侧靠它定位，别用下标。 */
  readonly key: string;
  /** 人类可读文本，给决策模型挑用。 */
  readonly label: string;
  /** CSS 选择器，直接喂给浏览器。 */
  readonly selector: string;
  /** 点击后应该发生的可观察变化（人话），同时就是验收标准。 */
  readonly effect: string;
}

const EFFECTS: Record<ClickKind, string> = {
  tab: '该标签页变为选中（aria-selected="true"），同组其他标签页取消选中，对应面板显示',
  accordion: '该折叠项切换展开状态（details 的 open 取反）',
  submit: '表单提示（.ms-form__note）由隐藏变为可见',
};

/** 属性值放进 CSS 属性选择器前转义，避免 id 里的引号/反斜杠破坏选择器。 */
export function cssAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function partOf(key: string): number {
  const [, raw] = key.split(':');
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function blockOf(key: string): string {
  return key.split(':')[0] ?? key;
}

/**
 * 按文档顺序解析全部可点元素。
 * tab 用 `<button data-ms-tab>`，accordion 用 `<details data-ms-accordion>` + `<summary>`，
 * submit 用 `<button data-ms-submit>`；与 renderer.ts 的输出一一对应。
 */
export function parseClickTargets(html: string): ClickTarget[] {
  const targets: ClickTarget[] = [];
  const tagRe = /<(button|details)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const attrs = match[2] ?? '';
    const tabKey = /data-ms-tab="([^"]*)"/.exec(attrs)?.[1];
    const accordionKey = /data-ms-accordion="([^"]*)"/.exec(attrs)?.[1];
    const submitKey = /data-ms-submit="([^"]*)"/.exec(attrs)?.[1];

    if (tabKey) {
      const close = html.indexOf('</button>', tagRe.lastIndex);
      const label = plainText(html.slice(tagRe.lastIndex, close < 0 ? undefined : close));
      targets.push({
        kind: 'tab',
        blockId: blockOf(tabKey),
        part: partOf(tabKey),
        key: tabKey,
        label,
        selector: `[data-ms-tab="${cssAttrValue(tabKey)}"]`,
        effect: EFFECTS.tab,
      });
    } else if (accordionKey) {
      const rest = html.slice(tagRe.lastIndex);
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(rest);
      targets.push({
        kind: 'accordion',
        blockId: blockOf(accordionKey),
        part: partOf(accordionKey),
        key: accordionKey,
        label: summary ? plainText(summary[1] ?? '') : '',
        selector: `[data-ms-accordion="${cssAttrValue(accordionKey)}"] > summary`,
        effect: EFFECTS.accordion,
      });
    } else if (submitKey) {
      const close = html.indexOf('</button>', tagRe.lastIndex);
      const label = plainText(html.slice(tagRe.lastIndex, close < 0 ? undefined : close));
      targets.push({
        kind: 'submit',
        blockId: blockOf(submitKey),
        part: 0,
        key: submitKey,
        label,
        selector: `[data-ms-submit="${cssAttrValue(submitKey)}"]`,
        effect: EFFECTS.submit,
      });
    }
    void tag;
  }
  return targets;
}

export function findClickTarget(targets: readonly ClickTarget[], key: string): ClickTarget | undefined {
  return targets.find((t) => t.key === key);
}

/** 决策模型的问题选项：每行"key：标签（种类，点了会怎样）"。 */
export function describeClickTargets(targets: readonly ClickTarget[]): string {
  return targets
    .map((t) => `${t.key}：${t.label || '(无文本)'}（${t.kind}；点击后 ${t.effect}）`)
    .join('\n');
}
