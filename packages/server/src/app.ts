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
import type { Server } from 'node:http';
import type { EnvType, SandboxProvider } from '@mediasandbox/sandbox';
import {
  Orchestrator,
  type DecisionClient,
  type FallbackPolicy,
  type LlmClient,
  type OrchestrationEvent,
  type ToolRegistry,
} from '@mediasandbox/orchestrator';
import { RunStore, makeRunId, toWireEvent, type RunRecord } from './run-store.js';

export interface ServerDeps {
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly llm?: LlmClient | undefined;
  /** 按 provider 名取实现：'local' 或 'docker'。 */
  readonly providers: Readonly<Record<string, SandboxProvider>>;
  readonly defaultProvider: string;
  readonly policy?: FallbackPolicy | undefined;
  readonly nodeTimeoutMs?: number | undefined;
  readonly decisionTimeoutMs?: number | undefined;
}

export interface CreateServerResult {
  readonly app: Express;
  readonly store: RunStore;
  /** 挂到 HTTP server 上以启用 WebSocket。 */
  attachWebSocket(server: Server): WebSocketServer;
  /** 等待所有在途运行结束。测试与优雅关闭用。 */
  waitForIdle(): Promise<void>;
}

function parseEnvType(value: unknown): EnvType | undefined {
  return value === 'frontend' || value === 'image' || value === 'copy' ? value : undefined;
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
  const store = new RunStore();

  /** runId → 沙盒 id。产物下载时用来找回句柄。 */
  const sandboxIdByRun = new Map<string, string>();
  /** 在途运行的 promise，用于优雅关闭。 */
  const inFlight = new Set<Promise<void>>();
  /** WebSocket 订阅者。显式记录 socket，便于断开时精确移除。 */
  const subscribers = new Map<WebSocket, { runId: string | null }>();

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
    envType: EnvType;
    tone?: string | undefined;
    minArtifacts?: number | undefined;
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
          ...(args.tone !== undefined ? { tone: args.tone } : {}),
          ...(args.minArtifacts !== undefined ? { minArtifacts: args.minArtifacts } : {}),
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
        finishedAt: Date.now(),
        // 执行结果里的 artifacts 是 readonly，复制一份存进可变记录。
        artifacts: [...(result.execution?.artifacts ?? [])],
        attempts: result.attempts,
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
    } catch (error) {
      store.update(record.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

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

    const envType = parseEnvType(body['envType'] ?? 'copy');
    if (envType === undefined) {
      errorResponse(res, 400, 'envType 必须是 frontend / image / copy 之一');
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
    const task = executeRun({
      record,
      provider,
      goal,
      envType,
      ...(typeof body['tone'] === 'string' ? { tone: body['tone'] } : {}),
      ...(typeof body['minArtifacts'] === 'number'
        ? { minArtifacts: body['minArtifacts'] }
        : {}),
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

  app.get('/api/runs/:runId/artifacts', (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    res.json({ artifacts: record.artifacts });
  });

  /** 下载单个产物。名字只允许 artifacts/ 下的文件。 */
  app.get('/api/runs/:runId/artifacts/:name', async (req: Request, res: Response) => {
    const record = store.get(paramOf(req, 'runId'));
    if (record === undefined) {
      errorResponse(res, 404, '运行不存在');
      return;
    }
    const provider = deps.providers[record.provider];
    if (provider === undefined) {
      errorResponse(res, 500, `provider ${record.provider} 已不可用`);
      return;
    }

    const name = paramOf(req, 'name');
    const target = record.artifacts.find((a) => a.path === `artifacts/${name}`);
    if (target === undefined) {
      errorResponse(res, 404, '产物不存在');
      return;
    }

    const sandboxId = sandboxIdByRun.get(record.id);
    const handle = sandboxId === undefined ? undefined : await provider.get(sandboxId);
    if (handle === undefined) {
      errorResponse(res, 410, '沙盒已销毁，产物不可再读');
      return;
    }

    try {
      const bytes = await provider.readFile(handle, target.path);
      res.setHeader('content-type', target.mimeHint);
      res.setHeader('content-length', String(bytes.byteLength));
      res.send(Buffer.from(bytes));
    } catch (error) {
      errorResponse(res, 500, '读取产物失败', String(error));
    }
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
    const specs = deps.registry.filter(envType !== undefined ? { envType } : {});
    res.json({
      tools: specs.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        role: s.role,
        category: s.category,
        envTypes: s.envTypes,
      })),
    });
  });

  return {
    app,
    store,
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
  };
}
