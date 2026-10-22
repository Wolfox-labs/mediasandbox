/**
 * 结构化制作链路的两个工具：**填一块** 与 **装一页**。
 *
 * ## 为什么是两个而不是一个
 *
 * 现有工具是交付物级粒度（一次调用产出一个整页），于是 DAG 只有一个节点，
 * 退化成单点——所有机械（并发、重试、依赖、校验）都在空转。
 *
 * 拆成"每块一个节点 + 一个组装节点"之后，计划天然是 N+1 个节点：
 *
 * ```
 * fill-block(b1) ┐
 * fill-block(b2) ├─→ assemble-page → verify-artifact
 * fill-block(b3) ┘
 * ```
 *
 * 同层节点**并发执行**，每块**独立重试**，块的产出顺序就是页面顺序。
 * 这才是"可编排"的对象——而不是一个巨大的单点。
 *
 * ## 为什么填块产出的是 JSON 而不是 HTML 片段
 *
 * 填充管**内容**，渲染管**版式**。让填块直接吐 HTML 片段，就把两者焊死了：
 * 换版式要重跑全部填充（重新花钱），换内容要动渲染代码。
 * 产出 JSON 则两头都松：版式改了重渲染即可，填充结果还能复用。
 *
 * ## 为什么工具是**工厂**而不是常量
 *
 * 两个工具都要查 block 池：填块要按 `BlockSpec` 决定每个 slot 怎么填，
 * 组装页要拿池子校验结构。而池子**必须与规划器用的是同一个**。
 *
 * 此前三处（规划器、fill-block、assemble-page）各自 `createBlockRegistry()`
 * 新建了一个内置池，于是外部来源的 block（模型提议 / 用户手打 / 导入）
 * 呈现为一条断链：`/api/blocks` 列得出来、却永远选不到；
 * 就算硬塞进候选集，也会在**执行期**才报"未注册"。
 *
 * 现在池子从外面注入一次，三处共用。不注入时退回内置池，
 * 保证"什么都不配也能跑通"这条底线不变。
 */
import { ToolError, type ToolRegistration, type ToolResult, type ToolRuntime } from '../tools/types.js';
import type { LlmClient } from '../llm/types.js';
import { DEFAULT_VIEWPORT, defaultScreenshotDriver, type ScreenshotDriver } from '../render/screenshot.js';
import { createBlockRegistry, type BlockRegistry } from './block-spec.js';
import { deriveBrand, fillBlock, type GenerateSlotResult } from './filler.js';
import { validatePageSpec, type BlockInstance, type PageSpec } from './page-spec.js';
import { writePage, type PageWriteBlockPlan } from './page-write.js';
import { renderPage } from './renderer.js';

/** 读一个必需的字符串入参。 */
function requireString(inputs: Readonly<Record<string, unknown>>, key: string, toolId: string): string {
  const value = inputs[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`工具 ${toolId} 缺少必需的字符串入参: ${key}`, 'EXECUTION_FAILED', toolId);
  }
  return value;
}

/** 读一个布尔入参，缺失时用默认值。 */
function boolInput(inputs: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = inputs[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 把 JSON 文本解析成结构化数据。失败即工具失败，并带上出错位置。 */
function parseJson<T>(raw: string, toolId: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ToolError(
      `工具 ${toolId} 无法解析${what} JSON: ${error instanceof Error ? error.message : String(error)}`,
      'EXECUTION_FAILED',
      toolId,
    );
  }
}

/**
 * 填一块。
 *
 * 入参里带的是**该块的 JSON**（`planner` 产出的 pending 实例，含决策层问出来的数量），
 * 出参是**填好内容的同构 JSON**。这样每个块在网络与磁盘上都可独立传递、独立检查，
 * 也就能独立重做——"定点修复"的前提。
 */
export function createFillBlockTool(blocks: BlockRegistry): ToolRegistration {
  return {
    spec: {
      id: 'fill-block',
      label: '填充一个页面区块',
      description:
        '把结构里一个已定型的 block 的各个 slot 填成实际内容，产出一份带内容的 block JSON',
      envTypes: ['webpage'],
      role: 'generate',
      category: 'structured',
      inputs: [
        { name: 'blockJson', type: 'text', required: true, description: '该 block 的 JSON' },
        { name: 'goal', type: 'text', required: true, description: '页面目标，填充内容的依据' },
        { name: 'brand', type: 'text', required: false, description: '站点名' },
        { name: 'index', type: 'number', required: false, description: '该块在页面上的序号' },
        {
          name: 'useGenerative',
          type: 'boolean',
          required: false,
          description: '是否用生成层写文案。false 时全部确定性填充，零成本',
        },
        {
          name: 'written',
          type: 'text',
          required: false,
          description: '整页执笔结果里属于本块的 slot 文案 JSON（有就优先用，省掉逐 slot 调用）',
        },
      ],
      outputs: [
        { name: 'block', type: 'text', required: true, description: '填好的 block JSON' },
        { name: 'file', type: 'file', required: true, description: 'block JSON 的相对路径' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const blockJson = requireString(runtime.inputs, 'blockJson', 'fill-block');
      const goal = requireString(runtime.inputs, 'goal', 'fill-block');
      const brand = typeof runtime.inputs['brand'] === 'string' ? runtime.inputs['brand'] : '';
      const indexRaw = runtime.inputs['index'];
      const index =
        typeof indexRaw === 'number' && Number.isFinite(indexRaw) ? Math.round(indexRaw) : 0;
      const useGenerative = boolInput(runtime.inputs, 'useGenerative', false);

      const block = parseJson<BlockInstance>(blockJson, 'fill-block', 'block');
      if (!blocks.has(block.type)) {
        throw new ToolError(
          `block ${block.id} 的类型未注册: ${block.type}。` +
            `自定义 block 必须与规划器用同一个池子（服务层注入 deps.blocks）`,
          'EXECUTION_FAILED',
          'fill-block',
        );
      }

      // 整页执笔的结果：有就优先用，只有它没覆盖到的 slot 才回落到逐 slot 生成。
      const writtenRaw = runtime.inputs['written'];
      let written: Readonly<Record<string, unknown>> | undefined;
      if (typeof writtenRaw === 'string' && writtenRaw.trim() !== '') {
        try {
          const parsed = JSON.parse(writtenRaw) as unknown;
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>;
            // 执笔工具给的是整页 `{ blocks: { id: slots } }`；也兼容直接给本块 slot 表。
            const grouped = record['blocks'];
            if (grouped !== null && typeof grouped === 'object' && !Array.isArray(grouped)) {
              const mine = (grouped as Record<string, unknown>)[block.id];
              if (mine !== null && typeof mine === 'object' && !Array.isArray(mine)) {
                written = mine as Record<string, unknown>;
              }
            } else {
              written = record;
            }
          }
        } catch {
          runtime.log('执笔文案不是合法 JSON，已忽略并回落到逐 slot 生成');
        }
      }

      // 生成式实现：只对"归生成层填"的 slot 类型调模型，其余仍是确定性。
      // 粒度是 **slot**，不是 block —— "这块标题用确定性的、主视觉用生成式的"
      // 必须表达得出来，否则素材层又退化成一揽子。
      const generate =
        useGenerative && runtime.llm !== undefined
          ? makeSlotGenerator(runtime.llm, runtime)
          : undefined;

      // planner 放进 slots 里的数量信息要留着，否则"要几个"这一问就白问了。
      const counts: Record<string, number> = {};
      for (const [name, value] of Object.entries(block.slots)) {
        counts[name] =
          value.kind === 'list'
            ? value.items.length
            : value.kind === 'list-image'
              ? value.refs.length
              : 1;
      }

      const filled = await fillBlock({
        spec: blocks.get(block.type),
        block,
        goal,
        // 没给 brand 就交给 `deriveBrand` 派生。
        //
        // 这里曾经写的是 `goal.slice(0, 16)` —— 与 `deriveBrand` **两套逻辑**，
        // 于是修好了派生函数也没用：服务端这条路径根本不走它，
        // 页面上顶着的仍是一句在词中间切断的残句（「…含首屏、特」）。
        // 兜底只能有一处，否则改了 A 忘了 B，表现是"修了但没生效"。
        brand: brand === '' ? deriveBrand(goal) : brand,
        options:
          generate === undefined
            ? {}
            : { generate, ...(written !== undefined ? { written } : {}) },
        index,
        counts,
      });

      const relPath = `src/blocks/${block.id}.json`;
      const outJson = JSON.stringify(filled.block, null, 2);
      await runtime.sandbox.writeFile(runtime.handle, relPath, outJson);

      for (const warning of filled.warnings) runtime.log(warning);
      if (useGenerative && runtime.llm === undefined) {
        runtime.log('要求生成式填充但本次运行未提供 LlmClient，已全部走确定性填充');
      }

      return {
        outputs: { block: outJson, file: relPath },
        artifacts: [],
        summary:
          `填充区块 ${block.id}(${block.type})，${Object.keys(filled.block.slots).length} 个 slot，` +
          `${filled.generativeCalls} 次生成调用` +
          (filled.writtenSlots.length > 0 ? `，执笔 ${filled.writtenSlots.length} 个` : ''),
      };
    },
  };
}

/**
 * 一次执笔整页：把一页里所有可写 slot 交给模型一口气写完。
 *
 * 之前是**逐 slot** 调生成层：一页 5~6 块、11 个 slot 就是 11 次调用，
 * 而且只有一个块的 4 个 slot 并行，剩下 7 个排在第二波。
 * 这里改成页面级一次调用，填充器优先用它的结果，
 * 只有没被覆盖到的 slot 才回落（见 `fill-block` 的 `written` 入参）。
 */
export function createWritePageTool(blocks: BlockRegistry): ToolRegistration {
  return {
    spec: {
      id: 'write-page-copy',
      label: '一次执笔整页文案',
      description:
        '按已定稿的块序与版式，一次写完整页所有可写 slot 的文案；不决定结构',
      envTypes: ['webpage'],
      role: 'generate',
      category: 'structured',
      inputs: [
        { name: 'blocksJson', type: 'text', required: true, description: '整页 block 数组的 JSON' },
        { name: 'goal', type: 'text', required: true, description: '页面目标' },
        { name: 'brand', type: 'text', required: false, description: '站点名' },
        { name: 'planText', type: 'text', required: false, description: '统筹计划的文本摘要' },
      ],
      outputs: [
        { name: 'written', type: 'text', required: true, description: '块 id → slot 文案的 JSON' },
        { name: 'counts', type: 'number', required: true, description: '写出文案的 slot 总数' },
      ],
      costHint: 'slow',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      if (runtime.llm === undefined) {
        runtime.log('本次运行没有生成层，执笔跳过，全部走逐 slot/确定性填充');
        return {
          outputs: { written: '', counts: 0 },
          artifacts: [],
          summary: '没有生成层，执笔跳过',
        };
      }

      const blocksJson = requireString(runtime.inputs, 'blocksJson', 'write-page-copy');
      const goal = requireString(runtime.inputs, 'goal', 'write-page-copy');
      const brand = typeof runtime.inputs['brand'] === 'string' ? runtime.inputs['brand'] : '';
      const planText =
        typeof runtime.inputs['planText'] === 'string' ? runtime.inputs['planText'] : '';

      const parsed = parseJson<BlockInstance[]>(blocksJson, 'write-page-copy', 'blocks');
      if (!Array.isArray(parsed)) {
        throw new ToolError('工具 write-page-copy 的 blocksJson 不是数组', 'EXECUTION_FAILED', 'write-page-copy');
      }

      const plans: PageWriteBlockPlan[] = [];
      for (const [index, block] of parsed.entries()) {
        if (!blocks.has(block.type)) {
          throw new ToolError(
            `block ${block.id} 的类型未注册: ${block.type}`,
            'EXECUTION_FAILED',
            'write-page-copy',
          );
        }
        const counts: Record<string, number> = {};
        for (const [name, value] of Object.entries(block.slots)) {
          counts[name] =
            value.kind === 'list'
              ? value.items.length
              : value.kind === 'list-image'
                ? value.refs.length
                : 1;
        }
        plans.push({ index, block, spec: blocks.get(block.type), counts });
      }

      const outcome = await writePage({
        llm: runtime.llm,
        goal,
        ...(brand === '' ? {} : { brand }),
        blocks: plans,
        ...(planText === '' ? {} : { planText }),
        signal: runtime.signal,
      });

      if (!outcome.ok) {
        runtime.log(`执笔未成功：${outcome.detail}。回落到逐 slot 生成`);
        return {
          outputs: { written: '', counts: 0 },
          artifacts: [],
          summary: `执笔未成功，已回落：${outcome.detail}`,
        };
      }

      const grouped: Record<string, Record<string, unknown>> = {};
      let writtenSlots = 0;
      for (const block of outcome.page.blocks) {
        grouped[block.id] = block.slots as Record<string, unknown>;
        writtenSlots += Object.keys(block.slots).length;
      }

      const wroteBlocks = outcome.page.blocks.length;
      return {
        outputs: { written: JSON.stringify({ blocks: grouped }), counts: writtenSlots },
        artifacts: [],
        summary:
          `执笔：一次写出 ${wroteBlocks}/${plans.length} 块、${writtenSlots} 个 slot 文案` +
          `（${outcome.page.model}，${(outcome.page.latencyMs / 1000).toFixed(1)}s）`,
      };
    },
  };
}

/**
 * 造一个 slot 级生成器。
 *
 * 只有 `text` / `title` / `code` 与列表型走文本模型；`image` / `list-image`
 * **不在这里生成** —— 生图是逐张计费的，必须由显式的开关控制，
 * 不能因为"这个 slot 是图"就自动扣钱。
 */
export function makeSlotGenerator(
  llm: LlmClient,
  runtime: ToolRuntime,
  /**
   * 哪种模态。**必须传对**：提示词里说"你是网页文案撰写者"时，
   * 幻灯片会拿到一整段网页口吻的导语——版式是幻灯片、文案是落地页，
   * 看上去就像"模板没填完"。演示文稿要用自己的说法（短句、能读出来）。
   */
  kind: 'webpage' | 'slides' = 'webpage',
): (request: {
  readonly goal: string;
  readonly blockType: string;
  readonly blockId: string;
  readonly slot: { readonly name: string; readonly type: string; readonly description: string };
  readonly count: number;
  /** 同块已填好的内容，用来给生图写提示词（比如主标题）。 */
  readonly context?: Readonly<Record<string, string>>;
  /** 决策层选定的来源：生成 / 网上找图 / 占位（占位根本不会走到这里）。 */
  readonly source?: 'generative' | 'web' | 'deterministic' | undefined;
}) => Promise<GenerateSlotResult | null> {
  return async (request) => {
    const { slot, goal, count } = request;
    if (slot.type === 'image' || slot.type === 'list-image') {
      // 生图：决策层已经把"这块图要不要真生成"问过了（`slot_source`）。
      // 走到这里就说明它选了生成层，剩下的只是把提示词写清楚、按张调用。
      return generateImagesForSlot(llm, runtime, {
        goal,
        blockType: request.blockType,
        slotName: slot.name,
        slotType: slot.type,
        description: slot.description,
        count,
        context: request.context ?? {},
        ...(request.source === undefined ? {} : { source: request.source }),
      });
    }
    if (slot.type === 'link' || slot.type === 'literal') return null;

    const wantsList = slot.type === 'list-text';
    const isDeck = kind === 'slides';
    // features 的条目要"标题 + 一句说明"才撑得起卡片；只说"每行一条"时
    // 模型往往只给标题，卡片下半截永远是空的。
    const wantsTitleDetail = wantsList && request.blockType === 'features' && slot.name === 'items';
    const contextLine = Object.values(request.context ?? {})
      .filter((value) => value !== '')
      .slice(0, 2)
      .join(' / ');
    const system = isDeck
      ? '你在写演示文稿上的文字：短、具体、能一眼读完。' +
        '只输出成品内容本身——不要解释、不要标题前缀、不要 Markdown、不要编号。' +
        '不要出现"这里展示""由填充器生成"这类元话语。' +
        '不要套话（打造/赋能/引领/震撼/焕新/开启新篇章/让我们一起），每句至少含一个具体信息。'
      : '你是网页文案撰写者。只输出成品内容本身，不要解释、不要标题前缀、不要 Markdown 代码块。' +
        '不要输出字段名或提示词标签（如"主按钮：""副标题：""行动文字："）——那些是给排版看的，不是给访客看的。' +
        '不要空话套话（打造/赋能/引领/震撼/焕新/开启新篇章/让我们一起），' +
        '每句至少含一个具体信息（人名、地点、数字、事实）；标题不要复用页面目标里的整句。';
    const scene = isDeck ? '这份演示文稿的主题' : '页面目标';
    const contextHint =
      contextLine === '' ? '' : `本页已写内容（措辞不要重复）：${contextLine}\n`;
    const user = wantsList
      ? `${scene}：${goal}\n${contextHint}` +
        `请为「${slot.description}」写 ${count} 条，每行一条，不要编号，每条不超过 20 字` +
        (wantsTitleDetail ? '，每条写成「标题|一句说明」两段，用竖线分隔' : '') +
        '；条目之间不要同义重复。'
      : isDeck
        ? `${scene}：${goal}\n${contextHint}请写「${slot.description}」。一句话，不要空话，不要用"我们"开头。`
        : `${scene}：${goal}\n${contextHint}请写「${slot.description}」。要具体，不要空话。`;

    runtime.log('调用生成层填充 slot', { blockId: request.blockId, slot: slot.name });
    const response = await llm.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: isDeck ? 0.8 : 0.7,
      ...(isDeck ? { maxTokens: wantsList ? 260 : 80 } : {}),
      signal: runtime.signal,
    });
    const text = response.text.trim();
    if (text === '') return null;
    if (!wantsList) {
      const line = firstMeaningfulLine(text);
      if (line === '') return null;
      // 标题类只取第一行并截断：模型经常把整段话塞进标题槽，
      // 于是封面标题变成三行，版式直接塌掉。
      return { text: slot.type === 'title' ? line.slice(0, TITLE_LIMIT) : line.slice(0, TEXT_LIMIT) };
    }

    /*
     * 列表型：**宽松收取**。
     *
     * 早先这里要求 `items.length === count`，一个不多一个不少。后果是
     * 模型给的条数只要差一条，整块就回落到确定性填充器——而那份兜底内容
     * 是"条目 1：与目标直接相关的一项"这种**元文本**，比少一条难看得多。
     * 真正该守的只有两条：条数落在版式能容纳的区间内（由填充器校验），
     * 以及每条都是**内容**而不是模型的自言自语。
     */
    const items = toListItems(text, count);
    if (items.length < 2) return null;
    return { items };
  };
}

/**
 * 一次最多生成几张图。
 *
 * 图集按张计费：决策层即使要 8 张，也只真生成 4 张，剩下的用占位——
 * 上限在这里而不是提示词里，因为"模型答应了但账单没人看"是更糟的失败。
 */
const MAX_GENERATED_IMAGES = 2;

interface ImageSlotRequest {
  readonly goal: string;
  readonly blockType: string;
  readonly slotName: string;
  readonly slotType: string;
  readonly description: string;
  readonly count: number;
  readonly context: Readonly<Record<string, string>>;
  /** 决策层的选择：生成 / 网上找图 / 占位。省略时按环境变量。 */
  readonly source?: 'generative' | 'web' | 'deterministic' | undefined;
}

/**
 * 给一个图片 slot 真生成图片。
 *
 * 两步：**先让文本模型写提示词，再按提示词逐张生图**。
 * 提示词不写死成"一张好看的图"——它要结合页面目标与这一块已经写好的文案，
 * 否则整页会出现四张风格各异的通用插画。
 */
async function generateImagesForSlot(
  llm: LlmClient,
  runtime: ToolRuntime,
  request: ImageSlotRequest,
): Promise<GenerateSlotResult | null> {
  const decided = request.source;
  const envMode = (process.env['MEDIASANDBOX_IMAGE_SOURCE'] ?? 'decision').toLowerCase();
  // 决策层选了什么就听什么；它没选（自由模式/旧数据）时才看环境变量。
  const mode: 'generate' | 'web' | 'mixed' =
    decided === 'web'
      ? 'web'
      : decided === 'generative'
        ? 'mixed' // 选"生成"时允许失败后回落搜图，别让一个坏请求拖垮整页
        : envMode === 'bing'
          ? 'web'
          : envMode === 'mixed'
            ? 'mixed'
            : 'generate';
  const wanted =
    request.slotType === 'list-image'
      ? Math.min(Math.max(request.count, 1), MAX_GENERATED_IMAGES)
      : 1;

  // 生成优先：明确选了生成；或混合模式下的首屏主视觉（那一张最值得独一无二）。
  const generateFirst = mode === 'generate' || (mode === 'mixed' && request.slotType === 'image');
  if (generateFirst && llm.generateImage !== undefined) {
    const generated = await generateViaModel(llm, runtime, request, wanted);
    if (generated.length > 0) {
      return request.slotType === 'image'
        ? { imageBytes: generated[0]!.bytes, imageMime: generated[0]!.mime }
        : { images: generated };
    }
    runtime.log('生图未成功，改用 Bing 搜图');
  }

  // ── 网上找图（Bing）──────────────────────────────────────────────
  // 先用关键词搜候选，再逐张下载。任何一张失败都不拖垮整块：
  // 已经拿到的照用；一张都没拿到就回落占位（选"生成"的才已试过生图）。
  {
    // 查询词不能直接用 slot 的声明描述（"图片，每张一行提示词"搜不出东西）：
    // 先去掉这些内部词，再补上这一块已经写好的标题/正文作为语境。
    const generic = /(图片|配图|每张一行提示词|每行一条|主视觉图|提示词|一行一条)/g;
    const contextText = Object.values(request.context)
      .filter((value) => value !== '')
      .slice(0, 1)
      .join(' ');
    const cleaned = `${contextText} ${request.description.replace(generic, ' ')}`
      .replace(request.goal, '')
      .replace(/\s+/g, ' ')
      .trim();
    // 按块类型补一个稳定的画面关键词：只靠"介绍/主视觉图"搜出来的往往是资讯配图。
    const sceneWord =
      request.blockType === 'hero'
        ? '校园 主楼 全景'
        : request.blockType === 'gallery'
          ? '校园 风景'
          : '';
    const parts = [request.goal, cleaned, sceneWord]
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const query = [...new Set(parts)].join(' ').slice(0, 80);
    // 候选多取一些：网图可能 403/不是图片，取 2× 数量才不至于一张失败就回落。
    const urls = takeBingUrls(request.goal, await bingImageUrls(query), wanted * 2);
    runtime.log(`Bing 搜图「${query}」：取 ${urls.length} 张（已避开本次用过的图）`);
    const found: { bytes: Uint8Array; mime: string }[] = [];
    for (const [index, url] of urls.entries()) {
      if (found.length >= wanted) break;
      runtime.log(`下载图片 ${index + 1}/${urls.length}`, { url });
      const image = await withImageSlot(() => fetchImageBytes(url)).catch(() => null);
      if (image !== null) {
        found.push(image);
        runtime.log(`图片 ${index + 1} 完成（${Math.round(image.bytes.length / 1024)} KB）`);
      }
    }
    if (found.length > 0) {
      return request.slotType === 'image'
        ? { imageBytes: found[0]!.bytes, imageMime: found[0]!.mime }
        : { images: found };
    }
  }

  runtime.log('Bing 一张都没拿到，回落占位');
  return null;
}

/** 走图像模型生成若干张；失败逐张回落，返回真正拿到的那些。 */
async function generateViaModel(
  llm: LlmClient,
  runtime: ToolRuntime,
  request: ImageSlotRequest,
  wanted: number,
): Promise<{ bytes: Uint8Array; mime: string }[]> {
  if (llm.generateImage === undefined) return [];
  const prompts = await craftImagePrompts(llm, runtime, { ...request, count: wanted });
  const generated: { bytes: Uint8Array; mime: string }[] = [];
  for (const [index, prompt] of prompts.entries()) {
    runtime.log(`生图 ${index + 1}/${prompts.length}：${prompt}`);
    try {
      // 并发上限 2：本地代理同时排太多图会互相拖慢，最后一起超时。
      const response = await withImageSlot(() =>
        llm.generateImage!({
          prompt,
          // 单图（首屏主视觉）用横向，图集用方形：横向适合当页面主视觉/背景，
          // 方形裁成网格更不容易变形。
          size: request.slotType === 'list-image' ? '1024x1024' : '1536x1024',
          n: 1,
          // 单张 90s 上限：本地代理偶发挂住时，不能让首屏一直等到节点超时，
          // 到点就切 Bing/占位，页面至少能出。
          signal: AbortSignal.any([
            ...(runtime.signal === undefined ? [] : [runtime.signal]),
            AbortSignal.timeout(90_000),
          ]),
        }),
      );
      const image = response.images[0];
      if (image === undefined) continue;
      generated.push({ bytes: image.bytes, mime: image.mimeType });
      runtime.log(
        `生图 ${index + 1}/${prompts.length} 完成（${Math.round(image.bytes.length / 1024)} KB）`,
      );
    } catch (error) {
      // 生图失败不拖垮整块：这一张回落占位，原因留在运行日志里。
      runtime.log(
        `生图失败，回落占位：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return generated;
}

/** 同时在跑的图片请求上限。生图/下载都走它，避免把本地代理打爆。 */
const MAX_CONCURRENT_IMAGES = 2;
let activeImageTasks = 0;
const imageWaiters: (() => void)[] = [];

async function withImageSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeImageTasks >= MAX_CONCURRENT_IMAGES) {
    await new Promise<void>((resolve) => imageWaiters.push(resolve));
  }
  activeImageTasks += 1;
  try {
    return await task();
  } finally {
    activeImageTasks -= 1;
    imageWaiters.shift()?.();
  }
}

const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0';

/**
 * 同一个目标下已经用过的图片 URL。
 *
 * 作用是**跨 slot 去重**：首屏和两个图集可能命中同一批搜索结果，
 * 不去重就会出现"首屏和图集第一张是同一栋楼"。按 goal 分组：
 * 换一个目标就该允许复用图片。
 */
const bingUsedByGoal = new Map<string, Set<string>>();

/** 从候选里**同步预留**若干张（先标记已用，再下载），避免并发节点拿到同一张。 */
function takeBingUrls(goal: string, urls: readonly string[], count: number): string[] {
  let used = bingUsedByGoal.get(goal);
  if (used === undefined) {
    used = new Set<string>();
    bingUsedByGoal.set(goal, used);
  }
  const picked: string[] = [];
  for (const url of urls) {
    if (picked.length >= count) break;
    if (used.has(url)) continue;
    used.add(url);
    picked.push(url);
  }
  return picked;
}

/** 从 Bing 图片搜索结果里抠出原图地址。只做一次搜索，结果在进程内缓存。 */
const bingUrlCache = new Map<string, string[]>();

async function bingImageUrls(query: string): Promise<string[]> {
  const cached = bingUrlCache.get(query);
  if (cached !== undefined) return cached;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const response = await fetch(url, {
    headers: { 'user-agent': BING_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Bing 搜索失败 HTTP ${response.status}`);
  const html = (await response.text()).replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  const urls: string[] = [];
  // 结果页里原图地址长这样：murl":"https://...（部分版本是 \"murl\":\"...\"）
  for (const match of html.matchAll(/"murl"\s*:\s*"(https?:[^"]+)"/g)) {
    const candidate = match[1];
    if (candidate !== undefined && !urls.includes(candidate)) urls.push(candidate);
  }
  bingUrlCache.set(query, urls);
  return urls;
}

async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const response = await fetch(url, {
    headers: { 'user-agent': BING_UA, referer: 'https://www.bing.com/' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
  const mime = response.headers.get('content-type') ?? '';
  if (!mime.startsWith('image/')) throw new Error(`不是图片：${mime}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2_000) throw new Error(`图片太小（${bytes.length} B）`);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('图片超过 8 MB');
  return { bytes, mime: mime.split(';')[0]! };
}

/** 让文本模型写提示词；失败就用兜底提示词，不让"没问题可问"变成没图。 */
async function craftImagePrompts(
  llm: LlmClient,
  runtime: ToolRuntime,
  request: ImageSlotRequest,
): Promise<string[]> {
  const contextLine = Object.values(request.context)
    .filter((value) => value !== '')
    .slice(0, 3)
    .join(' / ');
  const fallback =
    `${request.goal}——${request.description}；高品质游戏宣传主视觉，电影级光影，` +
    '构图干净、有留白，画面中不出现任何文字、水印或标志';

  try {
    const response = await llm.complete({
      messages: [
        {
          role: 'system',
          content:
            '你在为网页撰写图像生成提示词。只输出提示词本身，一行一条，' +
            '不要编号、不要解释、不要引号。',
        },
        {
          role: 'user',
          content:
            `页面目标：${request.goal}\n` +
            `这一块的文案：${contextLine === '' ? '（暂无）' : contextLine}\n` +
            `需要为「${request.description}」准备 ${request.count} 张配图。\n` +
            `写出 ${request.count} 条中文提示词：每条 40 字以内，写清画面主体、构图、光线与风格；` +
            '画面中不要出现任何文字、水印、logo；整体质感统一为高品质游戏宣传主视觉。',
        },
      ],
      temperature: 0.9,
      maxTokens: 240,
      signal: runtime.signal,
    });
    const lines = response.text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter((line) => line !== '');
    if (lines.length > 0) {
      return Array.from({ length: request.count }, (_, index) => {
        const base = lines[index] ?? lines[index % lines.length]!;
        return request.count === 1 ? base : `${base}（第 ${index + 1} 张，换一个视角）`;
      });
    }
  } catch (error) {
    runtime.log(
      `生图提示词生成失败，用兜底提示词：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return Array.from({ length: request.count }, (_, index) =>
    request.count === 1 ? fallback : `${fallback}（第 ${index + 1} 张，换一个视角）`,
  );
}

/** 标题槽的字符上限。超过就会把版式挤坏。 */
const TITLE_LIMIT = 40;/** 正文/引文槽的字符上限。 */
const TEXT_LIMIT = 300;

/**
 * 清掉模型输出里的"非内容"：
 *
 *   - chatml / 特殊控制符（`<|im_end|>`、`<|im_start|>`）——本地模型常把它们
 *     当正文吐出来，直接渲染就是页面上出现一串尖括号；
 *   - 模型**自己续写的下一轮**（`<|im_start|>user 请写…`）——从第一个
 *     `im_start` 起全部丢掉：那之后的内容不属于这一项；
 *   - 空行与前后的引号/项目符号。
 */
function sanitizeGenerated(text: string): string {
  return text
    .replace(/<\|?im_start\|?>[\s\S]*$/i, ' ')
    .replace(/<\|[^|>]*\|>/g, ' ')
    // 模型会把 slot 说明当内容抄进来（"底下一行小字：…"、"图注：…"）。
    // 这是**元话语**，印在页面上等于把提示词泄漏给观众。
    .replace(/^[\s"'“”「」]*(?:底下一行小字|图注|备注|说明|标题|正文|副标题|眉标|页脚|主按钮|行动按钮|按钮文字|按钮文案|按钮|行动文字|CTA)[:：]\s*/i, '')
    // 模型也爱把字段名挂在正文后面（"原神宣传网页｜标题"）。
    .replace(/[\s｜|]+(?:标题|副标题|正文|按钮|按钮文字|说明|文案)\s*$/i, '')
    .replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/g, '')
    .replace(/\r/g, '');
}

/** 取第一行有意义的内容（标题类槽用）。 */
function firstMeaningfulLine(text: string): string {
  const clean = sanitizeGenerated(text);
  for (const line of clean.split('\n')) {
    const value = line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim();
    if (value !== '' && !looksLikeInstruction(value)) return value;
  }
  return '';
}

/**
 * 把模型的一整段输出切成"内容条目"。
 *
 * 丢掉的不是"格式不对的行"，而是**不像内容**的行：指令复述、要求说明、
 * 只剩标点的行。宁可少一条，也不要把"请写章节名"印在页面上。
 */
function toListItems(text: string, count: number): string[] {
  const items: string[] = [];
  for (const line of sanitizeGenerated(text).split('\n')) {
    const value = line
      .replace(/^\s*(?:[-*•·]|\d+[.、)])\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (value === '' || looksLikeInstruction(value)) continue;
    if (value.length > TEXT_LIMIT) continue;
    if (items.includes(value)) continue;
    items.push(value);
    if (items.length >= count) break;
  }
  return items;
}

/** 这一行像"模型在复述要求"而不是"内容"吗。 */
function looksLikeInstruction(line: string): boolean {
  return /^(?:请|写|注意|要求|格式|示例|例如|输出|不要|只能|需要)[\s:：]/.test(line) || /请写「|不要编号/.test(line);
}

/**
 * 装一页。
 *
 * 入参 `blocks` 是**扇入**：多个 `fill-block` 节点的产出聚成一个数组，
 * **数组顺序就是页面顺序**。这是全仓库唯一一处多对一的数据流——
 * 没有它，结构化制作在计划层面就退化成"一个大节点里填所有块"。
 */
export function createAssemblePageTool(blocks: BlockRegistry): ToolRegistration {
  return {
    spec: {
      id: 'assemble-page',
      label: '组装结构化页面',
      description:
        '把各区块的填充结果按顺序组装成一个完整 HTML 页面，并做结构校验，写入 artifacts/index.html',
      envTypes: ['webpage'],
      role: 'transform',
      category: 'structured',
      inputs: [
        { name: 'pageJson', type: 'text', required: true, description: '页面骨架 JSON（不含已填内容）' },
        { name: 'blocks', type: 'json', required: true, description: '按页面顺序排列的已填充 block 列表' },
        { name: 'title', type: 'text', required: false, description: '文档标题' },
        { name: 'annotate', type: 'boolean', required: false, description: '是否标注每块的来源' },
      ],
      outputs: [
        { name: 'html', type: 'text', required: true, description: '完整页面 HTML' },
        { name: 'file', type: 'file', required: true, description: '产物相对路径' },
        { name: 'blockCount', type: 'number', required: true, description: '页面上有几块' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const pageJson = requireString(runtime.inputs, 'pageJson', 'assemble-page');
      const rawBlocks = runtime.inputs['blocks'];
      if (!Array.isArray(rawBlocks)) {
        throw new ToolError(
          '工具 assemble-page 的 blocks 入参不是数组。' +
            '它应当由多个 fill-block 节点的产出扇入而成',
          'EXECUTION_FAILED',
          'assemble-page',
        );
      }

      const skeleton = parseJson<PageSpec>(pageJson, 'assemble-page', '页面骨架');

      // 扇入来的每一项是 fill-block 的 `block` 端口，即一段 JSON 文本。
      // 逐个解析并**校验形态**：某一项坏了要能指出是第几项，而不是笼统地说"组装失败"。
      const filled: BlockInstance[] = [];
      for (const [i, item] of rawBlocks.entries()) {
        if (typeof item !== 'string') {
          throw new ToolError(
            `blocks 第 ${i + 1} 项不是字符串（实际 ${typeof item}），扇入的应当是 fill-block 的 block 产出`,
            'EXECUTION_FAILED',
            'assemble-page',
          );
        }
        const parsed = parseJson<BlockInstance>(item, 'assemble-page', `第 ${i + 1} 个 block`);
        if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
          throw new ToolError(
            `blocks 第 ${i + 1} 项缺少 id 或 type 字段，不是合法的 block`,
            'EXECUTION_FAILED',
            'assemble-page',
          );
        }
        filled.push(parsed);
      }

      const page: PageSpec = { ...skeleton, blocks: filled };
      // 渲染之前先校验结构。放到渲染后查，错误会埋进 HTML 里，肉眼看不出来。
      validatePageSpec(page, blocks);

      const title =
        typeof runtime.inputs['title'] === 'string' && runtime.inputs['title'] !== ''
          ? runtime.inputs['title']
          : page.goal;
      const annotate = boolInput(runtime.inputs, 'annotate', false);

      // 把池子交给渲染器：池子里查得到、但没有专属渲染器的 block（自定义 block）
      // 走通用渲染。不传的话它们会落成"未支持的 block 类型"占位——
      // 于是"选得到、填得了、页面上却什么都没有"。
      const html = renderPage(page, { title, annotate, blocks });
      const file = 'artifacts/index.html';
      await runtime.sandbox.writeFile(runtime.handle, file, html);

      const blockTypes = filled.map((b) => b.type).join(' → ');
      return {
        outputs: { html, file, blockCount: filled.length },
        artifacts: await runtime.sandbox.collectArtifacts(runtime.handle),
        summary: `组装页面 ${file}（${filled.length} 块：${blockTypes}，${html.length} 字符）`,
      };
    },
  };
}

/**
 * 截图：**把已经落到沙盒里的页面拍成一张 PNG**。
 *
 * 与"装配页面"分开成一个节点，是因为它是**可选的**：默认不跑（零成本、零依赖），
 * 显式要求时才挂在组装节点后面。真浏览器接入前后，这个节点的位置与语义都不变。
 *
 * 入参 `file` 默认取 `artifacts/index.html`——即装配节点刚写下的那一份。
 * 截图驱动决定"怎么拍"：占位驱动产出确定性的示意图，真实驱动要浏览器。
 */
export function createScreenshotPageTool(driver: ScreenshotDriver): ToolRegistration {
  return {
    spec: {
      id: 'screenshot-page',
      label: '页面截图',
      description: '把页面渲染成一张 PNG 图片，写入 artifacts/screenshot.png',
      envTypes: ['webpage'],
      role: 'transform',
      category: 'structured',
      inputs: [
        { name: 'file', type: 'text', required: false, description: '要截图的页面路径' },
        // 只用于内容指纹：截图工具本来是从沙盒读文件，但缓存键只看入参，
        // 不把页面内容接进来就会出现"页面变了、截图还是上一张"。
        { name: 'html', type: 'text', required: false, description: '页面 HTML（仅用于缓存指纹）' },
        { name: 'width', type: 'number', required: false, description: '视口宽度' },
        { name: 'height', type: 'number', required: false, description: '视口高度' },
      ],
      outputs: [
        { name: 'file', type: 'text', required: true, description: '截图产物相对路径' },
        { name: 'driver', type: 'text', required: true, description: '产出它的驱动名' },
        { name: 'placeholder', type: 'boolean', required: true, description: '是否是占位图' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const source =
        typeof runtime.inputs['file'] === 'string' && runtime.inputs['file'] !== ''
          ? (runtime.inputs['file'] as string)
          : 'artifacts/index.html';

      const html = await runtime.sandbox
        .readFile(runtime.handle, source)
        .then((bytes) => new TextDecoder().decode(bytes))
        .catch(() => undefined);
      if (html === undefined) {
        throw new ToolError(
          `工具 screenshot-page 找不到要截图的页面: ${source}`,
          'EXECUTION_FAILED',
          'screenshot-page',
        );
      }

      const width =
        typeof runtime.inputs['width'] === 'number' ? runtime.inputs['width'] : DEFAULT_VIEWPORT.width;
      const height =
        typeof runtime.inputs['height'] === 'number'
          ? runtime.inputs['height']
          : DEFAULT_VIEWPORT.height;

      const shot = await driver.capture({
        html,
        width,
        height,
        // 把沙盒一并交给驱动：真浏览器要**在沙盒那一侧**渲染，
        // 而不是把用户页面拿到宿主机上跑一遍。
        sandbox: { provider: runtime.sandbox, handle: runtime.handle },
        pagePath: source,
      });
      const file = 'artifacts/screenshot.png';
      await runtime.sandbox.writeFile(runtime.handle, file, shot.bytes);

      return {
        outputs: { file, driver: shot.driver, placeholder: shot.placeholder },
        artifacts: await runtime.sandbox.collectArtifacts(runtime.handle),
        // 占位这件事要写在摘要里：一张占位图和一张真截图在文件列表里长得一样，
        // 不说明的话，事后没人能判断"当时到底有没有真渲染"。
        summary:
          `截图 ${file}（${shot.width}×${shot.height}，${shot.bytes.byteLength} 字节，` +
          (shot.placeholder ? `占位驱动 ${shot.driver}：未接入真实浏览器` : `驱动 ${shot.driver}`) +
          `）`,
      };
    },
  };
}

/**
 * 透传一块：把已有的块 JSON 原样交出去。
 *
 * "定点重做"里，**没有**被点名的块不该再被填一遍（那既花钱又可能把好内容改坏），
 * 但它们仍要进组装节点的扇入口——而扇入口只认节点产出。于是需要一个什么都不做、
 * 只把既有内容递下去的节点。
 *
 * 它刻意不做任何加工：内容从哪来、对不对，都是调用方（重做入口）的事。
 */
export function createPassthroughBlockTool(): ToolRegistration {
  return {
    spec: {
      id: 'passthrough-block',
      label: '透传已有区块',
      description: '把已有的区块内容原样交给组装节点，用于定点重做时保留其余区块',
      envTypes: ['webpage'],
      role: 'transform',
      category: 'structured',
      inputs: [
        { name: 'blockJson', type: 'text', required: true, description: '既有的区块 JSON' },
      ],
      outputs: [{ name: 'block', type: 'json', required: true, description: '原样的区块' }],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const blockJson = requireString(runtime.inputs, 'blockJson', 'passthrough-block');
      const block = parseJson<BlockInstance>(blockJson, 'passthrough-block', '区块');
      if (typeof block.id !== 'string' || typeof block.type !== 'string') {
        throw new ToolError(
          '工具 passthrough-block 的 blockJson 缺少 id 或 type',
          'EXECUTION_FAILED',
          'passthrough-block',
        );
      }
      return {
        outputs: { block: blockJson },
        artifacts: [],
        summary: `透传区块 ${block.id}（${block.type}）`,
      };
    },
  };
}

/**
 * 结构化制作链路的工具全集。与 `BUILTIN_TOOLS` 分开，只在 webpage 环境装配。
 *
 * 传进来的 `blocks` 必须是**这一次运行真正在用的那个池子** ——
 * 包括服务层装了外部来源 block 的那个。传错了就会重现"选得到、填不了"的断链。
 */
export function createStructuredTools(
  blocks: BlockRegistry,
  // 缺省用占位驱动：既有调用方（测试、单机脚本）不必被迫提供一个驱动，
  // 而"什么都配不了也能跑通"这条底线保持不变。
  screenshotDriver: ScreenshotDriver = defaultScreenshotDriver(),
): readonly ToolRegistration[] {
  return [
    createWritePageTool(blocks),
    createFillBlockTool(blocks),
    createAssemblePageTool(blocks),
    createPassthroughBlockTool(),
    createScreenshotPageTool(screenshotDriver),
  ].sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1));
}

/**
 * 默认工具集：装在**内置 block 池**上，截图走占位驱动。
 *
 * 给不注入池子的调用方（测试、单机脚本）用。服务层应当改用
 * `createStructuredTools(它自己的 blocks, 它选的驱动)`。
 */
export const STRUCTURED_TOOLS: readonly ToolRegistration[] = createStructuredTools(
  createBlockRegistry(),
  defaultScreenshotDriver(),
);
