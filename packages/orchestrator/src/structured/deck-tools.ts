/**
 * 演示文稿链路的两个工具：**填一页** 与 **装成一份**。
 *
 * 与网页链路的 `fill-block` / `assemble-page` 是**平行的两套**，不是复用同一对：
 *
 * | | 网页 | 演示文稿 |
 * |---|---|---|
 * | 中间结构落盘 | `src/blocks/<id>.json` | `src/slides/<id>.json` |
 * | 产物 | `artifacts/index.html`（单页长文） | `artifacts/deck.html` + `artifacts/deck.json`（多页） |
 * | 渲染器 | `renderPage` | `renderDeck` |
 * | 环境 | `webpage` | `slides` |
 *
 * 为什么不开一个 `mode` 参数把两套合成一套：产物形态与校验规则都不同
 * （一页 HTML 与"N 页各 16:9"），合成一个工具会让 `envTypes`、产物路径、
 * 校验三处都出现条件分支，而分支写错的表现是"另一种模态静默产出错的产物"。
 *
 * **决策与填充这两层是共用的**：版式池同样是 `BlockSpec`，填充同样走 `fillBlock`。
 * 所以"新增模态"的成本主要在渲染器与工具声明，不在决策逻辑——这是这套结构
 * 有意换来的性质。
 */
import { ToolError, type ToolRegistration, type ToolResult, type ToolRuntime } from '../tools/types.js';
import { readText } from '@mediasandbox/sandbox';
import { DEFAULT_VIEWPORT, defaultScreenshotDriver, type ScreenshotDriver } from '../render/screenshot.js';
import { createSlideRegistry } from './deck-spec.js';
import { renderDeck } from './deck-renderer.js';
import { resolveDeckTheme } from './deck-theme.js';
import type { BlockRegistry } from './block-spec.js';
import { deriveBrand, fillBlock } from './filler.js';
import { validatePageSpec, type BlockInstance, type PageSpec } from './page-spec.js';
import { makeSlotGenerator } from './tools.js';

/** 演示文稿链路的工具 id。集中定义，避免散落的字符串。 */
export const DECK_TOOLS = {
  fillSlide: 'fill-slide',
  assembleDeck: 'assemble-deck',
  verify: 'verify-artifact',
  screenshot: 'screenshot-deck',
} as const;

/** 读一个必需的字符串入参。 */
function requireString(inputs: Readonly<Record<string, unknown>>, key: string, toolId: string): string {
  const value = inputs[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`工具 ${toolId} 缺少必需入参 ${key}`, 'EXECUTION_FAILED', toolId);
  }
  return value;
}

function boolInput(inputs: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = inputs[key];
  return typeof value === 'boolean' ? value : fallback;
}

function parseJson<T>(text: string, toolId: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ToolError(
      `工具 ${toolId} 的${what}不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      'EXECUTION_FAILED',
      toolId,
    );
  }
}

/**
 * 各 slot 由谁填的规则与网页链路**完全一致**，所以直接用同一个生成器，
 * 不在这里另写一份：两份逻辑迟早会漂移，而漂移的表现是"演示文稿的图被偷偷生成了"。
 */

/** 填一页：把一个已定型的版式的各个 slot 填成实际内容。 */
export function createFillSlideTool(layouts: BlockRegistry): ToolRegistration {
  return {
    spec: {
      id: DECK_TOOLS.fillSlide,
      label: '填充一页幻灯片',
      description: '把结构里一页已定型的版式填成实际内容，产出一份带内容的页 JSON',
      envTypes: ['slides'],
      role: 'generate',
      category: 'structured',
      inputs: [
        { name: 'slideJson', type: 'text', required: true, description: '该页的 JSON' },
        { name: 'goal', type: 'text', required: true, description: '整份文稿的目标，填充内容的依据' },
        { name: 'brand', type: 'text', required: false, description: '主题名' },
        { name: 'index', type: 'number', required: false, description: '该页在文稿里的序号' },
        {
          name: 'useGenerative',
          type: 'boolean',
          required: false,
          description: '是否用生成层写文案。false 时全部确定性填充，零成本',
        },
      ],
      outputs: [
        { name: 'slide', type: 'text', required: true, description: '填好的页 JSON' },
        { name: 'file', type: 'file', required: true, description: '页 JSON 的相对路径' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const slideJson = requireString(runtime.inputs, 'slideJson', DECK_TOOLS.fillSlide);
      const goal = requireString(runtime.inputs, 'goal', DECK_TOOLS.fillSlide);
      const brand = typeof runtime.inputs['brand'] === 'string' ? runtime.inputs['brand'] : '';
      const indexRaw = runtime.inputs['index'];
      const index =
        typeof indexRaw === 'number' && Number.isFinite(indexRaw) ? Math.round(indexRaw) : 0;
      const useGenerative = boolInput(runtime.inputs, 'useGenerative', false);

      const slide = parseJson<BlockInstance>(slideJson, DECK_TOOLS.fillSlide, '页结构');
      if (!layouts.has(slide.type)) {
        throw new ToolError(
          `页 ${slide.id} 的版式未注册: ${slide.type}。` +
            `演示文稿版式池必须与规划器用同一个（服务层注入 slideLayouts）`,
          'EXECUTION_FAILED',
          DECK_TOOLS.fillSlide,
        );
      }

      const generate =
        useGenerative && runtime.llm !== undefined
          ? makeSlotGenerator(runtime.llm, runtime, 'slides')
          : undefined;

      const counts: Record<string, number> = {};
      for (const [name, value] of Object.entries(slide.slots)) {
        counts[name] =
          value.kind === 'list'
            ? value.items.length
            : value.kind === 'list-image'
              ? value.refs.length
              : 1;
      }

      const filled = await fillBlock({
        spec: layouts.get(slide.type),
        block: slide,
        goal,
        brand: brand === '' ? deriveBrand(goal) : brand,
        options: generate === undefined ? {} : { generate },
        index,
        counts,
      });

      const relPath = `src/slides/${slide.id}.json`;
      const outJson = JSON.stringify(filled.block, null, 2);
      await runtime.sandbox.writeFile(runtime.handle, relPath, outJson);

      for (const warning of filled.warnings) runtime.log(warning);
      if (useGenerative && runtime.llm === undefined) {
        runtime.log('要求生成式填充但本次运行未提供 LlmClient，已全部走确定性填充');
      }

      return {
        outputs: { slide: outJson, file: relPath },
        artifacts: [],
        summary:
          `填充第 ${index + 1} 页(${slide.type})，${Object.keys(filled.block.slots).length} 个 slot，` +
          `${filled.generativeCalls} 次生成调用`,
      };
    },
  };
}

/** 装成一份：把各页按顺序拼成一份可放映的演示文稿。 */
export function createAssembleDeckTool(layouts: BlockRegistry): ToolRegistration {
  return {
    spec: {
      id: DECK_TOOLS.assembleDeck,
      label: '组装演示文稿',
      description:
        '把各页的填充结果按顺序拼成一份 16:9 可放映的 HTML 演示文稿，写入 artifacts/deck.html，结构另存 artifacts/deck.json',
      envTypes: ['slides'],
      role: 'transform',
      category: 'structured',
      inputs: [
        { name: 'deckJson', type: 'text', required: true, description: '文稿骨架 JSON（不含已填内容）' },
        { name: 'slides', type: 'json', required: true, description: '按页序排列的已填充页列表' },
        { name: 'title', type: 'text', required: false, description: '文稿标题' },
        {
          name: 'themeId',
          type: 'text',
          required: false,
          description: '视觉主题 id（决策模型选的）。未知 id 回落到默认主题',
        },
      ],
      outputs: [
        { name: 'html', type: 'text', required: true, description: '完整文稿 HTML' },
        { name: 'file', type: 'file', required: true, description: '产物相对路径' },
        { name: 'slideCount', type: 'number', required: true, description: '一共几页' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const deckJson = requireString(runtime.inputs, 'deckJson', DECK_TOOLS.assembleDeck);
      const rawSlides = runtime.inputs['slides'];
      if (!Array.isArray(rawSlides)) {
        throw new ToolError(
          `工具 ${DECK_TOOLS.assembleDeck} 的 slides 入参不是数组。` +
            '它应当由多个 fill-slide 节点的产出扇入而成',
          'EXECUTION_FAILED',
          DECK_TOOLS.assembleDeck,
        );
      }

      const skeleton = parseJson<PageSpec>(deckJson, DECK_TOOLS.assembleDeck, '文稿骨架');

      const filled: BlockInstance[] = [];
      for (const [i, item] of rawSlides.entries()) {
        if (typeof item !== 'string') {
          throw new ToolError(
            `slides 第 ${i + 1} 项不是字符串（实际 ${typeof item}），扇入的应当是 fill-slide 的 slide 产出`,
            'EXECUTION_FAILED',
            DECK_TOOLS.assembleDeck,
          );
        }
        const parsed = parseJson<BlockInstance>(item, DECK_TOOLS.assembleDeck, `第 ${i + 1} 页`);
        if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
          throw new ToolError(
            `slides 第 ${i + 1} 项缺少 id 或 type 字段，不是合法的一页`,
            'EXECUTION_FAILED',
            DECK_TOOLS.assembleDeck,
          );
        }
        filled.push(parsed);
      }

      const deck: PageSpec = { ...skeleton, blocks: filled };
      validatePageSpec(deck, layouts);

      const title =
        typeof runtime.inputs['title'] === 'string' && runtime.inputs['title'] !== ''
          ? runtime.inputs['title']
          : deck.goal;

      const themeId =
        typeof runtime.inputs['themeId'] === 'string' && runtime.inputs['themeId'] !== ''
          ? runtime.inputs['themeId']
          : undefined;

      const html = renderDeck(deck, { title, ...(themeId !== undefined ? { themeId } : {}) });
      const file = 'artifacts/deck.html';
      await runtime.sandbox.writeFile(runtime.handle, file, html);

      /*
       * 结构另存一份，**并把"是谁决定的"一起写进去**：
       *   - `themeId` / `themeLabel`：视觉方向是哪次决策选的
       *   - `layoutSequence`：页序——产物本身就能看出"决策模型排了什么"
       *
       * 不塞进 HTML 的注释里：那既不好读，也容易被当成纯文本处理时丢掉。
       */
      const deckFile = 'artifacts/deck.json';
      const resolvedTheme = resolveDeckTheme(themeId);
      await runtime.sandbox.writeFile(
        runtime.handle,
        deckFile,
        JSON.stringify(
          {
            ...deck,
            themeId: resolvedTheme.id,
            themeLabel: resolvedTheme.label,
            layoutSequence: filled.map((page) => page.type),
          },
          null,
          2,
        ),
      );

      const layoutSeq = filled.map((page) => page.type).join(' → ');
      return {
        outputs: { html, file, slideCount: filled.length },
        artifacts: await runtime.sandbox.collectArtifacts(runtime.handle),
        summary: `组装演示文稿 ${filled.length} 页：${layoutSeq}（主题 ${resolvedTheme.label}）`,
      };
    },
  };
}

/**
 * 把文稿截成一张图（首屏）。
 *
 * 与网页链路的 `screenshot-page` 分开：它换的是 `file` 入参的默认值，
 * 并复用同一个驱动。合成一个工具会让"截图截哪个文件"变成隐式判断。
 */
export function createScreenshotDeckTool(driver: ScreenshotDriver): ToolRegistration {
  return {
    spec: {
      id: DECK_TOOLS.screenshot,
      label: '把演示文稿首页截图',
      description: '把组装好的文稿首页截成一张图，写入 artifacts/deck.png',
      envTypes: ['slides'],
      role: 'transform',
      category: 'structured',
      inputs: [
        { name: 'file', type: 'text', required: false, description: '要截图的文稿路径' },
        { name: 'width', type: 'number', required: false, description: '视口宽度' },
        { name: 'height', type: 'number', required: false, description: '视口高度' },
      ],
      outputs: [
        { name: 'path', type: 'file', required: true, description: '截图相对路径' },
      ],
      costHint: 'medium',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const file =
        typeof runtime.inputs['file'] === 'string' && runtime.inputs['file'] !== ''
          ? runtime.inputs['file']
          : 'artifacts/deck.html';
      // 直接读沙盒里的那一份文件交给驱动渲染——**不要重新 renderDeck 一份**：
      // 那样"被截图的文稿"与"交付的文稿"可能不是同一份字节。
      const html = await readText(runtime.sandbox, runtime.handle, file);
      const shot = await driver.capture({
        html,
        pagePath: file,
        width: numberInput(runtime.inputs, 'width', DEFAULT_VIEWPORT.width),
        height: numberInput(runtime.inputs, 'height', DEFAULT_VIEWPORT.height),
        sandbox: { provider: runtime.sandbox, handle: runtime.handle },
        // 直说这张图要落在哪：默认路径会让真驱动写出一份 screenshot.png，
        // 而这里再存一份 deck.png —— 同一张图在产物里出现两次。
        outputPath: 'artifacts/deck.png',
      });
      const path = 'artifacts/deck.png';
      // 占位驱动只在内存里生成字节，不写文件；真驱动已经写好了同一份。
      // 两种都写一次是幂等的（内容相同），但省掉判断更不容易出错。
      await runtime.sandbox.writeFile(runtime.handle, path, shot.bytes);
      return {
        outputs: { path },
        artifacts: await runtime.sandbox.collectArtifacts(runtime.handle),
        summary: `截了 ${file}（驱动 ${shot.driver}${shot.placeholder ? '，占位实现' : ''}）`,
      };
    },
  };
}

function numberInput(inputs: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * 演示文稿链路需要注册的全部工具。
 *
 * `layoutPool` 省略时退回内置版式池——与 `createStructuredTools` 同一条理由：
 * 池子必须与规划器用的是同一个，否则外部来源的版式永远选不到。
 */
export function createDeckTools(
  layoutPool?: BlockRegistry,
  screenshotDriver: ScreenshotDriver = defaultScreenshotDriver(),
): ToolRegistration[] {
  const layouts = layoutPool ?? createSlideRegistry();
  return [
    createFillSlideTool(layouts),
    createAssembleDeckTool(layouts),
    createScreenshotDeckTool(screenshotDriver),
  ];
}
