/**
 * 把 HTTP 输入解析成**结构编辑**。
 *
 * ## 为什么要单独一层
 *
 * 与 `block-input.ts` 同一条理由：请求体是**外部输入**。`body as PageSpec` 等于
 * 把校验交给运气——一个 slot 形态写错的块会带着非法值进结构，然后在填充器里
 * 变成一个看不懂的取值、或者在第 200 次运行时才炸。这里只做**结构与类型**这一层，
 * 语义校验（类型在不在池子里、必需 slot 齐不齐、能不能重复）交给
 * `validatePageSpec`，避免两处各写一半、将来改一处漏一处。
 *
 * ## 两条入口，别混用
 *
 *   - `parsePageSpecInput` —— **整份结构**，用于"带指定 PageSpec 重跑"。
 *     只有持有完整结构（含 slot 内容）的调用方用得上。
 *   - `parseStructureOps` / `applyStructureOps` —— **增量编辑**，用于
 *     `POST /api/runs/:runId/structure/ops`。前端从 REST 拿到的是压缩视图
 *     （块只有 id/type/status/slotNames，没有内容），它能表达的就是"增删移"，
 *     所以编辑走 op、不走整份覆盖：覆盖式会绕过增删移的语义校验，
 *     也会把前端没看见的内容一并抹掉。
 */
import {
  PageSpecError,
  appendBlock,
  insertBlock,
  moveBlock,
  nextBlockId,
  normalizePageSpec,
  removeBlock,
  replaceBlock,
  validatePageSpec,
  type BlockInstance,
  type BlockRegistry,
  type BlockStatus,
  type PageSpec,
  type SlotFillPlan,
  type SlotSource,
  type SlotValue,
  type StructureFix,
} from '@mediasandbox/orchestrator';

export class StructureInputError extends Error {
  override readonly name = 'StructureInputError';
}

const STATUSES: readonly BlockStatus[] = ['pending', 'filled', 'failed', 'skipped'];
const PLANS: readonly SlotFillPlan[] = ['generative', 'deterministic'];
/** block id 的合法形态：进 HTML 属性、进 JSON、进文件名，字符集必须收住。 */
const BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(message: string): never {
  throw new StructureInputError(message);
}

function readObject(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${where} 必须是对象`);
  }
  return raw as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} 的 ${key} 必须是非空字符串`);
  }
  return value;
}

function readIndex(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${where} 的 ${key} 必须是非负整数`);
  }
  return value;
}

// ── slot 取值 ───────────────────────────────────────────────────────────

/** 解析一个 slot 取值。形态必须与 `SlotValue` 完全一致，否则填充器会拿到看不懂的东西。 */
function parseSlotValue(raw: unknown, where: string): SlotValue {
  const value = readObject(raw, where);
  const kind = readString(value, 'kind', where);
  if (kind === 'text') {
    return { kind: 'text', text: readString(value, 'text', where) };
  }
  if (kind === 'list') {
    const items = value['items'];
    if (!Array.isArray(items)) fail(`${where} 的 items 必须是数组`);
    return {
      kind: 'list',
      items: items.map((item, i) => {
        if (typeof item !== 'string') fail(`${where}.items[${i}] 必须是字符串`);
        return item;
      }),
    };
  }
  if (kind === 'image') {
    return { kind: 'image', ref: readString(value, 'ref', where), alt: readString(value, 'alt', where) };
  }
  if (kind === 'list-image') {
    const refs = value['refs'];
    if (!Array.isArray(refs)) fail(`${where} 的 refs 必须是数组`);
    return {
      kind: 'list-image',
      refs: refs.map((item, i) => {
        const image = readObject(item, `${where}.refs[${i}]`);
        return {
          ref: readString(image, 'ref', `${where}.refs[${i}]`),
          alt: readString(image, 'alt', `${where}.refs[${i}]`),
        };
      }),
    };
  }
  fail(`${where} 的 kind 非法: ${kind}（可用: text, list, image, list-image）`);
}

type Slots = Readonly<Record<string, SlotValue>>;

function parseSlots(raw: unknown, where: string): Slots {
  const source = readObject(raw, where);
  const slots: Record<string, SlotValue> = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.trim() === '') fail(`${where} 出现了空 slot 名`);
    slots[name] = parseSlotValue(value, `${where}.${name}`);
  }
  return slots;
}

/**
 * 解析一份块的**局部描述**（op 用它）。
 *
 * `type` 与 `slots` 都可省：`replace` 是局部更新（只改给出的字段），
 * 省掉的字段由调用方从原块继承。
 */
function parseBlockPatch(raw: unknown, where: string): {
  type?: string;
  slots?: Slots;
  status?: BlockStatus;
} {
  const patch = readObject(raw, where);
  const result: { type?: string; slots?: Slots; status?: BlockStatus } = {};

  if (patch['type'] !== undefined) result.type = readString(patch, 'type', where);
  if (patch['slots'] !== undefined) result.slots = parseSlots(patch['slots'], `${where}.slots`);
  if (patch['status'] !== undefined) {
    const status = readString(patch, 'status', where);
    if (!STATUSES.includes(status as BlockStatus)) {
      fail(`${where} 的 status 非法: ${status}（可用: ${STATUSES.join(', ')}）`);
    }
    result.status = status as BlockStatus;
  }
  return result;
}

/** 用户直接给的 slot 值，来源就是 `user`——这个枚举值本来就是为它准备的。 */
function sourcesOf(slots: Slots): Readonly<Record<string, SlotSource>> {
  const sources: Record<string, SlotSource> = {};
  for (const name of Object.keys(slots)) sources[name] = 'user';
  return sources;
}

/**
 * `slotPlans` 也要收窄：它是**计划**（这一 slot 由生成式还是确定性实现），
 * 填充器按它决定要不要调生成层。放一个看不懂的值进去，填充器会静默按默认行为填——
 * "计划与结果不一致"却看不出来。
 */
function parseSlotPlans(raw: unknown, where: string): Readonly<Record<string, SlotFillPlan>> {
  const source = readObject(raw, where);
  const plans: Record<string, SlotFillPlan> = {};
  for (const [name, plan] of Object.entries(source)) {
    if (typeof plan !== 'string' || !PLANS.includes(plan as SlotFillPlan)) {
      fail(`${where}.${name} 取值非法: ${String(plan)}（可用: ${PLANS.join(', ')}）`);
    }
    plans[name] = plan as SlotFillPlan;
  }
  return plans;
}

// ── 入口 1：整份结构（带指定 PageSpec 重跑） ─────────────────────────────

export interface StructureInput {
  readonly blocks: readonly BlockInstance[];
  readonly templateId: string | null;
  readonly qualityScore: number | null;
}

/**
 * 解析请求体里的 `pageSpec`。
 *
 * **只收块序列与少量留痕**：`projectId` / `goal` / `candidateBlockIds` 由本次运行
 * 决定，不从请求体里读——让外部输入指定"这次跑在哪个项目、填什么目标"，
 * 等于把一次运行的身份交出去。`candidateBlockIds` 由实际用到的块类型派生。
 *
 * ## `status` 的含义要说清
 *
 * 缺省是 `pending`：**只想按这个结构重跑**（内容由本次填充生成）就是它。
 * 标 `filled` 等于声明"内容在我手里"，那就必须带齐该块的必需 slot——
 * 只给结构不给内容会被 `validatePageSpec` 拦下，错误信息会指出缺哪个 slot。
 */
export function parsePageSpecInput(raw: unknown): StructureInput {
  const body = readObject(raw, 'pageSpec');

  const rawBlocks = body['blocks'];
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
    fail('pageSpec 的 blocks 必须是非空数组');
  }

  const seen = new Set<string>();
  const blocks = rawBlocks.map((item, i) => {
    const where = `pageSpec.blocks[${i}]`;
    const source = readObject(item, where);
    const id = readString(source, 'id', where);
    if (!BLOCK_ID.test(id)) fail(`${where} 的 id 形态非法: ${id}`);
    if (seen.has(id)) fail(`pageSpec 里 block id 重复: ${id}`);
    seen.add(id);

    const type = readString(source, 'type', where);
    const slots = source['slots'] === undefined ? {} : parseSlots(source['slots'], `${where}.slots`);

    const statusRaw = source['status'];
    let status: BlockStatus = 'pending';
    if (statusRaw !== undefined) {
      if (typeof statusRaw !== 'string' || !STATUSES.includes(statusRaw as BlockStatus)) {
        fail(`${where} 的 status 非法: ${String(statusRaw)}（可用: ${STATUSES.join(', ')}）`);
      }
      status = statusRaw as BlockStatus;
    }

    const block: BlockInstance = {
      id,
      type,
      slots,
      status,
      // 请求体里带了内容，就如实标成"用户给的"：来源是留痕，不该由外部随口指定。
      sources: sourcesOf(slots),
      ...(source['slotPlans'] !== undefined
        ? { slotPlans: parseSlotPlans(source['slotPlans'], `${where}.slotPlans`) }
        : {}),
      ...(source['error'] !== undefined ? { error: readString(source, 'error', where) } : {}),
    };
    return block;
  });

  const templateIdRaw = body['templateId'];
  if (templateIdRaw !== undefined && templateIdRaw !== null && typeof templateIdRaw !== 'string') {
    fail('pageSpec 的 templateId 必须是字符串或 null');
  }

  const qualityRaw = body['qualityScore'];
  if (qualityRaw !== undefined && qualityRaw !== null && typeof qualityRaw !== 'number') {
    fail('pageSpec 的 qualityScore 必须是数字或 null');
  }

  return {
    blocks,
    templateId: typeof templateIdRaw === 'string' ? templateIdRaw : null,
    qualityScore: typeof qualityRaw === 'number' ? qualityRaw : null,
  };
}

/**
 * 语义预检：拿池子把"类型未注册 / filled 却缺必需 slot / 不可重复的重复出现"
 * 在 **HTTP 边界上**就拦下来。
 *
 * 用的是**编排层同一个** `validatePageSpec`，只是把调用时机提前——不是另写一套规则。
 * 不提前的话，一个不合规的结构会被收下：先回 202，再跑成 failed，
 * 调用方要等一轮运行才知道自己写错了字段。
 */
export function validateStructureInput(
  input: StructureInput,
  goal: string,
  registry: BlockRegistry,
): void {
  validatePageSpec(
    {
      // 这三项校验不看（它只读 blocks），但 PageSpec 的形态要完整。
      projectId: '(pending)',
      goal,
      templateId: input.templateId,
      candidateBlockIds: [],
      blocks: input.blocks,
      qualityScore: input.qualityScore,
      createdAt: 0,
    },
    registry,
  );
}

// ── 入口 3：定点重做 ────────────────────────────────────────────────────

/**
 * 拼出「定点重做」要用的结构：**目标块清空，其余块带上现成内容**。
 *
 * ## 为什么要在这里拼，而不是让前端传整份结构
 *
 * 块的现成内容躺在沙盒的 `src/blocks/<id>.json` 里（那是 `fill-block` 的落点），
 * 而前端手里只有压缩视图（块只有 id/type/status）。让前端把内容传回来，
 * 就得先把内容发下去再发上来——多一圈，还多一个"传回来的和沙盒里的不一样"的坑。
 *
 * ## 为什么要给其余块标上 `deterministic`
 *
 * 填充器的生成式那一遍**不看内容是否已经存在**（见 `applyGenerated`），
 * 只要这一趟带生成层、slot 没说"确定性"，它就会重写一遍。
 * 于是"重做一块"会变成"整页重新生成一遍"——既花钱，又把没点名的块改坏。
 * 标成 `deterministic` 就是把这个意图写进数据：**这几块这趟不花钱**。
 */
export function buildRedoStructureInput(args: {
  readonly structure: { readonly page: PageSpec };
  readonly blocks: ReadonlyMap<string, BlockInstance>;
  readonly targetIds: readonly string[];
}): StructureInput {
  const targets = new Set(args.targetIds);
  const blocks = args.structure.page.blocks.map((block) => {
    if (targets.has(block.id)) {
      // 内容与状态一起清掉：这一趟就是要重新填它。
      return { id: block.id, type: block.type, slots: {}, status: 'pending' as const, sources: {} };
    }

    const saved = args.blocks.get(block.id);
    if (saved === undefined) {
      // 内容没落盘（上次填充失败、或被跳过）：它本来就没东西可留，
      // 顺手在这一趟补上，而不是把"空"当成"要保留的内容"。
      return { ...block, slots: {}, status: 'pending' as const, sources: {} };
    }

    const slotNames = Object.keys(saved.slots);
    const plans: Record<string, SlotFillPlan> = {};
    for (const name of slotNames) plans[name] = 'deterministic';

    return {
      ...block,
      slots: saved.slots,
      status: 'filled' as const,
      sources: saved.sources,
      ...(slotNames.length > 0 ? { slotPlans: plans } : {}),
    };
  });

  return {
    blocks,
    templateId: args.structure.page.templateId,
    qualityScore: args.structure.page.qualityScore,
  };
}

/**
 * 校验"要重做哪些块"。
 *
 * 空列表直接拒：**"重做零块"没有意义**，而静默跑一次全量填充是更坏的结果
 * （用户以为只重做一块，实际整页重来）。
 */
export function parseRedoBlockIds(raw: unknown, page: PageSpec): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('blockIds 必须是非空数组：不指定要重做哪一块，"定点重做"就没有意义');
  }
  const known = new Set(page.blocks.map((b) => b.id));
  const ids: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`blockIds[${index}] 必须是非空字符串`);
    }
    if (!known.has(item)) {
      fail(
        `blockIds[${index}] 指向的区块不存在: ${item}` +
          `（这次运行的区块：${[...known].join('、')}）`,
      );
    }
    ids.push(item);
  }
  return ids;
}

// ── 入口 2：增量编辑 ────────────────────────────────────────────────────

export type StructureOp =
  | { readonly op: 'append'; readonly type: string; readonly slots: Slots; readonly status: BlockStatus }
  | {
      readonly op: 'insert';
      readonly index: number;
      readonly type: string;
      readonly slots: Slots;
      readonly status: BlockStatus;
    }
  | { readonly op: 'remove'; readonly blockId: string }
  | { readonly op: 'move'; readonly blockId: string; readonly toIndex: number }
  | {
      readonly op: 'replace';
      readonly blockId: string;
      readonly patch: { type?: string; slots?: Slots; status?: BlockStatus };
    };

/** 解析 `ops` 数组。整批**要么全收要么全拒**：半批生效会让调用方对不上账。 */
export function parseStructureOps(raw: unknown): readonly StructureOp[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('ops 必须是非空数组');
  }
  return raw.map((item, i) => {
    const where = `ops[${i}]`;
    const source = readObject(item, where);
    const op = readString(source, 'op', where);

    if (op === 'append' || op === 'insert') {
      const patch = parseBlockPatch(source, where);
      // 新增块必须说明是什么类型；slots 可省（新块默认待填充）。
      const type = patch.type;
      if (type === undefined) fail(`${where} 缺少 type`);
      const slots = patch.slots ?? {};
      const status = patch.status ?? 'pending';
      if (op === 'append') return { op, type, slots, status };
      return { op, index: readIndex(source, 'index', where), type, slots, status };
    }

    if (op === 'remove' || op === 'move' || op === 'replace') {
      const blockId = readString(source, 'blockId', where);
      if (op === 'remove') return { op, blockId };
      if (op === 'move') return { op, blockId, toIndex: readIndex(source, 'toIndex', where) };
      return { op, blockId, patch: parseBlockPatch(source, where) };
    }

    fail(`${where} 的 op 非法: ${op}（可用: append, insert, remove, move, replace）`);
  });
}

/** 由 op 造一个新块：id 由服务端发（`nextBlockId` 只增不减，删块后不复用）。 */
function newBlock(page: PageSpec, type: string, slots: Slots, status: BlockStatus): BlockInstance {
  return {
    id: nextBlockId(page),
    type,
    slots,
    status,
    sources: sourcesOf(slots),
  };
}

/**
 * 逐条应用编辑，返回新的页面。
 *
 * ## 原子性
 *
 * 全程在**局部变量**上做，只有全部成功才由调用方落库。中间任何一条失败
 * （越界、找不到块、类型未注册、slot 形态不符）都整批不生效——半批生效会让
 * 用户看到的页面与自己的操作对不上，且无从复原。
 *
 * ## 校验与规范化照旧
 *
 * 编辑完仍走 `validatePageSpec`（类型在池子里、slot 形态对得上、不可重复的没重复）
 * 与 `normalizePageSpec`（两端块归位）。用户手工编辑最需要这道兜底：
 * `canLead` 只能挡住"第一块放 footer"，挡不住"第二块放 footer"。
 */
export function applyStructureOps(
  page: PageSpec,
  ops: readonly StructureOp[],
  registry: BlockRegistry,
): { readonly page: PageSpec; readonly fixes: readonly StructureFix[] } {
  let next = page;

  for (const op of ops) {
    switch (op.op) {
      case 'append':
        next = appendBlock(next, newBlock(next, op.type, op.slots, op.status));
        break;
      case 'insert':
        next = insertBlock(next, op.index, newBlock(next, op.type, op.slots, op.status));
        break;
      case 'remove':
        next = removeBlock(next, op.blockId);
        break;
      case 'move':
        next = moveBlock(next, op.blockId, op.toIndex);
        break;
      case 'replace': {
        const current = next.blocks.find((b) => b.id === op.blockId);
        if (current === undefined) {
          throw new PageSpecError(`找不到要修改的 block: ${op.blockId}`, 'UNKNOWN_BLOCK');
        }
        // **局部更新**：只改给出的字段。整块覆盖会把前端没看见的 slot 内容一并抹掉。
        const slots = { ...current.slots, ...(op.patch.slots ?? {}) };
        const merged: BlockInstance = {
          ...current,
          ...(op.patch.type !== undefined ? { type: op.patch.type } : {}),
          slots,
          status: op.patch.status ?? current.status,
          // 新给的 slot 归"用户"，其余保留原来源——来源是留痕，不能被一次编辑洗白。
          sources: { ...current.sources, ...sourcesOf(op.patch.slots ?? {}) },
        };
        next = replaceBlock(next, op.blockId, merged);
        break;
      }
    }
  }

  // **留痕形态**：记录里的结构只带 status 与 sources，内容在产物与
  // `src/blocks/<id>.json` 里，所以"filled 但一个 slot 都没有"是正常形态。
  // 用默认规则（要求 filled 的块 slot 齐全）去校验它，每次编辑都会被判非法。
  validatePageSpec(next, registry, { requireSlots: false });
  return normalizePageSpec(next, registry);
}
