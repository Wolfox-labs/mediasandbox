/**
 * 演示文稿主题：**视觉方向由决策模型选**，不是写死一套。
 *
 * ## 为什么需要这一层
 *
 * 只有"版式池"时，所有文稿长得一模一样：同一套底色、同一个强调色、
 * 同一种字重。版式决定的是**信息结构**（这页讲几件事、怎么排），
 * 主题决定的是**视觉气质**（冷暖、轻重、疏密）。两件事都该有人决定，
 * 而"这次要什么气质"恰恰是决策模型能答、代码不该替它答的封闭问题。
 *
 * ## 所以主题是一个 `choice` 问题
 *
 * `deck-assembler` 在逐页选版式**之前**问一次 `deck_theme`，候选是 `DECK_THEMES` 里的全部。
 * 决定结果：
 *   - 进 `plan.rationale`（看得见"为什么是这个气质"）
 *   - 作为 `assemble-deck` 的入参（渲染时用）
 *   - 写进 `artifacts/deck.json` 的 `themeId` 与 HTML 的 `data-ms-theme`
 *     （**生成结果上能查到是哪次决策定的**，不是只活在日志里）
 *
 * ## 用 CSS 变量而不是四套模板
 *
 * 主题只改一组变量（底、字、强调、弱化、显示字体、圆角、留白密度），
 * 版式仍然只有一份实现。这样加主题不碰版式、加版式不碰主题——
 * 否则 4 主题 × 12 版式就是 48 份要各自维护的样式。
 */

/** 一套主题。字段刻意少：多了就会变成"每个版式都要为它写特例"。 */
export interface DeckTheme {
  readonly id: string;
  readonly label: string;
  /** 喂给决策模型的一句描述：要说**区别**，不能只说"深色"。 */
  readonly description: string;
  readonly vars: {
    /** 幻灯片底色（不是页面底色）。 */
    readonly bg: string;
    /** 正文色。 */
    readonly fg: string;
    /** 强调色：编号、项目符号、边框。 */
    readonly accent: string;
    /** 弱化文字（图注、出处、页码）。 */
    readonly muted: string;
    /** 卡片/次级面底。 */
    readonly surface: string;
    /** 标题字体栈。 */
    readonly display: string;
    /** 标题字重与字距，决定"轻"还是"重"。 */
    readonly displayWeight: string;
    readonly displayTracking: string;
    /** 一页的内边距，单位 cqw。 */
    readonly padX: string;
    readonly padY: string;
    /** 圆角，单位 cqw。 */
    readonly radius: string;
  };
}

/**
 * 内置主题。
 *
 * 每套的气质差别是**一眼能看出来**的（深冷 / 暖纸 / 极简 / 高饱和 / 科技蓝 /
 * 红旅红金 / 土黄国风 / 黑金），因为决策模型只能读描述、用户只能看结果——
 * 中间没有任何解释环节。后四套取自创赛 PPT 素材的实际配色，不是凭空造的。
 */
export const DECK_THEMES: readonly DeckTheme[] = [
  {
    id: 'midnight',
    label: '深夜科技',
    description: '深蓝近黑的底、冷白字、亮蓝强调。适合技术方案、数据复盘、产品发布这类"要显得硬"的场合',
    vars: {
      bg: 'linear-gradient(135deg,#10151f 0%,#1a2333 55%,#22304a 100%)',
      fg: '#f2f5fa',
      accent: '#5b8cff',
      muted: '#9aa7bd',
      surface: 'rgba(255,255,255,.06)',
      display: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      displayWeight: '700',
      displayTracking: '-0.01em',
      padX: '8',
      padY: '6',
      radius: '0.8',
    },
  },
  {
    id: 'editorial',
    label: '暖纸杂志',
    description: '米白纸感的底、墨黑字、赭红强调、衬线大标题。适合品牌故事、人物访谈、行业观察这类"要读得下去"的场合',
    vars: {
      bg: 'linear-gradient(180deg,#faf6ef 0%,#f3ece1 100%)',
      fg: '#1f1b16',
      accent: '#b4553a',
      muted: '#7a6d5e',
      surface: '#efe6d8',
      display: 'Georgia,"Songti SC","Noto Serif SC",serif',
      displayWeight: '600',
      displayTracking: '0',
      padX: '9',
      padY: '7',
      radius: '0.3',
    },
  },
  {
    id: 'mono',
    label: '极简网格',
    description: '纯白底、纯黑字、只用细线分隔，几乎没有颜色。适合内部汇报、方法论、清单类内容，信息密度优先',
    vars: {
      bg: '#ffffff',
      fg: '#111111',
      accent: '#111111',
      muted: '#8c8c8c',
      surface: '#f4f4f4',
      display: '"Helvetica Neue",Arial,"PingFang SC",sans-serif',
      displayWeight: '600',
      displayTracking: '-0.02em',
      padX: '10',
      padY: '7',
      radius: '0',
    },
  },
  {
    id: 'vivid',
    label: '高饱和渐变',
    description: '紫到粉的渐变底、白字、亮黄强调。适合对外宣讲、活动招募、创意提案这类"要抓眼球"的场合',
    vars: {
      bg: 'linear-gradient(135deg,#3b1d6e 0%,#7a2b8f 50%,#c2417a 100%)',
      fg: '#ffffff',
      accent: '#ffd45e',
      muted: '#e2cfea',
      surface: 'rgba(255,255,255,.12)',
      display: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      displayWeight: '800',
      displayTracking: '-0.015em',
      padX: '9',
      padY: '6',
      radius: '1.2',
    },
  },
  // ── 以下四套来自创赛 PPT 素材的实际配色（科技风蓝 / 红旅红金 / 土黄国风 / 黑金）──
  // 它们的底色不是单层渐变，而是「一层光斑 + 一层渐变」：原稿的视觉重量主要来自
  // 左下或顶部的光晕，纯线性渐变复现不出来。`background` 支持多层，所以不必新增变量。
  {
    id: 'tech-cyan',
    label: '科技风蓝',
    description: '近黑的深海军蓝，左下角一片青色光晕、右下角一片电蓝光晕，亮青强调。适合硬科技方案、架构图、数据看板这类"要显得精密"的场合',
    vars: {
      bg:
        'radial-gradient(120% 95% at 6% 102%,rgba(0,224,255,.28) 0%,transparent 58%),' +
        'radial-gradient(90% 75% at 94% -8%,rgba(1,109,255,.45) 0%,transparent 66%),' +
        'linear-gradient(140deg,#061a33 0%,#0a2b4e 52%,#0d3a63 100%)',
      fg: '#e9f3ff',
      accent: '#35d7ff',
      muted: '#8ba7c7',
      surface: 'rgba(53,215,255,.10)',
      display: '"PingFang SC","Source Han Sans SC","Microsoft YaHei",system-ui,sans-serif',
      displayWeight: '700',
      displayTracking: '-0.01em',
      padX: '8',
      padY: '6',
      radius: '0.5',
    },
  },
  {
    id: 'red-gold',
    label: '红旅红金',
    description: '深红底、顶部一片暖金光，标题用宋体。适合红色文旅、非遗传承、公益赛道这类"要显得庄重"的场合',
    vars: {
      bg:
        'radial-gradient(110% 85% at 50% -10%,rgba(232,183,82,.20) 0%,transparent 62%),' +
        'linear-gradient(160deg,#3a0c10 0%,#5a1216 48%,#280708 100%)',
      fg: '#f8ecdf',
      accent: '#e8b752',
      muted: '#c9a58f',
      surface: 'rgba(232,183,82,.10)',
      display: '"Songti SC","Source Han Serif SC","Noto Serif SC",serif',
      displayWeight: '700',
      displayTracking: '0.01em',
      padX: '9',
      padY: '6',
      radius: '0.2',
    },
  },
  {
    id: 'opera-sand',
    label: '土黄国风',
    description: '宣纸米黄底、墨褐字、赭红强调、宋体标题，右上角一点朱砂色晕。适合传统文化、戏曲、中医药这类"要显得有年头的"场合',
    vars: {
      bg:
        'radial-gradient(95% 80% at 88% 6%,rgba(156,43,28,.14) 0%,transparent 60%),' +
        'linear-gradient(170deg,#f6ecd6 0%,#e9d7b3 58%,#dcc59b 100%)',
      fg: '#2a2018',
      accent: '#9c2b1c',
      muted: '#7b6650',
      surface: 'rgba(156,43,28,.08)',
      display: '"Songti SC","Source Han Serif SC","Noto Serif SC",serif',
      displayWeight: '600',
      displayTracking: '0.02em',
      padX: '9',
      padY: '7',
      radius: '0',
    },
  },
  {
    id: 'ink-gold',
    label: '黑金',
    description: '近黑的暖底、左上角一片金色光晕、金色强调。适合高端品牌、颁奖、投资路演这类"要显得贵"的场合',
    vars: {
      bg:
        'radial-gradient(90% 75% at 16% 4%,rgba(200,162,74,.22) 0%,transparent 58%),' +
        'linear-gradient(135deg,#09090b 0%,#15120c 55%,#211b11 100%)',
      fg: '#f4efe4',
      accent: '#c8a24a',
      muted: '#9a8d74',
      surface: 'rgba(200,162,74,.09)',
      display: '"PingFang SC","Source Han Sans SC","Microsoft YaHei",system-ui,sans-serif',
      displayWeight: '700',
      displayTracking: '-0.01em',
      padX: '8',
      padY: '6',
      radius: '0.3',
    },
  },
];

/** 决策层用的问句 id。集中定义，避免散落的字符串。 */
export const DECK_THEME_QUESTION = 'deck_theme';

/**
 * 构图的问句 id 与候选。
 *
 * 构图决定"整份文稿的节奏"：
 *   - `parallel` 每页同一套排法（平静、像正式报告）
 *   - `ranked`   偶数页换成另一种排法（排行 / 编号 / 主从），翻页有轻重
 *
 * 它与主题**同批问**：两者都是"整体气质"层面的决定，一次决策往返问两个
 * 问题，比分成两批省一次 prefill，而且它们本来就该一起权衡。
 */
export const DECK_COMPOSITION_QUESTION = 'deck_composition';

export function deckCompositionCriteria(): Record<string, string> {
  return {
    parallel: '统一平静：每页用同一种排法，读起来稳定，像一份正式报告',
    ranked: '有节奏起伏：偶数页换成排行 / 编号 / 主从，翻页时轻重交替',
  };
}

/** 弃权时用 `ranked`：有起伏的版本信息量更大，也更不像模板。 */
export const DEFAULT_DECK_COMPOSITION: 'parallel' | 'ranked' = 'ranked';

/** 默认主题：决策层弃权时用它，确定且可复现。 */
export const DEFAULT_DECK_THEME_ID = 'midnight';

/**
 * 按 id 取主题。未知 id 回落到默认值并**不抛错**。
 *
 * 为什么容错：主题是纯视觉参数，id 不认识时最坏结果是"长得不像预期"，
 * 而不该让整份文稿渲染不出来。真正需要报错的是版式（结构会不对），不是主题。
 */
export function resolveDeckTheme(themeId: string | undefined): DeckTheme {
  const hit = DECK_THEMES.find((theme) => theme.id === themeId);
  return hit ?? DECK_THEMES.find((t) => t.id === DEFAULT_DECK_THEME_ID)!;
}

/**
 * 把主题编成 CSS 变量声明。
 *
 * `--sk-*` 前缀是刻意的：与版式类名（`.sk-cover`）同一套命名空间，
 * 以后加主题只要往这里加变量，版式里用 `var(--sk-accent, #3b6df5)` 即可。
 */
export function deckThemeCssVars(theme: DeckTheme): string {
  const v = theme.vars;
  return [
    `--sk-bg:${v.bg}`,
    `--sk-fg:${v.fg}`,
    `--sk-accent:${v.accent}`,
    `--sk-muted:${v.muted}`,
    `--sk-surface:${v.surface}`,
    `--sk-display:${v.display}`,
    `--sk-display-weight:${v.displayWeight}`,
    `--sk-display-tracking:${v.displayTracking}`,
    `--sk-pad-x:${v.padX}cqw`,
    `--sk-pad-y:${v.padY}cqw`,
    `--sk-radius:${v.radius}cqw`,
  ].join(';');
}

/** 给决策模型看的候选表：`choice` 的 criteria。 */
export function deckThemeCriteria(): Record<string, string> {
  return Object.fromEntries(DECK_THEMES.map((theme) => [theme.id, `${theme.label}：${theme.description}`]));
}
