/**
 * 最小 ZIP 写入器。
 *
 * ## 为什么自己写
 *
 * 导出产物需要一个 ZIP，但为此引入 `archiver` / `jszip` 这类依赖，
 * 换来的是几十个传递依赖 —— 而我们只需要一个**存储/压缩二选一、无加密、
 * 无 ZIP64** 的子集。ZIP 的格式是公开且稳定的，自己写反而更可控。
 *
 * ## 支持范围
 *
 *   - deflate（用内置 `node:zlib`）或 store（不压缩）
 *   - UTF-8 文件名（设了 flag bit 11，中文文件名在 Windows 资源管理器里能正确显示）
 *   - 单次写入内存后输出（产物总量是 MB 级，不需要流式）
 *
 * ## 不支持（明确声明，避免误用）
 *
 *   - ZIP64：单文件或总大小超过 4 GiB 会**报错**而不是产出坏包
 *   - 加密、分卷、目录项（空目录不会被写入）
 */

import { deflateRawSync } from 'node:zlib';

/** CRC32 查表，首次使用时构建。 */
let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable !== undefined) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** 计算 CRC32。ZIP 用它做完整性校验。 */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 包内路径，用 `/` 分隔。 */
  readonly path: string;
  readonly data: Uint8Array;
}

export interface ZipOptions {
  /**
   * 是否 deflate 压缩。默认 true。
   *
   * 图像 / 视频等已压缩格式再压一遍收益接近零，纯文本则收益明显。
   * 调用方可按内容类型选择，或干脆用它做"打包更快"的取舍。
   */
  readonly compress?: boolean | undefined;
  /** 打包内的时间戳。不传用当前时间。 */
  readonly date?: Date | undefined;
}

const MAX_ZIP32 = 0xffffffff;

/** 把 Date 转成 ZIP 用的 DOS 时间/日期对。 */
function toDosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 把若干文件打成 ZIP。
 *
 * @throws 当总大小或单个文件超过 4 GiB（需要 ZIP64，本实现不支持）
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Buffer {
  const compress = options.compress ?? true;
  const now = options.date ?? new Date();
  const { time: dosTime, date: dosDate } = toDosTime(now);

  // 先算总量，超 ZIP32 上限就明确报错 —— 宁可失败也不要产出坏包。
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.data.length > MAX_ZIP32) {
      throw new Error(`文件过大，需要 ZIP64（本实现不支持）: ${entry.path}`);
    }
    totalUncompressed += entry.data.length;
    if (totalUncompressed > MAX_ZIP32) {
      throw new Error('打包内容超过 4 GiB，需要 ZIP64（本实现不支持）');
    }
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const raw = Buffer.from(entry.data);

    let payload: Buffer;
    let method: number;
    if (compress && raw.length > 0) {
      // 压缩后反而更大时不划算，但为了 method 与数据一致，仍按压缩标记 —— 
      // 判断"要不要用 store"会让同一包内 method 混杂，收益不值这个复杂度。
      payload = deflateRawSync(raw, { level: 6 });
      method = 8;
    } else {
      payload = raw;
      method = 0;
    }

    // ── 本地文件头 ──────────────────────────────────────────────────
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6); // flag：文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 无 extra 字段

    localParts.push(local, nameBytes, payload);

    // ── 中央目录项 ──────────────────────────────────────────────────
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8); // flag：UTF-8
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移

    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);

  // ── 中央目录结束记录 ──────────────────────────────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
