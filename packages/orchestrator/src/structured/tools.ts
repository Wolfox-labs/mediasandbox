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
import { deriveBrand, fillBlock } from './filler.js';
import { validatePageSpec, type BlockInstance, type PageSpec } from './page-spec.js';
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
        options: generate === undefined ? {} : { generate },
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
          `${filled.generativeCalls} 次生成调用`,
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
}) => Promise<{ readonly text?: string; readonly items?: readonly string[] } | null> {
  return async (request) => {
    const { slot, goal, count } = request;
    if (slot.type === 'image' || slot.type === 'list-image') return null;
    if (slot.type === 'link' || slot.type === 'literal') return null;

    const wantsList = slot.type === 'list-text';
    const isDeck = kind === 'slides';
    const system = isDeck
      ? '你在写演示文稿上的文字：短、具体、能一眼读完。' +
        '只输出成品内容本身——不要解释、不要标题前缀、不要 Markdown、不要编号。' +
        '不要出现"这里展示""由填充器生成"这类元话语。'
      : '你是网页文案撰写者。只输出成品内容本身，不要解释、不要标题前缀、不要 Markdown 代码块。';
    const scene = isDeck ? '这份演示文稿的主题' : '页面目标';
    const user = wantsList
      ? `${scene}：${goal}\n请为「${slot.description}」写 ${count} 条，每行一条，不要编号，每条不超过 20 字。`
      : isDeck
        ? `${scene}：${goal}\n请写「${slot.description}」。一句话，不要空话，不要用"我们"开头。`
        : `${scene}：${goal}\n请写「${slot.description}」。要具体，不要空话。`;

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

/** 标题槽的字符上限。超过就会把版式挤坏。 */
const TITLE_LIMIT = 40;
/** 正文/引文槽的字符上限。 */
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
    .replace(/^[\s"'“”「」]*(?:底下一行小字|图注|备注|说明|标题|正文|副标题|眉标|页脚)[:：]\s*/i, '')
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
