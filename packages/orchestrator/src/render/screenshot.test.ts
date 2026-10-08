/**
 * 截图驱动与 PNG 编码的测试。
 *
 * 重点不是"文件写出来了"，而是**它是不是一张真 PNG**、以及**是不是确定性的**：
 * 占位图会走产物清单、会进前端预览，签名或尺寸写错的话，用户看到的是破图，
 * 而这里不测就只能在界面上发现。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VIEWPORT,
  PlaceholderScreenshotDriver,
  defaultScreenshotDriver,
  encodePng,
} from './screenshot.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 从 IHDR 里读宽高（签名 8 字节 + 长度 4 + "IHDR" 4 → 宽在高 16 字节处）。 */
function ihdrSize(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PNG 编码', () => {
  it('产出合法的 PNG：签名、IHDR 尺寸、IEND 收尾', () => {
    const bytes = encodePng(4, 3, () => [1, 2, 3]);
    assert.deepEqual([...bytes.subarray(0, 8)], PNG_MAGIC, 'PNG 签名不对');
    assert.deepEqual(ihdrSize(bytes), { width: 4, height: 3 }, 'IHDR 里的尺寸不对');
    // 末尾必须是 IEND 块（长度 0 + "IEND" + CRC）。
    assert.equal(Buffer.from(bytes.subarray(bytes.length - 8, bytes.length - 4)).toString('ascii'), 'IEND');
  });

  it('像素值真的写进去了，且逐字节确定', () => {
    const red = encodePng(2, 2, () => [255, 0, 0]);
    const again = encodePng(2, 2, () => [255, 0, 0]);
    assert.deepEqual([...red], [...again], '同样输入两次编码结果不同');

    const blue = encodePng(2, 2, () => [0, 0, 255]);
    assert.notDeepEqual([...red], [...blue], '不同颜色的图居然一样（像素没写进去）');
  });

  it('1×1 的边界尺寸也能编出来', () => {
    const bytes = encodePng(1, 1, () => [0, 0, 0]);
    assert.deepEqual(ihdrSize(bytes), { width: 1, height: 1 });
  });
});

describe('占位截图驱动', () => {
  it('默认驱动就是占位驱动，且如实声明自己是占位', () => {
    const driver = defaultScreenshotDriver();
    assert.equal(driver.placeholder, true);
    assert.equal(driver.name, 'placeholder');
  });

  it('capture 产出一张符合请求尺寸的 PNG，并标明驱动与占位', async () => {
    const driver = new PlaceholderScreenshotDriver();
    const shot = await driver.capture({ html: '<html></html>', width: 320, height: 240 });
    assert.deepEqual([...shot.bytes.subarray(0, 8)], PNG_MAGIC);
    assert.deepEqual({ width: shot.width, height: shot.height }, { width: 320, height: 240 });
    assert.equal(shot.driver, 'placeholder');
    assert.equal(shot.placeholder, true, '占位这件事必须能被读出来，否则事后分不清真假截图');
  });

  it('同样的请求逐字节一致（可复现、可缓存）', async () => {
    const driver = new PlaceholderScreenshotDriver();
    const a = await driver.capture({ html: 'x', width: 64, height: 48 });
    const b = await driver.capture({ html: '完全不同的页面', width: 64, height: 48 });
    // 占位图不看内容：它表达的是"还没有真实渲染"，不是"这一页长什么样"。
    assert.deepEqual([...a.bytes], [...b.bytes]);
  });

  it('尺寸为 0 或负数时被夹到 1，不产出坏图', async () => {
    const driver = new PlaceholderScreenshotDriver();
    const shot = await driver.capture({ html: '', width: 0, height: -5 });
    assert.deepEqual(ihdrSize(shot.bytes), { width: 1, height: 1 });
  });

  it('默认视口是一个像样的桌面尺寸', () => {
    assert.ok(DEFAULT_VIEWPORT.width >= 1024);
    assert.ok(DEFAULT_VIEWPORT.height >= 640);
  });
});
