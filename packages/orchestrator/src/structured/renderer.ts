/**
 * 页面渲染器：**结构化数据 → 完整 HTML 文档**。
 *
 * ## 边界
 *
 * 填充管**内容**，渲染管**版式**。让填充分支去吐 HTML 片段，就把两者焊死了：
 * 换版式要重跑全部填充（重新花钱），换内容要动渲染代码。所以这里是**纯函数**：
 * 只吃 `PageSpec`，吐字符串，不碰沙盒、不调模型、不读文件。
 *
 * ## 三条硬要求
 *
 * 1. **全部转义**。slot 内容来自用户目标，不转义就是注入点。所有进 HTML 的
 *    数据都过 `escapeHtml`，包括 SVG 里的文本。
 * 2. **pending / failed 的块也渲染**。结构定了但内容没填是**正常中间态**，
 *    渲染器不该因此崩掉或吞掉整页——那会让"部分完成"这个性质消失。
 * 3. **确定性**。同样的输入逐字节相同：不用 `Date.now()`、不用随机数。
 *    否则"可复现"这条就守不住，缓存与测试也跟着不可靠。
 *
 * ## 交互块为什么用原生元素
 *
 * 后续要拿决策模型**模拟点击**来验交互，所以可点元素必须是真实控件：
 * `tabs` 用 `<button>`，`accordion` 用原生 `<details>/<summary>`（连脚本都不用），
 * `form` 的提交被内联脚本拦下并给一句提示，**绝不发网络请求**。
 * 每个可点元素都带 `data-ms-*` 属性作为定位锚点。
 */
import type { BlockRegistry, BlockSpec, SlotSpec } from './block-spec.js';
import type { BlockInstance, PageSpec, SlotValue } from './page-spec.js';
import { deriveBrand } from './filler.js';

export interface RenderOptions {
  /** 文档标题。缺省用 `spec.goal`。 */
  readonly title?: string | undefined;
  /** 是否在页面上标注每块的来源与状态（演示与排查用）。默认 false。 */
  readonly annotate?: boolean | undefined;
  /**
   * block 池。给了它，**池子里查得到、但没有专属渲染器**的 block（自定义 block）
   * 走通用渲染，而不是落成"未支持的 block 类型"占位。
   *
   * 不给就维持原行为：没有专属渲染器的一律占位。这样既有调用方与测试
   * 不必被迫提供一个池子——"能渲染自定义 block"是增强，不是新前提。
   */
  readonly blocks?: BlockRegistry | undefined;
}

// ── 转义 ────────────────────────────────────────────────────────────────

/**
 * HTML 转义。**这是安全底线**，所有进标记的数据都要过它。
 *
 * 单引号也转：属性值可能用单引号包裹，漏掉它就有注入面。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 文本 → 段落 HTML。
 *
 * **必须先转义再转换**：反过来会把已经生成好的 `<p>` 一起转义掉，
 * 或者更糟——把用户输入里的标签当成结构放出去。
 */
function paragraphs(text: string): string {
  const parts = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return '<p>（待补充）</p>';
  return parts.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** 单行文本 → 转义后的行内 HTML。 */
function inline(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// ── slot 取值读取（缺省一律回落，绝不返回 undefined 进模板） ────────────

function textOf(block: BlockInstance, name: string, fallback = ''): string {
  const value: SlotValue | undefined = block.slots[name];
  if (value === undefined) return fallback;
  if (value.kind === 'text') return value.text;
  if (value.kind === 'list') return value.items.join('\n');
  return fallback;
}

function listOf(block: BlockInstance, name: string): string[] {
  const value: SlotValue | undefined = block.slots[name];
  if (value === undefined) return [];
  if (value.kind === 'list') return [...value.items];
  if (value.kind === 'text') return value.text === '' ? [] : [value.text];
  return [];
}

function imagesOf(block: BlockInstance, name: string): { ref: string; alt: string }[] {
  const value: SlotValue | undefined = block.slots[name];
  if (value === undefined) return [];
  if (value.kind === 'image') return [{ ref: value.ref, alt: value.alt }];
  if (value.kind === 'list-image') return value.refs.map((r) => ({ ref: r.ref, alt: r.alt }));
  return [];
}

/**
 * 版式 id。结构里没选过（或老数据没有这个字段）就用该类型的默认版式——
 * 默认值由各渲染函数给，因为它们最清楚"没有偏好时哪种最稳妥"。
 */
function layoutOf(block: BlockInstance, fallback: string): string {
  const layout = block.layout;
  return layout === undefined || layout === '' ? fallback : layout;
}

/**
 * 页面壳的锚点标签：取这一块真正的小节标题，而不是 block 类型名。
 *
 * 不是每种 block 都有可当标题的 slot（`tabs` / `form` 的标题在列表里），
 * 表里没有的就不进导航——宁可少一个锚点，也不要在顶栏印一串 `b3 features`。
 */
const SECTION_HEADING_SLOT: Readonly<Record<string, string>> = {
  hero: 'title',
  features: 'heading',
  gallery: 'heading',
  text: 'heading',
  table: 'heading',
  code: 'heading',
  video: 'heading',
  form: 'heading',
  accordion: 'heading',
};

function anchorLabel(block: BlockInstance): string {
  const slotName = SECTION_HEADING_SLOT[block.type];
  if (slotName === undefined) return '';
  const raw = textOf(block, slotName).replace(/\s+/g, ' ').trim();
  if (raw === '') return '';
  return raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
}

/** 一行 "a | b" 拆成 [a, b]；没有分隔符时第二项为空。 */
function splitRow(row: string): [string, string] {
  const index = row.indexOf('|');
  if (index < 0) return [row, ''];
  return [row.slice(0, index).trim(), row.slice(index + 1).trim()];
}

// ── 图片 ────────────────────────────────────────────────────────────────

/**
 * 内联 SVG 占位图。**`ref` 为空时用它，而不是输出 `<img src="">`**。
 *
 * `<img src="">` 会让浏览器把当前页面地址当成图片地址再请求一次——
 * 页面上多几个空 `src`，就是几次莫名其妙的重复请求，且预览出现破图。
 */
function placeholderSvg(alt: string): string {
  const label = escapeHtml(alt === '' ? '图片待补充' : alt);
  return (
    `<svg class="ms-img ms-img--placeholder" viewBox="0 0 800 480" role="img" ` +
    `aria-label="${label}" preserveAspectRatio="xMidYMid slice">` +
    `<rect width="800" height="480" fill="currentColor" opacity="0.06"/>` +
    `<rect x="16" y="16" width="768" height="448" fill="none" stroke="currentColor" ` +
    `stroke-opacity="0.2" stroke-width="2" stroke-dasharray="10 8"/>` +
    `<text x="400" y="248" text-anchor="middle" font-size="28" fill="currentColor" ` +
    `opacity="0.5" font-family="inherit">${label}</text>` +
    `</svg>`
  );
}

/**
 * 渲染一张图。
 *
 * `ref` 允许是 data URI（确定性填充就是这种）或相对路径（真实产物是这种）。
 * **两种情况都直接当 `src`**，不做路径改写——改写会把沙盒里的相对路径弄错。
 */
function imageHtml(ref: string, alt: string, className = 'ms-img'): string {
  const safeAlt = escapeHtml(alt);
  if (ref.trim() === '') {
    return `<figure class="ms-figure">${placeholderSvg(alt)}` +
      (alt === '' ? '' : `<figcaption class="ms-figure__caption">${safeAlt}</figcaption>`) +
      `</figure>`;
  }
  const figure =
    `<figure class="ms-figure">` +
    `<img class="${className}" src="${escapeHtml(ref)}" alt="${safeAlt}" loading="lazy" decoding="async">` +
    (alt === '' ? '' : `<figcaption class="ms-figure__caption">${safeAlt}</figcaption>`) +
    `</figure>`;
  return figure;
}

// ── 各 block 的渲染 ─────────────────────────────────────────────────────

interface RenderContext {
  readonly annotate: boolean;
  /** block 池：用来分辨"这是自定义 block"还是"结构里的类型对不上词表"。 */
  readonly blocks: BlockRegistry | undefined;
}

type BlockRenderer = (block: BlockInstance, ctx: RenderContext) => string;

const renderNav: BlockRenderer = (b) => {
  const brand = textOf(b, 'brand', '站点');
  const links = listOf(b, 'links');
  const items = links
    .map((l) => `<li class="ms-nav__item"><a href="#">${inline(l)}</a></li>`)
    .join('');
  return (
    `<nav class="ms-nav">` +
    `<span class="ms-nav__brand">${inline(brand)}</span>` +
    `<ul class="ms-nav__list">${items}</ul>` +
    `</nav>`
  );
};

const renderHero: BlockRenderer = (b) => {
  const title = textOf(b, 'title', '标题');
  const subtitle = textOf(b, 'subtitle');
  const actionText = textOf(b, 'actionText');
  const actionHref = textOf(b, 'actionHref', '#');
  const media = imagesOf(b, 'media');
  const mediaHtml = media.length > 0 ? imageHtml(media[0]!.ref, media[0]!.alt, 'ms-hero__media') : '';
  // 版式只改摆法：分栏是"文在图侧"，居中通栏是"文在上、图在下"。
  const layout = layoutOf(b, 'split');
  const body =
    `<div class="ms-hero__body">` +
    `<h1 class="ms-hero__title">${inline(title)}</h1>` +
    (subtitle === '' ? '' : `<p class="ms-hero__subtitle">${inline(subtitle)}</p>`) +
    (actionText === ''
      ? ''
      : `<a class="ms-btn ms-btn--primary ms-hero__action" href="${escapeHtml(actionHref === '' ? '#' : actionHref)}">${inline(actionText)}</a>`) +
    `</div>`;

  // 全幅背景：图当页面背景用，文字压在上面。没有图时退回居中通栏——
  // 一块没有背景的"全幅"只是一段留白，比居中更差。
  if (layout === 'immersive' && media.length > 0) {
    const backdrop = media[0]!;
    return (
      `<header class="ms-hero ms-hero--immersive" role="img" aria-label="${escapeHtml(backdrop.alt)}">` +
      `<div class="ms-hero__backdrop" style="background-image:url(${escapeHtml(backdrop.ref)})"></div>` +
      body +
      `</header>`
    );
  }

  return (
    `<header class="ms-hero ms-hero--${escapeHtml(layout)}">` +
    body +
    (mediaHtml === '' ? '' : `<div class="ms-hero__visual">${mediaHtml}</div>`) +
    `</header>`
  );
};

const renderFeatures: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const items = listOf(b, 'items');
  const layout = layoutOf(b, 'cards');
  if (layout === 'rows') {
    const rows = items
      .map((item, i) => {
        const [title, detail] = splitRow(item);
        return (
          `<li class="ms-features__row">` +
          `<span class="ms-features__index">${String(i + 1).padStart(2, '0')}</span>` +
          `<div class="ms-features__row-body">` +
          `<h3 class="ms-features__item-title">${inline(title)}</h3>` +
          (detail === '' ? '' : `<p class="ms-features__item-detail">${inline(detail)}</p>`) +
          `</div>` +
          `</li>`
        );
      })
      .join('');
    return section(heading, `<ul class="ms-features ms-features--rows">${rows}</ul>`, 'ms-features-section');
  }
  const cards = items
    .map((item, i) => {
      const [title, detail] = splitRow(item);
      return (
        `<li class="ms-features__item">` +
        `<span class="ms-features__index">${String(i + 1).padStart(2, '0')}</span>` +
        `<h3 class="ms-features__item-title">${inline(title)}</h3>` +
        (detail === '' ? '' : `<p class="ms-features__item-detail">${inline(detail)}</p>`) +
        `</li>`
      );
    })
    .join('');
  return section(heading, `<ul class="ms-features ms-features--${escapeHtml(layout)}">${cards}</ul>`, 'ms-features-section');
};

const renderGallery: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const images = imagesOf(b, 'images');
  const requested = layoutOf(b, 'grid');
  // 拼贴版式需要"一大两小"：图不够三张时退回等宽网格，
  // 否则网格里会留一个空洞，比整齐的网格更难看。
  const layout = requested === 'collage' && images.length < 3 ? 'grid' : requested;
  const figures = images
    .map((img, i) => `<li class="ms-gallery__item" data-ms-index="${i}">${imageHtml(img.ref, img.alt)}</li>`)
    .join('');
  return section(
    heading,
    `<ul class="ms-gallery ms-gallery--${escapeHtml(layout)}">${figures}</ul>`,
    'ms-gallery-section',
  );
};

const renderCta: BlockRenderer = (b) => {
  const text = textOf(b, 'text', '现在开始');
  const buttonText = textOf(b, 'buttonText', '立即体验');
  const href = textOf(b, 'href', '#');
  const layout = layoutOf(b, 'banner');
  return (
    `<aside class="ms-cta ms-cta--${escapeHtml(layout)}">` +
    `<p class="ms-cta__text">${inline(text)}</p>` +
    `<a class="ms-btn ms-btn--primary" href="${escapeHtml(href === '' ? '#' : href)}">${inline(buttonText)}</a>` +
    `</aside>`
  );
};

const renderFooter: BlockRenderer = (b) => {
  const copyright = textOf(b, 'copyright');
  const links = listOf(b, 'links');
  const items = links.map((l) => `<li><a href="#">${inline(l)}</a></li>`).join('');
  return (
    `<footer class="ms-footer">` +
    `<p class="ms-footer__copyright">${inline(copyright)}</p>` +
    (items === '' ? '' : `<ul class="ms-footer__links">${items}</ul>`) +
    `</footer>`
  );
};

const renderText: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const body = textOf(b, 'body');
  return section(heading, `<div class="ms-prose">${paragraphs(body)}</div>`, 'ms-text-section');
};

const renderImage: BlockRenderer = (b) => {
  const value = b.slots['prompt'];
  const alt = textOf(b, 'caption');
  const ref = value?.kind === 'image' ? value.ref : '';
  const imageAlt = value?.kind === 'image' && value.alt !== '' ? value.alt : alt;
  return `<div class="ms-image-block">${imageHtml(ref, imageAlt === '' ? alt : imageAlt)}</div>`;
};

const renderVideo: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const src = textOf(b, 'src');
  const poster = imagesOf(b, 'poster');
  // 没有真实素材时给一个占位框，而不是一个空的 <video>——
  // 后者在部分浏览器里会显示成一块空白，看不出是"待补"还是"坏了"。
  const player =
    src === '' || src === '#'
      ? `<div class="ms-video__placeholder" role="img" aria-label="视频待补充">视频待补充</div>`
      : `<video class="ms-video__player" controls preload="none"${poster.length > 0 && poster[0]!.ref !== '' ? ` poster="${escapeHtml(poster[0]!.ref)}"` : ''}><source src="${escapeHtml(src)}"></video>`;
  return section(heading, `<div class="ms-video">${player}</div>`, 'ms-video-section');
};

const renderCode: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const language = textOf(b, 'language', 'text');
  const source = textOf(b, 'source');
  return section(
    heading,
    `<pre class="ms-code"><code class="ms-code__body" data-ms-lang="${escapeHtml(language)}">${escapeHtml(source)}</code></pre>`,
    'ms-code-section',
  );
};

const renderQuote: BlockRenderer = (b) => {
  const text = textOf(b, 'text');
  const attribution = textOf(b, 'attribution');
  return (
    `<blockquote class="ms-quote">` +
    `<p class="ms-quote__text">${inline(text)}</p>` +
    (attribution === '' ? '' : `<footer class="ms-quote__source">— ${inline(attribution)}</footer>`) +
    `</blockquote>`
  );
};

const renderTable: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const rows = listOf(b, 'rows');
  const head = rows[0] === undefined ? null : splitRow(rows[0]);
  const bodyRows = rows.slice(1);
  const headHtml =
    head === null
      ? ''
      : `<thead><tr><th scope="col">${inline(head[0])}</th><th scope="col">${inline(head[1])}</th></tr></thead>`;
  const bodyHtml = bodyRows
    .map((row) => {
      const [a, c] = splitRow(row);
      return `<tr><td>${inline(a)}</td><td>${inline(c)}</td></tr>`;
    })
    .join('');
  return section(heading, `<table class="ms-table">${headHtml}<tbody>${bodyHtml}</tbody></table>`, 'ms-table-section');
};

const renderForm: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const fields = listOf(b, 'fields');
  const submitText = textOf(b, 'submitText', '提交');
  const inputs = fields
    .map((name, i) => {
      const id = `${b.id}-f${i + 1}`;
      return (
        `<div class="ms-form__field">` +
        `<label class="ms-form__label" for="${escapeHtml(id)}">${inline(name)}</label>` +
        `<input class="ms-form__input" id="${escapeHtml(id)}" name="${escapeHtml(id)}" type="text" data-ms-field="${escapeHtml(id)}">` +
        `</div>`
      );
    })
    .join('');
  // 提交被内联脚本拦下并给一句提示。**不发网络请求**——
  // 页面在沙盒里跑，没有可提交的后端，真发出去只会得到一个失败请求。
  return section(
    heading,
    `<form class="ms-form" data-ms-form="${escapeHtml(b.id)}" onsubmit="event.preventDefault();var n=this.querySelector('.ms-form__note');if(n){n.hidden=false;}return false;">` +
      inputs +
      `<button class="ms-btn ms-btn--primary ms-form__submit" type="submit" data-ms-submit="${escapeHtml(b.id)}">${inline(submitText)}</button>` +
      `<p class="ms-form__note" hidden>已提交（演示，未发送到任何服务）</p>` +
      `</form>`,
    'ms-form-section',
  );
};

const renderTabs: BlockRenderer = (b) => {
  const names = listOf(b, 'tabs');
  const panels = listOf(b, 'panels');
  const count = Math.max(names.length, panels.length);
  if (count === 0) {
    return `<div class="ms-tabs" data-ms-tabs="${escapeHtml(b.id)}"><p class="ms-tabs__empty">（标签页待补充）</p></div>`;
  }
  const buttons = Array.from({ length: count }, (_, i) => {
    const name = names[i] ?? `标签 ${i + 1}`;
    const selected = i === 0;
    return (
      `<button class="ms-tabs__tab" type="button" role="tab" ` +
      `id="${escapeHtml(b.id)}-t${i + 1}" aria-selected="${selected ? 'true' : 'false'}" ` +
      `aria-controls="${escapeHtml(b.id)}-p${i + 1}" data-ms-tab="${escapeHtml(b.id)}:${i + 1}">${inline(name)}</button>`
    );
  }).join('');
  const contents = Array.from({ length: count }, (_, i) => {
    const body = panels[i] ?? '（内容待补充）';
    return (
      `<div class="ms-tabs__panel" role="tabpanel" id="${escapeHtml(b.id)}-p${i + 1}" ` +
      `aria-labelledby="${escapeHtml(b.id)}-t${i + 1}" data-ms-panel="${escapeHtml(b.id)}:${i + 1}"` +
      (i === 0 ? '' : ' hidden') +
      `>${paragraphs(body)}</div>`
    );
  }).join('');
  return (
    `<div class="ms-tabs" data-ms-tabs="${escapeHtml(b.id)}">` +
    `<div class="ms-tabs__list" role="tablist">${buttons}</div>` +
    `<div class="ms-tabs__panels">${contents}</div>` +
    `</div>`
  );
};

const renderAccordion: BlockRenderer = (b) => {
  const heading = textOf(b, 'heading');
  const items = listOf(b, 'items');
  const details = items
    .map((item, i) => {
      const [question, answer] = splitRow(item);
      return (
        `<details class="ms-accordion__item" data-ms-accordion="${escapeHtml(b.id)}:${i + 1}"${i === 0 ? ' open' : ''}>` +
        `<summary class="ms-accordion__summary">${inline(question)}</summary>` +
        `<div class="ms-accordion__body">${paragraphs(answer === '' ? '（待补充）' : answer)}</div>` +
        `</details>`
      );
    })
    .join('');
  return section(heading, `<div class="ms-accordion">${details}</div>`, 'ms-accordion-section');
};

/** 带可选小节标题的包裹。 */
function section(heading: string, body: string, className: string): string {
  return (
    `<section class="${className}">` +
    (heading === '' ? '' : `<h2 class="ms-section__heading">${inline(heading)}</h2>`) +
    body +
    `</section>`
  );
}

// ── 自定义 block 的通用渲染 ──────────────────────────────────────────────

/**
 * 链接白名单：只放行 `http(s)`、站内相对路径与锚点。
 *
 * `link` slot 的取值会进 `href`，而它来自用户目标或填充器——不校验就等于
 * 把 `javascript:` / `data:` 这类可执行 URL 交给页面。收藏夹里的书签可以随便写，
 * 但**渲染出来的页面不该执行外部输入**。
 */
function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  if (href === '') return undefined;
  return /^(https?:\/\/|\/|\.\/|\.\.\/|#)/i.test(href) ? href : undefined;
}

/**
 * 一个 slot 取值 → 通用元素。
 *
 * 判据以**取值形态**为主、声明类型为辅：`title` / `code` / `link` / `literal`
 * 的取值形态都是 `text`，只能靠声明区分；其余按形态走。
 * 形态与声明不符的结构到不了这里——`validatePageSpec` 已经拦下了。
 */
function slotHtml(declared: SlotSpec, value: SlotValue): string {
  if (value.kind === 'list') {
    const items = value.items.map((t) => `<li>${inline(t)}</li>`).join('');
    return items === '' ? '' : `<ul class="ms-generic__list">${items}</ul>`;
  }
  if (value.kind === 'list-image') {
    const figures = value.refs
      .map((img, i) => `<li class="ms-gallery__item" data-ms-index="${i}">${imageHtml(img.ref, img.alt)}</li>`)
      .join('');
    return figures === '' ? '' : `<ul class="ms-gallery">${figures}</ul>`;
  }
  if (value.kind === 'image') return imageHtml(value.ref, value.alt);

  if (declared.type === 'title') {
    return `<h3 class="ms-generic__title">${inline(value.text)}</h3>`;
  }
  if (declared.type === 'code') {
    return `<pre class="ms-code"><code class="ms-code__body">${escapeHtml(value.text)}</code></pre>`;
  }
  if (declared.type === 'link') {
    const href = safeHref(value.text);
    // 不放行的 URL 不当链接用，但**内容照旧显示**：静默丢掉用户给的东西更糟。
    return href === undefined
      ? `<p class="ms-generic__link">${inline(value.text)}</p>`
      : `<p class="ms-generic__link"><a href="${escapeHtml(href)}">${inline(value.text)}</a></p>`;
  }
  return paragraphs(value.text);
}

/**
 * 自定义 block 的通用渲染：**按 slot 声明推版式**。
 *
 * ## 为什么只能这么推
 *
 * `BlockSpec` 里没有版式信息（只有 id / label / 分组 / slot 声明 / 位置约束），
 * 所以可用的依据只有"它声明了哪些 slot、各是什么类型"。
 * 而这正是"自定义 block 选得到、填得了、却渲染不出东西"的症结：
 * 填出来的内容本来就带形态（`SlotValue`），只是此前没有渲染器认识它。
 *
 * ## 为什么不把 label 印到页面上
 *
 * `label` 是给决策模型看的名字（"促销横幅"），不是用户的内容。把它当小节标题
 * 印出来，页面上就会多一句用户没要过的文字。要看每块的类型与来源请开 `annotate`
 * ——那是专门的排查通道，不该靠往正文里掺元数据来实现。
 */
function renderCustomBlock(block: BlockInstance, spec: BlockSpec): string {
  const parts: string[] = [];
  for (const declared of spec.slots) {
    const value: SlotValue | undefined = block.slots[declared.name];
    // 未填的 slot 不占位：整块"待填充"的提示由外层统一给，逐 slot 再提示一遍只是噪声。
    if (value === undefined) continue;
    const html = slotHtml(declared, value);
    if (html !== '') parts.push(html);
  }
  return `<section class="ms-generic"><div class="ms-generic__body">${parts.join('')}</div></section>`;
}

/** 池子里查得到这个类型吗？查得到就把声明交出来，供通用渲染用。 */
function customSpecOf(type: string, ctx: RenderContext): BlockSpec | undefined {
  const registry = ctx.blocks;
  if (registry === undefined || !registry.has(type)) return undefined;
  return registry.get(type);
}

/** block 类型 → 渲染函数。用表而不是 switch：加类型就是加一行。 */
const RENDERERS: Readonly<Record<string, BlockRenderer>> = {
  nav: renderNav,
  hero: renderHero,
  features: renderFeatures,
  gallery: renderGallery,
  cta: renderCta,
  footer: renderFooter,
  text: renderText,
  image: renderImage,
  video: renderVideo,
  code: renderCode,
  quote: renderQuote,
  table: renderTable,
  form: renderForm,
  tabs: renderTabs,
  accordion: renderAccordion,
};

/**
 * 渲染一个 block。
 *
 * 三种情况都**不抛错**，而是渲染出可辨认的占位：
 *   - 未知类型：说明是哪种，便于定位
 *   - `pending` / `skipped`：结构已定、内容未填，是正常中间态
 *   - `failed`：附上原因，便于定点重做
 *
 * 渲染器让整页失败，等于把"部分完成"这个性质抹掉了——而那正是结构化制作
 * 相对于"一次性生成一整页"的核心优势。
 */
function renderBlock(block: BlockInstance, ctx: RenderContext, index: number): string {
  const parts: string[] = [];

  if (block.status === 'failed') {
    parts.push(
      `<div class="ms-block-error" role="note">区块 ${escapeHtml(block.id)} 填充失败` +
        (block.error === undefined ? '' : `：${escapeHtml(block.error)}`) +
        `</div>`,
    );
  } else if (block.status === 'pending' || block.status === 'skipped') {
    parts.push(
      `<div class="ms-block-pending" role="note">区块 ${escapeHtml(block.id)}` +
        `（${escapeHtml(block.type)}）${block.status === 'skipped' ? '已跳过' : '待填充'}</div>`,
    );
  }

  // 三条走法，**优先级不能换**：
  //   1. 内置专属渲染器 —— 版式是为它写死的，最好看
  //   2. 池子里有、但没有专属渲染器 → 通用渲染（自定义 block 的落点）
  //   3. 池子里根本没有 → `ms-unknown` 占位
  // 2 与 3 分开是有意的：**"池子里有它、只是没有专属版式"** 和
  // **"结构里的类型对不上词表"** 是两件事，长得一样就没法定位了。
  const renderer = RENDERERS[block.type];
  const custom = renderer === undefined ? customSpecOf(block.type, ctx) : undefined;

  try {
    if (renderer !== undefined) {
      parts.push(renderer(block, ctx));
    } else if (custom !== undefined) {
      parts.push(renderCustomBlock(block, custom));
    } else {
      parts.push(
        `<div class="ms-unknown" role="note">未支持的 block 类型: ${escapeHtml(block.type)}</div>`,
      );
    }
  } catch (error) {
    // 单个 block 渲染失败不该毁掉整页。把原因留在页面上，便于定点排查。
    parts.push(
      `<div class="ms-block-error" role="note">区块 ${escapeHtml(block.id)} 渲染失败：` +
        `${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`,
    );
  }

  // `data-ms-block` **无论如何都要有**：它是后续"定点重做"与"模拟点击定位"的锚点。
  // 不随 annotate 开关变化——关了标注不等于丢了锚点。
  //
  // `id` 只在有可读标题时给：页面壳的导航要按它跳转，没有标题的块不占锚点。
  const label = anchorLabel(block);
  const anchor = label === '' ? '' : ` id="ms-s${index + 1}"`;
  return (
    `<div class="ms-block ms-block--${escapeHtml(block.type)}"${anchor} ` +
    `data-ms-block="${escapeHtml(block.id)}" ` +
    `data-ms-status="${escapeHtml(block.status)}" data-ms-type="${escapeHtml(block.type)}"` +
    (block.layout === undefined ? '' : ` data-ms-layout="${escapeHtml(block.layout)}"`) +
    `>` +
    parts.join('') +
    (ctx.annotate ? annotationFor(block) : '') +
    `</div>`
  );
}

/** 调试用标注：来源与状态。默认关闭。 */
function annotationFor(block: BlockInstance): string {
  const sources = Object.entries(block.sources)
    .map(([name, source]) => `${escapeHtml(name)}=${escapeHtml(source)}`)
    .join(' ');
  return (
    `<div class="ms-annotate">` +
    `<span class="ms-annotate__id">${escapeHtml(block.id)}</span>` +
    `<span class="ms-annotate__type">${escapeHtml(block.type)}</span>` +
    `<span class="ms-annotate__status">${escapeHtml(block.status)}</span>` +
    (sources === '' ? '' : `<span class="ms-annotate__sources">${sources}</span>`) +
    `</div>`
  );
}

// ── 样式 ────────────────────────────────────────────────────────────────

/**
 * 页面 CSS。
 *
 * 全部内联在 `<style>` 里、不引用任何外部资源（字体、CDN、图标库都不要）：
 * 页面要在 `network=none` 的容器里跑得起来，任何外链都是一次必然失败。
 */
export function pageStyles(): string {
  return `
:root {
  --ms-bg: #ffffff;
  --ms-fg: #1a1d21;
  --ms-muted: #5c6672;
  --ms-line: #e3e7ec;
  --ms-surface: #f7f9fb;
  --ms-accent: #2f6fd0;
  --ms-accent-fg: #ffffff;
  --ms-radius: 10px;
  --ms-max: 68rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ms-bg: #14171b;
    --ms-fg: #e8ebef;
    --ms-muted: #98a2ae;
    --ms-line: #2b3138;
    --ms-surface: #1b1f24;
    --ms-accent: #5b9bf5;
    --ms-accent-fg: #0d1117;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.7;
  color: var(--ms-fg);
  /* 底色不是纯色：一层很淡的实景底纹 + 两层主题色光晕。
     底纹只在页面里已有真图时出现，且压到 8% 左右——它负责"空气感"，
     不负责被看清，正文对比度优先。 */
  background:
    radial-gradient(1200px 620px at 82% -10%, color-mix(in srgb, var(--ms-accent) 14%, transparent), transparent 60%),
    radial-gradient(900px 520px at -12% 18%, color-mix(in srgb, var(--ms-accent) 9%, transparent), transparent 55%),
    var(--ms-bg);
  background-attachment: fixed;
}
img, svg { max-width: 100%; display: block; }
a { color: var(--ms-accent); }
h1, h2, h3 { line-height: 1.25; margin: 0 0 .6em; }
p { margin: 0 0 1em; }
ul { margin: 0; padding: 0; list-style: none; }

.ms-page { display: block; position: relative; }
/* 实景底纹：模糊、低透明度、铺满视口。用伪元素而不是 body 的多层背景，
   这样才能加 blur——不模糊的整张校园照透出来是"窗户竖条"，不是氛围。 */
.ms-page::before {
  content: "";
  position: fixed;
  inset: -4%;
  z-index: -1;
  pointer-events: none;
  background: var(--ms-bg-img, none) center / cover no-repeat;
  filter: blur(14px) saturate(.9);
  opacity: .16;
}
.ms-block { display: block; }
/* 相邻内容段交替底色：长页面往下滚时，段落之间有分界，不像一堵白墙。
   用"主题色 5% + 表面色"的渐变而不是平涂，段落才有层次。 */
.ms-block:nth-of-type(even) {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--ms-accent) 5%, color-mix(in srgb, var(--ms-surface) 95%, transparent)),
    color-mix(in srgb, var(--ms-surface) 97%, transparent)
  );
  border-top: 1px solid color-mix(in srgb, var(--ms-line) 65%, transparent);
}
.ms-section__heading { font-size: 1.5rem; text-wrap: balance; }
/* 小节标题前的一小段强调线：不需要额外文案，也能让每段有"被设计过"的起手 */
.ms-section__heading::before {
  content: ""; display: block; width: 2.25rem; height: 3px; border-radius: 2px;
  background: var(--ms-accent); opacity: .8; margin-bottom: .7rem;
}
html { scroll-behavior: smooth; }
[id^="ms-s"] { scroll-margin-top: 4.5rem; }

/* ── 页面壳：顶栏 ─────────────────────────────────────────────────
   位置固定、半透明，滚动时始终能看到"我在哪一页的哪一段"。
   结构里已经有 nav 块时不渲染它（避免两条导航叠在一起）。 */
.ms-topbar {
  position: sticky; top: 0; z-index: 20;
  background: var(--ms-bg);
  background: color-mix(in srgb, var(--ms-bg) 88%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--ms-line);
}
.ms-topbar__inner {
  max-width: var(--ms-max); margin: 0 auto; padding: .65rem 1.5rem;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
}
.ms-topbar__brand { font-weight: 650; letter-spacing: -.01em; }
.ms-topbar__links { display: flex; gap: 1.1rem; flex-wrap: wrap; }
.ms-topbar__link { color: var(--ms-muted); text-decoration: none; font-size: .92rem; }
.ms-topbar__link:hover { color: var(--ms-fg); }

/* 骨架块铺满，内容块居中收窄——版式上分得开，读起来也不散 */
.ms-nav {
  display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap;
  padding: .9rem 1.5rem; border-bottom: 1px solid var(--ms-line);
  background: var(--ms-surface);
}
.ms-nav__brand { font-weight: 650; }
.ms-nav__list { display: flex; gap: 1.1rem; flex-wrap: wrap; }
.ms-nav__item a { color: var(--ms-muted); text-decoration: none; font-size: .94rem; }
.ms-nav__item a:hover { color: var(--ms-fg); }

.ms-hero {
  display: grid; grid-template-columns: 1fr; gap: 2rem;
  max-width: var(--ms-max); margin: 0 auto; padding: 3.5rem 1.5rem;
}
@media (min-width: 60rem) {
  /* 分栏：文字在左、主视觉在右。padding 与下方内容段统一，
     避免上一版 5rem + 2.5rem 叠出一个空洞。 */
  .ms-hero--split { grid-template-columns: 1.1fr .9fr; align-items: center; padding: 4.5rem 1.5rem; }
  /* 镜像分栏：图在左、文字在右，用来打破相邻两段"都是左文右图"的重复 */
  .ms-hero--mirror { grid-template-columns: .9fr 1.1fr; align-items: center; padding: 4.5rem 1.5rem; }
  .ms-hero--mirror .ms-hero__visual { order: -1; }
}
.ms-hero--center {
  position: relative;
  isolation: isolate;
  max-width: 56rem; text-align: center; padding-top: 4rem; padding-bottom: 3rem;
}
/* 居中首屏背后的一团主题色光晕：没有它，标题+图就是"白底贴图"。 */
.ms-hero--center::before {
  content: "";
  position: absolute; left: 50%; top: -6rem;
  width: min(72rem, 120%); height: 34rem;
  transform: translateX(-50%);
  background: radial-gradient(
    50% 55% at 50% 45%,
    color-mix(in srgb, var(--ms-accent) 20%, transparent),
    transparent 70%
  );
  z-index: -1; pointer-events: none;
}
.ms-hero--center .ms-hero__subtitle { margin-left: auto; margin-right: auto; }
.ms-hero--center .ms-hero__visual { margin-top: .5rem; }
.ms-hero__title { font-size: clamp(1.9rem, 4vw, 2.9rem); letter-spacing: -.02em; text-wrap: balance; }
.ms-hero__subtitle { font-size: 1.1rem; color: var(--ms-muted); max-width: 34rem; }
.ms-hero__visual { min-width: 0; }
.ms-hero__visual img {
  border-radius: calc(var(--ms-radius) * 1.6);
  box-shadow: 0 30px 70px -32px rgba(15, 23, 42, .5);
}

/* 全幅背景：图铺满整屏，压一层暗色蒙层保证文字可读 */
.ms-hero--immersive { position: relative; display: block; max-width: none; padding: 0; background: #0f1115; }
.ms-hero--immersive .ms-hero__backdrop {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
}
.ms-hero--immersive .ms-hero__backdrop::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(8, 10, 14, .32), rgba(8, 10, 14, .74));
}
.ms-hero--immersive .ms-hero__body {
  position: relative; z-index: 1;
  max-width: var(--ms-max); margin: 0 auto; padding: 6.5rem 1.5rem;
  color: #fff;
}
.ms-hero--immersive .ms-hero__subtitle { color: rgba(255, 255, 255, .86); }

.ms-btn {
  display: inline-block; padding: .6rem 1.25rem; border-radius: var(--ms-radius);
  border: 1px solid var(--ms-line); text-decoration: none; font-size: .95rem;
  cursor: pointer; font-family: inherit; background: transparent; color: var(--ms-fg);
}
.ms-btn--primary { background: var(--ms-accent); color: var(--ms-accent-fg); border-color: transparent; }
.ms-btn--primary:hover { filter: brightness(1.08); }

.ms-features-section, .ms-gallery-section, .ms-text-section, .ms-table-section,
.ms-code-section, .ms-video-section, .ms-form-section, .ms-accordion-section,
.ms-generic {
  max-width: var(--ms-max); margin: 0 auto; padding: 3rem 1.5rem;
}
.ms-features { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 48rem) {
  /* 列数随条数自适应：4 条在宽屏上排成 4 列，不会孤一张挂到下一行。 */
  .ms-features--cards { grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
}
.ms-features__item {
  border: 1px solid var(--ms-line); border-radius: var(--ms-radius);
  padding: 1.25rem; background: var(--ms-surface);
  position: relative; overflow: hidden;
  transition: transform .15s ease, box-shadow .15s ease;
}
.ms-features__item::before {
  content: ""; position: absolute; inset: 0 0 auto; height: 3px;
  background: var(--ms-accent); opacity: .55;
}
.ms-features__item:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(0, 0, 0, .08); }
.ms-features__index { font-family: ui-monospace, monospace; font-size: .8rem; color: var(--ms-muted); }
.ms-features__item-title { font-size: 1.05rem; margin: .4rem 0 .3rem; }
.ms-features__item-detail { margin: 0; color: var(--ms-muted); font-size: .95rem; }
/* 列表行：序号在左、内容在右，行间用细线分隔——适合有先后的要点 */
.ms-features--rows { gap: 0; border-top: 1px solid var(--ms-line); }
.ms-features__row {
  display: grid; grid-template-columns: 2.5rem 1fr; gap: 1rem;
  padding: 1.15rem 0; border-bottom: 1px solid var(--ms-line);
}
.ms-features__row .ms-features__item-title { margin-top: 0; }

/* Bento 混排：首条占 2×2，其余填满网格。6 条时正好铺满 3×3。 */
.ms-features--bento { grid-template-columns: repeat(3, 1fr); grid-auto-rows: minmax(9rem, auto); }
.ms-features--bento .ms-features__item:first-child {
  grid-column: span 2; grid-row: span 2;
  display: flex; flex-direction: column; justify-content: center;
  padding: 2rem;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--ms-accent) 10%, var(--ms-surface)),
    var(--ms-surface) 72%
  );
}
.ms-features--bento .ms-features__item:first-child .ms-features__item-title { font-size: 1.35rem; }
@media (max-width: 48rem) {
  .ms-features--bento { grid-template-columns: 1fr; }
  .ms-features--bento .ms-features__item:first-child { grid-column: auto; grid-row: auto; }
}

.ms-gallery { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
/* 瀑布流：按列纵向排布，允许图高不一致 */
.ms-gallery--masonry { display: block; columns: 3; column-gap: 1rem; }
.ms-gallery--masonry .ms-gallery__item { break-inside: avoid; margin-bottom: 1rem; }
@media (max-width: 64rem) { .ms-gallery--masonry { columns: 2; } }
@media (max-width: 40rem) { .ms-gallery--masonry { columns: 1; } }
/* 一大两小拼贴：首图占 2×2，其余小图填满网格。 */
.ms-gallery--collage { grid-template-columns: repeat(3, 1fr); grid-auto-rows: minmax(10rem, 1fr); }
.ms-gallery--collage .ms-gallery__item { overflow: hidden; border-radius: var(--ms-radius); }
.ms-gallery--collage .ms-gallery__item:first-child { grid-column: span 2; grid-row: span 2; }
.ms-gallery--collage .ms-img { width: 100%; height: 100%; object-fit: cover; }
.ms-gallery--collage .ms-figure { height: 100%; }
.ms-gallery--collage .ms-figure__caption { display: none; }
@media (max-width: 48rem) {
  .ms-gallery--collage { grid-template-columns: 1fr; }
  .ms-gallery--collage .ms-gallery__item:first-child { grid-column: auto; grid-row: auto; }
}

.ms-figure { margin: 0; }
.ms-figure__caption { font-size: .85rem; color: var(--ms-muted); margin-top: .4rem; }

.ms-cta {
  max-width: var(--ms-max); margin: 0 auto; padding: 2.75rem 1.5rem;
  display: flex; flex-wrap: wrap; align-items: center; gap: 1.25rem;
}
.ms-cta--banner {
  border-top: 1px solid var(--ms-line); border-bottom: 1px solid var(--ms-line);
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--ms-accent) 8%, var(--ms-surface)),
    var(--ms-surface) 62%
  );
}
.ms-cta--card {
  flex-direction: column; align-items: center; justify-content: center; text-align: center;
  margin: 1.5rem auto; padding: 2.5rem 2rem;
  border: 1px solid var(--ms-line); border-radius: calc(var(--ms-radius) * 1.6);
  background: var(--ms-surface);
}
.ms-cta__text { margin: 0; font-size: 1.25rem; font-weight: 600; flex: 1 1 18rem; max-width: 44rem; }
.ms-cta--card .ms-cta__text { flex: 0 1 auto; }

.ms-footer {
  max-width: var(--ms-max); margin: 0 auto; padding: 2rem 1.5rem 3rem;
  display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between;
  color: var(--ms-muted); font-size: .9rem;
}
.ms-footer--shell { border-top: 1px solid var(--ms-line); margin-top: 1rem; }
.ms-footer__copyright { margin: 0; }
.ms-footer__links { display: flex; gap: 1rem; flex-wrap: wrap; }

.ms-prose { max-width: 44rem; }

.ms-code {
  background: var(--ms-surface); border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius); padding: 1rem; overflow-x: auto; margin: 0;
}
.ms-code__body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem; }

.ms-quote {
  max-width: 44rem; margin: 0 auto; padding: 2rem 1.5rem;
  border-left: 3px solid var(--ms-accent);
}
.ms-quote__text { font-size: 1.15rem; margin: 0 0 .5rem; }
.ms-quote__source { color: var(--ms-muted); font-size: .9rem; }

.ms-table { width: 100%; border-collapse: collapse; font-size: .95rem; }
.ms-table th, .ms-table td { text-align: left; padding: .6rem .75rem; border-bottom: 1px solid var(--ms-line); }
.ms-table th { background: var(--ms-surface); font-weight: 600; }

.ms-form { display: grid; gap: .9rem; max-width: 32rem; }
.ms-form__field { display: grid; gap: .3rem; }
.ms-form__label { font-size: .9rem; color: var(--ms-muted); }
.ms-form__input {
  padding: .55rem .7rem; border: 1px solid var(--ms-line); border-radius: 8px;
  background: var(--ms-bg); color: var(--ms-fg); font-family: inherit; font-size: .95rem;
}
.ms-form__submit { justify-self: start; }
.ms-form__note { margin: 0; color: var(--ms-accent); font-size: .9rem; }

.ms-tabs { max-width: var(--ms-max); margin: 0 auto; padding: 2.5rem 1.5rem; }
.ms-tabs__list { display: flex; gap: .35rem; flex-wrap: wrap; border-bottom: 1px solid var(--ms-line); }
.ms-tabs__tab {
  padding: .5rem 1rem; border: 1px solid transparent; border-bottom: none;
  background: transparent; color: var(--ms-muted); cursor: pointer;
  font-family: inherit; font-size: .95rem;
  border-radius: 8px 8px 0 0;
}
.ms-tabs__tab[aria-selected="true"] {
  color: var(--ms-fg); background: var(--ms-surface);
  border-color: var(--ms-line); margin-bottom: -1px;
}
.ms-tabs__panel { padding: 1.25rem 0; }

.ms-accordion { display: grid; gap: .5rem; }
.ms-accordion__item { border: 1px solid var(--ms-line); border-radius: var(--ms-radius); }
.ms-accordion__summary {
  padding: .8rem 1rem; cursor: pointer; font-weight: 550; list-style-position: inside;
}
.ms-accordion__body { padding: 0 1rem 1rem; color: var(--ms-muted); }
.ms-accordion__body p { margin: 0 0 .6em; }

.ms-video__placeholder {
  display: grid; place-items: center; min-height: 12rem;
  border: 2px dashed var(--ms-line); border-radius: var(--ms-radius);
  color: var(--ms-muted); background: var(--ms-surface);
}
.ms-video__player { width: 100%; border-radius: var(--ms-radius); }

.ms-image-block { max-width: var(--ms-max); margin: 0 auto; padding: 1.5rem; }

/* 自定义 block 的通用版式：没有专属样式，只保证排版不塌、与其余内容块同节奏。
   列表要显式给 list-style 与缩进——全局把 ul 的它们都清掉了。 */
.ms-generic__body { display: grid; gap: .9rem; }
.ms-generic__title { font-size: 1.15rem; margin: 0; }
.ms-generic__list { display: grid; gap: .35rem; padding-left: 1.25rem; list-style: disc; }
.ms-generic__link { margin: 0; }

/* 中间态与错误提示：可见、但不喧宾夺主 */
.ms-block-pending, .ms-block-error, .ms-unknown {
  margin: .5rem auto; max-width: var(--ms-max);
  padding: .5rem .9rem; border-radius: 8px; font-size: .85rem;
}
.ms-block-pending { border: 1px dashed var(--ms-line); color: var(--ms-muted); }
.ms-block-error, .ms-unknown {
  border: 1px solid #d9534f55; background: #d9534f14; color: #b3403c;
}

.ms-annotate {
  max-width: var(--ms-max); margin: 0 auto; padding: .25rem 1.5rem;
  display: flex; flex-wrap: wrap; gap: .5rem;
  font-family: ui-monospace, monospace; font-size: .7rem; color: var(--ms-muted);
  opacity: .75;
}
.ms-annotate__id { font-weight: 700; }
`.trim();
}

// ── 入口 ────────────────────────────────────────────────────────────────

/**
 * 标签页切换的脚本。
 *
 * 只有页面上真的有 `tabs` 块时才注入——没用到就不给页面加脚本，
 * 这既是体积考量，也让"没有交互块"的页面保持零脚本。
 *
 * 用事件委托而不是给每个按钮绑 `onclick`：脚本可以在标签之前或之后执行，
 * 委托到 `document` 上就不依赖加载顺序。**不引入任何外部库**。
 */
function tabsScript(): string {
  return `<script>
(function () {
  document.addEventListener('click', function (e) {
    var tab = e.target && e.target.closest ? e.target.closest('[data-ms-tab]') : null;
    if (!tab) return;
    var group = tab.closest('[data-ms-tabs]');
    if (!group) return;
    var key = tab.getAttribute('data-ms-tab');
    var tabs = group.querySelectorAll('[data-ms-tab]');
    var panels = group.querySelectorAll('[data-ms-panel]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', tabs[i] === tab ? 'true' : 'false');
    }
    for (var j = 0; j < panels.length; j++) {
      var panel = panels[j];
      var own = panel.getAttribute('data-ms-panel');
      var show = own === key || (own && key && own.split(':')[0] === key.split(':')[0] &&
        own.split(':')[1] === key.split(':')[1]);
      if (show) { panel.removeAttribute('hidden'); } else { panel.setAttribute('hidden', ''); }
    }
  });
})();
</script>`;
}

/**
 * 页面壳：结构里没有 `nav` 时补一条顶栏，没有 `footer` 时补一行页脚。
 *
 * **不覆盖用户/模型已经排出来的块**：页面里有 nav 就让它自己当顶栏，
 * 再叠一条只会出现两个导航。壳只负责"缺了才补"，不负责重排。
 * 顶栏里的锚点取每块的真实小节标题，所以它就是一份可以从上往下跳的目录。
 */
function topbarHtml(brand: string, anchors: readonly { id: string; label: string }[]): string {
  const links = anchors
    .slice(0, 6)
    .map((anchor) => `<a class="ms-topbar__link" href="#${escapeHtml(anchor.id)}">${inline(anchor.label)}</a>`)
    .join('');
  return (
    `<header class="ms-topbar">` +
    `<div class="ms-topbar__inner">` +
    `<span class="ms-topbar__brand">${inline(brand)}</span>` +
    (links === '' ? '' : `<nav class="ms-topbar__links" aria-label="页面段落">${links}</nav>`) +
    `</div>` +
    `</header>`
  );
}

function shellFooterHtml(brand: string): string {
  // 不写年份：渲染器承诺**同样的输入逐字节相同**（见文件头第 3 条）。
  return (
    `<footer class="ms-footer ms-footer--shell">` +
    `<p class="ms-footer__copyright">© ${inline(brand)}</p>` +
    `</footer>`
  );
}

/** 把结构化页面渲染成完整 HTML 文档。
 *
 * 输出是**自包含**的：一个字符串，写进文件就能直接打开，
 * 不依赖任何外部资源。这是"能在 network=none 的沙盒里跑起来"的前提。
 */
/** 页面里第一张可当底纹的真图（data URI，且不太大，避免把页面撑爆）。 */
function firstImageDataUri(spec: PageSpec): string | undefined {
  const usable = (ref: unknown): ref is string =>
    typeof ref === 'string' && ref.startsWith('data:image/') && ref.length < 1_500_000;
  for (const block of spec.blocks) {
    for (const value of Object.values(block.slots)) {
      // 这里只是"找个底纹"，不该因为某个 slot 形态异常把整页弄挂。
      if (typeof value !== 'object' || value === null) continue;
      const slot = value as { kind?: unknown; ref?: unknown; refs?: unknown };
      if (slot.kind === 'image' && usable(slot.ref)) return slot.ref;
      if (slot.kind === 'list-image' && Array.isArray(slot.refs)) {
        for (const ref of slot.refs) {
          if (typeof ref !== 'object' || ref === null) continue;
          const item = ref as { ref?: unknown };
          if (usable(item.ref)) return item.ref;
        }
      }
    }
  }
  return undefined;
}

export function renderPage(spec: PageSpec, options: RenderOptions = {}): string {
  const title = options.title ?? spec.goal;
  const ctx: RenderContext = { annotate: options.annotate === true, blocks: options.blocks };

  const body = spec.blocks.map((block, index) => renderBlock(block, ctx, index)).join('\n');
  const needsTabsScript = spec.blocks.some((b) => b.type === 'tabs');
  // 页面背景图：取页面里第一张不太大的真图，压成很淡的底纹。
  // 只定义一次 CSS 变量，body 里引用，避免同一张 base64 在文档里写两遍。
  const backgroundImage = firstImageDataUri(spec);

  const hasNav = spec.blocks.some((b) => b.type === 'nav');
  const hasFooter = spec.blocks.some((b) => b.type === 'footer');
  const brand = deriveBrand(spec.goal);
  const anchors = hasNav
    ? []
    : spec.blocks
        .map((block, index) => ({ id: `ms-s${index + 1}`, label: anchorLabel(block) }))
        .filter((anchor) => anchor.label !== '');
  const topbar = hasNav ? '' : topbarHtml(brand, anchors);
  const footer = hasFooter ? '' : shellFooterHtml(brand);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="generator" content="MediaSandbox 结构化制作链路">
<meta name="ms-blocks" content="${escapeHtml(String(spec.blocks.length))}">
<style>
${backgroundImage === undefined ? '' : `:root{--ms-bg-img:url("${backgroundImage}")}`}
${pageStyles()}
</style>
</head>
<body>
${topbar}
<main class="ms-page" data-ms-project="${escapeHtml(spec.projectId)}" data-ms-blocks="${escapeHtml(String(spec.blocks.length))}">
${body}
</main>
${footer}
${needsTabsScript ? tabsScript() : ''}
</body>
</html>
`;
}
