/**
 * 模拟点击的测试（不需要 Docker / 浏览器的那一半）。
 *
 * 重点全在**判定**上：模型挑目标可以挑错，但"算不算点成功"
 * 必须由这里的规则说了算，而且失败原因要说人话——
 * 报告里写"点击未生效，标签页仍未被选中"才有诊断价值，
 * 写"验证失败"等于什么都没说。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClickTarget } from './click-targets.js';
import {
  buildClickScript,
  judgeClick,
  parseClickScriptResult,
  PlaceholderClickDriver,
} from './click.js';
import { ChromiumClickDriver } from './chromium-click.js';

function target(kind: ClickTarget['kind'], key: string, blockId = 'b1'): ClickTarget {
  return {
    kind,
    blockId,
    part: 1,
    key,
    label: '标签',
    selector: `[data-ms-${kind}="${key}"]`,
    effect: '效果',
    initiallyActive: false,
  };
}

describe('模拟点击：判定只看可观察的变化', () => {
  it('标签页从没选中变成选中 = 生效', () => {
    const verdict = judgeClick(
      target('tab', 'b1:2'),
      { selectedTabs: ['b1:1'] },
      { selectedTabs: ['b1:2'] },
    );
    assert.equal(verdict.changed, true);
    assert.match(verdict.detail, /b1:2 变为选中/);
  });

  it('标签页点了还是没选中 = 不生效，且说清当前选中是谁', () => {
    const verdict = judgeClick(
      target('tab', 'b1:2'),
      { selectedTabs: ['b1:1'] },
      { selectedTabs: ['b1:1'] },
    );
    assert.equal(verdict.changed, false);
    assert.match(verdict.detail, /仍未选中/);
    assert.match(verdict.detail, /b1:1/);
  });

  it('本来就已经选中的标签页不算验证成功（没有可观察的变化）', () => {
    const verdict = judgeClick(
      target('tab', 'b1:1'),
      { selectedTabs: ['b1:1'] },
      { selectedTabs: ['b1:1'] },
    );
    assert.equal(verdict.changed, false);
    assert.match(verdict.detail, /就已经是选中状态/);
  });

  it('折叠项开合任一方向都算生效', () => {
    const opened = judgeClick(target('accordion', 'b9:2'), { openAccordions: ['b9:1'] }, { openAccordions: ['b9:1', 'b9:2'] });
    assert.equal(opened.changed, true);
    assert.match(opened.detail, /展开/);
    const closed = judgeClick(target('accordion', 'b9:1'), { openAccordions: ['b9:1'] }, { openAccordions: [] });
    assert.equal(closed.changed, true);
    assert.match(closed.detail, /收起/);
  });

  it('折叠项状态没动 = 不生效', () => {
    const verdict = judgeClick(target('accordion', 'b9:2'), { openAccordions: [] }, { openAccordions: [] });
    assert.equal(verdict.changed, false);
    assert.match(verdict.detail, /没有变化/);
  });

  it('表单提示由隐藏变可见 = 生效', () => {
    const verdict = judgeClick(target('submit', 'b7'), { formNoteVisible: false }, { formNoteVisible: true });
    assert.equal(verdict.changed, true);
    assert.match(verdict.detail, /提示变为可见/);
  });

  it('表单提示本来就可见不算验证成功', () => {
    const verdict = judgeClick(target('submit', 'b7'), { formNoteVisible: true }, { formNoteVisible: true });
    assert.equal(verdict.changed, false);
  });
});

describe('模拟点击：页面内脚本', () => {
  it('脚本里带目标选择器，并且真的调用 click()', () => {
    const script = buildClickScript(target('tab', 'b1:2'));
    assert.ok(script.includes('document.querySelector("[data-ms-tab=\\"b1:2\\"]")'), '选择器没进脚本');
    assert.ok(script.includes('el.click()'), '没有真的点击');
    assert.ok(script.includes('"b1:2"'), 'key 没进脚本');
  });

  it('选择器里的引号被 JSON 转义，脚本撑不破', () => {
    const script = buildClickScript({ ...target('tab', 'b1:1'), selector: '[data-ms-tab="a\\"b"]' });
    assert.ok(script.includes('\\"'), '引号没被转义');
    assert.ok(!script.includes('querySelector([data-ms-tab'), '选择器没被当成字符串');
  });

  it('快照在前、点击在中、快照在后', () => {
    const script = buildClickScript(target('tab', 'b1:1'));
    const before = script.indexOf('const before = snap()');
    const click = script.indexOf('el.click()');
    const after = script.indexOf('const after = snap()');
    assert.ok(before > 0 && before < click && click < after, '三次动作顺序不对');
  });

  it('返回结构不对就报错，不猜', () => {
    assert.throws(() => parseClickScriptResult(42), /没有返回字符串/);
    assert.throws(() => parseClickScriptResult('{"x":1}'), /缺 found/);
    assert.equal(parseClickScriptResult('{"found":false}').found, false);
  });
});

describe('模拟点击：占位驱动不假装点过', () => {
  it('明确报告没真点、结论不可信', async () => {
    const result = await new PlaceholderClickDriver().click({
      target: target('tab', 'b1:1'),
      width: 800,
      height: 600,
    });
    assert.equal(result.placeholder, true);
    assert.equal(result.changed, false);
    assert.match(result.detail, /没有真点击/);
    assert.match(result.detail, /未经验证/);
  });
});

describe('模拟点击：真驱动的前置条件', () => {
  it('没有沙盒就直接说清楚，不静默降级', async () => {
    const driver = new ChromiumClickDriver({ docker: { createContainer: async () => {
      throw new Error('不该走到建容器');
    } } });
    await assert.rejects(
      () => driver.click({ target: target('tab', 'b1:1'), width: 800, height: 600 }),
      /需要沙盒/,
    );
  });

  it('端口等不到时按时失败，并且把旁挂容器删掉', async () => {
    let removed = 0;
    const driver = new ChromiumClickDriver({
      timeoutMs: 300,
      docker: {
        createContainer: async () => ({
          start: async () => undefined,
          wait: async () => ({ StatusCode: 0 }),
          remove: async () => {
            removed += 1;
          },
          // 端口永远拿不到：模拟 chromium 起不来。
          inspect: async () => ({ NetworkSettings: { Ports: {} } }),
        }),
      },
    });
    await assert.rejects(
      () =>
        driver.click({
          target: target('tab', 'b1:1'),
          width: 800,
          height: 600,
          sandbox: { provider: {} as never, handle: { workDir: 'E:/tmp/sb' } as never },
        }),
      /等不到 chromium 调试端口/,
    );
    assert.equal(removed, 1, '容器没被清理，泄漏了');
  });
});
