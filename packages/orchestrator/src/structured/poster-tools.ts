/**
 * 海报链路的三个工具：**执笔 → 排版 → 导出**。
 *
 * 拆成三个而不是一个大工具，理由与网页链路相同：
 *   - 文案可以单独重写（换标题不必重渲染）
 *   - 一个版式可以导出多个尺寸（渲染一次、导出多次）
 *   - 每一步都能在工作流里单独看状态、单独命中缓存
 *
 * 工具只做自己那一步：执笔不碰 HTML，排版不调模型，导出只负责截图。
 */
import { ToolError, type ToolRegistration, type ToolResult, type ToolRuntime } from '../tools/types.js';
import type { LlmClient } from '../llm/types.js';
import type { ScreenshotDriver } from '../render/screenshot.js';
import {
  DEFAULT_PALETTE,
  normalizeBrief,
  renderPosterHtml,
  resolvePosterSize,
  type PosterBrief,
} from './poster.js';
import { bingImageUrls, fetchImageBytes } from './tools.js';

function requireString(inputs: Readonly<Record<string, unknown>>, key: string, toolId: string): string {
  const value = inputs[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`工具 ${toolId} 缺少必需的字符串入参: ${key}`, 'EXECUTION_FAILED', toolId);
  }
  return value;
}

/** 执笔：把目标写成一份海报文案。 */
export function createPosterBriefTool(): ToolRegistration {
  return {
    spec: {
      id: 'poster-brief',
      label: '写一份海报文案',
      description: '按目标写主标题、副标题、3~4 条要点、行动语与落款，并给出一组配色',
      envTypes: ['image'],
      role: 'generate',
      category: 'poster',
      inputs: [
        { name: 'goal', type: 'text', required: true, description: '海报要表达的目标' },
        { name: 'tone', type: 'text', required: false, description: '语气要求' },
        { name: 'brand', type: 'text', required: false, description: '主办方/品牌' },
      ],
      outputs: [
        { name: 'brief', type: 'text', required: true, description: '海报文案 JSON' },
      ],
      costHint: 'slow',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      if (runtime.llm === undefined) {
        throw new ToolError('海报执笔需要生成层，但本次运行没有提供 LlmClient', 'EXECUTION_FAILED', 'poster-brief');
      }
      const goal = requireString(runtime.inputs, 'goal', 'poster-brief');
      const tone = typeof runtime.inputs['tone'] === 'string' ? runtime.inputs['tone'] : '';
      const brand = typeof runtime.inputs['brand'] === 'string' ? runtime.inputs['brand'] : '';

      const brief = await writeBrief(runtime.llm, { goal, tone, brand, signal: runtime.signal });
      return {
        outputs: { brief: JSON.stringify(brief) },
        artifacts: [],
        summary: `海报文案：${brief.headline}（${brief.points.length} 条要点）`,
      };
    },
  };
}

async function writeBrief(
  llm: LlmClient,
  args: { goal: string; tone: string; brand: string; signal?: AbortSignal | undefined },
): Promise<PosterBrief> {
  const system = [
    '你是海报文案撰写者。只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
    '规则：',
    '1. headline 不超过 14 字，要有画面感，不要口号套话（打造/赋能/引领/震撼/焕新）。',
    '2. subheadline 一句话，不超过 40 字，说清"给谁、什么时候、在哪"。',
    '3. points 写 3 条，每条不超过 20 字，是具体信息（时间/地点/名额/亮点），不要同义重复。',
    '4. cta 不超过 8 字，动词开头。',
    '5. footer 写主办方与日期，不超过 30 字。',
    '6. palette 给四个 #RRGGBB：from/to 是背景渐变（深色为宜），accent 是强调色，ink 是文字色。',
  ].join('\n');
  const user = [
    `海报目标：${args.goal}`,
    args.tone === '' ? '' : `语气：${args.tone}`,
    args.brand === '' ? '' : `主办方：${args.brand}`,
    '输出形状：{"headline":"...","subheadline":"...","points":["...","...","..."],"cta":"...","footer":"...","palette":{"from":"#0f172a","to":"#1e3a5f","accent":"#38bdf8","ink":"#f8fafc"}}',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const response = await llm.complete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    responseFormat: 'json',
    temperature: 0.8,
    maxTokens: 700,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });

  const raw = response.text.trim();
  if (raw === '') return normalizeBrief({ headline: args.goal, palette: DEFAULT_PALETTE });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    parsed = undefined;
  }
  return normalizeBrief(parsed ?? { headline: args.goal });
}

/** 排版：一份文案 → 一个尺寸的 HTML。 */
export function createPosterRenderTool(): ToolRegistration {
  return {
    spec: {
      id: 'poster-render',
      label: '排版一张海报',
      description: '把海报文案放进版式，产出指定尺寸的 HTML',
      envTypes: ['image'],
      role: 'transform',
      category: 'poster',
      inputs: [
        { name: 'brief', type: 'text', required: true, description: '海报文案 JSON' },
        { name: 'sizeId', type: 'text', required: false, description: '尺寸 id：story/square/banner/a4' },
        { name: 'background', type: 'text', required: false, description: '背景图（data URI 或 http 地址）' },
        { name: 'logo', type: 'text', required: false, description: '叠在图上的品牌落款' },
      ],
      outputs: [
        { name: 'html', type: 'text', required: true, description: '海报 HTML' },
        { name: 'file', type: 'file', required: true, description: 'HTML 相对路径' },
      ],
      costHint: 'fast',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const briefRaw = requireString(runtime.inputs, 'brief', 'poster-render');
      const sizeId = typeof runtime.inputs['sizeId'] === 'string' ? runtime.inputs['sizeId'] : '';
      const size = resolvePosterSize(sizeId === '' ? undefined : sizeId);

      let parsed: unknown;
      try {
        parsed = JSON.parse(briefRaw);
      } catch {
        throw new ToolError('poster-render 的 brief 不是合法 JSON', 'EXECUTION_FAILED', 'poster-render');
      }
      const brief = normalizeBrief(parsed);
      const background =
        typeof runtime.inputs['background'] === 'string' && runtime.inputs['background'].trim() !== ''
          ? runtime.inputs['background']
          : undefined;
      const logo = typeof runtime.inputs['logo'] === 'string' ? runtime.inputs['logo'] : undefined;
      const html = renderPosterHtml(brief, size, {
        ...(background !== undefined ? { background } : {}),
        ...(logo !== undefined && logo.trim() !== '' ? { logo } : {}),
      });
      const file = `artifacts/poster-${size.id}.html`;
      await runtime.sandbox.writeFile(runtime.handle, file, html);
      return {
        outputs: { html, file },
        artifacts: [{ path: file, size: Buffer.byteLength(html, 'utf8'), mimeHint: 'text/html' }],
        summary: `排版 ${size.label}（${size.width}×${size.height}）${background === undefined ? '' : '，带背景图'}`,
      };
    },
  };
}

/** 导出：一个尺寸的 HTML → PNG。 */
export function createPosterExportTool(driver: ScreenshotDriver): ToolRegistration {
  return {
    spec: {
      id: 'poster-export',
      label: '导出一张海报图',
      description: '把排版好的海报 HTML 截成 PNG，写入 artifacts/poster-<尺寸>.png',
      envTypes: ['image'],
      role: 'transform',
      category: 'poster',
      inputs: [
        { name: 'file', type: 'text', required: true, description: '海报 HTML 的相对路径' },
        { name: 'sizeId', type: 'text', required: false, description: '尺寸 id（决定画布像素）' },
        // 内容指纹：导出读的是沙盒文件，但缓存键只看入参。
        // 不把 HTML 接进来，就会出现"换背景了、导出的还是上一张"。
        { name: 'html', type: 'text', required: false, description: '海报 HTML（仅用于缓存指纹）' },
      ],
      outputs: [{ name: 'path', type: 'file', required: true, description: 'PNG 相对路径' }],
      costHint: 'medium',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const file = requireString(runtime.inputs, 'file', 'poster-export');
      const sizeId = typeof runtime.inputs['sizeId'] === 'string' ? runtime.inputs['sizeId'] : '';
      const size = resolvePosterSize(sizeId === '' ? undefined : sizeId);
      const outputPath = `artifacts/poster-${size.id}.png`;

      const shot = await driver.capture({
        html: '',
        width: size.width,
        height: size.height,
        pagePath: file,
        sandbox: { provider: runtime.sandbox, handle: runtime.handle },
        outputPath,
      });
      await runtime.sandbox.writeFile(runtime.handle, outputPath, shot.bytes);

      return {
        outputs: { path: outputPath },
        artifacts: [{ path: outputPath, size: shot.bytes.length, mimeHint: 'image/png' }],
        summary:
          `导出 ${size.label}：${shot.width}×${shot.height}` +
          `，${Math.round(shot.bytes.length / 1024)} KB${shot.placeholder ? '（占位图，未接真浏览器）' : ''}`,
      };
    },
  };
}

/**
 * 找一张背景图。
 *
 * 只做搜图、不生图：生图是逐张计费的，而海报背景用一张真实场景照片往往更合适。
 * 找不到就返回空串——渲染器会用纯渐变兜底，海报照样出得来。
 */
export function createPosterBackgroundTool(): ToolRegistration {
  return {
    spec: {
      id: 'poster-background',
      label: '找一张背景图',
      description: '按目标/查询词搜一张实景图，作为海报背景；找不到就留空走渐变兜底',
      envTypes: ['image'],
      role: 'generate',
      category: 'poster',
      inputs: [
        { name: 'goal', type: 'text', required: true, description: '海报目标（也当作默认查询词）' },
        { name: 'query', type: 'text', required: false, description: '自定义查询词' },
        { name: 'source', type: 'text', required: false, description: 'web（默认）| none（不要背景）' },
      ],
      outputs: [
        { name: 'image', type: 'text', required: true, description: 'data URI；空串表示没有背景' },
        { name: 'from', type: 'text', required: true, description: '来源：web / none / fallback' },
      ],
      costHint: 'medium',
    },
    execute: async (runtime: ToolRuntime): Promise<ToolResult> => {
      const goal = requireString(runtime.inputs, 'goal', 'poster-background');
      const source = typeof runtime.inputs['source'] === 'string' ? runtime.inputs['source'] : 'web';
      if (source === 'none') {
        return {
          outputs: { image: '', from: 'none' },
          artifacts: [],
          summary: '背景：按配置不使用图片',
        };
      }
      const query = typeof runtime.inputs['query'] === 'string' && runtime.inputs['query'].trim() !== ''
        ? runtime.inputs['query'].trim()
        : goal;

      let urls: string[] = [];
      try {
        urls = await bingImageUrls(query);
      } catch (error) {
        runtime.log(`搜图失败：${error instanceof Error ? error.message : String(error)}`);
      }

      // 候选按顺序试：前几张 403/超时是常态，试到一张能用为止。
      for (const url of urls.slice(0, 4)) {
        try {
          const image = await fetchImageBytes(url);
          const dataUri = `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
          runtime.log(`背景图：${Math.round(image.bytes.length / 1024)} KB`);
          return {
            outputs: { image: dataUri, from: 'web' },
            artifacts: [],
            summary: `背景图 ${Math.round(image.bytes.length / 1024)} KB（查询：${query}）`,
          };
        } catch {
          /* 换下一张 */
        }
      }

      return {
        outputs: { image: '', from: 'fallback' },
        artifacts: [],
        summary: `没有找到可用背景图（查询：${query}），改用渐变`,
      };
    },
  };
}

export function createPosterTools(driver: ScreenshotDriver): readonly ToolRegistration[] {
  return [
    createPosterBriefTool(),
    createPosterBackgroundTool(),
    createPosterRenderTool(),
    createPosterExportTool(driver),
  ];
}
