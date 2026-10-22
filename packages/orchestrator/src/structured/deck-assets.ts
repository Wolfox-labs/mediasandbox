/**
 * 演示文稿的图片素材位：三种来源，一个入口。
 *
 * ## 为什么需要这一层
 *
 * 版式里的 `image` / `list-image` 槽只认 `{ ref, alt }`，而图从哪来有三条完全
 * 不同的路：
 *
 *   1. **留空**——不给 ref。版式会画一个「设计过的空」提示框，用户自己放图。
 *   2. **用户上传 / 本地文件**——读成 data URI。产物仍然**自包含**：断网可看、
 *      单文件可发，这是部署形态决定的，不是洁癖。
 *   3. **生成或抓取**——外部工具产出字节流（生图、爬虫下载），同样落成 data URI。
 *
 * 三条路的**产物形态完全一样**，所以版式与渲染器不需要知道图从哪来。
 * 这一层只做一件事：把字节变成 `ImageRef`，并把体积问题暴露给调用方。
 *
 * ## 体积纪律
 *
 * data URI 是自包含的代价。`MAX_INLINE_BYTES` 默认 1.5MB：超过就**抛错而不是
 * 静默塞进去**——一份 19 页的稿子塞十张 8MB 的原图，产物会到 100MB 以上，
 * 打开就卡。要更大的图，调用方应自己先压。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImageRef } from './page-spec.js';

/** 单张图内联的上限（字节）。超过就让调用方去压，不在这里偷偷降质。 */
export const MAX_INLINE_BYTES = 1_500_000;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** 后缀 → mime。认不出来按 png 处理并交给体积检查兜底。 */
export function mimeOf(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

/** 字节 → data URI。这是三条路共同的落点。 */
export function toDataUri(bytes: Uint8Array, mime = 'image/png'): string {
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new Error(
      '图片 ' + bytes.byteLength + ' 字节超过内联上限 ' + MAX_INLINE_BYTES + '，请先压缩再内联',
    );
  }
  return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
}

/** 用户上传 / 本地文件：读盘 → data URI。alt 缺省用文件名，读屏器不至于念一串 base64。 */
export async function imageRefFromFile(filePath: string, alt?: string): Promise<ImageRef> {
  const bytes = await readFile(filePath);
  return { ref: toDataUri(bytes, mimeOf(filePath)), alt: alt ?? path.basename(filePath) };
}

/**
 * 生成或抓取：外部拿到的字节流直接转 ref。
 * 与 `imageRefFromFile` 共用同一条内联与体积规则——两条路不该有两套标准。
 */
export function imageRefFromBytes(bytes: Uint8Array, mime: string, alt = ''): ImageRef {
  return { ref: toDataUri(bytes, mime), alt };
}