/**
 * 真浏览器点击驱动：把 chromium 旁挂起来，用 **CDP** 在页面里真点一下。
 *
 * ## 为什么必须走 CDP，而不是"把点击写进页面脚本"
 *
 * 页面里的交互是渲染器自带的脚本（标签页切换、`<details>`、表单提示）。
 * 想验证"用户点得动"，就得让浏览器**真的派发一次点击**；
 * 任何"渲染时就把标签页设成选中"的做法都是在验证我们自己写的假象。
 * CDP 的 `Runtime.evaluate` 执行 `el.click()`，是浏览器真的派发点击事件，
 * 与手点走的是同一条事件路径。
 *
 * ## 与截图驱动唯一的、必须写下来的差别：网络
 *
 * 截图驱动给容器 `network=none`；点击驱动做不到——CDP 要连容器里的
 * 9222 端口，端口发布要求容器在 bridge 网络上（`network=none` 下
 * Docker 直接拒绝发布端口）。取舍是：
 *
 *   - 端口**只绑 127.0.0.1**（`HostIp`），局域网里别的机器连不上；
 *   - 容器本身不下载任何东西，页面是 `file://` 读工作区；
 *   - 因此点击驱动**只在需要验证交互时启用**，日常截图仍走 `network=none`。
 *
 * 这条差别是真实的隔离让步，不藏着：想两个都要（既能点又不出网）
 * 得改成 `--remote-debugging-pipe` 走容器 stdin/stdout，
 * 那是另一套 framing，等真有需求再换。
 */
import { BROWSER_IMAGE } from '@mediasandbox/sandbox';
import type { BrowserContainer } from './chromium.js';
import type { ClickDriver, ClickObservation, ClickRequest, ClickResult } from './click.js';
import { buildClickScript, judgeClick, parseClickScriptResult } from './click.js';

/**
 * chromium 在容器内监听的端口（只有回环）。
 *
 * 两者分开是必须的：新版 chromium **忽略** `--remote-debugging-address`，
 * 永远只绑 127.0.0.1（实测 netstat 里就是 `127.0.0.1:9222`），
 * 而 Docker 的端口转发是连容器的非回环地址，于是永远连不上、只报一句 `fetch failed`。
 * 中间加一层 socat 把 `0.0.0.0:<DEBUG_PORT>` 转到回环上的这个端口。
 */
const INNER_PORT = 9222;
/** 容器内对外（经 socat）的调试端口；宿主机端口由 Docker 随机分配。 */
const DEBUG_PORT = 9223;
/** 容器内工作区挂载点，与项目容器、截图驱动保持一致。 */
const CONTAINER_WORKDIR = '/workspace';
/** 点击后截图的相对路径。与截图驱动分开命名，两者可以同时存在。 */
const CLICK_SHOT_PATH = 'artifacts/click.png';

export interface ClickContainer extends BrowserContainer {
  inspect(): Promise<{
    readonly NetworkSettings?:
      | {
          readonly Ports?:
            | Record<string, readonly { readonly HostPort?: string | undefined }[] | null>
            | undefined;
        }
      | undefined;
  }>;
}

export interface ClickDocker {
  createContainer(options: Record<string, unknown>): Promise<ClickContainer>;
}

export interface ChromiumClickDriverOptions {
  readonly docker: ClickDocker;
  /** 浏览器镜像名。默认 `mediasandbox/browser:latest`。 */
  readonly image?: string | undefined;
  /** 整体超时。默认 60 秒。 */
  readonly timeoutMs?: number | undefined;
  readonly containerWorkDir?: string | undefined;
}

/** WebSocket 的最小形状。Node ≥ 22 自带全局 WebSocket，这里不引第三方依赖。 */
interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

function webSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (ctor === undefined) {
    throw new Error('点击驱动需要全局 WebSocket（Node ≥ 22）；当前运行时没有，请升级 Node');
  }
  return ctor;
}

/** CDP 的最小客户端：只用到"发一条命令、等它的结果"这一种交互。 */
class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocketLike) {}

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new (webSocketCtor())(url);
    const client = new CdpClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 CDP 超时（${timeoutMs}ms）`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`连接 CDP 失败：${url}`));
      });
      socket.addEventListener('message', (event) => client.onMessage(event.data));
    });
    return client;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return; // 事件流里混进非 JSON 不该让整次点击失败。
    }
    if (typeof parsed.id !== 'number') return; // 事件（没有 id），本驱动不订阅事件。
    const waiter = this.pending.get(parsed.id);
    if (waiter === undefined) return;
    this.pending.delete(parsed.id);
    if (parsed.error !== undefined) {
      waiter.reject(new Error(`CDP 调用失败：${parsed.error.message ?? '未知错误'}`));
    } else {
      waiter.resolve(parsed.result ?? {});
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(new Error('CDP 连接已关闭'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

export class ChromiumClickDriver implements ClickDriver {
  readonly name = 'chromium-cdp';
  readonly placeholder = false;

  private readonly docker: ClickDocker;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly containerWorkDir: string;

  constructor(options: ChromiumClickDriverOptions) {
    this.docker = options.docker;
    this.image = options.image ?? BROWSER_IMAGE;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.containerWorkDir = options.containerWorkDir ?? CONTAINER_WORKDIR;
  }

  async click(request: ClickRequest): Promise<ClickResult> {
    const sandbox = request.sandbox;
    if (sandbox === undefined) {
      throw new Error('chromium 点击驱动需要沙盒：请在 ClickRequest 里带上 { provider, handle }');
    }
    const { provider, handle } = sandbox;
    const pagePath = request.pagePath ?? 'artifacts/index.html';
    const width = Math.max(1, Math.round(request.width));
    const height = Math.max(1, Math.round(request.height));
    const deadline = Date.now() + this.timeoutMs;

    const container = await this.docker.createContainer({
      Image: this.image,
      // 与截图驱动同一条：只读根下 HOME 必须可写，否则 chromium 以 133 退出、什么都不做。
      Env: ['HOME=/tmp'],
      Cmd: [
        '/bin/sh',
        '-c',
        // socat 先把对外的口开出来，再 exec chromium（exec 让容器退出码就是 chromium 的，
        // 出问题时一眼看得出是谁挂的）。socat 的 `fork` 让每个连接各起一个子进程。
        `socat TCP-LISTEN:${DEBUG_PORT},fork,reuseaddr TCP:127.0.0.1:${INNER_PORT} & exec ` +
          [
            '/usr/bin/chromium-browser',
            '--headless=new',
            // 与截图驱动同一条理由：外层容器才是沙盒。
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            `--window-size=${width},${height}`,
            // profile 落到 tmpfs（与上面的 HOME 配套）。
            '--user-data-dir=/tmp/chromium-profile',
            `--remote-debugging-port=${INNER_PORT}`,
            `file://${this.containerWorkDir}/${pagePath}`,
          ].join(' '),
      ],
      WorkingDir: this.containerWorkDir,
      ExposedPorts: { [`${DEBUG_PORT}/tcp`]: {} },
      HostConfig: {
        Binds: [`${handle.workDir}:${this.containerWorkDir}`],
        // 见文件头：CDP 要端口，端口要 bridge；端口只绑回环。
        NetworkMode: 'bridge',
        PortBindings: { [`${DEBUG_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 128,
        Tmpfs: { '/tmp': 'rw,size=64m' },
      },
    });

    let client: CdpClient | undefined;
    try {
      await container.start();
      const host = await this.resolveHostPort(container, deadline);
      const wsUrl = await this.waitForPageTarget(host, deadline);
      client = await CdpClient.connect(wsUrl, Math.max(1, deadline - Date.now()));
      await this.waitForReady(client, deadline);

      const evaluated = await client.send('Runtime.evaluate', {
        expression: buildClickScript(request.target),
        returnByValue: true,
      });
      const value = (evaluated['result'] as { value?: unknown } | undefined)?.value;
      const parsed = parseClickScriptResult(value);
      if (!parsed.found) {
        throw new Error(`页面里找不到可点元素：${request.target.selector}`);
      }
      const before: ClickObservation = parsed.before ?? {};
      const after: ClickObservation = parsed.after ?? {};
      const verdict = judgeClick(request.target, before, after);

      // 点击后的截图：验证失败时它是最有用的证据。
      let screenshot: { bytes: Uint8Array; path: string } | undefined;
      try {
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        const data = shot['data'];
        if (typeof data === 'string' && data.length > 0) {
          const bytes = Buffer.from(data, 'base64');
          await provider.writeFile(handle, CLICK_SHOT_PATH, bytes);
          screenshot = { bytes, path: CLICK_SHOT_PATH };
        }
      } catch {
        // 截图只是证据，拿不到不影响点击结论。
        screenshot = undefined;
      }

      return {
        target: request.target,
        before,
        after,
        changed: verdict.changed,
        detail: verdict.detail,
        screenshot,
        driver: this.name,
        placeholder: false,
      };
    } finally {
      client?.close();
      // 旁挂容器必须清掉：它开着端口，留着就是泄漏。
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /** 宿主机端口由 Docker 分配，起来之后 inspect 才拿得到。 */
  private async resolveHostPort(container: ClickContainer, deadline: number): Promise<string> {
    while (Date.now() < deadline) {
      const info = await container.inspect().catch(() => undefined);
      const bindings = info?.NetworkSettings?.Ports?.[`${DEBUG_PORT}/tcp`];
      const port = bindings?.[0]?.HostPort;
      if (typeof port === 'string' && port.length > 0) return `127.0.0.1:${port}`;
      await delay(100);
    }
    throw new Error(`等不到 chromium 调试端口（${DEBUG_PORT}）`);
  }

  /** 页面目标出现才算 CDP 能连；chromium 启动要一两秒。 */
  private async waitForPageTarget(host: string, deadline: number): Promise<string> {
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${host}/json/list`);
        const targets = (await response.json()) as readonly {
          type?: string;
          webSocketDebuggerUrl?: string;
        }[];
        const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
        if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(150);
    }
    throw new Error(`等不到 chromium 的页面目标${lastError === '' ? '' : `：${lastError}`}`);
  }

  /** 页面还没加载完就点会点空——等它自己说 complete。 */
  private async waitForReady(client: CdpClient, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      const value = (evaluated['result'] as { value?: unknown } | undefined)?.value;
      if (value === 'complete') return;
      await delay(100);
    }
    throw new Error('等页面加载完成超时');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 有 Docker 才可能真点；没有就由调用方决定降级成占位驱动。 */
export function chromiumClickDriverFor(
  docker: ClickDocker | undefined,
  options: { readonly image?: string | undefined; readonly timeoutMs?: number | undefined } = {},
): ChromiumClickDriver | undefined {
  if (docker === undefined) return undefined;
  return new ChromiumClickDriver({
    docker,
    ...(options.image !== undefined ? { image: options.image } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
