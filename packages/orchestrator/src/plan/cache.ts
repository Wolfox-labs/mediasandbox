/**
 * 节点级结果缓存。
 *
 * ## 为什么要它
 *
 * 一条工作流里真正花钱/花时间的通常只有两三个节点（执笔、生图、搜图），
 * 其余都是毫秒级的确定性变换。但此前的执行器**每次都从头跑**：
 * 改一个标题也要重新执笔整页、重新下载图片。
 *
 * ComfyUI 的核心手感正来自这里：**改了哪个节点，就只重跑它和它的下游**。
 * 做到这件事不需要"脏节点标记"——只要缓存的键是
 * `工具 id + 解析后的入参 + 上游产出的哈希`，那么：
 *
 *   - 改一个节点的参数 → 它的键变了 → 它重跑
 *   - 它的产出变了 → 下游的键跟着变 → 下游重跑
 *   - 没碰的旁支 → 键不变 → 全命中
 *
 * ## 键里为什么必须含上游产出
 *
 * 只对"节点自己声明的参数"做哈希是不够的：上游重新执笔写出的文案不同，
 * 下游的组装结果当然也该不同。把解析后的**入参**整个哈希掉，
 * 等价于把"上游产出"间接包含进来（入参就是上游产出解析出来的值）。
 *
 * 这个接口刻意做得很小：执行器只需要 `get` / `put`，
 * 缓存存哪里（内存、磁盘、对象存储）由实现决定。
 */
import type { Artifact } from '@mediasandbox/sandbox';
import type { PlanNode } from './types.js';

/** 缓存命中时返回的东西：与工具执行结果同构。 */
export interface CachedNodeResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly Artifact[];
  readonly summary: string;
}

export interface NodeCache {
  get(node: PlanNode, inputs: Readonly<Record<string, unknown>>): Promise<CachedNodeResult | undefined>;
  put(
    node: PlanNode,
    inputs: Readonly<Record<string, unknown>>,
    result: CachedNodeResult,
  ): Promise<void>;
}

/**
 * 缓存键：`<toolId>-<hash>`。
 *
 * 三个因子决定键，缺一不可：
 *   1. **版本号**：缓存格式变了就 +1（老键自然失效，不用手动清目录）
 *   2. **代码盐**：`MEDIASANDBOX_CACHE_SALT`。模板/渲染器改了但入参没变时，
 *      只有显式换盐才能让旧缓存失效——这是刻意的：**代码变更不该悄悄复用旧产物**，
 *      但也不该每次启动都全量重跑。
 *   3. `工具 id + 解析后的入参`
 */
export const NODE_CACHE_VERSION = 2;

export function cacheKeyFor(node: PlanNode, inputs: Readonly<Record<string, unknown>>): string {
  const payload = stableStringify({
    v: NODE_CACHE_VERSION,
    salt: process.env['MEDIASANDBOX_CACHE_SALT'] ?? '',
    tool: node.toolId,
    inputs,
  });
  return `${node.toolId}-${hashString(payload)}`;
}

/**
 * 稳定序列化：对象键排序、`Uint8Array` 转成带长度与内容摘要的占位。
 *
 * 不直接用 `JSON.stringify` 的原因：对象键顺序依赖插入顺序，
 * 同一份入参换个构造顺序就会得到不同的键——缓存永远不命中，而且很难发现。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return `{"$bytes":${value.length},"$sum":${hashString(Buffer.from(value).toString('base64'))}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** FNV-1a 64 位（用两段 32 位实现），够短、够稳定，不需要密码学强度。 */
export function hashString(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const part = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `${part(h1)}${part(h2)}`;
}

/**
 * 强制某些节点"当作没缓存"。
 *
 * 这是"重跑此节点及其下游"的实现方式：不删缓存、不做脏标记，
 * 只让点名节点的 `get` 直接落空。于是：
 *   - 它自己重跑；
 *   - 它的产出变了 → 下游的缓存键跟着变 → 下游自然重跑；
 *   - 旁支的键没变 → 继续命中。
 *
 * 比"清空整份缓存"精确，也比"维护依赖图失效"简单——后者要在缓存层重建一遍 DAG。
 */
export function forceCacheMiss(cache: NodeCache, nodeIds: ReadonlySet<string>): NodeCache {
  return {
    get: (node, inputs) =>
      nodeIds.has(node.id) ? Promise.resolve(undefined) : cache.get(node, inputs),
    put: (node, inputs, result) => cache.put(node, inputs, result),
  };
}
