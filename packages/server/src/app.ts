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
import { mkdir, readFile, stat as statFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { Artifact, EnvType, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import { ENV_TYPES } from '@mediasandbox/sandbox';
import {
  BLOCK_GROUP_LABELS,
  BlockError,
  Orchestrator,
  TemplateError,
  builtinBlockIds,
  extractTemplate,
  type BlockGroup,
  type BlockRegistry,
  type BlockSpec,
  type DecisionClient,
  type FallbackPolicy,
  type LlmClient,
  type OrchestrationEvent,
  type TemplateRegistry,
  type TemplateSpec,
  type ToolRegistry,
} from '@mediasandbox/orchestrator';
import { RunStore, compactStructure, makeRunId, toWireEvent, type RunRecord } from './run-store.js';
import { JsonPersist } from './persist.js';
import { BlockInputError, parseBlockSpec } from './block-input.js';
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

  /** runId → 沙盒 id。产物下载时用来找回句柄。 */
  const sandboxIdByRun = new Map<string, string>();
  /** 在途运行的 promise，用于优雅关闭。 */
  const inFlight = new Set<Promise<void>>();
  /** WebSocket 订阅者。显式记录 socket，便于断开时精确移除。 */
  const subscribers = new Map<WebSocket, { runId: string | null }>();
  /** 已结束的 run 的完成时间，按结束先后排序，用于淘汰最旧的沙盒。 */
  const finishedRuns: { runId: string; finishedAt: number }[] = [];

  const retention = deps.sandboxRetention?.maxRuns ?? 20;

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
      const sandboxId = sandboxIdByRun.get(oldest.runId);
      if (sandboxId === undefined) continue;
      const record = store.get(oldest.runId);
      const provider = record === undefined ? undefined : deps.providers[record.provider];
      try {
        if (provider !== undefined) {
          const handle = await provider.get(sandboxId);
          if (handle !== undefined) await provider.destroy(handle);
        }
      } catch {
        // 销毁失败不该影响新运行的提交：最坏结果是多留一个工作区。
      } finally {
        sandboxIdByRun.delete(oldest.runId);
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
    const sandboxId = sandboxIdByRun.get(record.id);
    const handle = sandboxId === undefined ? undefined : await provider.get(sandboxId);
    if (handle === undefined) return { error: 'NO_SANDBOX' };
    try {
      return { bytes: await provider.readFile(handle, artifact.path) };
    } catch (error) {
      return { error: 'READ_FAILED', detail: String(error) };
    }
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
    };
  }): Promise<void> {
    const { record, provider, goal, envType } = args;
    const controller = new AbortController();
    store.registerController(record.id, controller);
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

      sandboxIdByRun.set(record.id, result.handle.id);

      store.update(record.id, {
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
  app.post('/api/runs', (req: Request, res: Response) => {
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
    if (templateId !== undefined) {
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

    const task = executeRun({
      record,
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
      },
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));

    res.status(202).json({ runId, status: 'queued' });
  });

  // ── 查询运行 ────────────────────────────────────────────────────────
  app.get('/api/runs', (_req: Request, res: Response) => {
    res.json({
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
      })),
    });
  });

  app.get('/api/runs/:runId', (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    res.json(serializeRun(record));
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
    if (store.get(runId) === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    res.json({ runId, cancelled: store.cancel(runId) });
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
      // 说清一件已知限制，而不是让用户自己发现：
      // 自定义 block 目前没有专属渲染器，页面上会落成一个带类型名的占位块。
      note: '已入池。自定义 block 暂无专属渲染器，页面上会渲染为占位块；填充与结构决策已完全可用。',
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
