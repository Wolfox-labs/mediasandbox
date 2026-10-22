/**
 * 用户素材库。
 *
 * ## 为什么单独一块
 *
 * 产物目录（`projects/`）是"这次跑出来的东西"，素材是"我手里本来就有、想让它进画面的东西"。
 * 两者的生命周期不同：产物跟着运行走，素材要被多次运行复用，所以落在
 * `data/assets/` 下，按内容哈希命名——同一张图传两次得到同一个 id，不会堆一堆副本。
 *
 * ## 只收图片，且按魔数判类型
 *
 * 相信 `content-type` 是不够的：浏览器给 `.png` 打上的 type 未必对，脚本更是随便写。
 * 落盘前用魔数复核一次（`sniffImageMime`），不符的直接拒——否则后面填进页面的
 * 会是一段说自己是 PNG 的任意字节。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sniffImageMime } from '@mediasandbox/orchestrator';

/** 一张已入库的素材。 */
export interface StoredAsset {
  readonly assetId: string;
  /** 绝对路径。工具侧按这个路径读字节。 */
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly createdAt: number;
}

/** 允许的图片类型 → 扩展名。白名单而不是黑名单：多收一种要显式加一行。 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** id 形状固定，既是内容寻址，也顺手挡住了 `../` 这类路径穿越。 */
const ID_PATTERN = /^a-[0-9a-f]{16}$/;

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export interface AssetStore {
  /** 落盘并返回入库记录。同样的字节只会存一份。 */
  save(bytes: Uint8Array, declaredMime: string): Promise<StoredAsset>;
  /** 按 id 找文件。找不到返回 undefined。 */
  locate(assetId: string): Promise<StoredAsset | undefined>;
  list(): Promise<StoredAsset[]>;
}

export function createAssetStore(dir: string): AssetStore {
  const ready = mkdir(dir, { recursive: true });

  function toStored(assetId: string, ext: string, bytes: number): StoredAsset {
    return {
      assetId,
      path: path.join(dir, `${assetId}${ext}`),
      mime: EXT_TO_MIME[ext] ?? 'application/octet-stream',
      bytes,
      createdAt: Date.now(),
    };
  }

  return {
    async save(bytes, declaredMime) {
      if (bytes.length === 0) throw new Error('素材是空的（0 字节）');
      if (bytes.length > MAX_ASSET_BYTES) {
        throw new Error(
          `素材 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_ASSET_BYTES / 1024 / 1024}MB`,
        );
      }
      // 魔数优先：`declaredMime` 只用来在魔数认不出来时决定要不要拒。
      const sniffed = sniffImageMime(bytes);
      const mime = EXT_BY_MIME[sniffed] === undefined ? '' : sniffed;
      if (mime === '') {
        throw new Error(`不认识的图片格式（声明为 ${declaredMime}，魔数识别为 ${sniffed}）`);
      }
      const ext = EXT_BY_MIME[mime]!;
      const assetId = `a-${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}`;
      await ready;
      const target = path.join(dir, `${assetId}${ext}`);
      // 同内容再传一次：直接复用，不重复写盘。
      const existing = await readFile(target).catch(() => null);
      if (existing === null) await writeFile(target, bytes);
      return toStored(assetId, ext, bytes.length);
    },

    async locate(assetId) {
      if (!ID_PATTERN.test(assetId)) return undefined;
      await ready;
      const names = await readdir(dir).catch(() => [] as string[]);
      const hit = names.find((name) => name.startsWith(`${assetId}.`));
      if (hit === undefined) return undefined;
      const ext = path.extname(hit);
      const full = path.join(dir, hit);
      const bytes = await readFile(full).catch(() => null);
      if (bytes === null) return undefined;
      return toStored(assetId, ext, bytes.length);
    },

    async list() {
      await ready;
      const names = await readdir(dir).catch(() => [] as string[]);
      const out: StoredAsset[] = [];
      for (const name of names) {
        const ext = path.extname(name);
        const stem = path.basename(name, ext);
        if (!ID_PATTERN.test(stem)) continue;
        const stat = await readFile(path.join(dir, name)).catch(() => null);
        if (stat === null) continue;
        out.push(toStored(stem, ext, stat.length));
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    },
  };
}
