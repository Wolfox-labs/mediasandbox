/**
 * 把 HTTP 请求体解析成 `BlockSpec`。
 *
 * ## 为什么要单独一层，而不是 `body as BlockSpec`
 *
 * 请求体是**外部输入**。直接断言类型等于把校验交给运气：一个字段名写错的
 * block 会带着 `undefined` 混进池子，然后在决策层候选集里变成一个没有名字的
 * 选项、或者在第 200 次运行时才炸。
 *
 * `BlockRegistry.register` 里已经有语义校验（id 格式、slot 名、countRange 与
 * 列表型是否匹配……），这里只做**结构与类型**这一层：把 `unknown` 收窄成
 * `BlockSpec`，错误信息说清是哪个字段。两层合起来才是完整的入口校验。
 *
 * ## 与"模型提议"共用同一条路
 *
 * 设计稿 §2.2 说外部来源有四类，其中模型提议也要"经注册与校验后入池"。
 * 那条路径将来会复用这里的校验——**提议 ≠ 决定**，而决定的前提是它先是个合法声明。
 */
import type { BlockGroup, BlockPlacement, BlockSpec, SlotSpec, SlotType } from '@mediasandbox/orchestrator';

export class BlockInputError extends Error {
  override readonly name = 'BlockInputError';
}

const SLOT_TYPES: readonly SlotType[] = [
  'text',
  'title',
  'image',
  'code',
  'link',
  'literal',
  'list-text',
  'list-image',
];
const GROUPS: readonly BlockGroup[] = ['skeleton', 'content', 'interactive'];
const COST_HINTS = ['fast', 'medium', 'slow'] as const;
const PLACEMENTS: readonly BlockPlacement[] = ['any', 'first', 'last'];

function fail(message: string): never {
  throw new BlockInputError(message);
}

function readString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where} 的 ${key} 必须是非空字符串`);
  }
  return value;
}

function readBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') fail(`${where} 的 ${key} 必须是布尔值`);
  return value;
}

function readObject(raw: unknown, where: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${where} 必须是对象`);
  }
  return raw as Record<string, unknown>;
}

function parseSlot(raw: unknown, index: number): SlotSpec {
  const where = `slots[${index}]`;
  const slot = readObject(raw, where);
  const name = readString(slot, 'name', where);
  const typeRaw = readString(slot, 'type', where);
  if (!SLOT_TYPES.includes(typeRaw as SlotType)) {
    fail(`${where} 的 type 非法: ${typeRaw}（可用: ${SLOT_TYPES.join(', ')}）`);
  }
  const description = readString(slot, 'description', where);
  const required = slot['required'] === undefined ? true : readBoolean(slot, 'required', where);

  const rangeRaw = slot['countRange'];
  if (rangeRaw === undefined) {
    return { name, type: typeRaw as SlotType, required, description };
  }
  const range = readObject(rangeRaw, `${where}.countRange`);
  const min = range['min'];
  const max = range['max'];
  if (typeof min !== 'number' || typeof max !== 'number') {
    fail(`${where}.countRange 的 min 与 max 必须是数字`);
  }
  return { name, type: typeRaw as SlotType, required, description, countRange: { min, max } };
}

/**
 * 解析一个 block 声明。
 *
 * **只接受"外部来源"该有的样子**：`id` 重复由注册表拒绝，
 * 列表型 slot 缺 `countRange` 由注册表拒绝——这里不重复实现那套规则，
 * 只在类型层面收窄，避免两处校验各写一半、将来改一处漏一处。
 */
export function parseBlockSpec(raw: unknown): BlockSpec {
  const body = readObject(raw, 'block 声明');

  const id = readString(body, 'id', 'block 声明');
  const label = readString(body, 'label', 'block 声明');
  const description = readString(body, 'description', 'block 声明');

  const groupRaw = readString(body, 'group', 'block 声明');
  if (!GROUPS.includes(groupRaw as BlockGroup)) {
    fail(`block 声明的 group 非法: ${groupRaw}（可用: ${GROUPS.join(', ')}）`);
  }

  const slotsRaw = body['slots'];
  if (!Array.isArray(slotsRaw) || slotsRaw.length === 0) {
    fail('block 声明的 slots 必须是非空数组');
  }

  const costRaw = body['costHint'] ?? 'fast';
  if (typeof costRaw !== 'string' || !COST_HINTS.includes(costRaw as (typeof COST_HINTS)[number])) {
    fail(`block 声明的 costHint 非法: ${String(costRaw)}（可用: ${COST_HINTS.join(', ')}）`);
  }

  const placementRaw = body['placement'];
  if (placementRaw !== undefined) {
    if (
      typeof placementRaw !== 'string' ||
      !PLACEMENTS.includes(placementRaw as BlockPlacement)
    ) {
      fail(`block 声明的 placement 非法: ${String(placementRaw)}（可用: ${PLACEMENTS.join(', ')}）`);
    }
  }

  return {
    id,
    label,
    description,
    group: groupRaw as BlockGroup,
    slots: slotsRaw.map(parseSlot),
    canLead: readBoolean(body, 'canLead', 'block 声明'),
    repeatable: readBoolean(body, 'repeatable', 'block 声明'),
    ...(placementRaw !== undefined ? { placement: placementRaw as BlockPlacement } : {}),
    costHint: costRaw as (typeof COST_HINTS)[number],
  };
}
