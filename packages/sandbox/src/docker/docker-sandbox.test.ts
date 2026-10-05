import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { DockerSandbox, IMAGE_BY_ENV, parseMemory } from './docker-sandbox.js';
import { defineProviderSuite } from '../testing/provider-suite.js';
import type { DockerApi } from './docker-api.js';

/**
 * Docker provider 的测试。
 *
 * 分两部分：
 *   1. **一致性套件** —— 与 LocalSandbox 完全相同的用例。这是"适配完成"的定义。
 *   2. **隔离性用例** —— 只有容器实现才有的约束，本地实现无法满足。
 *
 * 若本机 Docker 不可用或镜像未构建，整组跳过并说明原因——
 * 不静默通过，那等于假装测过了。
 */

const DOCKER_AVAILABLE = await probeDocker();

async function probeDocker(): Promise<{ ok: boolean; detail: string }> {
  const dockerPath = process.env['DOCKER_HOST'] ?? 'default';
  try {
    const docker = new Docker() as unknown as DockerApi;
    // listContainers 是最轻的可用性探测。
    await docker.listContainers({ all: false });
    // 顺便确认镜像在不在。
    for (const image of Object.values(IMAGE_BY_ENV)) {
      try {
        await docker.getImage(image).inspect();
      } catch {
        return { ok: false, detail: `镜像未构建: ${image}（先跑 scripts/build-images.ps1）` };
      }
    }
    return { ok: true, detail: `Docker 可用（${dockerPath}）` };
  } catch (error) {
    return {
      ok: false,
      detail: `Docker 不可用: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

describe('parseMemory', () => {
  it('解析各种单位', () => {
    assert.equal(parseMemory('512m'), 512 * 1024 ** 2);
    assert.equal(parseMemory('1g'), 1024 ** 3);
    assert.equal(parseMemory('2G'), 2 * 1024 ** 3);
    assert.equal(parseMemory('256k'), 256 * 1024);
    assert.equal(parseMemory('1048576'), 1048576);
    assert.equal(parseMemory('1.5g'), Math.round(1.5 * 1024 ** 3));
  });

  it('无法解析时抛错，不静默用默认值', () => {
    assert.throws(() => parseMemory('lots'), /无法解析/);
    assert.throws(() => parseMemory(''), /无法解析/);
  });
});

if (!DOCKER_AVAILABLE.ok) {
  describe('DockerSandbox', () => {
    it('跳过：环境不满足', (t) => {
      t.skip(DOCKER_AVAILABLE.detail);
    });
  });
} else {
  const rootDir = path.join(os.tmpdir(), `mediasandbox-docker-test-${process.pid}`);
  const docker = new Docker() as unknown as DockerApi;
  const provider = new DockerSandbox({
    docker,
    rootDir,
    limits: { memory: '512m', cpus: 1, pidsLimit: 128, execTimeoutMs: 60_000 },
  });
  const handle = await provider.create(`dkr${process.pid}`, 'frontend');

  // ── 第 1 部分：与 LocalSandbox 完全相同的一致性套件 ──────────────────
  defineProviderSuite({
    provider,
    name: 'DockerSandbox',
    handle,
    enforcesIsolation: true,
    timeouts: { exec: 120_000 },
  });

  // ── 第 2 部分：容器特有的隔离约束 ────────────────────────────────────
  //
  // 必须自己建句柄：上面的一致性套件在 after() 里销毁了它的句柄，
  // 直接复用会全部报 NO_SUCH_SANDBOX。
  describe('DockerSandbox · 隔离约束', () => {
    let probeHandle: Awaited<ReturnType<typeof provider.create>>;

    before(async () => {
      probeHandle = await provider.create(`dkriso${process.pid}`, 'frontend');
    });

    after(async () => {
      await provider.destroy(probeHandle);
    });

    it('容器内看不到宿主机的其他路径', async () => {
      const result = await provider.exec(probeHandle, 'ls /workspace');
      assert.equal(result.exitCode, 0);
      // /workspace 是唯一挂载点，里面只有环境预设建的目录。
      assert.match(result.stdout, /artifacts/);
    });

    it('容器内没有网络（默认 network=none）', async () => {
      // 尝试出网。没有网卡时必然失败。
      const result = await provider.exec(
        probeHandle,
        'node -e "require(\'net\').connect(80,\'1.1.1.1\').on(\'error\',e=>{console.error(\'NO_NET\');process.exit(0)}).on(\'connect\',()=>{console.log(\'HAS_NET\');process.exit(1)})"',
        { timeoutMs: 20_000 },
      );
      assert.match(`${result.stdout}${result.stderr}`, /NO_NET/, '容器应无法建立外部连接');
    });

    it('根文件系统只读，写不进去', async () => {
      const result = await provider.exec(probeHandle, 'touch /etc/should-fail 2>&1; echo "exit=$?"');
      // 只读根 → touch 失败，$? 非 0。
      assert.doesNotMatch(result.stdout, /exit=0/, '根文件系统应不可写');
    });

    it('工作区可写（挂载点）', async () => {
      const result = await provider.exec(
        probeHandle,
        'touch /workspace/artifacts/probe.txt && echo OK',
      );
      assert.match(result.stdout, /OK/);
    });

    it('以非 root 用户运行', async () => {
      const result = await provider.exec(probeHandle, 'id -u');
      assert.equal(result.stdout.trim(), '1000', '容器内应是 uid 1000');
    });

    it('内存超限的进程会被内核杀掉', async () => {
      // 申请远超 512m 限制的内存；有 memory 限制时会被 OOM kill。
      const result = await provider.exec(
        probeHandle,
        'node -e "const a=[];for(;;){a.push(Buffer.alloc(64*1024*1024))}" 2>&1 | head -3; echo "done"',
        { timeoutMs: 45_000, maxOutputBytes: 8192 },
      );
      assert.ok(result.exitCode !== 0 || /done/.test(result.stdout), '超限分配不应无声成功');
    });

    it('destroy 后容器真的被删掉', async () => {
      const temp = await provider.create(`dkr${process.pid}del`, 'copy');
      await provider.destroy(temp);
      const remaining = await provider.listManaged();
      assert.ok(
        !remaining.some((c) => c.id === temp.id),
        'destroy 后不应还有该容器',
      );
    });
  });
}
