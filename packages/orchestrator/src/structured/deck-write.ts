/**
 * 一次执笔：让大模型**一口气写完**整份演示文稿的每页文案。
 *
 * ## 为什么要有这一步
 *
 * 此前演示文稿的正文是"逐 slot 生成"：同一个要点页的标题、导语、五个条目
 * 是五次独立调用。模型看不到邻居写了什么，更看不到上一页讲了什么，于是：
 *
 *   - 页与页之间没有承接（这页讲增长，下页又从头讲背景）
 *   - 同页条目风格不齐（有的 8 字、有的 20 字）
 *   - 每页都在"通过数据洞察……"这种重复措辞
 *
 * 版式再换也救不了：**执笔被切碎了**。这里把它还原成一次写作——
 * 读目标、读统筹计划、读已经定稿的页序与版式，一次写出每一页的 slot 文案。
 *
 * ## 分工
 *
 * | 谁 | 干什么 |
 * |---|---|
 * | 大模型（本模块） | 写内容：一次写完整份文稿的文案 |
 * | 决策模型 | 只从候选里挑：页序、版式、主题、构图、每页要几项 |
 * | 渲染器 | 确定性代码：把文案放进选中的版式 |
 *
 * 本模块**不决定**任何结构：页数、每页版式、每个 slot 的名字都来自上游的
 * `PageSpec`，它只负责"把字写出来"。
 *
 * ## 失败不静默，也不打挂整次运行
 *
 * 和统筹规划同一个纪律：拿不到合法结果就返回 `{ ok: false, detail }`，
 * 让调用方回落到逐 slot 生成，并如实记下原因。**不编一份假文案**。
 */
import type { LlmClient, LlmResponse, LlmUsage } from '../llm/types.js';
import type { PageBlueprint } from '../plan/blueprint.js';
import type { BlockSpec, SlotSpec } from './block-spec.js';

/** 一页的写作计划：用哪个版式、每个 slot 计划几项。 */
export interface DeckWritePagePlan {
  readonly index: number;
  readonly spec: BlockSpec;
  /** 列表型 slot 的项数（来自规划器问出来的数量）。非列表不需要。 */
  readonly counts: Readonly<Record<string, number>>;
}

export interface DeckWriteRequest {
  readonly llm: LlmClient;
  readonly goal: string;
  readonly pages: readonly DeckWritePagePlan[];
  /** 统筹规划的结果（如果有）。让执笔知道整份文稿打算怎么讲。 */
  readonly blueprint?: PageBlueprint | undefined;
  readonly themeLabel?: string | undefined;
  readonly themeDescription?: string | undefined;
  readonly tone?: string | undefined;
  readonly constraints?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** 一个 slot 的原始文案：文本型是字符串，列表型是字符串数组。 */
export type WrittenSlotText = string | readonly string[];

/** 一页的执笔结果。`index` 与上游页序一一对应。 */
export interface WrittenPage {
  readonly index: number;
  readonly layout: string;
  /** slot 名 → 文案。只包含该版式声明过、且可写的 slot。 */
  readonly slots: Readonly<Record<string, WrittenSlotText>>;
}

export interface WrittenDeck {
  readonly pages: readonly WrittenPage[];
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: LlmUsage;
  readonly finishReason: LlmResponse['finishReason'];
  /** 模型原文，保留用于排查与存证。 */
  readonly raw: string;
}

/**
 * 执笔结果。
 *
 * 与统筹规划一样用判别联合，不用 `deck?` + `error?`：
 * 后者能构造出"既有结果又有错误"和"两者都没有"两种非法状态。
 */
export type DeckWriteOutcome =
  | { readonly ok: true; readonly deck: WrittenDeck }
  | { readonly ok: false; readonly detail: string };

/**
 * 执笔的默认超时。
 *
 * 比统筹规划长：规划只写几行摘要，执笔要写整份文稿。12 页、每页 5 个 slot
 * 在本地小模型上可能要一两分钟。超时不是期望值，而是"这条链路已经不适合
 * 承担这一步"的兜底线——超时后回落到逐 slot 生成，页面照样出得来。
 */
export const DEFAULT_DECK_WRITE_TIMEOUT_MS = 120_000;

/**
 * 可以被执笔的 slot 类型。
 *
 * 图片不在此列：生图逐张计费，必须由显式开关控制（与 `makeSlotGenerator`
 * 同一条理由）。`link` / `literal` 是确定性常量，也不让模型编。
 */
const WRITABLE_SLOT_TYPES: ReadonlySet<SlotSpec['type']> = new Set<SlotSpec['type']>([
  'text',
  'title',
  'code',
  'list-text',
]);

/**
 * 提示词。
 *
 * 关键约束只有三类：
 *   1. **形状**：页数、页序、每页的 slot 名必须与上游一致（否则填充器接不住）
 *   2. **数量**：列表型条数必须落在版式能容纳的区间里
 *   3. **文风**：整份文稿像同一个人一口气写的，页与页有承接
 */
function buildMessages(request: DeckWriteRequest): { system: string; user: string } {
  const system = [
    '你是一份演示文稿的执笔。你只写内容，不决定版式、页序或视觉主题——这些已经由决策层定好。',
    '',
    '规则：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。',
    '2. pages 数组的长度必须等于给定页数，顺序必须与给定页序一致；每项只有 slots 字段。',
    '3. 每页只写该页列出的 slot 名，不要自创 slot，不要把版式名或页码写进文案。',
    '4. 列表型给字符串数组，条数必须落在给定区间；每页内的条目句式要一致。',
    '5. 整份文稿要像同一个人一口气写完：后页承接前页，不要每页都从头介绍背景。',
    '6. 具体、可读，不写"本页""我们将""通过数据洞察"这类空话；标题不超过 18 字，条目每条不超过 30 字。',
    '7. 不要编造没有依据的具体数字；需要数据时沿用计划里给出的数字，或改用定性表述。',
    '8. 封面页写标题与副标题，结尾页收口，不要开启新话题。',
  ].join('\n');

  const parts: string[] = [`目标：${request.goal}`];
  if (request.tone !== undefined && request.tone.trim() !== '') {
    parts.push(`语气要求：${request.tone}`);
  }
  if (request.themeLabel !== undefined && request.themeLabel !== '') {
    const description =
      request.themeDescription !== undefined && request.themeDescription !== ''
        ? `（${request.themeDescription}）`
        : '';
    parts.push(`视觉主题：${request.themeLabel}${description}`);
  }
  if (request.constraints !== undefined && request.constraints.length > 0) {
    parts.push(`硬约束：\n${request.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  if (request.blueprint !== undefined) {
    parts.push(formatBlueprint(request.blueprint));
  }
  parts.push(formatPages(request.pages));
  parts.push(
    '输出 JSON 形状：\n' +
      '{"pages":[{"slots":{"title":"...","subtitle":"..."}},{"slots":{"heading":"...","lede":"...","items":["...","..."]}}]}',
  );

  return { system, user: parts.join('\n\n') };
}

function formatBlueprint(blueprint: PageBlueprint): string {
  const lines: string[] = ['整体计划：'];
  if (blueprint.title !== '') lines.push(`标题：${blueprint.title}`);
  if (blueprint.positioning !== '') lines.push(`定位：${blueprint.positioning}`);
  if (blueprint.audience !== '') lines.push(`读者：${blueprint.audience}`);
  if (blueprint.tone !== '') lines.push(`语气：${blueprint.tone}`);
  lines.push('段落：');
  blueprint.sections.forEach((section, index) => {
    const detail = section.detail !== '' ? ` —— ${section.detail}` : '';
    lines.push(`${index + 1}. ${section.purpose}${detail}`);
  });
  return lines.join('\n');
}

function formatPages(pages: readonly DeckWritePagePlan[]): string {
  const lines: string[] = [
    `页序与版式（共 ${pages.length} 页；必须按这个顺序写，每页只写列出的 slot）：`,
  ];
  for (const page of pages) {
    lines.push(`第 ${page.index + 1} 页 [${page.spec.id} / ${page.spec.label}]`);
    for (const slot of page.spec.slots) {
      if (!WRITABLE_SLOT_TYPES.has(slot.type)) continue;
      lines.push(`  ${formatSlot(slot, page.counts[slot.name])}`);
    }
    const skipped = page.spec.slots.filter((slot) => !WRITABLE_SLOT_TYPES.has(slot.type));
    if (skipped.length > 0) {
      lines.push(`  （${skipped.map((slot) => slot.name).join('、')} 由系统自动填充，不要写）`);
    }
  }
  return lines.join('\n');
}

function formatSlot(slot: SlotSpec, count: number | undefined): string {
  const required = slot.required ? '必填' : '可选';
  if (slot.type === 'list-text') {
    const range = slot.countRange;
    const amount =
      range !== undefined
        ? `${range.min}~${range.max} 项`
        : `${count !== undefined && count > 0 ? count : 1} 项`;
    return `- ${slot.name}（${required}，字符串数组，${amount}）：${slot.description}`;
  }
  const label = slot.type === 'title' ? '标题' : slot.type === 'code' ? '代码' : '文本';
  return `- ${slot.name}（${required}，${label}）：${slot.description}`;
}

/**
 * 跑一次执笔。
 *
 * **不抛错**：失败时返回 `{ ok: false }`，由调用方回落到逐 slot 生成。
 * 唯一例外是调用方已中止（`AbortError`）——那属于上层取消逻辑。
 */
export async function writeDeck(request: DeckWriteRequest): Promise<DeckWriteOutcome> {
  if (request.pages.length === 0) {
    return { ok: false, detail: '没有页面可写' };
  }

  const { system, user } = buildMessages(request);
  const timeoutMs =
    request.timeoutMs !== undefined && request.timeoutMs > 0
      ? request.timeoutMs
      : DEFAULT_DECK_WRITE_TIMEOUT_MS;
  const signals: AbortSignal[] = [];
  if (request.signal !== undefined) signals.push(request.signal);
  signals.push(AbortSignal.timeout(timeoutMs));
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let response;
  try {
    response = await request.llm.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      responseFormat: 'json',
      temperature: 0.7,
      // 每页大约 300~400 token 的文案；留一点 JSON 结构的余量。
      maxTokens: Math.min(8192, Math.max(1200, request.pages.length * 420)),
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted === true) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: signal.aborted
        ? `执笔模型在 ${Math.round(timeoutMs / 1000)} 秒内没有返回，已放弃本次执笔：${detail}`
        : `执笔模型调用失败：${detail}`,
    };
  }

  const raw = response.text ?? '';
  if (raw.trim() === '') {
    return { ok: false, detail: '执笔模型返回空内容' };
  }

  const parsed = parseWrittenPages(raw, request.pages);
  if (parsed.contentPages === 0) {
    const truncated = response.finishReason === 'length' ? '（输出被截断）' : '';
    return {
      ok: false,
      detail:
        `执笔模型返回的内容里读不出任何一页文案${truncated}` +
        `（原文 ${raw.length} 字）`,
    };
  }

  return {
    ok: true,
    deck: {
      pages: parsed.pages,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage,
      finishReason: response.finishReason,
      raw,
    },
  };
}

interface ParsedWrittenPages {
  /** 与 `request.pages` 等长、按页序对齐；没有写到的页 `slots` 为空对象。 */
  readonly pages: readonly WrittenPage[];
  readonly contentPages: number;
}

/**
 * 解析并规范化模型输出。
 *
 * 宽松但有边界：
 *   - 页面对象可以写成 `{ slots: {...} }`，也可以把 slot 直接放在页面对象上
 *   - 只保留该页版式**声明过**的、可写的 slot；模型编出来的名字直接丢掉
 *   - 列表型可以是数组，也可以是换行分隔的字符串
 *
 * 不做类型强转（比如把对象塞进文本 slot）：那类值会在填充器里被拒绝，
 * 这里提前过滤掉，免得把"形态错误"拖到下游才暴露。
 */
function parseWrittenPages(
  text: string,
  plans: readonly DeckWritePagePlan[],
): ParsedWrittenPages {
  const pages: WrittenPage[] = plans.map((plan) => ({
    index: plan.index,
    layout: plan.spec.id,
    slots: {},
  }));

  const json = extractJsonObject(text);
  if (json === null) return { pages, contentPages: 0 };

  const record = json as Record<string, unknown>;
  const rawPages = record['pages'];
  if (!Array.isArray(rawPages)) return { pages, contentPages: 0 };

  let contentPages = 0;
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    const rawPage = rawPages[i];
    if (plan === undefined || rawPage === undefined) continue;
    const rawSlots = pageSlots(rawPage);
    if (rawSlots === null) continue;

    const slots: Record<string, WrittenSlotText> = {};
    for (const slot of plan.spec.slots) {
      if (!WRITABLE_SLOT_TYPES.has(slot.type)) continue;
      const value = rawSlots[slot.name];
      const normalized =
        slot.type === 'list-text' ? normalizeList(value) : normalizeText(value);
      if (normalized !== undefined) slots[slot.name] = normalized;
    }

    if (Object.keys(slots).length > 0) {
      pages[i] = { index: plan.index, layout: plan.spec.id, slots };
      contentPages += 1;
    }
  }

  return { pages, contentPages };
}

/** 从可能带 markdown 围栏、前后废话的文本里切出第一个完整的 JSON 对象。 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  // 按大括号配对找结尾，跳过字符串里的括号——否则 `{"a":"}"}` 会被截断。
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 取出一页的 slot 表；兼容"slot 直接放在页面对象上"的写法。 */
function pageSlots(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const slots = record['slots'];
  if (typeof slots === 'object' && slots !== null && !Array.isArray(slots)) {
    return slots as Record<string, unknown>;
  }
  return record;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? undefined : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function normalizeList(value: unknown): string[] | undefined {
  let items: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeText(item);
      if (text !== undefined) items.push(text);
    }
  } else {
    const text = normalizeText(value);
    if (text === undefined) return undefined;
    items = text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter((line) => line !== '');
  }
  return items.length > 0 ? items : undefined;
}
