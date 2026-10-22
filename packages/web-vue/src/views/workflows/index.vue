/**
 * 工作流画布。
 *
 * 三块：左边是工作流列表，中间是图，右边是检查器。
 *
 * ## 为什么不引第三方流程图库
 *
 * 需要的只有"拖、连、缩放"，而任何图库都会带来自己的状态模型与依赖；
 * 这个项目的依赖已经被 pnpm 的递归命令坑过一次。这里用绝对定位的节点
 * + 一个 SVG 边层，两百多行就够，而且**节点位置、连线、状态全在同一份数据里**，
 * 与后端的工作流定义一一对应。
 *
 * ## 状态从哪来
 *
 * 定义来自 `GET /api/workflows/:id`；运行状态来自轮询 `GET /api/runs/:id`
 * 的 `nodeStates`（服务端从事件流折出来的）。所以刷新页面、换个人打开，
 * 看到的是同一个状态，而不是"只有点过运行的那台机器知道"。
 */
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { WorkflowDef, WorkflowInput, WorkflowNodeDef } from './types';
import { layoutNodes, type Point } from './layout';

interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly envType: string;
  readonly builtin?: boolean;
  readonly nodeCount?: number;
  readonly params?: readonly { name: string; required: boolean; description: string }[];
}

interface NodeState {
  status: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  cached?: boolean;
}

const NODE_W = 216;
const NODE_H = 78;

const workflows = ref<WorkflowSummary[]>([]);
const selectedId = ref('poster');
const def = ref<WorkflowDef | null>(null);
const goal = ref('校园二手市集');
const templateId = ref('promo-page');
const builtin = ref(true);
const loading = ref(false);
const error = ref('');

const positions = reactive<Record<string, Point>>({});
const selectedNodeId = ref('');
const view = reactive({ scale: 1, x: 0, y: 0 });
const run = ref<{ id: string; status: string; startedAt?: number } | null>(null);
const nodeStates = ref<Record<string, NodeState>>({});
const recentRuns = ref<{ id: string; status: string; goal: string; artifactCount: number }[]>([]);
const dirty = ref(false);
const busy = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

const nodes = computed<readonly WorkflowNodeDef[]>(() => def.value?.nodes ?? []);

const edges = computed(() => {
  const list: { id: string; from: string; to: string; path: string }[] = [];
  for (const node of nodes.value) {
    for (const input of Object.values(node.inputs ?? {})) {
      const sources = 'from' in input ? (Array.isArray(input.from) ? input.from : [input]) : [];
      for (const source of sources as { from?: string; nodeId?: string; port: string }[]) {
        const from = source.nodeId ?? source.from;
        if (from === undefined) continue;
        const a = positions[from];
        const b = positions[node.id];
        if (a === undefined || b === undefined) continue;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        list.push({
          id: `${from}-${node.id}-${source.port}`,
          from,
          to: node.id,
          path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        });
      }
    }
  }
  return list;
});

const selectedNode = computed(() =>
  nodes.value.find((node) => node.id === selectedNodeId.value),
);

const statusOf = (id: string): NodeState | undefined => nodeStates.value[id];

const statusLabel = (state: NodeState | undefined): string => {
  if (state === undefined) return '';
  if (state.cached === true) return '缓存命中';
  return { running: '运行中', succeeded: '完成', failed: '失败', skipped: '跳过', pending: '等待' }[state.status] ?? state.status;
};

async function loadWorkflows(): Promise<void> {
  try {
    const response = await fetch('/api/workflows');
    const body = (await response.json()) as { workflows?: WorkflowSummary[] };
    workflows.value = body.workflows ?? [];
    if (!workflows.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = workflows.value[0]?.id ?? '';
    }
  } catch (error_) {
    error.value = `读取工作流列表失败：${String(error_)}`;
  }
}

async function loadDef(): Promise<void> {
  if (selectedId.value === '') return;
  loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams();
    if (selectedId.value === 'poster' || selectedId.value === 'page') {
      query.set('goal', goal.value);
      if (selectedId.value === 'page') query.set('templateId', templateId.value);
    }
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    const response = await fetch(`/api/workflows/${encodeURIComponent(selectedId.value)}${suffix}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { workflow: WorkflowDef & { builtin?: boolean; dynamic?: boolean } };
    def.value = body.workflow;
    builtin.value = body.workflow.builtin === true;
    // 首次进入：后端给的位置是"建议值"，缺的按拓扑自动排。
    const layout = layoutNodes(body.workflow.nodes);
    positionsCache.clear();
    for (const [id, point] of Object.entries(layout)) {
      positions[id] = body.workflow.nodes.find((node) => node.id === id)?.position ?? point;
    }
    selectedNodeId.value = body.workflow.nodes[0]?.id ?? '';
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    nodeStates.value = {};
    dirty.value = false;
  } catch (error_) {
    error.value = `读取工作流失败：${String(error_)}`;
  } finally {
    loading.value = false;
  }
}

const positionsCache = new Map<string, Point>();

async function selectWorkflow(id: string): Promise<void> {
  selectedId.value = id;
  await loadDef();
}

async function startRun(forceNodes?: readonly string[]): Promise<void> {
  if (def.value === null || busy.value) return;
  busy.value = true;
  error.value = '';
  nodeStates.value = {};
  try {
    const body: Record<string, unknown> = {};
    if (selectedId.value === 'poster' || selectedId.value === 'page') body.goal = goal.value;
    if (selectedId.value === 'page') body.templateId = templateId.value;
    if (forceNodes !== undefined && forceNodes.length > 0) body.forceNodes = [...forceNodes];
    const response = await fetch(`/api/workflows/${encodeURIComponent(selectedId.value)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { runId?: string; error?: string; detail?: string };
    if (!response.ok || payload.runId === undefined) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    run.value = { id: payload.runId, status: 'queued' };
    watchRun(payload.runId);
  } catch (error_) {
    error.value = `启动失败：${String(error_)}`;
    busy.value = false;
  }
}

function watchRun(runId: string): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
      if (!response.ok) return;
      const body = (await response.json()) as {
        status?: string;
        nodeStates?: Record<string, NodeState>;
        error?: string;
      };
      nodeStates.value = body.nodeStates ?? {};
      if (run.value !== null) run.value.status = body.status ?? run.value.status;
      if (body.status !== undefined && body.status !== 'queued' && body.status !== 'running') {
        if (pollTimer !== undefined) clearInterval(pollTimer);
        pollTimer = undefined;
        busy.value = false;
        if (body.status !== 'succeeded') error.value = body.error ?? `运行结束：${body.status}`;
        void loadRecentRuns();
      }
    } catch {
      /* 轮询失败不致命：下一次继续 */
    }
  }, 800);
}

async function save(): Promise<void> {
  if (def.value === null || builtin.value) return;
  const payload = {
    name: def.value.name,
    description: def.value.description ?? '',
    envType: def.value.envType,
    nodes: def.value.nodes.map((node) => ({ ...node, position: positions[node.id] })),
  };
  const response = await fetch(`/api/workflows/${encodeURIComponent(def.value.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.ok) {
    dirty.value = false;
    await loadWorkflows();
  } else {
    const body = (await response.json()) as { error?: string };
    error.value = body.error ?? `保存失败：HTTP ${response.status}`;
  }
}

function updateLiteral(nodeId: string, port: string, value: string, kind: 'string' | 'number' | 'boolean'): void {
  const node = def.value?.nodes.find((item) => item.id === nodeId);
  const inputs = node?.inputs as Record<string, WorkflowInput> | undefined;
  if (inputs === undefined) return;
  const input = inputs[port];
  if (input === undefined || !('value' in input)) return;
  const next = kind === 'number' ? Number(value) : kind === 'boolean' ? value === 'true' : value;
  inputs[port] = { value: next };
  dirty.value = true;
}

// ── 画布交互 ──────────────────────────────────────────────────────────
const canvas = ref<HTMLElement | null>(null);
let drag: { kind: 'pan' | 'node'; id?: string; startX: number; startY: number; originX: number; originY: number } | null = null;

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const rect = canvas.value?.getBoundingClientRect();
  if (rect === undefined) return;
  const factor = event.deltaY < 0 ? 1.08 : 0.92;
  const scale = Math.min(1.8, Math.max(0.35, view.scale * factor));
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  view.x = mx - ((mx - view.x) * scale) / view.scale;
  view.y = my - ((my - view.y) * scale) / view.scale;
  view.scale = scale;
}

function onBackgroundDown(event: PointerEvent): void {
  drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onNodeDown(event: PointerEvent, node: WorkflowNodeDef): void {
  event.stopPropagation();
  selectedNodeId.value = node.id;
  const point = positions[node.id];
  if (point === undefined) return;
  drag = {
    kind: 'node',
    id: node.id,
    startX: event.clientX,
    startY: event.clientY,
    originX: point.x,
    originY: point.y,
  };
}

function onPointerMove(event: PointerEvent): void {
  if (drag === null) return;
  const dx = (event.clientX - drag.startX) / view.scale;
  const dy = (event.clientY - drag.startY) / view.scale;
  if (drag.kind === 'pan') {
    view.x = drag.originX + (event.clientX - drag.startX);
    view.y = drag.originY + (event.clientY - drag.startY);
    return;
  }
  if (drag.id !== undefined) {
    positions[drag.id] = { x: drag.originX + dx, y: drag.originY + dy };
    dirty.value = true;
  }
}

function onPointerUp(): void {
  drag = null;
}

function fitView(): void {
  if (nodes.value.length === 0) return;
  const xs = nodes.value.map((node) => positions[node.id]?.x ?? 0);
  const ys = nodes.value.map((node) => positions[node.id]?.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX + NODE_W;
  const height = Math.max(...ys) - minY + NODE_H;
  const rect = canvas.value?.getBoundingClientRect();
  if (rect === undefined) return;
  view.scale = Math.min(1.2, Math.max(0.4, Math.min((rect.width - 60) / width, (rect.height - 60) / height)));
  view.x = 30 - minX * view.scale;
  view.y = 40 - minY * view.scale;
}

async function loadRecentRuns(): Promise<void> {
  try {
    const response = await fetch('/api/runs');
    const body = (await response.json()) as { runs?: { id: string; status: string; goal: string; artifactCount: number }[] };
    recentRuns.value = (body.runs ?? []).slice(0, 8);
  } catch {
    /* 历史只是辅助信息，读不到不影响画布 */
  }
}

/** 点历史运行：把当时的节点状态铺回画布，方便事后核对。 */
async function openRun(runId: string): Promise<void> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) return;
  const body = (await response.json()) as { status?: string; nodeStates?: Record<string, NodeState> };
  nodeStates.value = body.nodeStates ?? {};
  run.value = { id: runId, status: body.status ?? 'unknown' };
}

onMounted(async () => {
  await loadWorkflows();
  await loadDef();
  await loadRecentRuns();
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
});

onBeforeUnmount(() => {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});
</script>

<template>
  <div class="wf-page">
    <aside class="wf-list">
      <div class="wf-list__title">工作流</div>
      <button
        v-for="item in workflows"
        :key="item.id"
        class="wf-list__item"
        :class="{ active: item.id === selectedId }"
        type="button"
        @click="selectWorkflow(item.id)"
      >
        <span class="wf-list__name">{{ item.name }}</span>
        <span class="wf-list__meta">{{ item.builtin ? '内置' : `${item.nodeCount ?? 0} 节点` }}</span>
      </button>

      <div class="wf-list__title wf-list__title--gap">最近运行</div>
      <button
        v-for="item in recentRuns"
        :key="item.id"
        class="wf-list__item wf-list__item--run"
        type="button"
        @click="openRun(item.id)"
      >
        <span class="wf-list__name">{{ item.goal }}</span>
        <span class="wf-list__meta" :class="`is-${item.status}`">{{ item.status }}</span>
      </button>
      <div v-if="recentRuns.length === 0" class="wf-list__hint">还没有运行记录</div>
    </aside>

    <section class="wf-main">
      <header class="wf-toolbar">
        <input v-model="goal" class="wf-input" placeholder="目标（如：校园二手市集）" />
        <input
          v-if="selectedId === 'page'"
          v-model="templateId"
          class="wf-input wf-input--short"
          placeholder="templateId"
        />
        <button class="wf-btn wf-btn--primary" type="button" :disabled="busy || loading" @click="startRun()">
          {{ busy ? '运行中…' : '运行' }}
        </button>
        <button v-if="!builtin && dirty" class="wf-btn" type="button" @click="save">保存</button>
        <button class="wf-btn" type="button" @click="loadDef">重新加载</button>
        <button class="wf-btn" type="button" @click="fitView">适配视图</button>
        <span v-if="run !== null" class="wf-run" :class="`is-${run.status}`">
          {{ run.status }} · {{ run.id }}
        </span>
        <span v-if="error !== ''" class="wf-error">{{ error }}</span>
      </header>

      <div
        ref="canvas"
        class="wf-canvas"
        @wheel.prevent="onWheel"
        @pointerdown="onBackgroundDown"
      >
        <div
          class="wf-stage"
          :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }"
        >
          <svg class="wf-edges">
            <path v-for="edge in edges" :key="edge.id" :d="edge.path" />
          </svg>

          <div
            v-for="node in nodes"
            :key="node.id"
            class="wf-node"
            :class="[
              `is-${statusOf(node.id)?.status ?? 'idle'}`,
              { selected: node.id === selectedNodeId, cached: statusOf(node.id)?.cached === true },
            ]"
            :style="{
              left: `${positions[node.id]?.x ?? 0}px`,
              top: `${positions[node.id]?.y ?? 0}px`,
              width: `${NODE_W}px`,
              height: `${NODE_H}px`,
            }"
            @pointerdown="onNodeDown($event, node)"
          >
            <div class="wf-node__head">
              <span class="wf-node__id">{{ node.id }}</span>
              <span v-if="statusOf(node.id) !== undefined" class="wf-node__status">
                {{ statusLabel(statusOf(node.id)) }}
              </span>
            </div>
            <div class="wf-node__tool">{{ node.toolId }}</div>
            <div class="wf-node__note">{{ node.note ?? '' }}</div>
            <div v-if="statusOf(node.id)?.durationMs !== undefined" class="wf-node__time">
              {{ (statusOf(node.id)!.durationMs! / 1000).toFixed(1) }}s
            </div>
          </div>
        </div>
        <div v-if="nodes.length === 0 && !loading" class="wf-empty">这个工作流还没有节点</div>
      </div>
    </section>

    <aside class="wf-inspector">
      <template v-if="selectedNode !== undefined">
        <div class="wf-inspector__title">{{ selectedNode.id }}</div>
        <div class="wf-inspector__sub">{{ selectedNode.toolId }}</div>

        <button
          class="wf-btn wf-btn--primary wf-inspector__run"
          type="button"
          :disabled="busy"
          @click="startRun([selectedNode.id])"
        >
          重跑此节点及下游
        </button>

        <div class="wf-inspector__section">输入</div>
        <div v-for="(input, port) in selectedNode.inputs ?? {}" :key="port" class="wf-field">
          <label class="wf-field__label">{{ port }}</label>
          <template v-if="'value' in input">
            <input
              v-if="typeof input.value === 'string'"
              class="wf-field__input"
              :value="input.value"
              @change="updateLiteral(selectedNode.id, port, ($event.target as HTMLInputElement).value, 'string')"
            />
            <input
              v-else-if="typeof input.value === 'number'"
              class="wf-field__input"
              type="number"
              :value="input.value"
              @change="updateLiteral(selectedNode.id, port, ($event.target as HTMLInputElement).value, 'number')"
            />
            <select
              v-else
              class="wf-field__input"
              :value="String(input.value)"
              @change="updateLiteral(selectedNode.id, port, ($event.target as HTMLSelectElement).value, 'boolean')"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </template>
          <span v-else class="wf-field__ref">← 上游节点</span>
        </div>

        <div v-if="statusOf(selectedNode.id) !== undefined" class="wf-inspector__section">最近一次</div>
        <div v-if="statusOf(selectedNode.id) !== undefined" class="wf-inspector__state">
          <div>{{ statusLabel(statusOf(selectedNode.id)) }}</div>
          <div v-if="statusOf(selectedNode.id)?.summary" class="wf-inspector__summary">
            {{ statusOf(selectedNode.id)!.summary }}
          </div>
          <div v-if="statusOf(selectedNode.id)?.error" class="wf-inspector__error">
            {{ statusOf(selectedNode.id)!.error }}
          </div>
        </div>
      </template>
      <div v-else class="wf-inspector__hint">点一个节点看它的参数</div>
    </aside>
  </div>
</template>

<style scoped>
.wf-page {
  display: flex;
  height: calc(100vh - 56px);
  background: #0b1220;
  color: #e2e8f0;
}
.wf-list {
  width: 220px;
  border-right: 1px solid #1e293b;
  padding: 12px;
  overflow-y: auto;
}
.wf-list__title {
  font-size: 12px;
  letter-spacing: 0.2em;
  color: #64748b;
  margin-bottom: 10px;
}
.wf-list__item {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: #111c31;
  color: #cbd5e1;
  cursor: pointer;
  text-align: left;
}
.wf-list__item.active {
  border-color: #38bdf8;
  background: #0e2033;
}
.wf-list__name {
  font-size: 13px;
}
.wf-list__meta {
  font-size: 11px;
  color: #64748b;
}
.wf-list__title--gap {
  margin-top: 18px;
}
.wf-list__item--run {
  flex-direction: column;
  gap: 2px;
}
.wf-list__hint {
  font-size: 12px;
  color: #475569;
}
.wf-list__meta.is-succeeded {
  color: #34d399;
}
.wf-list__meta.is-failed {
  color: #f87171;
}
.wf-list__meta.is-running,
.wf-list__meta.is-queued {
  color: #fbbf24;
}
.wf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.wf-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #1e293b;
  flex-wrap: wrap;
}
.wf-input {
  background: #0f1a2d;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 6px 10px;
  color: #e2e8f0;
  width: 260px;
}
.wf-input--short {
  width: 140px;
}
.wf-btn {
  background: #16233a;
  border: 1px solid #24344f;
  color: #cbd5e1;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}
.wf-btn--primary {
  background: #38bdf8;
  border-color: #38bdf8;
  color: #06121f;
  font-weight: 600;
}
.wf-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.wf-run {
  font-size: 12px;
  color: #94a3b8;
}
.wf-run.is-failed {
  color: #f87171;
}
.wf-run.is-succeeded {
  color: #34d399;
}
.wf-error {
  color: #f87171;
  font-size: 12px;
}
.wf-canvas {
  position: relative;
  flex: 1;
  overflow: hidden;
  background-image: radial-gradient(#1e293b 1px, transparent 1px);
  background-size: 24px 24px;
  cursor: grab;
}
.wf-stage {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
}
.wf-edges {
  position: absolute;
  inset: 0;
  width: 4000px;
  height: 3000px;
  overflow: visible;
  pointer-events: none;
}
.wf-edges path {
  fill: none;
  stroke: #2f4a6d;
  stroke-width: 1.5;
}
.wf-node {
  position: absolute;
  box-sizing: border-box;
  background: #111c31;
  border: 1px solid #24344f;
  border-radius: 10px;
  padding: 8px 10px;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  overflow: hidden;
}
.wf-node.selected {
  border-color: #38bdf8;
  box-shadow: 0 0 0 1px #38bdf8 inset;
}
.wf-node.is-running {
  border-color: #fbbf24;
}
.wf-node.is-succeeded {
  border-color: #34d399;
}
.wf-node.is-failed {
  border-color: #f87171;
}
.wf-node.cached {
  opacity: 0.85;
}
.wf-node__head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}
.wf-node__id {
  font-weight: 600;
  color: #e2e8f0;
}
.wf-node__status {
  font-size: 11px;
  color: #94a3b8;
}
.wf-node__tool {
  font-size: 11px;
  color: #7dd3fc;
  margin-top: 2px;
}
.wf-node__note {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-node__time {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 10px;
  color: #475569;
}
.wf-inspector {
  width: 280px;
  border-left: 1px solid #1e293b;
  padding: 14px;
  overflow-y: auto;
}
.wf-inspector__title {
  font-size: 15px;
  font-weight: 600;
}
.wf-inspector__sub {
  font-size: 12px;
  color: #7dd3fc;
  margin-bottom: 10px;
}
.wf-inspector__run {
  width: 100%;
  margin-bottom: 12px;
}
.wf-inspector__section {
  font-size: 11px;
  letter-spacing: 0.16em;
  color: #64748b;
  margin: 14px 0 6px;
}
.wf-field {
  margin-bottom: 8px;
}
.wf-field__label {
  display: block;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 3px;
}
.wf-field__input {
  width: 100%;
  background: #0f1a2d;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 5px 8px;
  color: #e2e8f0;
  font-size: 12px;
}
.wf-field__ref {
  font-size: 12px;
  color: #64748b;
}
.wf-inspector__state {
  font-size: 12px;
  color: #cbd5e1;
}
.wf-inspector__summary {
  color: #94a3b8;
  margin-top: 4px;
}
.wf-inspector__error {
  color: #f87171;
  margin-top: 4px;
}
.wf-inspector__hint,
.wf-empty {
  color: #475569;
  font-size: 13px;
}
.wf-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
