/**
 * 服务入口。
 *
 * 启动一个进程，同时提供：
 *   - REST API（提交运行、查询状态、下载产物）
 *   - WebSocket（实时推送编排事件）
 *
 * 沙盒 provider 按环境变量选择：
 *   SANDBOX_PROVIDER=local   （默认）本地目录隔离，开发用
 *   SANDBOX_PROVIDER=docker  容器隔离，生产用
 */
import http from 'node:http';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_TOOLS,
  DEFAULT_POLICY,
  DemoDecisionClient,
  RizzoFlowClient,
  StubDecisionClient,
  ToolRegistry,
  OpenAiCompatibleClient,
  type DecisionClient,
  type LlmClient,
} from '@mediasandbox/orchestrator';
import {
  DockerSandbox,
  LocalSandbox,
  type DockerApi,
  type SandboxProvider,
} from '@mediasandbox/sandbox';
import { createServer } from './app.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '../../..', 'workspaces');
/** 前端构建产物目录。构建过就由本服务托管，使访问地址只有一个。 */
const WEB_DIST = path.resolve(HERE, '../../web/dist');

function log(message: string): void {
  process.stdout.write(`[mediasandbox] ${message}\n`);
}

/** 读一个非负整数环境变量。缺失或非法时用默认值。 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log(`环境变量值非法（${raw}），回落到默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

/**
 * 决策层三选一：
 *   - `MEDIASANDBOX_DECISION=demo`（默认）演示决策层：按目标关键词选工具，
 *     让演示链路自洽（"做一个网页"确实产出网页）
 *   - `MEDIASANDBOX_DECISION=stub` 固定回答的桩：与输入无关，用于测试
 *   - `MEDIASANDBOX_DECISION=rizzo` 真实 rizzo-flow（需先部署）
 */
function buildDecision(): DecisionClient {
  const mode = process.env['MEDIASANDBOX_DECISION'] ?? (process.env['MEDIASANDBOX_STUB_DECISION'] === '1' ? 'stub' : 'demo');

  if (mode === 'stub') {
    log('决策层：固定回答的桩（MEDIASANDBOX_DECISION=stub）');
    return new StubDecisionClient();
  }
  if (mode === 'rizzo') {
    const baseUrl = process.env['RIZZO_BASE_URL'] ?? 'http://127.0.0.1:8017';
    const model = process.env['RIZZO_MODEL'] ?? 'rizzo-latest';
    log(`决策层：RizzoFlowClient → ${baseUrl}（模型 ${model}）`);
    return new RizzoFlowClient({ baseUrl, model });
  }

  log('决策层：演示模式（关键词判断，非真实模型；MEDIASANDBOX_DECISION=rizzo 可切真实模型）');
  return new DemoDecisionClient();
}

/**
 * 生成层：未配置 API key 时返回 undefined，编排层会走确定性工具。
 *
 * 两种接法：
 *   - 预置厂商：`LLM_PROVIDER=deepseek`（见 PROVIDERS 表）
 *   - 任意 OpenAI 兼容端点：`LLM_BASE_URL=https://.../v1`（优先于 provider）
 */
function buildLlm(): LlmClient | undefined {
  const apiKey = process.env['LLM_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    log('生成层：未配置 LLM_API_KEY，生成式工具将不可用（确定性工具仍可工作）');
    return undefined;
  }
  const baseUrl = process.env['LLM_BASE_URL'];
  const model = process.env['LLM_MODEL'];
  // 显式给了 baseUrl 就按自定义端点接；否则用预置 profile。
  const target =
    baseUrl !== undefined && baseUrl !== ''
      ? `自定义端点 ${baseUrl}`
      : `provider=${process.env['LLM_PROVIDER'] ?? 'deepseek'}`;
  log(`生成层：OpenAiCompatibleClient（${target}${model !== undefined ? `，模型 ${model}` : ''}）`);
  return new OpenAiCompatibleClient({
    ...(baseUrl !== undefined && baseUrl !== ''
      ? { baseUrl }
      : { provider: process.env['LLM_PROVIDER'] ?? 'deepseek' }),
    apiKey,
    ...(model !== undefined ? { defaultModel: model } : {}),
  });
}

async function buildProviders(): Promise<{
  providers: Record<string, SandboxProvider>;
  defaultProvider: string;
}> {
  const local = new LocalSandbox({ rootDir: path.join(WORKSPACE_ROOT, 'local') });
  const providers: Record<string, SandboxProvider> = { local };

  // Docker 是可选能力：装不上也要能起来（只有 local 可用）。
  try {
    const dockerode = await import('dockerode');
    const api = new dockerode.default() as unknown as DockerApi;
    providers['docker'] = new DockerSandbox({
      docker: api,
      rootDir: path.join(WORKSPACE_ROOT, 'docker'),
      autoPull: false,
    });
    log('已启用 docker provider');
  } catch (error) {
    log(`docker provider 不可用，仅用 local：${String(error)}`);
  }

  const requested = process.env['SANDBOX_PROVIDER'] ?? 'local';
  const defaultProvider = providers[requested] !== undefined ? requested : 'local';
  return { providers, defaultProvider };
}

async function main(): Promise<void> {
  const registry = new ToolRegistry().registerAll(BUILTIN_TOOLS);
  const decision = buildDecision();
  const llm = buildLlm();
  const { providers, defaultProvider } = await buildProviders();

  // 产物是从沙盒工作区实时读的，所以结束后要留一段时间才能下载。
  // 但必须设上限，否则每跑一次就永久多一个工作区（Local 目录 / Docker 容器）。
  const sandboxRetention = parseNonNegativeInt(process.env['SANDBOX_RETENTION'], 20);

  // 前端构建产物存在就一并托管，让"可运行版本"是一个地址。
  const webDistExists = await stat(WEB_DIST)
    .then((s) => s.isDirectory())
    .catch(() => false);

  const instance = createServer({
    registry,
    decision,
    ...(llm !== undefined ? { llm } : {}),
    providers,
    defaultProvider,
    policy: DEFAULT_POLICY,
    sandboxRetention: { maxRuns: sandboxRetention },
    ...(webDistExists ? { staticDir: WEB_DIST } : {}),
  });

  const server = http.createServer(instance.app);
  instance.attachWebSocket(server);

  const port = Number(process.env['PORT'] ?? 8787);
  const host = process.env['HOST'] ?? '127.0.0.1';

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log(`监听 http://${host}:${port}`);
  log(`  REST      http://${host}:${port}/api/health`);
  log(`  WebSocket ws://${host}:${port}/ws`);
  log(`  沙盒      ${defaultProvider}（可用: ${Object.keys(providers).join(', ')}）`);
  log(`  工作区    ${WORKSPACE_ROOT}`);
  log(`  保留      ${sandboxRetention} 个已结束运行的沙盒（SANDBOX_RETENTION 可调，0 = 不保留）`);
  if (!webDistExists) {
    log('  前端      未构建（跑 pnpm --filter @mediasandbox/web build 后即可经本服务访问）');
  }

  const shutdown = (signal: string): void => {
    log(`收到 ${signal}，正在关闭`);
    void instance.waitForIdle().finally(() => {
      server.close(() => process.exit(0));
      // 兜底：若连接迟迟不释放，3 秒后强退。
      setTimeout(() => process.exit(0), 3_000).unref();
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

await main();
