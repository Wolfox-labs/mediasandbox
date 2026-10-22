/**
 * 把结构里的内联图片抽成**文件**，结构里只留相对路径。
 *
 * ## 为什么
 *
 * 演示文稿的结构（`deck.json`）此前把每张图的 base64 原样存了一遍：
 * 同一张图在 `deck.html` 里已经内联过一次，结构里再来一次，产物体积直接翻倍。
 * 一份 7 页、2 张图的文稿，两个产物各 2.7 MB，其中一半是重复的像素数据。
 *
 * 现在结构里只写 `assets/img-<hash>.png`，图片落到 `artifacts/assets/`：
 *   - 结构可读、可 diff、可转格式
 *   - 同一张图只落一次（按内容哈希去重）
 *   - **HTML 不受影响**：它是自包含产物，仍然内联，单文件能直接发出去
 *
 * ## 边界
 *
 * 只处理 `data:image/<png|jpeg|webp|gif>;base64,`。占位图是 SVG 的 data URI，
 * 体积小且是"可读的兜底"，保持原样——抽成文件反而丢了它的自解释性。
 */
import { createHash } from 'node:crypto';
import type { SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';

/** 只抽这几种位图；SVG 占位图留在原地。 */
const BASE64_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
};

export interface ExternalizeResult {
  /** 替换后的结构：图片字符串变成 `assets/img-xxx.png`。 */
  readonly value: unknown;
  /** 落盘的图片文件数（按内容去重后）。 */
  readonly files: number;
}

/**
 * 递归扫描结构，把 base64 图片落成文件并替换成相对路径。
 *
 * `dir` 是相对 `artifacts/` 的目录，默认 `assets`。
 */
export async function externalizeImages(args: {
  readonly sandbox: SandboxProvider;
  readonly handle: SandboxHandle;
  readonly value: unknown;
  readonly dir?: string;
}): Promise<ExternalizeResult> {
  const dir = args.dir ?? 'assets';
  const written = new Set<string>();
  let files = 0;

  const visit = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      const match = BASE64_IMAGE.exec(value);
      if (match === null) return value;
      const [, mime = 'png', rawBase64 = ''] = match;
      const bytes = Buffer.from(rawBase64.replace(/\s+/g, ''), 'base64');
      if (bytes.length === 0) return value;
      const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12);
      const ext = EXT_BY_MIME[mime] ?? 'png';
      const name = `img-${hash}.${ext}`;
      const relPath = `${dir}/${name}`;
      if (!written.has(relPath)) {
        written.add(relPath);
        await args.sandbox.writeFile(args.handle, `artifacts/${relPath}`, bytes);
        files += 1;
      }
      return relPath;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await visit(item));
      return out;
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = await visit(item);
      return out;
    }
    return value;
  };

  return { value: await visit(args.value), files };
}
