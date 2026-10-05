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
  SandboxError,
  type Artifact,
  type EnvType,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type ResourceStats,
  type SandboxHandle,
  type SandboxProvider,
} from '../types.js';
import { getPreset } from '../env-presets.js';
import { assertValidProjectId, resolveInside, toPosixRelative } from '../util/paths.js';
import { matchesGlob } from '../util/glob.js';
import { mimeHintFor } from '../util/mime.js';
import {
  DEFAULT_LIMITS,
  isConflict,
  isNotFound,
  type DockerApi,
  type DockerContainer,
  type DockerLimits,
  type ResolvedDockerLimits,
} from './docker-api.js';

/** 容器内的工作区挂载点，与 Dockerfile 里的 WORKDIR 一致。 */
const CONTAINER_WORKDIR = '/workspace';

const TRUNCATION_MARKER = '\n...[输出被截断]...\n';

/** 各环境对应的镜像名。由构建脚本产出。 */
export const IMAGE_BY_ENV: Readonly<Record<EnvType, string>> = {
  frontend: 'mediasandbox/frontend:latest',
  image: 'mediasandbox/image:latest',
  copy: 'mediasandbox/copy:latest',
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

/**
 * 解出 Docker 多路复用流。
 *
 * 非 TTY 模式下，Docker 把 stdout 与 stderr 复用在一条流里，每帧带 8 字节头：
 *   [streamType(1)][0][0][0][size(4, big-endian)]
 * streamType: 0=stdin, 1=stdout, 2=stderr
 *
 * 必须按这个格式解帧才能把两个流分开——否则 stderr 会混进 stdout，
 * 而 provider 测试明确要求二者分离。
 */
function createDemuxer(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void) {
  // 显式标注为 Buffer（默认泛型参数），否则 Buffer.alloc 的收窄类型
  // 与 data 事件给的 Buffer 不兼容。
  let buffer: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      // 只要还剩完整的头 + 载荷，就继续解帧。
      while (buffer.length >= 8) {
        const streamType = buffer[0];
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break; // 载荷未到齐，等下一块

        const payload = buffer.subarray(8, 8 + size);
        if (streamType === 2) onStderr(payload);
        else if (streamType === 1) onStdout(payload);
        // streamType 0（stdin 回显）与 3 忽略

        buffer = buffer.subarray(8 + size);
      }
    },    /** 流结束时把残留当 stdout 处理，避免丢内容。 */
    flush(): void {
      if (buffer.length > 0) {
        onStdout(buffer);
        buffer = Buffer.alloc(0);
      }
    },
  };
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
   */
  async adopt(sandboxId: string): Promise<SandboxHandle> {
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

    const projectId = info.Config.Labels?.['mediasandbox.project'] ?? 'unknown';
    const envTypeRaw = info.Config.Labels?.['mediasandbox.env'] ?? 'copy';
    const envType: EnvType =
      envTypeRaw === 'frontend' || envTypeRaw === 'image' || envTypeRaw === 'copy'
        ? envTypeRaw
        : 'copy';

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
          User: 'root',
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
    return files.map((f) => ({ path: f.path, size: f.size, mimeHint: mimeHintFor(f.path) }));
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
