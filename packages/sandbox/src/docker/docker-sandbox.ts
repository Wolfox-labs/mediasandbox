/**
 * Docker 沙盒：用容器提供**真实的安全边界**。
 *
 * 与 LocalSandbox 的根本差别：本地实现是路径级隔离（进程仍以当前用户身份运行，
 * 能读写用户可及的任何文件）；这里通过容器把网络、文件系统、资源都关进笼子。
 *
 * 四项约束（每项都有对应的 provider 测试）：
 *   1. **网络**：默认 `none`，容器没有网卡，出网必失败
 *   2. **文件**：只挂载项目工作区到 /workspace，容器内看不到宿主机其他路径
 *   3. **资源**：`Memory` / `NanoCpus` / `PidsLimit`，超限被内核杀掉
 *   4. **只读根**：`ReadonlyRootfs`，根文件系统不可写，只有 /workspace 与 /tmp 可写
 *
 * 文件读写走**绑定挂载**：宿主机目录直接映进容器，因此 writeFile/readFile 在宿主机
 * 侧完成即可，容器立刻可见。这比走 tar archive API 简单，也避免依赖容器内有工具。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ENV_TYPES,
  SandboxError,
  type AdoptHint,
  type Artifact,
  type EnvType,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type ProcessOutput,
  type ProcessStatus,
  type ResourceStats,
  type SandboxHandle,
  type SandboxProcess,
  type SandboxProvider,
  type StartProcessOptions,
} from '../types.js';
import { getPreset } from '../env-presets.js';
import { OutputBuffer } from '../util/proc.js';
import { assertValidProjectId, resolveInside, toPosixRelative } from '../util/paths.js';
import { matchesGlob } from '../util/glob.js';
import { mimeHintFor } from '../util/mime.js';
import { isDeliverableArtifact } from '../util/artifacts.js';
import {
  DEFAULT_LIMITS,
  isConflict,
  isNotFound,
  type DockerApi,
  type DockerContainer,
  type DockerLimits,
  type ResolvedDockerLimits,
} from './docker-api.js';
import { createDemuxer } from './stream-frames.js';

/** 容器内的工作区挂载点，与 Dockerfile 里的 WORKDIR 一致。 */
const CONTAINER_WORKDIR = '/workspace';

const TRUNCATION_MARKER = '\n...[输出被截断]...\n';

/**
 * 浏览器镜像：**不属于任何环境**，只被截图驱动旁挂起来跑一次。
 *
 * 与 `IMAGE_BY_ENV` 分开是有意的：项目容器的镜像不该背上几百 MB 的 chromium，
 * 而浏览器也不该成为"跑网页"的前提。
 */
export const BROWSER_IMAGE = 'mediasandbox/browser:latest';

/** 各环境对应的镜像名。由构建脚本产出。 */
export const IMAGE_BY_ENV: Readonly<Record<EnvType, string>> = {
  frontend: 'mediasandbox/frontend:latest',
  image: 'mediasandbox/image:latest',
  copy: 'mediasandbox/copy:latest',
  // 结构化网页只需要 Node 工具链，与 copy 镜像同构，直接复用同一个镜像，
  // 不为它单独维护一份 Dockerfile——多一份镜像就多一处会和别处漂移的地方。
  webpage: 'mediasandbox/copy:latest',
  // 演示文稿同理：它也是 Node 侧拼字符串产 HTML，不需要浏览器或 Office。
  // 真要导出 PDF 是使用方的后续动作，不该成为"做一页演示文稿"的前提。
  slides: 'mediasandbox/copy:latest',
};

export interface DockerSandboxOptions {
  readonly docker: DockerApi;
  /** 宿主机上存放项目工作区的根目录；会被挂载进容器。 */
  readonly rootDir: string;
  readonly limits?: DockerLimits | undefined;
  readonly imageByEnv?: Readonly<Partial<Record<EnvType, string>>> | undefined;
  /** 找不到镜像时是否自动 pull。默认 false——镜像应由显式构建步骤产出。 */
  readonly autoPull?: boolean | undefined;
}

interface DockerRecord {
  readonly handle: SandboxHandle;
  readonly container: DockerContainer;
}

export class DockerSandbox implements SandboxProvider {
  readonly kind = 'docker' as const;
  private readonly docker: DockerApi;
  private readonly rootDir: string;
  private readonly limits: ResolvedDockerLimits;
  private readonly imageByEnv: Readonly<Record<EnvType, string>>;
  private readonly autoPull: boolean;
  private readonly records = new Map<string, DockerRecord>();

  constructor(options: DockerSandboxOptions) {
    this.docker = options.docker;
    this.rootDir = path.resolve(options.rootDir);
    // 显式逐字段回落，而不是对象展开：exactOptionalPropertyTypes 下
    // 展开会把 `T | undefined` 带进结果，与 ResolvedDockerLimits 不兼容。
    const given = options.limits ?? {};
    this.limits = {
      memory: given.memory ?? DEFAULT_LIMITS.memory,
      cpus: given.cpus ?? DEFAULT_LIMITS.cpus,
      pidsLimit: given.pidsLimit ?? DEFAULT_LIMITS.pidsLimit,
      networkMode: given.networkMode ?? DEFAULT_LIMITS.networkMode,
      execTimeoutMs: given.execTimeoutMs ?? DEFAULT_LIMITS.execTimeoutMs,
    };
    this.imageByEnv = { ...IMAGE_BY_ENV, ...(options.imageByEnv ?? {}) };
    this.autoPull = options.autoPull ?? false;
  }

  async create(projectId: string, envType: EnvType): Promise<SandboxHandle> {
    assertValidProjectId(projectId);
    const preset = getPreset(envType);
    const image = this.imageByEnv[envType];

    const sandboxId = `${projectId}-${envType}-${randomUUID().slice(0, 8)}`;
    const workDir = path.join(this.rootDir, sandboxId);

    try {
      await fs.mkdir(workDir, { recursive: true });
      for (const dir of preset.directories) {
        await fs.mkdir(resolveInside(workDir, dir), { recursive: true });
      }
      for (const [relPath, content] of Object.entries(preset.seedFiles)) {
        const target = resolveInside(workDir, relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(`准备沙盒工作区失败: ${String(error)}`, 'CREATE_FAILED', {
        cause: error,
      });
    }

    // 容器内是 uid 1000，宿主目录默认属当前用户。放开写权限让容器能写入，
    // 否则挂载进来的目录对 sandbox 用户是只读的。
    await fs.chmod(workDir, 0o777).catch(() => undefined);

    await this.ensureImage(image);

    let container: DockerContainer;
    try {
      container = await this.docker.createContainer({
        name: sandboxId,
        Image: image,
        // 不跑 CMD，用 sleep 保持存活，等 exec 进来。
        Cmd: ['sleep', 'infinity'],
        WorkingDir: CONTAINER_WORKDIR,
        User: '1000:1000',
        HostConfig: {
          // ── 约束 2：文件边界。只挂项目工作区，容器看不到宿主机其他路径。
          Binds: [`${workDir}:${CONTAINER_WORKDIR}:rw`],
          // ── 约束 1：网络。默认 none。
          NetworkMode: this.limits.networkMode,
          // ── 约束 3：资源配额。
          Memory: parseMemory(this.limits.memory),
          NanoCpus: Math.round(this.limits.cpus * 1e9),
          PidsLimit: this.limits.pidsLimit,
          // ── 约束 4：只读根文件系统。
          ReadonlyRootfs: true,
          // 只读根之下这些位置仍需可写，否则多数程序跑不起来。
          Tmpfs: {
            '/tmp': 'rw,size=64m,nosuid',
            '/run': 'rw,size=8m,nosuid',
          },
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          AutoRemove: false,
        },
        Labels: {
          'mediasandbox.project': projectId,
          'mediasandbox.env': envType,
          'mediasandbox.managed': 'true',
        },
      });
      await container.start();
    } catch (error) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      throw new SandboxError(
        `创建容器失败（镜像 ${image}）: ${error instanceof Error ? error.message : String(error)}`,
        'CREATE_FAILED',
        { cause: error },
      );
    }

    const handle: SandboxHandle = {
      id: sandboxId,
      projectId,
      envType,
      workDir,
      createdAt: Date.now(),
      provider: 'docker',
    };
    this.records.set(sandboxId, { handle, container });
    return handle;
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new SandboxError(
          `检查镜像失败: ${error instanceof Error ? error.message : String(error)}`,
          'CREATE_FAILED',
          { cause: error },
        );
      }
    }

    if (!this.autoPull || this.docker.pull === undefined) {
      throw new SandboxError(
        `镜像不存在: ${image}。请先构建镜像，或开启 autoPull。`,
        'CREATE_FAILED',
      );
    }

    const stream = await this.docker.pull(image);
    // 必须把流读干，否则 pull 不会真正完成。
    await new Promise<void>((resolve, reject) => {
      stream.on('data', () => undefined);
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
  }

  async get(sandboxId: string): Promise<SandboxHandle | undefined> {
    return this.records.get(sandboxId)?.handle;
  }

  /**
   * 进程重启后按容器名接管已有沙盒。
   *
   * 这里刻意**不做模糊匹配**：容器名必须与 sandboxId 精确相等，否则返回 NO_SUCH_SANDBOX。
   * 用标签做 fallback 会把别的项目的容器认成自己的，那种错误比找不到更难查。
   *
   * 身份取法：容器标签 → 调用方给的 hint → **抛错**。
   * 从前这里认不出来就填 `projectId='unknown'` / `envType='copy'`，
   * 那是把"认不出"伪装成"认出来了"：句柄会带着假项目名继续跑。
   */
  async adopt(sandboxId: string, hint: AdoptHint = {}): Promise<SandboxHandle> {
    const listed = await this.docker.listContainers({ all: true });
    const found = listed.find((c) => c.Names.some((n) => n.replace(/^\//, '') === sandboxId));
    if (found === undefined) {
      throw new SandboxError(`找不到容器: ${sandboxId}`, 'NO_SUCH_SANDBOX');
    }

    const container = this.docker.getContainer(found.Id);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }

    const projectId = info.Config.Labels?.['mediasandbox.project'] ?? hint.projectId;
    const envTypeRaw = info.Config.Labels?.['mediasandbox.env'] ?? hint.envType;
    // 从 ENV_TYPES 派生，不写死字面量列表——加一个环境却漏改这里，
    // 表现是"容器在跑，但句柄上的 envType 悄悄变成 copy"，很难查。
    const envType: EnvType | undefined =
      envTypeRaw !== undefined && (ENV_TYPES as readonly string[]).includes(envTypeRaw)
        ? (envTypeRaw as EnvType)
        : undefined;

    if (projectId === undefined || envType === undefined) {
      throw new SandboxError(
        `容器 ${sandboxId} 存在，但认不出它属于哪个项目/环境` +
          `（标签缺失时请用 adopt(id, { projectId, envType }) 明确给出）`,
        'NO_SUCH_SANDBOX',
      );
    }

    const handle: SandboxHandle = {
      id: sandboxId,
      projectId,
      envType,
      workDir: path.join(this.rootDir, sandboxId),
      createdAt: Date.now(),
      provider: 'docker',
    };
    this.records.set(sandboxId, { handle, container });
    return handle;
  }

  private require(sandboxId: string): DockerRecord {
    const record = this.records.get(sandboxId);
    if (record === undefined) {
      throw new SandboxError(`沙盒不存在或已销毁: ${sandboxId}`, 'NO_SUCH_SANDBOX');
    }
    return record;
  }

  async exec(handle: SandboxHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const record = this.require(handle.id);
    const preset = getPreset(handle.envType);
    const timeoutMs = options.timeoutMs ?? this.limits.execTimeoutMs;
    const maxBytes = options.maxOutputBytes ?? 1024 * 1024;

    // cwd 是相对 workDir 的路径；先用本地那套校验挡掉越界，再映射到容器内绝对路径。
    let workingDir = CONTAINER_WORKDIR;
    if (options.cwd !== undefined && options.cwd !== '') {
      const resolved = resolveInside(handle.workDir, options.cwd);
      const rel = toPosixRelative(handle.workDir, resolved);
      workingDir = rel === '' ? CONTAINER_WORKDIR : `${CONTAINER_WORKDIR}/${rel}`;
    }

    const env: Record<string, string> = {
      ...preset.baselineEnv,
      ...options.env,
      SANDBOX_WORKDIR: CONTAINER_WORKDIR,
      SANDBOX_ENV_TYPE: handle.envType,
      SANDBOX_PROJECT_ID: handle.projectId,
    };

    const startedAt = Date.now();
    // TTY 模式下 Docker 给的是**裸流**（没有 8 字节帧头），且 stdout/stderr
    // 在容器侧就合并了。用错格式不会报错，只会让输出从第 9 个字节开始错位。
    const tty = options.tty === true;

    let execution: Awaited<ReturnType<DockerContainer['exec']>>;
    try {
      execution = await record.container.exec({
        // 用 sh：copy 镜像基于 alpine，没有 bash。
        Cmd: ['/bin/sh', '-c', command],
        WorkingDir: workingDir,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: false,
        Tty: tty,
        User: '1000:1000',
      });
    } catch (error) {
      throw new SandboxError(
        `创建 exec 失败: ${error instanceof Error ? error.message : String(error)}`,
        'UNSUPPORTED',
        { cause: error },
      );
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    const append = (buf: Buffer, stream: 'out' | 'err'): void => {
      const current = stream === 'out' ? stdoutBytes : stderrBytes;
      const remaining = maxBytes - current;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = buf.length <= remaining ? buf : buf.subarray(0, remaining);
      if (stream === 'out') {
        stdoutChunks.push(Buffer.from(slice));
        stdoutBytes += slice.length;
      } else {
        stderrChunks.push(Buffer.from(slice));
        stderrBytes += slice.length;
      }
      if (slice.length < buf.length) truncated = true;
    };

    const demux = createDemuxer(
      (chunk) => append(chunk, 'out'),
      (chunk) => append(chunk, 'err'),
      // TTY 下没有帧可解：整段都算 stdout。此时 `stderr` 会是空串，
      // 这是**如实**的——容器侧已经把两个流合并成一条了，假装还分得开才是假的。
      { framed: !tty },
    );

    const stream = await execution.start({ hijack: true, stdin: false });

    let timedOut = false;
    let settled = false;

    /** 超时后在容器内终止该用户的进程。exec 本身没有 kill API，只能从内部杀。 */
    const killInnerProcesses = async (): Promise<void> => {
      try {
        const killExec = await record.container.exec({
          Cmd: ['/bin/sh', '-c', 'pkill -TERM -u 1000 >/dev/null 2>&1 || true'],
          AttachStdout: false,
          AttachStderr: false,
          // **不能以 root 身份发信号**：容器建的时候 `CapDrop: ['ALL']`，root 在里面
          // 连 CAP_KILL 都没有，于是"root 去杀 uid 1000 的进程"是一次静默空转
          // （实测：pkill 返回后目标进程还在，而这条清理路径看上去"跑了"）。
          // 以沙盒用户自己的身份发信号不需要任何 capability——杀自己的进程本就允许。
          User: '1000:1000',
        });
        const killStream = await killExec.start({ hijack: true, stdin: false });
        killStream.on('data', () => undefined);
        killStream.on('error', () => undefined);
        killStream.resume();
      } catch {
        // 清理失败不影响结果上报；容器最终会被 destroy 回收。
      }
    };

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        if (settled) return;
        settled = true;
        // 杀掉遗留进程，然后立即结束等待——不能无限等流自然关闭。
        void killInnerProcesses().finally(() => resolve());
      }, timeoutMs);

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        demux.push(chunk);
      });

      const done = (): void => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        demux.flush();
        resolve();
      };
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', done);
    });

    // 超时就用 -1 表示；否则从 exec 检查里取真实退出码。
    let exitCode = -1;
    if (!timedOut) {
      const info = await execution.inspect().catch(() => undefined);
      exitCode = info?.ExitCode ?? -1;
    }

    const decode = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString('utf8') + (truncated ? TRUNCATION_MARKER : '');

    return {
      exitCode,
      stdout: decode(stdoutChunks),
      stderr: decode(stderrChunks),
      timedOut,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 起一个长驻进程（容器实现）。
   *
   * ## 为什么开 TTY
   *
   * 不开 TTY 时两个流是多路复用的：读要解帧，写 stdin 还要自己加帧
   * （见 `stream-frames.ts`）。长驻进程是交互式用法，"写进去、读回来"是主路径，
   * 所以这里走 TTY 的裸流：字节直接进出，少一层容易接错的封装。
   * 代价是 **stderr 与 stdout 合并**（`read()` 的 `stderr` 恒为空串）——
   * 这是容器侧的事实，不是这里丢的。
   *
   * ## 怎么杀
   *
   * `Docker exec` 没有 kill API。用 `pkill -u 1000` 会连别的运行的进程一起杀，
   * 所以起进程时先把自己的 pid 写进 `/tmp` 的标记文件（`exec` 之前记，记的就是
   * 真正那个进程），kill 时按标记文件精确杀。标记文件在容器里，随容器一起消失。
   * 发信号的**身份必须是沙盒用户**：容器 CapDrop 了 ALL，root 没有 CAP_KILL。
   */
  async start(
    handle: SandboxHandle,
    command: string,
    options: StartProcessOptions = {},
  ): Promise<SandboxProcess> {
    const record = this.require(handle.id);
    const preset = getPreset(handle.envType);

    let workingDir = CONTAINER_WORKDIR;
    if (options.cwd !== undefined && options.cwd !== '') {
      const resolved = resolveInside(handle.workDir, options.cwd);
      const rel = toPosixRelative(handle.workDir, resolved);
      workingDir = rel === '' ? CONTAINER_WORKDIR : `${CONTAINER_WORKDIR}/${rel}`;
    }

    const env: Record<string, string> = {
      ...preset.baselineEnv,
      ...options.env,
      SANDBOX_WORKDIR: CONTAINER_WORKDIR,
      SANDBOX_ENV_TYPE: handle.envType,
      SANDBOX_PROJECT_ID: handle.projectId,
    };

    const id = `p${randomUUID().slice(0, 8)}`;
    const pidFile = `/tmp/ms-${id}.pid`;
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    const out = new OutputBuffer(limit);
    const startedAt = Date.now();

    const execution = await record.container.exec({
      // 先记 pid 再 exec：`exec` 之后 shell 被目标进程替换，$$ 就是目标进程。
      Cmd: ['/bin/sh', '-c', `echo $$ > ${pidFile}; exec ${command}`],
      WorkingDir: workingDir,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: true,
      Tty: true,
      User: '1000:1000',
    });

    const stream = await execution.start({ hijack: true, stdin: true });

    // TTY 的裸流：不做任何解帧，整段都算 stdout。
    const demux = createDemuxer((chunk) => out.push(chunk), () => undefined, { framed: false });
    stream.on('data', (chunk: Buffer) => demux.push(chunk));
    stream.on('end', () => demux.flush());
    stream.on('close', () => demux.flush());
    // 只读不写会让流卡住；错误只影响交互，不影响已经读到的输出。
    stream.on('error', () => undefined);

    /** 按标记文件里的 pid 精确杀，尽量不影响容器里别的进程。 */
    const killByPidFile = async (signal: string): Promise<void> => {
      try {
        const killExec = await record.container.exec({
          Cmd: ['/bin/sh', '-c', `kill -${signal} "$(cat ${pidFile})" 2>/dev/null || true`],
          AttachStdout: false,
          AttachStderr: false,
          // 同上：**不能以 root 身份发信号**（容器 CapDrop 了 ALL，root 没有 CAP_KILL）。
          User: '1000:1000',
        });
        const killStream = await killExec.start({ hijack: true, stdin: false });
        killStream.on('data', () => undefined);
        killStream.on('error', () => undefined);
        killStream.resume();
      } catch {
        // 容器已经没了，或 exec 起不来：进程随容器消失，不必再管。
      }
    };

    /** 等 exec 真的结束。inspect 的状态更新是异步的，发完信号立刻查会读到"还在跑"。 */
    const waitGone = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const info = await execution.inspect().catch(() => undefined);
        if (info === undefined || !info.Running) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    return {
      id,
      command,
      startedAt,
      write: async (data: string): Promise<boolean> => {
        if (stream.writableEnded || stream.destroyed) return false;
        stream.write(data);
        return true;
      },
      read: async (): Promise<ProcessOutput> => {
        const taken = out.take();
        return {
          stdout: taken.text,
          // TTY 下两个流在容器侧已经合并：如实给空串，而不是把合并流再塞进来一遍。
          stderr: '',
          truncated: taken.truncated,
        };
      },
      status: async (): Promise<ProcessStatus> => {
        const info = await execution.inspect().catch(() => undefined);
        if (info === undefined) return { running: false, exitCode: null };
        return { running: info.Running, exitCode: info.ExitCode };
      },
      kill: async (): Promise<void> => {
        await killByPidFile('TERM');
        // 发完信号要**等它真的退出**：不等的话 kill() 回来时 status() 还可能报 running，
        // 调用方只能靠轮询去猜——而 kill 的语义就是"回来的时候它已经死了"。
        if (!(await waitGone(2_000))) {
          await killByPidFile('KILL');
          await waitGone(3_000);
        }
        stream.end();
      },
    };
  }

  async writeFile(handle: SandboxHandle, relPath: string, content: string | Uint8Array): Promise<void> {
    this.require(handle.id);
    const target = resolveInside(handle.workDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Uint8Array> {
    this.require(handle.id);
    const target = resolveInside(handle.workDir, relPath);
    try {
      return await fs.readFile(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        throw new SandboxError(`文件不存在: ${relPath}`, 'NO_SUCH_FILE', { cause: error });
      }
      throw error;
    }
  }

  async listFiles(handle: SandboxHandle, glob: string): Promise<FileEntry[]> {
    this.require(handle.id);
    const out: FileEntry[] = [];
    const skip = new Set(['node_modules', '.git']);

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = toPosixRelative(handle.workDir, abs);
        if (!matchesGlob(glob, rel)) continue;
        const stat = await fs.stat(abs);
        out.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };

    await walk(handle.workDir);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async exists(handle: SandboxHandle, relPath: string): Promise<boolean> {
    this.require(handle.id);
    const target = resolveInside(handle.workDir, relPath);
    return (await fs.stat(target).catch(() => undefined)) !== undefined;
  }

  async collectArtifacts(handle: SandboxHandle): Promise<Artifact[]> {
    this.require(handle.id);
    const dir = resolveInside(handle.workDir, 'artifacts');
    if ((await fs.stat(dir).catch(() => undefined)) === undefined) return [];
    const files = await this.listFiles(handle, 'artifacts/**');
    // 与 LocalSandbox 保持同一判定：空文件与 .gitkeep 不算产物。
    return files
      .filter((f) => isDeliverableArtifact(f))
      .map((f) => ({ path: f.path, size: f.size, mimeHint: mimeHintFor(f.path) }));
  }

  async stats(handle: SandboxHandle): Promise<ResourceStats> {
    this.require(handle.id);
    const files = await this.listFiles(handle, '**');
    return {
      diskBytes: files.reduce((sum, f) => sum + f.size, 0),
      fileCount: files.length,
    };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.records.get(handle.id);
    this.records.delete(handle.id);

    if (record !== undefined) {
      await record.container.stop({ t: 0 }).catch((error: unknown) => {
        // 已经停了不算错误。
        if (!isNotFound(error) && !isConflict(error)) throw error;
      });
      await record.container.remove({ force: true, v: true }).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    }

    // 销毁沙盒即意味着产物不再需要——调用方应在 destroy 之前读取产物。
    const workDir = record?.handle.workDir ?? path.join(this.rootDir, handle.id);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** 列出本 provider 管理的所有容器（含未接管的），便于清理残留。 */
  async listManaged(): Promise<{ id: string; projectId: string; envType: string }[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['mediasandbox.managed=true'] },
    });
    return containers.map((c) => ({
      id: c.Names[0]?.replace(/^\//, '') ?? c.Id,
      projectId: c.Labels?.['mediasandbox.project'] ?? 'unknown',
      envType: c.Labels?.['mediasandbox.env'] ?? 'unknown',
    }));
  }
}

/** '512m' / '2g' → 字节数。Docker API 要字节。 */
export function parseMemory(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(value.trim());
  if (match === null) {
    throw new SandboxError(`无法解析内存上限: ${value}`, 'UNSUPPORTED');
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const multiplier = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.round(amount * multiplier);
}
