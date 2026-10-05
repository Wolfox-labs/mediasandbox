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
import { runCommand } from '../util/proc.js';
import { assertValidProjectId, resolveInside, toPosixRelative } from '../util/paths.js';
import { matchesGlob } from '../util/glob.js';
import { mimeHintFor } from '../util/mime.js';

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
 * 本地沙盒：以独立目录作为工作区边界。
 *
 * 边界强度说明（诚实声明）：这是**路径级**隔离，不是安全边界。进程仍以当前用户身份
 * 运行，能读写用户可及的任何文件。用于开发期与本地执行；不可信代码必须走 DockerSandbox。
 */
export class LocalSandbox implements SandboxProvider {
  readonly kind = 'local' as const;
  private readonly rootDir: string;
  private readonly records = new Map<string, LocalRecord>();

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
  async adopt(sandboxId: string, projectId: string, envType: EnvType): Promise<SandboxHandle> {
    assertValidProjectId(projectId);
    const workDir = path.join(this.rootDir, sandboxId);
    const stat = await fs.stat(workDir).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) {
      throw new SandboxError(`沙盒目录不存在: ${workDir}`, 'NO_SUCH_SANDBOX');
    }
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
    return files.map((f) => ({ path: f.path, size: f.size, mimeHint: mimeHintFor(f.path) }));
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
    await fs.rm(record.handle.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
