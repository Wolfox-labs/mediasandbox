/**
 * 一次执笔（网页）：让大模型**一口气写完整页**所有可写 slot。
 *
 * ## 为什么要页面级执笔
 *
 * 网页此前是"逐 slot 生成"：一个 hero 的 eyebrow、title、lede、两个按钮
 * 是四五次独立调用。模型看不到邻居，于是标题和导语各说各的；
 * 一页 5~6 块就是 11 次调用、两波并发，光填充就一分钟。
 *
 * 这里把它还原成一次写作：读目标、读统筹计划、读已经定稿的块序与每块要几项，
 * 一次写出整页文案。填充器（`filler.ts`）本来就有 `written` 通道，
 * 只是网页链路一直没用上——演示文稿早就用上了。
 *
 * ## 分工不变
 *
 * | 谁 | 干什么 |
 * |---|---|
 * | 大模型（本模块） | 写内容：一次写完整页文案 |
 * | 决策模型 | 只从候选里挑：块序、版式、每块要几项、图片从哪来 |
 * | 渲染器 | 确定性代码：把文案放进选中的版式 |
 *
 * 本模块**不决定**任何结构：块数、块序、slot 名都来自上游 `PageSpec`。
 *
 * ## 失败不静默，也不打挂整次运行
 *
 * 拿不到合法结果就返回 `{ ok:false, detail }`，由调用方回落到逐 slot 生成，
 * 并如实记下原因。**不编假文案。**
 */
import type { LlmClient, LlmResponse } from '../llm/types.js';
import type { BlockInstance } from './page-spec.js';
import type { BlockSpec, SlotSpec } from './block-spec.js';

/** 一个块的写作计划。 */
export interface PageWriteBlockPlan {
  readonly index: number;
  readonly block: BlockInstance;
  readonly spec: BlockSpec;
  /** 列表型 slot 的项数（来自规划器问出来的数量）。 */
  readonly counts: Readonly<Record<string, number>>;
}

export interface PageWriteRequest {
  readonly llm: LlmClient;
  readonly goal: string;
  readonly brand?: string | undefined;
  readonly blocks: readonly PageWriteBlockPlan[];
  /** 统筹计划的文本摘要（如果有）。让执笔知道整页打算怎么讲。 */
  readonly planText?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 一个 slot 的原始文案：文本型是字符串，列表型是字符串数组。 */
export type WrittenSlotText = string | readonly string[];

export interface WrittenBlock {
  readonly id: string;
  readonly index: number;
  /** slot 名 → 文案。只包含该版式声明过、且可写的 slot。 */
  readonly slots: Readonly<Record<string, WrittenSlotText>>;
}

export interface WrittenPage {
  readonly blocks: readonly WrittenBlock[];
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: LlmResponse['usage'];
  readonly finishReason: LlmResponse['finishReason'];
  readonly raw: string;
}

export type PageWriteOutcome =
  | { readonly ok: true; readonly page: WrittenPage }
  | { readonly ok: false; readonly detail: string };

/** 默认超时：整页 6~7 块、每块 4~5 个 slot，一次写完。 */
export const DEFAULT_PAGE_WRITE_TIMEOUT_MS = 120_000;

/**
 * 可以被执笔的 slot 类型。
 *
 * 图片不在此列：生图逐张计费，必须由显式开关控制；
 * `link` / `literal` 是确定性常量，也不让模型编。
 */
export const WRITABLE_SLOT_TYPES: ReadonlySet<SlotSpec['type']> = new Set<SlotSpec['type']>([
  'text',
  'title',
  'code',
  'list-text',
]);

function formatSlot(slot: SlotSpec, count: number | undefined): string {
  const required = slot.required ? '必填' : '可选';
  if (slot.type === 'list-text') {
    const range = slot.countRange;
    const amount =
      count !== undefined && count > 0
        ? `${count} 项${range !== undefined ? `（可用 ${range.min}~${range.max}）` : ''}`
        : range !== undefined
          ? `${range.min}~${range.max} 项`
          : '1 项';
    return `- ${slot.name}（${required}，字符串数组，${amount}）：${slot.description}`;
  }
  const label = slot.type === 'title' ? '标题' : slot.type === 'code' ? '代码' : '文本';
  return `- ${slot.name}（${required}，${label}）：${slot.description}`;
}

function buildMessages(request: PageWriteRequest): { system: string; user: string } {
  const system = [
    '你是一个中文网页的执笔。你只写内容，不决定块序、版式或视觉样式——这些已经由决策层定好。',
    '',
    '规则：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。',
    '2. blocks 数组的长度必须等于给定块数，顺序必须与给定块序一致；每项形如 {"id":"...","slots":{...}}。',
    '3. 每块只写该块列出的 slot 名，不要自创 slot，不要把块类型名或序号写进文案。',
    '4. 列表型给字符串数组，条数必须落在给定区间；同一块内的条目句式要一致。',
    '5. 整页要像同一个人一口气写完：相邻块之间有承接，不要每块都从头介绍背景。',
    '6. 具体、可读，不写“本页”“我们将”“通过数据洞察”这类空话；标题不超过 18 字，条目每条不超过 30 字。',
    '7. 不要编造没有依据的具体数字；需要数据时沿用目标里给出的，或改用定性表述。',
    '8. 禁止套话：打造/赋能/引领/震撼/焕新/开启新篇章/让我们一起。',
  ].join('\n');

  const parts: string[] = [`页面目标：${request.goal}`];
  if (request.brand !== undefined && request.brand.trim() !== '') {
    parts.push(`站点名：${request.brand.trim()}`);
  }
  if (request.planText !== undefined && request.planText.trim() !== '') {
    parts.push(`整体计划：\n${request.planText.trim()}`);
  }
  if (request.constraints !== undefined && request.constraints.length > 0) {
    parts.push(`硬约束：\n${request.constraints.map((c) => `- ${c}`).join('\n')}`);
  }

  const lines: string[] = [`块序与版式（共 ${request.blocks.length} 块；必须按这个顺序写）：`];
  for (const plan of request.blocks) {
    lines.push(`第 ${plan.index + 1} 块 [id=${plan.block.id} / ${plan.spec.id} / ${plan.spec.label}]`);
    for (const slot of plan.spec.slots) {
      if (!WRITABLE_SLOT_TYPES.has(slot.type)) continue;
      lines.push(`  ${formatSlot(slot, plan.counts[slot.name])}`);
    }
    const skipped = plan.spec.slots.filter((slot) => !WRITABLE_SLOT_TYPES.has(slot.type));
    if (skipped.length > 0) {
      lines.push(`  （${skipped.map((slot) => slot.name).join('、')} 由系统自动填充，不要写）`);
    }
  }
  parts.push(lines.join('\n'));
  parts.push(
    '输出 JSON 形状：\n' +
      '{"blocks":[{"id":"hero","slots":{"title":"...","lede":"..."}},' +
      '{"id":"features","slots":{"heading":"...","items":["...","..."]}}]}',
  );

  return { system, user: parts.join('\n\n') };
}

/**
 * 跑一次执笔。
 *
 * **不抛错**：失败时返回 `{ ok:false }`，由调用方回落到逐 slot 生成。
 * 唯一例外是调用方已中止（`AbortError`）——那属于上层取消逻辑。
 */
export async function writePage(request: PageWriteRequest): Promise<PageWriteOutcome> {
  const plans = request.blocks.filter(
    (plan) => plan.spec.slots.some((slot) => WRITABLE_SLOT_TYPES.has(slot.type)),
  );
  if (plans.length === 0) {
    return { ok: false, detail: '没有可写的 slot' };
  }

  const { system, user } = buildMessages({ ...request, blocks: plans });
  const timeoutMs =
    request.timeoutMs !== undefined && request.timeoutMs > 0
      ? request.timeoutMs
      : DEFAULT_PAGE_WRITE_TIMEOUT_MS;
  const signals: AbortSignal[] = [];
  if (request.signal !== undefined) signals.push(request.signal);
  signals.push(AbortSignal.timeout(timeoutMs));
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let response: LlmResponse;
  try {
    response = await request.llm.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      responseFormat: 'json',
      temperature: 0.7,
      // 每块大约 200~350 token；留出 JSON 结构余量。
      maxTokens: Math.min(8192, Math.max(1200, plans.length * 420)),
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted === true) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: signal.aborted
        ? `执笔模型在 ${Math.round(timeoutMs / 1000)} 秒内没有返回：${detail}`
        : `执笔模型调用失败：${detail}`,
    };
  }

  const raw = response.text ?? '';
  if (raw.trim() === '') return { ok: false, detail: '执笔模型返回空内容' };

  const parsed = parseWrittenBlocks(raw, plans);
  if (parsed.written === 0) {
    const truncated = response.finishReason === 'length' ? '（输出被截断）' : '';
    return {
      ok: false,
      detail: `执笔模型返回的内容里读不出任何一块文案${truncated}（原文 ${raw.length} 字）`,
    };
  }

  return {
    ok: true,
    page: {
      blocks: parsed.blocks,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage,
      finishReason: response.finishReason,
      raw,
    },
  };
}

/**
 * 解析并规范化模型输出。
 *
 * 宽松但有边界：
 *   - 块可以写成 `{ id, slots }`，也可以写成 `{ index, slots }`，或 `{ [id]: slots }`
 *   - 只保留该块**声明过**的、可写的 slot；模型编出来的名字直接丢掉
 *   - 列表型可以是数组，也可以是换行分隔的字符串
 */
export function parseWrittenBlocks(
  raw: string,
  plans: readonly PageWriteBlockPlan[],
): { blocks: WrittenBlock[]; written: number } {
  const data = extractJson(raw);
  const byId = new Map<string, Record<string, unknown>>();

  const takeSlots = (id: string, value: unknown): void => {
    const slots = asSlotRecord(value);
    if (slots !== undefined) byId.set(id, slots);
  };

  if (Array.isArray(data)) {
    for (const [position, item] of data.entries()) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const explicitId = typeof record['id'] === 'string' ? record['id'] : undefined;
      const plan = explicitId !== undefined ? plans.find((p) => p.block.id === explicitId) : plans[position];
      if (plan === undefined) continue;
      takeSlots(plan.block.id, record['slots'] ?? record);
    }
  } else if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const blocksField = record['blocks'];
    if (Array.isArray(blocksField)) {
      for (const [position, item] of blocksField.entries()) {
        if (item === null || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        const explicitId = typeof entry['id'] === 'string' ? entry['id'] : undefined;
        const plan = explicitId !== undefined ? plans.find((p) => p.block.id === explicitId) : plans[position];
        if (plan === undefined) continue;
        takeSlots(plan.block.id, entry['slots'] ?? entry);
      }
    } else if (blocksField !== null && typeof blocksField === 'object') {
      for (const [id, value] of Object.entries(blocksField as Record<string, unknown>)) {
        takeSlots(id, value);
      }
    } else {
      // 直接把 slot 平铺在根上（只有一块时常见）
      for (const plan of plans) {
        takeSlots(plan.block.id, record[plan.block.id] ?? record);
      }
    }
  }

  const out: WrittenBlock[] = [];
  let written = 0;
  for (const plan of plans) {
    const slots = byId.get(plan.block.id);
    if (slots === undefined) continue;
    const kept: Record<string, WrittenSlotText> = {};
    for (const slot of plan.spec.slots) {
      if (!WRITABLE_SLOT_TYPES.has(slot.type)) continue;
      const value = normalizeSlotValue(slot, slots[slot.name]);
      if (value === undefined) continue;
      kept[slot.name] = value;
    }
    if (Object.keys(kept).length === 0) continue;
    out.push({ id: plan.block.id, index: plan.index, slots: kept });
    written += Object.keys(kept).length;
  }
  return { blocks: out, written };
}

function normalizeSlotValue(slot: SlotSpec, raw: unknown): WrittenSlotText | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (slot.type === 'list-text') {
    const items = Array.isArray(raw)
      ? raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
      : typeof raw === 'string'
        ? raw
            .split(/\r?\n/)
            .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)）])\s*/, '').trim())
            .filter((line) => line !== '')
        : [];
    return items.length > 0 ? items : undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

function asSlotRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 从模型输出里取出 JSON：容忍 ```json 围栏与前后闲话。 */
function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 退一步：截取第一个 `{` 到最后一个 `}`。
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}
