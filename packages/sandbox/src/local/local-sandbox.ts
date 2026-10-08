import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
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
import { OutputBuffer, defaultShell, killTree, runCommand } from '../util/proc.js';
import { assertValidProjectId, resolveInside, toPosixRelative } from '../util/paths.js';
import { matchesGlob } from '../util/glob.js';
import { mimeHintFor } from '../util/mime.js';
import { isDeliverableArtifact } from '../util/artifacts.js';

export interface LocalSandboxOptions {
  /** 所有项目工作区的根目录。默认 `<cwd>/workspaces`。 */
  readonly rootDir: string;
  /** 是否在 create() 时检查预设命令是否可用（只告警）。默认 true。 */
  readonly checkCommands?: boolean;
}

interface LocalRecord {
  readonly handle: SandboxHandle;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * 从目录名反推项目与环境。
 *
 * 名字形如 `<projectId>-<envType>-<8位随机>`（见 `create`），而 projectId
 * **允许包含短横线**（`PROJECT_ID_RE` 放行 `-`），所以从左往右切会切错。
 * 只能从右往左：末段是随机后缀，倒数第二段必须是已知环境名，剩下的全归 projectId。
 */
function identityFromDirName(
  sandboxId: string,
): { readonly projectId: string; readonly envType: EnvType } | undefined {
  const parts = sandboxId.split('-');
  if (parts.length < 3) return undefined;
  const envRaw = parts[parts.length - 2];
  if (envRaw === undefined || !(ENV_TYPES as readonly string[]).includes(envRaw)) return undefined;
  const projectId = parts.slice(0, -2).join('-');
  if (projectId === '') return undefined;
  return { projectId, envType: envRaw as EnvType };
}

/**
 * 本地沙盒：以独立目录作为工作区边界。
 *
 * 边界强度说明（诚实声明）：这是**路径级**隔离，不是安全边界。进程仍以当前用户身份
 * 运行，能读写用户可及的任何文件。用于开发期与本地执行；不可信代码必须走 DockerSandbox。
 */
export class LocalSandbox implements SandboxProvider {
  readonly kind = 'local' as const;
  private readonly rootDir: string;
  private readonly records = new Map<string, LocalRecord>();
  /** 活着的长驻进程，按 sandboxId 归组——销毁沙盒时要把它们一起带走。 */
  private readonly processes = new Map<string, LocalProcessRecord[]>();

  constructor(options: LocalSandboxOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  async create(projectId: string, envType: EnvType): Promise<SandboxHandle> {
    assertValidProjectId(projectId);
    const preset = getPreset(envType);

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
      throw new SandboxError(`创建本地沙盒失败: ${String(error)}`, 'CREATE_FAILED', { cause: error });
    }

    const handle: SandboxHandle = {
      id: sandboxId,
      projectId,
      envType,
      workDir,
      createdAt: Date.now(),
      provider: 'local',
    };
    this.records.set(sandboxId, { handle });
    return handle;
  }

  async get(sandboxId: string): Promise<SandboxHandle | undefined> {
    return this.records.get(sandboxId)?.handle;
  }

  /** 让同一进程重启后也能复用已有目录。 */
  async adopt(sandboxId: string, hint: AdoptHint = {}): Promise<SandboxHandle> {
    const workDir = path.join(this.rootDir, sandboxId);
    const stat = await fs.stat(workDir).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) {
      throw new SandboxError(`沙盒目录不存在: ${workDir}`, 'NO_SUCH_SANDBOX');
    }

    // 身份优先用调用方给的；没给才从目录名反推。两处都推不出来就抛错——
    // 拿一个 projectId='unknown' 的句柄继续跑，会把假项目名写进
    // SANDBOX_PROJECT_ID 与派生文案里，那种错比"找不到"难查得多。
    const derived = identityFromDirName(sandboxId);
    const projectId = hint.projectId ?? derived?.projectId;
    const envType = hint.envType ?? derived?.envType;
    if (projectId === undefined || envType === undefined) {
      throw new SandboxError(
        `无法确定沙盒 ${sandboxId} 的项目与环境，请显式给出：` +
          `adopt(id, { projectId, envType })`,
        'NO_SUCH_SANDBOX',
      );
    }
    assertValidProjectId(projectId);

    const handle: SandboxHandle = {
      id: sandboxId,
      projectId,
      envType,
      workDir,
      createdAt: stat.birthtimeMs,
      provider: 'local',
    };
    this.records.set(sandboxId, { handle });
    return handle;
  }

  private require(sandboxId: string): SandboxHandle {
    const record = this.records.get(sandboxId);
    if (record === undefined) {
      throw new SandboxError(`沙盒不存在或已销毁: ${sandboxId}`, 'NO_SUCH_SANDBOX');
    }
    return record.handle;
  }

  /**
   * 解析路径并校验符号链接不逃逸。
   * 对已存在的部分做 realpath；不存在的尾部按词法拼接。
   */
  private async safePath(handle: SandboxHandle, relPath: string): Promise<string> {
    const lexical = resolveInside(handle.workDir, relPath);
    const realRoot = await fs.realpath(handle.workDir);

    // 从目标向上找到第一个存在的祖先，realpath 它，再拼回剩余部分。
    let cursor = lexical;
    const tail: string[] = [];
    for (;;) {
      const exists = await fs.lstat(cursor).catch(() => undefined);
      if (exists !== undefined) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
    const realCursor = await fs.realpath(cursor).catch(() => cursor);
    const resolved = path.join(realCursor, ...tail);

    const rel = path.relative(realRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new SandboxError(`路径经符号链接逃出沙盒: ${relPath}`, 'PATH_ESCAPE');
    }
    return resolved;
  }

  async exec(handle: SandboxHandle, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const live = this.require(handle.id);
    const preset = getPreset(live.envType);
    const cwd =
      options.cwd === undefined || options.cwd === ''
        ? live.workDir
        : await this.safePath(live, options.cwd);

    const cwdStat = await fs.stat(cwd).catch(() => undefined);
    if (cwdStat === undefined || !cwdStat.isDirectory()) {
      throw new SandboxError(`工作目录不存在: ${options.cwd ?? '.'}`, 'NO_SUCH_FILE');
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...preset.baselineEnv,
      ...options.env,
      SANDBOX_WORKDIR: live.workDir,
      SANDBOX_ENV_TYPE: live.envType,
      SANDBOX_PROJECT_ID: live.projectId,
    };

    return runCommand({
      command,
      cwd,
      env,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    });
  }

  /**
   * 起一个长驻进程（本地实现）。
   *
   * `tty` 在本地被忽略：这里两个流本来就是两条独立的管道，
   * 没有"合并成一条"这回事，也没有终端要分配（容器侧才有）。
   */
  async start(
    handle: SandboxHandle,
    command: string,
    options: StartProcessOptions = {},
  ): Promise<SandboxProcess> {
    const live = this.require(handle.id);
    const preset = getPreset(live.envType);
    const cwd =
      options.cwd === undefined || options.cwd === ''
        ? live.workDir
        : await this.safePath(live, options.cwd);

    const cwdStat = await fs.stat(cwd).catch(() => undefined);
    if (cwdStat === undefined || !cwdStat.isDirectory()) {
      // 目录不存在时 spawn 报的是 ENOENT，很容易被误读成"命令找不到"。
      throw new SandboxError(`工作目录不存在: ${options.cwd ?? '.'}`, 'NO_SUCH_FILE');
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...preset.baselineEnv,
      ...options.env,
      SANDBOX_WORKDIR: live.workDir,
      SANDBOX_ENV_TYPE: live.envType,
      SANDBOX_PROJECT_ID: live.projectId,
    };

    const limit = options.maxOutputBytes ?? 1024 * 1024;
    const isWindows = process.platform === 'win32';
    const shell = defaultShell();
    const child = spawn(shell.file, [...shell.prefixArgs, command], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 起不来的要**当场如实失败**：给一个永远不动的句柄，调用方会一直等它出输出。
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) =>
        reject(
          new SandboxError(`启动长驻进程失败: ${error.message}`, 'UNSUPPORTED', { cause: error }),
        ),
      );
    });

    const out = new OutputBuffer(limit);
    const err = new OutputBuffer(limit);
    const state: { running: boolean; exitCode: number | null } = { running: true, exitCode: null };

    // 进程自己退出是常态（命令行工具跑完就退）：只记状态，不抛错。
    child.on('close', (code) => {
      state.running = false;
      state.exitCode = code ?? -1;
    });
    child.on('error', () => {
      state.running = false;
    });
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    const id = `${live.id}-p${randomUUID().slice(0, 8)}`;
    const record: LocalProcessRecord = {
      id,
      command,
      startedAt: Date.now(),
      child,
      out,
      err,
      state,
      stop: async (): Promise<void> => {
        child.stdin?.end();
        if (state.running) {
          const pid = child.pid;
          if (pid !== undefined) {
            // taskkill 返回 ≠ 子进程的 'close' 已经派发。kill() 的语义是
            // "回来的时候它已经死了"，所以这里等事件真的到达（有宽限，不能死等）。
            const closed = new Promise<void>((resolve) => {
              child.once('close', () => resolve());
              const timer = setTimeout(resolve, 5_000);
              timer.unref();
            });
            await killTree(pid);
            if (state.running) await closed;
          }
        }
        state.running = false;
      },
    };
    const list = this.processes.get(live.id) ?? [];
    list.push(record);
    this.processes.set(live.id, list);

    return {
      id,
      command,
      startedAt: record.startedAt,
      write: async (data: string): Promise<boolean> => {
        if (!state.running || child.stdin === null || child.stdin.destroyed) return false;
        child.stdin.write(data);
        // 返回 false 只表示内核缓冲满了，不是失败：数据仍会在排水后送出。
        return true;
      },
      read: async (): Promise<ProcessOutput> => {
        const takenOut = out.take();
        const takenErr = err.take();
        return {
          stdout: takenOut.text,
          stderr: takenErr.text,
          truncated: takenOut.truncated || takenErr.truncated,
        };
      },
      status: async (): Promise<ProcessStatus> => ({
        running: state.running,
        exitCode: state.exitCode,
      }),
      kill: async (): Promise<void> => {
        const current = this.processes.get(live.id);
        if (current !== undefined) {
          const index = current.indexOf(record);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) this.processes.delete(live.id);
        }
        await record.stop();
      },
    };
  }

  async writeFile(handle: SandboxHandle, relPath: string, content: string | Uint8Array): Promise<void> {
    const live = this.require(handle.id);
    const target = await this.safePath(live, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async readFile(handle: SandboxHandle, relPath: string): Promise<Uint8Array> {
    const live = this.require(handle.id);
    const target = await this.safePath(live, relPath);
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
    const live = this.require(handle.id);
    const out: FileEntry[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = toPosixRelative(live.workDir, abs);
        if (!matchesGlob(glob, rel)) continue;
        const stat = await fs.stat(abs);
        out.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    };

    await walk(live.workDir);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  async exists(handle: SandboxHandle, relPath: string): Promise<boolean> {
    const live = this.require(handle.id);
    const target = await this.safePath(live, relPath);
    return (await fs.stat(target).catch(() => undefined)) !== undefined;
  }

  async collectArtifacts(handle: SandboxHandle): Promise<Artifact[]> {
    const live = this.require(handle.id);
    const dir = resolveInside(live.workDir, 'artifacts');
    if ((await fs.stat(dir).catch(() => undefined)) === undefined) return [];

    const files = await this.listFiles(live, 'artifacts/**');
    // 排除空文件与 .gitkeep 之类的占位：环境预设会建空 .gitkeep 来保留目录，
    // 那是脚手架，不是交付产物。把它们算进来会让"第一个产物"变成空文件。
    return files
      .filter((f) => isDeliverableArtifact(f))
      .map((f) => ({ path: f.path, size: f.size, mimeHint: mimeHintFor(f.path) }));
  }

  async stats(handle: SandboxHandle): Promise<ResourceStats> {
    const live = this.require(handle.id);
    const files = await this.listFiles(live, '**');
    return {
      diskBytes: files.reduce((sum, f) => sum + f.size, 0),
      fileCount: files.length,
    };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.records.get(handle.id);
    if (record === undefined) return;
    this.records.delete(handle.id);
    // **先把长驻进程带走，再删目录**：反过来的话，进程还在写一个已经被删掉的
    // 工作区，而且它会一直活着——"沙盒没了、进程还在"是最难查的一类残留。
    await this.killProcessesOf(handle.id);
    await fs.rm(record.handle.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** 杀掉某个沙盒留下的全部长驻进程。幂等。 */
  private async killProcessesOf(sandboxId: string): Promise<void> {
    const list = this.processes.get(sandboxId) ?? [];
    this.processes.delete(sandboxId);
    for (const proc of list) {
      await proc.stop().catch(() => undefined);
    }
  }
}

/** 一个活着的长驻进程。 */
interface LocalProcessRecord {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  readonly child: ChildProcess;
  readonly out: OutputBuffer;
  readonly err: OutputBuffer;
  readonly state: { running: boolean; exitCode: number | null };
  /** 终止并释放；幂等。 */
  stop(): Promise<void>;
}
