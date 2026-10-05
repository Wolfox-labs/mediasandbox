import path from 'node:path';
import { SandboxError } from '../types.js';

/** 项目 id 白名单，防止用 ../ 或保留名污染工作区根。 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function assertValidProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new SandboxError(
      `非法 projectId: ${JSON.stringify(projectId)}（只允许字母数字与 . _ -，且不超过 64 字符）`,
      'PATH_ESCAPE',
    );
  }
  if (WINDOWS_RESERVED.has(projectId.toLowerCase())) {
    throw new SandboxError(`projectId 是 Windows 保留名: ${projectId}`, 'PATH_ESCAPE');
  }
}

/** 大小写不敏感比较（Windows / macOS），其余平台敏感。 */
function samePathRoot(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * 把相对路径解析到 root 之内，越界即抛 PATH_ESCAPE。
 * 只做词法解析：调用方若需符号链接安全，须另行 realpath 校验。
 */
export function resolveInside(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new SandboxError('路径不能为空', 'PATH_ESCAPE');
  }
  if (relPath.includes('\0')) {
    throw new SandboxError('路径含空字节', 'PATH_ESCAPE');
  }
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new SandboxError(`不允许绝对路径: ${relPath}`, 'PATH_ESCAPE');
  }

  const normalizedRoot = path.resolve(root);
  // 统一分隔符后交给 path.resolve，避免 Windows 上的 / 与 \ 混用歧义。
  const unified = relPath.replace(/[\\/]+/g, path.sep);
  const target = path.resolve(normalizedRoot, unified);

  if (samePathRoot(target, normalizedRoot)) {
    throw new SandboxError(`路径必须指向目录内的文件: ${relPath}`, 'PATH_ESCAPE');
  }
  const rel = path.relative(normalizedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError(`路径逃出沙盒: ${relPath}`, 'PATH_ESCAPE');
  }
  return target;
}

/** 把绝对路径还原成相对 root 的 POSIX 风格路径。 */
export function toPosixRelative(root: string, absolute: string): string {
  return path.relative(path.resolve(root), path.resolve(absolute)).split(path.sep).join('/');
}
