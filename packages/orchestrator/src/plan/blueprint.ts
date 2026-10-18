/**
 * 统筹规划：**大语言模型先出一份整体计划**，再交给决策模型逐块选块。
 *
 * ## 这一步为什么必须单独存在
 *
 * 在此之前，结构化链路里只有一个模型在"决定结构"——决策模型逐轮回答
 * "下一块放什么"。它能选对单块，但它**看不到全局**：
 *
 *   - 它不知道这一页要讲几个论点、先后怎么推进
 *   - 它每轮只看到"现在排到哪了"，没有一份可以对着核对的计划
 *   - 页面读起来是"一堆合理的块"，而不是"一篇讲得通的页面"
 *
 * 缺的不是"更聪明的选块"，是**先有一份计划**。所以这里引入第二个模型角色：
 *
 * | 角色 | 谁 | 干什么 | 输出 |
 * |---|---|---|---|
 * | 统筹规划 | `LlmClient`（大语言模型，开放生成） | 读目标，写出一份内容计划 | 段落序列：每段讲什么、用什么块 |
 * | 结构决策 | `DecisionClient`（决策模型，封闭问题） | 按计划逐轮在候选集里选块 | `PageSpec` |
 *
 * 这条分工与既有的红线一致：**决策模型仍然独占"选哪个块"**，
 * 规划器只给出"要讲哪几段"的意图，不给具体块——它给的是建议（`blockIds`），
 * 真正选中哪一个由决策层的 `choice` 回答。
 *
 * ## 为什么规划的结果要变成决策层的 `facts`
 *
 * 规划如果只进日志，对结构没有任何影响，那它就是一次白花的生成额度。
 * 把它压成几行事实塞进 `DecisionContext.facts`，决策模型每一轮都能看到
 * "计划里有这几段、已经排到第几段"——这才是"统筹"落到了决策上。
 *
 * ## 失败不静默
 *
 * 规划不可用时（生成层不可达、超时），**不编一份假计划**，而是明确返回失败原因：
 * 调用方把它写进 rationale 和运行记录，界面照实显示"这次没有统筹规划"。
 * 编一份假计划比没有计划更糟——它会让"计划与实际结构的偏差"这个指标彻底失真。
 */
import type { EnvType } from '@mediasandbox/sandbox';
import type { LlmClient, LlmUsage } from '../llm/types.js';
import type { BlockSpec } from '../structured/block-spec.js';

/** 规划里的一段。**不是 block**——它是"这一段要讲什么"，块由决策层选。 */
export interface BlueprintSection {
  /** 这一段要解决的问题，一句话。 */
  readonly purpose: string;
  /** 展开写什么：要点、例子、数据。 */
  readonly detail: string;
  /**
   * 建议用哪些块。
   *
   * 只是**建议**：决策模型仍可另选。校验时会过滤掉候选集里没有的 id，
   * 所以模型编出来的块名不会漏进下游。
   */
  readonly blockIds: readonly string[];
}

/** 一份内容计划。它是产出物的一部分：前端要能展示它、用户要能核对它。 */
export interface PageBlueprint {
  readonly title: string;
  /** 一句话定位：这页到底是什么。 */
  readonly positioning: string;
  readonly audience: string;
  readonly tone: string;
  readonly sections: readonly BlueprintSection[];
  /** 模型自己提的约束或提醒（可空）。 */
  readonly notes: readonly string[];
  /**
   * 解析质量。
   *
   * - `ok`：模型按 JSON 契约返回，逐字段解析成功
   * - `lenient`：返回了内容但不是合法 JSON，按行文退回解析（仍有价值，但要标出来）
   */
  readonly status: 'ok' | 'lenient';
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: LlmUsage;
  /** 模型原文，保留用于排查与存证。 */
  readonly raw: string;
}

export interface PlanBlueprintRequest {
  readonly llm: LlmClient;
  readonly goal: string;
  readonly envType: EnvType;
  /** 本次候选块。规划要"看着能用的块"来写建议，否则建议全是池子里没有的。 */
  readonly blocks: readonly BlockSpec[];
  readonly constraints?: readonly string[] | undefined;
  readonly tone?: string | undefined;
  /** 套了模板时告诉规划器，免得它规划出模板里放不下的段落。 */
  readonly templateLabel?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * 规划结果。
 *
 * 用判别联合而不是 `blueprint?: ...` + `error?: ...`：
 * 后者能构造出"既有计划又有错误"和"两者都没有"两种非法状态。
 */
export type BlueprintOutcome =
  | { readonly ok: true; readonly blueprint: PageBlueprint }
  | { readonly ok: false; readonly detail: string };

/** 规划失败（生成层不可用 / 超时）。调用方据此如实记录，而不是伪造计划。 */
export class BlueprintError extends Error {
  override readonly name = 'BlueprintError';
  constructor(
    message: string,
    readonly reason: 'UNREACHABLE' | 'TIMEOUT' | 'EMPTY',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * 规划的默认超时。
 *
 * ## 为什么必须有默认值，而且不能是个很大的数
 *
 * 规划是**上游的第一步**：它没返回之前，一个 block 都还没开始填，
 * 用户看到的是一条空的事件流。实测本地 1.7B 模型约 20 token/s，
 * 这份提示词要 600–900 个 token，光规划就是 30–45 秒——而这台机器还算能跑。
 *
 * 所以 90 秒是个**上限而不是期望**：正常情况十几秒就回来，超过 90 秒说明
 * 这个模型或这条链路已经不适合承担这一步，此时"如实报超时、退回直接逐页决策"
 * 比"让用户对着空白页面等下去"好得多。生成层不可达本来也不该等于页面做不出来。
 *
 * 想要更长的调用方显式传 `blueprintTimeoutMs` —— 默认值不该替人做决定，
 * 但必须有一个，否则一次卡住的请求会拖死整次运行。
 */
export const DEFAULT_BLUEPRINT_TIMEOUT_MS = 90_000;

/**
 * 模态的中文说法。提示词里用它，避免把 `webpage` 这种代码值直接丢给模型。
 *
 * 用 `Record<string, string>` 而不是 `Record<EnvType, string>`：新增一个模态时
 * 忘了加标签只该退化成"显示代码值"，不该让整个包编译不过。
 */
const ENV_LABELS: Readonly<Record<string, string>> = {
  webpage: '网页',
  frontend: '前端应用',
  image: '图片',
  copy: '文案',
  slides: '演示文稿',
};

/**
 * 提示词。
 *
 * ## 为什么逼 JSON
 *
 * 规划要**被代码读**（喂给决策层、显示在界面上），不是被当文章读。
 * 一段自由散文要么用正则抠，要么只能整段塞给用户看——两者都让"计划"
 * 无法参与后续决策。JSON 让"第几段讲什么、建议用什么块"变成字段。
 *
 * ## 为什么字数压得这么死
 *
 * 规划是**上游**：它多花 10 秒，整次运行就多 10 秒；它写 2000 字，
 * 决策层看到的 facts 就长到把真正的结构信息挤掉。所以每段 detail 限一句。
 */
function buildMessages(request: PlanBlueprintRequest): {
  readonly system: string;
  readonly user: string;
} {
  const system = [
    '你在做页面策划。读完目标，写出一份可以照着排版的计划。',
    '',
    '规则：',
    '1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。',
    '2. sections 是页面从上到下的段落顺序。3 到 6 段，不要更多。',
    '3. 每段的 purpose 写"这一段解决什么"，一句话，不超过 20 字，不要用"本段"开头。',
    '4. 每段的 detail 写要点，一句话，不超过 40 字。',
    '5. blockIds 只能从给定的可选块 id 里挑，每段 1 到 2 个，按优先级排。',
    '6. positioning 是一句话定位，audience 是给谁看，tone 是语气。',
    '7. 语气按中文写作常识来写，不要写"我们将为你打造"这类空话。',
  ].join('\n');

  const blockLines = request.blocks
    .slice(0, 60)
    .map((b) => `- ${b.id}（${b.label}）：${b.description}`)
    .join('\n');

  const parts: string[] = [
    `目标：${request.goal}`,
    `模态：${ENV_LABELS[request.envType] ?? request.envType}`,
  ];
  if (request.tone !== undefined && request.tone.trim() !== '') {
    parts.push(`语气要求：${request.tone}`);
  }
  if (request.templateLabel !== undefined) {
    parts.push(`已选模块：${request.templateLabel}（段落安排要能放进这个模块）`);
  }
  if (request.constraints !== undefined && request.constraints.length > 0) {
    parts.push(`硬约束：\n${request.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  parts.push(`可选块：\n${blockLines}`);
  parts.push(
    '输出 JSON 形状：\n' +
      '{"title":"...","positioning":"...","audience":"...","tone":"...",' +
      '"sections":[{"purpose":"...","detail":"...","blockIds":["..."]}],"notes":["..."]}',
  );

  return { system, user: parts.join('\n\n') };
}

/**
 * 跑一次统筹规划。
 *
 * **不抛错**：失败时返回 `{ ok: false }`。理由是调用方一定能处理"没有计划"，
 * 但几乎无法处理"规划把整次运行打挂了"——生成层不可达不该等于页面做不出来。
 * 唯一例外是调用方已中止（`AbortError`），那种情况交给上层取消逻辑。
 */
export async function planBlueprint(request: PlanBlueprintRequest): Promise<BlueprintOutcome> {
  if (request.blocks.length === 0) {
    return { ok: false, detail: '候选块为空，无法规划' };
  }

  const { system, user } = buildMessages(request);
  const signals: AbortSignal[] = [];
  if (request.signal !== undefined) signals.push(request.signal);
  // 超时**总是挂着**，默认值见 `DEFAULT_BLUEPRINT_TIMEOUT_MS`。
  // 这里不加条件判断：漏挂一次就是"整次运行卡在一个不返回的请求上"。
  const timeoutMs =
    request.timeoutMs !== undefined && request.timeoutMs > 0
      ? request.timeoutMs
      : DEFAULT_BLUEPRINT_TIMEOUT_MS;
  signals.push(AbortSignal.timeout(timeoutMs));
  const signal: AbortSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);

  let response;
  try {
    response = await request.llm.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 900,
      signal,
    });
  } catch (error) {
    // 调用方自己取消的（不是我们设的超时）：交给上层取消逻辑，不当成规划失败。
    if (request.signal?.aborted === true) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    // 走到这里说明调用方没取消，那 `signal.aborted` 只可能是超时那一路。
    return {
      ok: false,
      detail: signal.aborted
        ? `规划模型在 ${Math.round(timeoutMs / 1000)} 秒内没有返回，已放弃本次规划：${detail}`
        : `规划模型调用失败：${detail}`,
    };
  }

  const raw = response.text ?? '';
  if (raw.trim() === '') {
    return { ok: false, detail: '规划模型返回空内容' };
  }

  const parsed = parseBlueprintText(raw);
  const sections = parsed.sections
    .map((section) => ({
      purpose: section.purpose,
      detail: section.detail,
      // 只留候选集里真实存在的块。模型编出来的 id 到下游一定会被拦，
      // 在这里先过滤，让"建议"这一栏永远是可信的。
      blockIds: section.blockIds.filter((id) => request.blocks.some((b) => b.id === id)),
    }))
    .filter((section) => section.purpose !== '');

  if (sections.length === 0) {
    return { ok: false, detail: `规划模型返回的内容里读不出任何段落（原文 ${raw.length} 字）` };
  }

  return {
    ok: true,
    blueprint: {
      title: parsed.title,
      positioning: parsed.positioning,
      audience: parsed.audience,
      tone: parsed.tone,
      sections,
      notes: parsed.notes,
      status: parsed.status,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage,
      raw,
    },
  };
}

/**
 * 把计划压成决策层的 `facts`。
 *
 * 这是**两个模型之间唯一的接口**：规划器能影响结构的全部手段，就是这几行文本。
 * 刻意只放"计划本身"，不放"我们希望你选 footer"这种暗示——
 * 那等于用规划器替决策层选块，红线就被绕过去了。
 */
export function blueprintFacts(blueprint: PageBlueprint): Record<string, string> {
  const facts: Record<string, string> = {
    整体规划: [blueprint.title, blueprint.positioning].filter((s) => s !== '').join('；') || '(模型未给)',
    规划段落数: String(blueprint.sections.length),
    规划段落: blueprint.sections
      .map((section, index) => {
        const blocks =
          section.blockIds.length > 0 ? `（建议块 ${section.blockIds.join('/')}）` : '';
        return `${index + 1}. ${section.purpose}${blocks}`;
      })
      .join(' | '),
  };
  if (blueprint.audience !== '') facts['目标读者'] = blueprint.audience;
  if (blueprint.tone !== '') facts['语气'] = blueprint.tone;
  return facts;
}

/**
 * 计划与定稿结构的对照。
 *
 * 两个模型分工之后，"计划说几段、实际排几块"就变成一个**必须能回答**的问题：
 * 差得多说明规划没落下去（或者决策层没理它），差得少说明两者对上了。
 * 把它算成一行可读文本，界面直接显示，不用人去数。
 */
export function describeAlignment(
  blueprint: PageBlueprint,
  actualBlockCount: number,
): {
  readonly plannedSections: number;
  readonly actualBlocks: number;
  readonly aligned: boolean;
  readonly detail: string;
} {
  const planned = blueprint.sections.length;
  const actualBlocks = actualBlockCount;
  const delta = actualBlocks - planned;
  // 阈值取 ±1：块比段多一块少一块都正常（收尾块、导航块不占段落）。
  const aligned = Math.abs(delta) <= 1;
  const detail = aligned
    ? `计划 ${planned} 段，实际 ${actualBlocks} 块，对得上`
    : `计划 ${planned} 段，实际 ${actualBlocks} 块，差 ${delta > 0 ? '+' : ''}${delta}`;
  return { plannedSections: planned, actualBlocks, aligned, detail };
}

// ── 解析 ────────────────────────────────────────────────────────────────────

interface ParsedBlueprint {
  readonly title: string;
  readonly positioning: string;
  readonly audience: string;
  readonly tone: string;
  readonly sections: { purpose: string; detail: string; blockIds: string[] }[];
  readonly notes: string[];
  readonly status: 'ok' | 'lenient';
}

/**
 * 解析模型输出。
 *
 * 两级：
 *   1. **严格**：从文本里切出第一个 `{...}` 当 JSON 解析
 *   2. **宽松**：不是 JSON 就按行读——标题行当 title，列表项当段落
 *
 * 为什么要有第二级：这个模型的 `responseFormat: 'json'` 只是**请求**，
 * 服务端不保证遵守（本地 gguf 的 grammar 不一定挂得上）。返回一段正常中文
 * 并不是错误，它仍然是一份可用的计划——直接判失败等于把能用的东西扔掉。
 * 但要标成 `lenient`，让人知道这份计划不是按契约来的。
 */
function parseBlueprintText(text: string): ParsedBlueprint {
  const json = extractJsonObject(text);
  if (json !== null) {
    const strict = fromJson(json);
    if (strict !== null) return strict;
  }
  return fromText(text);
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

function fromJson(value: unknown): ParsedBlueprint | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const sectionsRaw = record['sections'];
  if (!Array.isArray(sectionsRaw)) return null;

  const sections: { purpose: string; detail: string; blockIds: string[] }[] = [];
  for (const item of sectionsRaw) {
    if (typeof item === 'string') {
      const purpose = item.trim();
      if (purpose !== '') sections.push({ purpose, detail: '', blockIds: [] });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const purpose = str(row['purpose']) || str(row['title']) || str(row['name']);
    if (purpose === '') continue;
    sections.push({
      purpose,
      detail: str(row['detail']) || str(row['description']) || str(row['content']),
      blockIds: strArray(row['blockIds'] ?? row['blocks'] ?? row['block']),
    });
  }
  if (sections.length === 0) return null;

  return {
    title: str(record['title']),
    positioning: str(record['positioning']) || str(record['summary']) || str(record['position']),
    audience: str(record['audience']),
    tone: str(record['tone']),
    sections,
    notes: strArray(record['notes']),
    status: 'ok',
  };
}

/**
 * 兜底解析：把模型写的一段中文读成段落列表。
 *
 * 认得的东西：`#`/`##` 标题、`-`/`*`/`1.` 列表项、空行分段。
 * 不认得的（散文段落）当 detail 挂到上一段，或者自成一段。
 */
function fromText(text: string): ParsedBlueprint {
  const lines = text.split(/\r?\n/);
  let title = '';
  const sections: { purpose: string; detail: string; blockIds: string[] }[] = [];
  const notes: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      const value = heading[1]!.trim();
      if (title === '') title = value;
      else if (value !== '') sections.push({ purpose: value, detail: '', blockIds: [] });
      continue;
    }

    const bullet = /^(?:[-*·]|\d+[.)、])\s+(.*)$/.exec(trimmed);
    if (bullet !== null) {
      const value = bullet[1]!.trim();
      if (value === '') continue;
      // "要点：细节" 这种写法拆成 purpose + detail。
      const split = /^([^：:]{1,20})[：:]\s*(.+)$/.exec(value);
      if (split !== null) {
        sections.push({ purpose: split[1]!.trim(), detail: split[2]!.trim(), blockIds: [] });
      } else {
        sections.push({ purpose: value, detail: '', blockIds: [] });
      }
      continue;
    }

    if (title === '') {
      title = trimmed;
      continue;
    }
    // 普通句子：给它一段，或者并进上一段的 detail。
    const last = sections.at(-1);
    if (last !== undefined && last.detail === '') {
      sections[sections.length - 1] = { ...last, detail: trimmed };
    } else {
      sections.push({ purpose: shorten(trimmed), detail: '', blockIds: [] });
    }
  }

  if (sections.length === 0 && title !== '') {
    // 只有一行标题也认：至少 title 有用，调用方会按"没有段落"判失败。
    notes.push('返回内容只有标题，没有读到段落');
  }

  return {
    title,
    positioning: '',
    audience: '',
    tone: '',
    sections,
    notes,
    status: 'lenient',
  };
}

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function strArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter((s) => s !== '');
}

function shorten(text: string): string {
  return text.length <= 20 ? text : `${text.slice(0, 20)}…`;
}
