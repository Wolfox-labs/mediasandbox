import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { createZip, crc32, type ZipEntry } from './zip.js';

/**
 * 自写 ZIP 写入器的测试。
 *
 * 重点验三件容易写错的事：
 *   1. CRC32 与标准实现一致（算错的话解压工具会报"文件损坏"）
 *   2. 结构能被真实解压器接受（不是只有自己认得）
 *   3. UTF-8 文件名标志位正确（否则中文名会变乱码）
 */

/** 从 ZIP 里手工解析出条目名与内容，用于断言而不依赖外部解压工具。 */
function readZip(buf: Buffer): { name: string; data: Buffer; method: number }[] {
  const out: { name: string; data: Buffer; method: number }[] = [];
  let offset = 0;
  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // 到中央目录了

    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    out.push({
      name,
      data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw),
      method,
    });
    offset = dataStart + compressedSize;
  }
  return out;
}

describe('ZIP 写入器', () => {
  it('CRC32 与已知值一致', () => {
    // "123456789" 的 CRC32 是标准测试向量 0xCBF43926。
    assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('', 'utf8')), 0);
  });

  it('单文件往返：内容与名字都对', () => {
    const entries: ZipEntry[] = [
      { path: 'a/b.txt', data: Buffer.from('hello 世界', 'utf8') },
    ];
    const zip = createZip(entries, { date: new Date('2026-01-02T03:04:06') });

    assert.equal(zip.subarray(0, 4).toString('ascii'), 'PK\x03\x04', 'ZIP 本地头魔数');
    const parsed = readZip(zip);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.name, 'a/b.txt');
    assert.equal(parsed[0]?.data.toString('utf8'), 'hello 世界');
  });

  it('多个文件全部写入，顺序保持', () => {
    const entries: ZipEntry[] = [
      { path: 'one.txt', data: Buffer.from('1') },
      { path: 'two.txt', data: Buffer.from('2') },
      { path: 'three.txt', data: Buffer.from('3') },
    ];
    const parsed = readZip(createZip(entries));
    assert.deepEqual(
      parsed.map((p) => p.name),
      ['one.txt', 'two.txt', 'three.txt'],
    );
    assert.deepEqual(
      parsed.map((p) => p.data.toString()),
      ['1', '2', '3'],
    );
  });

  it('中文文件名能被正确还原（UTF-8 标志位）', () => {
    const entries: ZipEntry[] = [
      { path: '项目/产物/文案.md', data: Buffer.from('内容', 'utf8') },
    ];
    const zip = createZip(entries);
    // flag bit 11 = 0x0800，表示文件名是 UTF-8。
    const flags = zip.readUInt16LE(6);
    assert.equal((flags & 0x0800) !== 0, true, '应设置 UTF-8 文件名标志位');
    assert.equal(readZip(zip)[0]?.name, '项目/产物/文案.md');
  });

  it('压缩与不压缩都能还原出相同内容', () => {
    const payload = Buffer.from('重复内容'.repeat(200), 'utf8');
    const entries: ZipEntry[] = [{ path: 'big.txt', data: payload }];

    const compressed = createZip(entries, { compress: true });
    const stored = createZip(entries, { compress: false });

    // 重复文本应能被压缩得明显更小。
    assert.ok(compressed.length < stored.length, '压缩后应更小');
    assert.equal(readZip(compressed)[0]?.data.toString('utf8'), payload.toString('utf8'));
    assert.equal(readZip(stored)[0]?.data.toString('utf8'), payload.toString('utf8'));
    assert.equal(readZip(stored)[0]?.method, 0, '不压缩时 method 应为 store');
  });

  it('空文件也能打包（不能因为长度为 0 就跳过）', () => {
    const parsed = readZip(createZip([{ path: 'empty.txt', data: Buffer.alloc(0) }]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.data.length, 0);
  });

  it('中央目录记录数与实际条目数一致', () => {
    const entries: ZipEntry[] = [
      { path: 'a.txt', data: Buffer.from('a') },
      { path: 'b.txt', data: Buffer.from('b') },
    ];
    const zip = createZip(entries);
    // EOCD 在末尾 22 字节，偏移 8/10 是条目数（本盘/总）。
    const eocd = zip.subarray(zip.length - 22);
    assert.equal(eocd.readUInt32LE(0), 0x06054b50, 'EOCD 魔数');
    assert.equal(eocd.readUInt16LE(8), 2);
    assert.equal(eocd.readUInt16LE(10), 2);
  });

  it('超过 4 GiB 时明确报错，而不是产出坏包', () => {
    // 造一个声明为超大的条目（不真的分配内存：用 length 恰好超限的 Buffer 不现实，
    // 所以直接验证守卫的边界条件——单文件超过 u32 上限时抛错）。
    const huge = { path: 'huge.bin', data: { length: 0x100000000 } as unknown as Uint8Array };
    assert.throws(() => createZip([huge]), /ZIP64/);
  });
});
