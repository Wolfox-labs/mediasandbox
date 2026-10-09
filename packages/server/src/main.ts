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
  ChromiumScreenshotDriver,
  createStructuredTools,
  createTemplateRegistry,
  DEFAULT_POLICY,
  defaultScreenshotDriver,
  DemoDecisionClient,
  RizzoFlowClient,
  SplitLlmClient,
  StubDecisionClient,
  ToolRegistry,
  OpenAiCompatibleClient,
  type BrowserDocker,
  type DecisionClient,
  type LlmClient,
} from '@mediasandbox/orchestrator';
import {
  BROWSER_IMAGE,
  DockerSandbox,
  LocalSandbox,
  type DockerApi,
  type SandboxProvider,
} from '@mediasandbox/sandbox';
import { createServer } from './app.js';
import { JsonPersist } from './persist.js';
import { loadPersistedPools, type LoadedPools } from './boot.js';
import { probeBrowserDocker } from './docker-probe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '../../..', 'workspaces');
/** 前端构建产物目录。构建过就由本服务托管，使访问地址只有一个。 */
const WEB_DIST = path.resolve(HERE, '../../web/dist');
/**
 * 落盘数据目录。
 *
 * 放在仓库根而不是 `dist/` 旁边：它是**数据**，`pnpm build` 不该动它。
 * 已在 `.gitignore` 里排除。
 */
const DATA_ROOT = path.resolve(HERE, '../../..', 'data');
/**
 * 交付物落定目录。
 *
 * 与 `workspaces/` 分开是**有意的**：工作区是临时空间（按保留额度回收），
 * 交付物是成果（长期留着）。此前两者是同一个目录，于是"防止工作区无限增长"
 * 的代价变成了"把交付物删掉"——对一个产出交付物的系统来说，这个取舍是反的。
 */
const PROJECTS_ROOT = path.resolve(HERE, '../../..', 'projects');

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
 * 读一个**正整数**环境变量。缺失或非法时用默认值。
 *
 * 与上一个分开是因为 0 在这里没有意义：并发为 0 等于"永远不跑"，
 * 而调用方写 0 时想的多半是"不限"——那种情况正确答案是夹到 1 并说出来，
 * 不是安静地让服务再也不跑任何东西。
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = parseNonNegativeInt(raw, fallback);
  if (value === 0) {
    log(`并发上限不能为 0（等于永远不跑），按 1 处理`);
    return 1;
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
 * 三种接法：
 *   - 预置厂商：`LLM_PROVIDER=deepseek`（见 PROVIDERS 表）
 *   - 任意 OpenAI 兼容端点：`LLM_BASE_URL=https://.../v1`（优先于 provider）
 *   - **文本与图像分开**：再配 `LLM_IMAGE_BASE_URL` + `LLM_IMAGE_API_KEY`
 *
 * 第三种是实际部署里常见的情况 —— 文本模型与图像模型来自不同服务商，
 * 域名与密钥都不同。这时用 `SplitLlmClient` 组合两个客户端，
 * 而不是把两套凭据硬塞进一个客户端里。
 */
function buildLlm(): LlmClient | undefined {
  const apiKey = process.env['LLM_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    log('生成层：未配置 LLM_API_KEY，生成式工具将不可用（确定性工具仍可工作）');
    return undefined;
  }
  const baseUrl = process.env['LLM_BASE_URL'];
  const model = process.env['LLM_MODEL'];

  // 文本客户端。
  const textTarget =
    baseUrl !== undefined && baseUrl !== ''
      ? `自定义端点 ${baseUrl}`
      : `provider=${process.env['LLM_PROVIDER'] ?? 'deepseek'}`;
  log(`生成层[文本]：${textTarget}${model !== undefined ? `，模型 ${model}` : ''}`);
  const text = new OpenAiCompatibleClient({
    ...(baseUrl !== undefined && baseUrl !== ''
      ? { baseUrl }
      : { provider: process.env['LLM_PROVIDER'] ?? 'deepseek' }),
    apiKey,
    ...(model !== undefined ? { defaultModel: model } : {}),
  });

  // 图像客户端：独立端点 + 独立密钥（都可选）。
  const imageBaseUrl = process.env['LLM_IMAGE_BASE_URL'];
  const imageApiKey = process.env['LLM_IMAGE_API_KEY'] ?? apiKey;
  const imageModel = process.env['LLM_IMAGE_MODEL'];

  if (imageModel === undefined || imageModel === '') {
    log('生成层[图像]：未配 LLM_IMAGE_MODEL，render-image 将回落到文本补全');
    return text;
  }

  // 图像端点没单独给就复用文本端点（同一服务商同时提供两种模型的情况）。
  const imageTarget =
    imageBaseUrl !== undefined && imageBaseUrl !== '' ? imageBaseUrl : (baseUrl ?? '(同文本端点)');
  log(`生成层[图像]：${imageTarget}，模型 ${imageModel}`);

  const image = new OpenAiCompatibleClient({
    ...(imageBaseUrl !== undefined && imageBaseUrl !== ''
      ? { baseUrl: imageBaseUrl }
      : baseUrl !== undefined && baseUrl !== ''
        ? { baseUrl }
        : { provider: process.env['LLM_PROVIDER'] ?? 'deepseek' }),
    apiKey: imageApiKey,
    ...(model !== undefined ? { defaultModel: model } : {}),
    imageModel,
  });

  // 端点与密钥都相同就不必套路由器 —— 直接用一个客户端更省一层。
  const sameEndpoint =
    (imageBaseUrl === undefined || imageBaseUrl === '' || imageBaseUrl === baseUrl) &&
    imageApiKey === apiKey;
  if (sameEndpoint) return image;

  return new SplitLlmClient({ text, image });
}

async function buildProviders(): Promise<{
  providers: Record<string, SandboxProvider>;
  defaultProvider: string;
  /** Docker 的浏览器能力**已确认可用**时把它交出来；否则 undefined，截图退回占位驱动。 */
  docker: BrowserDocker | undefined;
}> {
  const local = new LocalSandbox({ rootDir: path.join(WORKSPACE_ROOT, 'local') });
  const providers: Record<string, SandboxProvider> = { local };
  let docker: BrowserDocker | undefined;

  // Docker 是可选能力：装不上也要能起来（只有 local 可用）。
  // **光 import 成功不算"有 Docker"**：dockerode 的客户端对象是惰性的，一次往返都不发，
  // 所以这里再探一次 daemon 与截图镜像。探不通就当没有，让截图退回占位驱动——
  // 而不是等到运行到截图那一步才失败（那会把整次运行判成 escalated）。
  try {
    const dockerode = await import('dockerode');
    const api = new dockerode.default() as unknown as DockerApi;
    providers['docker'] = new DockerSandbox({
      docker: api,
      rootDir: path.join(WORKSPACE_ROOT, 'docker'),
      autoPull: false,
    });
    const probe = await probeBrowserDocker(api, BROWSER_IMAGE);
    if (probe.ok) {
      docker = api as unknown as BrowserDocker;
      log(`已启用 docker provider（浏览器截图可用：${probe.detail}）`);
    } else {
      log(`docker provider 已装载但浏览器能力不可用：${probe.reason}`);
      log('  截图改用占位驱动；产物里会标明是占位图');
    }
  } catch (error) {
    log(`docker provider 不可用，仅用 local：${String(error)}`);
  }

  const requested = process.env['SANDBOX_PROVIDER'] ?? 'local';
  const defaultProvider = providers[requested] !== undefined ? requested : 'local';
  return { providers, defaultProvider, docker };
}

/**
 * 装回用户新增的 block 与模板。
 *
 * 逻辑在 `boot.ts`：那里能同时被服务启动与测试复用，
 * 避免"测试里模拟的装入逻辑和 main.ts 里的不是同一条"。
 */
async function loadPools(persist: JsonPersist): Promise<LoadedPools> {
  return await loadPersistedPools(persist, (message) => log(`  ⚠ ${message}`));
}

async function main(): Promise<void> {
  // ── 落盘存储 ────────────────────────────────────────────────────────
  //
  // `RunStore` 曾经是内存 Map，重启即丢；block 池与模板池也是进程内构造的。
  // 于是"越用越好用"（从跑过的项目沉淀模板）没有立足点 —— 沉淀出来的东西
  // 下次启动就不在了。这里把它落到 JSON：零依赖、纯文本、可直接打开给人看。
  const dataDir = process.env['MEDIASANDBOX_DATA'] ?? DATA_ROOT;
  const persist = new JsonPersist({
    rootDir: dataDir,
    onError: (message, error) => {
      log(`  ⚠ ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  // 外部来源的 block 与模板**先装载、再建池子**：池子在注册期就校验类型，
  // 装晚了就只剩"跳过校验"这一条路，而没校验过的 block 进池子正是要防的事。
  const { blocks, externalBlocks, userTemplates } = await loadPools(persist);

  const { providers, defaultProvider, docker } = await buildProviders();

  // 截图驱动：有 Docker 就用**真浏览器**（旁挂 chromium 容器渲染沙盒里的页面），
  // 没有就退回确定性占位驱动。这不是"看运气"，而是按部署能力选实现——
  // 能不能截图取决于这台机器有没有 Docker，而这件事在启动时就知道。
  const screenshotDriver =
    docker === undefined
      ? defaultScreenshotDriver()
      : new ChromiumScreenshotDriver({ docker });

  // 工具注册表：通用工具 + 结构化制作工具。结构化那几条只在 webpage 环境可见
  // （它们声明了 `envTypes: ['webpage']`），所以放进同一个注册表不会污染其它链路。
  //
  // 工具必须装在这一个池子上，否则自定义 block 会重现
  // "规划器选得到、执行期说未注册"的断链。
  const registry = new ToolRegistry()
    .registerAll(BUILTIN_TOOLS)
    .registerAll(createStructuredTools(blocks, screenshotDriver));
  const templates = createTemplateRegistry(blocks, [...userTemplates]);
  const decision = buildDecision();
  const llm = buildLlm();

  // 产物是从沙盒工作区实时读的，所以结束后要留一段时间才能下载。
  // 但必须设上限，否则每跑一次就永久多一个工作区（Local 目录 / Docker 容器）。
  const sandboxRetention = parseNonNegativeInt(process.env['SANDBOX_RETENTION'], 20);
  // 并发与排队。默认 **2 并发 / 16 队列**：保守值，因为每个运行都会起一个沙盒
  // （Docker 下是一个容器）。队列满时回 429 而不是继续收——收进来的尽头是 OOM。
  // 排队中的运行不会在重启后复活（队列只在内存里，`persist.ts` 会把它们标成已取消）。
  const maxConcurrentRuns = parsePositiveInt(process.env['MAX_CONCURRENT_RUNS'], 2);
  const queueLimit = parseNonNegativeInt(process.env['RUN_QUEUE_LIMIT'], 16);
  // 落定产物（`projects/`）**默认不删**：它是沙盒回收之后交付物的唯一副本，
  // 默认删掉不叫清理，叫丢东西。要控盘就显式设 PROJECTS_RETENTION。
  const projectsRetention = parseNonNegativeInt(process.env['PROJECTS_RETENTION'], 0);

  // 前端构建产物存在就一并托管，让"可运行版本"是一个地址。
  const webDistExists = await stat(WEB_DIST)
    .then((s) => s.isDirectory())
    .catch(() => false);

  const instance = createServer({
    registry,
    blocks,
    templates,
    persist,
    projectsDir: PROJECTS_ROOT,
    onLog: (message) => log(`  ${message}`),
    decision,
    ...(llm !== undefined ? { llm } : {}),
    providers,
    defaultProvider,
    policy: DEFAULT_POLICY,
    sandboxRetention: { maxRuns: sandboxRetention },
    projectsRetention: { maxRunsPerProject: projectsRetention },
    concurrency: { maxConcurrentRuns, queueLimit },
    ...(webDistExists ? { staticDir: WEB_DIST } : {}),
  });

  const server = http.createServer(instance.app);
  instance.attachWebSocket(server);

  // **在 listen 之前**把历史运行记录装回来：否则第一批请求会看到一个空的运行列表，
  // 而它几毫秒后就不是空的了 —— 这种"时有时无"最难排查。
  const restoredRuns = await instance.loadPersisted();

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
  log(`  交付物    ${PROJECTS_ROOT}（运行结束后落定一份，不随沙盒回收消失）`);
  log(`  block 池  ${blocks.size} 类，分 ${blocks.groups().length} 组（结构化制作链路，webpage 环境）`);
  log(
    `  截图      ${
      screenshotDriver.placeholder
        ? `占位驱动（未检测到 Docker，真浏览器截图不可用）`
        : `chromium（旁挂容器渲染沙盒里的页面，镜像 ${BROWSER_IMAGE}）`
    }`,
  );
  log(`  模板池    ${templates.size} 套（${templates.specs().map((t) => t.id).join(', ')}）`);
  log(
    `  持久化    ${dataDir}（装载 ${restoredRuns} 条运行记录` +
      `、${externalBlocks.length} 个自定义 block、${userTemplates.length} 套模板）`,
  );
  log(`  保留      ${sandboxRetention} 个已结束运行的沙盒（SANDBOX_RETENTION 可调，0 = 不保留）`);
  log(
    `  并发      ${maxConcurrentRuns} 个同时跑，超出排 ${queueLimit} 个（MAX_CONCURRENT_RUNS / RUN_QUEUE_LIMIT 可调），` +
      `队满回 429；重启不恢复排队`,
  );
  log(
    `  落定保留  ${
      projectsRetention === 0
        ? '不清理（交付物一个都不删，PROJECTS_RETENTION 可调）'
        : `每个项目保留最近 ${projectsRetention} 次（PROJECTS_RETENTION 可调）`
    }`,
  );
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
