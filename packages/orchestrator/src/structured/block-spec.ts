/**
 * block 类型注册表。
 *
 * ## 为什么需要它
 *
 * 现有工具是**交付物级**粒度（整页、整篇、整图）。于是"做一个网页"退化成
 * "调一次大模型吐一个 HTML 字符串"——中间没有任何可决策、可干预、可校验的对象。
 *
 * block 把颗粒度降到**版式单元**级：`hero` / `features` / `gallery` …
 * 页面结构由此变成可枚举的数据，决策模型才有东西可选。
 *
 * ## 与工具注册表同构
 *
 * 工具注册表的核心原则是「候选集来自注册表，扩展工具链 = 加一条，不需重训模型」。
 * block 池沿用同一条原则：**决策模型只在本次候选集里选**，候选集来自这里。
 *
 * ## slot 是素材的落点
 *
 * 每个 block 声明具名、有类型的 slot。**类型决定由谁来填**：
 * 文本与代码归生成层，链接与常量归确定性代码，图片归图像端点。
 * 这就是"素材填充"的落点——逐个 slot 独立决定，而不是让模型一揽子吐出来。
 */
import type { NumericRange } from '../decision/types.js';

/**
 * slot 类型。决定**由谁来填**，因此是"素材层"的核心契约。
 */
export type SlotType =
  /** 自由文本。归生成层。 */
  | 'text'
  /** 短标题，有长度上限。归生成层。 */
  | 'title'
  /** 图片。归图像端点；确定性实现下退化为内联占位图形。 */
  | 'image'
  /** 源码。归生成层。 */
  | 'code'
  /** 链接。**确定性**——不该让模型编 URL。 */
  | 'link'
  /** 用户指定或确定性派生的常量。 */
  | 'literal'
  /** 文本列表。需要先问"要几个"（`numeric` 原语的落点）。 */
  | 'list-text'
  /** 图集。需要先问"要几张"。 */
  | 'list-image';

/**
 * block 分组。
 *
 * 三类各有用途，不是装饰：
 *   - `skeleton` 决定页面**版式**
 *   - `content`  决定**信息形态**
 *   - `interactive` 是验证环节的**测试对象**（有交互才有点击可模拟）
 */
export type BlockGroup = 'skeleton' | 'content' | 'interactive';

export const BLOCK_GROUPS: readonly BlockGroup[] = ['skeleton', 'content', 'interactive'];

export const BLOCK_GROUP_LABELS: Readonly<Record<BlockGroup, string>> = {
  skeleton: '页面骨架',
  content: '内容块',
  interactive: '交互块',
};

/**
 * 版式位置约束。
 *
 * 与 `canLead` **分工不同，两者都要**：
 *
 * | 字段 | 作用时机 | 管什么 |
 * |---|---|---|
 * | `canLead` | 规划**前** | 候选集过滤：首轮根本不给 `footer` 这种选项 |
 * | `placement` | 定稿**后** | 规范化：把跑偏的 `nav` / `footer` 挪回该在的位置 |
 *
 * 为什么两个都需要：`canLead` 只能挡住"第一块"，挡不住"第二块放 footer"。
 * 实测确实排得出 `hero → footer → features` —— 页脚后面还有正文，页面是错的，
 * 而每一块单独看都合法、测试也不会报。
 *
 * **只约束两端，不管中间**：中间位置属于版式偏好，交给决策模型判断。
 */
export type BlockPlacement = 'any' | 'first' | 'last';

/** 一个具名 slot 的声明。 */
export interface SlotSpec {
  readonly name: string;
  readonly type: SlotType;
  /** 缺省时由填充器补上。 */
  readonly required: boolean;
  /** 展示给决策模型的说明。 */
  readonly description: string;
  /**
   * `list-*` 型 slot 的长度区间：**"要几个"这类问题只对它有定义**。
   * 非列表型 slot 不设此项——没有量程的 numeric 问句没有意义。
   */
  readonly countRange?: NumericRange | undefined;
}

/** 一个 block 类型的声明。 */
export interface BlockSpec {
  /** 稳定标识。结构数据、决策候选、前端展示都用它。 */
  readonly id: string;
  /** 展示给决策模型的名称。 */
  readonly label: string;
  /** 补充说明，让决策模型能区分相近 block。 */
  readonly description: string;
  readonly group: BlockGroup;
  readonly slots: readonly SlotSpec[];
  /**
   * 该 block 能否作为页面首块。
   *
   * 首块决定页面第一印象，`footer` / `nav` 之类当首块是明显的结构错误；
   * 与其让决策模型犯错再纠正，不如**从一开始就不给它这个选项**。
   */
  readonly canLead: boolean;
  /** 同一页面上是否允许多次出现。`hero` 出现两次是错，`text` 出现两次很正常。 */
  readonly repeatable: boolean;
  /**
   * 版式位置约束。省略即 `'any'`。
   *
   * 只有语义上**定义在两端**的块才该设：`nav` 是"顶部导航"，`footer` 是页脚。
   * 其余一律不设——把 `gallery` 钉死在某个位置会夺走决策模型的判断空间。
   */
  readonly placement?: BlockPlacement | undefined;
  /** 实现成本提示，供决策模型权衡。 */
  readonly costHint: 'fast' | 'medium' | 'slow';
}

export class BlockError extends Error {
  override readonly name = 'BlockError';
  constructor(
    message: string,
    readonly code: BlockErrorCode,
    readonly blockId: string,
  ) {
    super(message);
  }
}

export type BlockErrorCode =
  /** spec 本身不合法。 */
  | 'BAD_SPEC'
  /** id 重复注册。 */
  | 'DUPLICATE_BLOCK'
  /** 池子里没有这个 block。 */
  | 'UNKNOWN_BLOCK'
  /** 候选集为空或不满足决策层约束。 */
  | 'BAD_CANDIDATES';

/** 决策层 `choice` 候选集的一项。与工具注册表的 `CandidateOption` 同形。 */
export interface BlockOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly group: BlockGroup;
}

/** 候选集查询。 */
export interface BlockQuery {
  readonly group?: BlockGroup | undefined;
  /** 只看能当首块的。 */
  readonly leadOnly?: boolean | undefined;
  /** 只看可重复出现的。 */
  readonly repeatableOnly?: boolean | undefined;
  readonly exclude?: readonly string[] | undefined;
}

function validateSlot(spec: BlockSpec, slot: SlotSpec): void {
  if (slot.name.trim() === '') {
    throw new BlockError(`block ${spec.id} 的 slot 名为空`, 'BAD_SPEC', spec.id);
  }
  if (!/^[a-z][a-zA-Z0-9]*$/.test(slot.name)) {
    throw new BlockError(
      `block ${spec.id} 的 slot 名只允许小写字母开头的驼峰: ${slot.name}`,
      'BAD_SPEC',
      spec.id,
    );
  }
  /**
   * 列表型 slot **无论必需与否**都必须声明 `countRange`。
   *
   * 原因：列表的长度是一个**决策**（"要几条"），而不是填充器随便取的值。
   * 不声明区间，就等于把"要几个"这个问题从决策层手里拿走，
   * 交给填充器用一个内部默认值——那正是本项目要消灭的那种"隐式决定"。
   * 必需与否只影响"这一块能不能没有这个 slot"，不影响它该不该被问。
   */
  const isList = slot.type === 'list-text' || slot.type === 'list-image';
  if (isList && slot.countRange === undefined) {
    throw new BlockError(
      `block ${spec.id} 的列表型 slot ${slot.name} 必须声明 countRange，` +
        `否则无法向决策层提出"要几个"的问题——长度就成了填充器的隐式决定`,
      'BAD_SPEC',
      spec.id,
    );
  }
  if (!isList && slot.countRange !== undefined) {
    throw new BlockError(
      `block ${spec.id} 的非列表型 slot ${slot.name} 不应声明 countRange`,
      'BAD_SPEC',
      spec.id,
    );
  }
  if (slot.countRange !== undefined) {
    const { min, max } = slot.countRange;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
      throw new BlockError(
        `block ${spec.id} 的 slot ${slot.name} 的 countRange 非法: ${min}..${max}`,
        'BAD_SPEC',
        spec.id,
      );
    }
  }
}

function validateSpec(spec: BlockSpec): void {
  if (spec.id.trim() === '') {
    throw new BlockError('block id 不能为空', 'BAD_SPEC', spec.id);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(spec.id)) {
    throw new BlockError(
      `block id 只允许小写字母、数字与连字符: ${spec.id}`,
      'BAD_SPEC',
      spec.id,
    );
  }
  if (spec.slots.length === 0) {
    throw new BlockError(`block ${spec.id} 未声明任何 slot`, 'BAD_SPEC', spec.id);
  }
  // `placement: 'first'` 与 `canLead: false` 是自相矛盾的声明：
  // 一个块"必须在最前"却又"不能作为首块"，规范化和候选过滤会打架。
  if (spec.placement === 'first' && !spec.canLead) {
    throw new BlockError(
      `block ${spec.id} 声明了 placement='first' 却 canLead=false，两者矛盾`,
      'BAD_SPEC',
      spec.id,
    );
  }
  const names = new Set<string>();
  for (const slot of spec.slots) {
    if (names.has(slot.name)) {
      throw new BlockError(`block ${spec.id} 的 slot 重名: ${slot.name}`, 'BAD_SPEC', spec.id);
    }
    names.add(slot.name);
    validateSlot(spec, slot);
  }
}

/**
 * block 池。
 *
 * 内置 15 类（见 `BUILTIN_BLOCKS`），另外接受三类外部来源——模型提议、用户手打、
 * 导入。外部来源**必须走 `register` 的同一套校验**：提议不等于决定，
 * 未通过校验的 block 不得进入候选集。
 */
export class BlockRegistry {
  private readonly blocks = new Map<string, BlockSpec>();

  register(spec: BlockSpec): this {
    validateSpec(spec);
    if (this.blocks.has(spec.id)) {
      throw new BlockError(`block id 已被注册: ${spec.id}`, 'DUPLICATE_BLOCK', spec.id);
    }
    this.blocks.set(spec.id, spec);
    return this;
  }

  registerAll(specs: readonly BlockSpec[]): this {
    for (const spec of specs) validateSpec(spec);
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.id)) {
        throw new BlockError(`批量注册中存在重复 id: ${spec.id}`, 'DUPLICATE_BLOCK', spec.id);
      }
      seen.add(spec.id);
      if (this.blocks.has(spec.id)) {
        throw new BlockError(`block id 已被注册: ${spec.id}`, 'DUPLICATE_BLOCK', spec.id);
      }
    }
    for (const spec of specs) this.blocks.set(spec.id, spec);
    return this;
  }

  has(blockId: string): boolean {
    return this.blocks.has(blockId);
  }

  get(blockId: string): BlockSpec {
    const spec = this.blocks.get(blockId);
    if (spec === undefined) {
      throw new BlockError(`未注册的 block: ${blockId}`, 'UNKNOWN_BLOCK', blockId);
    }
    return spec;
  }

  /** 全部 spec，按 id 排序保证确定性。 */
  specs(): BlockSpec[] {
    return [...this.blocks.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** 分组名，按固定顺序（骨架 → 内容 → 交互），不是字母序。 */
  groups(): BlockGroup[] {
    return BLOCK_GROUPS.filter((g) => this.specs().some((s) => s.group === g));
  }

  filter(query: BlockQuery = {}): BlockSpec[] {
    const exclude = new Set(query.exclude ?? []);
    return this.specs().filter((spec) => {
      if (exclude.has(spec.id)) return false;
      if (query.group !== undefined && spec.group !== query.group) return false;
      if (query.leadOnly === true && !spec.canLead) return false;
      if (query.repeatableOnly === true && !spec.repeatable) return false;
      return true;
    });
  }

  /**
   * 导出决策层 `choice` 的候选集。
   *
   * **候选集只有一项时不导出**：问一个只有一个选项的问题没有意义。
   * 这一点是 `assemble` 的既定做法（唯一候选直接采用、省一次决策往返），
   * 保持一致。
   */
  candidatesFor(query: BlockQuery = {}): BlockOption[] {
    return this.filter(query).map((spec) => ({
      id: spec.id,
      label: spec.label,
      detail: spec.description,
      group: spec.group,
    }));
  }

  /**
   * 转成决策层 `choice` 原语要的 criteria 结构（id → 描述）。
   *
   * 描述里带分组前缀，让决策模型看得见"这是骨架块还是交互块"——
   * 分组信息不进 state 就等于不存在。
   */
  criteriaFor(query: BlockQuery = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const option of this.candidatesFor(query)) {
      out[option.id] = `[${BLOCK_GROUP_LABELS[option.group]}] ${option.label}：${option.detail}`;
    }
    return out;
  }

  get size(): number {
    return this.blocks.size;
  }
}

// ── slot 构造辅助（让下面的声明读起来像表格） ──────────────────────────

function slot(name: string, type: SlotType, description: string, required = true): SlotSpec {
  return { name, type, required, description };
}

function listSlot(
  name: string,
  type: 'list-text' | 'list-image',
  description: string,
  min: number,
  max: number,
): SlotSpec {
  return { name, type, required: true, description, countRange: { min, max } };
}

/** 可选的列表型 slot。**同样要声明 countRange** —— 见下面 `validateSlot` 的说明。 */
function optionalListSlot(
  name: string,
  type: 'list-text' | 'list-image',
  description: string,
  min: number,
  max: number,
): SlotSpec {
  return { name, type, required: false, description, countRange: { min, max } };
}

const optional = (s: SlotSpec): SlotSpec => ({ ...s, required: false });

/**
 * 内置 block 词表：15 类，分 3 组。
 *
 * **15 < 26**（`MAX_OPTIONS_PER_QUESTION`），所以单问即可，不需要分层。
 * 分组仍然有价值：界面按组展示，提问时可限定"只在骨架组里选"。
 *
 * 先给字面量标注类型、再另起一个排序后的视图：直接写
 * `const X: readonly BlockSpec[] = [...].sort()` 时，TS 为了确认 `.sort()`
 * 存在会先推断字面量类型，标注就失效了，`group` 被放宽成 `string`。
 */
const BLOCKS: readonly BlockSpec[] = [
  // ── 页面骨架 ────────────────────────────────────────────────────────
  {
    id: 'hero',
    label: '首屏主视觉',
    description: '页面顶部的标题、副标题与主视觉图，决定第一印象。通常放最前，全页最多一次',
    group: 'skeleton',
    slots: [
      slot('title', 'title', '主标题'),
      slot('subtitle', 'text', '一句话副标题'),
      optional(slot('media', 'image', '主视觉图')),
      slot('actionText', 'text', '行动按钮文字'),
      optional(slot('actionHref', 'link', '按钮链接')),
    ],
    canLead: true,
    repeatable: false,
    costHint: 'medium',
  },
  {
    id: 'features',
    label: '特性条目',
    description: '三条左右的并列要点，每条一个标题加一句说明。适合讲清"能做什么"',
    group: 'skeleton',
    slots: [
      slot('heading', 'title', '小节标题'),
      listSlot('items', 'list-text', '条目，每行一条', 2, 6),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'gallery',
    label: '图片集',
    description: '一组并排展示的图片，适合作品集与产品截图',
    group: 'skeleton',
    slots: [
      slot('heading', 'title', '小节标题'),
      listSlot('images', 'list-image', '图片，每张一行提示词', 2, 8),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'slow',
  },
  {
    id: 'cta',
    label: '行动号召',
    description: '页面末尾的转化区：一句号召加一个按钮',
    group: 'skeleton',
    slots: [
      slot('text', 'title', '号召语'),
      slot('buttonText', 'text', '按钮文字'),
      optional(slot('href', 'link', '按钮链接')),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'footer',
    label: '页脚',
    description: '版权与辅助链接。应放在页面最后',
    group: 'skeleton',
    slots: [
      slot('copyright', 'literal', '版权行'),
      optionalListSlot('links', 'list-text', '辅助链接，每行一条', 1, 5),
    ],
    canLead: false,
    repeatable: false,
    placement: 'last',
    costHint: 'fast',
  },
  {
    id: 'nav',
    label: '导航栏',
    description: '顶部导航，含站点名与若干链接。适合多区块的长页面',
    group: 'skeleton',
    slots: [
      slot('brand', 'title', '站点名'),
      listSlot('links', 'list-text', '导航项，每行一条', 2, 6),
    ],
    canLead: true,
    repeatable: false,
    placement: 'first',
    costHint: 'fast',
  },

  // ── 内容块 ──────────────────────────────────────────────────────────
  {
    id: 'text',
    label: '正文段落',
    description: '一段说明性文字。最通用的内容块，可多次出现',
    group: 'content',
    slots: [
      optional(slot('heading', 'title', '段落小标题')),
      slot('body', 'text', '正文，可多段'),
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'image',
    label: '单张配图',
    description: '一张带说明文字的图，适合插在正文之间',
    group: 'content',
    slots: [
      slot('prompt', 'image', '图片内容描述'),
      optional(slot('caption', 'text', '图注')),
    ],
    canLead: true,
    repeatable: true,
    costHint: 'slow',
  },
  {
    id: 'video',
    label: '视频位',
    description: '一个视频播放位。无真实素材时展示占位框',
    group: 'content',
    slots: [
      optional(slot('heading', 'title', '小节标题')),
      slot('src', 'link', '视频地址'),
      optional(slot('poster', 'image', '封面图')),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'code',
    label: '代码块',
    description: '等宽字体展示的源码片段，适合技术文档',
    group: 'content',
    slots: [
      optional(slot('heading', 'title', '小节标题')),
      slot('language', 'literal', '语言标识，如 ts'),
      slot('source', 'code', '源码'),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'medium',
  },
  {
    id: 'quote',
    label: '引用',
    description: '一段带出处的引述，用于证言或强调',
    group: 'content',
    slots: [
      slot('text', 'text', '引述内容'),
      slot('attribution', 'text', '出处'),
    ],
    canLead: true,
    repeatable: true,
    costHint: 'fast',
  },
  {
    id: 'table',
    label: '表格',
    description: '行列对照数据，适合参数或价格对比',
    group: 'content',
    slots: [
      optional(slot('heading', 'title', '小节标题')),
      listSlot('rows', 'list-text', '每行一条，单元格用竖线分隔', 2, 8),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },

  // ── 交互块（验证环节的测试对象） ────────────────────────────────────
  {
    id: 'form',
    label: '表单',
    description: '收集输入的字段组与提交按钮。有交互，可被模拟点击验证',
    group: 'interactive',
    slots: [
      slot('heading', 'title', '表单标题'),
      listSlot('fields', 'list-text', '字段名，每行一个', 1, 5),
      slot('submitText', 'text', '提交按钮文字'),
    ],
    canLead: false,
    repeatable: false,
    costHint: 'medium',
  },
  {
    id: 'tabs',
    label: '标签页',
    description: '并列切换的若干面板。点击切换是本项目验证环节的主要模拟对象',
    group: 'interactive',
    slots: [
      listSlot('tabs', 'list-text', '标签名，每行一个', 2, 5),
      listSlot('panels', 'list-text', '各面板正文，与标签一一对应', 2, 5),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'medium',
  },
  {
    id: 'accordion',
    label: '折叠面板',
    description: '逐条展开的问答列表，适合常见问题',
    group: 'interactive',
    slots: [
      optional(slot('heading', 'title', '小节标题')),
      listSlot('items', 'list-text', '每行一条，问与答用竖线分隔', 2, 8),
    ],
    canLead: false,
    repeatable: true,
    costHint: 'fast',
  },
];

/** 内置 block 词表，按 id 排序。 */
export const BUILTIN_BLOCKS: readonly BlockSpec[] = [...BLOCKS].sort((a, b) =>
  a.id < b.id ? -1 : 1,
);
/** 建一个装了内置 block 的池子。外部来源自行 `register` 追加。 */
export function createBlockRegistry(extra: readonly BlockSpec[] = []): BlockRegistry {
  return new BlockRegistry().registerAll(BUILTIN_BLOCKS).registerAll(extra);
}

/** 内置 block 池的只读视图，供测试与展示用。 */
export function builtinBlockIds(): string[] {
  return BUILTIN_BLOCKS.map((b) => b.id);
}
