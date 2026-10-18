/**
 * 统筹规划的服务层验收：**两个模型的分工要能从前端拿得到的数据里看见**。
 *
 * 这里测的不是"prompt 写得好不好"，而是三件必须成立的事：
 *   1. 配了生成层时，网页链路会**真的**先多问一次模型要整体计划（一次独立调用）
 *   2. 计划出现在 `GET /api/runs/:id` 与 `plan_assembled` 事件里，与结构并列
 *   3. 显式关掉时，结果里如实写着"被关掉了"——不是空着一栏
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLlmClient } from '@mediasandbox/orchestrator';
import { startServer } from './testing/harness.js';

const PLAN_JSON = JSON.stringify({
  title: '团队协作工具落地页',
  positioning: '给 10 人以下团队看的协作工具介绍页',
  audience: '创业团队负责人',
  tone: '克制、具体',
  sections: [
    { purpose: '说清这是什么', detail: '一句话讲清解决什么问题', blockIds: ['hero'] },
    { purpose: '证明它好使', detail: '三条客户实证', blockIds: ['features'] },
    { purpose: '让人动手', detail: '一个免费试用入口', blockIds: ['cta'] },
  ],
  notes: ['不要用"颠覆"这类词'],
});

/** 轮询到运行结束。上限放宽到 20 秒：结构化链路要跑好几个节点。 */
async function waitForStatus(
  origin: string,
  runId: string,
): Promise<{ status: string; blueprint: unknown; structure: unknown }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = (await (await fetch(`${origin}/api/runs/${runId}`)).json()) as {
      status: string;
      blueprint: unknown;
      structure: unknown;
    };
    if (['succeeded', 'failed', 'escalated', 'cancelled'].includes(detail.status)) {
      return detail;
    }
    if (Date.now() > deadline) {
      throw new Error(`运行 ${runId} 在 20 秒内没有结束（当前 ${detail.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('统筹规划（服务层）', () => {
  it('配了生成层时先规划再决策，计划出现在运行详情里', async () => {
    const llm = new MockLlmClient({ defaultText: PLAN_JSON });
    const ctx = await startServer({ structured: true, llm });

    try {
      const submit = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '给中小团队做一个协作工具落地页',
          envType: 'webpage',
        }),
      });
      assert.equal(submit.status, 202, '提交应被接受');
      const { runId } = (await submit.json()) as { runId: string };

      const detail = await waitForStatus(ctx.origin, runId);
      assert.equal(detail.status, 'succeeded');

      // ── 1. 规划是**一次独立的生成层调用**，且带着用户目标 ──────────────
      const planCall = llm.calls[0];
      assert.ok(planCall !== undefined, '应当至少调用过一次生成层');
      const prompt = planCall.messages.map((m) => m.content).join('\n');
      assert.match(prompt, /你在做页面策划/, '第一次调用应当是统筹规划，而不是填块');
      assert.match(prompt, /协作工具落地页/, '规划提示词里必须带用户目标');
      assert.match(prompt, /可选块/, '规划要看着候选块来写建议');

      // ── 2. 计划与结构**并列**出现在运行详情里 ────────────────────────
      const blueprint = detail.blueprint as {
        ok: boolean;
        title: string;
        sections: { purpose: string; blockIds: string[] }[];
        status: string;
      };
      assert.equal(blueprint.ok, true);
      assert.equal(blueprint.title, '团队协作工具落地页');
      assert.equal(blueprint.sections.length, 3);
      assert.equal(blueprint.sections[0]!.purpose, '说清这是什么');
      assert.equal(blueprint.status, 'ok');

      assert.notEqual(detail.structure, null, '结构也应同时在，两者并列才有对照价值');

      // ── 3. 计划被写进计划的 rationale，且与实际块数做了对照 ──────────
      const events = ctx.store.get(runId)?.events ?? [];
      const assembled = events.find((e) => e.type === 'plan_assembled');
      assert.ok(assembled !== undefined && assembled.type === 'plan_assembled');
      if (assembled !== undefined && assembled.type === 'plan_assembled') {
        assert.ok(assembled.blueprint !== undefined, 'plan_assembled 事件也要带计划');
        const text = assembled.plan.rationale.join('\n');
        assert.match(text, /统筹规划/);
        assert.match(text, /计划 3 段，实际 \d+ 块/, '计划与实际结构要有一行对照');
      }
    } finally {
      await ctx.close();
    }
  });

  it('显式关掉时如实写"被关掉了"，而不是空着一栏', async () => {
    const llm = new MockLlmClient({ defaultText: PLAN_JSON });
    const ctx = await startServer({ structured: true, llm });

    try {
      const submit = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: '做一个落地页',
          envType: 'webpage',
          useBlueprint: false,
        }),
      });
      const { runId } = (await submit.json()) as { runId: string };
      const detail = await waitForStatus(ctx.origin, runId);
      assert.equal(detail.status, 'succeeded');

      const blueprint = detail.blueprint as { ok: boolean; detail?: string };
      assert.equal(blueprint.ok, false);
      assert.match(blueprint.detail ?? '', /关闭了统筹规划/);

      // 关掉规划 + 没开生成式填充 ⇒ 这条链路上一次生成层调用都不该发生。
      const planCalls = llm.calls.filter((call) =>
        call.messages.some((message) => message.content.includes('你在做页面策划')),
      );
      assert.equal(planCalls.length, 0, '关掉规划后不该再发规划请求');
    } finally {
      await ctx.close();
    }
  });

  it('规划模型不可用时，如实记录失败原因，页面照样做得出来', async () => {
    const llm = new MockLlmClient({
      defaultText: PLAN_JSON,
      rules: [{ match: '你在做页面策划', fail: '规划模型 503' }],
    });
    const ctx = await startServer({ structured: true, llm });

    try {
      const submit = await fetch(`${ctx.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: '做一个落地页', envType: 'webpage' }),
      });
      const { runId } = (await submit.json()) as { runId: string };
      const detail = await waitForStatus(ctx.origin, runId);

      // 规划失败不该让整次运行失败——生成层不可达不等于页面做不出来。
      assert.equal(detail.status, 'succeeded');

      const blueprint = detail.blueprint as { ok: boolean; detail?: string };
      assert.equal(blueprint.ok, false);
      assert.match(blueprint.detail ?? '', /规划模型调用失败/);
      assert.match(blueprint.detail ?? '', /503/);
    } finally {
      await ctx.close();
    }
  });
});
