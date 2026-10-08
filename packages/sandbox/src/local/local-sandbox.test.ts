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

describe('LocalSandbox · 接管已有沙盒', () => {
  it('不给 hint 时从目录名反推身份，带短横线的 projectId 也切得对', async () => {
    const sandbox = new LocalSandbox({ rootDir: path.join(rootDir, 'adopt') });
    // projectId 里有短横线：从左往右切会把 "my-project" 切成两段。
    const created = await sandbox.create(`my-project-v2${process.pid}`, 'webpage');
    try {
      // 模拟进程重启：换一个实例、清空内存记录，只能靠目录名认回来。
      const fresh = new LocalSandbox({ rootDir: path.join(rootDir, 'adopt') });
      assert.equal(await fresh.get(created.id), undefined, '新实例本来就不该有内存记录');

      const adopted = await fresh.adopt(created.id);
      assert.equal(adopted.id, created.id);
      assert.equal(adopted.projectId, `my-project-v2${process.pid}`);
      assert.equal(adopted.envType, 'webpage');
      assert.equal(adopted.workDir, created.workDir);

      // 接管后能真的执行，而不是只有个句柄。
      const result = await fresh.exec(adopted, 'node -e "process.stdout.write(\'ok\')"');
      assert.equal(result.stdout, 'ok');
    } finally {
      await sandbox.destroy(created);
    }
  });

  it('目录名认不出来又不给 hint 时抛错，不编一个身份', async () => {
    const sandbox = new LocalSandbox({ rootDir: path.join(rootDir, 'adopt-unknown') });
    // 手工造一个不符合 <projectId>-<envType>-<随机> 的目录（例如历史遗留或人工创建）。
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(path.join(rootDir, 'adopt-unknown', 'legacy-dir'), { recursive: true });

    await assert.rejects(
      () => sandbox.adopt('legacy-dir'),
      (error: unknown) =>
        error instanceof Error && /无法确定沙盒/.test(error.message) && 'code' in error
          ? (error as { code?: string }).code === 'NO_SUCH_SANDBOX'
          : false,
    );

    // 给了 hint 就能接管：hint 存在的意义就是这个。
    const adopted = await sandbox.adopt('legacy-dir', {
      projectId: `legacy${process.pid}`,
      envType: 'copy',
    });
    assert.equal(adopted.envType, 'copy');
  });
});
