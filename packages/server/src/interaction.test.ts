/**
 * 交互验证的 HTTP 入口（W2）。
 *
 * 三条验收路径都在这里锁住，且**都不需要真浏览器**：
 *   1. 点成了 → `passed: true`，带上点击后的截图路径；
 *   2. 页面上没有可点元素 → 如实说"未做点击验证"，**不能报成功**；
 *   3. 驱动不可用 → 503 并说明原因，**不能静默降级成通过**。
 *
 * 第三条是这组用例里最重要的：一个"没验证却报通过"的接口比没有这个接口更糟，
 * 因为它会让人以为验过了。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import path from 'node:path';
import { LocalSandbox } from '@mediasandbox/sandbox';
import type { SandboxProvider } from '@mediasandbox/sandbox';
import type { BlockInstance, ClickDriver, ClickRequest, ClickResult, PageSpec } from '@mediasandbox/orchestrator';
import { createPageSpec } from '@mediasandbox/orchestrator';
import { startServer } from './testing/harness.js';

function block(id: string, type: string, slots: BlockInstance['slots']): BlockInstance {
  const sources: Record<string, 'deterministic'> = {};
  for (const name of Object.keys(slots)) sources[name] = 'deterministic';
  return { id, type, slots, status: 'filled', sources };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return { ...createPageSpec({ projectId: 'proj', goal: '测试目标', candidateBlockIds: [] }), blocks };
}

/** 可点的页面：tabs 渲染出两个 `data-ms-tab` 锚点。 */
const TABS_PAGE = page([
  block('b1', 'tabs', {
    tabs: { kind: 'list', items: ['概览', '参数'] },
    panels: { kind: 'list', items: ['概览正文', '参数正文'] },
  }),
]);

/** 没有交互块的页面：没有任何 `data-ms-*` 锚点可点。 */
const PLAIN_PAGE = page([
  block('b1', 'hero', {
    title: { kind: 'text', text: '标题' },
    subtitle: { kind: 'text', text: '副标题' },
  }),
]);

class StubClickDriver implements ClickDriver {
  readonly name = 'stub-click';
  readonly placeholder = false;
  readonly requests: ClickRequest[] = [];

  async click(request: ClickRequest): Promise<ClickResult> {
    this.requests.push(request);
    return {
      target: request.target,
      before: { selectedTabs: ['b1:0'] },
      after: { selectedTabs: [request.target.key] },
      changed: true,
      detail: '点击后标签页变为选中',
      screenshot: { bytes: new Uint8Array([137, 80, 78, 71]), path: 'artifacts/click.png' },
      driver: this.name,
      placeholder: false,
    };
  }
}

describe('交互验证接口', () => {
  const started: Awaited<ReturnType<typeof startServer>>[] = [];

  after(async () => {
    for (const ctx of started) await ctx.close();
  });

  /** 起一个服务，并塞进一条"已成功的结构化运行"记录（含真实沙盒）。 */
  async function boot(options: {
    structure?: PageSpec;
    status?: string;
    sandboxId?: string;
    clickDriver?: ClickDriver;
    provider?: SandboxProvider;
  }) {
    // 根目录必须在**可写的工作区**里：本机沙箱只允许写工作区，系统 TEMP 会 EPERM。
    const rootDir = path.join(
      'D:\\github123\\_tmp',
      `mediasandbox-interaction-test-${process.pid}-${started.length}`,
    );
    const localSandbox = options.provider ?? new LocalSandbox({ rootDir });
    const ctx = await startServer({
      structured: true,
      providers: { local: localSandbox },
      ...(options.clickDriver !== undefined ? { clickDriver: options.clickDriver } : {}),
    });
    started.push(ctx);

    // 造一个真沙盒，让 provider.get(sandboxId) 找得到——端点会去拿页面。
    const handle = await localSandbox.create('proj', 'webpage');
    const record = ctx.store.create({
      id: `run-seeded-${started.length}`,
      projectId: 'proj',
      goal: '测试目标',
      envType: 'webpage',
      provider: 'local',
    });
    /** 已成功的结构化运行：状态必须显式设成终态，否则记录停在 `queued`，
     *  端点命中的会是"还在跑"那条判定，而不是用例想验的那一条。 */
    ctx.store.update(record.id, {
      status: (options.status ?? 'succeeded') as never,
      sandboxId: options.sandboxId ?? handle.id,
      finishedAt: Date.now(),
      ...(options.structure !== undefined
        ? { structure: { page: options.structure, steps: [] } }
        : {}),
    });
    return { ctx, runId: record.id, handle };
  }

  it('点成了：返回 passed，并带上点击后的截图路径', async () => {
    const driver = new StubClickDriver();
    const { ctx, runId } = await boot({ structure: TABS_PAGE, clickDriver: driver });

    const response = await fetch(`${ctx.origin}/api/runs/${runId}/verify-interaction`, {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['passed'], true);
    assert.equal(body['placeholder'], false);
    assert.equal(body['driver'], 'stub-click');
    assert.equal(body['screenshotPath'], 'artifacts/click.png');
    assert.ok((body['targetCount'] as number) >= 2, '应当发现两个标签页锚点');
    assert.equal(driver.requests.length >= 1, true, '驱动应当被真的调用过');
  });

  it('页面上没有可点元素时如实说明"未做点击验证"，不报成功', async () => {
    const { ctx, runId } = await boot({ structure: PLAIN_PAGE, clickDriver: new StubClickDriver() });
    const response = await fetch(`${ctx.origin}/api/runs/${runId}/verify-interaction`, {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['passed'], false, '没点成不能报成功');
    assert.equal(body['targetCount'], 0);
    assert.match(String(body['detail']), /没有可点元素|未做点击验证/);
  });

  it('驱动不可用时回 503 并说明原因，不静默降级成通过', async () => {
    const { ctx, runId } = await boot({ structure: TABS_PAGE });
    const response = await fetch(`${ctx.origin}/api/runs/${runId}/verify-interaction`, {
      method: 'POST',
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error?: string; detail?: string };
    assert.match(String(body.error), /没有可用的点击驱动/);
    assert.match(String(body.detail), /Docker/);
  });

  it('运行不存在回 404；没有结构回 409；还在跑回 409', async () => {
    const { ctx, runId } = await boot({ structure: TABS_PAGE, clickDriver: new StubClickDriver() });

    const missing = await fetch(`${ctx.origin}/api/runs/run-不存在/verify-interaction`, {
      method: 'POST',
    });
    assert.equal(missing.status, 404);

    const noStructure = await boot({
      status: 'succeeded',
      clickDriver: new StubClickDriver(),
    });
    // 注意：`boot()` 每次起的是**另一台服务**，所以要用它自己的 origin 去查，
    // 拿原来那台的地址查会得到 404（用例本身写错，不是端点的问题）。
    const conflict = await fetch(
      `${noStructure.ctx.origin}/api/runs/${noStructure.runId}/verify-interaction`,
      { method: 'POST' },
    );
    assert.equal(conflict.status, 409);
    assert.match(String(((await conflict.json()) as { error?: string }).error), /没有结构化留痕/);

    const running = await boot({
      structure: TABS_PAGE,
      status: 'running',
      clickDriver: new StubClickDriver(),
    });
    const busy = await fetch(
      `${running.ctx.origin}/api/runs/${running.runId}/verify-interaction`,
      { method: 'POST' },
    );
    assert.equal(busy.status, 409);
    assert.match(String(((await busy.json()) as { error?: string }).error), /还在进行中/);

    // 已失败（escalated）的运行也没有可验证的页面。
    const escalated = await boot({
      structure: TABS_PAGE,
      status: 'escalated',
      clickDriver: new StubClickDriver(),
    });
    const failed = await fetch(
      `${escalated.ctx.origin}/api/runs/${escalated.runId}/verify-interaction`,
      { method: 'POST' },
    );
    assert.equal(failed.status, 409);
    assert.match(String(((await failed.json()) as { error?: string }).error), /escalated/);

    void runId;
  });

  it('沙盒已被回收时回 410，而不是报一个空结论', async () => {
    const { ctx, runId } = await boot({
      structure: TABS_PAGE,
      sandboxId: 'sandbox-已经没了',
      clickDriver: new StubClickDriver(),
    });
    const response = await fetch(`${ctx.origin}/api/runs/${runId}/verify-interaction`, {
      method: 'POST',
    });
    assert.equal(response.status, 410);
    assert.match(String(((await response.json()) as { error?: string }).error), /找不到这次运行的沙盒/);
  });
});
