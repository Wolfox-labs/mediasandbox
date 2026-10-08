/**
 * 一次性验证脚本：在真 Docker + 真 chromium 上跑一次**模拟点击**。
 *
 * 不属于测试套件（要 Docker + 浏览器镜像）。跑完它会打印判定结论，
 * 并把"点击之后"的截图落到 `click-verify.png` 供人工查看。
 *
 * 用法：node probe-click.mjs
 */
import Docker from 'dockerode';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ChromiumClickDriver,
  DemoDecisionClient,
  createPageSpec,
  verifyInteraction,
} from '@mediasandbox/orchestrator';
import { DockerSandbox } from '@mediasandbox/sandbox';

const root = path.join(os.tmpdir(), `ms-click-${Date.now()}`);
const provider = new DockerSandbox({ docker: new Docker(), rootDir: root });
const handle = await provider.create(`click${Date.now()}`, 'webpage');

// 一个有交互的页面：两个标签页，默认选中第一个。
// 决策层要挑的就是"第二个标签页"——点了它才会看到选中态迁移。
const structure = {
  ...createPageSpec({
    projectId: 'click-probe',
    goal: '做一个中文产品介绍落地页，带可切换的标签页',
    candidateBlockIds: [],
  }),
  blocks: [
    {
      id: 'b1',
      type: 'tabs',
      status: 'filled',
      sources: { tabs: 'deterministic', panels: 'deterministic' },
      slots: {
        tabs: { kind: 'list', items: ['概览', '参数与价格'] },
        panels: { kind: 'list', items: ['概览正文：一句话说明这个产品是做什么的。', '参数正文：列出三条关键规格。'] },
      },
    },
  ],
};

const verification = await verifyInteraction({
  structure,
  decision: new DemoDecisionClient({ latencyMs: 0 }),
  driver: new ChromiumClickDriver({ docker: new Docker() }),
  sandbox: { provider, handle },
  pagePath: 'artifacts/index.html',
  goal: structure.goal,
});

console.log('候选数:', verification.targets.length);
console.log('候选:', verification.targets.map((t) => `${t.key}(${t.label})`).join(' '));
console.log('决策层选中:', verification.picked?.key, verification.picked?.label);
console.log('驱动:', verification.driver, '占位:', verification.placeholder);
console.log('点击前快照:', JSON.stringify(verification.result?.before ?? {}));
console.log('点击后快照:', JSON.stringify(verification.result?.after ?? {}));
console.log('判定:', verification.result?.changed === true ? '通过' : '未通过');
console.log('详情:', verification.detail);

const files = await provider.listFiles(handle, 'artifacts/*');
console.log('artifacts:', files.map((f) => `${f.path}(${f.size}B)`).join(' '));

try {
  const png = await provider.readFile(handle, 'artifacts/click.png');
  const out = path.join(process.cwd(), 'click-verify.png');
  await fs.writeFile(out, png);
  console.log('written:', out, png.byteLength, 'bytes');
} catch (error) {
  console.log('没有点击后截图:', error instanceof Error ? error.message : String(error));
}
console.log('workdir:', handle.workDir);
