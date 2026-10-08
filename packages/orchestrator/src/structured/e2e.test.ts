/**
 * 结构化链路的端到端测试：**从目标到可打开的页面，零成本**。
 *
 * ## 这个测试要证明什么
 *
 * 它跑的是完整链路，一处都不跳过：
 *
 * ```
 * 目标文本
 *   → 决策层逐块决定结构（choice / noul / numeric / score）
 *   → 组装成扇入 DAG（N 个 fill-block 并发 + 1 个 assemble-page）
 *   → 执行器在真实沙盒里跑
 *   → artifacts/index.html
 * ```
 *
 * 并且断言三条与设计稿直接对应的性质：
 *
 *   1. **结构是数据**：计划里每块一个节点，不是一个巨大的单点
 *   2. **零成本**：全程没有生成层调用（确定性填充）
 *   3. **产物是真的**：`index.html` 能被解析、含结构里的每个块、含交互元素
 *
 * 用 `LocalSandbox`：它不需要 Docker，测试能在任何机器上跑。
 *
 * ## 一个容易踩的坑
 *
 * **沙盒句柄要用 `result.handle`，不能自己先 `create()` 一个。**
 * `Orchestrator.run` 内部会自己 `create()`，得到的是一个**新的**
 * 工作区目录（id 里带随机后缀）。测试若拿自己那个句柄去读文件，
 * 会读到另一个空目录，报"文件不存在"——而实际产物好端端躺在另一个目录里。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { LocalSandbox, readText } from '@mediasandbox/sandbox';
import { ToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtin.js';
import { createStructuredTools } from './tools.js';
import { createBlockRegistry, type BlockRegistry, type BlockSpec } from './block-spec.js';
import type { PageSpec } from './page-spec.js';
import { extractTemplate, type TemplateSpec } from './template-spec.js';
import { Orchestrator, type RunResult } from '../orchestrator.js';
import { DemoDecisionClient } from '../decision/demo-client.js';
import type { DecisionClient } from '../decision/types.js';
import { planLayers } from '../plan/types.js';

let root = '';
let sandbox: LocalSandbox;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ms-structured-'));
  sandbox = new LocalSandbox({ rootDir: root });
});

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

function registry(pool: BlockRegistry = createBlockRegistry()): ToolRegistry {
  // 工具装在**同一个池子**上：这是"自定义 block 全链路可用"的前提。
  return new ToolRegistry()
    .registerAll(BUILTIN_TOOLS)
    .registerAll(createStructuredTools(pool));
}

/**
 * 演示决策层（关键词判断）。
 *
 * 它不是真模型，但它**真的在按问题逐块作答**，所以链路形状与真实模型一致。
 * 用它跑端到端，可以不部署 rizzo-flow 就验完整条链路，而且零成本。
 */
function decision(): DecisionClient {
  return new DemoDecisionClient({ latencyMs: 0 });
}

/** 跑一次结构化链路，并保证沙盒被回收。 */
async function runStructured(args: {
  readonly projectId: string;
  readonly goal: string;
  readonly candidateBlockIds?: readonly string[];
  readonly maxBlocks?: number;
  readonly annotate?: boolean;
  /** 注入自定义 block 池；省略即内置池。 */
  readonly blocks?: BlockRegistry;
  /** 套用的模板。 */
  readonly template?: TemplateSpec;
  /**
   * 把定稿的结构接出来。
   *
   * 结构**不在 `RunResult` 上**，它是随 `plan_assembled` 事件带出来的
   * （见下面那条"结构留痕被带到调用方"的用例）。要断言结构的用例传个空对象进来即可。
   */
  readonly capture?: { page?: PageSpec | undefined };
}): Promise<RunResult> {
  const pool = args.blocks ?? createBlockRegistry();
  return await new Orchestrator().run(
    {
      projectId: args.projectId,
      goal: args.goal,
      envType: 'webpage',
      blocks: pool,
      ...(args.template !== undefined ? { template: args.template } : {}),
      ...(args.candidateBlockIds !== undefined
        ? { candidateBlockIds: args.candidateBlockIds }
        : {}),
      ...(args.maxBlocks !== undefined ? { maxBlocks: args.maxBlocks } : {}),
      ...(args.annotate !== undefined ? { annotate: args.annotate } : {}),
    },
    {
      registry: registry(pool),
      decision: decision(),
      sandbox,
      onEvent: (e) => {
        if (e.type === 'plan_assembled' && e.structure !== undefined && args.capture !== undefined) {
          args.capture.page = e.structure.page;
        }
      },
    },
  );
}

/** 读产物。用 `result.handle` —— 见文件头那个坑的说明。 */
async function readIndexHtml(result: RunResult): Promise<string> {
  return await readText(sandbox, result.handle, 'artifacts/index.html');
}

describe('结构化链路：端到端（Local 沙盒，零成本）', () => {
  it('从目标跑到可打开的 index.html', async () => {
    const result = await runStructured({
      projectId: 'e2e-structured',
      goal: '做一个产品介绍落地页，包含首屏、特性与行动号召',
      candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
      maxBlocks: 4,
    });

    assert.equal(result.status, 'succeeded', result.reason ?? '');
    assert.ok(result.plan !== undefined);

    // ── 1. 结构是数据：计划里每块一个节点，不是一个巨大的单点 ──────────
    const fillNodes = result.plan.nodes.filter((n) => n.toolId === 'fill-block');
    assert.ok(fillNodes.length >= 2, `只有 ${fillNodes.length} 个填充节点，结构没被拆开`);
    const assemble = result.plan.nodes.find((n) => n.toolId === 'assemble-page');
    assert.ok(assemble !== undefined, '缺少组装节点');
    // 填充节点之间无依赖 → 同层并发。
    assert.ok(
      fillNodes.every((n) => n.dependsOn.length === 0),
      '填充节点之间存在依赖，无法并发——每块就不再独立',
    );
    // 组装节点依赖全部填充节点。
    assert.equal(assemble.dependsOn.length, fillNodes.length);
    const layers = planLayers(result.plan);
    assert.equal(layers.length, 3, `预期三层（填充 / 组装 / 校验），实际 ${layers.length}`);

    // ── 2. 零成本 + 全绿 ───────────────────────────────────────────────
    for (const outcome of result.execution?.outcomes ?? []) {
      assert.notEqual(outcome.status, 'failed', `${outcome.toolId}: ${outcome.error ?? ''}`);
    }

    // ── 3. 产物是真的 ──────────────────────────────────────────────────
    const html = await readIndexHtml(result);
    assert.ok(html.includes('<!DOCTYPE html>'), '产物不是完整 HTML 文档');
    assert.ok(html.length > 1000, `产物只有 ${html.length} 字符，太单薄`);
    assert.match(html, /data-ms-block="b1"/, '缺少块定位锚点');
    assert.ok(html.includes('产品介绍落地页'), '页面里没有目标文本');

    await sandbox.destroy(result.handle);
  });

  it('结构里的每一个块都出现在产物 HTML 里，且顺序一致', async () => {
    const result = await runStructured({
      projectId: 'e2e-order',
      goal: '做作品展示页',
      candidateBlockIds: ['nav', 'hero', 'gallery', 'cta'],
      maxBlocks: 4,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');

    const html = await readIndexHtml(result);
    const anchors = [...html.matchAll(/data-ms-block="(b\d+)"/g)].map((m) => m[1]!);
    assert.ok(anchors.length >= 2, `产物里只找到 ${anchors.length} 个块锚点`);
    // 锚点顺序必须与 id 顺序一致（b1, b2, b3…），也就是页面顺序 = 结构顺序。
    assert.deepEqual(
      anchors,
      [...anchors].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );

    const assembleOutcome = result.execution?.outcomes.find((o) => o.toolId === 'assemble-page');
    const blockCount = assembleOutcome?.result?.outputs['blockCount'];
    assert.equal(anchors.length, blockCount, '产物里的块数与组装节点报的对不上');

    await sandbox.destroy(result.handle);
  });

  it('结构里的块类型覆盖了候选集，不是反复挑同一个', async () => {
    const result = await runStructured({
      projectId: 'e2e-variety',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'features', 'gallery', 'cta'],
      maxBlocks: 4,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const html = await readIndexHtml(result);
    const types = [...html.matchAll(/data-ms-type="([a-z-]+)"/g)].map((m) => m[1]!);
    assert.ok(
      new Set(types).size >= 3,
      `只用了 ${new Set(types).size} 种块：${types.join(',')}——逐块决策退化了`,
    );
    await sandbox.destroy(result.handle);
  });

  it('交互块产出真实可点击元素——后续要拿它做模拟点击验证', async () => {
    const result = await runStructured({
      projectId: 'e2e-interactive',
      goal: '做含标签页与问答的说明页',
      candidateBlockIds: ['hero', 'tabs', 'accordion', 'cta'],
      maxBlocks: 4,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');

    const html = await readIndexHtml(result);
    const types = [...html.matchAll(/data-ms-type="([a-z-]+)"/g)].map((m) => m[1]!);
    const hasTabs = types.includes('tabs');
    const hasAccordion = types.includes('accordion');
    assert.ok(hasTabs || hasAccordion, `没有渲染出任何交互块，实际：${types.join(',')}`);

    if (hasTabs) {
      assert.ok(html.includes('data-ms-tabs'), '缺少标签页容器锚点');
      // 标签必须是 <button>，否则没法被"点击"。
      assert.ok(html.includes('data-ms-tab='), '标签缺少定位属性');
      assert.ok(/data-ms-tab=[^>]*>/.test(html), '标签结构不完整');
      assert.ok(html.includes('role="tablist"'), '标签页缺少 tablist 语义');
      assert.ok(html.includes('aria-selected'), '标签缺少选中状态，无法判定切换是否生效');
      assert.ok(html.includes('data-ms-panel='), '面板缺少定位属性，无法判定切换结果');
      // 切换需要脚本（原生没有 tab 元素），且不能依赖外部库。
      assert.ok(html.includes('<script>'), '标签页切换缺少脚本');
      assert.ok(!/<script[^>]+src=/.test(html), '引入了外部脚本——沙盒 network=none 时必然失败');
    }
    if (hasAccordion) {
      // 用原生 <details>/<summary>：最省事、不依赖脚本、天然可点击。
      assert.ok(html.includes('<details'), '折叠面板没有用原生 details');
      assert.ok(html.includes('<summary'), '折叠面板缺少 summary');
    }

    await sandbox.destroy(result.handle);
  });

  it('图集块真的产出图片，而不是一排空 ref（端到端回归）', async () => {
    const result = await runStructured({
      projectId: 'e2e-gallery-images',
      goal: '做作品展示页，含图片集',
      candidateBlockIds: ['hero', 'gallery', 'cta'],
      maxBlocks: 3,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const html = await readIndexHtml(result);

    // 定位到 gallery 块，检查它里面的图。
    const start = html.indexOf('data-ms-type="gallery"');
    assert.ok(start >= 0, '这次运行没有产出 gallery 块，用例失去意义');
    // 取到下一个块锚点为止，避免把别的块的图算进来。
    const next = html.indexOf('data-ms-block=', start + 10);
    const gallery = next > 0 ? html.slice(start, next) : html.slice(start);

    const imgCount = (gallery.match(/<img /g) ?? []).length;
    assert.ok(imgCount >= 2, `gallery 里只有 ${imgCount} 张 <img>，图集是空的`);

    // 每一张都必须是可渲染的图，不能是空 src。
    assert.ok(!/src=""/.test(gallery), 'gallery 里出现了空 src —— 浏览器会再请求一次当前页');
    assert.ok(
      (gallery.match(/src="data:image\/svg\+xml/g) ?? []).length >= 2,
      'gallery 的图不是内联 data URI',
    );
    // alt 也要有，否则读屏软件读不出来、破图也看不出是什么。
    assert.ok((gallery.match(/alt="[^"]+"/g) ?? []).length >= 2, 'gallery 的图缺少 alt');

    await sandbox.destroy(result.handle);
  });

  /**
   * 回归：**站点名不能在词中间切断。**
   *
   * 缺陷出现过两次，第二次尤其值得记：
   *   1. `deriveBrand` 自己按字数硬截，得到「含首屏、特」这种残句；
   *   2. 修好 `deriveBrand` 之后**页面上没变**——因为工具层另写了一份
   *      `goal.slice(0, 16)` 兜底，服务端这条路径根本不走 `deriveBrand`。
   *
   * 第 2 条是这类"修了但没生效"的典型：单测在 `filler` 上全绿，
   * 端到端产出的页面却纹丝不动。所以这条断言必须走**完整链路**，
   * 而且看的是**产物里的文本**，不是函数返回值。
   */
  it('站点名不在词中间切断（端到端回归，覆盖工具层兜底）', async () => {
    const goal = '做一个产品介绍落地页，含首屏、特性与行动号召';
    const result = await runStructured({
      projectId: 'e2e-brand-cut',
      goal,
      candidateBlockIds: ['nav', 'hero', 'cta'],
      maxBlocks: 3,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const html = await readIndexHtml(result);

    // 页面顶部/导航里的站点名。
    const brandMatch = /class="ms-nav__brand">([^<]*)</.exec(html);
    assert.ok(brandMatch !== null, '没有找到导航站点名');
    const brand = brandMatch[1]!;
    assert.ok(brand.trim() !== '', '站点名是空的');
    // 不该以一个孤立的分隔符结尾——那正是"切在词中间"的痕迹。
    assert.ok(!/[、，,：:;；]$/.test(brand), `站点名以分隔符结尾：「${brand}」`);
    // 也不该是"含首屏、特"这种半截短语。
    assert.ok(!brand.includes('含首屏'), `站点名切在了小句中间：「${brand}」`);
    // 应当在第一个小句边界处停下。
    assert.equal(brand, '产品介绍落地页');

    await sandbox.destroy(result.handle);
  });

  it('产物自包含：不引用任何外部资源', async () => {
    const result = await runStructured({
      projectId: 'e2e-selfcontained',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'gallery', 'cta'],
      maxBlocks: 3,
    });    const html = await readIndexHtml(result);
    // 页面要在 network=none 的容器里跑起来，任何外链都是一次必然失败。
    assert.ok(!/<link[^>]+href="https?:/i.test(html), '引用了外部样式表');
    assert.ok(!/<script[^>]+src=/i.test(html), '引用了外部脚本');
    assert.ok(!/@import\s+url\(/i.test(html), 'CSS 里有 @import');
    assert.ok(!/url\(["']?https?:/i.test(html), 'CSS 里有外部资源引用');
    // 默认不标注——标注是调试开关。
    //
    // 查的是**渲染出来的标注元素**，不是字符串 `ms-annotate`：
    // 样式表里无论如何都有 `.ms-annotate` 这条规则（它只是个类名定义，
    // 没有元素用到就不产生任何效果）。按字符串查会永远失败，那是假失败。
    assert.ok(!html.includes('class="ms-annotate"'), '默认渲染不该带标注元素');
    await sandbox.destroy(result.handle);
  });

  it('annotate 打开时才输出来源标注', async () => {
    const result = await runStructured({
      projectId: 'e2e-annotate',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'cta'],
      maxBlocks: 2,
      annotate: true,
    });
    const html = await readIndexHtml(result);
    assert.ok(html.includes('class="ms-annotate"'), 'annotate 打开后没有输出标注元素');
    // 标注里要能看出这块是谁填的。
    assert.ok(html.includes('deterministic'), '标注里没有来源信息');
    await sandbox.destroy(result.handle);
  });

  it('执行结果回填进结构留痕：status 不再是 pending', async () => {
    const result = await runStructured({
      projectId: 'e2e-status-merge',
      goal: '做一个产品介绍落地页',
      candidateBlockIds: ['hero', 'features', 'cta'],
      maxBlocks: 3,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');

    // 结构是**产出**，所以它必须说最终形态。停在 `pending` 的话，
    // 界面上会一直显示"三块都未填充"，而页面早就渲染好了——
    // 数据、产物、日志三处都正常，只有这一处说反了。
    const page = result.structure?.page;
    assert.ok(page !== undefined, '结构没带到结果上');
    for (const block of page.blocks) {
      assert.equal(block.status, 'filled', `${block.id} 仍是 ${block.status}`);
      assert.ok(
        Object.keys(block.sources).length > 0,
        `${block.id} 没有来源标记——"这块是模型写的还是确定性拼的"就看不出来了`,
      );
    }
    // 回填不该改动结构本身：id 与类型要原样保留，否则"定点重做"就找不到目标了。
    assert.deepEqual(
      page.blocks.map((b) => b.id),
      page.blocks.map((_, i) => `b${i + 1}`),
      'id 应当是连续的 b1..bN',
    );
    await sandbox.destroy(result.handle);
  });

  it('结构留痕被带到调用方——这是前端"先看结构再执行"与沉淀模板的材料', async () => {
    const events: string[] = [];
    let captured: unknown;
    const result = await new Orchestrator().run(
      {
        projectId: 'e2e-trace',
        goal: '做落地页',
        envType: 'webpage',
        candidateBlockIds: ['hero', 'features', 'cta'],
        maxBlocks: 3,
      },
      {
        registry: registry(),
        decision: decision(),
        sandbox,
        onEvent: (e) => {
          events.push(e.type);
          if (e.type === 'plan_assembled' && e.structure !== undefined) captured = e.structure;
        },
      },
    );
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    assert.ok(captured !== undefined, 'plan_assembled 事件里没有结构');
    const structure = captured as {
      page: { blocks: readonly { id: string; type: string }[]; qualityScore: number | null };
      steps: readonly { round: number; rationale: string }[];
    };
    assert.ok(structure.page.blocks.length >= 2);
    assert.ok(structure.steps.length > 0, '没有逐轮决策留痕');
    for (const step of structure.steps) assert.ok(step.rationale.length > 0);
    // 评分是 `score` 原语的产物，必须带出来。
    assert.ok(structure.page.qualityScore !== null, '结构评分没有随结构带出');
    await sandbox.destroy(result.handle);
  });

  it('未注册 block 候选时明确失败，而不是悄悄换一个', async () => {
    const result = await runStructured({
      projectId: 'e2e-bad-candidate',
      goal: 'g',
      candidateBlockIds: ['hero', 'no-such-block'],
    });
    assert.notEqual(result.status, 'succeeded');
    assert.match(result.reason ?? '', /未注册/);
    await sandbox.destroy(result.handle);
  });

  it('每块有各自独立的 outcome —— "某一块坏了只重做那一块"的前提', async () => {
    const result = await runStructured({
      projectId: 'e2e-partial',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'features', 'cta'],
      maxBlocks: 3,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const fillOutcomes = (result.execution?.outcomes ?? []).filter((o) => o.toolId === 'fill-block');
    assert.ok(fillOutcomes.length >= 2);
    const ids = new Set(fillOutcomes.map((o) => o.nodeId));
    assert.equal(ids.size, fillOutcomes.length, '填充节点没有各自独立的 outcome');
    for (const outcome of fillOutcomes) {
      assert.equal(outcome.status, 'succeeded', `${outcome.nodeId}: ${outcome.error ?? ''}`);
    }
    await sandbox.destroy(result.handle);
  });

  it('产物校验节点被追加，且能通过', async () => {
    const result = await runStructured({
      projectId: 'e2e-verify',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'cta'],
      maxBlocks: 2,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const verify = result.execution?.outcomes.find((o) => o.toolId === 'verify-artifact');
    assert.ok(verify !== undefined, '没有追加产物校验');
    assert.equal(verify.status, 'succeeded');
    assert.ok((result.execution?.artifacts ?? []).some((a) => a.path.endsWith('index.html')));
    await sandbox.destroy(result.handle);
  });

  it('逐块填充的中间产物落在 src/blocks/ 下，可被单独检查', async () => {
    const result = await runStructured({
      projectId: 'e2e-blocks',
      goal: '做落地页',
      candidateBlockIds: ['hero', 'features', 'cta'],
      maxBlocks: 3,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const files = await sandbox.listFiles(result.handle, 'src/blocks/*.json');
    assert.ok(files.length >= 2, `src/blocks/ 下只有 ${files.length} 个文件`);
    // 每个文件都是一份合法的 block JSON —— 才可能"单独替换、单独重做"。
    for (const file of files) {
      const text = await readText(sandbox, result.handle, file.path);
      const parsed = JSON.parse(text) as { id: string; type: string; status: string; slots: unknown };
      assert.ok(typeof parsed.id === 'string');
      assert.ok(typeof parsed.type === 'string');
      assert.equal(parsed.status, 'filled');
      assert.ok(Object.keys(parsed.slots as object).length > 0, `${parsed.id} 的 slots 是空的`);
    }
    await sandbox.destroy(result.handle);
  });
});

describe('结构化链路：与既有链路并存', () => {
  it('webpage 之外的链路完全不受影响', async () => {
    const result = await new Orchestrator().run(
      { projectId: 'e2e-copy-still-works', goal: '写一段产品介绍', envType: 'copy' },
      { registry: registry(), decision: decision(), sandbox },
    );
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    assert.ok(
      (result.plan?.nodes ?? []).every(
        (n) => n.toolId !== 'fill-block' && n.toolId !== 'assemble-page',
      ),
      '结构化工具漏进了单链链路',
    );
    await sandbox.destroy(result.handle);
  });

  it('frontend 链路也没被改坏', async () => {
    const result = await new Orchestrator().run(
      { projectId: 'e2e-frontend-ok', goal: '做一个简单页面', envType: 'frontend' },
      { registry: registry(), decision: decision(), sandbox },
    );
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const html = await readText(sandbox, result.handle, 'artifacts/index.html');
    assert.ok(html.includes('<!DOCTYPE html>'));
    await sandbox.destroy(result.handle);
  });

  it('webpage 环境不会选到单链路的前端工具', async () => {
    const result = await runStructured({ projectId: 'e2e-no-scaffold', goal: '做落地页' });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const toolIds = (result.plan?.nodes ?? []).map((n) => n.toolId);
    assert.ok(!toolIds.includes('scaffold-frontend'), 'webpage 链路不该走整页生成');
    assert.ok(!toolIds.includes('static-page-from-template'), 'webpage 链路不该走模板整页生成');
    await sandbox.destroy(result.handle);
  });

  it('注册表里结构化工具只对 webpage 环境可见', () => {
    const reg = registry();
    for (const toolId of ['fill-block', 'assemble-page']) {
      const spec = reg.getSpec(toolId);
      assert.deepEqual(spec.envTypes, ['webpage']);
      // 其它环境里查不到它——这样候选集不会串。
      assert.ok(!reg.filter({ envType: 'frontend' }).some((s) => s.id === toolId));
      assert.ok(!reg.filter({ envType: 'copy' }).some((s) => s.id === toolId));
    }
  });

  it('webpage 环境的候选集非空且都能当主产出', () => {
    const reg = registry();
    const specs = reg.filter({ envType: 'webpage', role: 'generate' });
    assert.ok(specs.length > 0);
    for (const spec of specs) assert.ok(spec.envTypes.includes('webpage'));
  });

  it('不指定候选集时用 block 池全集，默认就能跑通', async () => {
    const result = await runStructured({ projectId: 'e2e-default-pool', goal: '做落地页' });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const html = await readIndexHtml(result);
    assert.ok(html.includes('<!DOCTYPE html>'));
    await sandbox.destroy(result.handle);
  });
});

/**
 * 自定义 block（模型提议 / 用户手打 / 导入）走完整条链路。
 *
 * 设计稿 §2.2 把这三类来源列为"用户可选项"，但此前是**断链**：
 * 规划器、fill-block、assemble-page 各自 `createBlockRegistry()` 新建内置池，
 * 于是外部 block 只在 `/api/blocks` 里存在。这里端到端守住修好之后的行为。
 */
describe('结构化链路：自定义 block 能真正参与制作', () => {
  const promoBanner: BlockSpec = {
    id: 'promo-banner',
    label: '促销横幅',
    description: '一条限时促销提示',
    group: 'skeleton',
    slots: [{ name: 'text', type: 'title', required: true, description: '促销语' }],
    canLead: false,
    repeatable: false,
    costHint: 'fast',
  };

  it('不注入池子时，外部 block 进不了候选集——报错而不是悄悄换一个', async () => {
    const result = await runStructured({
      projectId: 'e2e-custom-nopool',
      goal: 'g',
      candidateBlockIds: ['hero', 'promo-banner'],
    });
    assert.notEqual(result.status, 'succeeded');
    assert.match(result.reason ?? '', /未注册/);
    await sandbox.destroy(result.handle);
  });

  it('注入池子后同一个请求能跑通，且这个块真的出现在结构里', async () => {
    const pool = createBlockRegistry([promoBanner]);
    const capture: { page?: PageSpec } = {};
    const result = await runStructured({
      projectId: 'e2e-custom-pool',
      goal: '做一个产品介绍落地页',
      // 只有 hero 能当首块 → 首轮直接采用；第二轮候选只剩 promo-banner → 也直接采用。
      // 于是这个断言是确定性的，不依赖演示决策层的关键词判断。
      candidateBlockIds: ['hero', 'promo-banner'],
      blocks: pool,
      capture,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const types = capture.page?.blocks.map((b) => b.type) ?? [];
    assert.ok(types.includes('promo-banner'), `结构里没有自定义块：${types.join(' → ')}`);
    await sandbox.destroy(result.handle);
  });

  it('自定义 block 的填充也走通了——不是"选得到、填不了"', async () => {
    const pool = createBlockRegistry([promoBanner]);
    const result = await runStructured({
      projectId: 'e2e-custom-fill',
      goal: '做一个产品介绍落地页',
      candidateBlockIds: ['hero', 'promo-banner'],
      blocks: pool,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const fillOutcomes = (result.execution?.outcomes ?? []).filter((o) => o.toolId === 'fill-block');
    assert.ok(fillOutcomes.length >= 2);
    for (const outcome of fillOutcomes) {
      assert.equal(outcome.status, 'succeeded', `${outcome.nodeId}: ${outcome.error ?? ''}`);
    }
    await sandbox.destroy(result.handle);
  });

  it('自定义 block 在产物里真的渲染出内容，而不是占位块', async () => {
    const pool = createBlockRegistry([promoBanner]);
    const result = await runStructured({
      projectId: 'e2e-custom-render',
      goal: '做一个产品介绍落地页',
      candidateBlockIds: ['hero', 'promo-banner'],
      blocks: pool,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');

    const html = await readIndexHtml(result);
    // 这一条是这次修复的正面断言：以前它会命中"未支持的 block 类型"。
    assert.ok(!html.includes('未支持的 block 类型'), '自定义 block 落成了"未支持的 block 类型"占位');
    assert.ok(html.includes('ms-block--promo-banner'), '这个块没进页面');
    assert.ok(
      html.includes('ms-generic__title'),
      '通用渲染器没被调用——title slot 没出小标题，说明内容填了却没画出来',
    );
    await sandbox.destroy(result.handle);
  });
});

describe('结构化链路：模板', () => {
  function template(blocks: readonly string[]): TemplateSpec {
    return {
      id: 'tpl-e2e',
      label: '端到端测试模板',
      description: '用于测试',
      blocks: blocks.map((type) => ({ type })),
      builtin: false,
    };
  }

  it('模板的起手结构落进页面，templateId 记在结构上', async () => {
    const capture: { page?: PageSpec } = {};
    const result = await runStructured({
      projectId: 'e2e-tpl',
      goal: '做一个产品介绍落地页',
      candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
      template: template(['hero', 'features']),
      capture,
    });
    assert.equal(result.status, 'succeeded', result.reason ?? '');
    const page = capture.page;
    assert.equal(page?.templateId, 'tpl-e2e');
    assert.deepEqual(
      page?.blocks.slice(0, 2).map((b) => b.type),
      ['hero', 'features'],
      '起手结构应当原样出现在页面开头',
    );
    await sandbox.destroy(result.handle);
  });

  it('从历史沉淀的模板能直接拿来起手——"越用越好用"的闭环', async () => {
    // 先跑一次，把产出结构沉淀成模板。
    const firstCapture: { page?: PageSpec } = {};
    const first = await runStructured({
      projectId: 'e2e-tpl-source',
      goal: '做一个产品介绍落地页',
      candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
      maxBlocks: 4,
      capture: firstCapture,
    });
    assert.equal(first.status, 'succeeded', first.reason ?? '');
    const source = firstCapture.page;
    assert.ok(source !== undefined);
    await sandbox.destroy(first.handle);

    const recycled = extractTemplate(source, { id: 'tpl-recycled-e2e' });
    assert.ok(recycled.blocks.length > 0);

    // 再拿它起手跑第二次。
    const secondCapture: { page?: PageSpec } = {};
    const second = await runStructured({
      projectId: 'e2e-tpl-reuse',
      goal: '做另一个产品的落地页',
      candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
      template: recycled,
      capture: secondCapture,
    });
    assert.equal(second.status, 'succeeded', second.reason ?? '');
    const reused = secondCapture.page;
    assert.equal(reused?.templateId, 'tpl-recycled-e2e');
    assert.deepEqual(
      reused?.blocks.slice(0, recycled.blocks.length).map((b) => b.type),
      recycled.blocks.map((b) => b.type),
    );
    // 沉淀的是结构，不是内容：新项目的页面不该出现上一次的目标原文。
    assert.notEqual(reused?.goal, source.goal);
    await sandbox.destroy(second.handle);
  });
});
