/**
 * 内置工具集。
 *
 * 这些是编排层可以直接调用的原子操作。每个工具都真实干活：调生成层、写沙盒、
 * 跑命令、收集产物。
 *
 * 设计原则：**优先用确定性代码，只在真正需要生成时才调 LLM**。比如"写文件"
 * 是纯确定性操作，不该让模型生成一遍。
 */
import path from 'node:path';
import { ToolError, type ToolRegistration, type ToolRuntime, type ToolResult } from './types.js';
import { LlmError } from '../llm/types.js';

/** 把产物路径规范成 artifacts/ 下的相对路径，并阻止逃逸。 */
function artifactPath(name: string): string {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.includes('..')) {
    throw new ToolError(`产物名不允许包含 ..: ${name}`, 'EXECUTION_FAILED', 'artifact-name');
  }
  return cleaned.startsWith('artifacts/') ? cleaned : `artifacts/${cleaned}`;
}

/**
 * MIME → 文件后缀。
 *
 * 存在的意义：产物后缀要与**真实内容格式**一致。曾经把供应商返回的任意图片
 * 一律写成 `image.png`，结果 `.png` 里装着 JPEG —— 预览能显示（浏览器会嗅探），
 * 但下载下来用别的工具打开就报格式错。
 */
function extensionForMime(mimeType: string): string {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
      return 'png';
    default:
      // 认不出来就用 png —— 图像生成端点绝大多数默认返回 png。
      return 'png';
  }
}

function requireString(inputs: Readonly<Record<string, unknown>>, key: string, toolId: string): string {
  const value = inputs[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`工具 ${toolId} 缺少必需的字符串入参: ${key}`, 'EXECUTION_FAILED', toolId);
  }
  return value;
}

/** 调生成层，失败时转成 ToolError 并保留原因分类。 */
async function generate(
  runtime: ToolRuntime,
  systemPrompt: string,
  userPrompt: string,
  toolId: string,
  temperature = 0.7,
): Promise<string> {
  if (runtime.llm === undefined) {
    throw new ToolError(
      `工具 ${toolId} 需要生成层，但本次运行未提供 LlmClient`,
      'EXECUTION_FAILED',
      toolId,
    );
  }
  runtime.log('调用生成层', { toolId, promptChars: userPrompt.length });
  try {
    const response = await runtime.llm.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      signal: runtime.signal,
    });
    if (response.text.trim() === '') {
      throw new ToolError(
        `生成层返回空内容（finishReason=${response.finishReason}）`,
        'EXECUTION_FAILED',
        toolId,
      );
    }
    return response.text;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const reason = error instanceof LlmError ? error.reason : 'UNKNOWN';
    throw new ToolError(
      `生成层调用失败（${reason}）: ${error instanceof Error ? error.message : String(error)}`,
      'EXECUTION_FAILED',
      toolId,
      { cause: error },
    );
  }
}

/** 跑一条沙盒命令；非零退出即失败，带上 stderr 便于兜底判断。 */
async function runOrFail(
  runtime: ToolRuntime,
  toolId: string,
  command: string,
  cwd?: string,
): Promise<void> {
  runtime.log('执行命令', { toolId, command });
  const result = await runtime.sandbox.exec(runtime.handle, command, {
    timeoutMs: runtime.timeoutMs,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  if (result.timedOut) {
    throw new ToolError(
      `命令超时（${runtime.timeoutMs}ms）: ${command}`,
      'EXECUTION_FAILED',
      toolId,
    );
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 800);
    throw new ToolError(
      `命令退出码 ${result.exitCode}: ${command}\n${detail}`,
      'EXECUTION_FAILED',
      toolId,
    );
  }
}

async function collect(runtime: ToolRuntime) {
  return await runtime.sandbox.collectArtifacts(runtime.handle);
}

// ── 文案类 ───────────────────────────────────────────────────────────────

const templateCopy: ToolRegistration = {
  spec: {
    id: 'template-copy',
    label: '用模板拼文案',
    description:
      '不调用生成模型，用固定结构把目标与要点拼成文档。确定性、零延迟，适合结构化的说明类内容',
    envTypes: ['copy', 'frontend'],
    role: 'generate',
    category: 'copy',
    inputs: [
      { name: 'goal', type: 'text', required: true, description: '写作目标' },
      { name: 'points', type: 'text', required: false, description: '要点，每行一条' },
    ],
    outputs: [{ name: 'text', type: 'text', required: true, description: '文案正文' }],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const goal = requireString(runtime.inputs, 'goal', 'template-copy');
    const raw = typeof runtime.inputs['points'] === 'string' ? runtime.inputs['points'] : '';
    const points = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const lines: string[] = [`# ${goal}`, ''];
    if (points.length > 0) {
      for (const point of points) lines.push(`- ${point}`);
    } else {
      lines.push('（要点待补充）');
    }
    const text = lines.join('\n');
    await runtime.sandbox.writeFile(runtime.handle, artifactPath('copy.md'), text);
    return {
      outputs: { text },
      artifacts: await collect(runtime),
      summary: `模板拼出文案 ${text.length} 字符（未调用生成模型）`,
    };
  },
};

const draftCopy: ToolRegistration = {
  spec: {
    id: 'draft-copy',
    label: '撰写文案初稿',
    description: '根据目标与受众生成一段正文文案，写入 artifacts/copy.md',
    envTypes: ['copy', 'frontend'],
    role: 'generate',
    category: 'copy',
    inputs: [
      { name: 'goal', type: 'text', required: true, description: '写作目标' },
      { name: 'tone', type: 'text', required: false, description: '语气风格' },
    ],
    outputs: [{ name: 'text', type: 'text', required: true, description: '文案正文' }],
    costHint: 'medium',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const goal = requireString(runtime.inputs, 'goal', 'draft-copy');
    const tone = typeof runtime.inputs['tone'] === 'string' ? runtime.inputs['tone'] : '简洁、具体';
    const text = await generate(
      runtime,
      '你是中文文案撰写者。只输出成品文案本身，不要解释、不要标题前缀、不要 Markdown 代码块。',
      `目标：${goal}\n语气：${tone}\n\n请写出一段完整文案。`,
      'draft-copy',
    );
    await runtime.sandbox.writeFile(runtime.handle, artifactPath('copy.md'), text);
    return {
      outputs: { text },
      artifacts: await collect(runtime),
      summary: `生成文案 ${text.length} 字`,
    };
  },
};

const refineCopy: ToolRegistration = {
  spec: {
    id: 'refine-copy',
    label: '打磨文案',
    description: '对已有文案做精简、改语气或修正表达，覆盖写回 artifacts/copy.md',
    envTypes: ['copy', 'frontend'],
    role: 'transform',
    category: 'copy',
    inputs: [
      { name: 'text', type: 'text', required: true, description: '待打磨的文案' },
      { name: 'instruction', type: 'text', required: true, description: '打磨要求' },
    ],
    outputs: [{ name: 'text', type: 'text', required: true, description: '打磨后的文案' }],
    costHint: 'medium',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const text = requireString(runtime.inputs, 'text', 'refine-copy');
    const instruction = requireString(runtime.inputs, 'instruction', 'refine-copy');
    const refined = await generate(
      runtime,
      '你是中文编辑。只输出修改后的完整文案，不要说明你改了什么。',
      `要求：${instruction}\n\n原文：\n${text}`,
      'refine-copy',
    );
    await runtime.sandbox.writeFile(runtime.handle, artifactPath('copy.md'), refined);
    return {
      outputs: { text: refined },
      artifacts: await collect(runtime),
      summary: `打磨文案 ${text.length} → ${refined.length} 字`,
    };
  },
};

// ── 图像类 ───────────────────────────────────────────────────────────────

const solidImage: ToolRegistration = {
  spec: {
    id: 'solid-image',
    label: '生成纯色占位图',
    description:
      '不调用生成模型，用 Python 画一张纯色图并写上标题。用于占位或验证链路，确定性、零成本',
    envTypes: ['image'],
    role: 'generate',
    category: 'image',
    inputs: [
      { name: 'prompt', type: 'text', required: true, description: '标题文字' },
      { name: 'width', type: 'number', required: false, description: '宽度像素' },
      { name: 'height', type: 'number', required: false, description: '高度像素' },
    ],
    outputs: [
      { name: 'prompt', type: 'text', required: true, description: '标题' },
      { name: 'file', type: 'file', required: true, description: '图像文件相对路径' },
    ],
    requiresCommands: ['python'],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const title = requireString(runtime.inputs, 'prompt', 'solid-image');
    const num = (key: string, fallback: number): number => {
      const v = runtime.inputs[key];
      return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
    };
    const width = num('width', 512);
    const height = num('height', 512);
    // 用 Pillow 画图；标题经 repr 转义后写进脚本，避免引号注入。
    const script = [
      'from PIL import Image, ImageDraw',
      `im = Image.new("RGB", (${width}, ${height}), (32, 34, 38))`,
      'd = ImageDraw.Draw(im)',
      `title = ${JSON.stringify(title.slice(0, 120))}`,
      'd.text((24, 24), title, fill=(240, 240, 240))',
      'im.save("artifacts/image.png")',
      'print(im.size)',
    ].join('\n');
    await runtime.sandbox.writeFile(runtime.handle, 'out/_solid.py', script);
    await runOrFail(runtime, 'solid-image', 'python out/_solid.py');
    return {
      outputs: { prompt: title, file: artifactPath('image.png') },
      artifacts: await collect(runtime),
      summary: `生成占位图 ${width}x${height}（未调用生成模型）`,
    };
  },
};

const renderImage: ToolRegistration = {
  spec: {
    id: 'render-image',
    label: '按提示词渲染图像',
    description: '调用多模态生成能力渲染一张图，写入 artifacts/image.png',
    envTypes: ['image', 'frontend'],
    role: 'generate',
    category: 'image',
    inputs: [
      { name: 'prompt', type: 'text', required: true, description: '图像提示词' },
      { name: 'size', type: 'text', required: false, description: '尺寸，如 1024x1024' },
    ],
    outputs: [
      { name: 'prompt', type: 'text', required: true, description: '实际使用的提示词' },
      { name: 'file', type: 'file', required: true, description: '图像文件相对路径' },
    ],
    costHint: 'slow',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const prompt = requireString(runtime.inputs, 'prompt', 'render-image');
    if (runtime.llm === undefined) {
      throw new ToolError('渲染图像需要生成层', 'EXECUTION_FAILED', 'render-image');
    }

    const file = artifactPath('image.png');

    // ── 首选：真正的图像生成端点 ──────────────────────────────────────
    // `generateImage` 在 LlmClient 上是**可选能力**，不支持的实现不实现它。
    // 供应商差异（返回 b64 还是外链）由客户端吸收，这里只认字节。
    if (runtime.llm.generateImage !== undefined) {
      runtime.log('调用图像生成端点', { promptChars: prompt.length });
      const size = typeof runtime.inputs['size'] === 'string' ? runtime.inputs['size'] : undefined;
      const response = await runtime.llm.generateImage({
        prompt,
        ...(size !== undefined ? { size } : {}),
        ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
      });
      const first = response.images[0];
      if (first === undefined) {
        throw new ToolError('图像生成端点没有返回任何图像', 'EXECUTION_FAILED', 'render-image');
      }
      // 按供应商给的 MIME 决定后缀，避免 .png 装 JPEG 内容。
      const ext = extensionForMime(first.mimeType);
      const target = ext === 'png' ? file : artifactPath(`image.${ext}`);
      await runtime.sandbox.writeFile(runtime.handle, target, first.bytes);
      return {
        outputs: { prompt, file: target },
        artifacts: await collect(runtime),
        summary: `渲染图像 ${target}（${first.bytes.byteLength} 字节，${first.mimeType}）`,
      };
    }

    // ── 回落：文本补全 + 期待 data URL ────────────────────────────────
    // 只有部分供应商在 chat 响应里直接给 data URL 时才可行。
    runtime.log('生成层无图像端点，回落到文本补全', { promptChars: prompt.length });
    const response = await runtime.llm.complete({
      messages: [{ role: 'user', content: `生成图像：${prompt}` }],
      signal: runtime.signal,
    });

    const dataUrl = /^data:image\/(\w+);base64,(.+)$/s.exec(response.text.trim());

    // 拿不到图像数据就**失败**，不要把模型的文字回复当图片落盘。
    //
    // 这里曾经是"否则落盘占位文本"：接一个纯文本模型时，模型会回复
    // "我无法生成图像，但可以给你提示词…"，那段文字被当成 image.png 写出，
    // 于是产物清单里出现一个**后缀是 .png 但不是图片**的文件——
    // 预览打不开、下载下来是乱码，而且没有任何报错提示。
    // 宁可失败并说清原因，也不要产出伪装成图片的文本。
    if (dataUrl === null || dataUrl[2] === undefined) {
      const preview = response.text.trim().slice(0, 120).replace(/\s+/g, ' ');
      throw new ToolError(
        `生成层未返回图像数据（当前模型可能不支持图像生成）。` +
          `返回内容开头：${preview}${response.text.length > 120 ? '…' : ''}`,
        'EXECUTION_FAILED',
        'render-image',
      );
    }

    const format = dataUrl[1] ?? 'png';
    const target = format === 'png' ? file : artifactPath(`image.${format}`);
    await runtime.sandbox.writeFile(runtime.handle, target, Buffer.from(dataUrl[2], 'base64'));
    return {
      outputs: { prompt, file: target },
      artifacts: await collect(runtime),
      summary: `渲染图像 ${target}`,
    };
  },
};

// ── 前端类 ───────────────────────────────────────────────────────────────

const staticPageFromTemplate: ToolRegistration = {
  spec: {
    id: 'static-page-from-template',
    label: '用模板生成静态页',
    description:
      '不调用生成模型，直接用内置 HTML 模板与给定文案拼出页面。内容较朴素但确定性强、无延迟、零成本',
    envTypes: ['frontend'],
    role: 'generate',
    category: 'frontend',
    inputs: [
      { name: 'goal', type: 'text', required: true, description: '页面目标（用作标题）' },
      { name: 'copy', type: 'text', required: false, description: '页面正文文案' },
    ],
    outputs: [
      { name: 'html', type: 'text', required: true, description: '页面 HTML' },
      { name: 'file', type: 'file', required: true, description: '文件相对路径' },
    ],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const goal = requireString(runtime.inputs, 'goal', 'static-page-from-template');
    const copy = typeof runtime.inputs['copy'] === 'string' ? runtime.inputs['copy'] : '';
    // 转义后再嵌入，避免目标里的尖括号破坏结构。
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = copy !== '' ? esc(copy).replace(/\n{2,}/g, '</p><p>') : '（正文待补充）';
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(goal)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         line-height:1.7; color:#1a1a1a; background:#fff; }
  main { max-width: 46rem; margin: 0 auto; padding: 4rem 1.5rem; }
  h1 { font-size: 2rem; line-height:1.3; margin:0 0 1.5rem; }
  p { margin: 0 0 1.2rem; }
</style>
</head>
<body>
<main>
<h1>${esc(goal)}</h1>
<p>${body}</p>
</main>
</body>
</html>
`;
    const file = 'src/index.html';
    await runtime.sandbox.writeFile(runtime.handle, file, html);
    return {
      outputs: { html, file },
      artifacts: await collect(runtime),
      summary: `模板生成页面 ${file}（${html.length} 字符，未调用生成模型）`,
    };
  },
};

const scaffoldFrontend: ToolRegistration = {
  spec: {
    id: 'scaffold-frontend',
    label: '生成前端页面骨架',
    description: '在沙盒 src/ 下生成一个可直接打开的 HTML 页面骨架',
    envTypes: ['frontend'],
    role: 'generate',
    category: 'frontend',
    inputs: [
      { name: 'goal', type: 'text', required: true, description: '页面目标' },
      { name: 'copy', type: 'text', required: false, description: '页面文案' },
    ],
    outputs: [
      { name: 'html', type: 'text', required: true, description: '页面 HTML' },
      { name: 'file', type: 'file', required: true, description: '文件相对路径' },
    ],
    costHint: 'medium',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const goal = requireString(runtime.inputs, 'goal', 'scaffold-frontend');
    const copy = typeof runtime.inputs['copy'] === 'string' ? runtime.inputs['copy'] : '';
    const html = await generate(
      runtime,
      '你是前端工程师。只输出完整的单个 HTML 文件内容，内联 CSS，不要解释、不要代码块围栏。',
      `页面目标：${goal}\n${copy !== '' ? `页面文案：\n${copy}\n` : ''}\n请输出一个完整可打开的 HTML 文件。`,
      'scaffold-frontend',
    );
    const file = 'src/index.html';
    await runtime.sandbox.writeFile(runtime.handle, file, html);
    return {
      outputs: { html, file },
      artifacts: await collect(runtime),
      summary: `生成页面骨架 ${file}（${html.length} 字符）`,
    };
  },
};

const buildFrontend: ToolRegistration = {
  spec: {
    id: 'build-frontend',
    label: '构建前端产物',
    description: '把 src/ 下的页面复制到 artifacts/ 作为交付产物',
    envTypes: ['frontend'],
    role: 'execute',
    category: 'frontend',
    inputs: [{ name: 'entry', type: 'text', required: false, description: '入口文件，默认 src/index.html' }],
    outputs: [{ name: 'file', type: 'file', required: true, description: '产物相对路径' }],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const entry = typeof runtime.inputs['entry'] === 'string' && runtime.inputs['entry'] !== ''
      ? runtime.inputs['entry']
      : 'src/index.html';
    if (!(await runtime.sandbox.exists(runtime.handle, entry))) {
      throw new ToolError(`入口文件不存在: ${entry}`, 'EXECUTION_FAILED', 'build-frontend');
    }
    const bytes = await runtime.sandbox.readFile(runtime.handle, entry);
    const out = artifactPath('index.html');
    await runtime.sandbox.writeFile(runtime.handle, out, bytes);
    return {
      outputs: { file: out },
      artifacts: await collect(runtime),
      summary: `构建产物 ${out}（${bytes.byteLength} 字节）`,
    };
  },
};

// ── 图像处理类 ───────────────────────────────────────────────────────────

const processImage: ToolRegistration = {
  spec: {
    id: 'process-image',
    label: '图像后处理',
    description: '用 Python 对 in/ 下的图做缩放或格式转换，输出到 artifacts/',
    envTypes: ['image'],
    role: 'transform',
    category: 'image',
    inputs: [
      { name: 'source', type: 'text', required: true, description: '源图相对路径' },
      { name: 'width', type: 'number', required: false, description: '目标宽度像素' },
    ],
    outputs: [{ name: 'file', type: 'file', required: true, description: '产物相对路径' }],
    requiresCommands: ['python'],
    costHint: 'medium',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const source = requireString(runtime.inputs, 'source', 'process-image');
    if (!(await runtime.sandbox.exists(runtime.handle, source))) {
      throw new ToolError(`源图不存在: ${source}`, 'EXECUTION_FAILED', 'process-image');
    }
    const widthRaw = runtime.inputs['width'];
    const width = typeof widthRaw === 'number' && Number.isFinite(widthRaw) ? Math.round(widthRaw) : 512;
    const script = [
      'import sys',
      'from PIL import Image',
      `src = r"${source}"`,
      'im = Image.open(src)',
      `w = ${width}`,
      'if im.width > w:',
      '    im = im.resize((w, round(im.height * w / im.width)))',
      'im.save("artifacts/processed.png")',
      'print(f"{im.width}x{im.height}")',
    ].join('\n');
    await runtime.sandbox.writeFile(runtime.handle, 'out/_process.py', script);
    await runOrFail(runtime, 'process-image', 'python out/_process.py');
    return {
      outputs: { file: artifactPath('processed.png') },
      artifacts: await collect(runtime),
      summary: `图像处理后处理完成，宽度 ${width}`,
    };
  },
};

// ── 通用类 ───────────────────────────────────────────────────────────────

const writeFileTool: ToolRegistration = {
  spec: {
    id: 'write-file',
    label: '写入文件',
    description: '把给定内容原样写入沙盒内的某个文件（确定性操作，不调用生成层）',
    envTypes: ['copy', 'image', 'frontend'],
    role: 'transform',
    category: 'utility',
    inputs: [
      { name: 'path', type: 'text', required: true, description: '相对路径' },
      { name: 'content', type: 'text', required: true, description: '文件内容' },
    ],
    outputs: [{ name: 'file', type: 'file', required: true, description: '写入的相对路径' }],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const relPath = requireString(runtime.inputs, 'path', 'write-file');
    const content = requireString(runtime.inputs, 'content', 'write-file');
    await runtime.sandbox.writeFile(runtime.handle, relPath, content);
    return {
      outputs: { file: relPath },
      artifacts: [],
      summary: `写入 ${relPath}（${content.length} 字符）`,
    };
  },
};

const verifyArtifact: ToolRegistration = {
  spec: {
    id: 'verify-artifact',
    label: '校验产物',
    description: '检查 artifacts/ 下是否存在非空产物，作为交付前的最后一道检查',
    envTypes: ['copy', 'image', 'frontend'],
    role: 'verify',
    category: 'utility',
    inputs: [{ name: 'minFiles', type: 'number', required: false, description: '至少几个产物' }],
    outputs: [
      { name: 'ok', type: 'boolean', required: true, description: '是否通过' },
      { name: 'count', type: 'number', required: true, description: '产物个数' },
    ],
    costHint: 'fast',
  },
  execute: async (runtime): Promise<ToolResult> => {
    const raw = runtime.inputs['minFiles'];
    const minFiles = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 1;
    const artifacts = await collect(runtime);
    const nonEmpty = artifacts.filter((a) => a.size > 0);
    const ok = nonEmpty.length >= minFiles;
    if (!ok) {
      throw new ToolError(
        `产物校验失败：需要至少 ${minFiles} 个非空产物，实际 ${nonEmpty.length} 个`,
        'EXECUTION_FAILED',
        'verify-artifact',
      );
    }
    return {
      outputs: { ok, count: nonEmpty.length },
      artifacts,
      summary: `产物校验通过（${nonEmpty.length} 个非空产物）`,
    };
  },
};

/**
 * 内置工具全集。
 *
 * 每类环境都提供**两条路线**，这是刻意的设计：
 *   - 生成式（调模型）：质量高，慢，有成本
 *   - 确定性（模板/本地库）：朴素，但零延迟、零成本、完全可复现
 *
 * 有两条路线，决策层的 `choice` 才有真实的选择可做；而且当生成层不可用时，
 * 确定性路线就是可用的降级方案。
 */
export const BUILTIN_TOOLS: readonly ToolRegistration[] = [
  templateCopy,
  draftCopy,
  refineCopy,
  solidImage,
  renderImage,
  staticPageFromTemplate,
  scaffoldFrontend,
  buildFrontend,
  processImage,
  writeFileTool,
  verifyArtifact,
].sort((a, b) => (a.spec.id < b.spec.id ? -1 : 1));

export { path };
