/**
 * 结构化中间表示：**页面是数据，不是字符串**。
 *
 * 这是整条结构化链路的地基。四层能力都建立在它之上：
 *
 * | 性质 | 支撑了什么 |
 * |---|---|
 * | 每个 block 有稳定 `id` | 可单独替换、重做、定点干预 |
 * | 每个 block 有 `type` | 结构可枚举，用户能说"把这块换成图集" |
 * | 每个 block 有 `slots` | 素材的落点，slot 有名字有类型，下游接得上 |
 * | 每个 block 有 `status` | 支持"部分完成"与断点续做 |
 *
 * **字符串形态的 HTML 做不到任何一条**：没法暂停（字符串没有中间状态）、
 * 没法定点重做（不知道哪一段对应哪一块）、没法沉淀（结构藏在文本里）。
 */
import type { BlockRegistry, BlockSpec, SlotType } from './block-spec.js';

/** 单个 block 的完成状态。 */
export type BlockStatus =
  /** 结构已定，slot 还没填。 */
  | 'pending'
  /** 已填充并渲染。 */
  | 'filled'
  /** 填充失败，需要定点重做。 */
  | 'failed'
  /** 用户或决策层决定跳过。 */
  | 'skipped';

/** slot 值的形态。与 `SlotType` 对应但不相同：把"声明"与"取值"分开。 */
export type SlotValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'image'; readonly ref: string; readonly alt: string }
  | { readonly kind: 'list-image'; readonly refs: readonly ImageRef[] };

export interface ImageRef {
  /** 沙盒内相对路径。 */
  readonly ref: string;
  readonly alt: string;
}

/** 页面上的一个 block 实例。 */
export interface BlockInstance {
  /** 稳定 id。`b1` `b2` …，由规划器按序生成，**不随增删而重编号**。 */
  readonly id: string;
  /** 指向 `BlockSpec.id`。 */
  readonly type: string;
  /** slot 名 → 取值。缺省表示尚未填充。 */
  readonly slots: Readonly<Record<string, SlotValue>>;
  readonly status: BlockStatus;
  /** 该 block 的每个 slot 由谁填充，供前端展示"这块是模型写的还是确定性拼的"。 */
  readonly sources: Readonly<Record<string, SlotSource>>;
  /** 填充失败的原因。`status === 'failed'` 时存在。 */
  readonly error?: string | undefined;
}

/** slot 的填充方式。 */
export type SlotSource =
  /** 生成层（LLM / 图像端点）。 */
  | 'generative'
  /** 确定性代码（模板、常量、派生值）。 */
  | 'deterministic'
  /** 用户直接指定。 */
  | 'user';

/** 整页的结构化表示。 */
export interface PageSpec {
  /** 项目 id，与沙盒一致。 */
  readonly projectId: string;
  /** 用户目标原文。填充器据此派生文案。 */
  readonly goal: string;
  /** 套用的模板 id；未套用为 null。 */
  readonly templateId: string | null;
  /** 本次可用的候选 block 类型（来自 block 池的用户选取结果）。 */
  readonly candidateBlockIds: readonly string[];
  /** 页面 = block 序列。顺序即版式顺序。 */
  readonly blocks: readonly BlockInstance[];
  /** 决策层给出的整体结构评分（`score` 原语）。未评估为 null。 */
  readonly qualityScore: number | null;
  /** 结构定稿时间。 */
  readonly createdAt: number;
}

export class PageSpecError extends Error {
  override readonly name = 'PageSpecError';
  constructor(
    message: string,
    readonly code: PageSpecErrorCode,
  ) {
    super(message);
  }
}

export type PageSpecErrorCode =
  /** 页面一个 block 都没有。 */
  | 'EMPTY_PAGE'
  /** block 类型不在池子里。 */
  | 'UNKNOWN_BLOCK'
  /** block id 重复。 */
  | 'DUPLICATE_BLOCK_ID'
  /** 同一非可重复 block 出现了多次。 */
  | 'NON_REPEATABLE_DUPLICATED'
  /** slot 名不在该 block 的声明里。 */
  | 'UNKNOWN_SLOT'
  /** slot 值形态与声明的类型不匹配。 */
  | 'SLOT_TYPE_MISMATCH'
  /** 列表长度超出 countRange。 */
  | 'COUNT_OUT_OF_RANGE'
  /** 必需 slot 未填。 */
  | 'MISSING_REQUIRED_SLOT'
  /** 插入 / 移动的目标位置越界。 */
  | 'INDEX_OUT_OF_RANGE';

/** 判断某种 slot 类型在取值层面对应哪种 `SlotValue.kind`。 */
export function valueKindFor(slotType: SlotType): SlotValue['kind'] {
  switch (slotType) {
    case 'list-text':
      return 'list';
    case 'image':
      return 'image';
    case 'list-image':
      return 'list-image';
    default:
      return 'text';
  }
}

/** 校验一个 slot 取值是否符合声明。 */
function validateSlotValue(
  block: BlockInstance,
  spec: BlockSpec,
  slotName: string,
  value: SlotValue,
): void {
  const declared = spec.slots.find((s) => s.name === slotName);
  if (declared === undefined) {
    throw new PageSpecError(
      `block ${block.id}(${block.type}) 出现了未声明的 slot: ${slotName}`,
      'UNKNOWN_SLOT',
    );
  }
  const expected = valueKindFor(declared.type);
  if (value.kind !== expected) {
    throw new PageSpecError(
      `block ${block.id} 的 slot ${slotName} 声明为 ${declared.type}，` +
        `取值形态应为 ${expected}，实际 ${value.kind}`,
      'SLOT_TYPE_MISMATCH',
    );
  }
  if (value.kind === 'list' && declared.countRange !== undefined) {
    const { min, max } = declared.countRange;
    if (value.items.length < min || value.items.length > max) {
      throw new PageSpecError(
        `block ${block.id} 的 slot ${slotName} 有 ${value.items.length} 项，` +
          `超出声明区间 ${min}..${max}`,
        'COUNT_OUT_OF_RANGE',
      );
    }
  }
  if (value.kind === 'list-image' && declared.countRange !== undefined) {
    const { min, max } = declared.countRange;
    if (value.refs.length < min || value.refs.length > max) {
      throw new PageSpecError(
        `block ${block.id} 的 slot ${slotName} 有 ${value.refs.length} 张图，` +
          `超出声明区间 ${min}..${max}`,
        'COUNT_OUT_OF_RANGE',
      );
    }
  }
}

/**
 * 校验结构化表示。
 *
 * 与 `validatePlan` 同一条思路：**把所有结构性问题在渲染之前一次查清**。
 * 放到渲染后查，代价是错误埋进 HTML 里，肉眼看不出来。
 *
 * `registry` 省略时只做自洽校验（id 唯一、必需 slot 齐全），
 * 不查"block 类型是否存在"。
 */
export function validatePageSpec(spec: PageSpec, registry?: BlockRegistry): void {
  if (spec.blocks.length === 0) {
    throw new PageSpecError('页面结构为空：一个 block 都没有', 'EMPTY_PAGE');
  }

  const seenIds = new Set<string>();
  const typeCounts = new Map<string, number>();

  for (const block of spec.blocks) {
    if (seenIds.has(block.id)) {
      throw new PageSpecError(`block id 重复: ${block.id}`, 'DUPLICATE_BLOCK_ID');
    }
    seenIds.add(block.id);
    typeCounts.set(block.type, (typeCounts.get(block.type) ?? 0) + 1);

    if (registry !== undefined) {
      if (!registry.has(block.type)) {
        throw new PageSpecError(`block ${block.id} 的类型未注册: ${block.type}`, 'UNKNOWN_BLOCK');
      }
      const blockSpec = registry.get(block.type);

      for (const [slotName, value] of Object.entries(block.slots)) {
        validateSlotValue(block, blockSpec, slotName, value);
      }

      // 必需 slot 只在 block 声明为 filled 时才要求齐全：
      // pending 的 block 还没填，缺 slot 是它的正常状态。
      if (block.status === 'filled') {
        for (const declared of blockSpec.slots) {
          if (declared.required && block.slots[declared.name] === undefined) {
            throw new PageSpecError(
              `block ${block.id}(${block.type}) 已标记 filled，但必需 slot ${declared.name} 缺失`,
              'MISSING_REQUIRED_SLOT',
            );
          }
        }
      }
    }
  }

  if (registry !== undefined) {
    for (const [type, count] of typeCounts) {
      if (count > 1 && !registry.get(type).repeatable) {
        throw new PageSpecError(
          `block 类型 ${type} 声明为不可重复，但页面上出现了 ${count} 次`,
          'NON_REPEATABLE_DUPLICATED',
        );
      }
    }
  }
}

/** 建一个空页面结构。块序列由规划器逐块追加。 */
export function createPageSpec(args: {
  readonly projectId: string;
  readonly goal: string;
  readonly templateId?: string | null | undefined;
  readonly candidateBlockIds: readonly string[];
  readonly createdAt?: number | undefined;
}): PageSpec {
  return {
    projectId: args.projectId,
    goal: args.goal,
    templateId: args.templateId ?? null,
    candidateBlockIds: [...args.candidateBlockIds],
    blocks: [],
    qualityScore: null,
    createdAt: args.createdAt ?? Date.now(),
  };
}

/** 追加一个待填充的 block，返回新的 PageSpec（不改原对象）。 */
export function appendBlock(spec: PageSpec, block: BlockInstance): PageSpec {
  return { ...spec, blocks: [...spec.blocks, block] };
}

/** 替换指定 id 的 block。找不到时抛错——静默忽略会让"定点重做"失效却看不出来。 */
export function replaceBlock(spec: PageSpec, blockId: string, next: BlockInstance): PageSpec {
  const index = spec.blocks.findIndex((b) => b.id === blockId);
  if (index < 0) {
    throw new PageSpecError(`找不到要替换的 block: ${blockId}`, 'UNKNOWN_BLOCK');
  }
  const blocks = [...spec.blocks];
  blocks[index] = next;
  return { ...spec, blocks };
}

// ── 位置操作 ────────────────────────────────────────────────────────────
//
// 结构既然是数据，就该能被**定点改**，而不只是"往后追加"。
// 这一组是「增删改某个 block / 调整顺序」的落点（设计稿 §6.2 的干预点），
// 也是 `normalizePageSpec` 的实现手段 —— 有真实调用方，不是储备 API。
//
// 三条共同的取舍：
//   1. **纯函数**，返回新 `PageSpec`，不改原对象（与 `appendBlock` 一致）
//   2. **越界抛错，不夹取**：夹取会让"插到第 3 位"和"插到最后"看起来一样
//   3. **找不到就抛错**：静默忽略会让定点干预失效却看不出来（理由同 `replaceBlock`）

/**
 * 在指定位置插入一个 block。
 *
 * `index` 允许等于 `blocks.length`（等价于追加），不要用 `splice` 的负索引语义——
 * "从后往前数"在这里只会让调用方算错位置。
 */
export function insertBlock(spec: PageSpec, index: number, block: BlockInstance): PageSpec {
  if (!Number.isInteger(index) || index < 0 || index > spec.blocks.length) {
    throw new PageSpecError(
      `插入位置越界: ${index}（当前 ${spec.blocks.length} 块，合法范围 0..${spec.blocks.length}）`,
      'INDEX_OUT_OF_RANGE',
    );
  }
  const blocks = [...spec.blocks];
  blocks.splice(index, 0, block);
  return { ...spec, blocks };
}

/** 删除指定 block。 */
export function removeBlock(spec: PageSpec, blockId: string): PageSpec {
  const index = spec.blocks.findIndex((b) => b.id === blockId);
  if (index < 0) {
    throw new PageSpecError(`找不到要删除的 block: ${blockId}`, 'UNKNOWN_BLOCK');
  }
  const blocks = [...spec.blocks];
  blocks.splice(index, 1);
  return { ...spec, blocks };
}

/**
 * 把某个 block 移到指定位置（`toIndex` 是**移动完成后**它所在的下标）。
 *
 * 位置不变时返回原对象：调用方常用它做"归位"判断，
 * 没变就不该产生一次无意义的复制（也便于上方用 `===` 判断有没有动过）。
 */
export function moveBlock(spec: PageSpec, blockId: string, toIndex: number): PageSpec {
  const from = spec.blocks.findIndex((b) => b.id === blockId);
  if (from < 0) {
    throw new PageSpecError(`找不到要移动的 block: ${blockId}`, 'UNKNOWN_BLOCK');
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= spec.blocks.length) {
    throw new PageSpecError(
      `移动目标位置越界: ${toIndex}（合法范围 0..${spec.blocks.length - 1}）`,
      'INDEX_OUT_OF_RANGE',
    );
  }
  if (from === toIndex) return spec;
  const blocks = [...spec.blocks];
  const moved = blocks.splice(from, 1)[0]!;
  blocks.splice(toIndex, 0, moved);
  return { ...spec, blocks };
}

/** 一次版式修正的记录。规范化不静默——改了什么必须能被读出来。 */
export interface StructureFix {
  readonly kind: 'moved' | 'removed';
  readonly blockId: string;
  readonly detail: string;
}

/**
 * 版式规范化：把**定义在两端**的块挪回该在的位置，并去掉重复的非可重复块。
 *
 * ## 为什么需要它（这不是洁癖，是真实缺陷的补丁）
 *
 * `canLead` 只能挡住"第一块放 footer"，**挡不住"第二块放 footer"**。
 * 于是模型完全排得出：
 *
 * ```
 * hero → footer → features      页脚后面还有正文，页面是错的
 * hero → features → nav → cta   导航栏跑到了页面中段
 * ```
 *
 * 每一块单独看都合法：类型在池子里、slot 齐全、不可重复的没重复。
 * `validatePageSpec` 查的是**自洽性**，查不出"顺序不合语义"——那是版式事实，
 * 不在结构校验的职责里。所以需要这一道。
 *
 * ## 为什么是"规范化"而不是"候选过滤"
 *
 * 过滤只能管住规划器自己排出来的结构。**模板给的起手结构、用户的手工编辑、
 * 将来 P7 的暂停指导，都会绕过规划器**——它们同样必须被兜住。
 * 规范化放在定稿之后，所有这些入口都经过它。
 *
 * ## 边界
 *
 * - **只动两端**：中间顺序是决策模型的判断，规范化不碰
 * - 未知类型跳过（交给 `validatePageSpec` 报错，不在这里抢着报）
 * - 非可重复块重复时**保留第一个**：第一次出现更可能是模型的本意，
 *   后面的更可能是它忘了自己放过
 */
export function normalizePageSpec(
  spec: PageSpec,
  registry: BlockRegistry,
): { readonly page: PageSpec; readonly fixes: readonly StructureFix[] } {
  const fixes: StructureFix[] = [];
  let page = spec;

  // ── 1. 非可重复块去重（保留第一个） ──────────────────────────────────
  const seen = new Set<string>();
  for (const block of [...page.blocks]) {
    if (!registry.has(block.type)) continue;
    if (registry.get(block.type).repeatable) continue;
    if (!seen.has(block.type)) {
      seen.add(block.type);
      continue;
    }
    page = removeBlock(page, block.id);
    fixes.push({
      kind: 'removed',
      blockId: block.id,
      detail: `${block.type} 声明为不可重复，重复出现，已删除后一个`,
    });
  }

  // ── 2. 位置约束 ──────────────────────────────────────────────────────
  // 先归位 `placement: 'first'` 的，再归位 `'last'` 的。
  // 顺序有意义：两者可能同时存在，先定头再定尾，结果与直觉一致。
  for (const placement of ['first', 'last'] as const) {
    for (const spec_ of registry.specs()) {
      if (spec_.placement !== placement) continue;
      const index = page.blocks.findIndex((b) => b.type === spec_.id);
      if (index < 0) continue;
      const target = placement === 'first' ? 0 : page.blocks.length - 1;
      if (index === target) continue;
      const before = index;
      page = moveBlock(page, page.blocks[index]!.id, target);
      fixes.push({
        kind: 'moved',
        blockId: page.blocks[target]!.id,
        detail:
          `${spec_.id} 声明了 placement='${placement}'，` +
          `从第 ${before + 1} 位移到第 ${target + 1} 位`,
      });
    }
  }

  return { page, fixes };
}

/** 结构摘要，用于日志、事件与决策层的 evidence。保持简短。 */
export function describePageSpec(spec: PageSpec): string {
  if (spec.blocks.length === 0) return '（空页面）';
  return spec.blocks
    .map((b, i) => {
      const slotNames = Object.keys(b.slots).join(',');
      return `${i + 1}. ${b.type}#${b.id}[${b.status}]${slotNames === '' ? '' : `{${slotNames}}`}`;
    })
    .join(' → ');
}

/** 结构里出现过的 block 类型，按首次出现顺序去重。 */
export function blockTypesOf(spec: PageSpec): string[] {
  const out: string[] = [];
  for (const block of spec.blocks) {
    if (!out.includes(block.type)) out.push(block.type);
  }
  return out;
}

/** 逐块决策过程中，下一个 block 的序号（用于生成稳定 id）。 */
export function nextBlockId(spec: PageSpec): string {
  let max = 0;
  for (const block of spec.blocks) {
    const match = /^b(\d+)$/.exec(block.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `b${max + 1}`;
}
