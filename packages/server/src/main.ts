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
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_TOOLS,
  DEFAULT_POLICY,
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

/** 决策层：默认连本地 rizzo-flow；显式设 STUB=1 时用桩（无模型也能跑通链路）。 */
function buildDecision(): DecisionClient {
  if (process.env['MEDIASANDBOX_STUB_DECISION'] === '1') {
    log('决策层：使用桩实现（MEDIASANDBOX_STUB_DECISION=1）');
    return new StubDecisionClient();
  }
  const baseUrl = process.env['RIZZO_BASE_URL'] ?? 'http://127.0.0.1:8017';
  const model = process.env['RIZZO_MODEL'] ?? 'rizzo-latest';
  log(`决策层：RizzoFlowClient → ${baseUrl}（模型 ${model}）`);
  return new RizzoFlowClient({ baseUrl, model });
}

/** 生成层：未配置 API key 时返回 undefined，编排层会走确定性工具。 */
function buildLlm(): LlmClient | undefined {
  const apiKey = process.env['LLM_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    log('生成层：未配置 LLM_API_KEY，生成式工具将不可用（确定性工具仍可工作）');
    return undefined;
  }
  const provider = process.env['LLM_PROVIDER'] ?? 'deepseek';
  const model = process.env['LLM_MODEL'];
  log(`生成层：OpenAiCompatibleClient（provider=${provider}）`);
  return new OpenAiCompatibleClient({
    provider,
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

  const instance = createServer({
    registry,
    decision,
    ...(llm !== undefined ? { llm } : {}),
    providers,
    defaultProvider,
    policy: DEFAULT_POLICY,
    sandboxRetention: { maxRuns: sandboxRetention },
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
