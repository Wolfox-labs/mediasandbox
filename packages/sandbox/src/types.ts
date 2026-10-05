/**
 * 沙盒抽象接口。
 *
 * 上层编排代码只依赖本文件的类型。LocalSandbox 与 DockerSandbox 是两个实现，
 * 必须通过同一套 provider 测试（见 src/testing/provider-suite.ts）。
 */

/** 沙盒环境预设。每个预设对应一套预装工具链。 */
export type EnvType = 'frontend' | 'image' | 'copy';

export const ENV_TYPES: readonly EnvType[] = ['frontend', 'image', 'copy'];

/** 沙盒句柄。由 create() 返回，后续所有操作都作用于它。 */
export interface SandboxHandle {
  readonly id: string;
  readonly projectId: string;
  readonly envType: EnvType;
  /** 宿主机上该沙盒工作区的绝对路径（本地实现即项目目录；容器实现即挂载源）。 */
  readonly workDir: string;
  readonly createdAt: number;
  readonly provider: 'local' | 'docker';
}

export interface ExecOptions {
  /** 工作目录，相对于 workDir。默认 workDir 本身。 */
  readonly cwd?: string;
  /** 超时毫秒。超时后进程树被强制终止，结果里 timedOut = true。默认 30_000。 */
  readonly timeoutMs?: number;
  /** 单流输出上限（字节）。超出后截断并置 truncated = true。默认 1 MiB。 */
  readonly maxOutputBytes?: number;
  /** 传给进程的环境变量，与沙盒基线环境合并。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 标准输入。 */
  readonly stdin?: string;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** 是否因超时被终止。 */
  readonly timedOut: boolean;
  /** 是否因超过 maxOutputBytes 被截断。 */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface FileEntry {
  /** 相对 workDir 的 POSIX 风格路径。 */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface Artifact {
  readonly path: string;
  readonly size: number;
  readonly mimeHint: string;
}

export interface ResourceStats {
  /** 沙盒工作区占用字节。 */
  readonly diskBytes: number;
  readonly fileCount: number;
}

/** 沙盒错误基类，便于上层按类型兜底。 */
export class SandboxError extends Error {
  override readonly name: string = 'SandboxError';
  constructor(
    message: string,
    readonly code: SandboxErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type SandboxErrorCode =
  /** 路径逃出沙盒工作区。 */
  | 'PATH_ESCAPE'
  /** 沙盒不存在或已销毁。 */
  | 'NO_SUCH_SANDBOX'
  /** 目标文件不存在。 */
  | 'NO_SUCH_FILE'
  /** 环境预设不支持该操作。 */
  | 'UNSUPPORTED'
  /** create() 失败。 */
  | 'CREATE_FAILED';

export interface SandboxProvider {
  readonly kind: 'local' | 'docker';

  /**
   * 创建沙盒。同一 projectId 重复创建应返回可复用的句柄或抛错，
   * 由实现决定；测试套件要求 create() 后 get() 能找到它。
   */
  create(projectId: string, envType: EnvType): Promise<SandboxHandle>;

  /** 取回已存在的句柄；不存在返回 undefined。 */
  get(sandboxId: string): Promise<SandboxHandle | undefined>;

  exec(handle: SandboxHandle, command: string, options?: ExecOptions): Promise<ExecResult>;

  /** 写入文件。相对路径，父目录自动创建。 */
  writeFile(handle: SandboxHandle, relPath: string, content: string | Uint8Array): Promise<void>;

  readFile(handle: SandboxHandle, relPath: string): Promise<Uint8Array>;

  /** 按 glob 列举文件（相对路径，POSIX 分隔符）。 */
  listFiles(handle: SandboxHandle, glob: string): Promise<FileEntry[]>;

  exists(handle: SandboxHandle, relPath: string): Promise<boolean>;

  /** 收集产物。默认收集 workDir/artifacts 下的文件；无该目录则返回空数组。 */
  collectArtifacts(handle: SandboxHandle): Promise<Artifact[]>;

  stats(handle: SandboxHandle): Promise<ResourceStats>;

  /** 销毁沙盒。对不存在的沙盒应为幂等无异常。 */
  destroy(handle: SandboxHandle): Promise<void>;
}

/** 便捷方法：读取文件并按 UTF-8 解码。 */
export async function readText(
  provider: SandboxProvider,
  handle: SandboxHandle,
  relPath: string,
): Promise<string> {
  return new TextDecoder().decode(await provider.readFile(handle, relPath));
}
