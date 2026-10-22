/**
 * 海报工作流冒烟脚本：用真实生成层 + 真浏览器跑一遍四个尺寸。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/poster.mjs "校园二手市集"
 *
 * 它验证的是"工作流引擎 + 海报工具"这条链路本身，不经过服务端 API：
 * 沙盒、注册表、执行器、截图驱动都按服务启动时的方式装一遍。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { LocalSandbox } from '../packages/sandbox/dist/index.js';
import {
  ChromiumScreenshotDriver,
  createPosterTools,
  defaultScreenshotDriver,
  FileNodeCache,
  OpenAiCompatibleClient,
  posterWorkflow,
  runWorkflow,
  ToolRegistry,
} from '../packages/orchestrator/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const goal = process.argv[2] ?? '校园二手市集';

const baseUrl = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
if (baseUrl === undefined || apiKey === undefined) {
  console.error('缺 LLM_BASE_URL / LLM_API_KEY；用 --env-file-if-exists=.env 启动');
  process.exit(1);
}

const llm = new OpenAiCompatibleClient({
  baseUrl,
  apiKey,
  ...(process.env.LLM_MODEL !== undefined ? { defaultModel: process.env.LLM_MODEL } : {}),
  timeoutMs: 120_000,
});

// 与 server 一致：有 Docker 就用真浏览器，否则退回占位驱动。
// dockerode 装在 packages/server 下，脚本从那里解析，避免在根目录找包。
let docker;
try {
  const { createRequire } = await import('node:module');
  const requireFromServer = createRequire(path.join(root, 'packages', 'server', 'package.json'));
  const dockerode = requireFromServer('dockerode');
  docker = new (dockerode.default ?? dockerode)();
  await docker.ping();
  console.log('Docker 可用：截图走真浏览器');
} catch (error) {
  docker = undefined;
  console.log(`Docker 不可用（${error instanceof Error ? error.message : String(error)}），截图退回占位驱动`);
}

const provider = new LocalSandbox({ rootDir: path.join(root, '.tmp', 'poster-sandbox') });
const driver =
  docker === undefined ? defaultScreenshotDriver() : new ChromiumScreenshotDriver({ docker });

const registry = new ToolRegistry();
registry.registerAll(createPosterTools(driver));

const handle = await provider.create(`poster-${Date.now()}`, 'image');
const workflow = posterWorkflow({ goal });

const startedAt = Date.now();
const events = [];
const result = await runWorkflow(workflow, {
  registry,
  sandbox: provider,
  handle,
  llm,
  maxConcurrency: 4,
  allowPaid: false,
  onEvent: (event) => events.push(event),
  cache: new FileNodeCache({
    root: path.join(root, 'data', 'node-cache'),
    sandbox: provider,
    handle,
  }),
});

console.log(`\n目标：${goal}`);
console.log(`状态：${result.execution.status}，总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
for (const outcome of result.execution.outcomes) {
  console.log(
    `  ${outcome.status === 'succeeded' ? '✔' : '✖'} ${outcome.nodeId.padEnd(16)}` +
      `${(outcome.durationMs / 1000).toFixed(1).padStart(6)}s  ${outcome.result?.summary ?? outcome.error ?? ''}`,
  );
}
console.log('\n产物：');
for (const artifact of result.execution.artifacts) {
  console.log(`  ${artifact.path.padEnd(32)} ${Math.round(artifact.size / 1024)} KB`);
}
console.log(`\n沙盒目录：${path.join(root, '.tmp', 'poster-sandbox', handle.id, 'artifacts')}`);

if (result.execution.status !== 'succeeded') process.exitCode = 1;
