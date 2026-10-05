import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalSandbox } from '../local/local-sandbox.js';
import { defineProviderSuite } from '../testing/provider-suite.js';
import { isDeliverableArtifact, isPlaceholderFile } from '../util/artifacts.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-local-test-${process.pid}`);
const provider = new LocalSandbox({ rootDir });
const handle = await provider.create(`suite${process.pid}`, 'frontend');

defineProviderSuite({
  provider,
  name: 'LocalSandbox',
  handle,
  enforcesIsolation: false,
});

describe('产物判定', () => {
  it('识别占位文件', () => {
    assert.equal(isPlaceholderFile('artifacts/.gitkeep'), true);
    assert.equal(isPlaceholderFile('artifacts/.keep'), true);
    assert.equal(isPlaceholderFile('artifacts/.gitignore'), true);
    assert.equal(isPlaceholderFile('artifacts/copy.md'), false);
    assert.equal(isPlaceholderFile('artifacts/sub/.gitkeep'), true);
  });

  it('空文件不算交付产物', () => {
    assert.equal(isDeliverableArtifact({ path: 'artifacts/empty.txt', size: 0 }), false);
    assert.equal(isDeliverableArtifact({ path: 'artifacts/x.txt', size: 1 }), true);
  });

  it('占位文件即使有内容也不算产物', () => {
    assert.equal(isDeliverableArtifact({ path: 'artifacts/.gitkeep', size: 10 }), false);
  });

  it('collectArtifacts 排除环境预设建的空占位文件', async () => {
    // 环境预设会在 artifacts/ 下建空的 .gitkeep 来保留目录。
    const sandbox = new LocalSandbox({ rootDir: path.join(rootDir, 'placeholder') });
    const h = await sandbox.create(`ph${process.pid}`, 'copy');
    try {
      // 预设的 .gitkeep 存在但不应被算作产物。
      assert.equal(await sandbox.exists(h, 'artifacts/.gitkeep'), true);
      assert.deepEqual(await sandbox.collectArtifacts(h), []);

      // 真正写一个产物后，只有它被收集。
      await sandbox.writeFile(h, 'artifacts/real.md', '内容');
      const artifacts = await sandbox.collectArtifacts(h);
      assert.deepEqual(
        artifacts.map((a) => a.path),
        ['artifacts/real.md'],
      );
    } finally {
      await sandbox.destroy(h);
    }
  });
});
