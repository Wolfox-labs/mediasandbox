/**
 * 元素池预览：把池子里的**一项**渲染成一段"能直接看效果"的自包含 HTML。
 *
 * ## 为什么这件事必须在服务端做
 *
 * 前端（元素池清单）手里只有 block 的**声明**——slot 名字与类型，没有渲染器。
 * 要让它看见效果，唯一的正路是让**同一套渲染器**把一项渲染出来。让前端自己拼
 * 一份"差不多"的版式，看到的就不是真产物：slot 怎么落位、图集怎么排、占位图
 * 长什么样，全都会不一样，于是"预览里好看、跑出来不是那样"变成常态。
 *
 * ## 成本红线
 *
 * 这三条预览**绝不触碰生成层**：`fillPage` 的 `options` 里只有 `brand`，
 * **刻意不传 `generate`**（`FillOptions.generate` 是这条链路上唯一会花钱的入口）。
 * 于是预览是零成本、可复现、可被列表页反复拉取的——这三点缺一不可，
 * 否则"给每张卡片配一张缩略图"会变成一笔按次计费的开销。
 *
 * ## 只读：不污染任何状态
 *
 * 全程只用纯函数（`createPageSpec` / `appendBlock` / `fillPage` / `renderPage` /
 * `renderDeck`）在内存里造一份结构：**不注册 block、不落盘、不进运行记录**。
 * 预览因此与"跑过一次"没有任何关系——它不该在历史里留下痕迹。
 */
import {
  appendBlock,
  createPageSpec,
  fillPage,
  renderDeck,
  renderPage,
  type BlockInstance,
  type BlockRegistry,
  type BlockSpec,
  type PageSpec,
  type SlotSpec,
  type SlotValue,
  type TemplateSpec,
} from '@mediasandbox/orchestrator';

/**
 * 预览用的固定目标与品牌。
 *
 * 示例值本身是写死的常量，但**图片与兜底 slot 仍需一个目标**：填充器的内联
 * 占位图标签、没被示例覆盖的 slot 文案都由它派生。写成常量而不是让调用方传，
 * 是为了让同一项的两次预览**逐字节相同**——否则"缓存了预览却没发现它已经变了"。
 */
const PREVIEW_GOAL = '示例元素预览';
const PREVIEW_BRAND = '示例站点';

// ── 示例值 ────────────────────────────────────────────────────────────────
//
// 这批值是**给预览看的固定样本**，不是内容生成策略：它们要回答的问题是
// "这块大概长什么样"，所以取的是能撑出版式的典型长度，而不是最省事的占位符。

/** `title` 型 slot 的示例（按 slot 名细分：副栏标题不该和主标题一模一样）。 */
const TITLE_SAMPLES: Readonly<Record<string, string>> = {
  heading: '示例小节标题',
  brand: '示例站点',
  number: '01',
  leftTitle: '示例左栏标题',
  rightTitle: '示例右栏标题',
  headline: '示例收口句',
};
const DEFAULT_TITLE = '示例标题';

/** `text` 型 slot 的示例。按 slot 名细分，因为同一个 `text` 在不同位置字数差很多。 */
const TEXT_SAMPLES: Readonly<Record<string, string>> = {
  subtitle: '示例副标题：一句话说明这个元素讲什么。',
  // 两段：正文块的段间距是要看得出来的东西，一段文字看不出。
  body: '示例正文第一段：这里放说明性文字，用来示意内容量与行宽。\n\n示例正文第二段：占位文字，方便看出段间距。',
  caption: '示例图注：说明上面这张图讲了什么。',
  attribution: '示例出处',
  actionText: '示例按钮',
  buttonText: '示例按钮',
  submitText: '提交',
  eyebrow: '示例眉标',
  lede: '示例导语：一句话点出这一页的结论。',
  note: '示例说明：这里放一句补充。',
  quote: '这是一段示例引文，用来示意引用在这个位置占多大版面。',
  contact: '联系方式：hello@example.com',
  source: '示例出处',
};
const DEFAULT_TEXT = '示例内容：这里放一句与这个元素相关的说明文字。';

/**
 * `code` 型 slot 的示例。
 *
 * 给一小段**真代码**而不是一句"这里是代码"：代码块的版式（等宽、行高、横向
 * 滚动）只有真的多行缩进代码才看得出来。
 */
const CODE_SAMPLE = [
  '// 示例代码：示意代码块的等宽排版',
  'export function greet(name: string): string {',
  '  return `你好，${name}`;',
  '}',
].join('\n');

/** 短标签：导航项、目录项、标签名共用。要短——长句塞进导航，版式一眼就不对。 */
const SHORT_LABELS: readonly string[] = ['概览', '特性', '用法', '参数', '常见问题'];

/** 表单字段名。字段是"标签 + 输入框"，给名字就够，不要给说明句。 */
const FIELD_NAMES: readonly string[] = ['姓名', '联系方式', '需求描述', '期望时间', '其他'];

/** 从一份标签表里循环取 `count` 个（不够就从头发车，不从别处借）。 */
function pick(labels: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_, i) => labels[i % labels.length]!);
}

/** 通用条目：没被更具体的规则命中的列表型 slot。 */
function defaultItems(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `示例条目 ${i + 1}：这里放一条简短说明。`);
}

/**
 * 示例列表的条数：`countRange.min` 与 3 取大，再被 `max` 压住。
 *
 * 为什么是 3：多数并列型版式的最小完整形态就是三条——一条看不出并列，
 * 两条看着像对比。但**仍要服从 `countRange`**：越界的样本连 `validatePageSpec`
 * 都过不了，预览不该给出一份自己都不合法的结构。
 */
function sampleCount(slot: SlotSpec): number {
  const range = slot.countRange;
  // 列表型 slot 必须声明区间（`validateSlot` 已强制），这里的兜底只针对
  // 万一将来放宽的场景——那时宁可给 3，也不要凭空造一个越界的长度。
  if (range === undefined) return 3;
  return Math.min(range.max, Math.max(range.min, 3));
}

/**
 * 列表型 slot 的示例条目。**按 block 与 slot 名分派**，不能只看类型。
 *
 * 理由与填充器里那一条相同：同一个"列表"在不同 block 里的**形态要求完全不同**。
 * `features.items` 是"标题 | 说明"，`accordion.items` 是"问 | 答"，而
 * `bullets.items` / `agenda.items` 是**纯条目**。全都套一套模板的话，前者会
 * 缺一半内容（卡片只剩标题），后者会多出一个字面的竖线——而预览的职责恰恰是
 * 让人看出真实排布，这里糊弄等于白做。
 */
function listSample(spec: BlockSpec, slot: SlotSpec, count: number): string[] {
  switch (slot.name) {
    case 'rows':
      // 表格按竖线切成两列：首行是表头，其余是正文行。不给竖线就只剩一列。
      return Array.from({ length: count }, (_, i) =>
        i === 0 ? '指标 | 取值' : `示例指标 ${i} | 示例取值 ${i}`,
      );
    case 'fields':
      return pick(FIELD_NAMES, count);
    case 'links':
      return pick(SHORT_LABELS, count);
    case 'tabs':
      return pick(SHORT_LABELS, count);
    case 'panels':
      // 面板与标签**一一对应**，所以两者取同一份名字：各取各的会在预览里错位，
      // 点第一个标签看到的是第二个面板的正文。
      return pick(SHORT_LABELS, count).map((name) => `${name}：示例面板正文，说明这一项讲了什么。`);
    case 'items':
      if (spec.id === 'features') {
        return Array.from(
          { length: count },
          (_, i) => `示例要点 ${i + 1} | 用一句话说明它能解决什么问题。`,
        );
      }
      if (spec.id === 'accordion') {
        return Array.from(
          { length: count },
          (_, i) => `示例问题 ${i + 1}？ | 示例回答：这一项的答案由确定性填充器给出。`,
        );
      }
      if (spec.id === 'agenda') return pick(SHORT_LABELS, count);
      return defaultItems(count);
    default:
      return defaultItems(count);
  }
}

/**
 * 一个 slot 的固定示例值。
 *
 * 返回 `undefined` 表示**刻意留空**，交给填充器的确定性实现去填——`image` 就是
 * 这样：它会产出内联 SVG 占位图，而不是一个空 `src`（空 `src` 会让浏览器把当前
 * 页面地址当图片再请求一次，预览就多几次莫名其妙的请求）。
 */
function sampleValue(spec: BlockSpec, slot: SlotSpec): SlotValue | undefined {
  switch (slot.type) {
    case 'title':
      return { kind: 'text', text: TITLE_SAMPLES[slot.name] ?? DEFAULT_TITLE };
    case 'text':
      return { kind: 'text', text: TEXT_SAMPLES[slot.name] ?? DEFAULT_TEXT };
    case 'code':
      return { kind: 'text', text: CODE_SAMPLE };
    case 'link':
      // 链接不该由预览编出一个真地址：`#` 保证点它不会离开预览页。
      return { kind: 'text', text: '#' };
    case 'literal':
      // `literal` 的语义是"确定性常量"，而常量是什么取决于 slot 名——
      // 代码块的 `language` 与页脚的 `copyright` 都是 literal。
      return { kind: 'text', text: slot.name === 'language' ? 'ts' : '© 示例站点 版权所有' };
    case 'image':
      return undefined;
    case 'list-image':
      // 同样留空，但**长度要给**：条数是一个决定，预览也得按它排；不给长度的话
      // 图集永远只出 `countRange.min` 张，看不出真实密度。
      return {
        kind: 'list-image',
        refs: Array.from({ length: sampleCount(slot) }, () => ({ ref: '', alt: '' })),
      };
    case 'list-text':
      return { kind: 'list', items: listSample(spec, slot, sampleCount(slot)) };
  }
}

/** 该 block 的一份示例 slot 取值。 */
function sampleSlots(spec: BlockSpec): Record<string, SlotValue> {
  const slots: Record<string, SlotValue> = {};
  for (const slot of spec.slots) {
    const value = sampleValue(spec, slot);
    // 留空的 slot 不出现在 `slots` 里：填充器会把它当作"还没填"，
    // 走自己的确定性实现，图片因此拿到内联 SVG 占位图。
    if (value !== undefined) slots[slot.name] = value;
  }
  return slots;
}

/**
 * 造一个待填充的 block。
 *
 * 状态写 `pending`：**结构已定、内容归填充器**。这与 planner 交给 `fill-block`
 * 的形态完全一致，所以预览走的是与真实运行同一条填充路径，而不是一条"预览专用"的捷径。
 */
function sampleBlock(
  id: string,
  spec: BlockSpec,
  preset?: Readonly<Record<string, SlotValue>> | undefined,
): BlockInstance {
  return {
    id,
    type: spec.id,
    // 模板预置的 slot 值盖在示例之上：预置值（品牌名、版权行）是模板作者真的要的东西。
    slots: { ...sampleSlots(spec), ...preset },
    status: 'pending',
    sources: {},
  };
}

// ── 预览渲染 ──────────────────────────────────────────────────────────────

/**
 * 造结构 → 确定性填充。
 *
 * 三条接口的差别只有"造哪些块、用哪个渲染器"，填充这一步完全共用——
 * 于是"预览不调生成层"这条约束只需在这一处守住。
 */
async function fillPreview(
  registry: BlockRegistry,
  projectId: string,
  blocks: readonly BlockInstance[],
): Promise<PageSpec> {
  let page = createPageSpec({
    projectId,
    goal: PREVIEW_GOAL,
    candidateBlockIds: [...new Set(blocks.map((b) => b.type))],
    // 写死 0：预览必须逐字节可复现，任何"当前时间"都不该混进来。
    createdAt: 0,
  });
  for (const block of blocks) page = appendBlock(page, block);

  const { page: filled, generativeCalls } = await fillPage({
    page,
    blocks: registry,
    // 只给品牌。`FillOptions` 里会花钱的只有 `generate`，这里**刻意不给**。
    options: { brand: PREVIEW_BRAND },
  });
  // 不可达路径也要拦住：这条约束是成本红线，一旦被将来的改动破坏，
  // 表现会是"预览接口悄悄开始按次计费"，而不是一次报错。
  if (generativeCalls !== 0) {
    throw new Error(`预览只允许确定性填充，本次却发生了 ${generativeCalls} 次生成层调用`);
  }
  return filled;
}

/** 单个网页 block 的效果预览。 */
export async function previewBlockHtml(
  registry: BlockRegistry,
  spec: BlockSpec,
): Promise<string> {
  const page = await fillPreview(registry, `preview-block-${spec.id}`, [sampleBlock('b1', spec)]);
  // `blocks` 必须传：自定义 block 没有专属渲染器，靠它走通用渲染；
  // 不传的话预览会落成"未支持的 block 类型"，与真实产物不一致。
  return renderPage(page, { title: `${spec.label} · 预览`, blocks: registry });
}

/** 单个演示文稿版式的预览。用哪个渲染器由模态决定，与产物端一致。 */
export async function previewSlideLayoutHtml(
  registry: BlockRegistry,
  spec: BlockSpec,
): Promise<string> {
  const page = await fillPreview(registry, `preview-layout-${spec.id}`, [sampleBlock('b1', spec)]);
  return renderDeck(page, { title: `${spec.label} · 预览` });
}

/** 整套模板的预览：用模板**自己的块序**，"这套起手排出来是什么样"一眼可见。 */
export async function previewTemplateHtml(
  registry: BlockRegistry,
  template: TemplateSpec,
): Promise<string> {
  const blocks = template.blocks.map((entry, i) =>
    sampleBlock(`b${i + 1}`, registry.get(entry.type), entry.slots),
  );
  const page = await fillPreview(registry, `preview-template-${template.id}`, blocks);
  return renderPage(page, { title: `${template.label} · 预览`, blocks: registry });
}
