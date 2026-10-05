/**
 * 产物收集的共用判定。
 *
 * 环境预设会在 artifacts/ 下建空的 `.gitkeep` 来保留目录结构——那是脚手架，
 * 不是交付产物。若不排除，`collectArtifacts()` 的第一个结果会是 0 字节的空文件，
 * 下载接口与前端展示都会被它带偏（这个坑在服务端测试里真实暴露过）。
 */

/** 是占位文件（.gitkeep / .keep / .gitignore 之类）？ */
export function isPlaceholderFile(relPosixPath: string): boolean {
  const name = relPosixPath.split('/').pop() ?? '';
  return name === '.gitkeep' || name === '.keep' || name === '.gitignore';
}

/**
 * 该文件是否算作交付产物。
 *
 * 规则刻意保守：**空文件不算**。产物的意义是有内容可交付，
 * 0 字节的文件对使用者没有价值，把它算进去只会制造"有产物"的假象。
 */
export function isDeliverableArtifact(entry: { readonly path: string; readonly size: number }): boolean {
  if (entry.size <= 0) return false;
  return !isPlaceholderFile(entry.path);
}
