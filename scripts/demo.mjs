/**
 * 一键演示：起服务 → 跑冒烟 → 打印"该看到什么"与可点地址。
 *
 * ## 它解决什么
 *
 * 现有能力已经能演示（结构化链路、真截图、交互验证），但**动线是散的**：
 * 要人记住"先 `pnpm start`、另开终端跑 `probe-server-demo.mjs`、演示时看哪几个地方"。
 * 这份脚本把那三步收成一条命令，并把"该看到什么"直接写进输出——
 * 演示的人不必先读一遍文档。
 *
 * ## 用法
 *
 *   node scripts/demo.mjs              # 起服务、跑冒烟、打印导览，然后停掉服务
 *   node scripts/demo.mjs --keep       # 跑完不停服务，留在前台（Ctrl-C 结束）
 *   node scripts/demo.mjs --port 8899  # 换端口（默认 8787）
 *
 * 退出码 0 = 冒烟全绿。任何一步不对就非 0 退出，并把实际拿到的东西打出来。
 *
 * ## 它**不**假装做到的事
 *
 * 真截图与真点击需要旁挂 chromium 容器（Docker + 镜像）。本机没有 Docker 时
 * 这两项会如实报告为不可用，脚本照常退出 0——因为**能力缺失不是链路坏了**。
 * 想看真浏览器那两站，先 `scripts/build-images.ps1` 起镜像再跑本脚本。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const PORT = Number(option('--port', process.env.PORT ?? '8787'));
const HOST = option('--host', process.env.HOST ?? '127.0.0.1');
const ORIGIN = `http://${HOST}:${PORT}`;
const KEEP = flag('--keep');

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** 起服务。环境变量与 `pnpm start` 一致，另外带上本机的 llama.cpp 运行时（如有）。 */
function startServer() {
  const env = { ...process.env, PORT: String(PORT), HOST, SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER ?? 'local' };

  // 本机把 llama.cpp 的 b11081 运行时放在工作区里（不是 `rizzo download` 的默认位置）。
  // 截图与交互验证都要用它；没有就照常起，只是那两项能力不可用。
  const build = process.env.RIZZO_LLAMA_DIR ?? path.join(ROOT, '.research', 'llama-b11081-cuda', 'build');
  if (existsSync(build)) env.RIZZO_LLAMA_DIR = build;
  // CUDA 运行库（cuBLAS / cudart）通常随项目 venv 的 torch 一起装好。
  const torchLib = path.join(ROOT, '.venv-train', 'Lib', 'site-packages', 'torch', 'lib');
  if (existsSync(torchLib) && !(env.PATH ?? '').includes(torchLib)) {
    env.PATH = `${build};${torchLib};${env.PATH ?? ''}`;
  }

  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'packages/server/dist/main.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 把服务日志原样转出来：启动日志本身就是第一份验收单。
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`服务在 ${timeoutMs / 1000}s 内没有就绪：${ORIGIN}/api/health`);
}

function runProbe() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['packages/server/probe-server-demo.mjs'], {
      cwd: ROOT,
      env: { ...process.env, DEMO_ORIGIN: ORIGIN },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * 第三站：双 provider 产物对比。
 *
 * **只在 Docker 真的可用时跑**——它是 W4 动线里的"现场对比"，而不是链路的一部分；
 * 没有 Docker 时硬跑只会得到一句难读的连接错误，那对演示毫无帮助。
 */
function compareProviders() {
  return new Promise((resolve) => {
    const script = path.join(ROOT, 'scripts', 'compare-structured-providers.ps1');
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const child = spawn(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { cwd: ROOT, stdio: 'inherit' },
    );
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 服务把真实能力写在 `/api/health` 的 `browser` 字段里，脚本据它决定怎么说。 */
async function browserCapability(origin) {
  try {
    const response = await fetch(`${origin}/api/health`);
    const health = await response.json();
    return health.browser ?? { screenshot: 'placeholder', interaction: 'unavailable' };
  } catch {
    return { screenshot: 'placeholder', interaction: 'unavailable' };
  }
}

const server = startServer();
let exitCode = 0;
try {
  log(`\n=== 1/4 起服务 ===`);
  const health = await waitForHealth();
  log(`服务就绪：${ORIGIN}`);

  log(`\n=== 2/4 冒烟（真 HTTP，不是直接调库） ===`);
  const probeCode = await runProbe();
  if (probeCode !== 0) {
    log(`\n✗ 冒烟未通过（退出码 ${probeCode}）。上面的输出就是实际拿到的东西。`);
    exitCode = probeCode;
  } else {
    log(`\n✓ 冒烟通过`);
  }

  const browser = await browserCapability(ORIGIN);

  log(`\n=== 3/4 双 provider 现场对比 ===`);
  if (browser.screenshot === 'chromium') {
    const compareCode = await compareProviders();
    if (compareCode !== 0) {
      log(`✗ 双 provider 对比未通过（退出码 ${compareCode}）`);
      exitCode = compareCode;
    } else {
      log(`✓ 两个 provider 的产物逐字节一致（去掉 run id 后）`);
    }
  } else {
    log(`· 跳过：本机没有可用的 Docker 浏览器能力（截图=${browser.screenshot}）。`);
    log(`  要看这一站：先 scripts/build-images.ps1 构建镜像、确认 Docker Desktop 已启动，再跑本脚本。`);
  }

  log(`\n=== 4/4 演示导览：该看到什么 ===`);
  log(`服务地址        ${ORIGIN}/`);
  log(`创作工作台      ${ORIGIN}/            （左栏提交目标，中栏看决策与步骤，右栏看产物预览）`);
  log(`结构化演示      envType 选 webpage，勾几个 block，提交后右栏出页面`);
  log(`截图            勾上"截图"再提交 → 产物里出现 artifacts/screenshot.png`);
  log(
    `交互验证        运行成功后中栏出现「交互验证」面板 → 点一下按钮，看判定与点击后截图` +
      (browser.interaction === 'chromium' ? '' : '（本机没有 Docker，这一项会如实回 503）'),
  );
  log(`项目与产物      运行结束后产物落定一份到 projects/，沙盒回收也不影响下载`);
  log(
    `并发与排队      同时最多 ${process.env.MAX_CONCURRENT_RUNS ?? 2} 个在跑；超出的排队并显示位次，` +
      `队满回 429`,
  );
  log(`截图能力        ${browser.screenshot === 'chromium' ? '真 chromium' : '占位驱动（产物里标明是占位图）'}`);

  if (health.llm?.ok === false || String(health.llm?.detail ?? '').includes('未配置')) {
    log(`\n提示：生成层未配置（LLM_API_KEY），所以走的是**确定性路线**——`);
    log(`      这是设计里的降级，不是故障；演示不需要任何外部模型或付费调用。`);
  } else {
    log(`\n提示：生成层已配置。要演示零成本路线，把 .env 里的 LLM_API_KEY 清空再起。`);
  }

  log(`\n完整演示脚本与"该看到什么"的逐站说明见 docs/演示脚本.md。`);
} catch (error) {
  log(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  if (!KEEP) {
    server.kill();
    // 等它真的退出，避免"脚本结束了但端口还占着"。
    await new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    log(`\n服务已停止（--keep 可以让它留在前台）。`);
  } else {
    log(`\n服务留在前台：${ORIGIN}/　（Ctrl-C 结束）`);
  }
}

process.exit(exitCode);
