/**
 * 模板：**沉淀下来的起手结构**。
 *
 * ## 与既有 `static-page-from-template` 的根本区别
 *
 * 那个模板是**把 HTML 串硬编码在 TypeScript 里**的，且**不可改**：
 * 它只是一个"确定性路线"的工具，跟"模板"这个概念其实没关系。
 * 这里的模板是**数据**——可改、可派生、可从历史沉淀出来。
 * 结构是数据，模板才可能是数据；这是同一个前提的两次使用。
 *
 * ## 模板干两件事（设计稿 §7.1）
 *
 * | 用法 | 怎么实现 |
 * |---|---|
 * | **限定范围** | `allowedBlockIds`：本次只在这些 block 类型里工作，防跑偏 |
 * | **起手结构** | `blocks`：给出一个初始序列，规划器**从它之后继续排** |
 *
 * ## 关键边界：起手 ≠ 定死
 *
 * 模板给的必须是**起手**，不能是"最终结构"。后者会让决策模型沦为装饰 ——
 * 那是这个项目一开始就要消灭的病根（见设计稿 §2.1）。
 *
 * 所以：模板放进来的块记入 `usedTypes`，规划器**照旧逐块问决策模型**
 * "还要不要再来一块、下一块放什么"。一个把六块全排满的模板，
 * 模型仍然可以对"要不要继续"答否，也仍然可以插入它认为需要的块。
 *
 * 想要"完全照模板渲染、一个字都不改"，那该走**直接渲染**而不是走规划器 ——
 * 那条路本次不做，也不该伪装成模板。
 */
import type { BlockRegistry } from './block-spec.js';
import {
  appendBlock,
  nextBlockId,
  type BlockInstance,
  type PageSpec,
  type SlotValue,
} from './page-spec.js';

/** 模板里的一个块：只要类型，可选地预置 slot 值。 */
export interface TemplateBlock {
  /** 指向 `BlockSpec.id`。注册时校验存在性。 */
  readonly type: string;
  /**
   * 预置的 slot 值。
   *
   * 用途是"这个模板要求带上品牌名/版权行/固定链接"这类**事实性内容**，
   * 而不是"把上次项目写的文案抄过来"——后者会让新项目串味。
   * `extractTemplate`（从历史沉淀）**刻意不填这个字段**。
   */
  readonly slots?: Readonly<Record<string, SlotValue>> | undefined;
}

/** 模板声明。 */
export interface TemplateSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 起手结构。空数组表示"只限定范围，不给起手结构"。 */
  readonly blocks: readonly TemplateBlock[];
  /**
   * 限定范围：本次只能在这些 block 类型里工作。
   * 省略表示不额外限制（仍受调用方给的候选集约束）。
   */
  readonly allowedBlockIds?: readonly string[] | undefined;
  /**
   * 是否内置。
   *
   * 标出来是为了让界面能分开"我们提供的"与"从你项目里沉淀的"——
   * 后者可以删，前者删了只是下次还在。
   */
  readonly builtin: boolean;
}

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  constructor(
    message: string,
    readonly code: TemplateErrorCode,
    readonly templateId: string,
  ) {
    super(message);
  }
}

export type TemplateErrorCode =
  /** 模板声明本身不合法。 */
  | 'BAD_TEMPLATE'
  /** id 重复注册。 */
  | 'DUPLICATE_TEMPLATE'
  /** 池子里没有这个模板。 */
  | 'UNKNOWN_TEMPLATE';

/**
 * 校验一个模板声明。
 *
 * **起手结构必须自己就是合规的**：模板是"沉淀的经验"，一个排错的模板
 * 会把这个错误复制到之后每一个用它的项目上。宁可注册时就拒绝。
 *
 * 校验的是与 `normalizePageSpec` 同一组版式规则，但**时机不同、目的不同**：
 * 这里是"注册期拒绝坏数据"（fail fast），那里是"运行期兜住漂移"
 * （模板可以被人工改、结构可以被干预）。两处都需要。
 */
export function validateTemplate(spec: TemplateSpec, blocks: BlockRegistry): void {
  const fail = (message: string): never => {
    throw new TemplateError(message, 'BAD_TEMPLATE', spec.id);
  };

  if (!/^[a-z][a-z0-9-]*$/.test(spec.id)) {
    fail(`模板 id 只允许小写字母、数字与连字符: ${spec.id}`);
  }
  if (spec.label.trim() === '') fail(`模板 ${spec.id} 的 label 为空`);
  if (spec.description.trim() === '') fail(`模板 ${spec.id} 的 description 为空`);

  const seen = new Set<string>();
  for (const [index, entry] of spec.blocks.entries()) {
    if (!blocks.has(entry.type)) {
      fail(`模板 ${spec.id} 的第 ${index + 1} 块引用了未注册的 block: ${entry.type}`);
    }
    const blockSpec = blocks.get(entry.type);
    if (!blockSpec.repeatable && seen.has(entry.type)) {
      fail(`模板 ${spec.id} 里 ${entry.type} 声明为不可重复，却出现了两次`);
    }
    seen.add(entry.type);

    // 位置约束：模板是经验，经验不该是"页脚排在第一块"。
    if (blockSpec.placement === 'first' && index !== 0) {
      fail(`模板 ${spec.id} 的 ${entry.type} 声明了 placement='first'，却在第 ${index + 1} 位`);
    }
    if (blockSpec.placement === 'last' && index !== spec.blocks.length - 1) {
      fail(
        `模板 ${spec.id} 的 ${entry.type} 声明了 placement='last'，` +
          `却在第 ${index + 1} 位（共 ${spec.blocks.length} 块）`,
      );
    }
    if (index === 0 && !blockSpec.canLead) {
      fail(`模板 ${spec.id} 的首块 ${entry.type} 不能作为首块（canLead=false）`);
    }
  }

  for (const id of spec.allowedBlockIds ?? []) {
    if (!blocks.has(id)) {
      fail(`模板 ${spec.id} 的 allowedBlockIds 引用了未注册的 block: ${id}`);
    }
  }
}

/**
 * 模板池。与 `BlockRegistry` / `ToolRegistry` 同构：
 * **候选集来自注册表**，扩展模板 = 加一条，不动链路。
 */
export class TemplateRegistry {
  private readonly templates = new Map<string, TemplateSpec>();

  constructor(private readonly blocks: BlockRegistry) {}

  register(spec: TemplateSpec): this {
    validateTemplate(spec, this.blocks);
    if (this.templates.has(spec.id)) {
      throw new TemplateError(`模板 id 已被注册: ${spec.id}`, 'DUPLICATE_TEMPLATE', spec.id);
    }
    this.templates.set(spec.id, spec);
    return this;
  }

  registerAll(specs: readonly TemplateSpec[]): this {
    for (const spec of specs) validateTemplate(spec, this.blocks);
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.id)) {
        throw new TemplateError(`批量注册中存在重复 id: ${spec.id}`, 'DUPLICATE_TEMPLATE', spec.id);
      }
      seen.add(spec.id);
      if (this.templates.has(spec.id)) {
        throw new TemplateError(`模板 id 已被注册: ${spec.id}`, 'DUPLICATE_TEMPLATE', spec.id);
      }
    }
    for (const spec of specs) this.templates.set(spec.id, spec);
    return this;
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  /**
   * 移除一个模板。返回是否真的删掉了。
   *
   * **不拦内置模板**：注册表只负责"池子里有什么"，"哪些允许删"是产品决定，
   * 由服务层判（它会回 409）。把策略塞进数据结构里，会让另一个调用方
   * （比如"清空沉淀"的脚本）也跟着被限制住。
   */
  remove(id: string): boolean {
    return this.templates.delete(id);
  }

  get(id: string): TemplateSpec {
    const spec = this.templates.get(id);
    if (spec === undefined) {
      throw new TemplateError(`未注册的模板: ${id}`, 'UNKNOWN_TEMPLATE', id);
    }
    return spec;
  }

  /** 全部模板，按 id 排序保证确定性。内置在前只是一种展示偏好，这里不做。 */
  specs(): TemplateSpec[] {
    return [...this.templates.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  get size(): number {
    return this.templates.size;
  }
}

/**
 * 把模板的起手结构铺到一个空页面上。
 *
 * 返回的块一律是 `pending`：模板给的是**结构**，内容归填充器。
 * 模板里预置了 slot 的块照样是 `pending` —— 状态说的是"还没填充完"，
 * 而预置值会在填充时作为"用户已给"被保留（见 `filler.ts` 的 `preserved` 分支）。
 */
export function applyTemplate(page: PageSpec, template: TemplateSpec): PageSpec {
  // 显式标注类型：不标的话 `templateId` 会被推成 `string`，
  // 后面 `appendBlock` 返回的 `PageSpec` 就赋不回来了。
  let next: PageSpec = { ...page, templateId: template.id };
  for (const entry of template.blocks) {
    const block: BlockInstance = {
      id: nextBlockId(next),
      type: entry.type,
      slots: entry.slots ?? {},
      status: 'pending',
      sources: {},
    };
    next = appendBlock(next, block);
  }
  return next;
}

/**
 * 候选集与模板的**限定范围**取交集。
 *
 * 两个方向都写清楚：
 *   - 模板给了 `allowedBlockIds` → 取交集（模板是用户明确选的范围，更具体）
 *   - 模板没给 → 原样返回调用方的候选集
 *
 * 交集为空时抛错而不是返回空：那意味着"模板与候选集互相排斥"，
 * 让它走到规划器只会得到一个更难懂的 `NO_CANDIDATES`。
 */
export function narrowCandidates(
  candidates: readonly string[],
  template: TemplateSpec | undefined,
): string[] {
  if (template?.allowedBlockIds === undefined) return [...candidates];
  const allowed = new Set(template.allowedBlockIds);
  const narrowed = candidates.filter((id) => allowed.has(id));
  if (narrowed.length === 0) {
    throw new TemplateError(
      `模板 ${template.id} 的 allowedBlockIds 与本次候选集没有交集，无法开工`,
      'BAD_TEMPLATE',
      template.id,
    );
  }
  return narrowed;
}

/**
 * 从一份**已完成的结构**沉淀出模板。
 *
 * ## 只沉淀结构，不沉淀内容
 *
 * 刻意**不带 slot 值**：把上一个项目的文案抄进新项目，页面会串味
 * （"产品介绍落地页"里出现上个项目的品牌名与卖点）。沉淀下来的是
 * **"这类目标通常该怎么排版"**，不是"上次写了什么"。
 *
 * ## 为什么这是护城河而不是功能（设计稿 §7.2）
 *
 * 结构是数据、决策有留痕、验证有结果 —— 这些让"跑过的项目"能自动变成
 * "下次的起手经验"。一本字符串形态的 HTML 做不到：结构藏在文本里，机器读不出来。
 */
export function extractTemplate(
  page: PageSpec,
  args: { readonly id: string; readonly label?: string | undefined; readonly description?: string | undefined },
): TemplateSpec {
  const types = page.blocks.map((b) => b.type);
  return {
    id: args.id,
    label: args.label ?? `${page.goal.slice(0, 12)} 的结构`,
    description:
      args.description ??
      `从项目「${page.goal}」沉淀：${types.length} 块（${types.join(' → ')}）` +
        (page.qualityScore === null ? '' : `，结构评分 ${page.qualityScore.toFixed(3)}`),
    blocks: types.map((type) => ({ type })),
    allowedBlockIds: [...new Set(types)],
    builtin: false,
  };
}

// ── 内置模板 ──────────────────────────────────────────────────────────────
//
// **都是起手前缀，不是整页**：给一个被验证过"顺序合理"的开头，
// 剩下的块仍然由决策模型逐块决定。刻意都不收尾（不放 cta / footer），
// 否则模型一上来就无事可排了。
//
// 这与"从历史沉淀出来的模板"是有区别的：后者是**跑完过的整页**，
// 通常自带收尾块。两种都合法 —— 模板承载的是**用户已经决定的结构**，
// 它当然可以决定得很完整。红线管的是"生成层不能决定结构"（设计稿 §2.1），
// 不是"用户不能决定结构"。

const BUILTIN_TEMPLATES: readonly TemplateSpec[] = [
  {
    id: 'product-launch',
    label: '产品落地页',
    description: '首屏讲清是什么，接着展开特性。最通用的一种起手',
    blocks: [{ type: 'hero' }, { type: 'features' }],
    allowedBlockIds: ['hero', 'features', 'gallery', 'cta', 'footer', 'nav', 'text', 'quote', 'tabs'],
    builtin: true,
  },
  {
    id: 'doc-page',
    label: '技术文档页',
    description: '带导航的说明页起手，主体由代码块与表格展开',
    blocks: [{ type: 'nav' }, { type: 'text' }],
    allowedBlockIds: ['nav', 'text', 'code', 'table', 'image', 'quote', 'footer'],
    builtin: true,
  },
  {
    id: 'faq-page',
    label: '常见问题页',
    description: '开头点题，主体是折叠问答',
    blocks: [{ type: 'hero' }, { type: 'accordion' }],
    allowedBlockIds: ['hero', 'accordion', 'text', 'cta', 'footer', 'nav', 'form'],
    builtin: true,
  },
  {
    id: 'showcase',
    label: '作品展示页',
    description: '以图集为主，适合作品集与产品截图',
    blocks: [{ type: 'nav' }, { type: 'gallery' }],
    allowedBlockIds: ['nav', 'hero', 'gallery', 'image', 'text', 'quote', 'cta', 'footer'],
    builtin: true,
  },
];

/** 内置模板。`registry` 已经装了内置 block 池 —— 模板要在这里校验 block 类型。 */
export function builtinTemplates(): readonly TemplateSpec[] {
  return BUILTIN_TEMPLATES;
}

/** 建一个装了内置模板的池子。 */
export function createTemplateRegistry(
  blocks: BlockRegistry,
  extra: readonly TemplateSpec[] = [],
): TemplateRegistry {
  return new TemplateRegistry(blocks).registerAll(BUILTIN_TEMPLATES).registerAll(extra);
}
