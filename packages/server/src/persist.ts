/**
 * JSON 落盘：把"重启即丢"的东西存下来。
 *
 * ## 为什么是 JSON 而不是 SQLite
 *
 * 数据量在这个项目的量级上（一次运行 21KB 产物、十几条决策留痕），
 * 查询能力用不上，而**可读性**用得上：`runs/<id>/meta.json` 里就是逐轮决策留痕，
 * `events.ndjson` 就是执行轨迹 —— 演示时可以直接打开给评委看。
 *
 * `node:sqlite` 在 Node 24 上可用（实测建表通过），但它带一条
 * `ExperimentalWarning`，且 `.db` 是二进制、出问题不便手改。
 * 这里选了前者：**零依赖、纯文本、可回滚**。
 *
 * ## 为什么落盘的不是"整个 RunStore 的快照"
 *
 * 拆成两份，因为两者的写入模式完全不同：
 *
 * | 文件 | 模式 | 理由 |
 * |---|---|---|
 * | `meta.json` | 整体重写 | 它是**状态**，永远只关心最新值 |
 * | `events.ndjson` | 追加一行 | 它是**流水**，只增不改，追加比重写便宜几个数量级 |
 *
 * 一次运行可能产生上千条事件（那次无限重试就跑了 2107 条），
 * 整体重写会在每条事件上重写整个数组。
 *
 * ## 写入是"排队 + 异步"，不是同步
 *
 * 事件会连续到达。同步写会阻塞事件循环；并发写同一个文件会交错。
 * 因此每个 run 一条 promise 链：**顺序有保证，调用方不用等**。
 * 写失败只记日志、不抛出 —— 落盘失败不该让一次已经成功的运行变成失败。
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OrchestrationEvent } from '@mediasandbox/orchestrator';
import type { RunRecord } from './run-store.js';

/** 落盘接口。`RunStore` 只认这个，不认文件系统——这样它可以被单独测。 */
export interface RunPersist {
  /** 保存运行的元数据（整体重写）。 */
  saveMeta(record: RunRecord): void;
  /** 追加一条事件。 */
  appendEvent(runId: string, event: OrchestrationEvent): void;
}

/**
 * 池子类文件的写链键。
 *
 * 它们不是 run，但**同样需要顺序保证**：`templates.json` 是整体重写的，
 * 两次并发写会互相覆盖 —— 实测踩到过：连续"创建模板 → 删除模板"之后，
 * 创建那次的写入后落地，于是**删掉的模板在盘上复活了**。
 */
const BLOCKS_KEY = '#blocks';
const TEMPLATES_KEY = '#templates';

export interface PersistOptions {
  /** 数据根目录。子目录与文件由本模块自己建。 */
  readonly rootDir: string;
  /** 写失败时的日志出口。省略则静默（测试里用）。 */
  readonly onError?: ((message: string, error: unknown) => void) | undefined;
}

/** 落盘后的运行记录。`events` 不在 meta 里——它单独一份流水。 */
export interface PersistedRunMeta {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: RunRecord['status'];
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifacts: RunRecord['artifacts'];
  readonly attempts: RunRecord['attempts'];
  readonly sandboxId?: string | undefined;
  readonly planSummary?: RunRecord['planSummary'];
  readonly structure?: RunRecord['structure'];
  readonly reason?: string | undefined;
  readonly error?: string | undefined;
}

/** 装载回来的一条运行记录。 */
export interface LoadedRun {
  readonly record: RunRecord;
  readonly events: OrchestrationEvent[];
  /**
   * 装载时状态停在 `running`/`queued`（进程被杀，不是正常结束）。
   *
   * 单列一个标记而不是靠 `status` 判断：装载会把它如实改成 `failed`，
   * 改完之后"它曾经在跑"这个事实就再也读不出来了——而那正是
   * "要不要接管它留下的沙盒"的唯一依据。
   */
  interrupted?: boolean;
}

/**
 * 落盘存储。
 *
 * 目录布局：
 *
 * ```
 * <rootDir>/
 *   runs/<runId>/meta.json        运行状态（最新值）
 *   runs/<runId>/events.ndjson    事件流水（一行一条，追加式）
 *   blocks.json                   用户手打 / 导入 / 模型提议的 block
 *   templates.json                沉淀出来的模板
 * ```
 */
export class JsonPersist implements RunPersist {
  private readonly runsDir: string;
  readonly blocksFile: string;
  readonly templatesFile: string;

  /** 每个 run 一条写链，保证顺序。 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 根目录只需建一次。 */
  private ready: Promise<void> | undefined;

  constructor(private readonly options: PersistOptions) {
    this.runsDir = path.join(options.rootDir, 'runs');
    this.blocksFile = path.join(options.rootDir, 'blocks.json');
    this.templatesFile = path.join(options.rootDir, 'templates.json');
  }

  /** 建目录。只做一次，后续调用复用同一个 promise。 */
  private ensureReady(): Promise<void> {
    this.ready ??= mkdir(this.runsDir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  /** 把一件事排进某条写链。前一件失败不影响后一件。 */
  private enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((error: unknown) => {
      this.options.onError?.(`落盘失败（${key}）`, error);
    });
    this.chains.set(key, next);
  }

  saveMeta(record: RunRecord): void {
    const meta = toMeta(record);
    const file = path.join(this.runsDir, record.id, 'meta.json');
    this.enqueue(record.id, async () => {
      await this.ensureReady();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    });
  }

  appendEvent(runId: string, event: OrchestrationEvent): void {
    const file = path.join(this.runsDir, runId, 'events.ndjson');
    this.enqueue(runId, async () => {
      await this.ensureReady();
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
    });
  }

  /**
   * 读回所有运行记录，按开始时间**从新到旧**（与 `RunStore.list()` 一致）。
   *
   * 事件一并读回：WebSocket 的补发要用到它们，而"重启后补发不了历史事件"
   * 正是这次要修掉的东西之一。单个文件读不动就跳过那一条并报错，
   * 不让一份坏数据把整个服务拖得起不来。
   */
  async loadRuns(): Promise<LoadedRun[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir);
    } catch {
      return []; // 目录还不存在 = 第一次跑
    }

    const out: LoadedRun[] = [];
    for (const entry of entries) {
      const dir = path.join(this.runsDir, entry);
      try {
        const raw = await readFile(path.join(dir, 'meta.json'), 'utf8');
        const meta = JSON.parse(raw) as PersistedRunMeta;
        if (typeof meta.id !== 'string' || meta.id === '') {
          throw new Error('meta.json 缺少 id');
        }
        out.push({ record: fromMeta(meta), events: await this.loadEvents(dir) });
      } catch (error) {
        this.options.onError?.(`跳过无法读取的运行记录 ${entry}`, error);
      }
    }

    // 未正常结束的（进程被杀）状态停在 running/queued，重启后不可能再继续，
    // 如实标成 failed —— 让它永远显示"运行中"比标错更误导。
    for (const item of out) {
      if (item.record.status === 'running' || item.record.status === 'queued') {
        item.record.status = 'failed';
        item.record.error = '服务重启，该运行已中断';
        item.record.finishedAt ??= Date.now();
        // "被中断"要单独带出去：状态改成 failed 之后，"它留下的沙盒可能还活着"
        // 这条线索就没了，而启动时的接管只认它。
        item.interrupted = true;
      }
    }

    out.sort((a, b) => b.record.startedAt - a.record.startedAt);
    return out;
  }

  private async loadEvents(dir: string): Promise<OrchestrationEvent[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, 'events.ndjson'), 'utf8');
    } catch {
      return []; // 没有事件文件是正常的：运行可能一条都没产生就失败了
    }
    const events: OrchestrationEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line) as OrchestrationEvent);
      } catch {
        // 单行坏了（比如进程在写一半时被杀）只丢那一行，不让整个文件作废。
        this.options.onError?.('跳过一条无法解析的事件', line.slice(0, 120));
      }
    }
    return events;
  }

  /** 保存用户新增的 block（**只存外部来源的**，内置的由代码提供）。 */
  saveExternalBlocks(specs: readonly unknown[]): void {
    this.enqueue(BLOCKS_KEY, async () => {
      await this.ensureReady();
      await writeFile(this.blocksFile, `${JSON.stringify(specs, null, 2)}\n`, 'utf8');
    });
  }

  async loadExternalBlocks(): Promise<unknown[]> {
    return await this.readArray(this.blocksFile);
  }

  saveTemplates(specs: readonly unknown[]): void {
    this.enqueue(TEMPLATES_KEY, async () => {
      await this.ensureReady();
      await writeFile(this.templatesFile, `${JSON.stringify(specs, null, 2)}\n`, 'utf8');
    });
  }

  async loadTemplates(): Promise<unknown[]> {
    return await this.readArray(this.templatesFile);
  }

  private async readArray(file: string): Promise<unknown[]> {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      // 文件不存在（第一次跑）与文件坏了都返回空数组，但后者要报出来。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.onError?.(`无法读取 ${path.basename(file)}，按空处理`, error);
      }
      return [];
    }
  }

  /** 等所有在途写入落定。测试与优雅关闭用。 */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}

/** 内存版的落盘实现：什么都不做。给"不配 dataDir"的部署用。 */
export const NO_PERSIST: RunPersist = {
  saveMeta: () => undefined,
  appendEvent: () => undefined,
};

function toMeta(record: RunRecord): PersistedRunMeta {
  return {
    id: record.id,
    projectId: record.projectId,
    goal: record.goal,
    envType: record.envType,
    provider: record.provider,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    artifacts: record.artifacts,
    attempts: record.attempts,
    ...(record.sandboxId !== undefined ? { sandboxId: record.sandboxId } : {}),
    ...(record.planSummary !== undefined ? { planSummary: record.planSummary } : {}),
    ...(record.structure !== undefined ? { structure: record.structure } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

function fromMeta(meta: PersistedRunMeta): RunRecord {
  return {
    id: meta.id,
    projectId: meta.projectId,
    goal: meta.goal,
    envType: meta.envType,
    provider: meta.provider,
    status: meta.status,
    startedAt: meta.startedAt,
    ...(meta.finishedAt !== undefined ? { finishedAt: meta.finishedAt } : {}),
    events: [],
    artifacts: Array.isArray(meta.artifacts) ? [...meta.artifacts] : [],
    attempts: Array.isArray(meta.attempts) ? meta.attempts : [],
    ...(meta.sandboxId !== undefined ? { sandboxId: meta.sandboxId } : {}),
    ...(meta.planSummary !== undefined ? { planSummary: meta.planSummary } : {}),
    ...(meta.structure !== undefined ? { structure: meta.structure } : {}),
    ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
    ...(meta.error !== undefined ? { error: meta.error } : {}),
  };
}
