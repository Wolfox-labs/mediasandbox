/**
 * 队列用例。
 *
 * 锁的是四条验收：**超限排队、跑完自动放行、队列满明确拒绝、失败也要还名额**。
 * 最后一条最容易漏：跑挂的任务若不还名额，一次崩溃就永久少一个并发位，
 * 而症状是"越跑越慢"，很难归到队列头上。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunQueue } from './run-queue.js';

/** 手动控制每个任务何时结束，才能观察到"排队"这一刻的状态。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 让已排队的微任务跑一轮。 */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('RunQueue', () => {
  it('并发有余量时立刻开始，位次算第 1 位', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const queue = new RunQueue<string>(
      async (job) => {
        started.push(job);
        const gate = deferred();
        gates.set(job, gate);
        await gate.promise;
      },
      { maxConcurrent: 2, limit: 16 },
    );

    const result = queue.enqueue('a');
    assert.equal(result.accepted, true);
    assert.deepEqual(
      result.accepted ? { position: result.position, started: result.started } : null,
      { position: 1, started: true },
    );
    await tick();
    assert.deepEqual(started, ['a']);
    gates.get('a')?.resolve();
  });

  it('超过并发就排队；前一个跑完自动放行，不需要重新提交', async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const queue = new RunQueue<string>(
      async (job) => {
        started.push(job);
        const gate = deferred();
        gates.set(job, gate);
        await gate.promise;
      },
      { maxConcurrent: 1, limit: 16 },
    );

    queue.enqueue('a');
    await tick();
    const second = queue.enqueue('b');
    assert.equal(second.accepted, true);
    assert.equal(second.accepted ? second.started : true, false, 'b 应当排队而不是开始');
    assert.equal(second.accepted ? second.position : 0, 1);
    assert.deepEqual(started, ['a'], 'b 不该在 a 结束前开始');

    // a 结束 → b 自动开始
    gates.get('a')?.resolve();
    await tick();
    await tick();
    assert.deepEqual(started, ['a', 'b'], 'b 应当在 a 结束后自动开始');
    gates.get('b')?.resolve();
  });

  it('队列满时明确拒绝，并说明上限', async () => {
    const queue = new RunQueue<string>(async () => new Promise<void>(() => undefined), {
      maxConcurrent: 1,
      limit: 2,
    });
    queue.enqueue('a'); // 立刻开始
    queue.enqueue('b'); // 排队 1
    queue.enqueue('c'); // 排队 2（满）
    const rejected = queue.enqueue('d');
    assert.equal(rejected.accepted, false);
    assert.match(rejected.accepted === false ? rejected.reason : '', /队列已满/);
    assert.match(rejected.accepted === false ? rejected.reason : '', /同时最多 1 个/);
    assert.equal(rejected.accepted === false ? rejected.snapshot.waiting : -1, 2);
  });

  it('limit=0 表示不排队：超出并发直接拒', () => {
    const queue = new RunQueue<string>(async () => new Promise<void>(() => undefined), {
      maxConcurrent: 1,
      limit: 0,
    });
    assert.equal(queue.enqueue('a').accepted, true);
    assert.equal(queue.enqueue('b').accepted, false);
  });

  it('任务抛错也要把名额还回去', async () => {
    const started: string[] = [];
    const queue = new RunQueue<string>(
      async (job) => {
        started.push(job);
        if (job === 'boom') throw new Error('故意失败');
      },
      { maxConcurrent: 1, limit: 4 },
    );
    queue.enqueue('boom');
    await tick();
    await tick();
    // 名额若没还回来，b 会一直排队。
    const second = queue.enqueue('b');
    assert.equal(second.accepted ? second.started : false, true, '名额没还回来');
    await tick();
    assert.deepEqual(started, ['boom', 'b']);
  });

  it('位次是 1 起的排队序号；不在队列里的返回 undefined', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const queue = new RunQueue<string>(
      async (job) => {
        const gate = deferred();
        gates.set(job, gate);
        await gate.promise;
      },
      { maxConcurrent: 1, limit: 4 },
    );
    queue.enqueue('a'); // 在跑
    queue.enqueue('b');
    queue.enqueue('c');
    await tick();
    assert.equal(queue.positionOf('b'), 1);
    assert.equal(queue.positionOf('c'), 2);
    assert.equal(queue.positionOf('a'), undefined, '在跑的不在队列里');
    assert.equal(queue.positionOf('nope'), undefined);
    gates.get('a')?.resolve();
  });

  it('能把还在排队的任务摘出来；在跑的摘不掉', async () => {
    const started: string[] = [];
    const gate = deferred();
    const queue = new RunQueue<string>(
      async (job) => {
        started.push(job);
        if (job === 'a') await gate.promise;
      },
      { maxConcurrent: 1, limit: 4 },
    );
    queue.enqueue('a');
    queue.enqueue('b');
    await tick();
    assert.equal(queue.withdraw('a'), false, '在跑的应当走 AbortController，不是摘队列');
    assert.equal(queue.withdraw('b'), true);
    assert.equal(queue.positionOf('b'), undefined);
    gate.resolve();
    await tick();
    await tick();
    assert.deepEqual(started, ['a'], '被摘掉的 b 不该开始');
  });

  it('maxConcurrent<1 夹到 1，不会退化成"永远不跑"', () => {
    const queue = new RunQueue<string>(async () => undefined, { maxConcurrent: 0, limit: 1 });
    assert.equal(queue.snapshot().maxConcurrent, 1);
    assert.equal(queue.enqueue('a').accepted, true);
  });
});
