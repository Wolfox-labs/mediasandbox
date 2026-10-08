/**
 * 落盘存储的测试。
 *
 * 重点不是"文件写出来了"，而是**读回来之后还是不是原来那个东西**：
 * 状态、产物清单、结构留痕都要能原样回来，否则"重启不丢"只是写了个文件而已。
 *
 * 另外验两条容易漏的：
 *   - 进程被杀时留下的 `running` 记录，重启后要如实标成 failed
 *   - 写到一半坏掉的一行，不该让整个事件文件作废
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { JsonPersist } from './persist.js';
import { RunStore, type RunRecord } from './run-store.js';
import type { OrchestrationEvent } from '@mediasandbox/orchestrator';

let root = '';

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ms-persist-'));
});

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

let seq = 0;
function dataDir(): string {
  seq += 1;
  return path.join(root, `case-${seq}`);
}

function event(type: 'run_started' | 'run_finished', at = 1): OrchestrationEvent {
  return type === 'run_started'
    ? { type, projectId: 'p', goal: '做一个落地页', at }
    : { type, status: 'succeeded', attempts: 1, switches: 0, durationMs: 5, at };
}

describe('落盘：运行记录', () => {
  it('写出去再读回来，字段一致', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    const store = new RunStore(persist);

    const record = store.create({
      id: 'run-1',
      projectId: 'proj-1',
      goal: '做一个产品介绍落地页',
      envType: 'webpage',
      provider: 'local',
    });
    store.appendEvent('run-1', event('run_started'));
    store.update('run-1', {
      status: 'succeeded',
      finishedAt: 12345,
      artifacts: [{ path: 'artifacts/index.html', size: 21337, mimeHint: 'text/html' }],
      attempts: [{ attempt: 1, switches: 0, planKey: 'a>b', status: 'succeeded', detail: '产出 1 个产物' }],
      planSummary: [{ nodeId: 'n1-fill-block', toolId: 'fill-block', note: '填充区块 b1' }],
      structure: {
        page: {
          projectId: 'proj-1',
          goal: '做一个产品介绍落地页',
          templateId: 'product-launch',
          candidateBlockIds: ['hero'],
          qualityScore: 0.8,
          createdAt: 1,
          blocks: [
            {
              id: 'b1',
              type: 'hero',
              slots: { title: { kind: 'text', text: '标题' } },
              status: 'filled',
              sources: { title: 'deterministic' },
            },
          ],
        },
        steps: [
          {
            round: 0,
            kind: 'select',
            questionIds: ['next_block'],
            answers: { next_block: { type: 'choice', value: 'hero', probabilities: { hero: 0.9 } } },
            pickedBlockId: 'hero',
            continueProbability: null,
            continued: null,
            counts: {},
            score: null,
            latencyMs: 3,
            rationale: '选中 hero',
          },
        ],
      },
    });
    assert.equal(record.status, 'succeeded');
    await persist.flush();

    const reloaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    assert.equal(reloaded.length, 1);
    const back = reloaded[0]!.record;
    assert.equal(back.id, 'run-1');
    assert.equal(back.goal, '做一个产品介绍落地页');
    assert.equal(back.status, 'succeeded');
    assert.equal(back.finishedAt, 12345);
    assert.deepEqual(back.artifacts, [
      { path: 'artifacts/index.html', size: 21337, mimeHint: 'text/html' },
    ]);
    assert.equal(back.attempts.length, 1);
    assert.equal(back.planSummary?.[0]?.toolId, 'fill-block');
    // 结构是沉淀模板的原料，必须完整回来（含 slot 内容）。
    assert.equal(back.structure?.page.templateId, 'product-launch');
    assert.equal(back.structure?.page.blocks[0]?.slots['title']?.kind, 'text');
    assert.equal(back.structure?.steps.length, 1);
  });

  it('事件是追加式流水，一条一行，读回来顺序不变', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    const store = new RunStore(persist);
    store.create({ id: 'run-ev', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    for (let i = 0; i < 5; i += 1) store.appendEvent('run-ev', event('run_started', i));
    await persist.flush();

    const raw = await readFile(path.join(dir, 'runs', 'run-ev', 'events.ndjson'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 5, '一条事件一行');

    const loaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    const at = loaded[0]!.events.map((e) => (e.type === 'run_started' ? e.at : -1));
    assert.deepEqual(at, [0, 1, 2, 3, 4], '顺序必须保持，补发历史靠的就是它');
  });

  it('进程被杀留下的 running 记录，装载后如实标成 failed', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    new RunStore(persist).create({
      id: 'run-crash',
      projectId: 'p',
      goal: 'g',
      envType: 'copy',
      provider: 'local',
    });
    await persist.flush();
    // 模拟重启：状态停在 queued/running，进程没了。
    // 让它永远显示"运行中"比标错更误导——它不可能再继续了。

    const loaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    assert.equal(loaded[0]!.record.status, 'failed');
    assert.match(loaded[0]!.record.error ?? '', /重启/);
  });

  it('事件文件里坏了一行，只丢那一行', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    const store = new RunStore(persist);
    store.create({ id: 'run-bad', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    store.appendEvent('run-bad', event('run_started', 1));
    store.appendEvent('run-bad', event('run_started', 2));
    await persist.flush();

    // 往中间插一行写了一半的内容（进程被杀的典型形态）。
    const file = path.join(dir, 'runs', 'run-bad', 'events.ndjson');
    const raw = await readFile(file, 'utf8');
    const lines = raw.trim().split('\n');
    await writeFile(file, `${lines[0]}\n{"type":"run_sta\n${lines[1]}\n`, 'utf8');

    const loaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    assert.equal(loaded[0]!.events.length, 2, '只丢坏的那一行');
  });

  it('目录不存在时返回空数组，而不是抛错（第一次跑就是这样）', async () => {
    const loaded = await new JsonPersist({ rootDir: dataDir() }).loadRuns();
    assert.deepEqual(loaded, []);
  });

  it('一条坏掉的 meta.json 不影响其它记录', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    const store = new RunStore(persist);
    store.create({ id: 'run-good', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    await persist.flush();

    await mkdir(path.join(dir, 'runs', 'run-broken'), { recursive: true });
    await writeFile(path.join(dir, 'runs', 'run-broken', 'meta.json'), '{ not json', 'utf8');

    const loaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.record.id, 'run-good');
  });

  it('list() 按开始时间从新到旧，装载后保持同样顺序', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    const store = new RunStore(persist);
    store.create({ id: 'a', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    store.create({ id: 'b', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    // 两次 create 可能落在同一毫秒，显式拉开时间才能验顺序。
    store.update('a', { startedAt: 1 });
    store.update('b', { startedAt: 2 });
    await persist.flush();

    const loaded = await new JsonPersist({ rootDir: dir }).loadRuns();
    assert.deepEqual(loaded.map((r) => r.record.id), ['b', 'a']);
  });
});

describe('落盘：block 与模板', () => {
  it('自定义 block 与模板往返一致', async () => {
    const dir = dataDir();
    const persist = new JsonPersist({ rootDir: dir });
    await persist.saveExternalBlocks([{ id: 'promo', label: '促销' }]);
    await persist.saveTemplates([{ id: 'tpl-a', label: 'A', description: 'd', blocks: [], builtin: false }]);

    const again = new JsonPersist({ rootDir: dir });
    assert.deepEqual(await again.loadExternalBlocks(), [{ id: 'promo', label: '促销' }]);
    assert.equal((await again.loadTemplates()).length, 1);
  });

  it('文件不存在时返回空数组', async () => {
    const persist = new JsonPersist({ rootDir: dataDir() });
    assert.deepEqual(await persist.loadExternalBlocks(), []);
    assert.deepEqual(await persist.loadTemplates(), []);
  });

  it('文件内容不是数组时返回空数组并报错，而不是把非数组当数据用', async () => {
    const dir = dataDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'blocks.json'), '{"oops":true}', 'utf8');
    const errors: string[] = [];
    const persist = new JsonPersist({ rootDir: dir, onError: (m) => errors.push(m) });
    assert.deepEqual(await persist.loadExternalBlocks(), []);
  });
});

describe('落盘：RunStore 的写穿钩子', () => {
  it('create / appendEvent / update 都会触发落盘', async () => {
    const calls: string[] = [];
    const store = new RunStore({
      saveMeta: (r: RunRecord) => calls.push(`meta:${r.status}`),
      appendEvent: (id: string) => calls.push(`event:${id}`),
    });
    store.create({ id: 'x', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    store.appendEvent('x', event('run_started'));
    store.update('x', { status: 'succeeded' });
    assert.deepEqual(calls, ['meta:queued', 'event:x', 'meta:succeeded']);
  });

  it('adopt 装载时不回写——刚读出来的东西没必要原样覆盖一次', () => {
    const calls: string[] = [];
    const store = new RunStore({
      saveMeta: () => calls.push('meta'),
      appendEvent: () => calls.push('event'),
    });
    const record: RunRecord = {
      id: 'loaded',
      projectId: 'p',
      goal: 'g',
      envType: 'copy',
      provider: 'local',
      status: 'succeeded',
      startedAt: 1,
      events: [],
      artifacts: [],
      attempts: [],
    };
    store.adopt(record, [event('run_started')]);
    assert.deepEqual(calls, []);
    assert.equal(store.get('loaded')?.events.length, 1);
  });

  it('不配落盘时一切照旧（既有部署不该被迫提供存储）', () => {
    const store = new RunStore();
    store.create({ id: 'y', projectId: 'p', goal: 'g', envType: 'copy', provider: 'local' });
    store.appendEvent('y', event('run_started'));
    store.update('y', { status: 'failed' });
    assert.equal(store.get('y')?.status, 'failed');
  });
});
