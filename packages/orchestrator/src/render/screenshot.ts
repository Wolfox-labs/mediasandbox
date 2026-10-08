/**
 * 截图驱动：**页面 → PNG**。
 *
 * ## 为什么先只有占位实现
 *
 * 真实截图需要一个浏览器（容器里的 chromium，或宿主机上的浏览器），而浏览器是
 * 几百 MB 的依赖、还要动镜像。这里先把**接口与接缝**落下来，并给一个确定性的
 * 占位实现——理由与生图那条链路完全一致（`render-image` 与 `solid-image`）：
 *
 *   > 能力是可选增强，链路本身不能依赖它。
 *
 * 于是"组装 → 截图 → 产物清单 → 前端预览"这条管道现在就是通的、可测的、零成本的；
 * 将来接入真浏览器时，只需要再写一个 `ScreenshotDriver` 实现，链条上其余部分不动。
 *
 * ## 占位图必须一眼看得出来是占位
 *
 * 它长得像一张"带斜纹的灰卡片"，而不是一张模糊的页面——**不能让人误以为截图失败**。
 * 同时它逐字节确定：同样的尺寸永远是同一张图，可复现、可缓存、测试不用放宽比较。
 */
import { deflateSync } from 'node:zlib';

export interface ScreenshotRequest {
  /** 要截的页面 HTML。占位实现不看内容，真实实现要拿它去渲染。 */
  readonly html: string;
  readonly width: number;
  readonly height: number;
}

export interface Screenshot {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 产出它的驱动名。写进产物说明里，便于回答"这张图是怎么来的"。 */
  readonly driver: string;
  /** 是否是占位图（不是真实渲染结果）。 */
  readonly placeholder: boolean;
}

export interface ScreenshotDriver {
  readonly name: string;
  /** 该驱动产出的是不是占位图。 */
  readonly placeholder: boolean;
  capture(request: ScreenshotRequest): Promise<Screenshot>;
}

/** 默认视口。与常见桌面浏览器接近，够看清版式。 */
export const DEFAULT_VIEWPORT: { readonly width: number; readonly height: number } = {
  width: 1280,
  height: 800,
};

// ── PNG 编码 ────────────────────────────────────────────────────────────
//
// 自己写而不是引依赖：要的只是"一张纯色 + 斜纹的图"，为它装一个图像库不划算，
// 而 PNG 的最小可用实现就是一个 CRC32 加一次 deflate——node 自带 zlib。

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个 PNG 块：长度 + 类型 + 数据 + CRC。 */
function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * 编码一张 8 位真彩 PNG。
 *
 * `pixel(x, y)` 返回 `[r, g, b]`——逐像素给值，是因为占位图本来就是"画出来的"，
 * 而画法属于调用方。行首那个 0 是 PNG 的过滤器类型（None）。
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0; // filter: None
    cursor += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[cursor] = r;
      raw[cursor + 1] = g;
      raw[cursor + 2] = b;
      cursor += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：真彩 RGB
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 非隔行

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

// ── 占位驱动 ────────────────────────────────────────────────────────────

const BG: readonly [number, number, number] = [244, 246, 249];
const HATCH: readonly [number, number, number] = [216, 222, 232];
const EDGE: readonly [number, number, number] = [170, 180, 195];
const HEADER: readonly [number, number, number] = [230, 236, 244];

/** 一页"还没有真实渲染"的示意图：边框 + 页头带 + 斜纹。 */
function placeholderPixel(
  x: number,
  y: number,
  width: number,
  height: number,
): readonly [number, number, number] {
  if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) return EDGE;
  if (y < 44) return HEADER;
  if ((x + y) % 24 < 2) return HATCH;
  return BG;
}

export class PlaceholderScreenshotDriver implements ScreenshotDriver {
  readonly name = 'placeholder';
  readonly placeholder = true;

  async capture(request: ScreenshotRequest): Promise<Screenshot> {
    const width = Math.max(1, Math.round(request.width));
    const height = Math.max(1, Math.round(request.height));
    return {
      bytes: encodePng(width, height, (x, y) => placeholderPixel(x, y, width, height)),
      width,
      height,
      driver: this.name,
      placeholder: true,
    };
  }
}

/** 默认驱动。将来接真浏览器时，把这里换掉即可，调用方不必改。 */
export function defaultScreenshotDriver(): ScreenshotDriver {
  return new PlaceholderScreenshotDriver();
}
