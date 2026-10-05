/**
 * 极简 glob 匹配器。只支持 `*`、`**`、`?`，路径分隔符固定为 `/`。
 *
 * 语义（刻意保持可预测，便于两个 provider 行为一致）：
 *   - `*`  匹配单个路径段内的任意字符（不含 `/`）
 *   - `?`  匹配单个非 `/` 字符
 *   - `**` 匹配任意层级；写成 `**\/` 时匹配零个或多个目录前缀
 *   - 无 `/` 的模式锚定在根层，不会自动向下递归
 */

function globToRegExpSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        i += 1;
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      i += 1;
      out += '[^/]';
      continue;
    }
    i += 1;
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

export function compileGlob(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  return new RegExp(`^${globToRegExpSource(normalized)}$`);
}

export function matchesGlob(pattern: string, relPosixPath: string): boolean {
  return compileGlob(pattern).test(relPosixPath);
}
