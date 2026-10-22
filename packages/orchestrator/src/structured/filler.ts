/**
 * 确定性 slot 填充器：**不调用任何生成模型**，把已定稿的结构填成完整内容。
 *
 * ## 为什么先做确定性
 *
 * 结构化链路的价值在"结构是数据、逐块可干预"，与"文案写得多好"是两件事。
 * 先做确定性填充，可以在**零成本、零外部依赖**的前提下把整条链路跑通、跑满测试；
 * 生成层接上来之后，只替换单个 slot 的实现，链路本身不动。
 *
 * 这同时是**降级路径**：生成层不可用时，页面仍然出得来。
 *
 * ## 图片怎么办
 *
 * 生成式图片要调付费端点，而 P2 要求零成本。这里的做法是把 `image` slot 填成
 * **内联 SVG 的 data URI** —— 它是真正能渲染的图片（不是 `src=""` 那种占位），
 * 不需要网络、不需要磁盘、不会让预览开天窗。
 *
 * 这条尤其重要：它解决了"图嵌不进页面"。此前 `scaffold-frontend` 的入参只有
 * `goal` 与 `copy` 两个**文本**参数，根本没有接受图像的通道，所以图永远进不了页面。
 * 现在 `image` 是有名字有类型的 slot，谁来填是**逐 slot 决定**的。
 */
import { getPreset } from '@mediasandbox/sandbox';
import type { BlockRegistry, BlockSpec, SlotSpec } from './block-spec.js';
import {
  type BlockInstance,
  type ImageRef,
  type PageSpec,
  type SlotFillPlan,
  type SlotSource,
  type SlotValue,
} from './page-spec.js';

export interface FillOptions {
  /** 品牌名/站点名。缺省从目标里截取。 */
  readonly brand?: string | undefined;
  /** 确定性占位图的配色（前景、背景）。用于让同一页面上多张图不至全一样。 */
  readonly palette?: readonly (readonly [string, string])[] | undefined;
  /**
   * 生成式实现：给某个 slot 产出内容。**不传就是纯确定性**。
   *
   * 签名刻意做成"一次一个 slot"而不是"一次一个 block"：素材填充的粒度是 slot，
   * 这样"这块的标题用确定性的、主视觉用生成式的"才表达得出来。
   */
  readonly generate?:
    | ((request: GenerateSlotRequest) => Promise<GenerateSlotResult | null>)
    | undefined;
  /**
   * **一次执笔**的整页文案：slot 名 → 原始文本 / 字符串数组。
   *
   * 与 `generate` 的区别是粒度：`generate` 一次写一个 slot（模型看不到邻居），
   * `written` 是模型已经把这一页甚至整份文稿一口气写完的结果。填充器优先用
   * `written`，只有它没覆盖到的 slot 才回落到 `generate` / 确定性内容。
   *
   * 形态由填充器按版式声明校验：列表条数不够、类型对不上的值会被**拒绝**并
   * 回落，而不是硬塞进去——那样版式会在渲染前就崩掉。
   */
  readonly written?: Readonly<Record<string, unknown>> | undefined;
  /** 单个 slot 生成失败时是否让整块失败。默认 false——回落到确定性内容。 */
  readonly failOnGenerateError?: boolean | undefined;
}

export interface GenerateSlotRequest {
  readonly goal: string;
  readonly blockType: string;
  readonly blockId: string;
  readonly slot: SlotSpec;
  /** 该 slot 需要几项（列表型）。 */
  readonly count: number;
  /** 同块内已有的确定性内容，可作上下文。 */
  readonly context: Readonly<Record<string, string>>;
  /** 决策层给这个 slot 选的实现方式（图片的有图/搜图/占位三种）。 */
  readonly source?: SlotFillPlan | undefined;
}

export interface GenerateSlotResult {
  /** 文本类内容。列表型用 `items`。 */
  readonly text?: string | undefined;
  readonly items?: readonly string[] | undefined;
  /** 图片字节。给了就写成 data URI。 */
  readonly imageBytes?: Uint8Array | undefined;
  readonly imageMime?: string | undefined;
  /**
   * 图集（`list-image`）：一次给出多张。
   *
   * 与 `imageBytes` 并存而不是替换它：单图槽仍用后者，图集用这个。
   * 张数由调用方按 slot 的 `countRange` 与决策层给的项数控制。
   */
  readonly images?: readonly { readonly bytes: Uint8Array; readonly mime: string }[] | undefined;
}

/** 填充结果：填好的 block + 每个 slot 的来源。 */
export interface FilledBlock {
  readonly block: BlockInstance;
  readonly sources: Readonly<Record<string, SlotSource>>;
  /** 生成层调用次数。零成本验收就靠它。 */
  readonly generativeCalls: number;
  /** 来自"一次执笔"的 slot 名（用于区分整页写好的与逐 slot 生成的）。 */
  readonly writtenSlots: readonly string[];
  /** 生成层失败并被回落的原因，逐条记录。 */
  readonly warnings: readonly string[];
}

/** 顶部展示的上限。标题太长会撑破版式，也会把决策层的 state 撑大。 */
const TITLE_MAX = 28;

/** 从目标里截一段能当标题的短语。纯字符串处理，不做分词——确定性优先。 */
export function shorten(text: string, max = TITLE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * 从目标里派生一个品牌名 / 站点名。
 *
 * 两步：先剥掉动词性前缀（"帮我做一个…"），再**在小句边界处断开**。
 *
 * 为什么不能直接 `shorten`：直接按字数截会切在词中间——实测一个目标是
 * 「做一个产品介绍落地页，含首屏、特性与行动号召」，剥掉前缀后按 16 字截
 * 得到「含首屏、特」，页面上就顶着一句读不通的残句。按标点断开则得到
 * 「产品介绍落地页」，是一段完整的短语。
 *
 * 找不到标点时才退回按字数截（并带省略号，表明它是截断的）。
 */
export function deriveBrand(goal: string): string {
  const stripped = goal
    .replace(/^(请|帮我|帮忙|麻烦|给我)?\s*(做|制作|生成|创建|搭建|设计|写)?\s*(一个|一份|个|份)?\s*/u, '')
    .replace(/[。.!！?？]$/u, '')
    .trim();
  const base = stripped === '' ? goal.trim() : stripped;

  // 在第一个小句边界断开。逗号/顿号/分号/冒号都算——
  // 它们在中文里都标志着一个可以独立成句的片段结束。
  const boundary = /[，,、；;：:（(]/u.exec(base);
  if (boundary !== null && boundary.index >= 2) {
    const head = base.slice(0, boundary.index).trim();
    if (head !== '') return shorten(head, 16);
  }
  return shorten(base, 16);
}

/**
 * 把多行文本拆成非空行。
 *
 * 导出是因为调用方（工具层、测试）需要与填充器**用同一套**分行规则：
 * 各处各写一份，会在"空行算不算一项"这种细节上悄悄分叉。
 */
export function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 缺省配色。刻意选低饱和的中性色——占位图不该抢内容的注意力，
 * 也不该让人误以为这是最终视觉。
 */
const DEFAULT_PALETTE: readonly (readonly [string, string])[] = [
  ['#f4f6f8', '#5b6b7c'],
  ['#f5f3ff', '#6d5bd0'],
  ['#f0f9f4', '#2f7d5b'],
  ['#fdf6ec', '#9a6b2f'],
  ['#f2f6fb', '#3d6a99'],
];

/**
 * 造一张内联 SVG 占位图。
 *
 * 用 SVG 而不是位图：**体积小、可直接内联进 HTML、不需要任何依赖**。
 * 用 data URI 而不是外部文件：预览时不会因为相对路径不对而开天窗。
 *
 * 文本一律转义后再嵌入——slot 内容来自用户目标，不转义就是注入点。
 */
export function placeholderImageDataUri(label: string, index = 0, palette?: readonly (readonly [string, string])[]): string {
  const colors = palette ?? DEFAULT_PALETTE;
  const [bg, fg] = colors[index % colors.length]!;
  const text = escapeXml(shorten(label, 20));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480" role="img">` +
    `<rect width="800" height="480" fill="${bg}"/>` +
    `<rect x="24" y="24" width="752" height="432" fill="none" stroke="${fg}" stroke-opacity="0.25" stroke-width="2" stroke-dasharray="10 8"/>` +
    `<text x="400" y="248" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" ` +
    `font-size="30" fill="${fg}">${text}</text>` +
    `</svg>`;
  // 用 encodeURIComponent 而不是 base64：可读、体积更小、且不需要 Buffer（保持纯函数）。
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 确定性内容生成。
 *
 * 每条都是**目标 + slot 名**的函数，因此同样的输入永远得到同样的输出
 * （这正是"可复现"与"零成本测试"的前提）。
 *
 * 注意：`literal` 型要**按名字**分派，不能只看类型。`literal` 的语义是
 * "由确定性代码给的常量"，而常量是什么完全取决于这个 slot 是什么——
 * 页脚的 `copyright` 与代码块的 `language` 都是 `literal`，
 * 只看类型会把 `language` 填成"© xxx 版权所有"，而且页面照样渲染得出来，
 * 只是内容荒谬，很难在结果里发现。
 */
function deterministicText(
  slotName: string,
  slotType: SlotSpec['type'],
  args: { readonly goal: string; readonly brand: string; readonly blockType: string; readonly index: number },
): string {
  const { goal, brand, index } = args;
  const subject = shorten(goal, 40);
  switch (slotType) {
    case 'title':
      return index === 0 ? shorten(brand) : `${shorten(brand)}｜${slotLabel(slotName)}`;
    case 'link':
      return '#';
    case 'code':
      return [
        `// ${subject}`,
        'export function create() {',
        `  const site = ${JSON.stringify(brand)};`,
        '  return { site, ready: true };',
        '}',
      ].join('\n');
    case 'literal':
      // 常量按 slot 名分派，见上面的说明。
      if (slotName === 'language') return 'ts';
      return `© ${brand} 版权所有`;
    default:
      return `${subject}。${slotLabel(slotName)}：这里展示与目标直接相关的说明，` +
        `内容由确定性填充器生成，不调用生成模型。`;
  }
}

/** slot 名的中文说法，用于拼出可读的占位文案。 */
function slotLabel(slotName: string): string {
  const table: Readonly<Record<string, string>> = {
    title: '标题',
    subtitle: '副标题',
    heading: '小节标题',
    body: '正文',
    text: '内容',
    caption: '图注',
    attribution: '出处',
    actionText: '行动按钮',
    actionHref: '按钮链接',
    buttonText: '按钮文字',
    href: '链接',
    brand: '站点名',
    copyright: '版权',
    language: '语言',
    src: '地址',
    prompt: '图',
    poster: '封面',
    media: '主视觉',
    items: '条目',
    links: '链接',
    images: '图片',
    rows: '行',
    tabs: '标签',
    panels: '面板',
    fields: '字段',
    submitText: '提交按钮',
    source: '源码',
  };
  return table[slotName] ?? slotName;
}

/**
 * 造 N 条确定性的列表项说明。
 *
 * **按 slot 名分派**，不能一条模板走天下：
 * 同一个"列表"在不同 block 里的**形态要求完全不同**。
 * `features.items` 是卡片正文，长句合适；`nav.links` 是导航项，必须短；
 * `footer.links` 同理。用同一套长句填导航，页面上就是一条占三行的链接
 * ——截图里一眼能看出来，但产物清单、状态、来源三处都看不出来。
 */
function deterministicItems(
  slot: SlotSpec,
  args: { readonly goal: string; readonly brand: string; readonly count: number },
): string[] {
  const { goal, brand, count } = args;
  const subject = shorten(goal, 24);

  // 导航 / 页脚：**短标签**。三五个字，像真的导航。
  if (slot.name === 'links') {
    const labelSets: Readonly<Record<string, readonly string[]>> = {
      默认: ['概览', '特性', '用法', '文档', '支持'],
    };
    const labels = labelSets['默认']!;
    return Array.from({ length: count }, (_, i) => labels[i % labels.length]!);
  }

  const templates: readonly ((i: number) => string)[] = [
    (i) => `${slotLabel(slot.name)} ${i}：与「${subject}」直接相关的一项`,
    (i) => `要点 ${i}：说明它能解决什么问题`,
    (i) => `要点 ${i}：给出一个具体可验证的细节`,
    (i) => `${brand} 的第 ${i} 项说明`,
    (i) => `要点 ${i}：补充适用场景与边界`,
    (i) => `要点 ${i}：注明与其他项的差别`,
    (i) => `要点 ${i}：给出下一步动作`,
    (i) => `要点 ${i}：附一个数据或例子`,
  ];
  return Array.from({ length: count }, (_, i) => templates[i % templates.length]!(i + 1));
}

/** 表格行需要竖线分隔，填成确定性的两列。 */
function deterministicRows(count: number, goal: string): string[] {
  const subject = shorten(goal, 18);
  return Array.from({ length: count }, (_, i) => `指标 ${i + 1} | ${subject} 的第 ${i + 1} 项取值`);
}

/** 折叠面板需要"问 | 答"，填成确定性的问答。 */
function deterministicQa(count: number, goal: string): string[] {
  const subject = shorten(goal, 18);
  const questions: readonly string[] = [
    '这是什么',
    '适合谁用',
    '怎么开始',
    '有什么限制',
    '如何获取支持',
    '是否收费',
    '数据放在哪',
    '能导出吗',
  ];
  return Array.from({ length: count }, (_, i) => {
    const q = questions[i % questions.length]!;
    return `${q}？ | 关于「${subject}」，这一项由确定性填充器给出的占位说明。`;
  });
}

/** 标签页需要标签名与面板正文一一对应。 */
function deterministicTabs(count: number, goal: string): { tabs: string[]; panels: string[] } {
  const subject = shorten(goal, 18);
  const names: readonly string[] = ['概览', '特性', '用法', '参数', '常见问题'];
  const tabs = Array.from({ length: count }, (_, i) => names[i % names.length]!);
  const panels = tabs.map(
    (name) => `${name}：关于「${subject}」的${name}说明，由确定性填充器生成。`,
  );
  return { tabs, panels };
}

/** 表单字段名。 */
function deterministicFields(count: number): string[] {
  const names: readonly string[] = ['姓名', '联系方式', '需求描述', '期望时间', '其他'];
  return Array.from({ length: count }, (_, i) => names[i % names.length]!);
}

/**
 * 填一个 block 的全部 slot。
 *
 * 顺序：先确定性填满，再对配了 `generate` 的 slot 尝试生成式覆盖。
 * 这个顺序保证**生成层失败时页面依然完整**——而不是缺一半。
 */
export async function fillBlock(args: {
  readonly spec: BlockSpec;
  readonly block: BlockInstance;
  readonly goal: string;
  readonly brand: string;
  readonly options: FillOptions;
  /** 该 block 在页面上的序号，用于让占位图配色有变化但可复现。 */
  readonly index: number;
  /** 已有的确定性 slot 值（含 planner 问出来的数量）。 */
  readonly counts: Readonly<Record<string, number>>;
}): Promise<FilledBlock> {
  const { spec, block, goal, brand, options, index, counts } = args;
  const slots: Record<string, SlotValue> = {};
  const sources: Record<string, SlotSource> = {};
  const warnings: string[] = [];
  let generativeCalls = 0;
  const writtenApplied = new Set<string>();

  // ── 第一遍：确定性填满 ────────────────────────────────────────────────
  for (const slot of spec.slots) {
    const filled = deterministicSlot(slot, { goal, brand, blockType: spec.id, index, counts });
    // 已给的量优先取"用户/planner 提供的那个数"，但**内容一律由这里生成**。
    //
    // 这里曾经是 `slots[name] = value`，把 `block.slots` 里的值**整体覆盖**上来。
    // 后果很隐蔽：planner 为问数量而放的占位是"长度对、内容全空"的数组
    // （`{ kind:'list', items:['','',''] }`），于是列表型 slot 最终落盘成
    // **一串空字符串**，`status` 却写着 `filled`、来源还标成 `user`。
    // 页面照样渲染得出来，只是图集是五个破图占位、条目全是空白——
    // 而产物清单、状态、来源三处都看不出问题。
    //
    // 正确做法是**只取形状（长度），不取内容**：占位数组告诉我们要几项，
    // 内容则由确定性填充器按这个项数现生成。
    const preserved = block.slots[slot.name];
    if (preserved !== undefined) {
      const shape = listLengthOf(preserved);
      if (shape > 0) {
        // 列表型要分两种情形，此前被混成了一种：
        //
        //   1. **真的带了内容**（模板预置 / 用户手填 / 上游产出）→ 整值保留
        //   2. **空占位**（planner 为问数量而放的形状）→ 只取长度，内容现生成
        //
        // 早先两种都走"内容一律重新生成"，于是模板与用户给的列表内容被**静默丢掉**，
        // 而 `sources` 还标着 `user` —— 状态说"这是你给的"，内容却是系统编的。
        // 空占位那一支不能省（那条回归就是这么来的），真实内容这一支也不能丢。
        const wanted = counts[slot.name] ?? shape;
        if (hasListContent(preserved)) {
          slots[slot.name] = resizePreserved(preserved, filled, wanted);
          sources[slot.name] = 'user';
          continue;
        }
        slots[slot.name] = resizeSlot(filled, wanted);
        sources[slot.name] = 'deterministic';
        continue;
      }
      // 非列表型：整值优先，这是"用户/上游真的给了内容"的情形。
      slots[slot.name] = preserved;
      sources[slot.name] = 'user';
      continue;
    }
    slots[slot.name] = filled;
    sources[slot.name] = 'deterministic';
  }

  // ── 第二遍：一次执笔的整页文案 ────────────────────────────────────────
  //
  // 这是"大模型是主要执笔"的落点：模型已经按整份文稿的上下文一口气写完，
  // 这里只负责把字放进对应 slot。**不逐 slot 再问一遍**——再问就是把
  // 刚写好的连贯文案重新切碎（`generate` 仍保留给没写到的 slot 兜底）。
  //
  // 三条不覆盖：
  //   1. 决策层明确指定"确定性"的 slot（那一问仍然有效）
  //   2. 上游/用户已经给了真实内容（模板、手改）——整页执笔不该把人的修改冲掉
  //   3. 形态与版式声明不符的值——宁可回落到确定性，也不要产出一份非法页面
  if (options.written !== undefined) {
    for (const slot of spec.slots) {
      const raw = options.written[slot.name];
      if (raw === undefined) continue;
      if (block.slotPlans?.[slot.name] === 'deterministic') continue;
      if (sources[slot.name] === 'user') continue;
      const applied = writtenSlotValue(slot, raw);
      if (applied === null) {
        warnings.push(
          `执笔文案的 slot ${slot.name} 与版式「${spec.label}」的声明不符，已回落到确定性/逐 slot 生成`,
        );
        continue;
      }
      slots[slot.name] = applied;
      sources[slot.name] = 'generative';
      writtenApplied.add(slot.name);
    }
  }

  // ── 第三遍：生成式覆盖 ────────────────────────────────────────────────
  if (options.generate !== undefined) {
    const context: Record<string, string> = { goal, brand };
    for (const slot of spec.slots) {
      // 决策层对"这个 slot 由谁实现"做过选择时，**以它为准**：
      // 只有它明确说 `generative` 才调生成层。
      //
      // 这就是 `slot_source` 那一问存在的意义——"由谁实现"从"按 slot 类型硬编码"
      // 变成一次真正的决策。没问过时（零成本默认路径）保持原行为：text/title/code
      // 归生成层，link/literal 由下面的生成器自己拒掉。
      const plan = block.slotPlans?.[slot.name];
      if (block.slotPlans !== undefined && plan !== 'generative' && plan !== 'web') continue;
      // 执笔已经写好的 slot 不再逐 slot 调用：再写一遍等于把连贯的文案重新切碎。
      if (writtenApplied.has(slot.name)) continue;

      const count = counts[slot.name] ?? countOf(slots[slot.name]);
      let result: GenerateSlotResult | null = null;
      try {
        generativeCalls += 1;
        result = await options.generate({
          goal,
          blockType: spec.id,
          blockId: block.id,
          slot,
          count,
          context,
          ...(plan === undefined ? {} : { source: plan }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push(`slot ${slot.name} 生成失败，已回落到确定性内容：${detail}`);
        if (options.failOnGenerateError === true) throw error;
        continue;
      }
      if (result === null) continue;
      const applied = applyGenerated(slot, result, slots[slot.name]);
      if (applied === null) {
        warnings.push(`slot ${slot.name} 的生成结果形态与声明不符，已忽略`);
        continue;
      }
      slots[slot.name] = applied;
      sources[slot.name] = 'generative';
      // 生成出来的内容进 context，后续 slot 可以据此保持一致。
      context[slot.name] = typeof applied === 'object' && 'text' in applied ? applied.text : '';
    }
  }

  return {
    block: { ...block, slots, status: 'filled', sources, error: undefined },
    sources,
    generativeCalls,
    writtenSlots: [...writtenApplied],
    warnings,
  };
}

/**
 * 把执笔文案套到声明类型上。形态不符返回 null（调用方回落到确定性/逐 slot）。
 *
 * 与 `applyGenerated` 的区别：这里不做"信任模型"的宽松转换，列表条数必须
 * 落在 `countRange` 内（多了截断、少了拒绝），文本按 slot 类型截断。
 * 拒绝而不是硬塞，是因为非法取值会让 `validatePageSpec` 在渲染前抛错，
 * 整份文稿都出不来；回落到确定性内容至少页面是完整的。
 */
function writtenSlotValue(slot: SlotSpec, raw: unknown): SlotValue | null {
  if (slot.type === 'image' || slot.type === 'list-image') return null;
  if (slot.type === 'link' || slot.type === 'literal') return null;
  if (slot.type === 'list-text') {
    const items = writtenList(raw);
    if (items === undefined) return null;
    const range = slot.countRange;
    if (range !== undefined && items.length < range.min) return null;
    const kept = range !== undefined ? items.slice(0, range.max) : items;
    // 单条过长同样会把版式撑坏；与逐 slot 生成的上限保持一致。
    return { kind: 'list', items: kept.map((item) => (item.length > 200 ? item.slice(0, 200) : item)) };
  }
  const text = writtenText(raw);
  if (text === undefined) return null;
  const limit = slot.type === 'title' ? 40 : slot.type === 'code' ? 2000 : 300;
  return { kind: 'text', text: text.slice(0, limit) };
}

function writtenText(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? undefined : text;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function writtenList(raw: unknown): string[] | undefined {
  let items: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const text = writtenText(item);
      if (text !== undefined) items.push(text);
    }
  } else {
    const text = writtenText(raw);
    if (text === undefined) return undefined;
    items = text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter((line) => line !== '');
  }
  return items.length > 0 ? items : undefined;
}

/** 取一个 slot 值的项数（非列表返回 1）。 */
function countOf(value: SlotValue | undefined): number {
  if (value === undefined) return 1;
  if (value.kind === 'list') return value.items.length;
  if (value.kind === 'list-image') return value.refs.length;
  return 1;
}

/**
 * 列表型 slot 的项数；非列表返回 0。
 *
 * 用来区分"**形状占位**"与"真的内容"：planner 为问数量而放的占位是
 * 长度正确、内容全空的数组，它只该贡献长度，不该贡献内容。
 */
function listLengthOf(value: SlotValue): number {
  if (value.kind === 'list') return value.items.length;
  if (value.kind === 'list-image') return value.refs.length;
  return 0;
}

/**
 * 判断一个**列表型**取值是否真的带了内容。
 *
 * 全部为空串（或图的 ref/alt 都为空）就是纯占位——planner 为问数量放的壳子，
 * 它只该贡献项数，不该被当成"用户提供的内容"。
 *
 * 只对列表型调用：非列表型的值只要存在就是内容，不走这里。
 */
function hasListContent(value: SlotValue): boolean {
  if (value.kind === 'list') return value.items.some((item) => item.trim() !== '');
  if (value.kind === 'list-image') {
    return value.refs.some((ref) => ref.ref.trim() !== '' || ref.alt.trim() !== '');
  }
  return true;
}

/**
 * 把确定性生成的值调整到指定项数。
 *
 * 数量是**决策层问出来的**（`numeric` 或其降级形态），必须以它为准；
 * 确定性生成器只是"按这个项数把内容造出来"。
 */
function resizeSlot(value: SlotValue, length: number): SlotValue {
  if (length <= 0) return value;
  if (value.kind === 'list') {
    const items = value.items;
    if (items.length === length) return value;
    const out = Array.from({ length }, (_, i) => items[i % Math.max(1, items.length)] ?? '');
    return { kind: 'list', items: out };
  }
  if (value.kind === 'list-image') {
    const refs = value.refs;
    if (refs.length === length) return value;
    const out = Array.from({ length }, (_, i) => refs[i % Math.max(1, refs.length)] ?? { ref: '', alt: '' });
    return { kind: 'list-image', refs: out };
  }
  return value;
}

/**
 * 把**已有的真实内容**调整到指定项数：多了截断，少了用确定性内容补齐。
 *
 * 刻意不复用 `resizeSlot` 的循环取模：那会把模板/用户给的第 1 条复制成第 4 条，
 * 页面上看起来就是"同一条说了两遍"。补齐宁可换成朴素内容，也不要重复。
 */
function resizePreserved(preserved: SlotValue, fallback: SlotValue, length: number): SlotValue {
  if (length <= 0) return preserved;
  if (preserved.kind === 'list' && fallback.kind === 'list') {
    const items = Array.from(
      { length },
      (_, i) => preserved.items[i] ?? fallback.items[i % Math.max(1, fallback.items.length)] ?? '',
    );
    return { kind: 'list', items };
  }
  if (preserved.kind === 'list-image' && fallback.kind === 'list-image') {
    const refs = Array.from(
      { length },
      (_, i) =>
        preserved.refs[i] ??
        fallback.refs[i % Math.max(1, fallback.refs.length)] ??
        { ref: '', alt: '' },
    );
    return { kind: 'list-image', refs };
  }
  return preserved;
}

/** 确定性地产出一个 slot 的值。 */
function deterministicSlot(
  slot: SlotSpec,
  args: {
    readonly goal: string;
    readonly brand: string;
    readonly blockType: string;
    readonly index: number;
    readonly counts: Readonly<Record<string, number>>;
  },
): SlotValue {
  const { goal, brand, blockType, index, counts } = args;
  const text = (name: string, type: SlotSpec['type']): string =>
    deterministicText(name, type, { goal, brand, blockType, index });

  const requested = counts[slot.name] ?? slot.countRange?.min ?? 1;
  const count = slot.countRange === undefined
    ? requested
    : Math.min(slot.countRange.max, Math.max(slot.countRange.min, Math.round(requested)));

  switch (slot.type) {
    case 'image': {
      const label = `${brand} · ${slotLabel(slot.name)}`;
      return { kind: 'image', ref: placeholderImageDataUri(label, index), alt: label };
    }
    case 'list-image':
      return {
        kind: 'list-image',
        refs: Array.from({ length: count }, (_, i) => {
          const label = `${brand} · ${slotLabel(slot.name)} ${i + 1}`;
          return { ref: placeholderImageDataUri(label, index + i), alt: label };
        }),
      };
    case 'list-text': {
      // 表格、问答、标签页、表单这几种有结构约束，单独走专用生成；
      // 其余是普通条目列表。
      let items: string[];
      if (slot.name === 'rows') items = deterministicRows(count, goal);
      else if (slot.name === 'items' && blockType === 'accordion') items = deterministicQa(count, goal);
      else if (slot.name === 'fields') items = deterministicFields(count);
      else if (slot.name === 'tabs' || slot.name === 'panels') {
        // 标签名与面板正文必须一一对应，所以两种 slot 取同一次配对结果。
        const pair = deterministicTabs(count, goal);
        items = slot.name === 'tabs' ? pair.tabs : pair.panels;
      } else items = deterministicItems(slot, { goal, brand, count });
      return { kind: 'list', items };
    }
    default:
      return { kind: 'text', text: text(slot.name, slot.type) };
  }
}

/** 把生成结果套用到声明类型上。形态不符返回 null。 */
function applyGenerated(
  slot: SlotSpec,
  result: GenerateSlotResult,
  current: SlotValue | undefined,
): SlotValue | null {
  if (slot.type === 'list-text') {
    if (result.items === undefined) return null;
    const range = slot.countRange;
    if (range !== undefined) {
      const n = result.items.length;
      if (n < range.min || n > range.max) return null;
    }
    return { kind: 'list', items: [...result.items] };
  }
  if (slot.type === 'image') {
    if (result.imageBytes === undefined) return null;
    // 生成图的"文字说明"若没显式给就以空 alt 处理：把 slot 的声明描述
    // （"主视觉图"）当图注印出来，等于把内部词表泄漏到页面上。
    const alt = result.text ?? '';
    return { kind: 'image', ref: bytesToDataUri(result.imageBytes, result.imageMime), alt };
  }
  if (slot.type === 'list-image') {
    // 图集优先用一次给多张的 `images`；老的单张实现（`imageBytes`）仍兼容，
    // 但它只能替换第一张，其余保持原值。
    if (result.images !== undefined && result.images.length > 0) {
      const refs: ImageRef[] = result.images.map((image, index) => ({
        ref: bytesToDataUri(image.bytes, image.mime),
        alt: result.text === undefined || result.text === '' ? '' : `${result.text} ${index + 1}`,
      }));
      return { kind: 'list-image', refs };
    }
    if (result.imageBytes === undefined) return null;
    const existing = current?.kind === 'list-image' ? current.refs : [];
    const next = [...existing];
    if (next.length === 0) return null;
    next[0] = { ref: bytesToDataUri(result.imageBytes, result.imageMime), alt: result.text ?? '' };
    return { kind: 'list-image', refs: next };
  }
  if (result.text === undefined) return null;
  return { kind: 'text', text: result.text };
}

function bytesToDataUri(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * 填一个页面上的全部 block，返回新的 `PageSpec`。
 *
 * 逐块独立调用 `fillBlock`：**一个块失败不影响其它块**，
 * 失败的块被标成 `failed` 并留下原因，后续可以定点重做——
 * 这正是"每块有稳定 id 与 status"的用处。
 */
export async function fillPage(args: {
  readonly page: PageSpec;
  readonly blocks: BlockRegistry;
  readonly options?: FillOptions | undefined;
}): Promise<{ readonly page: PageSpec; readonly generativeCalls: number; readonly warnings: readonly string[] }> {
  const { page, blocks } = args;
  const options = args.options ?? {};
  const brand = options.brand ?? deriveBrand(page.goal);
  const out: BlockInstance[] = [];
  const warnings: string[] = [];
  let generativeCalls = 0;

  for (const [index, block] of page.blocks.entries()) {
    const counts: Record<string, number> = {};
    for (const [name, value] of Object.entries(block.slots)) counts[name] = countOf(value);
    try {
      // **`registry.get` 必须在这个 try 里。**
      // 放到外面，未注册的 block 会直接穿透 `fillPage` 抛给调用方，
      // 而页面上那块既不标 failed 也不带原因——排查时完全看不到真实情况。
      // 执行器里踩过同一个坑（见 plan/executor.ts 的注释），这里不重蹈。
      const spec = blocks.get(block.type);
      const filled = await fillBlock({ spec, block, goal: page.goal, brand, options, index, counts });
      out.push(filled.block);
      generativeCalls += filled.generativeCalls;
      warnings.push(...filled.warnings);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      out.push({ ...block, status: 'failed', error: detail });
      warnings.push(`block ${block.id}(${block.type}) 填充失败：${detail}`);
    }
  }

  return {
    page: { ...page, blocks: out },
    generativeCalls,
    warnings,
  };
}

/** 该环境是否支持结构化网页链路。 */
export function isWebpageEnv(envType: string): boolean {
  try {
    getPreset(envType as Parameters<typeof getPreset>[0]);
    return true;
  } catch {
    return false;
  }
}

/** 供测试断言用：确定性填充下生成层调用次数必须为 0。 */
export const ZERO_GENERATIVE_CALLS = 0;
