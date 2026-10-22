/**
 * 演示文稿组装器的端到端：**结构进去、计划出来**。
 *
 * 为什么需要它：此前 `deck-assembler` 一条用例都没有。版式池扩到 20 个之后，
 * 「决策层选得到、组装器接得住」这件事只靠肉眼看 demo 是证不了的——
 * 一旦新版式在候选集里被过滤掉，演示时才会发现某页静默空着。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assembleDeck } from './deck-assembler.js';
import { createDeckTools, DECK_TOOLS } from './deck-tools.js';
import { createSlideRegistry } from './deck-spec.js';
import { ToolRegistry } from '../tools/registry.js';
import { StubDecisionClient } from '../decision/stub-client.js';
import type { BlockInstance, PageSpec, SlotValue } from './page-spec.js';

function deckRegistry(): ToolRegistry { return new ToolRegistry().registerAll(createDeckTools(createSlideRegistry())); }

const text = (value: string): SlotValue => ({ kind: 'text', text: value });
const list = (items: string[]): SlotValue => ({ kind: 'list', items });

const block = (id: string, type: string, slots: Record<string, SlotValue>): BlockInstance => ({
  id,
  type: type as BlockInstance['type'],
  status: 'filled',
  sources: {},
  slots,
});

const pages: BlockInstance[] = [
  block('b1', 'data-table', {
    heading: text('四个环节各自断在哪'),
    columns: list(['环节', '缺口']),
    rows: list(['取景|现场不能标注', '文案|手机说不清']),
  }),
  block('b2', 'arch-diagram', {
    heading: text('两条通道分离'),
    nodes: list(['客户端|Compose', 'Agent|会话编排', '适配层|协议契约']),
    links: list(['WebSocket|指令与事件', 'HTTP|文件与载荷']),
    band: text('宿主环境：电脑或手机'),
  }),
  block('b3', 'node-graph', {
    heading: text('手机经中转接入宿主'),
    left: list(['手机端 A|同城', '手机端 B|异地']),
    hub: text('Relay|按会话转发'),
    right: list(['电脑 Agent|宿主执行']),
  }),
  block('b4', 'roadmap', { heading: text('三段推进'), stages: list(['近期|体验完善|A；B', '中期|场景深化|C；D']) }),
  block('b5', 'composite', { heading: text('四类接入'), cards: list(['Codex|原生线程', 'DSH|实时宿主']), steps: list(['发现|扫描', '验证|跑一轮']) }),
  block('b6', 'phone-row', { heading: text('三个界面'), items: list(['文件|产物', '编辑|保存', '终端|命令']) }),
];

const spec: PageSpec = {
  projectId: 'deck-e2e',
  goal: '跨设备协同路演稿',
  templateId: null,
  candidateBlockIds: pages.map((page) => page.type),
  blocks: pages,
  qualityScore: 0,
  createdAt: 0,
};

function request(extra: Record<string, unknown> = {}) {
  return {
    context: { goal: '跨设备协同路演稿', envType: 'slides' as const },
    envType: 'slides' as const,
    goal: '跨设备协同路演稿',
    projectId: 'deck-e2e',
    pageSpec: spec,
    ...extra,
  };
}

describe('演示文稿组装器：给定结构（含全部新版式）', () => {
  it('每页一个 fill-slide，末尾是 assemble-deck 与校验', async () => {
    const result = await assembleDeck({
      registry: deckRegistry(),
      decision: new StubDecisionClient(),
      request: request(),
    });
    const ids = result.plan.nodes.map((node) => node.toolId);
    assert.equal(ids.filter((id) => id === DECK_TOOLS.fillSlide).length, pages.length);
    assert.ok(ids.includes(DECK_TOOLS.assembleDeck), '计划里必须有 assemble-deck');
    assert.ok(
      ids.lastIndexOf(DECK_TOOLS.assembleDeck) > ids.lastIndexOf(DECK_TOOLS.fillSlide),
      'assemble-deck 必须排在所有 fill-slide 之后',
    );
  });

  it('结构原样带进计划：新版式没有被吞掉', async () => {
    const result = await assembleDeck({
      registry: deckRegistry(),
      decision: new StubDecisionClient(),
      request: request(),
    });
    assert.ok(result.structure !== undefined, '应回填结构');
    assert.deepEqual(
      result.structure.page.blocks.map((page) => page.type),
      pages.map((page) => page.type),
    );
    const skeleton = JSON.stringify(result.plan.nodes.map((node) => node.inputs));
    for (const type of ['data-table', 'arch-diagram', 'node-graph', 'roadmap', 'composite', 'phone-row']) {
      assert.ok(skeleton.includes(type), '版式 ' + type + ' 没进到计划输入里');
    }
  });
});