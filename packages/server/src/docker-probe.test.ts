/**
 * 探针的用例。
 *
 * 这组用例锁的是一件具体的事：**"import 得到 dockerode" 不等于 "这台机器能用 Docker"**。
 * 之前正是这个混淆让没装 Docker 的机器选上了真 chromium 驱动，然后整次运行失败——
 * 与文档承诺的"退化成占位图"相反。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeBrowserDocker, type DockerProbeApi } from './docker-probe.js';

const IMAGE = 'mediasandbox/browser:latest';

function fake(overrides: {
  listContainers?: () => Promise<unknown[]>;
  inspect?: () => Promise<unknown>;
}): DockerProbeApi {
  return {
    listContainers: overrides.listContainers ?? (async () => []),
    getImage: () => ({ inspect: overrides.inspect ?? (async () => ({})) }),
  };
}

describe('probeBrowserDocker', () => {
  it('daemon 不可达时判为不可用，并把原因带上', async () => {
    const result = await probeBrowserDocker(
      fake({
        listContainers: async () => {
          throw new Error('connect ENOENT //./pipe/docker_engine');
        },
      }),
      IMAGE,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /daemon 不可达/);
    assert.match(result.ok === false ? result.reason : '', /ENOENT/);
  });

  it('daemon 可达但镜像没构建时判为不可用，并指出是哪张镜像', async () => {
    const result = await probeBrowserDocker(
      fake({
        inspect: async () => {
          throw new Error('no such image');
        },
      }),
      IMAGE,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /截图镜像未构建/);
    assert.match(result.ok === false ? result.reason : '', new RegExp(IMAGE.replace(/[/:.]/g, '\\$&')));
  });

  it('daemon 可达且镜像在时判为可用', async () => {
    const result = await probeBrowserDocker(fake({}), IMAGE);
    assert.equal(result.ok, true);
    assert.match(result.ok === true ? result.detail : '', /已构建/);
  });

  it('先查 daemon 再查镜像：daemon 不可达时不去 inspect 镜像', async () => {
    let inspected = false;
    await probeBrowserDocker(
      fake({
        listContainers: async () => {
          throw new Error('boom');
        },
        inspect: async () => {
          inspected = true;
          return {};
        },
      }),
      IMAGE,
    );
    assert.equal(inspected, false, 'daemon 都不通，查镜像没有意义');
  });
});
