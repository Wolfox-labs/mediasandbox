/**
 * 磁盘版节点缓存：把一次节点执行的结果（端口产出 + 产物文件）存下来，
 * 下次同参数运行时直接复用。
 *
 * ## 为什么缓存要绑定沙盒
 *
 * 命中缓存时，下游节点需要的是**"上游节点刚才产出了什么"**，包括文件
 * （`artifacts/index.html` 这类路径会被下游当输入读）。
 * 所以命中不能只返回一段 JSON：必须把上次的产物文件重新写进本次的沙盒，
 * 否则下游会拿到"文件不存在"。这也是为什么这个实现要持有 sandbox + handle
 * 而不是一个纯函数。
 *
 * ## 什么不缓存
 *
 * 单个节点结果超过 `maxBytes`（默认 24 MB）就放弃缓存：
 * 内联了多张 base64 图片的页面能到 3 MB，再叠加几份就有把磁盘写爆的风险，
 * 而缓存的收益远小于"磁盘满导致整次运行失败"的代价。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { PlanNode } from '../plan/types.js';
import { cacheKeyFor, type CachedNodeResult, type NodeCache } from '../plan/cache.js';

export interface FileNodeCacheOptions {
  /** 缓存根目录，例如 `<项目>/data/node-cache`。 */
  readonly root: string;
  readonly sandbox: SandboxProvider;
  readonly handle: SandboxHandle;
  /** 单节点结果上限（字节）。超过就跳过缓存。 */
  readonly maxBytes?: number;
}

interface CacheMeta {
  readonly outputs: Record<string, unknown>;
  readonly artifacts: Artifact[];
  readonly summary: string;
  /** 产物路径列表（实际文件名做了 URL 编码，避免子目录问题）。 */
  readonly files: string[];
  readonly createdAt: number;
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

export class FileNodeCache implements NodeCache {
  constructor(private readonly options: FileNodeCacheOptions) {}

  async get(
    node: PlanNode,
    inputs: Readonly<Record<string, unknown>>,
  ): Promise<CachedNodeResult | undefined> {
    const dir = this.dirFor(node, inputs);
    let meta: CacheMeta;
    try {
      meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as CacheMeta;
    } catch {
      return undefined;
    }

    try {
      for (const relPath of meta.files) {
        const bytes = await readFile(path.join(dir, 'files', encodeURIComponent(relPath)));
        await this.options.sandbox.writeFile(this.options.handle, relPath, new Uint8Array(bytes));
      }
    } catch {
      // 文件缺了就把这条缓存当不存在：宁可重跑，也不要让下游读到半个结果。
      return undefined;
    }

    return { outputs: meta.outputs, artifacts: meta.artifacts, summary: meta.summary };
  }

  async put(
    node: PlanNode,
    inputs: Readonly<Record<string, unknown>>,
    result: CachedNodeResult,
  ): Promise<void> {
    const limit = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const dir = this.dirFor(node, inputs);

    const payloads: { relPath: string; bytes: Uint8Array }[] = [];
    let total = 0;
    for (const artifact of result.artifacts) {
      if (!(await this.options.sandbox.exists(this.options.handle, artifact.path))) continue;
      const bytes = await this.options.sandbox.readFile(this.options.handle, artifact.path);
      total += bytes.length;
      if (total > limit) return;
      payloads.push({ relPath: artifact.path, bytes });
    }

    const meta: CacheMeta = {
      outputs: result.outputs as Record<string, unknown>,
      artifacts: [...result.artifacts],
      summary: result.summary,
      files: payloads.map((payload) => payload.relPath),
      createdAt: Date.now(),
    };
    const metaJson = JSON.stringify(meta);
    if (Buffer.byteLength(metaJson, 'utf8') > limit) return;

    await mkdir(path.join(dir, 'files'), { recursive: true });
    for (const payload of payloads) {
      await writeFile(path.join(dir, 'files', encodeURIComponent(payload.relPath)), payload.bytes);
    }
    await writeFile(path.join(dir, 'meta.json'), metaJson);
  }

  private dirFor(node: PlanNode, inputs: Readonly<Record<string, unknown>>): string {
    return path.join(this.options.root, cacheKeyFor(node, inputs));
  }
}
