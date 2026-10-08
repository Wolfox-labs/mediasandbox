/**
 * 真浏览器截图驱动的测试。
 *
 * **不连 Docker**：这里验的是"驱动有没有把该交代的都交代出去"——
 * 镜像、命令、挂载、隔离参数、失败与超时是否如实、容器有没有被清掉。
 * 真容器渲染另有一条端到端用例（需要 Docker 与浏览器镜像）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BROWSER_IMAGE, type SandboxHandle, type SandboxProvider } from '@mediasandbox/sandbox';
import { ChromiumScreenshotDriver, chromiumDriverFor } from './chromium.js';
import type { BrowserContainer, BrowserDocker } from './chromium.js';

interface CreatedContainer {
  readonly options: Record<string, unknown>;
  started: number;
  removed: number;
}

/** 假的旁挂容器：记录被怎么创建、有没有被清掉。 */
function fakeDocker(behavior: { exitCode?: number; neverExits?: boolean } = {}): {
  docker: BrowserDocker;
  created: CreatedContainer[];
} {
  const created: CreatedContainer[] = [];
  return {
    created,
    docker: {
      createContainer: async (options: Record<string, unknown>): Promise<BrowserContainer> => {
        const record: CreatedContainer = { options, started: 0, removed: 0 };
        created.push(record);
        return {
          start: async () => {
            record.started += 1;
          },
          wait: async () => {
            if (behavior.neverExits === true) return await new Promise(() => undefined);
            return { StatusCode: behavior.exitCode ?? 0 };
          },
          remove: async () => {
            record.removed += 1;
          },
        };
      },
    },
  };
}

const HANDLE: SandboxHandle = {
  id: 'proj-webpage-abc',
  projectId: 'proj',
  envType: 'webpage',
  workDir: '/tmp/sandboxes/proj-webpage-abc',
  createdAt: 0,
  provider: 'docker',
};

/** 只实现驱动用到的那一个方法；其余能力与本用例无关。 */
function fakeProvider(bytes: Uint8Array): SandboxProvider {
  return {
    kind: 'docker',
    readFile: async () => bytes,
  } as unknown as SandboxProvider;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('chromium 截图驱动', () => {
  it('没有沙盒就明确报错，而不是"截出一张宿主机上的图"', async () => {
    const { docker } = fakeDocker();
    const driver = new ChromiumScreenshotDriver({ docker });
    await assert.rejects(
      () => driver.capture({ html: '<html></html>', width: 800, height: 600 }),
      /需要沙盒/,
    );
  });

  it('按约定渲染：镜像、headless 命令、页面用 file:// 读、截图写回工作区', async () => {
    const { docker, created } = fakeDocker();
    const driver = new ChromiumScreenshotDriver({ docker });
    const shot = await driver.capture({
      html: '<html></html>',
      width: 1024,
      height: 640,
      sandbox: { provider: fakeProvider(PNG), handle: HANDLE },
      pagePath: 'artifacts/index.html',
    });

    assert.equal(created.length, 1);
    const options = created[0]!.options;
    assert.equal(options['Image'], BROWSER_IMAGE);
    const cmd = options['Cmd'] as string[];
    assert.equal(cmd[0], '/usr/bin/chromium-browser');
    assert.ok(cmd.includes('--headless=new'));
    assert.ok(cmd.includes('--window-size=1024,640'), `视口没传对：${cmd.join(' ')}`);
    assert.ok(cmd.includes('--screenshot=/workspace/artifacts/screenshot.png'));
    assert.ok(
      cmd.includes('file:///workspace/artifacts/index.html'),
      '页面应当直接读沙盒里的那一份，而不是把 html 再写一遍',
    );

    assert.deepEqual([...shot.bytes], [...PNG]);
    assert.equal(shot.driver, 'chromium');
    assert.equal(shot.placeholder, false, '真截图不该标成占位');
    assert.deepEqual({ width: shot.width, height: shot.height }, { width: 1024, height: 640 });

    // 容器用完必须清掉，否则每截一次图就留一个占内存的僵尸。
    assert.equal(created[0]!.removed, 1);
  });

  it('旁挂容器带着与项目容器同级的隔离参数', async () => {
    const { docker, created } = fakeDocker();
    const driver = new ChromiumScreenshotDriver({ docker });
    await driver.capture({
      html: 'x',
      width: 100,
      height: 100,
      sandbox: { provider: fakeProvider(PNG), handle: HANDLE },
    });

    const host = created[0]!.options['HostConfig'] as Record<string, unknown>;
    assert.deepEqual(host['Binds'], [`${HANDLE.workDir}:/workspace`], '工作区没挂进去');
    assert.equal(host['NetworkMode'], 'none', '截图容器不该有网络');
    assert.deepEqual(host['CapDrop'], ['ALL'], '截图容器不该带着能力跑');
    assert.equal(host['ReadonlyRootfs'], true);
    assert.ok(host['Tmpfs'] !== undefined, '只读根下必须给 chromium 一块可写的 /tmp');
  });

  it('chromium 退出码非 0 时如实失败，并照样把容器清掉', async () => {
    const { docker, created } = fakeDocker({ exitCode: 1 });
    const driver = new ChromiumScreenshotDriver({ docker });
    await assert.rejects(
      () =>
        driver.capture({
          html: 'x',
          width: 10,
          height: 10,
          sandbox: { provider: fakeProvider(PNG), handle: HANDLE },
        }),
      /退出码 1/,
    );
    assert.equal(created[0]!.removed, 1, '失败路径也必须清容器');
  });

  it('渲染卡住时超时失败，不把整条链路吊死', async () => {
    const { docker } = fakeDocker({ neverExits: true });
    const driver = new ChromiumScreenshotDriver({ docker, timeoutMs: 60 });
    await assert.rejects(
      () =>
        driver.capture({
          html: 'x',
          width: 10,
          height: 10,
          sandbox: { provider: fakeProvider(PNG), handle: HANDLE },
        }),
      /渲染超时/,
    );
  });

  it('chromium 没写出图时明确失败，而不是给一张空文件', async () => {
    const { docker } = fakeDocker();
    const driver = new ChromiumScreenshotDriver({ docker });
    await assert.rejects(
      () =>
        driver.capture({
          html: 'x',
          width: 10,
          height: 10,
          sandbox: { provider: fakeProvider(new Uint8Array(0)), handle: HANDLE },
        }),
      /没有写出截图/,
    );
  });

  it('chromiumDriverFor 在拿不到 Docker 时返回 undefined（交由占位驱动）', () => {
    assert.equal(chromiumDriverFor(undefined), undefined);
    const { docker } = fakeDocker();
    assert.ok(chromiumDriverFor(docker) instanceof ChromiumScreenshotDriver);
  });
});
