/**
 * 海报：文案 → HTML → 图片。
 *
 * ## 为什么海报是"工作流"的第一个真实用例
 *
 * 网页和演示文稿的结构都由决策模型逐块决定，图是运行期才长出来的。
 * 海报正好相反：**版式是固定的**（标题、副标题、要点、行动语、落款），
 * 变的只有尺寸与配色。于是它天然是一张静态 DAG：
 *
 * ```
 * 文案执笔 → 版式渲染(×4 尺寸) → 截图导出(×4)
 * ```
 *
 * 这张图能直接验证工作流引擎的三件事：节点并发、缓存命中、产物落盘。
 *
 * ## 尺寸
 *
 * 四个预设覆盖常见投放位：竖版海报、社媒方图、横版 Banner、A4 打印。
 * 尺寸只影响画布与字号档，**不改变内容**——同一份文案换尺寸即可复用。
 */

export interface PosterSize {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** 字号基准（px）。竖版可以更大，横版必须收着，否则一行放不下。 */
  readonly baseFont: number;
}

export const POSTER_SIZES: readonly PosterSize[] = [
  { id: 'story', label: '竖版海报', width: 1080, height: 1440, baseFont: 64 },
  { id: 'square', label: '方形社媒图', width: 1080, height: 1080, baseFont: 58 },
  { id: 'banner', label: '横版 Banner', width: 1200, height: 628, baseFont: 46 },
  { id: 'a4', label: 'A4 打印', width: 1240, height: 1754, baseFont: 68 },
];

export const DEFAULT_POSTER_SIZE = 'story';

export function resolvePosterSize(id: string | undefined): PosterSize {
  return POSTER_SIZES.find((size) => size.id === id) ?? POSTER_SIZES[0]!;
}

/** 海报文案。由执笔节点产出，版式节点只负责摆。 */
export interface PosterBrief {
  /** 主标题，最重的一行。 */
  readonly headline: string;
  /** 副标题，一句解释。 */
  readonly subheadline: string;
  /** 3~4 条要点。 */
  readonly points: readonly string[];
  /** 行动语（"立即报名"这类）。 */
  readonly cta: string;
  /** 落款：主办方/日期/地点。 */
  readonly footer: string;
  /** 配色：深色底 + 一个强调色，稳且不挑内容。 */
  readonly palette: {
    readonly from: string;
    readonly to: string;
    readonly accent: string;
    readonly ink: string;
  };
}

export const DEFAULT_PALETTE: PosterBrief['palette'] = {
  from: '#0f172a',
  to: '#1e3a5f',
  accent: '#38bdf8',
  ink: '#f8fafc',
};

/** 把任意输入收敛成一份合法文案：字段缺失就补，长度超了就截。 */
export function normalizeBrief(raw: unknown): PosterBrief {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown, fallback: string, max: number): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text === '' ? fallback : text.slice(0, max);
  };
  const pointsRaw = Array.isArray(record['points']) ? record['points'] : [];
  const points = pointsRaw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item !== '')
    .slice(0, 4)
    .map((item) => item.slice(0, 28));
  const paletteRaw =
    record['palette'] !== null && typeof record['palette'] === 'object'
      ? (record['palette'] as Record<string, unknown>)
      : {};
  const color = (value: unknown, fallback: string): string =>
    typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : fallback;

  return {
    headline: text(record['headline'], '活动海报', 18),
    subheadline: text(record['subheadline'], '', 60),
    points,
    cta: text(record['cta'], '了解详情', 12),
    footer: text(record['footer'], '', 40),
    palette: {
      from: color(paletteRaw['from'], DEFAULT_PALETTE.from),
      to: color(paletteRaw['to'], DEFAULT_PALETTE.to),
      accent: color(paletteRaw['accent'], DEFAULT_PALETTE.accent),
      ink: color(paletteRaw['ink'], DEFAULT_PALETTE.ink),
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PosterRenderOptions {
  /**
   * 背景图：`data:image/...` 或 http(s) 地址。
   *
   * 给了就压一层深色蒙版：海报上的字必须始终可读，而背景图的明暗不可控。
   * 这也让"换一张背景"不需要改版式。
   */
  readonly background?: string | undefined;
  /** 叠在图上的落款 logo 文字（通常品牌名）。 */
  readonly logo?: string | undefined;
}

/**
 * 渲染一张海报的完整 HTML。
 *
 * 用内联样式与 `clamp()` 字号：一组 CSS 要适配四个尺寸，
 * 按尺寸写四套样式必然走样。这里只让 `--base` 随尺寸变，其余按比例缩。
 */
export function renderPosterHtml(
  brief: PosterBrief,
  size: PosterSize,
  options: PosterRenderOptions = {},
): string {
  const { from, to, accent, ink } = brief.palette;
  const points = brief.points
    .map(
      (point, index) =>
        `<li><span class="dot">${String(index + 1).padStart(2, '0')}</span>${escapeHtml(point)}</li>`,
    )
    .join('');
  const wide = size.width > size.height;
  const hasBackground =
    options.background !== undefined && options.background.trim() !== '';
  const cssUrl = hasBackground ? JSON.stringify(options.background!.trim()) : '';
  // `wide` 不只是给 CSS 用：有背景图时横版走"左文右图"，竖版走"上图下文"，
  // 两者靠这个 class 分叉。
  const bodyClass = [hasBackground ? 'has-bg' : '', wide ? 'wide' : ''].filter((name) => name !== '').join(' ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="poster-size" content="${size.id}" />
<title>${escapeHtml(brief.headline)}</title>
<style>
  :root {
    --from: ${from};
    --to: ${to};
    --accent: ${accent};
    --ink: ${ink};
    --base: ${size.baseFont}px;
    --w: ${size.width}px;
    --h: ${size.height}px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  html { background: linear-gradient(155deg, var(--from) 0%, var(--to) 100%); }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: var(--ink);
    background: transparent;
  }
  /* 背景铺在**固定定位**的图层上：截图工具的视口高度与实际画布偶尔差几像素，
     用 body 的高度去铺会漏出一条白边；fixed 图层永远铺满可见区域。 */
  body::before {
    content: "";
    position: fixed;
    /* 上下各外扩 100px：截图工具的窗口高度与 CSS 视口偶尔差几十像素，
       只铺 inset:0 会在底部漏出一条底色。固定层外扩后永远盖过边界。 */
    inset: -100px 0 -100px 0;
    z-index: 0;
    background:
      radial-gradient(120% 80% at 12% 0%, color-mix(in srgb, var(--accent) 26%, transparent) 0%, transparent 60%),
      radial-gradient(90% 70% at 100% 100%, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 55%),
      linear-gradient(155deg, var(--from) 0%, var(--to) 100%);
  }
  ${
    hasBackground
      ? `body.has-bg::before {
    background-image:
      linear-gradient(100deg,
        color-mix(in srgb, var(--from) 92%, transparent) 0%,
        color-mix(in srgb, var(--from) 46%, transparent) 58%,
        transparent 100%),
      url(${cssUrl});
    background-size: cover, cover;
    background-position: center, center;
    background-repeat: no-repeat, no-repeat;
  }
  /* 竖版走"上图下文"，所以横向那层 92% 的压暗反而把上半幅图也压平了；
     这里改成只压顶部一点点，剩下的交给下面的 ::after 底板。 */
  body.has-bg:not(.wide)::before {
    background-image:
      linear-gradient(180deg,
        color-mix(in srgb, var(--from) 52%, transparent) 0%,
        color-mix(in srgb, var(--from) 10%, transparent) 34%,
        transparent 46%),
      url(${cssUrl});
    background-size: cover, cover;
    background-position: center, center;
    background-repeat: no-repeat, no-repeat;
  }
  /* 有图时的**文字底板**：字必须始终压得住。
     竖版是"上半幅图、下半幅字"——文字整体下沉，落在这层近实色底上；
     横版是"左文右图"——左侧铺到 62% 几乎不透。 */
  body.has-bg:not(.wide)::after {
    content: "";
    position: fixed;
    left: 0;
    right: 0;
    bottom: -100px;
    height: 62%;
    z-index: 0;
    background: linear-gradient(
      180deg,
      transparent 0%,
      color-mix(in srgb, var(--from) 58%, transparent) 12%,
      color-mix(in srgb, var(--from) 92%, transparent) 34%,
      var(--from) 78%);
  }
  body.has-bg.wide::after {
    content: "";
    position: fixed;
    top: -100px;
    bottom: -100px;
    left: 0;
    width: 60%;
    z-index: 0;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--from) 97%, transparent) 0%,
      color-mix(in srgb, var(--from) 88%, transparent) 64%,
      transparent 100%);
  }
  /* 文字下沉：让标题落在底板上，而不是压在图的主体上。 */
  body.has-bg:not(.wide) .canvas {
    justify-content: flex-end;
    padding-bottom: calc(var(--base) * 1.35);
  }
  body.has-bg:not(.wide) .main {
    flex: 0 0 auto;
    justify-content: flex-start;
    gap: calc(var(--base) * 0.52);
  }
  /* 标题限宽：不限的话方形尺寸会排成一整行横跨到图的主体上。 */
  body.has-bg h1 {
    max-width: 92%;
  }
  body.has-bg:not(.wide) h1 {
    font-size: calc(var(--base) * 1.28);
  }
  /* 横版：左文右图，动作条也收回左侧，别飘到图上去。 */
  body.has-bg.wide .canvas {
    flex-direction: column;
    align-items: stretch;
    justify-content: space-between;
  }
  body.has-bg.wide h1 {
    max-width: 58%;
  }
  body.has-bg.wide .main {
    flex: 0 0 auto;
  }
  body.has-bg.wide .foot {
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    gap: calc(var(--base) * 0.8);
    min-width: 0;
  }
  /* 方形比竖版矮，底板占比小一点，让图多露出来。 */
  @media (max-aspect-ratio: 1/1) {
    body.has-bg:not(.wide)::after {
      height: 58%;
    }
  }
  .logo {
    position: absolute;
    top: calc(var(--base) * 1.1);
    right: calc(var(--base) * 1.1);
    z-index: 2;
    font-size: calc(var(--base) * 0.3);
    letter-spacing: 0.18em;
    color: color-mix(in srgb, var(--ink) 78%, transparent);
    text-shadow: 0 1px 6px color-mix(in srgb, var(--from) 70%, transparent);
  }`
      : ''
  }
  .canvas {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    padding: calc(var(--base) * 1.1);
    display: flex;
    flex-direction: ${wide ? 'row' : 'column'};
    ${wide ? 'align-items: center;' : ''}
    gap: calc(var(--base) * 0.9);
  }
  .ring {
    position: absolute;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
    opacity: 0.55;
    pointer-events: none;
  }
  .ring.a { width: calc(var(--base) * 9); height: calc(var(--base) * 9); right: calc(var(--base) * -2.4); top: calc(var(--base) * -3); }
  .ring.b { width: calc(var(--base) * 5.4); height: calc(var(--base) * 5.4); left: calc(var(--base) * -1.8); bottom: calc(var(--base) * -1.6); opacity: 0.3; }
  .main { position: relative; z-index: 1; display: flex; flex-direction: column; ${wide ? 'gap: calc(var(--base) * 0.75); flex: 1.25;' : 'gap: calc(var(--base) * 0.75); flex: 1; justify-content: center;'} }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--base) * 0.28);
    font-size: calc(var(--base) * 0.34);
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--accent) 88%, white 12%);
  }
  .eyebrow::before {
    content: "";
    width: calc(var(--base) * 0.5);
    height: 2px;
    background: var(--accent);
    display: inline-block;
  }
  h1 {
    font-size: calc(var(--base) * ${wide ? '1.35' : '1.55'});
    line-height: 1.12;
    font-weight: 800;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .sub {
    font-size: calc(var(--base) * 0.46);
    line-height: 1.55;
    color: color-mix(in srgb, var(--ink) 78%, transparent);
    max-width: ${wide ? '34ch' : '22ch'};
  }
  ul { list-style: none; display: flex; flex-direction: column; gap: calc(var(--base) * 0.38); }
  li {
    display: flex;
    align-items: baseline;
    gap: calc(var(--base) * 0.42);
    font-size: calc(var(--base) * 0.44);
    line-height: 1.35;
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
  .dot {
    font-size: calc(var(--base) * 0.3);
    font-variant-numeric: tabular-nums;
    color: var(--accent);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    padding-bottom: 2px;
  }
  .foot {
    position: relative;
    z-index: 1;
    display: flex;
    ${wide ? 'flex-direction: column; align-items: flex-start; gap: calc(var(--base) * 0.55); min-width: 30%;' : 'align-items: center; justify-content: space-between;'}
    gap: calc(var(--base) * 0.5);
  }
  .cta {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--base) * 0.3);
    padding: calc(var(--base) * 0.34) calc(var(--base) * 0.72);
    border-radius: 999px;
    background: var(--accent);
    color: #06121f;
    font-size: calc(var(--base) * 0.4);
    font-weight: 700;
    white-space: nowrap;
  }
  .cta::after { content: "→"; }
  .sig {
    font-size: calc(var(--base) * 0.3);
    letter-spacing: 0.12em;
    color: color-mix(in srgb, var(--ink) 62%, transparent);
  }
</style>
</head>
<body${bodyClass === '' ? '' : ` class="${bodyClass}"`}>
  ${options.logo !== undefined && options.logo.trim() !== '' ? `<div class="logo">${escapeHtml(options.logo.trim())}</div>` : ''}
  <div class="canvas">
    <span class="ring a"></span>
    <span class="ring b"></span>
    <div class="main">
      <span class="eyebrow">Poster</span>
      <h1>${escapeHtml(brief.headline)}</h1>
      ${brief.subheadline === '' ? '' : `<p class="sub">${escapeHtml(brief.subheadline)}</p>`}
      ${points === '' ? '' : `<ul>${points}</ul>`}
    </div>
    <div class="foot">
      <span class="cta">${escapeHtml(brief.cta)}</span>
      ${brief.footer === '' ? '' : `<span class="sig">${escapeHtml(brief.footer)}</span>`}
    </div>
  </div>
</body>
</html>`;
}
