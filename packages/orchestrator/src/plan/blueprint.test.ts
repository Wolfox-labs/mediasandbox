/**
 * 统筹规划的测试。
 *
 * 这批测试盯的是**两个模型分工的接口**，不是"prompt 写得好不好"：
 *   - 模型返回 JSON → 段落被读成结构，编出来的块名被过滤掉
 *   - 模型返回中文散文 → 仍能读出段落，但标成 `lenient`
 *   - 模型不可用 → 如实返回失败，**不伪造计划**
 *   - 计划能压成决策层的 facts，且能跟实际结构对照
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockRegistry } from '../structured/block-spec.js';
import { MockLlmClient } from '../testing/mock-llm.js';
import { blueprintFacts, describeAlignment, planBlueprint } from './blueprint.js';

const blocks = createBlockRegistry();

function candidates() {
  return blocks.specs().slice(0, 8);
}

describe('planBlueprint', () => {
  it('模型按 JSON 契约返回时，段落被读成结构', async () => {
    const llm = new MockLlmClient({
      defaultText: JSON.stringify({
        title: '团队协作工具落地页',
        positioning: '写给中小团队的协作工具介绍页',
        audience: '10 人以下的创业团队',
        tone: '克制、具体',
        sections: [
          { purpose: '说清这是什么', detail: '一句话讲清产品解决什么问题', blockIds: ['hero'] },
          { purpose: '证明它好使', detail: '三条客户实证', blockIds: ['features', 'no-such-block'] },
          { purpose: '让人动手', detail: '一个免费试用入口', blockIds: ['cta'] },
        ],
        notes: ['不要用"颠覆"这类词'],
      }),
    });

    const outcome = await planBlueprint({
      llm,
      goal: '给中小团队做一个协作工具落地页',
      envType: 'webpage',
      blocks: candidates(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.blueprint.status, 'ok');
    assert.equal(outcome.blueprint.title, '团队协作工具落地页');
    assert.equal(outcome.blueprint.sections.length, 3);
    assert.equal(outcome.blueprint.sections[0]!.purpose, '说清这是什么');
    // 编出来的块名必须被过滤：它到下游一定会被拦，不如在"建议"这一栏就不出现。
    assert.deepEqual(outcome.blueprint.sections[1]!.blockIds, ['features']);
    assert.deepEqual(outcome.blueprint.notes, ['不要用"颠覆"这类词']);
  });

  it('返回中文散文时按行解析，并标成 lenient', async () => {
    const llm = new MockLlmClient({
      defaultText: [
        '# 内部工具迁移说明',
        '- 先说清为什么迁：老工具的痛点：三句话讲完',
        '- 迁移怎么做：分三步，每步给一个负责人',
        '- 出问题找谁：留一个支持入口',
      ].join('\n'),
    });

    const outcome = await planBlueprint({
      llm,
      goal: '写一个内部工具迁移说明页',
      envType: 'webpage',
      blocks: candidates(),
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.blueprint.status, 'lenient');
    assert.equal(outcome.blueprint.title, '内部工具迁移说明');
    assert.equal(outcome.blueprint.sections.length, 3);
    assert.equal(outcome.blueprint.sections[0]!.purpose, '先说清为什么迁');
    assert.equal(outcome.blueprint.sections[0]!.detail, '老工具的痛点：三句话讲完');
  });

  it('模型不可用时如实返回失败，不伪造计划', async () => {
    const llm = new MockLlmClient({
      rules: [{ match: '规划失败测试', fail: '规划服务 503' }],
    });

    const outcome = await planBlueprint({
      llm,
      goal: '规划失败测试',
      envType: 'webpage',
      blocks: candidates(),
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.detail, /规划模型调用失败/);
    assert.match(outcome.detail, /503/);
  });

  it('返回空内容时也算失败，而不是给一份空计划', async () => {
    const llm = new MockLlmClient({ defaultText: '   ' });
    const outcome = await planBlueprint({
      llm,
      goal: '随便一个目标',
      envType: 'webpage',
      blocks: candidates(),
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.detail, /空内容/);
  });

  it('读不出段落时算失败', async () => {
    // 只有一句引号包着的废话，既不是 JSON 也没有列表/标题。
    const llm = new MockLlmClient({ defaultText: '好' });
    const outcome = await planBlueprint({
      llm,
      goal: '随便一个目标',
      envType: 'webpage',
      blocks: candidates(),
    });

    // 单行非空文本会被当成 title，没有段落 → 失败。
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.detail, /读不出任何段落/);
  });
});

describe('blueprintFacts', () => {
  it('把计划压成决策层能读的事实，且不带"该选哪块"的暗示', async () => {
    const llm = new MockLlmClient({
      defaultText: JSON.stringify({
        title: '落地页',
        positioning: '一句话定位',
        audience: '中小团队',
        tone: '克制',
        sections: [
          { purpose: '讲清是什么', detail: '', blockIds: ['hero'] },
          { purpose: '给出凭证', detail: '', blockIds: [] },
        ],
        notes: [],
      }),
    });
    const outcome = await planBlueprint({
      llm,
      goal: '做一个落地页',
      envType: 'webpage',
      blocks: candidates(),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const facts = blueprintFacts(outcome.blueprint);
    assert.equal(facts['规划段落数'], '2');
    assert.match(facts['整体规划']!, /落地页/);
    assert.match(facts['规划段落']!, /1\. 讲清是什么（建议块 hero）/);
    assert.match(facts['规划段落']!, /2\. 给出凭证$/);
    assert.equal(facts['目标读者'], '中小团队');
    assert.equal(facts['语气'], '克制');
  });
});

describe('describeAlignment', () => {
  const blueprint = {
    title: '',
    positioning: '',
    audience: '',
    tone: '',
    sections: [
      { purpose: 'a', detail: '', blockIds: [] },
      { purpose: 'b', detail: '', blockIds: [] },
      { purpose: 'c', detail: '', blockIds: [] },
    ],
    notes: [],
    status: 'ok' as const,
    model: 'm',
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: '',
  };

  it('块数与段数相差 1 以内算对得上', () => {
    for (const count of [2, 3, 4]) {
      const result = describeAlignment(blueprint, count);
      assert.equal(result.aligned, true, `${count} 块应当算对得上`);
    }
  });

  it('差得多就算对不上，并把差值写出来', () => {
    const result = describeAlignment(blueprint, 7);
    assert.equal(result.aligned, false);
    assert.equal(result.plannedSections, 3);
    assert.match(result.detail, /计划 3 段，实际 7 块，差 \+4/);
  });
});
