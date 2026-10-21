/**
 * 演示文稿版式池：**每页选一个版式**，与网页链路的 block 池同构、不同池。
 *
 * ## 为什么复用 `BlockSpec` 而不是另建一套类型
 *
 * 一页幻灯片和网页上的一个 block 在结构上是同一件事：**一个有具名 slot 的
 * 版式单元**。复用同一个 spec 类型，就能直接复用已有的三样东西：
 *   - `StructurePlanner` 的逐轮 `choice` 决策（"下一页用哪个版式"）
 *   - `fillBlock` 的 slot 填充（含"要几项"的 numeric 问句与生成式/确定性分流）
 *   - `PageSpec` / `BlockInstance` 的结构留痕与前端展示
 *
 * 所以演示文稿不是"网页改个名"：**版式池、产物形态、渲染器**都是另一套，
 * 但决策与填充这两层是同一套机器。这也是加模态时该走的路——
 * 新模态等于新池子 + 新渲染器，而不是新链路。
 *
 * ## 分组是分界线
 *
 * 这些版式全部声明 `group: 'deck'`。网页链路的候选集按分组取，
 * 永远不会出现"章节页"这种幻灯片版式；反过来演示文稿链路只用这个池子。
 */

import { BlockRegistry, type BlockSpec } from './block-spec.js';

/**
 * 内置版式。
 *
 * 设计上刻意**不做**"自由画布"：版式是固定的，模型选的是版式和文案。
 * 理由与网页链路一致——自由排版等于让生成层决定结构（设计稿 §2.1 的红线）。
 * 一页的视觉质量由版式本身保证，不靠模型每次重新发明。
 */
export const BUILTIN_SLIDE_LAYOUTS: readonly BlockSpec[] = [
  {
    id: 'cover',
    label: '封面页',
    description: '整份演示文稿的第一页：一个主标题、一句副标题，可选一个眉标。',
    group: 'deck',
    slots: [
      { name: 'eyebrow', type: 'text', required: false, description: '眉标：公司名、场合或日期' },
      { name: 'title', type: 'title', required: true, description: '主标题' },
      { name: 'subtitle', type: 'text', required: false, description: '副标题：一句话说明这份文稿讲什么' },
    ],
    canLead: true,
    repeatable: false,
    placement: 'first',
    costHint: 'fast',
  },
  {
    id: 'agenda',
    label: '目录页',
    description: '列出接下来要讲的几个部分，一页最多六条。',
    group: 'deck',
    slots: [
      { name: 'title', type: 'title', required: true, description: '标题，通常是"这次讲什么"' },
      { name: 'items', type: 'list-text', required: true, description: '各部分名称', countRange: { min: 3, max: 6 } },
    ],
    canLead: true,
    repeatable: false,
    costHint: 'fast',
  },
  {
    id: 'section',
    label: '章节分隔页',
    description: '把内容切成几段的过渡页：一个编号、一个章节名，可选一句提示。',
    group: 'deck',
    slots: [
      { name: 'number', type: 'title', required: false, description: '章节编号，如"01"' },
      { name: 'heading', type: 'title', required: true, description: '章节名' },
      { name: 'note', type: 'text', required: false, description: '一句话提示这一节要解决什么' },
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'bullets',
    label: '要点页',
    description: '最常用的一页：一个标题、一句导语、三到六条要点。',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      { name: 'lede', type: 'text', required: false, description: '导语：一句话点出这页的结论' },
      { name: 'items', type: 'list-text', required: true, description: '要点条目', countRange: { min: 3, max: 6 } },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'two-col',
    label: '两栏对比页',
    description: '左右两栏并列：适合"现状 vs 目标""方案 A vs 方案 B"这类对照。',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      { name: 'leftTitle', type: 'title', required: true, description: '左栏小标题' },
      { name: 'leftItems', type: 'list-text', required: true, description: '左栏条目', countRange: { min: 2, max: 5 } },
      { name: 'rightTitle', type: 'title', required: true, description: '右栏小标题' },
      { name: 'rightItems', type: 'list-text', required: true, description: '右栏条目', countRange: { min: 2, max: 5 } },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'quote-slide',
    label: '引用页',
    description: '整页只放一句引文，可选出处。适合用来强调一个判断。',
    group: 'deck',
    slots: [
      { name: 'quote', type: 'text', required: true, description: '引文正文，一到两句' },
      { name: 'source', type: 'text', required: false, description: '出处：人名、报告名或数据来源' },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'image-slide',
    label: '图文页',
    description: '一个大标题配一张主视觉，可选一行图注。',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      { name: 'image', type: 'image', required: false, description: '主视觉' },
      { name: 'caption', type: 'text', required: false, description: '图注：这张图说明什么' },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'medium',
  },
  {
    id: 'closing',
    label: '结尾页',
    description: '整份文稿的最后一页：一句收口的话，可选联系方式。',
    group: 'deck',
    slots: [
      { name: 'headline', type: 'title', required: true, description: '收口的一句话' },
      { name: 'note', type: 'text', required: false, description: '补充一句：下一步或行动号召' },
      { name: 'contact', type: 'text', required: false, description: '联系方式或链接' },
    ],
    canLead: false,
    repeatable: false,
    placement: 'last',
    costHint: 'fast',
  },
  /*
   * ── 下面四个是"结构上就不一样"的版式 ────────────────────────────────
   *
   * 上面八个都是"标题 + 正文块"的变体：字大一点小一点、分栏一分二，
   * 看多了就是同一份模板。真正让人觉得"这份演示文稿是设计过的"，
   * 靠的是**信息形态不同**：数字要大、时间要横着走、主张要敢占满一页。
   */
  {
    id: 'stats',
    label: '数据页',
    description:
      '一排大数字，每个数字配一句说明。适合复盘、增长、经营分析——数字本身就该是版面主角。条目写法：数字在前、说明在后，用竖线分隔，例如「25%|协作工具使用率提升」',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      {
        name: 'metrics',
        type: 'list-text',
        required: true,
        description: '指标条目：数字|说明（例如 25%|协作工具使用率提升）',
        countRange: { min: 2, max: 4 },
      },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'timeline',
    label: '时间线页',
    description:
      '横向的几段推进：一条线串起三到五个节点，适合路线图、实施计划、复盘节奏。条目写法：时间在前、事件在后，用竖线分隔，例如「Q1|完成需求梳理」',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      {
        name: 'phases',
        type: 'list-text',
        required: true,
        description: '节点条目：时间|事件（例如 Q1|完成需求梳理）',
        countRange: { min: 3, max: 5 },
      },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'manifesto',
    label: '主张页',
    description:
      '整页只放两三句主张，字极大、逐行递进。适合开场立论或中场转折——一页只讲一件事时用它，别用来塞信息',
    group: 'deck',
    slots: [
      {
        name: 'lines',
        type: 'list-text',
        required: true,
        description: '主张，一句一行，每行尽量不超过 14 字',
        countRange: { min: 2, max: 3 },
      },
      { name: 'note', type: 'text', required: false, description: '底下一行小字：出处或补充' },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'image-text',
    label: '图文左右页',
    description: '左半页一张主视觉、右半页讲三到五条。与「图文页」的区别是图占半页、文字在侧，信息更密',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      { name: 'image', type: 'image', required: false, description: '左半页的主视觉' },
      {
        name: 'items',
        type: 'list-text',
        required: true,
        description: '右侧条目',
        countRange: { min: 3, max: 5 },
      },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'medium',
  },
  {
    id: 'chart',
    label: '图表页',
    description:
      '把数据画成柱状图：内联 SVG、自包含、不引用外部资源。适合「几个季度对比」「几项指标差距」这类要**看出趋势**的内容。条目写法：标签|数值，例如「Q1|32」「Q2|45」，数值可带 % 或单位',
    group: 'deck',
    slots: [
      { name: 'heading', type: 'title', required: true, description: '这一页的标题' },
      {
        name: 'bars',
        type: 'list-text',
        required: true,
        description: '数据条目：标签|数值（例如 Q1|32）',
        countRange: { min: 3, max: 6 },
      },
      { name: 'note', type: 'text', required: false, description: '图下一行小字：口径或来源' },
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
];

/**
 * 版式池。
 *
 * 与 `createBlockRegistry()` 分开：同一个 `BlockRegistry` 类，两份内容。
 * 池子分开是硬要求——合成一个池子，网页链路就能选到"章节分隔页"。
 */
export function createSlideRegistry(): BlockRegistry {
  return new BlockRegistry().registerAll(BUILTIN_SLIDE_LAYOUTS);
}

/** 内置版式的 id 列表，便于测试与文档。 */
export function builtinSlideLayoutIds(): string[] {
  return BUILTIN_SLIDE_LAYOUTS.map((spec) => spec.id);
}
