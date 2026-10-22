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
      const html = renderPosterHtml(brief, size);
      const file = `artifacts/poster-${size.id}.html`;
      await runtime.sandbox.writeFile(runtime.handle, file, html);
      return {
        outputs: { html, file },
        artifacts: [{ path: file, size: Buffer.byteLength(html, 'utf8'), mimeHint: 'text/html' }],
        summary: `排版 ${size.label}（${size.width}×${size.height}）`,
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

export function createPosterTools(driver: ScreenshotDriver): readonly ToolRegistration[] {
  return [createPosterBriefTool(), createPosterRenderTool(), createPosterExportTool(driver)];
}
