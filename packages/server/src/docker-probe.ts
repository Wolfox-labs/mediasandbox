/**
 * Docker 到底能不能用。
 *
 * ## 为什么需要这个探针
 *
 * `import dockerode` 只证明**模块在**，不证明 **daemon 在**：`new Docker()` 只是造了一个
 * 客户端对象，一次网络都不会发。此前 `main.ts` 就用"import 成功"当成"有 Docker"，于是在
 * 没装 Docker Desktop 的机器上：
 *
 *   - 启动日志写着"截图 chromium"，而事实是这台机器渲不了图；
 *   - 文档承诺的"Docker 不在时截图退化成占位图"没有发生，取而代之的是截图工具报
 *     `connect ENOENT //./pipe/docker_engine`，重试到上限后整次运行被判 `escalated` 失败。
 *
 * 一次真实的往返（`listContainers`）就能把这两种情况分开，成本是一次本地 RPC。
 *
 * ## 为什么连浏览器镜像一起查
 *
 * 截图驱动用的是 `mediasandbox/browser:latest`。daemon 在、镜像没构建，同样渲不出图，
 * 而且失败点在**运行到截图那一步**——正是这里要提前暴露的那类"看起来能行"。
 * 这与 `docker-sandbox.test.ts` 里的 `probeDocker()` 是同一条判据，
 * 区别只在于那边探测失败是**跳过测试**，这边是**退回占位驱动**。
 *
 * ## 只声明用得到的方法
 *
 * `BrowserDocker` 只有 `createContainer`，够真截图用，但不够探测。这里声明一个最小的
 * 结构化切片（`listContainers` + `getImage`），`dockerode` 客户端与 `DockerApi` 都天然满足它。
 */

/** 探测需要的最小表面。`DockerApi` 与 `dockerode` 的默认客户端都满足。 */
export interface DockerProbeApi {
  listContainers(options?: Record<string, unknown>): Promise<unknown[]>;
  getImage(name: string): { inspect(): Promise<unknown> };
}

export type DockerProbeResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

/** 探测结果里带上镜像名，便于回答"是哪张镜像没构建"。 */
export async function probeBrowserDocker(
  docker: DockerProbeApi,
  browserImage: string,
): Promise<DockerProbeResult> {
  try {
    // 最轻的一次真实往返：daemon 不在时这里就是 connect ENOENT。
    await docker.listContainers({ all: false });
  } catch (error) {
    return { ok: false, reason: `Docker daemon 不可达: ${describe(error)}` };
  }
  try {
    await docker.getImage(browserImage).inspect();
  } catch (error) {
    return { ok: false, reason: `截图镜像未构建: ${browserImage}（${describe(error)}）` };
  }
  return { ok: true, detail: `daemon 可达且 ${browserImage} 已构建` };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
