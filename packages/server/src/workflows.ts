/**
 * 工作流定义的服务端存储。
 *
 * 存法刻意与 block/template 一致：**一个 JSON 文件一份定义**，落在数据目录下。
 * 好处是能直接打开看、能进版本库、坏了只坏一个文件；坏处是没有索引——
 * 但工作流数量是"几十"这个量级，全量读进内存完全够用。
 *
 * 内置预设（海报）不进这里：它在代码里生成，参数（目标、品牌）来自本次请求。
 * 这里只存用户"另存/自建"的那些。
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowDef } from '@mediasandbox/orchestrator';

export class WorkflowStore {
  private readonly defs = new Map<string, WorkflowDef>();

  constructor(private readonly dir: string) {}

  /** 启动时读一遍。单个坏文件只跳过它，不影响其它工作流。 */
  async load(onError?: (message: string, error: unknown) => void): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this.dir, file), 'utf8');
        const def = JSON.parse(raw) as WorkflowDef;
        if (typeof def.id === 'string' && Array.isArray(def.nodes)) this.defs.set(def.id, def);
      } catch (error) {
        onError?.(`工作流文件 ${file} 读取失败，已跳过`, error);
      }
    }
  }

  list(): readonly WorkflowDef[] {
    return [...this.defs.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  get(id: string): WorkflowDef | undefined {
    return this.defs.get(id);
  }

  async save(def: WorkflowDef): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const next: WorkflowDef = { ...def, updatedAt: Date.now() };
    await writeFile(
      path.join(this.dir, `${safeName(def.id)}.json`),
      JSON.stringify(next, null, 2),
      'utf8',
    );
    this.defs.set(def.id, next);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.defs.has(id)) return false;
    this.defs.delete(id);
    await unlink(path.join(this.dir, `${safeName(id)}.json`)).catch(() => undefined);
    return true;
  }
}

/** id 直接拼文件名会出路径穿越；只允许安全字符，其余转下划线。 */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}
