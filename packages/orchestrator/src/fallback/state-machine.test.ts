import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SandboxError } from '@mediasandbox/sandbox';
import { DecisionError } from '../decision/types.js';
import { PlanError } from '../plan/types.js';
import { ToolError } from '../tools/types.js';
import {
  classifyFailure,
  DEFAULT_POLICY,
  FallbackStateMachine,
  type FallbackPolicy,
} from './state-machine.js';

const FAST: FallbackPolicy = { ...DEFAULT_POLICY, backoffBaseMs: 0, backoffCapMs: 0 };

describe('失败归类', () => {
  it('计划错误不可重试', () => {
    const c = classifyFailure(new PlanError('有害的环', 'CYCLE'));
    assert.equal(c.kind, 'plan');
    assert.equal(c.retryable, false);
  });

  it('决策层不可达可重试', () => {
    const c = classifyFailure(new DecisionError('连不上', 'UNREACHABLE'));
    assert.equal(c.kind, 'decision_unavailable');
    assert.equal(c.retryable, true);
  });

  it('决策请求不合法不可重试（重试还是错）', () => {
    const c = classifyFailure(new DecisionError('参数错', 'BAD_REQUEST'));
    assert.equal(c.retryable, false);
  });

  it('工具执行失败可重试', () => {
    const c = classifyFailure(new ToolError('命令退出码 1', 'EXECUTION_FAILED', 'build-frontend'));
    assert.equal(c.kind, 'tool');
    assert.equal(c.retryable, true);
  });

  it('未知工具属于计划问题，不可重试', () => {
    const c = classifyFailure(new ToolError('没注册', 'UNKNOWN_TOOL', 'ghost'));
    assert.equal(c.kind, 'plan');
    assert.equal(c.retryable, false);
  });

  it('沙盒路径逃逸不可重试', () => {
    const c = classifyFailure(new SandboxError('越界', 'PATH_ESCAPE'));
    assert.equal(c.kind, 'tool');
    assert.equal(c.retryable, false);
  });

  /**
   * 回归：`DecisionError` 曾经继承 `SandboxError`，且 code 被写死成 `'UNSUPPORTED'`。
   *
   * 那样只有靠 `classifyFailure` 里两条 `instanceof` 的**书写顺序**才不出错——
   * 谁把 `SandboxError` 那条挪到前面，决策层不可用就会被误判成工具错误
   * （不可重试的 `BAD_REQUEST` 会被反复重试，或反之）。
   *
   * 现在 `DecisionError` 独立继承 `Error`，两条判断互不干扰。这个用例把该性质钉住：
   * 它**不依赖任何顺序假设**，直接断言类型关系本身。
   */
  it('DecisionError 不属于沙盒错误体系（避免靠 instanceof 顺序兜底）', () => {
    const error = new DecisionError('连不上', 'UNREACHABLE');
    assert.equal(
      error instanceof SandboxError,
      false,
      'DecisionError 不该是 SandboxError——否则归类正确性会依赖 instanceof 的书写顺序',
    );
    // 就算按"沙盒优先"的顺序判断，也必须仍然归成决策层问题。
    assert.equal(classifyFailure(error).kind, 'decision_unavailable');
  });

  it('未归类异常按瞬时故障处理且可重试', () => {
    const c = classifyFailure(new Error('谁知道呢'));
    assert.equal(c.kind, 'unknown');
    assert.equal(c.retryable, true);
  });

  it('非 Error 输入也能处理，不抛异常', () => {
    const c = classifyFailure('一个字符串');
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.detail.length > 0);
  });
});

describe('FallbackStateMachine', () => {
  it('瞬时故障按上限重试，然后转人工', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 0 });
    const error = new DecisionError('暂时连不上', 'UNREACHABLE');

    // maxRetries=3，所以第 1、2、3 次都是 retry
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const d = sm.onFailure(error, attempt);
      assert.equal(d.action, 'retry', `第 ${attempt} 次应为 retry`);
      assert.equal(d.state, 'retrying');
    }

    // 第 4 次超出上限，且不允许换方案 → 熔断
    const final = sm.onFailure(error, 4);
    assert.equal(final.action, 'escalate');
    assert.equal(final.state, 'circuit_open');
    assert.match(final.detail, /转人工/);
  });

  it('重试耗尽后换方案，而不是直接熔断', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 1 });
    const error = new ToolError('构建失败', 'EXECUTION_FAILED', 'build-frontend');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal(sm.onFailure(error, attempt).action, 'retry');
    }

    const switchDecision = sm.onFailure(error, 4);
    assert.equal(switchDecision.action, 'switch_plan');
    assert.equal(switchDecision.state, 'switching');
    assert.equal(sm.switchCount, 1);
  });

  it('换方案后重新计次，新方案也能重试', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 1 });
    const error = new ToolError('失败', 'EXECUTION_FAILED', 'x');

    for (let attempt = 1; attempt <= 3; attempt += 1) sm.onFailure(error, attempt);
    const sw = sm.onFailure(error, 4);
    assert.equal(sw.action, 'switch_plan');

    // 新方案第 1 次失败 → 又是 retry
    const afterSwitch = sm.onFailure(error, 1);
    assert.equal(afterSwitch.action, 'retry', '换方案后应重新获得重试额度');
  });

  it('换方案次数用尽后熔断', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 1 });
    const error = new ToolError('失败', 'EXECUTION_FAILED', 'x');

    for (let attempt = 1; attempt <= 3; attempt += 1) sm.onFailure(error, attempt);
    assert.equal(sm.onFailure(error, 4).action, 'switch_plan');

    for (let attempt = 1; attempt <= 3; attempt += 1) sm.onFailure(error, attempt);
    const final = sm.onFailure(error, 4);
    assert.equal(final.action, 'escalate');
    assert.equal(final.state, 'circuit_open');
  });

  it('不可重试的失败直接跳过重试阶段', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 1 });
    const error = new PlanError('存在环', 'CYCLE');

    // 第一次失败就应进入换方案，而不是 retry
    const d = sm.onFailure(error, 1);
    assert.equal(d.action, 'switch_plan');
  });

  it('计划错误且无方案可换时立刻熔断', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 0 });
    const d = sm.onFailure(new PlanError('存在环', 'CYCLE'), 1);
    assert.equal(d.action, 'escalate');
    assert.equal(d.state, 'circuit_open');
  });

  it('成功时状态归位', () => {
    const sm = new FallbackStateMachine(FAST);
    sm.onFailure(new DecisionError('x', 'UNREACHABLE'), 1);
    const d = sm.onSuccess();
    assert.equal(d.action, 'succeed');
    assert.equal(sm.currentState, 'done');
  });

  it('退避时间随尝试次数增长并有上限', () => {
    const sm = new FallbackStateMachine({
      maxRetries: 5,
      backoffBaseMs: 100,
      backoffCapMs: 250,
      maxSwitches: 0,
      onAbstain: 'continue',
    });
    const error = new DecisionError('x', 'UNREACHABLE');

    assert.equal(sm.onFailure(error, 1).delayMs, 100);
    assert.equal(sm.onFailure(error, 2).delayMs, 200);
    assert.equal(sm.onFailure(error, 3).delayMs, 250, '应被上限截住');
    assert.equal(sm.onFailure(error, 4).delayMs, 250);
  });

  it('弃权被归类为 abstained，且不可重试', () => {
    const c = classifyFailure(FallbackStateMachine.abstention('模型答不知道', 'primary_tool'));
    assert.equal(c.kind, 'abstained');
    assert.equal(c.retryable, false, '重试同一个问题只会得到同样答案');
  });

  it('弃权在 onAbstain=continue 时按确定性默认继续，不消耗重试额度', () => {
    const sm = new FallbackStateMachine({ ...FAST, onAbstain: 'continue' });
    const d = sm.onFailure(FallbackStateMachine.abstention('不知道', 'primary_tool'), 1);
    assert.equal(d.action, 'succeed', '应交给上层用确定性默认继续');
    assert.equal(d.kind, 'abstained');
    assert.equal(sm.attempts, 1, '不应计入重试');
  });

  it('弃权在 onAbstain=escalate 时直接转人工', () => {
    const sm = new FallbackStateMachine({ ...FAST, onAbstain: 'escalate' });
    const d = sm.onFailure(FallbackStateMachine.abstention('不知道', 'primary_tool'), 1);
    assert.equal(d.action, 'escalate');
    assert.equal(d.state, 'circuit_open');
    assert.match(d.detail, /弃权/);
  });

  it('弃权不会走换方案路径', () => {
    const sm = new FallbackStateMachine({ ...FAST, onAbstain: 'continue', maxSwitches: 5 });
    sm.onFailure(FallbackStateMachine.abstention('不知道', 'q'), 1);
    assert.equal(sm.switchCount, 0, '弃权不该触发换方案');
  });

  it('记录已试方案，供换方案时排除', () => {
    const sm = new FallbackStateMachine(FAST);
    sm.markTried('plan-a');
    sm.markTried('plan-b');
    sm.markTried('plan-a'); // 重复不应重复记录
    assert.deepEqual(sm.excludedPlans.sort(), ['plan-a', 'plan-b']);
  });

  it('熔断信息里带出已试方案，便于人工排查', () => {
    const sm = new FallbackStateMachine({ ...FAST, maxSwitches: 0 });
    sm.markTried('plan-a');
    const d = sm.onFailure(new PlanError('坏计划', 'CYCLE'), 1);
    assert.equal(d.action, 'escalate');
    assert.match(d.detail, /plan-a/);
  });

  it('默认策略符合约定：重试上限 3', () => {
    assert.equal(DEFAULT_POLICY.maxRetries, 3);
  });
});
