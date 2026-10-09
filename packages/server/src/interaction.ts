/**
 * 交互验证的 HTTP 入口（W2）。
 *
 * 能力本来就有——编排层的 `verifyInteraction()` 与两个探针脚本早就跑通了
 * "真浏览器点一下"。缺的是**界面能碰到它**：此前只能在命令行里跑，
 * 演示时价值被埋在脚本里。
 *
 * 这个模块把"跑一次验证"的判定逻辑单独放出来，便于直接测：
 * 三条验收路径（跑通、没有可点元素、驱动不可用）都不需要真的起浏览器。
 *
 * ## 为什么要点完把页面写回工作区
 *
 * `verifyInteraction` 是**从结构重新渲染 HTML** 再去点的，不是读旁边那份文件。
 * 这样解析锚点和真正被点击的必须是同一份字节——否则出现的是
 * "我们在验证另一个版本的页面"这种最难发现的错。代价是点击页会覆盖
 * `artifacts/index.html`；而它由同一份结构渲染而来，内容等价。
 */
import {
  verifyInteraction,
  type ClickDriver,
  type DecisionClient,
  type InteractionVerification,
} from '@mediasandbox/orchestrator';
import type { SandboxProvider } from '@mediasandbox/sandbox';
import type { RunRecord } from './run-store.js';

/** 页面在工作区里的相对路径，与截图/点击工具约定一致。 */
export const PAGE_PATH = 'artifacts/index.html';

export type InteractionOutcome =
  | { readonly ok: true; readonly verification: InteractionVerification }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly detail?: string };

export interface VerifyInteractionDeps {
  readonly record: RunRecord | undefined;
  readonly provider: SandboxProvider | undefined;
  readonly decision: DecisionClient;
  /** 省略即"这次部署没有点击驱动"——按不可用**如实**拒绝，不静默降级成通过。 */
  readonly driver?: ClickDriver | undefined;
}

export async function runInteractionVerification(
  deps: VerifyInteractionDeps,
): Promise<InteractionOutcome> {
  const { record } = deps;
  if (record === undefined) {
    return { ok: false, status: 404, error: '运行不存在' };
  }
  if (record.structure === undefined) {
    return {
      ok: false,
      status: 409,
      error: '这次运行没有结构化留痕',
      detail: '只有 webpage 环境的结构化链路才有页面可点',
    };
  }
  // 跑动中的运行不能验证：它可能正在重写页面，点出来的结论说明不了任何事。
  if (record.status === 'running' || record.status === 'queued') {
    return { ok: false, status: 409, error: '运行还在进行中，不能做交互验证', detail: '等它结束再点' };
  }
  if (record.status !== 'succeeded') {
    return {
      ok: false,
      status: 409,
      error: `这次运行的状态是 ${record.status}，没有可验证的页面`,
      detail: '只有成功的运行才有落定的页面',
    };
  }
  if (deps.driver === undefined) {
    // **不返回 200**：没有驱动就说"没验证"，而不是给一个看起来通过的空结论。
    return {
      ok: false,
      status: 503,
      error: '本机没有可用的点击驱动',
      detail: '点击验证需要 Docker（旁挂 chromium 容器）；当前部署未启用',
    };
  }
  if (deps.provider === undefined) {
    return { ok: false, status: 503, error: `未知的沙盒 provider: ${record.provider}` };
  }
  if (record.sandboxId === undefined) {
    return {
      ok: false,
      status: 410,
      error: '这次运行的沙盒已被回收',
      detail: '页面只在沙盒工作区里；沙盒被回收后无法再点它',
    };
  }
  const handle = await deps.provider.get(record.sandboxId);
  if (handle === undefined) {
    return {
      ok: false,
      status: 410,
      error: '找不到这次运行的沙盒',
      detail: `沙盒 ${record.sandboxId} 已不存在（可能被保留额度淘汰）`,
    };
  }

  const verification = await verifyInteraction({
    structure: record.structure.page,
    decision: deps.decision,
    driver: deps.driver,
    sandbox: { provider: deps.provider, handle },
    pagePath: PAGE_PATH,
    goal: record.goal,
  });
  return { ok: true, verification };
}
