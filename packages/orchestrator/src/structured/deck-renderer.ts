/**
 * 演示文稿渲染器：把「一页一个版式」的结构渲染成**可放映的一页一屏 HTML**。
 *
 * ## 为什么产物是 HTML 而不是 .pptx
 *
 * 说清楚，不夸大：这里产出的是 **16:9 的可放映 HTML 演示文稿**。
 *   - 直接打开就是全屏放映，方向键 / 点击翻页
 *   - 用浏览器「打印 → 另存为 PDF」得到一页一张的 PDF（`@page` 与
 *     `page-break-after` 都已经配好）
 *   - 结构另存为 `deck.json`，要转成别的格式有数据可用
 *
 * **它不是 .pptx 文件。** 做 .pptx 需要在 Node 侧拼 OOXML + ZIP，
 * 而这条链路的产物一律被当成纯文本写进沙盒，塞二进制进去会让
 * 产物收集、校验、下载三处都得改。与其做一个"名字叫 pptx、打开报错"的东西，
 * 不如把实际能用的东西做扎实，并把边界写在这里。
 *
 * ## 版式不靠模型发明
 *
 * 每页的视觉由版式自己保证（`deck-spec.ts`）。模型只选版式、填文案。
 * 理由与网页链路同一条：让生成层决定结构，正是要消灭的病根。
 *
 * ## 一页一屏 vs 滚动长页
 *
 * 幻灯片是**定尺寸**的：所有版面用 `cqw`（容器宽度百分比）做单位，
 * 于是同一份 HTML 在 13 寸笔记本和 4K 屏上比例完全一致——
 * 这就是"放映"该有的样子。用 `rem` 或 `px` 会得到一个大屏上小得看不清、
 * 小屏上挤成一团的产物。
 */
import { escapeHtml } from './renderer.js';
import { deckThemeCssVars, resolveDeckTheme } from './deck-theme.js';
import type { BlockInstance, ImageRef, PageSpec, SlotValue } from './page-spec.js';

/** 一页的版式 id。与 `BUILTIN_SLIDE_LAYOUTS` 一一对应。 */
export type SlideLayoutId =
  | 'cover'
  | 'agenda'
  | 'section'
  | 'bullets'
  | 'two-col'
  | 'quote-slide'
  | 'image-slide'
  | 'closing'
  | 'stats'
  | 'timeline'
  | 'manifesto'
  | 'image-text';

export interface RenderDeckOptions {
  /** 文档标题。省略用页面目标。 */
  readonly title?: string | undefined;
  /**
   * 主题 id（决策模型选的视觉方向）。未知 id 回落到默认主题，不抛错。
   *
   * 主题是**纯视觉参数**：认不出来最坏是"长得不像预期"，
   * 不该让整份文稿渲染不出来。
   */
  readonly themeId?: string | undefined;
}

// ── slot 取值 ───────────────────────────────────────────────────────────────

function slotOf(block: BlockInstance, name: string): SlotValue | undefined {
  return block.slots[name];
}

/** 取文本。`text` 与 `image` 都能给出字符串（后者取 alt，做图注兜底）。 */
function textOf(block: BlockInstance, name: string): string {
  const value = slotOf(block, name);
  if (value === undefined) return '';
  switch (value.kind) {
    case 'text':
      return value.text.trim();
    case 'list':
      return value.items.map((item) => item.trim()).filter((item) => item !== '').join('；');
    case 'image':
      return value.alt.trim();
    case 'list-image':
      return value.refs.map((ref) => ref.alt.trim()).filter((alt) => alt !== '').join('；');
  }
}

/** 取列表。非列表型 slot 包成单元素数组，避免调用方到处判类型。 */
function listOf(block: BlockInstance, name: string): string[] {
  const value = slotOf(block, name);
  if (value === undefined) return [];
  switch (value.kind) {
    case 'list':
      return value.items.map((item) => item.trim()).filter((item) => item !== '');
    case 'list-image':
      return value.refs.map((ref) => ref.alt.trim()).filter((alt) => alt !== '');
    case 'text':
      return value.text.trim() === '' ? [] : [value.text.trim()];
    case 'image':
      return value.ref.trim() === '' ? [] : [value.ref];
  }
}

/** 取一张图（data URI 或路径）与它的替代文本。 */
function imageOf(block: BlockInstance, name: string): { ref: string; alt: string } | null {  const value = slotOf(block, name);
  if (value === undefined) return null;
  if (value.kind === 'image') {
    return value.ref.trim() === '' ? null : { ref: value.ref, alt: value.alt };
  }
  if (value.kind === 'list-image') {
    const first: ImageRef | undefined = value.refs.find((ref) => ref.ref.trim() !== '');
    return first === undefined ? null : { ref: first.ref, alt: first.alt };
  }
  return null;
}

const inline = (text: string): string => escapeHtml(text);
const paragraphs = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${inline(line)}</p>`)
    .join('');

// ── 各版式 ──────────────────────────────────────────────────────────────────
//
// 每个函数只产出 `.slide__frame` **里面**的内容。外层的尺寸、居中、翻页
// 都由下面统一的骨架负责——版式之间因此不会各写一套定位。

type SlideRenderer = (block: BlockInstance) => string;

const renderCover: SlideRenderer = (block) => {
  const eyebrow = textOf(block, 'eyebrow');
  const title = textOf(block, 'title');
  const subtitle = textOf(block, 'subtitle');
  return (
    `<div class="sk-cover">` +
    (eyebrow === '' ? '' : `<p class="sk-cover__eyebrow">${inline(eyebrow)}</p>`) +
    `<h1 class="sk-cover__title">${inline(title)}</h1>` +
    (subtitle === '' ? '' : `<p class="sk-cover__subtitle">${paragraphs(subtitle)}</p>`) +
    `</div>`
  );
};

const renderAgenda: SlideRenderer = (block) => {
  const title = textOf(block, 'title');
  const items = listOf(block, 'items');
  const rows = items
    .map(
      (item, i) =>
        `<li class="sk-agenda__item"><span class="sk-agenda__no">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="sk-agenda__text">${inline(item)}</span></li>`,
    )
    .join('');
  return (
    `<div class="sk-agenda">` +
    `<h2 class="sk-agenda__title">${inline(title)}</h2>` +
    `<ol class="sk-agenda__list">${rows}</ol>` +
    `</div>`
  );
};

const renderSection: SlideRenderer = (block) => {
  const number = textOf(block, 'number');
  const heading = textOf(block, 'heading');
  const note = textOf(block, 'note');
  return (
    `<div class="sk-section">` +
    (number === '' ? '' : `<p class="sk-section__no">${inline(number)}</p>`) +
    `<h2 class="sk-section__heading">${inline(heading)}</h2>` +
    (note === '' ? '' : `<p class="sk-section__note">${inline(note)}</p>`) +
    `</div>`
  );
};

const renderBullets: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const lede = textOf(block, 'lede');
  const items = listOf(block, 'items');
  const rows = items
    .map((item) => `<li class="sk-bullets__item">${paragraphs(item)}</li>`)
    .join('');
  return (
    `<div class="sk-bullets">` +
    `<header class="sk-bullets__head"><h2 class="sk-bullets__title">${inline(heading)}</h2>` +
    (lede === '' ? '' : `<p class="sk-bullets__lede">${inline(lede)}</p>`) +
    `</header>` +
    `<ul class="sk-bullets__list">${rows}</ul>` +
    `</div>`
  );
};

const renderTwoCol: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const left = listOf(block, 'leftItems')
    .map((item) => `<li>${paragraphs(item)}</li>`)
    .join('');
  const right = listOf(block, 'rightItems')
    .map((item) => `<li>${paragraphs(item)}</li>`)
    .join('');
  return (
    `<div class="sk-two">` +
    `<h2 class="sk-two__title">${inline(heading)}</h2>` +
    `<div class="sk-two__grid">` +
    `<section class="sk-two__col sk-two__col--left">` +
    `<h3>${inline(textOf(block, 'leftTitle'))}</h3><ul>${left}</ul></section>` +
    `<section class="sk-two__col sk-two__col--right">` +
    `<h3>${inline(textOf(block, 'rightTitle'))}</h3><ul>${right}</ul></section>` +
    `</div></div>`
  );
};

const renderQuote: SlideRenderer = (block) => {
  const quote = textOf(block, 'quote');
  const source = textOf(block, 'source');
  return (
    `<div class="sk-quote">` +
    `<span class="sk-quote__mark" aria-hidden="true">“</span>` +
    `<blockquote class="sk-quote__body">${paragraphs(quote)}</blockquote>` +
    (source === '' ? '' : `<p class="sk-quote__source">— ${inline(source)}</p>`) +
    `</div>`
  );
};

const renderImage: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const caption = textOf(block, 'caption');
  const image = imageOf(block, 'image');
  const media =
    image === null
      ? `<div class="sk-image__placeholder">（这一页没有配图）</div>`
      : `<img class="sk-image__img" src="${escapeHtml(image.ref)}" alt="${escapeHtml(image.alt)}" />`;
  return (
    `<div class="sk-image">` +
    `<h2 class="sk-image__title">${inline(heading)}</h2>` +
    `<figure class="sk-image__figure">${media}` +
    (caption === '' ? '' : `<figcaption class="sk-image__caption">${inline(caption)}</figcaption>`) +
    `</figure></div>`
  );
};

const renderClosing: SlideRenderer = (block) => {
  const headline = textOf(block, 'headline');
  const note = textOf(block, 'note');
  const contact = textOf(block, 'contact');
  return (
    `<div class="sk-closing">` +
    `<h2 class="sk-closing__headline">${inline(headline)}</h2>` +
    (note === '' ? '' : `<p class="sk-closing__note">${paragraphs(note)}</p>`) +
    (contact === '' ? '' : `<p class="sk-closing__contact">${inline(contact)}</p>`) +
    `</div>`
  );
};

/**
 * 把「数字|说明」这类条目拆成两段。
 *
 * 数据页与时间线都靠这个约定：**模型不用懂结构，只要按 `数字|说明` 写**。
 * 分隔符认 `|` / 全角 `｜` / 冒号；都没有时按第一个空格拆，
 * 再不行就整段当"大字号部分"、说明留空——总比把整句塞进 7cqw 的字里好。
 */
function splitHeadTail(item: string): { head: string; tail: string } {
  const looksNumeric = (value: string): boolean => /[\d%％]|(\d+(\.\d+)?\s*[xX倍])/.test(value);
  const matched = /^(.{1,20}?)\s*[|｜:：]\s*(.+)$/.exec(item);
  if (matched !== null) {
    const head = matched[1]!.trim();
    const tail = matched[2]!.trim();
    // 模型经常把顺序写反（"协作工具使用率 35%"）。数字那一段才是该放大的那一段，
    // 所以这里按"谁像数字"决定，而不是按它写在前面还是后面。
    return looksNumeric(head) || !looksNumeric(tail) ? { head, tail } : { head: tail, tail: head };
  }
  const parts = item.trim().split(/\s+/);
  if (parts.length > 1) {
    const first = parts[0]!;
    const rest = parts.slice(1).join(' ');
    return looksNumeric(first) || !looksNumeric(rest) ? { head: first, tail: rest } : { head: rest, tail: first };
  }
  return { head: item.trim(), tail: '' };
}

const renderStats: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const metrics = listOf(block, 'metrics');
  const cells = metrics
    .map((metric) => {
      const { head, tail } = splitHeadTail(metric);
      return (
        `<div class="sk-stats__item">` +
        `<div class="sk-stats__value">${inline(head)}</div>` +
        (tail === '' ? '' : `<div class="sk-stats__label">${inline(tail)}</div>`) +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="sk-stats">` +
    `<h2 class="sk-stats__title">${inline(heading)}</h2>` +
    `<div class="sk-stats__grid" style="--sk-cols:${Math.min(Math.max(metrics.length, 1), 4)}">${cells}</div>` +
    `</div>`
  );
};

const renderTimeline: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const phases = listOf(block, 'phases');
  const nodes = phases
    .map((phase) => {
      const { head, tail } = splitHeadTail(phase);
      return (
        `<div class="sk-timeline__node">` +
        `<div class="sk-timeline__dot"></div>` +
        `<div class="sk-timeline__when">${inline(head)}</div>` +
        (tail === '' ? '' : `<div class="sk-timeline__what">${inline(tail)}</div>`) +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="sk-timeline">` +
    `<h2 class="sk-timeline__title">${inline(heading)}</h2>` +
    `<div class="sk-timeline__track">${nodes}</div>` +
    `</div>`
  );
};

const renderManifesto: SlideRenderer = (block) => {
  const lines = listOf(block, 'lines');
  const note = textOf(block, 'note');
  const body = lines.map((line) => `<p class="sk-manifesto__line">${inline(line)}</p>`).join('');
  return (
    `<div class="sk-manifesto">${body}` +
    (note === '' ? '' : `<p class="sk-manifesto__note">${inline(note)}</p>`) +
    `</div>`
  );
};

const renderImageText: SlideRenderer = (block) => {
  const image = imageOf(block, 'image');
  const items = listOf(block, 'items')
    .map((item) => `<li>${paragraphs(item)}</li>`)
    .join('');
  const media =
    image === null
      ? `<div class="sk-split__media-art" aria-hidden="true"></div>`
      : `<img src="${escapeHtml(image.ref)}" alt="${escapeHtml(image.alt)}" />`;
  return (
    `<div class="sk-split">` +
    `<div class="sk-split__media">${media}</div>` +
    `<div class="sk-split__body">` +
    `<h2 class="sk-split__title">${inline(textOf(block, 'heading'))}</h2>` +
    `<ul class="sk-split__items">${items}</ul>` +
    `</div></div>`
  );
};

/** 版式 id → 渲染函数。找不到时走兜底，而不是抛错——渲染一页失败不该毁掉整份文稿。 *//**
 * 每页的视觉调性。
 *
 * 为什么需要它：六页全是同一块深蓝底，看三页就疲劳——那正是"画面单一"的
 * 直接来源。调性只做一件事：让**底色与装饰的强度**在页与页之间有起伏，
 * 而不增加任何新结构：
 *
 *   - `accent` 强调页（封面/章节/主张/引用/结尾）：底色带主题色的斜向渐变
 *   - `tinted` 信息页（数据/时间线/图文）：底部强调线加粗，装饰更实
 *   - `plain`  阅读页（目录/要点）：装饰最弱，留给文字
 *
 * 规律是**由版式决定的**，不是随机：同一份结构重渲染永远得到同一个样子。
 */
function toneForLayout(type: string): 'plain' | 'tinted' | 'accent' {
  if (['cover', 'section', 'manifesto', 'quote-slide', 'closing'].includes(type)) return 'accent';
  if (['stats', 'timeline', 'image-text'].includes(type)) return 'tinted';
  return 'plain';
}

/** 版式 id → 渲染函数。找不到时走兜底，而不是抛错——渲染一页失败不该毁掉整份文稿。 */
/**
 * 图表页：把「标签|数值」画成**内联 SVG 柱状图**。
 *
 * 为什么是 SVG：产物必须自包含、断网可看；SVG 是文本、打印成 PDF 仍是矢量，
 * 也不需要任何外部库。读不出数字的条目直接丢弃并**不画空柱**——
 * 画一根 0 高度的柱子比不画更误导。
 */
const renderChart: SlideRenderer = (block) => {
  const heading = textOf(block, 'heading');
  const note = textOf(block, 'note');
  const rows = listOf(block, 'bars')
    .map((raw) => {
      const { head, tail } = splitHeadTail(raw);
      const label = /[\d%]/.test(head) ? tail : head;
      const numRaw = /[\d%]/.test(head) ? head : tail;
      const value = Number.parseFloat(numRaw.replace(/[^\d.]/g, ''));
      return { label: label === '' ? raw : label, value: Number.isFinite(value) ? value : Number.NaN };
    })
    .filter((row) => Number.isFinite(row.value) && row.value > 0);
  if (rows.length === 0) {
    return `<div class="sk-chart"><h2 class="sk-chart__title">${inline(heading)}</h2></div>`;
  }
  const max = Math.max(...rows.map((row) => row.value));
  const W = 1000;
  const H = 320;
  const gap = 26;
  const barW = (W - gap * (rows.length - 1)) / rows.length;
  const bars = rows
    .map((row, i) => {
      const h = Math.max(6, (row.value / max) * (H - 44));
      const x = i * (barW + gap);
      const y = H - h - 30;
      return (
        `<rect class="sk-chart__bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="6" />` +
        `<text class="sk-chart__val" x="${(x + barW / 2).toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle">${inline(String(row.value))}</text>` +
        `<text class="sk-chart__label" x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${inline(row.label)}</text>`
      );
    })
    .join('');
  return (
    `<div class="sk-chart">` +
    `<h2 class="sk-chart__title">${inline(heading)}</h2>` +
    `<svg class="sk-chart__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(heading)}">${bars}</svg>` +
    (note === '' ? '' : `<p class="sk-chart__note">${inline(note)}</p>`) +
    `</div>`
  );
};

const RENDERERS: Readonly<Record<string, SlideRenderer>> = {
  cover: renderCover,
  agenda: renderAgenda,
  section: renderSection,
  bullets: renderBullets,
  'two-col': renderTwoCol,
  'quote-slide': renderQuote,
  'image-slide': renderImage,
  closing: renderClosing,
  stats: renderStats,
  timeline: renderTimeline,
  manifesto: renderManifesto,
  'image-text': renderImageText,
  chart: renderChart,
};

/**
 * 未知版式的兜底：把这一页上**所有非空 slot** 原样列出来。
 *
 * 为什么是"列出来"而不是报错：结构可能来自历史运行或用户手改，
 * 一个已停用的版式不该让整份文稿渲染不出来。列出来至少内容还在，
 * 而且一眼就能看出"这页没版式"。
 */
const renderFallback: SlideRenderer = (block) => {
  const rows: string[] = [];
  for (const [name, value] of Object.entries(block.slots)) {
    const text =
      value.kind === 'text'
        ? value.text
        : value.kind === 'list'
          ? value.items.join('；')
          : value.kind === 'image'
            ? value.alt
            : value.refs.map((ref) => ref.alt).join('；');
    if (text.trim() === '') continue;
    rows.push(`<li><strong>${inline(name)}</strong>：${inline(text)}</li>`);
  }
  return (
    `<div class="sk-fallback"><h2>${inline(block.type)}</h2>` +
    (rows.length === 0 ? `<p>（这一页没有内容）</p>` : `<ul>${rows.join('')}</ul>`) +
    `</div>`
  );
};

function renderSlide(block: BlockInstance): string {
  const renderer = RENDERERS[block.type] ?? renderFallback;
  return renderer(block);
}

// ── 样式 ────────────────────────────────────────────────────────────────────

/**
 * 整份文稿的样式。
 *
 * 单位一律用 `cqw`：它相对 `.slide__frame` 的宽度，而 `.slide__frame` 保 16:9。
 * 于是"版面比例"和"屏幕尺寸"彻底解耦——这才是幻灯片该有的行为。
 */
const DECK_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#101216;color:#f5f6f8;font-family:"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.deck{min-height:100vh;display:flex;flex-direction:column}
.deck__nav{display:flex;gap:.4rem;justify-content:center;align-items:center;padding:.7rem .8rem;flex-wrap:wrap;background:#101216;position:sticky;top:0;z-index:5}
.deck__dot{width:2.1rem;height:2.1rem;border-radius:.55rem;border:1px solid #303540;background:#1a1d23;color:#9aa3b2;font-size:.86rem;line-height:1;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.deck__dot:hover{background:#23272f;color:#e8ebf0}
.deck__dot[aria-selected="true"]{background:#3b6df5;border-color:#3b6df5;color:#fff}
.deck__dot:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.deck__stage{flex:1;display:flex;align-items:center;justify-content:center;padding:1rem}
.slide{display:none;width:100%;justify-content:center}
.slide[hidden]{display:none}
.slide:not([hidden]){display:flex}
.slide__frame{position:relative;width:min(100%,1280px);aspect-ratio:16/9;container-type:inline-size;overflow:hidden;border-radius:.6rem;background:#fff;color:#15181f;box-shadow:0 18px 60px rgba(0,0,0,.45)}
.deck__hud{display:flex;justify-content:center;padding:0 0 1rem}
.deck__counter{font-size:.82rem;letter-spacing:.08em;color:#7b8494}
.deck__meta{position:absolute;right:1.6cqw;bottom:1.2cqw;font-size:1.1cqw;color:#8b93a1}

/* 封面 */
.sk-cover{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:1.6cqw;padding:0 9cqw;background:linear-gradient(135deg,#151a24 0%,#1f2a3d 55%,#28364e 100%);color:#fff}
.sk-cover__eyebrow{margin:0;font-size:1.5cqw;letter-spacing:.24em;text-transform:uppercase;color:#8fb0ff}
.sk-cover__title{margin:0;font-size:6.6cqw;line-height:1.12;font-weight:700;letter-spacing:-.01em}
.sk-cover__subtitle{margin:0;font-size:2.15cqw;line-height:1.6;color:#c3ccdb;max-width:74%}
.sk-cover__subtitle p{margin:0}

/* 目录 */
.sk-agenda{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:2.4cqw;padding:6cqw 8cqw}
.sk-agenda__title{margin:0;font-size:4cqw;font-weight:700}
.sk-agenda__list{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:1.1cqw 3cqw}
.sk-agenda__item{display:flex;align-items:baseline;gap:1.1cqw;font-size:2.1cqw;line-height:1.45;border-bottom:1px solid #e6e9ef;padding-bottom:.7cqw}
.sk-agenda__no{font-size:1.35cqw;font-weight:700;color:#3b6df5;font-variant-numeric:tabular-nums}
.sk-agenda__text{color:#252a34}

/* 章节分隔 */
.sk-section{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:1.4cqw;padding:0 10cqw;background:#f4f6fa}
.sk-section__no{margin:0;font-size:9cqw;line-height:1;font-weight:800;color:#d7ddea}
.sk-section__heading{margin:0;font-size:4.6cqw;font-weight:700;color:#15181f}
.sk-section__note{margin:0;font-size:1.9cqw;color:#5a6274}

/* 要点 */
.sk-bullets{position:absolute;inset:0;display:flex;flex-direction:column;padding:6cqw 8cqw;gap:2.6cqw}
.sk-bullets__head{display:flex;flex-direction:column;gap:1cqw;border-left:.55cqw solid #3b6df5;padding-left:2cqw}
.sk-bullets__title{margin:0;font-size:3.6cqw;font-weight:700;line-height:1.2}
.sk-bullets__lede{margin:0;font-size:1.9cqw;color:#5a6274}
.sk-bullets__list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:1.35cqw}
.sk-bullets__item{position:relative;padding-left:3.2cqw;font-size:2.05cqw;line-height:1.55;color:#252a34}
.sk-bullets__item::before{content:"";position:absolute;left:.6cqw;top:.85cqw;width:1.05cqw;height:1.05cqw;border-radius:50%;background:#3b6df5}
.sk-bullets__item p{margin:0}

/* 两栏 */
.sk-two{position:absolute;inset:0;display:flex;flex-direction:column;gap:2.4cqw;padding:6cqw 8cqw}
.sk-two__title{margin:0;font-size:3.5cqw;font-weight:700}
.sk-two__grid{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:2.4cqw;min-height:0}
.sk-two__col{border-radius:.7cqw;padding:2.4cqw 2.6cqw;display:flex;flex-direction:column;gap:1.2cqw;overflow:hidden}
.sk-two__col h3{margin:0;font-size:2.3cqw;font-weight:700}
.sk-two__col ul{margin:0;padding-left:2.4cqw;display:flex;flex-direction:column;gap:.9cqw}
.sk-two__col li{font-size:1.85cqw;line-height:1.5}
.sk-two__col li p{margin:0}
.sk-two__col--left{background:#f1f4f9;color:#252a34}
.sk-two__col--left h3{color:#0f62d6}
.sk-two__col--right{background:#eef7f1;color:#252a34}
.sk-two__col--right h3{color:#12774a}

/* 引用 */
.sk-quote{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 11cqw;gap:1.2cqw;background:#fffdf7}
.sk-quote__mark{font-size:13cqw;line-height:.6;color:#e8d9b0;font-family:Georgia,serif}
.sk-quote__body{margin:0;font-size:3.1cqw;line-height:1.45;font-weight:600;color:#1d2027}
.sk-quote__body p{margin:0 0 .5cqw}
.sk-quote__source{margin:0;font-size:1.7cqw;color:#6b7280}

/* 图文 */
.sk-image{position:absolute;inset:0;display:flex;flex-direction:column;padding:5cqw 7cqw;gap:1.6cqw}
.sk-image__title{margin:0;font-size:3.2cqw;font-weight:700}
.sk-image__figure{margin:0;flex:1;position:relative;min-height:0;border-radius:.8cqw;overflow:hidden;background:#eef1f6}
.sk-image__img{width:100%;height:100%;object-fit:cover;display:block}
.sk-image__placeholder{display:flex;align-items:center;justify-content:center;height:100%;font-size:1.8cqw;color:#9aa3b2}
.sk-image__caption{position:absolute;left:0;right:0;bottom:0;margin:0;padding:1.4cqw 1.8cqw;font-size:1.45cqw;color:#fff;background:linear-gradient(transparent,rgba(10,12,16,.78))}

/* 结尾 */
.sk-closing{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;gap:1.6cqw;padding:0 10cqw;background:linear-gradient(160deg,#1b2130,#2b3a55)}
.sk-closing__headline{margin:0;font-size:4.4cqw;font-weight:700;line-height:1.2;color:#fff}
.sk-closing__note{margin:0;font-size:1.95cqw;color:#c3ccdb;max-width:80%}
.sk-closing__note p{margin:0}
.sk-closing__contact{margin:1.6cqw 0 0;font-size:1.6cqw;letter-spacing:.06em;color:#8fb0ff}

/* 未知版式兜底 */
.sk-fallback{position:absolute;inset:0;padding:6cqw 8cqw;overflow:auto}
.sk-fallback h2{margin:0 0 1.6cqw;font-size:3cqw}
.sk-fallback ul{margin:0;padding-left:2.4cqw;display:flex;flex-direction:column;gap:.9cqw}
.sk-fallback li{font-size:1.75cqw;line-height:1.5;color:#252a34}

/* 标注：页脚写清"第几页 / 共几页"与版式，便于排查 */
.deck__anno{position:absolute;left:1.6cqw;bottom:1.2cqw;font-size:1.05cqw;color:#aab2c0}

/* ── 主题联动 ────────────────────────────────────────────────────────────
 *
 * 上面每个版式写的是**尺度**（cqw 字号、间距、栅格）与**默认色**；
 * 主题只在下面这一层覆盖"色 + 字体 + 内边距 + 圆角"。
 *
 * 为什么用后置覆盖、而不是把上面全部改成 var()：
 * 版式样式是稳定的，改它容易调坏；主题是变量，会一直加。
 * 把两者分成两层之后，**加主题永远不用回头改版式**，
 * 也不会出现"4 主题 × 12 版式 = 48 份要各自维护的样式"。
 */
.slide__frame{background:var(--sk-bg,#fff);color:var(--sk-fg,#15181f);border-radius:var(--sk-radius,.6cqw)}
.sk-cover,.sk-agenda,.sk-section,.sk-bullets,.sk-two,.sk-quote,.sk-image,.sk-closing{
  padding:var(--sk-pad-y,6cqw) var(--sk-pad-x,8cqw);background:transparent;color:inherit;
}
.sk-section,.sk-quote{background:var(--sk-surface,#f4f6fa)}
.sk-cover__eyebrow{color:var(--sk-accent,#8fb0ff)}
.sk-cover__subtitle{color:var(--sk-muted,#c3ccdb)}
.sk-agenda__no{color:var(--sk-accent,#3b6df5)}
.sk-agenda__item{border-bottom:1px solid var(--sk-surface,#e6e9ef)}
.sk-agenda__text{color:inherit}
.sk-section__no{color:var(--sk-accent,#d7ddea);opacity:.3}
.sk-section__heading{color:inherit}
.sk-section__note{color:var(--sk-muted,#5a6274)}
.sk-bullets__head{border-left-color:var(--sk-accent,#3b6df5)}
.sk-bullets__lede{color:var(--sk-muted,#5a6274)}
.sk-bullets__item{color:inherit}
.sk-bullets__item::before{background:var(--sk-accent,#3b6df5)}
.sk-two__col--left{background:var(--sk-surface,#f1f4f9);color:inherit;border-left:.4cqw solid var(--sk-accent,#3b6df5)}
.sk-two__col--right{background:transparent;color:inherit;border:1px solid var(--sk-surface,#eef7f1)}
.sk-two__col--left h3,.sk-two__col--right h3{color:var(--sk-accent,#0f62d6)}
.sk-quote__mark{color:var(--sk-accent,#e8d9b0);opacity:.38}
.sk-quote__body{color:inherit}
.sk-quote__source{color:var(--sk-muted,#6b7280)}
.sk-image__figure{background:var(--sk-surface,#eef1f6);border-radius:var(--sk-radius,.8cqw)}
.sk-image__placeholder{color:var(--sk-muted,#9aa3b2)}
.sk-closing{background:transparent;color:inherit}
.sk-closing__headline{color:inherit}
.sk-closing__note{color:var(--sk-muted,#c3ccdb)}
.sk-closing__contact{color:var(--sk-accent,#8fb0ff)}
.sk-fallback,.sk-fallback li,.sk-fallback ul{color:inherit}

/* 标题的字体/字重/字距由主题统一给——这是"气质"最直观的载体 */
.sk-cover__title,.sk-agenda__title,.sk-section__heading,.sk-bullets__title,.sk-two__title,
.sk-two__col h3,.sk-quote__body,.sk-image__title,.sk-closing__headline{
  font-family:var(--sk-display,inherit);
  font-weight:var(--sk-display-weight,700);
  letter-spacing:var(--sk-display-tracking,normal);
}

/* ── 版面节奏 ────────────────────────────────────────────────────────────
 *
 * 第一版按"网页思维"给字号：一页 1270px 宽的内容区只用了左边 60%，
 * 右边和下方大片留白，看着像没填完。16:9 的放映尺寸要**用满版面**。
 *
 * 所以这里统一把正文类版式放大并垂直居中——不是拍脑袋，是实测截图后
 * 按"一页能读清、不空旷"调的：条目标题 4.2cqw≈53px、条目 2.55cqw≈32px，
 * 在 1280×720 的放映尺寸下正好是"最后排也能看清"的量级。
 */
.sk-bullets{justify-content:center;gap:2cqw}
.sk-bullets__title{font-size:3.9cqw;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sk-bullets__lede{font-size:2.05cqw}
.sk-bullets__list{gap:1.45cqw}
.sk-bullets__item{font-size:2.3cqw;line-height:1.4}
/* 条目多时自动收一档：5 条以上还按大字号排，最后一条会被切在版面外 */
.sk-bullets__item:nth-child(n+6){font-size:2.05cqw}
.sk-bullets__item:nth-child(n+8){font-size:1.9cqw}
.sk-agenda__title{font-size:4.4cqw}
.sk-agenda__item{font-size:2.35cqw}
.sk-agenda__no{font-size:1.65cqw}
.sk-section__heading{font-size:5cqw}
.sk-section__note{font-size:2.2cqw}
.sk-two__title{font-size:3.9cqw}
.sk-two__col h3{font-size:2.5cqw}
.sk-two__col li{font-size:2.05cqw}
.sk-quote__body{font-size:3.6cqw}
.sk-quote__source{font-size:1.85cqw}
.sk-image__title{font-size:3.6cqw}
.sk-cover__title{font-size:6.8cqw;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.sk-cover__subtitle{font-size:2.3cqw}
.sk-closing__headline{font-size:4.8cqw}
.sk-closing__note{font-size:2.1cqw}

/* ── 新增结构版式：数据 / 时间线 / 主张 / 图文左右 ───────────────────────
 *
 * 这四个才是"看起来像设计过"的来源：信息形态本身不同，而不是同一块正文
 * 换字号。数字敢占半页、时间线横着走、主张敢留白、图占半边。
 */

/* 数据页 */
.sk-stats{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:3.4cqw}
.sk-stats__title{margin:0;font-size:3.4cqw;font-weight:var(--sk-display-weight,700);letter-spacing:var(--sk-display-tracking,normal);font-family:var(--sk-display,inherit)}
.sk-stats__grid{display:grid;grid-template-columns:repeat(var(--sk-cols,3),minmax(0,1fr));gap:2.2cqw;align-items:start}
.sk-stats__item{border-top:.24cqw solid var(--sk-accent,#3b6df5);padding-top:1.3cqw}
.sk-stats__value{font-size:7.4cqw;line-height:.94;font-weight:800;letter-spacing:-.03em;color:inherit}
.sk-stats__label{margin-top:1cqw;font-size:1.75cqw;line-height:1.45;color:var(--sk-muted,#8b93a1)}

/* 时间线 */
.sk-timeline{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:4cqw}
.sk-timeline__title{margin:0;font-size:3.4cqw;font-weight:var(--sk-display-weight,700);letter-spacing:var(--sk-display-tracking,normal);font-family:var(--sk-display,inherit)}
.sk-timeline__track{position:relative;display:flex;align-items:flex-start}
.sk-timeline__track::before{content:"";position:absolute;left:.62cqw;right:0;top:.62cqw;height:1px;background:var(--sk-accent,#3b6df5);opacity:.45}
.sk-timeline__node{flex:1;min-width:0;padding-right:1.8cqw}
.sk-timeline__dot{position:relative;width:1.26cqw;height:1.26cqw;border-radius:50%;background:var(--sk-accent,#3b6df5);margin-bottom:1.7cqw}
.sk-timeline__when{font-size:2.35cqw;font-weight:700;color:var(--sk-accent,#3b6df5);letter-spacing:.02em}
.sk-timeline__what{margin-top:.7cqw;font-size:1.85cqw;line-height:1.5;color:inherit}

/* 主张页 */
.sk-manifesto{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:1.5cqw}
.sk-manifesto__line{margin:0;font-size:5.4cqw;line-height:1.14;font-weight:var(--sk-display-weight,700);letter-spacing:var(--sk-display-tracking,normal);font-family:var(--sk-display,inherit)}
.sk-manifesto__line:nth-child(2){padding-left:7cqw}
.sk-manifesto__line:nth-child(3){padding-left:14cqw;color:var(--sk-accent,#3b6df5)}
.sk-manifesto__note{margin:2.2cqw 0 0;font-size:1.7cqw;color:var(--sk-muted,#8b93a1)}

/* 图文左右 */
.sk-split{position:absolute;inset:0;display:grid;grid-template-columns:1.05fr 1fr}
.sk-split__media{position:relative;overflow:hidden;background:var(--sk-surface,#eef1f6)}
.sk-split__media img{width:100%;height:100%;object-fit:cover;display:block}
.sk-split__placeholder{display:flex;align-items:center;justify-content:center;height:100%;font-size:1.6cqw;color:var(--sk-muted,#9aa3b2)}
/*
 * 没有配图时的左半页：**用几何图形画抽象底纹，不写字**。
 *
 * 早先这里画的是"占位框 + 目标文字"，目标被截断成
 * "一家做企业协作软件的公司做季…" 印在半页白板上——那看起来像渲染坏了。
 * 抽象底纹至少是一整页完整的视觉，也不假装自己有内容。
 */
.sk-split__media-art{
  position:absolute;inset:0;
  background:
    radial-gradient(circle at 26% 26%,var(--sk-accent,#3b6df5) 0 11%,transparent 12%),
    radial-gradient(circle at 66% 60%,var(--sk-accent,#3b6df5) 0 26%,transparent 27%),
    radial-gradient(circle at 40% 82%,var(--sk-accent,#3b6df5) 0 7%,transparent 8%),
    linear-gradient(135deg,var(--sk-surface,#eef1f6),transparent 72%);
  opacity:.55;
}
.sk-split__media-art::after{
  content:"";position:absolute;inset:2.6cqw;border:1px solid var(--sk-accent,#3b6df5);opacity:.3;
}
.sk-split__body{display:flex;flex-direction:column;justify-content:center;gap:1.8cqw;padding:var(--sk-pad-y,6cqw) var(--sk-pad-x,7cqw)}
.sk-split__title{margin:0;font-size:3.1cqw;line-height:1.22;font-weight:var(--sk-display-weight,700);letter-spacing:var(--sk-display-tracking,normal);font-family:var(--sk-display,inherit)}
.sk-split__items{margin:0;padding-left:2cqw;display:flex;flex-direction:column;gap:1.15cqw}
.sk-split__items li{font-size:1.95cqw;line-height:1.5}
.sk-split__items li p{margin:0}

/* ── 主题级视觉层：让"+底色"变成"有设计" ────────────────────────────────
 *
 * 纯 CSS 画的三层装饰（不引用任何外部资源，断网也成立）：
 *   1. 右上角一团柔和光晕（用主题强调色）
 *   2. 左下角一条极细的强调线
 *   3. 一层 5% 的斜向条纹，给纯色底一点质感
 *
 * 三层都很淡：装饰是为了让版面"有层次"，不是为了抢内容。
 * 用 pointer-events:none 保证点击验证不受影响——这点很关键，
 * 交互测试要点的是翻页按钮，不能被装饰层挡住。
 */
.slide__frame::before,
.slide__frame::after{content:"";position:absolute;pointer-events:none}
.slide__frame::before{
  inset:-10% -10% auto auto;width:62%;height:70%;
  background:radial-gradient(closest-side,var(--sk-accent,#3b6df5),transparent 70%);
  opacity:.16;filter:blur(.6cqw);
}
.slide__frame::after{
  left:0;right:0;bottom:0;height:.18cqw;
  background:linear-gradient(90deg,var(--sk-accent,#3b6df5),transparent 55%);
  opacity:.55;
}
.slide__frame > *{position:absolute;z-index:1}

/* ── 统一字号刻度 + 调性起伏 ────────────────────────────────────────────
 *
 * 两条都是针对"字忽大忽小、六页一个色"的实测问题：
 *
 * 1. **字号只从六个档里取**（display / h1 / h2 / body / caption / metric）。
 *    之前每个版式自己写一个 cqw，条目页 2.3、数据页说明 1.75、时间线 1.85……
 *    同样是"说明文字"，在相邻两页差了 30%，翻页时肉眼就觉得字在跳。
 * 2. **调性按版式起伏**：强调页底色带主题色斜向渐变，信息页底线更实，
 *    阅读页装饰最弱。规律由版式决定，所以重渲染永远是同一个样子。
 */
:where(.slide__frame){
  --fs-display:5.2cqw;--fs-h1:4cqw;--fs-h2:2.8cqw;--fs-body:2.05cqw;--fs-caption:1.7cqw;--fs-metric:7.2cqw;
}
.slide[data-tone="accent"] .slide__frame{
  background:linear-gradient(135deg,color-mix(in srgb,var(--sk-accent,#3b6df5) 34%,var(--sk-bg,#10151f)) 0%,
    var(--sk-bg,#10151f) 62%);
}
.slide[data-tone="accent"] .slide__frame::before{opacity:.26}
.slide[data-tone="tinted"] .slide__frame::after{height:.5cqw;opacity:.95}
.slide[data-tone="plain"] .slide__frame::before{opacity:.08}

.sk-manifesto__line{font-size:var(--fs-display)}
.sk-cover__title,.sk-section__heading,.sk-closing__headline{font-size:var(--fs-h1)}
.sk-bullets__title,.sk-agenda__title,.sk-two__title,.sk-stats__title,.sk-timeline__title,
.sk-quote__body,.sk-image__title,.sk-split__title{font-size:var(--fs-h2)}
.sk-stats__value{font-size:var(--fs-metric)}
.sk-two__col h3,.sk-timeline__when{font-size:calc(var(--fs-body) * 1.18)}
.sk-bullets__item,.sk-agenda__item,.sk-two__col li,.sk-split__items li{font-size:var(--fs-body)}
.sk-cover__subtitle,.sk-bullets__lede,.sk-section__note,.sk-closing__note{font-size:calc(var(--fs-body) * 1.04)}
.sk-stats__label,.sk-timeline__what,.sk-quote__source,.sk-manifesto__note,
.sk-bullets__item:nth-child(n+6),.sk-agenda__no{font-size:var(--fs-caption)}

/* 图表页：柱子用主题强调色，数值与标签用统一字号档 */
.sk-chart{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:2.6cqw}
.sk-chart__title{margin:0;font-size:var(--fs-h2,2.8cqw);font-weight:var(--sk-display-weight,700);letter-spacing:var(--sk-display-tracking,normal);font-family:var(--sk-display,inherit)}
.sk-chart__svg{width:100%;height:auto;max-height:56%;overflow:visible}
.sk-chart__bar{fill:var(--sk-accent,#3b6df5);opacity:.92}
.sk-chart__bar:nth-child(even){opacity:.62}
.sk-chart__val{fill:var(--sk-fg,#fff);font-size:15px;font-weight:700}
.sk-chart__label{fill:var(--sk-muted,#8b93a1);font-size:13px}
.sk-chart__note{margin:0;font-size:var(--fs-caption,1.7cqw);color:var(--sk-muted,#8b93a1)}

/* ── 构图交替：让相邻两页的"呼吸"不一样 ──────────────────────────────────
 *
 * 只有版式一个维度时，连续两页信息页看起来仍是"同一张图换个字"。
 * 这里按页序奇偶做**构图交替**（纯 CSS，不改结构）：
 *
 *   left  标题与内容靠左、强调线在左 —— 常规阅读节奏
 *   right 标题居中、强调线在底 —— 换气口，读者会感到"翻了一页"
 *
 * 为什么按页序而不是让模型选：页序已由决策模型决定，奇偶只是把它的
 * 选择**翻译成构图节奏**，不需要多一次决策往返，也不会让同一份结构
 * 重渲染出两种样子。
 */
.slide[data-side="right"] .sk-bullets__head{border-left:0;border-bottom:.35cqw solid var(--sk-accent,#3b6df5);padding-left:0;padding-bottom:1.2cqw;text-align:center;align-items:center}
.slide[data-side="right"] .sk-bullets__title{text-align:center}
.slide[data-side="right"] .sk-stats__grid{gap:3.4cqw}
.slide[data-side="right"] .sk-stats__item{border-top-width:.42cqw}

/* 数据页的**第二种构图**：从"并排三列"变成"竖向排行"。
 *
 * 同一页信息、两种读法：并排适合快速比较三个数，竖向排行适合"名次"语义
 * （第一名压在最后一行时最重）。这是纯 CSS 改结构呈现，不动 DOM，
 * 所以不需要决策层为它多问一次，也不会让产物变得不可复现。
 */
.slide[data-side="right"] .sk-stats__grid{grid-template-columns:1fr;gap:1.1cqw}
.slide[data-side="right"] .sk-stats__item{
  display:flex;align-items:baseline;gap:2.2cqw;
  border-top:0;border-bottom:1px solid var(--sk-surface,rgba(255,255,255,.12));
  padding:.9cqw 0;
}
.slide[data-side="right"] .sk-stats__value{font-size:4.2cqw;min-width:7cqw}
.slide[data-side="right"] .sk-stats__label{margin-top:0}

/* 时间线的**第二种构图**：从"横向一条线"变成"竖向台阶"。
 * 横向读的是节奏，竖向读的是先后与累积——同一组节点，两种叙事。
 */
.slide[data-side="right"] .sk-timeline__track{flex-direction:column;gap:1.3cqw}
.slide[data-side="right"] .sk-timeline__track::before{
  left:.62cqw;top:.6cqw;bottom:.6cqw;right:auto;width:1px;height:auto;
}
.slide[data-side="right"] .sk-timeline__node{
  display:grid;grid-template-columns:.9cqw 8cqw 1fr;align-items:center;gap:1.6cqw;padding-right:0;
}
.slide[data-side="right"] .sk-timeline__dot{margin-bottom:0}
.slide[data-side="right"] .sk-timeline__what{margin-top:0}
.slide[data-side="right"] .sk-agenda__list{grid-template-columns:1fr}

/* 要点页的第二种构图：从"圆点列表"变成**编号清单**。
 * 编号让"三件事"读起来有次序感，圆点更松散——同一组条目，两种语气。
 */
.slide[data-side="right"] .sk-bullets__list{counter-reset:sk-item;gap:1.2cqw}
.slide[data-side="right"] .sk-bullets__item{
  counter-increment:sk-item;padding-left:4.6cqw;
  border-bottom:1px solid var(--sk-surface,rgba(255,255,255,.12));padding-bottom:.9cqw;
}
.slide[data-side="right"] .sk-bullets__item::before{
  content:counter(sk-item,decimal-leading-zero);
  width:auto;height:auto;border-radius:0;background:none;left:0;top:.15cqw;
  color:var(--sk-accent,#3b6df5);font-size:2.05cqw;font-weight:700;
}

/* 两栏页的第二种构图：从"左右对等"变成**主从**（左窄右宽）。
 * 对等用于对照，主从用于"背景 → 方案"这类有轻重的叙述。
 */
.slide[data-side="right"] .sk-two__grid{grid-template-columns:.78fr 1.22fr;gap:1.8cqw}

/* 图表页的第二种读法：柱子换成**横向条形**，标签在左、数值在右。
 * 柱状读趋势（时间在横轴上），条形读排名（名字在纵轴上）——
 * 同一组数据，模型给的是"几个季度"还是"几个部门"，两种读法都成立。
 */
.slide[data-side="right"] .sk-chart__svg{max-height:62%}

/* 打印 / 导出 PDF：一页一张 */
@media print{
  @page{size:1280px 720px;margin:0}
  body{background:#fff}
  .deck__nav,.deck__hud,.deck__meta,.deck__anno{display:none!important}
  .deck__stage{display:block;padding:0}
  .slide{display:block!important}
  .slide[hidden]{display:block!important}
  .slide__frame{width:1280px;height:720px;aspect-ratio:auto;border-radius:0;box-shadow:none;page-break-after:always;break-after:page}
  .slide:last-child .slide__frame{page-break-after:auto;break-after:auto}
}
`;

/**
 * 翻页脚本。
 *
 * 复用网页链路那套 `data-ms-tab` / `data-ms-panel` 锚点约定，
 * 于是**同一个交互验证流程**（`verifyInteraction` → 决策层挑一个 → 真驱动去点）
 * 不用改一行就能验证演示文稿的翻页。这不是巧合：幻灯片本来就是"一次只显示一页"，
 * 它和标签页是同一种交互。
 *
 * 额外加了方向键与空格翻页——放映时没人愿意去点小圆点。
 */
const DECK_SCRIPT = `<script>
(function () {
  function activate(dot) {
    var group = dot.closest('[data-ms-tabs]');
    if (!group) return;
    var key = dot.getAttribute('data-ms-tab');
    var dots = group.querySelectorAll('[data-ms-tab]');
    for (var i = 0; i < dots.length; i++) {
      dots[i].setAttribute('aria-selected', dots[i] === dot ? 'true' : 'false');
    }
    var stage = document.querySelector('.deck__stage');
    var panels = stage ? stage.querySelectorAll('[data-ms-panel]') : [];
    for (var j = 0; j < panels.length; j++) {
      if (panels[j].getAttribute('data-ms-panel') === key) { panels[j].removeAttribute('hidden'); }
      else { panels[j].setAttribute('hidden', ''); }
    }
    var counter = document.querySelector('[data-ms-counter]');
    if (counter) {
      counter.textContent = (dot.textContent || '') + ' / ' + dots.length;
    }
  }
  document.addEventListener('click', function (e) {
    var dot = e.target && e.target.closest ? e.target.closest('[data-ms-tab]') : null;
    if (dot) { activate(dot); return; }
    // 点页面右侧翻下一页、左侧翻上一页。
    if (!e.target || !e.target.closest || !e.target.closest('.deck__stage')) return;
    var stage = document.querySelector('.deck__stage');
    if (!stage) return;
    var dots = document.querySelectorAll('[data-ms-tab]');
    var current = 0;
    for (var i = 0; i < dots.length; i++) { if (dots[i].getAttribute('aria-selected') === 'true') current = i; }
    var next = e.clientX > window.innerWidth / 2 ? current + 1 : current - 1;
    if (next >= 0 && next < dots.length) activate(dots[next]);
  });
  document.addEventListener('keydown', function (e) {
    var dots = document.querySelectorAll('[data-ms-tab]');
    if (!dots.length) return;
    var current = 0;
    for (var i = 0; i < dots.length; i++) { if (dots[i].getAttribute('aria-selected') === 'true') current = i; }
    var k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown') {
      if (current + 1 < dots.length) { activate(dots[current + 1]); e.preventDefault(); }
    } else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') {
      if (current > 0) { activate(dots[current - 1]); e.preventDefault(); }
    } else if (k === 'Home') { activate(dots[0]); e.preventDefault(); }
    else if (k === 'End') { activate(dots[dots.length - 1]); e.preventDefault(); }
  });
})();
</script>`;

/**
 * 把结构渲染成完整 HTML 文档。
 *
 * 输出**自包含**：不引用任何外部字体、脚本、样式。沙盒可能没有网络，
 * 而演示文稿必须能在一台断网的机器上打开就是完整的样子。
 */
export function renderDeck(spec: PageSpec, options: RenderDeckOptions = {}): string {
  const title = options.title ?? spec.goal;
  const slides = spec.blocks;
  // 主题在**决策层**定（`deck_theme` 这一问），这里只负责把它的变量铺到页面上。
  // `data-ms-theme` 让"这份文稿是哪种气质"在产物本身里可查，而不是只活在日志里。
  const theme = resolveDeckTheme(options.themeId);

  const dots = slides
    .map((_, i) => {
      const n = i + 1;
      return (
        `<button class="deck__dot" type="button" role="tab" id="deck-t${n}" ` +
        `aria-selected="${i === 0 ? 'true' : 'false'}" aria-controls="deck-s${n}" ` +
        `data-ms-tab="deck:${n}" aria-label="第 ${n} 页">${n}</button>`
      );
    })
    .join('');

  const pages = slides
    .map((block, i) => {
      const n = i + 1;
      return (
        `<section class="slide" id="deck-s${n}" role="tabpanel" aria-labelledby="deck-t${n}" ` +
        `data-ms-panel="deck:${n}" data-ms-layout="${escapeHtml(block.type)}" ` +
        `data-tone="${toneForLayout(block.type)}" data-side="${i % 2 === 0 ? 'left' : 'right'}"${i === 0 ? '' : ' hidden'}>` +
        `<div class="slide__frame">${renderSlide(block)}` +
        `<span class="deck__anno" aria-hidden="true">${n} · ${escapeHtml(block.type)}</span>` +
        `<span class="deck__meta" aria-hidden="true">${n} / ${slides.length}</span>` +
        `</div></section>`
      );
    })
    .join('');

  return (
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>${DECK_CSS}</style>\n</head>\n<body>\n` +
    `<main class="deck" data-ms-project="${escapeHtml(spec.projectId)}" ` +
    `data-ms-theme="${escapeHtml(theme.id)}" style="${deckThemeCssVars(theme)}" ` +
    `data-ms-slides="${slides.length}" data-ms-goal="${escapeHtml(spec.goal)}">\n` +
    `<nav class="deck__nav" data-ms-tabs="deck" role="tablist" aria-label="页序">${dots}</nav>\n` +
    `<div class="deck__stage">${pages}</div>\n` +
    `<div class="deck__hud"><span class="deck__counter" data-ms-counter>1 / ${slides.length}</span></div>\n` +
    `</main>\n${DECK_SCRIPT}\n</body>\n</html>\n`
  );
}
