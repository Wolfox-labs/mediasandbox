/**
 * Docker 沙盒：用容器提供**真实的安全边界**。
 *
 * 与 LocalSandbox 的根本差别：本地实现是路径级隔离（进程仍以当前用户身份运行，
 * 能读写用户可及的任何文件）；这里通过容器把网络、文件系统、资源都关进笼子。
 *
 * 四项约束（每一项都有对应的 provider 测试）：
 *   1. **网络**：默认 `none`，容器完全没有网卡，出网必失败
 *   2. **文件**：只挂载项目工作区到 /workspace，容器内看不到宿主机其他路径
 *   3. **资源**：`--memory` / `--cpus` / `--pids-limit` 限制，超限被内核杀掉
 *   4. **只读根**：`ReadonlyRootfs`，根文件系统不可写，只有 /workspace 与 /tmp 可写
 *
 * 容器生命周期比沙盒句柄长：create() 起容器，destroy() 停并删。
 * 句柄 id 与容器名一一对应，因此进程重启后可以通过容器名重新接管。
 */
import { PassThrough } from 'node:stream';
import { SandboxError, type ExecResult } from '../types.js';

/**
 * 只依赖 DockerRemoteAPI 需要的那些 dockerode 能力。
 *
 * 不直接 import dockerode 的类型，是为了让本文件在没装 dockerode 时也能通过类型检查——
 * 它是可选依赖，只有真正用 Docker 时才需要装。
 */
export interface DockerContainer {
  readonly id: string;
  start(): Promise<void>;
  stop(options?: { t?: number }): Promise<void>;
  remove(options?: { force?: boolean; v?: boolean }): Promise<void>;
  inspect(): Promise<{
    State: { Running: boolean; ExitCode: number; Status: string };
    Config: { Image: string; Labels?: Record<string, string> | null };
  }>;
  exec(options: {
    Cmd: string[];
    WorkingDir?: string;
    Env?: string[];
    AttachStdout: boolean;
    AttachStderr: boolean;
    AttachStdin?: boolean;
    User?: string;
  }): Promise<{
    start(options: { hijack?: boolean; stdin?: boolean }): Promise<NodeJS.ReadableStream>;
    inspect(): Promise<{ ExitCode: number | null; Running: boolean }>;
  }>;
  putArchive(data: NodeJS.ReadableStream, options: { path: string }): Promise<void>;
  getArchive(options: { path: string }): Promise<NodeJS.ReadableStream>;
}

export interface DockerApi {
  createContainer(options: Record<string, unknown>): Promise<DockerContainer>;
  getContainer(id: string): DockerContainer;
  listContainers(options?: Record<string, unknown>): Promise<
    { Id: string; Names: string[]; Labels?: Record<string, string> }[]
  >;
  getImage(name: string): { inspect(): Promise<unknown> };
  pull?(image: string): Promise<NodeJS.ReadableStream>;
  modem?: unknown;
}

/** create() 时可调的约束参数。 */
export interface DockerLimits {
  /** 内存上限，如 '512m'。默认 512m。 */
  readonly memory?: string | undefined;
  /** CPU 配额（核数），如 1.5。默认 1。 */
  readonly cpus?: number | undefined;
  /** 进程数上限，防 fork 炸弹。默认 256。 */
  readonly pidsLimit?: number | undefined;
  /** 网络模式。默认 'none'（完全无网络）。 */
  readonly networkMode?: string | undefined;
  /** 单条命令的默认超时。默认 120_000。 */
  readonly execTimeoutMs?: number | undefined;
}

/** 所有字段都必填的版本，供内部使用。 */
export interface ResolvedDockerLimits {
  readonly memory: string;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly networkMode: string;
  readonly execTimeoutMs: number;
}

export const DEFAULT_LIMITS: ResolvedDockerLimits = {
  memory: '512m',
  cpus: 1,
  pidsLimit: 256,
  networkMode: 'none',
  execTimeoutMs: 120_000,
};

/** 把 dockerode 挂在 Error 上的 HTTP 状态码读出来。 */
export function statusCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'statusCode' in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

export function isNotFound(error: unknown): boolean {
  const code = statusCodeOf(error);
  if (code === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no such container|No such image|not found/i.test(message);
}

export function isConflict(error: unknown): boolean {
  const code = statusCodeOf(error);
  if (code === 409) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /already in use|already exists|is already running/i.test(message);
}

export type { ExecResult };
export { SandboxError, PassThrough };
