import { spawn } from 'node:child_process';
import { SandboxError, type ExecResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = '\n...[输出被截断]...\n';

export interface RunCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly stdin?: string | undefined;
  /** 覆盖默认 shell。容器实现传 ['bash','-lc'] 之类。 */
  readonly shell?: { readonly file: string; readonly prefixArgs: readonly string[] } | undefined;
}

function defaultShell(): { file: string; prefixArgs: readonly string[] } {
  if (process.platform === 'win32') {
    // /d 跳过 AutoRun，/s 保留引号语义，/c 执行后退出。
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/d', '/s', '/c'] };
  }
  return { file: '/bin/sh', prefixArgs: ['-c'] };
}

/** 强制终止进程树。Windows 上 child.kill() 只杀直接子进程，孙进程会残留。 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

interface StreamBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendChunk(state: StreamBuffer, chunk: Buffer, limit: number): void {
  const remaining = limit - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (chunk.length <= remaining) {
    state.chunks.push(chunk);
    state.bytes += chunk.length;
    return;
  }
  state.chunks.push(chunk.subarray(0, remaining));
  state.bytes += remaining;
  state.truncated = true;
}

export async function runCommand(options: RunCommandOptions): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shell = options.shell ?? defaultShell();
  const startedAt = Date.now();

  const isWindows = process.platform === 'win32';

  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(shell.file, [...shell.prefixArgs, options.command], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      windowsHide: true,
      // Windows 上 Node 默认会对参数做一层引号转义，破坏命令里的内层引号，
      // 导致 `node -e "..."` 这类命令静默产出空输出。必须逐字传递。
      windowsVerbatimArguments: isWindows,
      // POSIX 下独立进程组，便于整组终止。
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out: StreamBuffer = { chunks: [], bytes: 0, truncated: false };
    const err: StreamBuffer = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const decode = (state: StreamBuffer): string =>
      Buffer.concat(state.chunks).toString('utf8') + (state.truncated ? TRUNCATION_MARKER : '');

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout: decode(out),
        stderr: decode(err),
        timedOut,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => appendChunk(out, chunk, maxOutputBytes));
    child.stderr.on('data', (chunk: Buffer) => appendChunk(err, chunk, maxOutputBytes));

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid !== undefined) void killTree(pid);
      // 宽限期：避免 taskkill 本身卡死导致 promise 永不 settle。
      killTimer = setTimeout(() => settle(-1), 5_000);
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(new SandboxError(`启动进程失败: ${error.message}`, 'UNSUPPORTED', { cause: error }));
    });

    child.on('close', (code) => settle(code ?? -1));

    child.stdin.end(options.stdin ?? '');
  });
}
