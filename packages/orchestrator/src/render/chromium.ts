/**
 * 真浏览器截图驱动：**旁挂一个 chromium 容器**，把沙盒里的页面渲染成 PNG。
 *
 * ## 为什么是旁挂容器，而不是把 chromium 装进项目镜像
 *
 *   - 项目镜像只需要 node。为了截图让每个网页容器都背上几百 MB 的浏览器不划算，
 *     而且那会让"跑网页"隐含地依赖"有浏览器"。
 *   - 旁挂容器的隔离边界与项目容器**同级**：`network=none`、`CapDrop: ALL`、
 *     只读根、pids/内存限额。页面依旧在容器的笼子里渲染，
 *     不会因为"要截图"就把用户页面拿到宿主机上跑一遍。
 *
 * 挂载方式是**项目工作区目录 → 容器内 /workspace**：页面用 `file://` 直接读，
 * 截图直接写回同一个目录，宿主机那边立刻可见（不需要 docker cp）。
 *
 * ## 两个必须写下来的取舍
 *
 * 1. **`--no-sandbox`**：容器已经 `CapDrop: ALL` 且以非 root 运行，chromium 自己的
 *    沙盒起不来（它要 user namespace）。**外层容器才是这里的沙盒**，关掉内层那层
 *    不降低边界——反过来，为了让它能开内层沙盒而把能力加回来，才是真的削弱隔离。
 * 2. **字体**：镜像里必须装 CJK 字体（见 `browser.Dockerfile`）。没装的话中文
 *    会渲染成一排方框——"截图成功了、全是豆腐块"是最难被发现的那种失败。
 */
import { BROWSER_IMAGE } from '@mediasandbox/sandbox';
import type { Screenshot, ScreenshotDriver, ScreenshotRequest } from './screenshot.js';

/**
 * 旁挂容器需要的最小 Docker 能力。
 *
 * 与 `DockerApi` 一样不引 dockerode 类型：它是可选依赖，只有真正要截图时才需要装。
 */
export interface BrowserContainer {
  start(): Promise<void>;
  wait(): Promise<{ StatusCode: number }>;
  remove(options?: { force?: boolean; v?: boolean }): Promise<void>;
}

export interface BrowserDocker {
  createContainer(options: Record<string, unknown>): Promise<BrowserContainer>;
}

export interface ChromiumDriverOptions {
  readonly docker: BrowserDocker;
  /** 浏览器镜像名。默认 `mediasandbox/browser:latest`。 */
  readonly image?: string | undefined;
  /** 渲染超时。默认 60 秒：够渲染一页静态页，也不会把整条链路吊死。 */
  readonly timeoutMs?: number | undefined;
  /** 容器内的工作区挂载点。默认 `/workspace`，与项目容器一致。 */
  readonly containerWorkDir?: string | undefined;
}

/** 容器内工作区挂载点，与项目容器保持一致。 */
const CONTAINER_WORKDIR = '/workspace';
/** 截图产物的相对路径，与 `screenshot-page` 工具约定的一致。 */
const OUTPUT_PATH = 'artifacts/screenshot.png';

export class ChromiumScreenshotDriver implements ScreenshotDriver {
  readonly name = 'chromium';
  readonly placeholder = false;

  private readonly docker: BrowserDocker;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly containerWorkDir: string;

  constructor(options: ChromiumDriverOptions) {
    this.docker = options.docker;
    this.image = options.image ?? BROWSER_IMAGE;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.containerWorkDir = options.containerWorkDir ?? CONTAINER_WORKDIR;
  }

  async capture(request: ScreenshotRequest): Promise<Screenshot> {
    const sandbox = request.sandbox;
    if (sandbox === undefined) {
      throw new Error(
        'chromium 截图驱动需要沙盒：请在 ScreenshotRequest 里带上 { provider, handle }',
      );
    }
    const { provider, handle } = sandbox;
    const pagePath = request.pagePath ?? 'artifacts/index.html';
    const width = Math.max(1, Math.round(request.width));
    const height = Math.max(1, Math.round(request.height));
    // 截图落到哪由调用方定（默认 `artifacts/screenshot.png`）。
    // 写死一个路径会让"演示文稿另存 deck.png"变成同一张图在产物里出现两次。
    const outputPath = request.outputPath ?? OUTPUT_PATH;

    const container = await this.docker.createContainer({
      Image: this.image,
      // **只读根下必须把 HOME 指到 tmpfs**：chromium 要往 `$HOME/.config` 下
      // 建 profile 与 crashpad 数据库，建不出来时它不报"目录不可写"，
      // 而是把 crashpad handler 拉起来却少给参数，最后以 133 退出、**一张图都不写**。
      // 实测：同一个容器，只加这一条 `HOME=/tmp` 就从 133 变成 0 并写出 PNG；
      // `--user-data-dir` 单独加是没用的。隔离边界不变（只读根照旧）。
      Env: ['HOME=/tmp'],
      Cmd: [
        '/usr/bin/chromium-browser',
        // **old headless，不是 new**：实测 new headless 下 `--window-size=W,H`
        // 得到的视口比窗口矮 88px（截图固定为窗口尺寸），底部于是多出一条白边；
        // 海报这种整幅铺底的设计上非常明显。old headless 的视口 = 窗口，截图完整。
        '--headless=old',
        // 见文件头第 1 条：外层容器才是沙盒。
        '--no-sandbox',
        '--disable-gpu',
        // 默认 /dev/shm 很小，不禁用的话大页面会渲染到一半崩掉。
        '--disable-dev-shm-usage',
        // profile 落到 tmpfs（与上面的 HOME 配套）。
        '--user-data-dir=/tmp/chromium-profile',
        '--hide-scrollbars',
        `--window-size=${width},${height}`,
        `--screenshot=${this.containerWorkDir}/${outputPath}`,
        `file://${this.containerWorkDir}/${pagePath}`,
      ],
      WorkingDir: this.containerWorkDir,
      HostConfig: {
        // 项目工作区直挂：页面读得到，截图写得回，宿主机立刻可见。
        Binds: [`${handle.workDir}:${this.containerWorkDir}`],
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 128,
        // chromium 要写临时目录；只读根下必须显式给一块。
        Tmpfs: { '/tmp': 'rw,size=64m' },
      },
    });

    try {
      await container.start();
      const result = await this.withTimeout(container.wait(), this.timeoutMs);
      if (result.StatusCode !== 0) {
        throw new Error(`chromium 渲染失败，退出码 ${result.StatusCode}`);
      }
    } finally {
      // 无论成功失败都要把旁挂容器清掉：留着它就是一个占内存的僵尸。
      await container.remove({ force: true }).catch(() => undefined);
    }

    const bytes = await provider.readFile(handle, outputPath);
    if (bytes.byteLength === 0) {
      throw new Error(`chromium 没有写出截图: ${outputPath}`);
    }
    return {
      bytes,
      width,
      height,
      driver: this.name,
      placeholder: false,
    };
  }

  /** 超时后不再等：容器在 `finally` 里被强制删掉，链路不必跟着吊死。 */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`chromium 渲染超时（${timeoutMs}ms）`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 能截图时用它，不能时用占位驱动——由部署方决定，不看运气。 */
export function chromiumDriverFor(
  docker: BrowserDocker | undefined,
  options: { readonly image?: string | undefined; readonly timeoutMs?: number | undefined } = {},
): ChromiumScreenshotDriver | undefined {
  if (docker === undefined) return undefined;
  return new ChromiumScreenshotDriver({
    docker,
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
