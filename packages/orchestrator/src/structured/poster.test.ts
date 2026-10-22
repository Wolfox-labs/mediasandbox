import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalSandbox } from '@mediasandbox/sandbox';
import { ToolRegistry } from '../tools/registry.js';
import { MockLlmClient } from '../testing/mock-llm.js';
import { defaultScreenshotDriver } from '../render/screenshot.js';
import {
  normalizeBrief,
  POSTER_SIZES,
  renderPosterHtml,
  resolvePosterSize,
} from '../structured/poster.js';
import { createPosterTools } from '../structured/poster-tools.js';
import { posterWorkflow } from '../workflow/presets.js';
import { runWorkflow } from '../workflow/runner.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-poster-test-${process.pid}`);
const sandbox = new LocalSandbox({ rootDir });
const handles: string[] = [];

async function makeHandle() {
  const handle = await sandbox.create(`poster${process.pid}${handles.length}`, 'image');
  handles.push(handle.id);
  return handle;
}

after(async () => {
  for (const id of handles) {
    const handle = await sandbox.get(id);
    if (handle !== undefined) await sandbox.destroy(handle);
  }
});

describe('海报版式', () => {
  it('四个尺寸都有合法的宽高与字号档', () => {
    assert.equal(POSTER_SIZES.length, 4);
    for (const size of POSTER_SIZES) {
      assert.ok(size.width >= 600 && size.height >= 600);
      assert.ok(size.baseFont >= 32);
    }
    assert.equal(resolvePosterSize('banner').width, 1200);
    assert.equal(resolvePosterSize('不存在').id, 'story');
  });

  it('渲染出的 HTML 带标题、要点、行动语，且做了转义', () => {
    const brief = normalizeBrief({
      headline: '社团招新',
      subheadline: '九月见',
      points: ['周三下午', '体育馆'],
      cta: '来报名',
      footer: '学生会',
    });
    const html = renderPosterHtml(brief, resolvePosterSize('story'));
    assert.ok(html.includes('社团招新'));
    assert.ok(html.includes('体育馆'));
    assert.ok(html.includes('来报名'));
    assert.ok(html.includes('--w: 1080px') && html.includes('--h: 1440px'));

    const escaped = renderPosterHtml(
      normalizeBrief({ headline: '<script>alert(1)</script>' }),
      resolvePosterSize('square'),
    );
    assert.ok(!escaped.includes('<script>alert(1)</script>'), '标题必须转义');
  });

  it('文案缺失时补默认值，不产出空字段', () => {
    const brief = normalizeBrief({ headline: '  ', points: ['a', '', 'b'] });
    assert.ok(brief.headline.length > 0);
    assert.deepEqual(brief.points, ['a', 'b']);
    assert.ok(brief.cta.length > 0);
    assert.ok(/^#[0-9a-f]{6}$/i.test(brief.palette.accent));
  });
});

describe('海报工作流', () => {
  it('预设的结构：1 个执笔 + 每尺寸一对渲染/导出', () => {
    const workflow = posterWorkflow({ goal: '社团招新' });
    assert.equal(workflow.nodes.length, 1 + POSTER_SIZES.length * 2);
    const render = workflow.nodes.find((node) => node.id === 'render-story');
    assert.deepEqual(render?.inputs?.['brief'], { from: 'brief', port: 'brief' });
    const exported = workflow.nodes.find((node) => node.id === 'export-a4');
    assert.deepEqual(exported?.inputs?.['file'], { from: 'render-a4', port: 'file' });
  });

  it('端到端：执笔 → 四尺寸排版 → 导出，产出四张 PNG', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createPosterTools(defaultScreenshotDriver()));

    const llm = new MockLlmClient({
      rules: [
        {
          match: '海报目标',
          text: JSON.stringify({
            headline: '校园二手市集',
            subheadline: '周六上午九点，东区操场',
            points: ['闲置书本与电器', '当面验货', '现场回收'],
            cta: '来摆摊',
            footer: '学生会 · 10 月 25 日',
          }),
        },
      ],
    });

    const handle = await makeHandle();
    const result = await runWorkflow(posterWorkflow({ goal: '校园二手市集' }), {
      registry,
      sandbox,
      handle,
      llm,
      maxConcurrency: 4,
    });

    assert.equal(result.execution.status, 'succeeded');
    const paths = result.execution.artifacts.map((artifact) => artifact.path);
    for (const size of POSTER_SIZES) {
      assert.ok(paths.includes(`artifacts/poster-${size.id}.html`), `缺 ${size.id} 的 HTML`);
      assert.ok(paths.includes(`artifacts/poster-${size.id}.png`), `缺 ${size.id} 的 PNG`);
    }
  });

  it('预设能通过静态校验（端口都接得上了）', async () => {
    const registry = new ToolRegistry();
    registry.registerAll(createPosterTools(defaultScreenshotDriver()));
    const { validateWorkflow } = await import('../workflow/validate.js');
    const order = validateWorkflow(posterWorkflow({ goal: 'x' }), { registry });
    assert.equal(order[0], 'brief');
  });
});
