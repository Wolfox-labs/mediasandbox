/**
 * 决策层契约测试。RizzoFlowClient 与 StubDecisionClient 必须同样通过。
 *
 * 只依赖 DecisionClient 接口，不引用任何实现细节。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  askNoul,
  askNumeric,
  askScore,
  type DecisionClient,
  type DecisionContext,
} from '../decision/types.js';

export interface DecisionContractOptions {
  readonly client: DecisionClient;
  readonly name: string;
  /** 真实客户端需要网络与模型，容器/CI 里可以跳过耗时项。 */
  readonly isStub: boolean;
}

const CONTEXT: DecisionContext = {
  goal: '做一个产品介绍网页',
  envType: 'frontend',
  constraints: ['不使用付费服务'],
  facts: { 交付格式: '静态网页' },
  evidence: ['已确定视觉风格为极简'],
};

export function defineDecisionContract(options: DecisionContractOptions): void {
  const { client, name } = options;

  describe(`${name} · DecisionClient 契约`, () => {
    it('health() 返回结构化结果', async () => {
      const health = await client.health();
      assert.equal(typeof health.ok, 'boolean');
      assert.equal(typeof health.detail, 'string');
      assert.ok(health.detail.length > 0, '应给出可读的说明');
    });

    it('批量提交多个问题，键名原样保留', async () => {
      const result = await client.decide(CONTEXT, {
        q_a: { type: 'noul', instructions: '目标是否需要构建步骤？' },
        q_b: { type: 'score', instructions: '目标描述的清晰程度' },
      });
      assert.deepEqual(Object.keys(result.answers).sort(), ['q_a', 'q_b']);
      assert.equal(result.answers['q_a']?.type, 'noul');
      assert.equal(result.answers['q_b']?.type, 'score');
      assert.equal(result.meta.source, options.isStub ? 'stub' : 'systemone');
      assert.ok(result.meta.latencyMs >= 0);
      assert.equal(result.usage.outputTokens, 0, '决策层不生成 token');
    });

    it('空问题集被拒绝', async () => {
      await assert.rejects(
        () => client.decide(CONTEXT, {}),
        (error: unknown) => {
          assert.ok(error instanceof DecisionError);
          assert.equal(error.reason, 'BAD_REQUEST');
          return true;
        },
      );
    });

    it('候选集少于 2 项被拒绝', async () => {
      await assert.rejects(
        () =>
          client.decide(CONTEXT, {
            q: { type: 'choice', instructions: '选一个', criteria: { only: '唯一项' } },
          }),
        (error: unknown) => {
          assert.ok(error instanceof DecisionError);
          assert.equal(error.reason, 'BAD_REQUEST');
          return true;
        },
      );
    });

    it('候选集超过 26 项被拒绝', async () => {
      const criteria: Record<string, string> = {};
      for (let i = 0; i < 27; i += 1) criteria[`opt${i}`] = `选项 ${i}`;
      await assert.rejects(
        () =>
          client.decide(CONTEXT, {
            q: { type: 'choice', instructions: '选一个', criteria },
          }),
        (error: unknown) => {
          assert.ok(error instanceof DecisionError);
          assert.equal(error.reason, 'BAD_REQUEST');
          return true;
        },
      );
    });

    it('choice 返回的值必然落在候选集内', async () => {
      const result = await client.decide(CONTEXT, {
        q: {
          type: 'choice',
          instructions: '选一个技术栈',
          criteria: { 'vite-react': 'Vite + React', 'next-js': 'Next.js', astro: 'Astro' },
        },
      });
      const answer = result.answers['q'];
      assert.equal(answer?.type, 'choice');
      if (answer?.type !== 'choice') return;
      if (answer.value === null) return; // 弃权合法
      assert.ok(
        ['vite-react', 'next-js', 'astro'].includes(answer.value),
        `返回值 ${answer.value} 必须来自候选集`,
      );
    });

    it('noul 的概率落在 [0,1] 且 value 与概率一致', async () => {
      const answer = await askNoul(client, {
        context: CONTEXT,
        question: '目标是否需要网络请求？',
      });
      assert.equal(answer.type, 'noul');
      if (answer.yesProbability === null) {
        assert.equal(answer.value, null, '概率为空时值也应为空（弃权）');
        return;
      }
      assert.ok(answer.yesProbability >= 0 && answer.yesProbability <= 1);
      assert.equal(answer.value, answer.yesProbability >= 0.5);
    });

    it('score 的值落在 [0,1]', async () => {
      const answer = await askScore(client, {
        context: CONTEXT,
        subject: 'Vite + React',
        rubric: '按实现难度打分',
      });
      assert.equal(answer.type, 'score');
      if (answer.value === null) return;
      assert.ok(answer.value >= 0 && answer.value <= 1, `score=${answer.value} 越界`);
    });

    it('numeric 返回数字或弃权', async () => {
      const answer = await askNumeric(client, {
        context: CONTEXT,
        question: '预计需要几个页面？',
        min: 1,
        max: 20,
      });
      assert.equal(answer.type, 'numeric');
      if (answer.value === null) {
        assert.ok(answer.abstention !== undefined, '弃权时必须带 status');
        return;
      }
      assert.equal(typeof answer.value, 'number');
    });

    it('相同输入连续两次得到相同结果（确定性）', async () => {
      const questions = {
        q: {
          type: 'choice' as const,
          instructions: '选一个技术栈',
          criteria: { 'vite-react': 'Vite + React', 'next-js': 'Next.js' },
        },
      };
      const first = await client.decide(CONTEXT, questions);
      const second = await client.decide(CONTEXT, questions);
      assert.equal(
        JSON.stringify(first.answers['q']),
        JSON.stringify(second.answers['q']),
        '相同 state 与问题必须得到相同答案',
      );
    });
  });
}
