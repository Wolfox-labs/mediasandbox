import type { RunRecord } from './run-store.js';

/**
 * 运行队列：给定"同时最多跑几个"，把超出的运行**排起来**，而不是一起压上去。
 *
 * ## 为什么要有它
 *
 * 此前每收到一个 `POST /api/runs` 就直接起一次运行。演示时点几下没问题，
 * 批量提交会把 CPU、内存、容器数一起推上去（Docker 下每个运行一个容器），
 * 而系统没有任何地方能回答"同时最多跑几个"。
 *
 * ## 三条约定
 *
 * 1. **放行是自动的**：前一个跑完，队列头的运行自己开始，不需要重新提交。
 *    要人重提交的排队不叫排队，叫拒绝。
 * 2. **队列有界，满了明确拒绝**：调用方拿到 429 与原因，好过默默堆积——
 *    堆积的尽头是 OOM，而那时已经看不出是谁压垮的。
 * 3. **重启不恢复**：队列只在内存里。服务重启后那些没开始的运行**不会**自己复活，
 *    由 `persist.ts` 如实标成"已取消（服务重启）"。宁愿让人重新提交，
 *    也不做"幽灵运行"——一个没人盯着、状态还写着排队中的运行，比失败更难查。
 *
 * 刻意只认一个 `start(job)` 回调而不是认识运行记录：队列的职责是**并发与顺序**，
 * 跑什么、怎么跑是调用方的事。这样它可以被单独测，不必造一整套服务。
 */

export interface QueueOptions {
  /** 同时可运行的次数上限。小于 1 会被夹到 1（0 并发等于永远不跑）。 */
  readonly maxConcurrent: number;
  /** 等待队列长度上限。0 表示不排队：超出并发就直接拒。 */
  readonly limit: number;
}

export interface QueueSnapshot {
  readonly running: number;
  readonly waiting: number;
  readonly maxConcurrent: number;
  readonly limit: number;
}

/** 入队结果。`accepted: false` 只由"队列满"产生，调用方据此回 429。 */
export type EnqueueResult =
  | { readonly accepted: true; readonly position: number; readonly started: boolean }
  | { readonly accepted: false; readonly reason: string; readonly snapshot: QueueSnapshot };

/**
 * 队列里的一个运行。
 *
 * `controller` **在入队时就建好**，不是在真正开跑时：排队中的运行也要能被取消。
 * 等到开跑才建 controller 的话，"取消一个还在排队的运行"就无从下手——
 * 而用户点了取消却什么都没发生，比不给取消按钮更糟。
 */
export interface QueuedRun {
  readonly record: RunRecord;
  /**
   * 真正开跑。返回的 Promise 结算即"这一次跑完了"。
   *
   * 不需要传 signal：取消开关就是下面这个 `controller`，队列只需要负责在名额
   * 空出来时调用它——**排队与在跑用的是同一个开关**，取消行为因此一致。
   */
  readonly execute: () => Promise<void>;
  readonly controller: AbortController;
}

export class RunQueue<T> {
  private readonly waiting: T[] = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly limit: number;

  /**
   * @param start 真正开始跑一个任务。返回的 Promise 结算即"这一次跑完了"，
   *   队列随即放行下一个。**它抛错也必须结算**，否则一个失败的任务会永久占住名额。
   */
  constructor(
    private readonly start: (job: T) => Promise<void>,
    options: QueueOptions,
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
    this.limit = Math.max(0, Math.floor(options.limit));
  }

  /**
   * 入队。有余额就立刻开始，否则排队；队列满则拒绝。
   *
   * `position` 是**1 起的排队位次**：立刻开始的算第 1 位（它不用等）。
   */
  enqueue(job: T): EnqueueResult {
    if (this.running < this.maxConcurrent) {
      this.pump(job);
      return { accepted: true, position: 1, started: true };
    }
    if (this.waiting.length >= this.limit) {
      return {
        accepted: false,
        reason: `队列已满：同时最多 ${this.maxConcurrent} 个运行，最多再排 ${this.limit} 个`,
        snapshot: this.snapshot(),
      };
    }
    this.waiting.push(job);
    return { accepted: true, position: this.waiting.length, started: false };
  }

  /**
   * 队列位次（1 起）。不在队列里返回 `undefined`——**不在队列**与**排在第 1 位**
   * 是两件事，用 0 表示"不在"迟早会被当成"第一个"。
   */
  positionOf(job: T): number | undefined {
    const index = this.waiting.indexOf(job);
    return index === -1 ? undefined : index + 1;
  }

  /**
   * 把一个还在排队的任务摘出来（用户取消了它）。
   *
   * 返回是否真的摘掉了：已经在跑的返回 false，那种情况该走 `AbortController`。
   */
  withdraw(job: T): boolean {
    const index = this.waiting.indexOf(job);
    if (index === -1) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  snapshot(): QueueSnapshot {
    return {
      running: this.running,
      waiting: this.waiting.length,
      maxConcurrent: this.maxConcurrent,
      limit: this.limit,
    };
  }

  private pump(job: T): void {
    this.running += 1;
    void this.start(job)
      // 失败也要把名额还回去，否则一次崩溃就永久少一个并发位。
      .catch(() => undefined)
      .finally(() => {
        this.running -= 1;
        const next = this.waiting.shift();
        if (next !== undefined) this.pump(next);
      });
  }
}
