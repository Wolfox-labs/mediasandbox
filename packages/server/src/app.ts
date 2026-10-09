/**
 * HTTP + WebSocket 服务。
 *
 * 职责边界（刻意保持窄）：
 *   - 提交一次运行，返回 runId
 *   - 用 WebSocket 把编排事件实时推给前端
 *   - 查询运行状态、列出产物、下载产物
 *
 * 不做的事：这一层不做任何编排决策，也不缓存产物内容——
 * 产物始终从沙盒工作区读，服务端只保存路径。
 */
import express, { type Express, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import path from 'node:path';
import { mkdir, readdir, readFile, rm, stat as statFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { Artifact, EnvType, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import { ENV_TYPES } from '@mediasandbox/sandbox';
import {
  BLOCK_GROUP_LABELS,
  BlockError,
  Orchestrator,
  PageSpecError,
  TemplateError,
  builtinBlockIds,
  extractTemplate,
  type BlockGroup,
  type BlockInstance,
  type BlockRegistry,
  type BlockSpec,
  type DecisionClient,
  type FallbackPolicy,
  type LlmClient,
  type OrchestrationEvent,
  type PageSpec,
  type TemplateRegistry,
  type TemplateSpec,
  type ToolRegistry,
} from '@mediasandbox/orchestrator';
import { RunStore, compactStructure, makeRunId, toWireEvent, type RunRecord } from './run-store.js';
import { RunQueue, type QueuedRun } from './run-queue.js';
import { JsonPersist } from './persist.js';
import { BlockInputError, parseBlockSpec } from './block-input.js';
import {
  StructureInputError,
  applyStructureOps,
  buildRedoStructureInput,
  parsePageSpecInput,
  parseRedoBlockIds,
  parseStructureOps,
  validateStructureInput,
} from './structure-input.js';
import { createZip, type ZipEntry } from './zip.js';

export interface ServerDeps {
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly llm?: LlmClient | undefined;
  /**
   * block 池。结构化制作（`webpage` 环境）的候选集来源。
   *
   * 省略时服务器照常工作，只是 `/api/blocks` 与结构化链路的候选选取不可用——
   * 让"只有工具链"的既有测试与部署不必被迫提供它。
   */
  readonly blocks?: BlockRegistry | undefined;
  /**
   * 模板池。省略时 `/api/templates` 返回 503，且请求里带 `templateId` 会被拒。
   *
   * 与 `blocks` 一样是可选注入：既有测试与部署不必被迫提供它。
   */
  readonly templates?: TemplateRegistry | undefined;
  /**
   * 落盘存储。省略即纯内存（重启即丢）——既有测试与临时部署不必被迫提供它。
   *
   * 这里要的是**具体类**而不是 `RunPersist` 窄接口：启动重建要读回运行记录，
   * 而"读回"不在 `RunStore` 需要的那个写穿接口里。
   */
  readonly persist?: JsonPersist | undefined;
  /**
   * 交付物落定目录。
   *
   * 省略则产物**只在沙盒工作区里**——沙盒一被回收（保留额度满），产物就没了。
   *
   * 给了之后，每次运行结束会把 `artifacts/` **复制一份**到这里，与沙盒生命周期
   * 解耦。这么做是因为原来的取舍是反的：那套保留额度本来是为了"别让工作区无限增长"，
   * 代价却是**把交付物本身删掉**——对一个"产出交付物"的系统来说，等于把成果当垃圾清。
   *
   * 正确的分法是：**工作区照旧回收（那是临时空间），交付物单独留。**
   */
  readonly projectsDir?: string | undefined;
  /** 日志出口。落定失败之类"不该让运行失败但必须让人知道"的事走它。 */
  readonly onLog?: ((message: string) => void) | undefined;
  /** 按 provider 名取实现：'local' 或 'docker'。 */
  readonly providers: Readonly<Record<string, SandboxProvider>>;
  readonly defaultProvider: string;
  readonly policy?: FallbackPolicy | undefined;
  readonly nodeTimeoutMs?: number | undefined;
  readonly decisionTimeoutMs?: number | undefined;
  /**
   * 沙盒保留策略。
   *
   * 沙盒工作区不能永不销毁——每跑一次就永久留下一个（Local 是目录，Docker 是容器），
   * 跑 100 次就有 100 个。取折中：**保留最近 N 个**，超出后按完成时间从旧到新销毁。
   *
   * **它管的是工作区，不是交付物**：配了 `projectsDir` 之后，产物在运行结束时已经
   * 落定一份，被淘汰的 run 照样下载得到。只有当 `projectsDir` 省略时，
   * 淘汰才会连带产物一起失去（那种情况返回 410）。
   * 设为 0 表示不留工作区——**交付物仍然留下**。
   */
  readonly sandboxRetention?:
    | {
        /** 最多保留多少个已结束 run 的沙盒。默认 20。 */
        readonly maxRuns?: number | undefined;
      }
    | undefined;
  /**
   * 并发上限与排队。
   *
   * 此前每来一个 `POST /api/runs` 就直接起一次运行，没有全局上限：批量提交会把
   * CPU / 内存 / 容器数一起推上去（Docker 下每个运行一个容器）。
   * 这里给"同时跑几个"一个明确的数字，超出的**排起来**，队列满则明确拒绝（429）。
   *
   * 省略即沿用默认值（2 并发 / 16 队列），与 `.env` 里的约定一致。
   */
  readonly concurrency?:
    | {
        /** 同时可运行的次数。默认 2。小于 1 会被夹到 1。 */
        readonly maxConcurrentRuns?: number | undefined;
        /** 等待队列长度。默认 16；0 表示不排队（超出并发直接 429）。 */
        readonly queueLimit?: number | undefined;
      }
    | undefined;
  /**
   * 落定产物（`projects/`）的清理策略。**默认不删**。
   *
   * 与 `sandboxRetention` 是两件事，别混：那个管的是**工作区**（随时可以重建），
   * 这个管的是**交付物**——沙盒被回收之后，落定副本就是唯一的一份。
   * 所以默认值是 0 = 一个都不删：默认删交付物不叫清理策略，叫静默的数据丢失。
   *
   * 需要控盘时把 `maxRunsPerProject` 设成正数：每个项目只留最近 N 次运行的落定目录，
   * 更旧的删掉（**在途运行的目录永远不碰**）。删掉之后那些 run 的产物下载会变成 410——
   * 与"沙盒超出额度被回收"的表现一致，运行记录本身照样查得到。
   */
  readonly projectsRetention?:
    | {
        /** 每个项目最多保留多少次已结束运行的落定产物。默认 0 = 不清理。 */
        readonly maxRunsPerProject?: number | undefined;
      }
    | undefined;
  /**
   * 前端构建产物目录。给了就由本服务直接托管静态文件，
   * 使"可运行版本"是单一地址（不需要另起前端服务器，也没有 CORS）。
   */
  readonly staticDir?: string | undefined;
}

export interface CreateServerResult {
  readonly app: Express;
  readonly store: RunStore;
  /** 挂到 HTTP server 上以启用 WebSocket。 */
  attachWebSocket(server: Server): WebSocketServer;
  /** 等待所有在途运行结束。测试与优雅关闭用。 */
  waitForIdle(): Promise<void>;
  /**
   * 从盘上读回历史运行记录。返回装载了几条。
   *
   * **刻意不放在构造里**：`createServer` 是同步的，而读盘是异步的。
   * 硬塞进去只会让调用方拿到一个"还没装好"的 store。
   * 调用方在 `listen()` 之前 await 它即可。
   */
  loadPersisted(): Promise<number>;
  /** 等所有在途落盘写完。测试与优雅关闭用。 */
  flushPersist(): Promise<void>;
}

/**
 * 解析环境类型。`'auto'` 是合法值——交给决策层判断"这是什么类型的任务"。
 *
 * 从 `ENV_TYPES` 派生，不写死字面量列表——加一个环境却漏改这里，
 * 表现是"前端能选，提交时被 400 拒绝"，而错误信息还写着旧的三种。
 */
function parseEnvType(value: unknown): EnvType | 'auto' | undefined {
  if (value === 'auto') return 'auto';
  return typeof value === 'string' && (ENV_TYPES as readonly string[]).includes(value)
    ? (value as EnvType)
    : undefined;
}

/** 受支持环境的可读列表，供错误信息与流水线提示用。 */
function envTypeList(): string {
  return `${ENV_TYPES.join(' / ')} / auto`;
}

/** 校验分组名。 */
function isBlockGroup(value: unknown): value is BlockGroup {
  return value === 'skeleton' || value === 'content' || value === 'interactive';
}

/**
 * 读路由参数并归一成 string。
 *
 * Express 5 的类型把 params 值标为 `string | string[]`（通配路由可能匹配多段）。
 * 我们的路由都是单段，但类型上必须处理这种情况——取第一个，缺失则给空串。
 */
function paramOf(req: Request, key: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function errorResponse(res: Response, status: number, message: string, detail?: string): void {
  res.status(status).json({ error: message, ...(detail !== undefined ? { detail } : {}) });
}

export function createServer(deps: ServerDeps): CreateServerResult {
  const store = new RunStore(deps.persist);

  // 沙盒 id 记在**运行记录**上（`record.sandboxId`），不再单独维护一张内存表。
  // 两张表就意味着两处真相：重启后内存表空了、产物明明还在那个沙盒里，
  // 却再也找不到它。记在记录上，落盘与读回都跟着记录走。
  /** 在途运行的 promise，用于优雅关闭。 */
  const inFlight = new Set<Promise<void>>();
  /** WebSocket 订阅者。显式记录 socket，便于断开时精确移除。 */
  const subscribers = new Map<WebSocket, { runId: string | null }>();
  /** 已结束的 run 的完成时间，按结束先后排序，用于淘汰最旧的沙盒。 */
  const finishedRuns: { runId: string; finishedAt: number }[] = [];

  const retention = deps.sandboxRetention?.maxRuns ?? 20;
  /**
   * 排队中的任务，按 runId 索引。
   *
   * 队列本身只知道"有哪些任务在排"，回答不了"这个 runId 排第几"——
   * 而位次要报给调用方，所以这里留一张 runId → job 的表。
   * 任务一旦开跑或结束就从表里摘掉：这张表只代表**还在排队**的那些。
   */
  const waiting = new Map<string, QueuedRun>();
  /**
   * 并发与排队。
   *
   * **默认 2 / 16**：保守值，因为每个运行都会起一个沙盒（Docker 下是一个容器）。
   * 队列满了回 429 而不是继续收——收进来的尽头是 OOM，而那时已经看不出是谁压垮的。
   */
  const queue = new RunQueue<QueuedRun>(
    async (job) => {
      // 开跑了就不再是"排队中"。
      waiting.delete(job.record.id);
      // 在途登记的**唯一入口**：优雅关闭要等在途的跑完，而"在途"只有这里知道。
      // 记在队列回调里而不是 POST 处理函数里，排队的任务被放行时才登记得上。
      const task = job.execute().finally(() => inFlight.delete(task));
      inFlight.add(task);
      try {
        await task;
      } finally {
        // 无论跑成什么样都要释放取消开关，否则表里会留下永远不会被 abort 的开关。
        store.finishRun(job.record.id);
      }
    },
    {
      maxConcurrent: deps.concurrency?.maxConcurrentRuns ?? 2,
      limit: deps.concurrency?.queueLimit ?? 16,
    },
  );

  /** 排队位次，1 起。不在排队时返回空对象——展开进响应里就是"没有这个字段"。 */
  function queuePositionOf(runId: string): { queuePosition?: number } {
    const job = waiting.get(runId);
    if (job === undefined) return {};
    const position = queue.positionOf(job);
    return position === undefined ? {} : { queuePosition: position };
  }

  /**
   * 淘汰超出保留额度的沙盒，从最旧的已结束 run 开始销毁。
   *
   * 只销毁**已结束**的 run：在途运行的沙盒正在被写，不能碰。
   * 额度为 0 时每个 run 一结束就销毁（产物随之下不下来，这是调用方的选择）。
   */
  async function reclaimSandboxes(): Promise<void> {
    // 额度为 0 时这个循环同样会执行：它会把刚登记的那个 run 也淘汰掉。
    while (finishedRuns.length > retention) {
      const oldest = finishedRuns.shift();
      if (oldest === undefined) break;
      const record = store.get(oldest.runId);
      const sandboxId = record?.sandboxId;
      if (record === undefined || sandboxId === undefined) continue;
      const provider = deps.providers[record.provider];
      try {
        if (provider !== undefined) {
          const handle = await provider.get(sandboxId);
          if (handle !== undefined) await provider.destroy(handle);
        }
      } catch {
        // 销毁失败不该影响新运行的提交：最坏结果是多留一个工作区。
      } finally {
        // 沙盒没了，id 也就过期了：留着它会让"重启后接管"去认一个已经不存在的沙盒。
        store.update(oldest.runId, { sandboxId: undefined });
      }
    }
  }

  /**
   * 交付物落定目录：`<projectsDir>/<projectId>/runs/<runId>/`。
   *
   * 没配 `projectsDir` 就返回 undefined —— 那时的行为与从前一致
   * （产物只在沙盒里，随回收消失）。这条是**可选增强**，不是新的前提。
   */
  function settledDirFor(record: RunRecord): string | undefined {
    if (deps.projectsDir === undefined) return undefined;
    return path.join(deps.projectsDir, record.projectId, 'runs', record.id);
  }

  /**
   * 把一个产物路径拼到落定目录下。**越界一律返回 undefined**。
   *
   * 产物路径最终来自工具产出，不是可信输入。两道检查：段里不能有 `..`、
   * 不能是绝对路径；`resolve` 之后还必须仍在落定目录内。
   */
  function settledPathFor(record: RunRecord, artifactPath: string): string | undefined {
    const dir = settledDirFor(record);
    if (dir === undefined) return undefined;
    const rel = artifactPath.replace(/\\/g, '/');
    if (rel.startsWith('/') || rel.split('/').includes('..')) return undefined;
    const base = path.resolve(dir);
    const full = path.resolve(base, rel);
    return full.startsWith(`${base}${path.sep}`) ? full : undefined;
  }

  /**
   * 把这次运行的产物复制一份到落定目录。
   *
   * **在沙盒回收之前调用**：回收是不可逆的，落定失败还有机会重试，回收之后再无可能。
   * 落定失败**不让运行失败**——运行已经成功了，产物也在沙盒里；失败只记日志。
   */
  async function settleArtifacts(record: RunRecord, handle: SandboxHandle): Promise<void> {
    if (deps.projectsDir === undefined || record.artifacts.length === 0) return;
    const provider = deps.providers[record.provider];
    if (provider === undefined) return;

    let saved = 0;
    const failures: string[] = [];
    for (const artifact of record.artifacts) {
      const target = settledPathFor(record, artifact.path);
      if (target === undefined) {
        failures.push(`${artifact.path}（路径越界或不合法）`);
        continue;
      }
      try {
        const bytes = await provider.readFile(handle, artifact.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        saved += 1;
      } catch (error) {
        failures.push(
          `${artifact.path}（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }

    if (failures.length > 0) {
      deps.onLog?.(`运行 ${record.id} 有 ${failures.length} 个产物未能落定：${failures.join('；')}`);
    }
    if (saved > 0) {
      deps.onLog?.(`运行 ${record.id} 落定 ${saved} 个产物到 ${settledDirFor(record) ?? ''}`);
    }
  }

  /**
   * 清理落定产物：**默认什么都不做**，配了额度才删。
   *
   * 只删"超出额度"的那部分，从最旧的开始；两条硬性保护：
   *   1. **在途运行的目录不碰**——它正在被写；
   *   2. 删除目标必须落在 `projects/` 根目录之内（路径由 `readdir` 给出，
   *      但这里仍旧 `resolve` 后再比一次，不让任何拼接失控）。
   * 删除失败只记日志：清理是收尾动作，不该把一次成功的运行变成失败。
   */
  async function pruneSettledProjects(record: RunRecord): Promise<void> {
    const limit = deps.projectsRetention?.maxRunsPerProject ?? 0;
    const root = deps.projectsDir;
    if (limit <= 0 || root === undefined) return;

    const runsDir = path.join(root, record.projectId, 'runs');
    let names: string[];
    try {
      names = await readdir(runsDir);
    } catch {
      return; // 还没落定过任何产物：没有可清理的东西
    }

    const dirs: { runId: string; mtimeMs: number }[] = [];
    for (const name of names) {
      try {
        const info = await statFile(path.join(runsDir, name));
        if (info.isDirectory()) dirs.push({ runId: name, mtimeMs: info.mtimeMs });
      } catch {
        // 单个目录读不到不影响其他目录的判断。
      }
    }
    if (dirs.length <= limit) return;

    // 新的在前，保留前 limit 个。
    dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const rootResolved = path.resolve(root);
    for (const doomed of dirs.slice(limit)) {
      const live = store.get(doomed.runId);
      if (live !== undefined && live.finishedAt === undefined) continue;

      const full = path.resolve(runsDir, doomed.runId);
      if (!full.startsWith(`${rootResolved}${path.sep}`)) continue;
      try {
        await rm(full, { recursive: true, force: true });
        deps.onLog?.(`清理落定产物：${doomed.runId}（超出每项目保留额度 ${limit}）`);
      } catch (error) {
        deps.onLog?.(
          `落定产物清理失败：${doomed.runId}（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
  }

  /**
   * 读一个产物：**先看落定副本，再看沙盒**。
   *
   * 顺序不能反：沙盒会被回收，落定副本不会。先问沙盒的话，回收之后就再也读不到，
   * 而副本明明还在——那正是这次要修掉的行为。
   */
  async function readArtifact(
    record: RunRecord,
    artifact: Artifact,
  ): Promise<
    { bytes: Uint8Array } | { error: 'NO_SANDBOX' } | { error: 'READ_FAILED'; detail: string }
  > {
    const settled = settledPathFor(record, artifact.path);
    if (settled !== undefined) {
      try {
        return { bytes: new Uint8Array(await readFile(settled)) };
      } catch {
        // 落定副本不在（老数据、或落定那一步失败过）→ 老老实实回沙盒取。
      }
    }

    const provider = deps.providers[record.provider];
    if (provider === undefined) return { error: 'NO_SANDBOX' };
    const handle =
      record.sandboxId === undefined ? undefined : await provider.get(record.sandboxId);
    if (handle === undefined) return { error: 'NO_SANDBOX' };
    try {
      return { bytes: await provider.readFile(handle, artifact.path) };
    } catch (error) {
      return { error: 'READ_FAILED', detail: String(error) };
    }
  }

  /**
   * 启动时把**被中断的运行**留下的沙盒接回来。
   *
   * 只接管这一类：它们的沙盒八成还活着，而历史运行的沙盒要么已被按额度回收、
   * 要么根本不需要——产物在运行结束时就落定过一份。每次 `adopt` 都要 list + inspect
   * （容器实现），对一堆历史运行做这件事只会拖慢启动。
   *
   * 失败**只记日志**：接管不上不影响启动，也不改变任何运行记录的状态。
   */
  async function adoptInterruptedSandboxes(
    items: readonly { readonly record: RunRecord; readonly interrupted?: boolean | undefined }[],
  ): Promise<void> {
    for (const { record, interrupted } of items) {
      if (interrupted !== true || record.sandboxId === undefined) continue;
      const provider = deps.providers[record.provider];
      if (provider === undefined) continue;
      const envType = (ENV_TYPES as readonly string[]).includes(record.envType)
        ? (record.envType as EnvType)
        : undefined;
      try {
        await provider.adopt(record.sandboxId, {
          projectId: record.projectId,
          ...(envType !== undefined ? { envType } : {}),
        });
        deps.onLog?.(`已接管被中断运行 ${record.id} 的沙盒 ${record.sandboxId}`);
      } catch (error) {
        deps.onLog?.(
          `接管沙盒失败（${record.id} / ${record.sandboxId}）：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 读回某次运行留下的分块内容（`src/blocks/<id>.json`，`fill-block` 的落点）。
   *
   * 读不到就**如实说清是哪一环断了**（沙盒被回收 / 句柄找不回 / 没有分块文件），
   * 而不是拿一份空内容去跑——那会把"重做一块"悄悄变成"整页重来"。
   */
  async function readSavedBlocks(
    record: RunRecord,
  ): Promise<{ blocks: Map<string, BlockInstance> } | { error: string; detail: string }> {
    const provider = deps.providers[record.provider];
    if (provider === undefined) {
      return { error: `这次运行用的 provider 不在本进程里: ${record.provider}`, detail: '读不回块内容' };
    }
    if (record.sandboxId === undefined) {
      return { error: '这次运行没有记下沙盒 id', detail: '读不回块内容' };
    }
    const handle = await provider.get(record.sandboxId);
    if (handle === undefined) {
      return {
        error: '沙盒已不在了，读不到块的现成内容',
        detail:
          `沙盒 ${record.sandboxId} 可能已按保留额度回收；` +
          '被中断的运行会在启动时自动接管，其余的要等它下次重跑',
      };
    }

    let files: Awaited<ReturnType<SandboxProvider['listFiles']>>;
    try {
      files = await provider.listFiles(handle, 'src/blocks/*.json');
    } catch (error) {
      return { error: '读取分块内容失败', detail: String(error) };
    }

    const blocks = new Map<string, BlockInstance>();
    for (const file of files) {
      try {
        const raw = await provider.readFile(handle, file.path);
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as BlockInstance;
        if (typeof parsed.id === 'string') blocks.set(parsed.id, parsed);
      } catch {
        // 单个坏文件不该让整次重做失败：那一块会被当成"没有内容"重新填。
      }
    }
    return { blocks };
  }

  function broadcast(runId: string, event: OrchestrationEvent): void {
    const payload = JSON.stringify(toWireEvent(runId, event));
    for (const [socket, filter] of subscribers) {
      if (filter.runId !== null && filter.runId !== runId) continue;
      sendRaw(socket, payload);
    }
  }

  function sendRaw(socket: WebSocket, payload: string): void {
    // readyState 1 = OPEN。用字面量避免依赖 ws 的常量导出形态。
    if (socket.readyState !== 1) return;
    try {
      socket.send(payload);
    } catch {
      /* 发送失败通常是连接已断，忽略 */
    }
  }

  function send(socket: WebSocket, payload: unknown): void {
    sendRaw(socket, JSON.stringify(payload));
  }

  async function executeRun(args: {
    record: RunRecord;
    /**
     * 这次运行的取消开关。**由调用方在入队时建好**——排队中的运行也要能被取消，
     * 所以它不能等到真正开跑时才创建。
     */
    controller: AbortController;
    provider: SandboxProvider;
    goal: string;
    envType: EnvType | 'auto';
    /** 是否放行按次计费的生成工具（目前是生图）。默认 false。 */
    allowPaidGeneration?: boolean | undefined;
    tone?: string | undefined;
    minArtifacts?: number | undefined;
    /** 结构化链路（webpage 环境）专用参数。 */
    structured?: {
      readonly candidateBlockIds?: readonly string[] | undefined;
      readonly maxBlocks?: number | undefined;
      readonly brand?: string | undefined;
      readonly useGenerative?: boolean | undefined;
      readonly annotate?: boolean | undefined;
      /** 已从模板池解析出来的模板（不是 id）。 */
      readonly template?: TemplateSpec | undefined;
      /** 既定结构：照它跑，结构不再由决策模型决定（"带指定 PageSpec 重跑"）。 */
      readonly pageSpec?: PageSpec | undefined;
      /** 是否在组装完成后截图（`artifacts/screenshot.png`）。默认 false。 */
      readonly screenshot?: boolean | undefined;
    };
  }): Promise<void> {
    const { record, provider, goal, envType } = args;
    const controller = args.controller;
    // controller 已在入队时注册（排队中就要能取消），这里只把状态推进到 running。
    store.update(record.id, { status: 'running' });

    const orchestrator = new Orchestrator();
    try {
      const result = await orchestrator.run(
        {
          projectId: record.projectId,
          goal,
          envType,
          // block 池**必须**是服务层那一个：结构化链路若自己新建一个内置池，
          // 外部来源（模型提议/手打/导入）的 block 就永远进不了候选集。
          ...(deps.blocks !== undefined ? { blocks: deps.blocks } : {}),
          ...(args.allowPaidGeneration !== undefined
            ? { allowPaidGeneration: args.allowPaidGeneration }
            : {}),
          ...(args.tone !== undefined ? { tone: args.tone } : {}),
          ...(args.minArtifacts !== undefined ? { minArtifacts: args.minArtifacts } : {}),
          ...(args.structured ?? {}),
        },
        {
          registry: deps.registry,
          decision: deps.decision,
          sandbox: provider,
          ...(deps.llm !== undefined ? { llm: deps.llm } : {}),
          ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
          ...(deps.nodeTimeoutMs !== undefined ? { nodeTimeoutMs: deps.nodeTimeoutMs } : {}),
          ...(deps.decisionTimeoutMs !== undefined
            ? { decisionTimeoutMs: deps.decisionTimeoutMs }
            : {}),
          signal: controller.signal,
          onEvent: (event) => {
            // 先落 store（供补发），再广播（供实时）。
            store.appendEvent(record.id, event);
            broadcast(record.id, event);
          },
        },
      );

      store.update(record.id, {
        // 沙盒 id 跟着记录落盘：重启之后还能找回这个句柄（容器实现靠容器名接管，
        // 本地实现靠目录名）。不记的话，重启就等于把这个沙盒丢了。
        sandboxId: result.handle.id,
        status: controller.signal.aborted
          ? 'cancelled'
          : result.status === 'succeeded'
            ? 'succeeded'
            : result.status,
        // 环境可能是决策层判出来的（请求里传的是 `auto`）。记下**实际**用的那个，
        // 否则运行记录里永远写着 "auto"，事后没法回答"这次到底走的哪条链路"。
        envType: result.envType,
        finishedAt: Date.now(),
        // 执行结果里的 artifacts 是 readonly，复制一份存进可变记录。
        artifacts: [...(result.execution?.artifacts ?? [])],
        attempts: result.attempts,
        // 结构是**产出**，不是过程：存下来之后刷新页面才还看得到。
        // 只靠 WebSocket 的 `plan_assembled` 事件的话，错过那一刻就永远没了。
        ...(result.structure !== undefined ? { structure: result.structure } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.plan !== undefined
          ? {
              planSummary: result.plan.nodes.map((n) => ({
                nodeId: n.id,
                toolId: n.toolId,
                note: n.note,
              })),
            }
          : {}),
      });

      // **落定必须在沙盒回收之前**：回收是不可逆的（`finally` 里就做），
      // 落定失败还有机会重试，回收之后再无可能。
      await settleArtifacts(record, result.handle);
    } catch (error) {
      store.update(record.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // 运行已结束，登记后按保留额度淘汰最旧的沙盒。
      // 放在 finally 里：失败与取消的 run 同样留下工作区，同样要算进额度。
      finishedRuns.push({ runId: record.id, finishedAt: Date.now() });
      await reclaimSandboxes();
      // 落定产物的清理是**可选的**（默认不删）；放在回收之后，
      // 顺序上先保证"产物已经落定"，再去考虑要不要删旧的。
      await pruneSettledProjects(record);
    }
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 静态前端（构建产物）。放在 API 路由之前，但只接管非 /api、非 /ws 的路径。
  // 这样"可访问版本"是一个地址，不需要另起一个前端服务器，也没有 CORS。
  const webRoot = deps.staticDir;
  if (webRoot !== undefined) {
    app.use(express.static(webRoot, { index: 'index.html' }));
  }

  // ── 健康检查 ────────────────────────────────────────────────────────
  app.get('/api/health', async (_req: Request, res: Response) => {
    const decisionHealth = await deps.decision.health().catch((error: unknown) => ({
      ok: false,
      detail: String(error),
    }));
    const llmHealth =
      deps.llm === undefined
        ? { ok: true, detail: '未配置生成层' }
        : await deps.llm
            .health()
            .catch((error: unknown) => ({ ok: false, detail: String(error) }));

    res.json({
      ok: decisionHealth.ok,
      decision: decisionHealth,
      llm: llmHealth,
      providers: Object.keys(deps.providers),
      defaultProvider: deps.defaultProvider,
      toolCount: deps.registry.size,
    });
  });

  // ── 提交运行 ────────────────────────────────────────────────────────
  app.post('/api/runs', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = typeof body['goal'] === 'string' ? body['goal'].trim() : '';
    if (goal === '') {
      errorResponse(res, 400, 'goal 不能为空');
      return;
    }

    // **不传就是 `auto`**：让决策层判断"这是什么类型的任务"（设计稿 §3.2 第一问）。
    // 从前缺省是 `copy`，一个图像需求会被静默当成文案任务处理。
    const envType = parseEnvType(body['envType'] ?? 'auto');
    if (envType === undefined) {
      errorResponse(res, 400, `envType 必须是 ${envTypeList()} 之一`);
      return;
    }

    // 两种"结构不由模型决定"的输入方式，最后都落到 `structureInput` 上：
    //   - `redoFrom` + `blockIds`：只重做某次运行里的几块
    //   - `pageSpec`：照一份完整的结构跑
    let structureInput: ReturnType<typeof parsePageSpecInput> | undefined;

    // ── 定点重做：从某次运行读回块的现成内容，只重填点名的块 ──────────────
    //
    // 与 `pageSpec` 并列的另一种输入：调用方只说"把哪一次运行的哪几块重做"，
    // 内容由服务端从**沙盒里那一份**读回来——比"发下去再发上来"少一圈，
    // 也不会出现"传回来的内容和沙盒里的不一样"。
    let redoBlockIds: readonly string[] | undefined;
    if (body['redoFrom'] !== undefined) {
      if (envType !== 'webpage') {
        errorResponse(res, 400, 'redoFrom 只对 webpage 环境有意义', `envType 是 ${envType}`);
        return;
      }
      if (typeof body['redoFrom'] !== 'string') {
        errorResponse(res, 400, 'redoFrom 必须是运行 id 字符串');
        return;
      }
      const source = store.get(body['redoFrom']);
      if (source === undefined) {
        errorResponse(res, 404, `找不到要重做的运行: ${body['redoFrom']}`);
        return;
      }
      if (source.structure === undefined) {
        errorResponse(res, 409, '那次运行没有结构化留痕', '只有 webpage 环境的结构化链路才有块可重做');
        return;
      }

      try {
        redoBlockIds = parseRedoBlockIds(body['blockIds'], source.structure.page);
      } catch (error) {
        if (error instanceof StructureInputError) {
          errorResponse(res, 400, error.message);
          return;
        }
        throw error;
      }

      const saved = await readSavedBlocks(source);
      if ('error' in saved) {
        errorResponse(res, 409, saved.error, saved.detail);
        return;
      }
      structureInput = buildRedoStructureInput({
        structure: source.structure,
        blocks: saved.blocks,
        targetIds: redoBlockIds,
      });
    }

    // ── 既定结构：「带指定 PageSpec 重跑」的入口 ─────────────────────────
    //
    // **必须显式传 webpage**：给个 auto 再让结构被另一条链路静默忽略，正是
    // "说了要照结构跑、结果没照"的那类缺陷。宁可在入口就拒掉。
    //
    // 解析放在这里、组装放到后面：先把外部输入验完再 `store.create`，
    // 否则一个 400 会留下一条永远 queued 的运行记录。
    if (body['pageSpec'] !== undefined) {
      if (envType !== 'webpage') {
        errorResponse(
          res,
          400,
          'pageSpec 只对 webpage 环境有意义',
          `envType 是 ${envType}；要按给定结构跑请显式传 webpage`,
        );
        return;
      }
      try {
        structureInput = parsePageSpecInput(body['pageSpec']);
      } catch (error) {
        if (error instanceof StructureInputError) {
          errorResponse(res, 400, error.message);
          return;
        }
        throw error;
      }
      // 语义这一层也在这里过：池子里没有的类型、filled 却缺必需 slot，
      // 现在就能回 400，而不是先收下这次运行、再让它跑成 failed。
      if (deps.blocks === undefined) {
        errorResponse(res, 503, '本次部署未装配 block 池', 'pageSpec 需要 block 池才能校验与执行');
        return;
      }
      try {
        validateStructureInput(structureInput, goal, deps.blocks);
      } catch (error) {
        if (error instanceof PageSpecError) {
          errorResponse(res, 400, error.message, `code=${error.code}`);
          return;
        }
        throw error;
      }
    }

    const providerName =
      typeof body['provider'] === 'string' ? body['provider'] : deps.defaultProvider;
    const provider = deps.providers[providerName];
    if (provider === undefined) {
      errorResponse(
        res,
        400,
        `未知 provider: ${providerName}`,
        `可用: ${Object.keys(deps.providers).join(', ')}`,
      );
      return;
    }

    const requestedProjectId = body['projectId'];
    const projectId =
      typeof requestedProjectId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requestedProjectId)
        ? requestedProjectId
        : undefined;

    const runId = makeRunId();
    const record = store.create({
      id: runId,
      projectId: projectId ?? runId,
      goal,
      envType,
      provider: providerName,
    });

    // 异步执行，立即返回 202。前端通过 WebSocket 跟进度。
    const candidateBlockIds = Array.isArray(body['candidateBlockIds'])
      ? body['candidateBlockIds'].filter((v): v is string => typeof v === 'string')
      : undefined;

    // 模板：请求里给的是 id，这里解析成模板本身再往下传。
    // 编排层只认"这一个模板长什么样"，不认"模板池在哪"。
    const templateId = typeof body['templateId'] === 'string' ? body['templateId'] : undefined;
    let template: TemplateSpec | undefined;
    // 给了既定结构时 `templateId` 被盖过：不解析也不校验——
    // 否则会拿一个**已被忽略**的参数把人挡在门外。
    if (templateId !== undefined && structureInput === undefined) {
      if (deps.templates === undefined) {
        errorResponse(res, 503, '本次部署未装配模板池', '服务启动时未提供 templates');
        return;
      }
      if (!deps.templates.has(templateId)) {
        errorResponse(
          res,
          400,
          `未知模板: ${templateId}`,
          `可用: ${deps.templates.specs().map((t) => t.id).join(', ')}`,
        );
        return;
      }
      template = deps.templates.get(templateId);
    }

    // 取消开关在**入队时**就建好并登记：排队中的运行也要能被取消。
    // 等到开跑才建的话，用户对排队中的运行点取消会毫无反应。
    const controller = new AbortController();
    store.registerController(record.id, controller);

    const job: QueuedRun = {
      record,
      controller,
      execute: () =>
        executeRun({
          record,
          // 入队时建的那个 controller 就是这次运行的取消开关：排队中被取消与跑动中
          // 被取消走的是同一个，两条路径的行为因此一致。队列把它的 signal 传下来，
          // 这里不需要再包一层。
          controller,
          provider,
          goal,
          envType,
          ...(typeof body['tone'] === 'string' ? { tone: body['tone'] } : {}),
          // **缺省是 false**：不放行按次计费的生成工具。
          // "实测生图要经过我的许可"这条纪律写进代码，而不是靠人记着。
          ...(typeof body['allowPaidGeneration'] === 'boolean'
            ? { allowPaidGeneration: body['allowPaidGeneration'] }
            : {}),
          ...(typeof body['minArtifacts'] === 'number'
            ? { minArtifacts: body['minArtifacts'] }
            : {}),
          structured: {
            ...(candidateBlockIds !== undefined && candidateBlockIds.length > 0
              ? { candidateBlockIds }
              : {}),
            ...(template !== undefined ? { template } : {}),
            ...(typeof body['maxBlocks'] === 'number' ? { maxBlocks: body['maxBlocks'] } : {}),
            ...(typeof body['brand'] === 'string' ? { brand: body['brand'] } : {}),
            // 缺省是 **false**：不显式要求就不调生成层。零成本是默认值。
            ...(typeof body['useGenerative'] === 'boolean'
              ? { useGenerative: body['useGenerative'] }
              : {}),
            ...(typeof body['annotate'] === 'boolean' ? { annotate: body['annotate'] } : {}),
            // 截图默认关：要求了才挂节点（与 useGenerative 同一条纪律）。
            ...(typeof body['screenshot'] === 'boolean' ? { screenshot: body['screenshot'] } : {}),
            // 定点重做：只有这些块挂填充节点，其余块原样透传。
            ...(redoBlockIds !== undefined ? { redoBlockIds } : {}),
            // 既定结构：带上它，结构**不再由决策模型决定**（templateId / candidateBlockIds /
            // maxBlocks 也就一并被盖过）。projectId 与 goal 取本次运行的：
            // 结构是上一次的产出，而这次要按这次的目标填、写进这次的沙盒。
            ...(structureInput !== undefined
              ? {
                  pageSpec: {
                    projectId: record.projectId,
                    goal,
                    templateId: structureInput.templateId,
                    // 候选集由**实际用到的块类型**派生（按首次出现去重，与 `blockTypesOf`
                    // 同一套语义）：结构已经定稿，那个候选集合是历史，不是这一问的输入。
                    candidateBlockIds: [...new Set(structureInput.blocks.map((b) => b.type))],
                    blocks: structureInput.blocks,
                    qualityScore: structureInput.qualityScore,
                    createdAt: Date.now(),
                  },
                }
              : {}),
          },
        }),
    };

    // 入队：有余额就立刻开跑，否则排队；队列满则**明确拒绝**。
    // 先入队再记账：被 429 挡掉的运行不该在服务端留下一条记录——
    // 否则列表里会多出一条永远排不上队的运行，而调用方以为它被拒了。
    const admission = queue.enqueue(job);
    if (!admission.accepted) {
      store.remove(record.id);
      errorResponse(
        res,
        429,
        admission.reason,
        `当前 ${admission.snapshot.running} 个在跑、${admission.snapshot.waiting} 个在排队；稍后重试`,
      );
      return;
    }
    // 只把**真的在排队**的记进表：立刻开跑的那个不是"排队中"，
    // 记进去会让 `queuePositionOf` 给一个已经在跑的运行报位次。
    if (!admission.started) waiting.set(record.id, job);

    // 被既定结构盖过的入参要**主动说出来**：不吭声的话，调用方会以为
    // 自己传的 templateId 起了作用，然后在页面上找不到原因。
    const ignored: string[] = [];
    if (structureInput !== undefined) {
      if (templateId !== undefined) ignored.push('templateId');
      if (candidateBlockIds !== undefined && candidateBlockIds.length > 0) {
        ignored.push('candidateBlockIds');
      }
      if (typeof body['maxBlocks'] === 'number') ignored.push('maxBlocks');
    }

    res.status(202).json({
      runId,
      // 立刻开始的报 `queued`（它马上会转 running），排队的报 `queued` 并带上位次。
      // 两种都报 `queued` 是因为 202 的语义就是"收下了，还没结束"；
      // 区别由 `queuePosition` 说清楚——**别让调用方去猜自己是不是在排队**。
      status: 'queued',
      ...(admission.started ? {} : { queuePosition: admission.position }),
      ...(redoBlockIds !== undefined
        ? { note: `定点重做：只重填 ${redoBlockIds.join('、')}，其余区块原样保留` }
        : ignored.length > 0
          ? { note: `已按 pageSpec 跑，以下入参被忽略：${ignored.join('、')}` }
          : {}),
    });
  });

  // ── 查询运行 ────────────────────────────────────────────────────────
  app.get('/api/runs', (_req: Request, res: Response) => {
    res.json({
      // 并发与排队的状态一并给出来：调用方据此知道"现在提交会不会被排上"，
      // 而不是提交完了才发现自己在排队。
      queue: queue.snapshot(),
      runs: store.list().map((r) => ({
        id: r.id,
        projectId: r.projectId,
        goal: r.goal,
        envType: r.envType,
        provider: r.provider,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        artifactCount: r.artifacts.length,
        // 排队中的运行带上位次：**光有 `queued` 状态看不出还要等多久**，
        // 而"我排第几"正是用户唯一能据以决定"等还是撤"的信息。
        ...queuePositionOf(r.id),
      })),
    });
  });

  app.get('/api/runs/:runId', (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    // 详情与列表带同一种位次字段：形状不一致的话，前端刷新一次就得写两套解析。
    res.json({ ...serializeRun(record), ...queuePositionOf(record.id) });
  });

  /**
   * 项目视图：把运行按 `projectId` 分组。
   *
   * 与 `/api/runs` 的区别是**视角**：那里是"每次运行"的流水，
   * 这里是"每个项目"的集合 —— 一个项目可能跑过多次（重试、换方案、改目标重来），
   * 项目页要把这些归到一起看。
   */
  app.get('/api/projects', (_req: Request, res: Response) => {
    const byProject = new Map<string, RunRecord[]>();
    for (const run of store.list()) {
      const list = byProject.get(run.projectId) ?? [];
      list.push(run);
      byProject.set(run.projectId, list);
    }

    const projects = [...byProject.entries()].map(([projectId, runs]) => {
      // 最近一次运行决定项目的展示状态 —— 项目"现在是什么样"看最后一次。
      const latest = runs[0]!;
      const artifacts = runs.flatMap((r) =>
        r.artifacts.map((a) => ({ ...a, runId: r.id })),
      );
      return {
        projectId,
        goal: latest.goal,
        envType: latest.envType,
        provider: latest.provider,
        status: latest.status,
        runCount: runs.length,
        artifactCount: artifacts.length,
        startedAt: latest.startedAt,
        updatedAt: Math.max(...runs.map((r) => r.finishedAt ?? r.startedAt)),
        runs: runs.map((r) => ({
          id: r.id,
          goal: r.goal,
          envType: r.envType,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          artifactCount: r.artifacts.length,
        })),
      };
    });

    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ projects });
  });

  /**
   * 导出项目产物为 ZIP。
   *
   * 只导出**当前保留期内**的产物：沙盒按额度回收（见 `sandboxRetention`），
   * 超期的产物读不到，这时如实跳过并在响应头里说明，而不是产出一个
   * 少文件的包让人以为导出成功了。
   */
  app.get('/api/projects/:projectId/export', async (req: Request, res: Response) => {
    const projectId = paramOf(req, 'projectId');
    const runs = store.list().filter((r) => r.projectId === projectId);
    if (runs.length === 0) {
      errorResponse(res, 404, '项目不存在');
      return;
    }

    const entries: ZipEntry[] = [];
    let skipped = 0;

    for (const run of runs) {
      for (const artifact of run.artifacts) {
        // 与单文件下载共用同一条读取路径：先落定副本、再沙盒。
        // 各写一份的话，"回收之后还能不能导出"会变成两个答案。
        const read = await readArtifact(run, artifact);
        if ('error' in read) {
          skipped += 1;
          continue;
        }
        // 包内路径带 run 前缀，避免多次运行的同名产物（都叫 artifacts/copy.md）互相覆盖。
        const shortRun = run.id.replace(/^run-/, '');
        entries.push({
          path: `${projectId}/${shortRun}/${artifact.path.split('/').pop() ?? 'artifact'}`,
          data: read.bytes,
        });
      }
    }

    if (entries.length === 0) {
      errorResponse(
        res,
        410,
        '没有可导出的产物',
        skipped > 0
          ? `${skipped} 个产物所在的沙盒已被回收，且没有落定副本`
          : '该项目还没有产物',
      );
      return;
    }

    const zip = createZip(entries);
    const safeName = projectId.replace(/[^\w.-]+/g, '_');
    res.setHeader('content-type', 'application/zip');
    res.setHeader(
      'content-disposition',
      `attachment; filename="${safeName}.zip"; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`,
    );
    res.setHeader('content-length', String(zip.byteLength));
    // 让调用方能知道有没有丢东西，而不是只能靠数文件个数。
    if (skipped > 0) res.setHeader('x-mediasandbox-skipped', String(skipped));
    res.send(zip);
  });

  app.get('/api/runs/:runId/artifacts', async (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    // `settled` 是**派生**出来的（落定副本还在不在），不是存下来的字段：
    // 存一份就要跟文件系统对账，而对账迟早会对不上。
    const artifacts = await Promise.all(
      record.artifacts.map(async (a) => {
        const settled = settledPathFor(record, a.path);
        const exists =
          settled !== undefined &&
          (await statFile(settled).then(
            () => true,
            () => false,
          ));
        return { ...a, settled: exists };
      }),
    );
    res.json({ artifacts });
  });

  /** 下载单个产物。名字只允许 artifacts/ 下的文件。 */
  app.get('/api/runs/:runId/artifacts/:name', async (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }

    const name = paramOf(req, 'name');
    const target = record.artifacts.find((a) => a.path === `artifacts/${name}`);
    if (target === undefined) {
      errorResponse(res, 404, '产物不存在');
      return;
    }

    const read = await readArtifact(record, target);
    if ('error' in read) {
      if (read.error === 'NO_SANDBOX') {
        errorResponse(res, 410, '沙盒已销毁，产物不可再读', '该产物也没有落定副本');
      } else {
        errorResponse(res, 500, '读取产物失败', read.detail);
      }
      return;
    }
    res.setHeader('content-type', target.mimeHint);
    res.setHeader('content-length', String(read.bytes.byteLength));
    res.send(Buffer.from(read.bytes));
  });

  app.post('/api/runs/:runId/cancel', (req: Request, res: Response) => {
    const runId = paramOf(req, 'runId');
    const record = store.get(runId);
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    // 排队中的运行**必须先摘出队列**再置状态：只 abort 不摘的话，名额一空出来
    // 它照样开跑——用户点了取消，运行却开始了。两件事缺一不可。
    const queued = waiting.get(runId);
    if (queued !== undefined) {
      queue.withdraw(queued);
      waiting.delete(runId);
    }
    const cancelled = store.cancel(runId);
    res.json({ runId, cancelled, ...(queued !== undefined ? { wasQueued: true } : {}) });
  });

  // ── 结构：读与改 ────────────────────────────────────────────────────
  //
  // 结构从 P1 起就是**产出**（`GET /api/runs/:id` 与 WebSocket 都带着它），
  // 但它此前只能读。下面两条是"读得明确、改得下来"的落点：
  // 前端要能定点增删移，并且**改完还在**（重启之后依然是改过的那份）。

  /** 单独取一份结构。形状与 run 详情、WebSocket 推的**同一个压缩函数**，前端只写一套解析。 */
  app.get('/api/runs/:runId/structure', (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    if (record.structure === undefined) {
      // 不是 404：运行**是**存在的，只是它不是结构化链路跑出来的（或还没定稿）。
      errorResponse(
        res,
        409,
        '这次运行没有结构化留痕',
        '只有 webpage 环境的结构化链路会产出结构；也可能是运行还没定稿',
      );
      return;
    }
    res.json({ runId: record.id, structure: compactStructure(record.structure) });
  });

  /**
   * 定点编辑结构并落库。
   *
   * 为什么是"op 列表"而不是"整份 PageSpec 覆盖"：前端拿到的是压缩视图
   * （块只有 id/type/status/slotNames），覆盖式提交会把它没看见的 slot 内容抹掉，
   * 而且绕过了增删移的语义校验（越界不夹取、找不到就报错）。
   */
  app.post('/api/runs/:runId/structure/ops', (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    // 先看"这次请求与这次运行合不合得上"，再看"部署能不能办"：
    // 一条本来就没有结构的运行，报"没装 block 池"会把排查方向带偏。
    if (record.structure === undefined) {
      errorResponse(res, 409, '这次运行没有结构化留痕', '没有结构可改');
      return;
    }
    // 跑动中改结构会与产出结构打架：run 结束时 `structure` 会被执行结果整个覆盖，
    // 用户刚做的编辑会**看起来生效、随后无声消失**。宁可现在拒掉。
    if (record.status === 'running' || record.status === 'queued') {
      errorResponse(res, 409, '运行还在进行中，不能改结构', '等它结束再改，否则编辑会被执行结果覆盖');
      return;
    }
    const registry = deps.blocks;
    if (registry === undefined) {
      errorResponse(res, 503, '本次部署未装配 block 池', '服务启动时未提供 blocks');
      return;
    }

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ops = parseStructureOps(body['ops']);
      const { page, fixes } = applyStructureOps(record.structure.page, ops, registry);
      // 落库走 `store.update`：它会把整条记录写穿到盘上（配了 dataDir 时）。
      store.update(record.id, { structure: { page, steps: record.structure.steps } });
      res.json({
        runId: record.id,
        applied: ops.length,
        structure: compactStructure({ page, steps: record.structure.steps }),
        // 规范化改了什么必须能被读出来：静默挪块会让人以为是自己记错了。
        fixes,
      });
    } catch (error) {
      if (error instanceof StructureInputError) {
        errorResponse(res, 400, error.message);
        return;
      }
      if (error instanceof PageSpecError) {
        errorResponse(res, 400, error.message, `code=${error.code}`);
        return;
      }
      throw error;
    }
  });

  /** 工具目录：前端据此展示"可以排布什么"。 */
  app.get('/api/tools', (req: Request, res: Response) => {
    const envType = parseEnvType(req.query['envType']);
    // `envType=auto` 表示"我还没定环境"——那时该列出**全部**工具，
    // 而不是拿 auto 去过滤（过滤不出任何东西，前端会以为一个工具都没有）。
    const specs =
      envType === undefined || envType === 'auto' ? deps.registry.specs() : deps.registry.filter({ envType });
    res.json({
      tools: specs.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        role: s.role,
        category: s.category,
        envTypes: s.envTypes,
        // 端口声明也一并给出：前端要展示"这个工具需要什么、产出什么"，
        // 而组装器连依赖正是靠它们（端口引用缺陷就出在这里）。
        inputs: s.inputs,
        outputs: s.outputs,
        ...(s.costHint !== undefined ? { costHint: s.costHint } : {}),
        ...(s.requiresCommands !== undefined ? { requiresCommands: s.requiresCommands } : {}),
      })),
    });
  });

  /**
   * block 池目录：前端据此展示"本次可以用哪些 block"。
   *
   * 这是「用户从候选池里选取本次要用的 block」的数据来源。
   * 池子与工具目录同构——都是"候选集来自注册表，扩展 = 加一条，不重训模型"。
   */
  app.get('/api/blocks', (req: Request, res: Response) => {
    const registry = deps.blocks;
    if (registry === undefined) {
      errorResponse(res, 503, '本次部署未装配 block 池', '服务启动时未提供 blocks');
      return;
    }
    const groupRaw = req.query['group'];
    const group = isBlockGroup(groupRaw) ? groupRaw : undefined;
    const specs = registry.filter(group !== undefined ? { group } : {});
    res.json({
      blocks: specs.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        group: s.group,
        groupLabel: BLOCK_GROUP_LABELS[s.group],
        canLead: s.canLead,
        repeatable: s.repeatable,
        // 版式位置约束：前端据此提示"这个块会固定在页面末尾"。
        placement: s.placement ?? 'any',
        costHint: s.costHint,
        slots: s.slots,
      })),
      groups: registry.groups().map((g) => ({
        id: g,
        label: BLOCK_GROUP_LABELS[g],
        count: registry.filter({ group: g }).length,
      })),
    });
  });

  /**
   * 模板目录：前端据此展示"起手可以用哪几套结构"。
   *
   * 模板与 block 池同构——都是"候选集来自注册表，扩展 = 加一条"。
   * `builtin` 标出"我们提供的"与"从你项目里沉淀的"，界面可以分开呈现。
   */
  app.get('/api/templates', (_req: Request, res: Response) => {
    const templates = deps.templates;
    if (templates === undefined) {
      errorResponse(res, 503, '本次部署未装配模板池', '服务启动时未提供 templates');
      return;
    }
    res.json({
      templates: templates.specs().map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        builtin: t.builtin,
        blocks: t.blocks.map((b) => ({ type: b.type })),
        allowedBlockIds: t.allowedBlockIds ?? null,
      })),
    });
  });

  /**
   * 注册一个 block（用户手打 / 导入 / 模型提议）。
   *
   * 设计稿 §2.2 说 block 池有四类来源，此前**只有内置那一类真的能进池子**：
   * 另外三类没有入口。这条接口补上入口，并走与内置完全相同的校验——
   * 提议不等于决定，而"能被选中"的前提是它先是个合法的声明。
   */
  app.post('/api/blocks', (req: Request, res: Response) => {
    const registry = deps.blocks;
    if (registry === undefined) {
      errorResponse(res, 503, '本次部署未装配 block 池', '服务启动时未提供 blocks');
      return;
    }
    let spec: BlockSpec;
    try {
      spec = parseBlockSpec(req.body);
    } catch (error) {
      if (error instanceof BlockInputError) {
        errorResponse(res, 400, error.message);
        return;
      }
      throw error;
    }
    try {
      registry.register(spec);
    } catch (error) {
      if (error instanceof BlockError) {
        errorResponse(res, 400, error.message, `code=${error.code}`);
        return;
      }
      throw error;
    }

    // 落盘只存**外部来源**的：内置的由代码提供，存一份只会造成两个真相来源。
    // 不 await：写入在 `JsonPersist` 内部**按文件排队**，顺序有保证——
    // 并发整文件写会互相覆盖，实测踩到过"删掉的模板在盘上复活"。
    saveExternalBlocks();

    res.status(201).json({
      block: { id: spec.id, label: spec.label, group: spec.group },
      // 说清它会被怎么渲染，而不是让用户自己发现：
      // 自定义 block 没有专属渲染器，但会**按 slot 声明走通用渲染**，不是占位块。
      note:
        '已入池。自定义 block 按声明的 slot 类型走通用渲染（title 出小标题、text 出段落、' +
        'code 出代码块、link 出链接、image 出图、list-* 出列表与图集）；' +
        '要专属版式需要内置渲染器。填充与结构决策已完全可用。',
    });
  });

  /**
   * 沉淀一个模板。
   *
   * 两种来源：
   *   - `fromRunId` —— 从某次运行的**定稿结构**提取（"越用越好用"的正路）
   *   - 直接给 `blocks` —— 手工定义一个起手结构
   *
   * 从历史提取时**只取结构、不取内容**：把上个项目的文案抄进新项目会串味。
   */
  app.post('/api/templates', (req: Request, res: Response) => {
    const templates = deps.templates;
    if (templates === undefined) {
      errorResponse(res, 503, '本次部署未装配模板池', '服务启动时未提供 templates');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const fromRunId = typeof body['fromRunId'] === 'string' ? body['fromRunId'] : undefined;
    let spec: TemplateSpec;

    try {
      if (fromRunId !== undefined) {
        const record = store.get(fromRunId);
        if (record === undefined) {
          errorResponse(res, 404, `找不到运行记录: ${fromRunId}`);
          return;
        }
        if (record.structure === undefined) {
          errorResponse(
            res,
            400,
            '这次运行没有结构留痕，无法沉淀',
            '只有 webpage 环境的结构化链路会产出结构',
          );
          return;
        }
        const id = typeof body['id'] === 'string' ? body['id'] : `from-${fromRunId.toLowerCase()}`;
        spec = extractTemplate(record.structure.page, {
          id,
          ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
          ...(typeof body['description'] === 'string' ? { description: body['description'] } : {}),
        });
      } else {
        if (!Array.isArray(body['blocks']) || body['blocks'].length === 0) {
          errorResponse(res, 400, '必须给 fromRunId（从历史沉淀）或 blocks（手工定义起手结构）');
          return;
        }
        spec = {
          id: typeof body['id'] === 'string' ? body['id'] : '',
          label: typeof body['label'] === 'string' ? body['label'] : '',
          description: typeof body['description'] === 'string' ? body['description'] : '',
          blocks: (body['blocks'] as unknown[]).map((entry) => {
            const item = (entry ?? {}) as Record<string, unknown>;
            if (typeof item['type'] !== 'string') {
              throw new BlockInputError('blocks 的每一项都要有 type');
            }
            return { type: item['type'] };
          }),
          ...(Array.isArray(body['allowedBlockIds'])
            ? {
                allowedBlockIds: body['allowedBlockIds'].filter(
                  (v): v is string => typeof v === 'string',
                ),
              }
            : {}),
          builtin: false,
        };
      }

      templates.register(spec);
    } catch (error) {
      if (error instanceof TemplateError || error instanceof BlockInputError) {
        errorResponse(res, 400, error.message, `code=${error.name}`);
        return;
      }
      throw error;
    }

    saveUserTemplates();
    res.status(201).json({
      template: {
        id: spec.id,
        label: spec.label,
        blocks: spec.blocks.map((b) => ({ type: b.type })),
      },
    });
  });

  /** 删掉一个**非内置**模板。内置模板不给删：删了下次启动还在，徒增困惑。 */
  app.delete('/api/templates/:templateId', (req: Request, res: Response) => {
    const templates = deps.templates;
    if (templates === undefined) {
      errorResponse(res, 503, '本次部署未装配模板池', '服务启动时未提供 templates');
      return;
    }
    const rawId = req.params['templateId'];
    const id = Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? '');
    if (!templates.has(id)) {
      errorResponse(res, 404, `未知模板: ${id}`);
      return;
    }
    if (templates.get(id).builtin) {
      errorResponse(res, 409, `${id} 是内置模板，不能删除`);
      return;
    }
    if (!templates.remove(id)) {
      errorResponse(res, 404, `未知模板: ${id}`);
      return;
    }
    saveUserTemplates();
    res.json({ removed: id });
  });

  /**
   * 把外部来源的 block 落盘。
   *
   * **只存非内置的**：内置的由代码提供，也存一份就会有两个真相来源，
   * 而它们迟早会不一致（改了代码忘了改数据文件）。
   */
  function saveExternalBlocks(): void {
    if (deps.persist === undefined || deps.blocks === undefined) return;
    const builtin = new Set(builtinBlockIds());
    const external = deps.blocks.specs().filter((s) => !builtin.has(s.id));
    deps.persist.saveExternalBlocks(external);
  }

  /** 把用户沉淀的模板落盘。理由同上：只存非内置的。 */
  function saveUserTemplates(): void {
    if (deps.persist === undefined || deps.templates === undefined) return;
    const userTemplates = deps.templates.specs().filter((t) => !t.builtin);
    deps.persist.saveTemplates(userTemplates);
  }

  // SPA 回退：非 /api、非 /ws 的 GET 一律交还 index.html。
  // 必须注册在所有 API 路由**之后**，否则会把 /api/* 也吞掉。
  if (webRoot !== undefined) {
    app.get(/^\/(?!api\/|ws$).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return {
    app,
    store,
    async loadPersisted(): Promise<number> {
      if (deps.persist === undefined) return 0;
      const items = await deps.persist.loadRuns();
      for (const item of items) store.adopt(item.record, item.events);
      await adoptInterruptedSandboxes(items);
      return items.length;
    },
    async flushPersist(): Promise<void> {
      await deps.persist?.flush();
    },
    async waitForIdle(): Promise<void> {
      // 在途任务可能在等待期间又派生了新的，循环直到清空。
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    attachWebSocket(server: Server): WebSocketServer {
      // path 固定，避免与将来的其他 WebSocket 端点混淆。
      const wss = new WebSocketServer({ server, path: '/ws' });

      wss.on('connection', (socket: WebSocket, request) => {
        const url = new URL(request.url ?? '/ws', 'http://localhost');
        const runIdFilter = url.searchParams.get('runId');
        subscribers.set(socket, { runId: runIdFilter });

        // 补发历史事件：客户端可能中途才连上。
        const targets =
          runIdFilter !== null
            ? [store.get(runIdFilter)].filter((r): r is RunRecord => r !== undefined)
            : store.list();

        for (const record of targets) {
          for (const event of record.events) {
            send(socket, toWireEvent(record.id, event));
          }
          // 已结束的运行补一个终态，免得前端一直等。
          if (record.status !== 'running' && record.status !== 'queued') {
            send(socket, {
              runId: record.id,
              type: 'run_state',
              status: record.status,
              artifacts: record.artifacts,
              reason: record.reason,
              at: Date.now(),
            });
          }
        }

        socket.on('close', () => {
          subscribers.delete(socket);
        });
        socket.on('error', () => {
          subscribers.delete(socket);
        });
      });

      return wss;
    },
  };
}

/** 裁剪后的 run 视图。事件不在这里返回，走 WebSocket。 */
function serializeRun(record: RunRecord): Record<string, unknown> {
  return {
    id: record.id,
    projectId: record.projectId,
    goal: record.goal,
    envType: record.envType,
    provider: record.provider,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    artifacts: record.artifacts,
    attempts: record.attempts,
    reason: record.reason,
    error: record.error,
    planSummary: record.planSummary,
    eventCount: record.events.length,
    // 与 WebSocket 推的是**同一个压缩函数**：刷新前后形状一致，前端只写一套解析。
    structure:
      record.structure !== undefined ? compactStructure(record.structure) : null,
  };
}
