/**
 * 一次性验证脚本：在真 Docker 上跑一次结构化链路，并让**真 chromium** 截图。
 *
 * 不属于测试套件：它需要 Docker + 浏览器镜像，跑完把 PNG 落盘供人工查看。
 * 用法：node probe-screenshot.mjs
 */
import Docker from 'dockerode';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_TOOLS,
  ChromiumScreenshotDriver,
  DemoDecisionClient,
  Orchestrator,
  ToolRegistry,
  createBlockRegistry,
  createStructuredTools,
} from '@mediasandbox/orchestrator';
import { DockerSandbox } from '@mediasandbox/sandbox';

const root = path.join(os.tmpdir(), `ms-shot-${Date.now()}`);
const provider = new DockerSandbox({ docker: new Docker(), rootDir: root });
const driver = new ChromiumScreenshotDriver({ docker: new Docker() });
const blocks = createBlockRegistry();
const registry = new ToolRegistry()
  .registerAll(BUILTIN_TOOLS)
  .registerAll(createStructuredTools(blocks, driver));

const result = await new Orchestrator().run(
  {
    projectId: `shot${Date.now()}`,
    goal: '做一个中文产品介绍落地页，包含首屏、特性与行动号召',
    envType: 'webpage',
    blocks,
    candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
    maxBlocks: 4,
    screenshot: true,
  },
  { registry, decision: new DemoDecisionClient({ latencyMs: 0 }), sandbox: provider },
);

console.log('status:', result.status, result.reason ?? '');
const shot = (result.execution?.outcomes ?? []).find((o) => o.toolId === 'screenshot-page');
console.log('screenshot node:', shot?.status, shot?.error ?? '', shot?.summary ?? '');

const files = await provider.listFiles(result.handle, 'artifacts/*');
console.log('artifacts:', files.map((f) => `${f.path}(${f.size}B)`).join(' '));

// 先看截图节点自己成没成：直接去读 PNG 会把 chromium 真正的报错盖成一个 ENOENT，
// 上一轮就是这么被误导的。
if (shot?.status !== 'succeeded') {
  console.error('截图节点没有成功，先看它的报错，而不是去读 PNG');
  await release(result.handle);
  process.exit(1);
}

const png = await provider.readFile(result.handle, 'artifacts/screenshot.png');
const out = path.join(process.cwd(), 'screenshot-verify.png');
await fs.writeFile(out, png);
console.log('written:', out, png.byteLength, 'bytes');
console.log('workdir:', result.handle.workDir);
await release(result.handle);

/**
 * 回收沙盒：不然每跑一次就永久多一个容器/工作区
 * （连跑几次之后 `docker ps` 里躺了 5 个就是这么来的）。
 *
 * 说明白：这条覆盖的是**正常跑完**与**截图节点失败**两条路径；
 * 脚本自己抛异常时仍可能漏一个（探针是一次性脚本，不为它再套一层）。
 * 想留着现场看就 `KEEP_SANDBOX=1 node probe-screenshot.mjs`。
 */
async function release(handle) {
  if (process.env.KEEP_SANDBOX === '1') {
    console.log('保留现场（KEEP_SANDBOX=1）：', handle.workDir);
    return;
  }
  try {
    await provider.destroy(handle);
    console.log('已回收沙盒');
  } catch (error) {
    console.log('回收沙盒失败：', error instanceof Error ? error.message : String(error));
  }
}
