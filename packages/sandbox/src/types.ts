/**
 * 沙盒抽象接口。
 *
 * 上层编排代码只依赖本文件的类型。LocalSandbox 与 DockerSandbox 是两个实现，
 * 必须通过同一套 provider 测试（见 src/testing/provider-suite.ts）。
 */

/**
 * 沙盒环境预设。每个预设对应一套预装工具链。
 *
 * `webpage` 与 `frontend` 并存而不是取代它：后者是"整页生成"链路，
 * 通着、有测试、有真实产出验证过；前者是**结构化制作**链路（block 级粒度），
 * 直接改造会同时破坏两条路。
 */
export type EnvType = 'frontend' | 'image' | 'copy' | 'webpage';

export const ENV_TYPES: readonly EnvType[] = ['frontend', 'image', 'copy', 'webpage'];

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
  /**
   * 是否为这次执行分配 TTY。默认 **false**。
   *
   * 打开它有两个**必须知道**的后果（容器实现的附流格式因此不同）：
   *   1. 输出变成**裸流**（没有多路复用帧头），错解会让输出从第 9 字节开始错位
   *   2. stdout 与 stderr **在容器侧合并**：`stderr` 会是空串，这不是丢数据，
   *      而是容器侧本来就不再分流
   *
   * 本地实现忽略它（本来就只有一条管道，且两个流天然分开）。
   */
  readonly tty?: boolean;
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

// ── 长驻进程 ────────────────────────────────────────────────────────────

/** 起一个长驻进程的参数。 */
export interface StartProcessOptions {
  /** 工作目录，相对于 workDir。默认 workDir 本身。 */
  readonly cwd?: string;
  /** 传给进程的环境变量，与沙盒基线环境合并。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 是否分配 TTY。默认 false。语义与 `ExecOptions.tty` 相同。 */
  readonly tty?: boolean;
  /** 单流输出上限（字节）。超出部分丢弃并置 `truncated`。默认 1 MiB。 */
  readonly maxOutputBytes?: number;
}

/** 一次增量读取的结果。 */
export interface ProcessOutput {
  /** 自**上次读取**以来新增的 stdout。 */
  readonly stdout: string;
  readonly stderr: string;
  /** 期间是否有输出因超出上限被丢弃。 */
  readonly truncated: boolean;
}

export interface ProcessStatus {
  readonly running: boolean;
  /** 已退出时是退出码；仍在跑或拿不到时为 null。 */
  readonly exitCode: number | null;
}

/**
 * 沙盒里的一个**长驻进程**。
 *
 * 与 `exec` 的差别只有一条，但要紧：**它没有超时**，会一直活着，直到 `kill()`
 * 或沙盒被销毁。所以有两件事必须由实现兜住：
 *
 *   1. **销毁沙盒时把它的进程一起带走**。否则"沙盒没了、进程还在"是最难查的残留：
 *      它继续占端口、继续写工作区，而记录里那个沙盒已经不存在了。
 *   2. **没人读的输出要攒着，但有上限**。攒是为了"起完进程过一会儿再来读"这种用法，
 *      上限是为了别把服务进程的内存吃光。
 */
export interface SandboxProcess {
  readonly id: string;
  readonly command: string;
  readonly startedAt: number;
  /**
   * 写入 stdin。
   *
   * 进程已经退出时返回 `false`，**不抛错**：长驻进程自己退出是常态
   * （命令行工具跑完就退），不该让调用方去 catch 一个"正常结局"。
   */
  write(data: string): Promise<boolean>;
  /** 读走自上次读取以来的新输出。 */
  read(): Promise<ProcessOutput>;
  status(): Promise<ProcessStatus>;
  /** 终止并释放。幂等：重复调用、以及对已退出的进程调用，都不报错。 */
  kill(): Promise<void>;
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

/**
 * 接管已有沙盒时的身份提示。
 *
 * 句柄上有 `projectId` 与 `envType`，而**沙盒本身不一定记得**：
 * 容器实现把它们写在容器标签里（自己建的容器一定有），本地实现只能从目录名反推。
 * 调用方手里有准确值时给出来，两边都不必猜。
 */
export interface AdoptHint {
  readonly projectId?: string | undefined;
  readonly envType?: EnvType | undefined;
}

export interface SandboxProvider {
  readonly kind: 'local' | 'docker';

  /**
   * 创建沙盒。同一 projectId 重复创建应返回可复用的句柄或抛错，
   * 由实现决定；测试套件要求 create() 后 get() 能找到它。
   */
  create(projectId: string, envType: EnvType): Promise<SandboxHandle>;

  /** 取回已存在的句柄；不存在返回 undefined。 */
  get(sandboxId: string): Promise<SandboxHandle | undefined>;

  /**
   * **接管一个已经存在的沙盒**——进程重启后按 id 找回可用句柄。
   *
   * 与 `get` 的分工：`get` 回答"在不在"（不在就 `undefined`），
   * `adopt` 是**动作**，用于"我认为它还在"的场合；因此不存在时**抛
   * `NO_SUCH_SANDBOX`**，而不是静默返回 `undefined`——后者会把
   * "我记错了"和"它被回收了"两件事混成一件。
   *
   * `hint` 只在实现自己认不出来时才用得上（容器看标签、本地看目录名）。
   * 两处都认不出来时必须抛错，**不许拿 'unknown' 之类占位值凑一个句柄**：
   * 那样的句柄会把假的项目名写进环境变量与派生文案里，比找不到更难查。
   */
  adopt(sandboxId: string, hint?: AdoptHint): Promise<SandboxHandle>;

  exec(handle: SandboxHandle, command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * 起一个**长驻进程**并拿回它的句柄（服务、交互式工具，将来还有浏览器）。
   *
   * 与 `exec` 的分工：`exec` 是"跑完给我结果"，有超时、超时即杀；
   * `start` 是"起起来，之后我按需读写、由我决定什么时候停"。
   * 两者不能合并——把长驻进程塞进 `exec`，等于一上来就给它定了死刑期限，
   * 而"起来之后等我下一步"恰恰是它存在的理由。
   */
  start(
    handle: SandboxHandle,
    command: string,
    options?: StartProcessOptions,
  ): Promise<SandboxProcess>;

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
