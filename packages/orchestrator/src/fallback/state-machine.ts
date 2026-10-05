/**
 * 失败兜底状态机。
 *
 * **刻意不用概率模型。** 兜底逻辑本身若依赖模型，就会在失败时二次失败——
 * 而它存在的意义正是在事情已经出错时可靠地做决定。因此这里只有确定性规则。
 *
 * 状态迁移（用户约定的策略）：
 *
 *   running ──失败──→ retrying ──重试≤3次──→ 成功 → done
 *                        │
 *                        └──重试耗尽──→ switching ──换方案──→ 成功 → done
 *                                          │
 *                                          └──无方案可换──→ circuit_open（转人工）
 *
 * 弃权（模型答"不知道"）**不是失败**，走单独的 treatAs 分支：
 * 可以配置成"按确定性默认继续"或"直接转人工"。
 */
import { SandboxError } from '@mediasandbox/sandbox';
import { DecisionError } from '../decision/types.js';
import { PlanError } from '../plan/types.js';
import { ToolError } from '../tools/types.js';

/** 兜底状态机的状态。 */
export type FallbackState =
  /** 首次执行中。 */
  | 'running'
  /** 正在重试同一方案。 */
  | 'retrying'
  /** 同方案重试耗尽，准备换方案。 */
  | 'switching'
  /** 已成功。 */
  | 'done'
  /** 熔断，转人工。 */
  | 'circuit_open';

/**
 * 决策层弃权。
 *
 * 单独一个类型而不是普通 Error：弃权**不是失败**，它需要走与失败不同的分支
 * （按确定性默认继续，或按策略转人工）。若混进普通异常，就会被当作故障重试，
 * 那是错的——模型明确说了"不知道"，重试同一个问题只会得到同样的答案。
 */
export class AbstentionError extends Error {
  override readonly name = 'AbstentionError';
  constructor(
    message: string,
    /** 哪个问题被弃权了。 */
    readonly questionId: string,
  ) {
    super(message);
  }
}

/** 失败分类。不同类别走不同兜底路径。 */
export type FailureKind =
  /** 可重试的瞬时故障：网络抖动、服务限流、超时。 */
  | 'transient'
  /** 工具自身的问题：命令非零退出、产物校验失败。 */
  | 'tool'
  /** 计划本身有问题：环、缺依赖、端口不匹配。换方案也无法修复。 */
  | 'plan'
  /** 决策层不可用。 */
  | 'decision_unavailable'
  /** 决策层说"不知道"。**这不是失败**。 */
  | 'abstained'
  /** 无法归类。 */
  | 'unknown';

export interface FailureClassification {
  readonly kind: FailureKind;
  /** 人可读的说明，进日志与前端。 */
  readonly detail: string;
  /** 该类别是否值得重试。 */
  readonly retryable: boolean;
}

/**
 * 把异常归类。
 *
 * 归类决定兜底走向，所以这里必须保守：**不确定的一律当作不可重试**，
 * 让上层走"换方案"或"熔断"，而不是把时间浪费在无望的重试上。
 */
export function classifyFailure(error: unknown): FailureClassification {
  // 弃权优先判定：它不是失败，必须与故障区分开。
  if (error instanceof AbstentionError) {
    return {
      kind: 'abstained',
      detail: error.message,
      retryable: false,
    };
  }

  if (error instanceof PlanError) {
    // 计划结构性问题。重试与换方案都改不了，必须熔断。
    return {
      kind: 'plan',
      detail: `计划错误（${error.code}）：${error.message}`,
      retryable: false,
    };
  }

  if (error instanceof DecisionError) {
    switch (error.reason) {
      case 'UNREACHABLE':
      case 'TIMEOUT':
        return {
          kind: 'decision_unavailable',
          detail: `决策层不可用（${error.reason}）：${error.message}`,
          retryable: true,
        };
      case 'INVALID_PROBABILITIES':
      case 'BAD_RESPONSE':
        // 服务在响应但响应不对，重试可能碰到不同的采样结果。
        return {
          kind: 'decision_unavailable',
          detail: `决策层响应异常（${error.reason}）：${error.message}`,
          retryable: true,
        };
      case 'BAD_REQUEST':
        // 请求本身拼错了，重试一模一样还是错。
        return {
          kind: 'decision_unavailable',
          detail: `决策请求不合法（${error.reason}）：${error.message}`,
          retryable: false,
        };
    }
  }

  if (error instanceof ToolError) {
    switch (error.code) {
      case 'ENV_NOT_SUPPORTED':
        // 环境不匹配：换方案可能选到合适的工具。
        return { kind: 'tool', detail: error.message, retryable: false };
      case 'EXECUTION_FAILED':
        return { kind: 'tool', detail: error.message, retryable: true };
      case 'UNKNOWN_TOOL':
      case 'BAD_SPEC':
      case 'DUPLICATE_TOOL':
        // 注册表的问题，运行时自愈不了。
        return { kind: 'plan', detail: error.message, retryable: false };
    }
  }

  if (error instanceof SandboxError) {
    switch (error.code) {
      case 'PATH_ESCAPE':
      case 'NO_SUCH_FILE':
        // 路径类错误：换方案可能绕开。
        return { kind: 'tool', detail: error.message, retryable: false };
      case 'NO_SUCH_SANDBOX':
        return { kind: 'tool', detail: error.message, retryable: false };
      case 'UNSUPPORTED':
      case 'CREATE_FAILED':
        return { kind: 'tool', detail: error.message, retryable: true };
    }
  }

  // 未归类的：按瞬时故障处理一次，但只给一次机会。
  return {
    kind: 'unknown',
    detail: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export interface FallbackPolicy {
  /** 同方案重试上限。用户约定为 3。 */
  readonly maxRetries: number;
  /**
   * 重试之间的退避毫秒。按尝试次数线性增长，并有上限。
   * 设为 0 可关闭等待（测试用）。
   */
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** 最多换几次方案。 */
  readonly maxSwitches: number;
  /**
   * 决策层弃权时怎么办：
   *   'continue'  按确定性默认继续（推荐，弃权是合法输入）
   *   'escalate'  直接转人工
   */
  readonly onAbstain: 'continue' | 'escalate';
}

export const DEFAULT_POLICY: FallbackPolicy = {
  maxRetries: 3,
  backoffBaseMs: 200,
  backoffCapMs: 2_000,
  maxSwitches: 1,
  onAbstain: 'continue',
};

export interface FallbackDecision {
  readonly action: 'retry' | 'switch_plan' | 'succeed' | 'escalate';
  readonly state: FallbackState;
  readonly kind: FailureKind;
  readonly detail: string;
  /** 下一次尝试前等待的毫秒。 */
  readonly delayMs: number;
  /** 本次尝试的序号（从 1 开始）。 */
  readonly attempt: number;
  /** 已换方案次数。 */
  readonly switches: number;
}

/**
 * 兜底状态机。
 *
 * 用法：每次执行失败后调 `onFailure`，按返回的 action 决定下一步；
 * 成功时调 `onSuccess` 让状态归位。
 */
export class FallbackStateMachine {
  private state: FallbackState = 'running';
  private attempt = 0;
  private switches = 0;
  /** 已试过的方案标识，用于"换方案"时不重复选。 */
  private readonly triedPlans = new Set<string>();

  constructor(private readonly policy: FallbackPolicy = DEFAULT_POLICY) {}

  get currentState(): FallbackState {
    return this.state;
  }

  get attempts(): number {
    return this.attempt;
  }

  get switchCount(): number {
    return this.switches;
  }

  /** 已试过、应当排除的方案。换方案时传给决策层做 exclude。 */
  get excludedPlans(): string[] {
    return [...this.triedPlans];
  }

  /** 记录一个已尝试的方案。 */
  markTried(planKey: string): void {
    this.triedPlans.add(planKey);
  }

  onSuccess(): FallbackDecision {
    this.state = 'done';
    return {
      action: 'succeed',
      state: this.state,
      kind: 'unknown',
      detail: '执行成功',
      delayMs: 0,
      attempt: this.attempt,
      switches: this.switches,
    };
  }

  /**
   * 处理一次失败。
   *
   * 注意入参是"本次失败的尝试编号"，从 1 开始。第一次失败传 1。
   */
  onFailure(error: unknown, attempt = this.attempt + 1): FallbackDecision {
    this.attempt = attempt;
    const classified = classifyFailure(error);

    // 弃权单独处理：它不是错误。
    if (classified.kind === 'abstained') {
      if (this.policy.onAbstain === 'escalate') {
        this.state = 'circuit_open';
        return {
          action: 'escalate',
          state: this.state,
          kind: classified.kind,
          detail: `决策层弃权，按策略转人工：${classified.detail}`,
          delayMs: 0,
          attempt,
          switches: this.switches,
        };
      }
      // 'continue'：交给上层用确定性默认继续，状态机不拦。
      this.state = 'running';
      return {
        action: 'succeed',
        state: this.state,
        kind: classified.kind,
        detail: `决策层弃权，按确定性默认继续：${classified.detail}`,
        delayMs: 0,
        attempt,
        switches: this.switches,
      };
    }

    // 不可重试的类别：直接跳过重试阶段，进入换方案或熔断。
    if (classified.retryable && attempt <= this.policy.maxRetries) {
      this.state = 'retrying';
      const delayMs = Math.min(
        this.policy.backoffBaseMs * attempt,
        this.policy.backoffCapMs,
      );
      return {
        action: 'retry',
        state: this.state,
        kind: classified.kind,
        detail: `${classified.detail}（第 ${attempt}/${this.policy.maxRetries} 次尝试）`,
        delayMs,
        attempt,
        switches: this.switches,
      };
    }

    // 重试不可用或已耗尽 → 换方案
    if (this.switches < this.policy.maxSwitches) {
      this.switches += 1;
      this.attempt = 0; // 新方案重新计次
      this.state = 'switching';
      return {
        action: 'switch_plan',
        state: this.state,
        kind: classified.kind,
        detail: `${classified.detail}（第 ${this.switches}/${this.policy.maxSwitches} 次换方案）`,
        delayMs: 0,
        attempt: this.switches,
        switches: this.switches,
      };
    }

    // 无路可走 → 熔断转人工
    this.state = 'circuit_open';
    return {
      action: 'escalate',
      state: this.state,
      kind: classified.kind,
      detail:
        `${classified.detail}；已重试至上限且无更多方案，转人工处理。` +
        `已试方案: ${[...this.triedPlans].join(', ') || '(无)'}`,
      delayMs: 0,
      attempt,
      switches: this.switches,
    };
  }

  /** 构造弃权错误，供上层在决策层返回 null 时使用。 */
  static abstention(detail: string, questionId = '(unknown)'): AbstentionError {
    return new AbstentionError(detail, questionId);
  }
}

/** 等待退避时间。 */
export async function waitBackoff(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
