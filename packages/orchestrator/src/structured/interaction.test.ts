/**
 * 交互验证的测试。
 *
 * 用假驱动 + 假决策层就能覆盖的，正是这条链路里最容易出错的部分：
 * **候选有没有送到决策层、它的选择有没有被采纳、弃权/越界怎么兜底。**
 * 真浏览器那一半由 `probe-click.mjs` 对着真 chromium 跑（见该脚本注释）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecisionContext, DecisionBatchResult, DecisionClient, Question } from '../decision/types.js';
import type { ClickDriver, ClickRequest, ClickResult } from '../render/click.js';
import type { BlockInstance, PageSpec } from './page-spec.js';
import { createPageSpec } from './page-spec.js';
import { verifyInteraction } from './interaction.js';

function block(id: string, type: string, slots: BlockInstance['slots']): BlockInstance {
  const sources: Record<string, 'deterministic'> = {};
  for (const name of Object.keys(slots)) sources[name] = 'deterministic';
  return { id, type, slots, status: 'filled', sources };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return { ...createPageSpec({ projectId: 'proj', goal: '测试目标', candidateBlockIds: [] }), blocks };
}

const tabsPage = page([
  block('b1', 'tabs', {
    tabs: { kind: 'list', items: ['概览', '参数'] },
    panels: { kind: 'list', items: ['概览正文', '参数正文'] },
  }),
]);

/** 只回答 choice 的假决策层：记录被问到的候选，按脚本挑一个（`null` = 弃权）。 */
class PickingDecision implements DecisionClient {
  readonly kind = 'stub' as const;
  calls = 0;
  options: string[] = [];
  question = '';

  private readonly picks: readonly (string | null)[];

  constructor(pick: string | null | readonly (string | null)[]) {
    this.picks = Array.isArray(pick) ? pick : [pick as string | null];
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'stub' };
  }

  async decide(
    _context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
  ): Promise<DecisionBatchResult> {
    this.calls += 1;
    const answers: Record<string, ReturnType<typeof choiceAnswer>> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (question.type !== 'choice') throw new Error(`交互验证只该问 choice，收到了 ${question.type}`);
      this.options = Object.keys(question.criteria);
      this.question = question.instructions;
      const picked = this.picks[this.calls - 1] ?? this.picks[this.picks.length - 1] ?? null;
      answers[id] = choiceAnswer(picked);
    }
    return { answers, meta: { latencyMs: 1, source: 'stub' }, usage: { inputTokens: 10, outputTokens: 0 }, raw: { stub: true } };
  }
}

function choiceAnswer(value: string | null) {
  return { type: 'choice' as const, value, probabilities: value === null ? {} : { [value]: 0.9 } };
}

/**
 * 假驱动：记录被点的是谁，结论由测试自己给。
 *
 * `dudKeys` 里的目标"点了没变化"——用来重现"决策层挑了个白点的元素"。
 */
class RecordingDriver implements ClickDriver {
  readonly name = 'recording';
  readonly placeholder = false;
  readonly requests: ClickRequest[] = [];

  constructor(private readonly dudKeys: readonly string[] = []) {}

  async click(request: ClickRequest): Promise<ClickResult> {
    this.requests.push(request);
    const changed = !this.dudKeys.includes(request.target.key);
    return {
      target: request.target,
      before: { selectedTabs: ['b1:1'] },
      after: { selectedTabs: changed ? [request.target.key] : ['b1:1'] },
      changed,
      detail: changed ? '点击后标签页变为选中' : `点击后 ${request.target.key} 没有任何变化`,
      screenshot: { bytes: new Uint8Array([1, 2, 3]), path: 'artifacts/click.png' },
      driver: this.name,
      placeholder: false,
    };
  }
}

/** 假沙盒：只关心"渲染结果有没有被写回工作区"。 */
function fakeSandbox(): { provider: never; handle: never; written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    provider: {
      writeFile: async (_handle: unknown, relPath: string, content: string | Uint8Array) => {
        written.set(relPath, typeof content === 'string' ? content : Buffer.from(content).toString());
      },
    } as never,
    handle: {} as never,
    written,
  };
}

const sandbox = fakeSandbox();

describe('交互验证：候选由页面定，选择由决策层定，结论由代码定', () => {
  it('解析用的 HTML 被写回工作区，解析与点击是同一份字节', async () => {
    const fresh = fakeSandbox();
    await verifyInteraction({
      structure: tabsPage,
      decision: new PickingDecision('b1:1'),
      driver: new RecordingDriver(),
      sandbox: fresh,
      goal: '测试目标',
    });
    const writtenHtml = fresh.written.get('artifacts/index.html') ?? '';
    assert.ok(writtenHtml.includes('data-ms-tab="b1:1"'), '页面没写回工作区');
    assert.ok(writtenHtml.includes('参数'), '写回的不是渲染结果');
  });

  it('决策层被问到全部候选，且采纳它的选择', async () => {
    const decision = new PickingDecision('b1:2');
    const driver = new RecordingDriver();
    const result = await verifyInteraction({ structure: tabsPage, decision, driver, sandbox, goal: '测试目标' });

    assert.equal(decision.calls, 1);
    assert.deepEqual(decision.options, ['b1:1', 'b1:2']);
    assert.match(decision.question, /交互验证/);
    assert.match(decision.question, /b1:2：参数/);
    assert.equal(result.picked?.key, 'b1:2', '没采纳决策层的选择');
    assert.equal(driver.requests[0]?.target.key, 'b1:2');
    assert.equal(result.targets.length, 2, '候选列表没带回来');
    assert.equal(result.placeholder, false);
    assert.match(result.detail, /交互验证通过/);
    assert.match(result.detail, /artifacts\/click\.png/);
  });

  it('弃权时按文档顺序兜底，并在结论里说清是兜底', async () => {
    const decision = new PickingDecision(null);
    const driver = new RecordingDriver();
    const result = await verifyInteraction({ structure: tabsPage, decision, driver, sandbox, goal: '测试目标' });
    assert.equal(result.picked?.key, 'b1:1');
    assert.match(result.detail, /弃权/);
    assert.match(result.detail, /按文档顺序/);
  });

  it('决策层给了不存在的 key，退回第一个候选而不是崩掉', async () => {
    const decision = new PickingDecision('不存在:9');
    const driver = new RecordingDriver();
    const result = await verifyInteraction({ structure: tabsPage, decision, driver, sandbox, goal: '测试目标' });
    assert.equal(result.picked?.key, 'b1:1');
    assert.equal(driver.requests.length, 1, '该点一次且只点一次');
  });

  it('没有可点元素时不问决策层，也不假装验证过', async () => {
    const decision = new PickingDecision('b1:1');
    const driver = new RecordingDriver();
    const result = await verifyInteraction({
      structure: page([block('b1', 'text', { body: { kind: 'text', text: '静态段落' } })]),
      decision,
      driver,
      sandbox,
      goal: '测试目标',
    });
    assert.equal(decision.calls, 0, '没有候选还去问决策层');
    assert.equal(driver.requests.length, 0, '没有候选还是点了');
    assert.deepEqual(result.targets, []);
    assert.match(result.detail, /没有可点元素/);
  });

  it('点击没生效时结论是未通过，不粉饰', async () => {
    const decision = new PickingDecision('b1:2');
    const driver = new RecordingDriver(['b1:1', 'b1:2']);
    const result = await verifyInteraction({ structure: tabsPage, decision, driver, sandbox, goal: '测试目标' });
    assert.match(result.detail, /交互验证未通过/);
  });

  it('第一次挑中"点了没变化"的目标时，换一个候选再点（并留下两次记录）', async () => {
    // 决策层第一次挑 b1:2（假驱动把它当白点），第二次只剩 b1:1，点通了。
    const decision = new PickingDecision(['b1:2', 'b1:1']);
    const driver = new RecordingDriver(['b1:2']);
    const result = await verifyInteraction({ structure: tabsPage, decision, driver, sandbox, goal: '测试目标' });

    assert.deepEqual(
      driver.requests.map((r) => r.target.key),
      ['b1:2', 'b1:1'],
      '应该换一个候选再试，而不是盯着同一个死点',
    );
    assert.equal(result.result?.changed, true);
    assert.match(result.detail, /交互验证通过/);
    assert.match(result.detail, /第 2 次尝试生效/);
    assert.match(result.detail, /尝试 2 次/);
    assert.equal(result.attempts?.length, 2);
    assert.match(result.attempts?.[0] ?? '', /b1:2/);
    // 第二轮只剩一个候选，不能再问决策层（choice 至少要 2 个候选，问了就是 422）。
    assert.equal(decision.calls, 1, '只剩一个候选时不该再问一次');
  });

  it('只剩一个候选且它点了没变化时，不会拿同一个目标反复点', async () => {
    const form = page([
      block('b7', 'form', {
        heading: { kind: 'text', text: '联系我们' },
        fields: { kind: 'list', items: ['邮箱'] },
        submitText: { kind: 'text', text: '发送' },
      }),
    ]);
    const decision = new PickingDecision('b7');
    const driver = new RecordingDriver(['b7']);
    const result = await verifyInteraction({ structure: form, decision, driver, sandbox, goal: '测试目标' });
    assert.equal(driver.requests.length, 1, '同一个候选只该点一次');
    assert.match(result.detail, /交互验证未通过/);
  });

  it('页面上只有一个可点元素时不问决策层，直接点它并说清没得挑', async () => {
    const form = page([
      block('b7', 'form', {
        heading: { kind: 'text', text: '联系我们' },
        fields: { kind: 'list', items: ['邮箱'] },
        submitText: { kind: 'text', text: '发送' },
      }),
    ]);
    const decision = new PickingDecision('b7');
    const driver = new RecordingDriver();
    const result = await verifyInteraction({ structure: form, decision, driver, sandbox, goal: '测试目标' });
    assert.equal(decision.calls, 0, '只有一个候选还去问决策层，服务端会直接 422');
    assert.equal(driver.requests.length, 1);
    assert.equal(result.picked?.key, 'b7');
    assert.match(result.detail, /只有一个可点元素/);
  });

  it('候选超过决策层上限时截断，并在上下文里说明', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `标签${i + 1}`).join('\n');
    const big = page([
      block(
        'b1',
        'tabs',
        // 直接用 items 数组，绕开竖线/换行解析：这里要的就是 30 个候选。
        { tabs: { kind: 'list', items: Array.from({ length: 30 }, (_, i) => `标签${i + 1}`) }, panels: { kind: 'list', items: Array.from({ length: 30 }, (_, i) => `正文${i + 1}`) } },
      ),
    ]);
    void many;
    const decision = new PickingDecision('b1:30');
    const driver = new RecordingDriver();
    const result = await verifyInteraction({ structure: big, decision, driver, sandbox, goal: '测试目标' });
    assert.equal(decision.options.length, 26, '候选没有按上限截断（决策层会直接 422）');
    assert.equal(result.targets.length, 30, '页面上真实候选数不该被改');
    assert.equal(result.picked?.key, 'b1:1', '截断掉的候选被选中，应该退回第一个');
  });
});
