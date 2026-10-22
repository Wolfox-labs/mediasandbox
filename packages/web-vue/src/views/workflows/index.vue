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
 *
 * ## 配色为什么全走 `--wf-*`
 *
 * 这里不是独立产品，是站内的一页。第一版直接把深色仪表盘那套色值写死，
 * 结果顶栏是白的、画布是黑的，切换明暗主题也不跟。现在所有颜色都从
 * `useThemeVars()` 映射下来（见 `themeStyle`），跟随主题、跟随主色，
 * 并且和 NCard 用的是同一组 token：同一档描边、同一档圆角、同一档字号。
 */
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { NButton, NEmpty, NInput, NSelect, NTag, useThemeVars } from 'naive-ui';
import type { WorkflowDef, WorkflowInput, WorkflowNodeDef } from './types';
import { layoutNodes, type Point } from './layout';
import { NODE_STATUS_STYLE, STATUS_STYLE, type NTagType } from '@/utils/format';

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

type Tag = { label: string; type: NTagType };

const NODE_W = 216;
const NODE_H = 84;
const MIN_SCALE = 0.2;
const MAX_SCALE = 1.6;

const themeVars = useThemeVars();

/** 把主题 token 摊成 `--wf-*`：组件内所有颜色都只认这一层，不再出现十六进制字面量。 */
const themeStyle = computed<Record<string, string>>(() => ({
  '--wf-card': themeVars.value.cardColor,
  '--wf-bg': themeVars.value.bodyColor,
  '--wf-divider': themeVars.value.dividerColor,
  '--wf-border': themeVars.value.borderColor,
  '--wf-text-1': themeVars.value.textColor1,
  '--wf-text-2': themeVars.value.textColor2,
  '--wf-text-3': themeVars.value.textColor3,
  '--wf-hover': themeVars.value.actionColor,
  '--wf-primary': themeVars.value.primaryColor,
  '--wf-primary-soft': themeVars.value.primaryColorHover,
  '--wf-success': themeVars.value.successColor,
  '--wf-warning': themeVars.value.warningColor,
  '--wf-error': themeVars.value.errorColor,
}));

const BOOL_OPTIONS = [
  { label: 'true', value: 'true' },
  { label: 'false', value: 'false' },
];

const RUN_TAGS = STATUS_STYLE as unknown as Record<string, Tag>;
const NODE_TAGS = NODE_STATUS_STYLE as unknown as Record<string, Tag>;

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
const queue = ref<{ running: number; waiting: number; maxConcurrent: number } | null>(null);
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

const runTag = (status: string): Tag => RUN_TAGS[status] ?? { label: status, type: 'default' };
const nodeTag = (status: string): Tag => NODE_TAGS[status] ?? { label: status, type: 'default' };

const statusLabel = (state: NodeState | undefined): string => {
  if (state === undefined) return '';
  if (state.cached === true) return '缓存';
  return nodeTag(state.status).label;
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
    for (const [id, point] of Object.entries(layout)) {
      positions[id] = body.workflow.nodes.find((node) => node.id === id)?.position ?? point;
    }
    selectedNodeId.value = body.workflow.nodes[0]?.id ?? '';
    nodeStates.value = {};
    dirty.value = false;
    // 不自动适配的话，节点会停在画布的原始坐标上，看上去"只露出一个"。
    await nextTick();
    fitView();
  } catch (error_) {
    error.value = `读取工作流失败：${String(error_)}`;
  } finally {
    loading.value = false;
  }
}

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
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
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

/** 把整张图缩放到刚好铺满画布并居中——首屏和点「适配视图」都走这里。 */
function fitView(): void {
  if (nodes.value.length === 0) return;
  const xs = nodes.value.map((node) => positions[node.id]?.x ?? 0);
  const ys = nodes.value.map((node) => positions[node.id]?.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX + NODE_W;
  const height = Math.max(...ys) - minY + NODE_H;
  const rect = canvas.value?.getBoundingClientRect();
  if (rect === undefined || rect.width === 0) return;
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.min((rect.width - 48) / width, (rect.height - 48) / height)),
  );
  view.scale = scale;
  view.x = (rect.width - width * scale) / 2 - minX * scale;
  view.y = (rect.height - height * scale) / 2 - minY * scale;
}

async function loadRecentRuns(): Promise<void> {
  try {
    const response = await fetch('/api/runs');
    const body = (await response.json()) as {
      runs?: { id: string; status: string; goal: string; artifactCount: number }[];
      queue?: { running: number; waiting: number; maxConcurrent: number };
    };
    recentRuns.value = (body.runs ?? []).slice(0, 6);
    queue.value = body.queue ?? null;
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
  <div class="wf" :style="themeStyle">
    <header class="wf-bar">
      <NInput v-model:value="goal" size="small" placeholder="目标（如：校园二手市集）" class="wf-bar__goal" />
      <NInput
        v-if="selectedId === 'page'"
        v-model:value="templateId"
        size="small"
        placeholder="templateId"
        class="wf-bar__tpl"
      />
      <NButton size="small" type="primary" :loading="busy" :disabled="loading" @click="startRun()">
        {{ busy ? '运行中' : '运行' }}
      </NButton>
      <NButton v-if="!builtin && dirty" size="small" @click="save">保存</NButton>
      <NButton size="small" quaternary @click="loadDef">重新加载</NButton>
      <NButton size="small" quaternary @click="fitView">适配视图</NButton>
      <NTag v-if="run !== null" size="small" :type="runTag(run.status).type">
        {{ runTag(run.status).label }} · {{ run.id.slice(0, 8) }}
      </NTag>
      <span v-if="error !== ''" class="wf-bar__error">{{ error }}</span>
    </header>

    <div class="wf-body">
      <aside class="wf-side">
        <div class="wf-side__title">工作流</div>
        <button
          v-for="item in workflows"
          :key="item.id"
          class="wf-item"
          :class="{ 'wf-item--active': item.id === selectedId }"
          type="button"
          @click="selectWorkflow(item.id)"
        >
          <span class="wf-item__name">{{ item.name }}</span>
          <span class="wf-item__meta">{{ item.builtin ? '内置' : `${item.nodeCount ?? 0} 节点` }}</span>
        </button>

        <div class="wf-side__title wf-side__title--gap">最近运行</div>
        <div v-if="queue !== null" class="wf-queue">
          运行 {{ queue.running }} · 排队 {{ queue.waiting }} · 上限 {{ queue.maxConcurrent }}
        </div>
        <button
          v-for="item in recentRuns"
          :key="item.id"
          class="wf-item wf-item--run"
          type="button"
          @click="openRun(item.id)"
        >
          <span class="wf-item__name" :title="item.goal">{{ item.goal }}</span>
          <span class="wf-item__row">
            <NTag size="tiny" :type="runTag(item.status).type">{{ runTag(item.status).label }}</NTag>
            <span class="wf-item__meta">{{ item.artifactCount }} 产物</span>
          </span>
        </button>
        <NEmpty v-if="recentRuns.length === 0" size="small" description="还没有运行记录" />
      </aside>

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
              { 'is-selected': node.id === selectedNodeId, 'is-cached': statusOf(node.id)?.cached === true },
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
                <i class="wf-node__dot" />
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
        <NEmpty v-if="nodes.length === 0 && !loading" class="wf-canvas__empty" size="small" description="这个工作流还没有节点" />
      </div>

      <aside class="wf-side wf-side--right">
        <template v-if="selectedNode !== undefined">
          <div class="wf-side__title">节点</div>
          <div class="wf-node-title">{{ selectedNode.id }}</div>
          <div class="wf-node-sub">{{ selectedNode.toolId }}</div>

          <NButton
            class="wf-inspector__run"
            size="small"
            type="primary"
            secondary
            block
            :disabled="busy"
            @click="startRun([selectedNode.id])"
          >
            重跑此节点及下游
          </NButton>

          <div class="wf-side__title wf-side__title--gap">输入</div>
          <div v-for="(input, port) in selectedNode.inputs ?? {}" :key="port" class="wf-field">
            <label class="wf-field__label">{{ port }}</label>
            <template v-if="'value' in input">
              <NInput
                v-if="typeof input.value === 'string'"
                size="small"
                :value="input.value"
                @update:value="updateLiteral(selectedNode.id, port, $event, 'string')"
              />
              <NInput
                v-else-if="typeof input.value === 'number'"
                size="small"
                :value="String(input.value)"
                @update:value="updateLiteral(selectedNode.id, port, $event, 'number')"
              />
              <NSelect
                v-else
                size="small"
                :value="input.value ? 'true' : 'false'"
                :options="BOOL_OPTIONS"
                @update:value="updateLiteral(selectedNode.id, port, $event, 'boolean')"
              />
            </template>
            <span v-else class="wf-field__ref">← 上游节点</span>
          </div>

          <template v-if="statusOf(selectedNode.id) !== undefined">
            <div class="wf-side__title wf-side__title--gap">最近一次</div>
            <div class="wf-inspector__state">
              <NTag size="tiny" :type="nodeTag(statusOf(selectedNode.id)!.status).type">
                {{ statusLabel(statusOf(selectedNode.id)) }}
              </NTag>
              <span v-if="statusOf(selectedNode.id)?.durationMs !== undefined" class="wf-item__meta">
                {{ (statusOf(selectedNode.id)!.durationMs! / 1000).toFixed(1) }}s
              </span>
            </div>
            <div v-if="statusOf(selectedNode.id)?.summary" class="wf-inspector__summary">
              {{ statusOf(selectedNode.id)!.summary }}
            </div>
            <div v-if="statusOf(selectedNode.id)?.error" class="wf-inspector__error">
              {{ statusOf(selectedNode.id)!.error }}
            </div>
          </template>
        </template>
        <div v-else class="wf-inspector__hint">点一个节点看它的参数</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* 尺寸与配色：与 NCard 同一档（8px 圆角、1px divider 描边、12px 内边距）。 */
.wf {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  color: var(--wf-text-1);
}
.wf-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-bar__goal {
  width: 240px;
}
.wf-bar__tpl {
  width: 130px;
}
.wf-bar__error {
  font-size: 12px;
  color: var(--wf-error);
}
.wf-body {
  display: flex;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--wf-divider);
  border-radius: 8px;
  background: var(--wf-card);
  overflow: hidden;
}
.wf-side {
  width: 236px;
  flex-shrink: 0;
  padding: 12px;
  overflow-y: auto;
  border-right: 1px solid var(--wf-divider);
}
.wf-side--right {
  width: 264px;
  border-right: none;
  border-left: 1px solid var(--wf-divider);
}
.wf-side__title {
  font-size: 12px;
  color: var(--wf-text-3);
  margin-bottom: 8px;
}
.wf-side__title--gap {
  margin-top: 16px;
}
.wf-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--wf-text-2);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s, border-color 0.15s;
}
.wf-item:hover {
  background: var(--wf-hover);
}
.wf-item--active {
  border-color: var(--wf-primary);
  background: var(--wf-hover);
  color: var(--wf-text-1);
}
.wf-item__name {
  font-size: 13px;
  color: var(--wf-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-item__row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wf-item__meta {
  font-size: 11px;
  color: var(--wf-text-3);
}
.wf-queue {
  font-size: 11px;
  color: var(--wf-text-2);
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--wf-divider);
  border-radius: 6px;
  background: var(--wf-bg);
}
.wf-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  cursor: grab;
  background-color: var(--wf-bg);
  background-image: radial-gradient(var(--wf-divider) 1px, transparent 1px);
  background-size: 22px 22px;
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
/* 描边色（borderColor）在浅色底上淡到断开，连线得用正文级的灰再压一半透明度。 */
.wf-edges path {
  fill: none;
  stroke: var(--wf-text-2);
  stroke-opacity: 0.45;
  stroke-width: 1.5;
}
.wf-node {
  position: absolute;
  box-sizing: border-box;
  background: var(--wf-card);
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.wf-node.is-selected {
  border-color: var(--wf-primary);
  box-shadow: 0 0 0 1px var(--wf-primary);
}
.wf-node.is-running {
  border-color: var(--wf-warning);
}
.wf-node.is-succeeded {
  border-color: var(--wf-success);
}
.wf-node.is-failed {
  border-color: var(--wf-error);
}
.wf-node.is-cached {
  border-style: dashed;
}
.wf-node__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.wf-node__id {
  font-weight: 600;
  color: var(--wf-text-1);
}
.wf-node__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--wf-text-3);
}
.wf-node__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wf-text-3);
}
.wf-node.is-running .wf-node__dot {
  background: var(--wf-warning);
}
.wf-node.is-succeeded .wf-node__dot {
  background: var(--wf-success);
}
.wf-node.is-failed .wf-node__dot {
  background: var(--wf-error);
}
.wf-node__tool {
  font-size: 11px;
  color: var(--wf-text-2);
  margin-top: 2px;
}
.wf-node__note {
  font-size: 11px;
  color: var(--wf-text-3);
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
  color: var(--wf-text-3);
}
.wf-node-title {
  font-size: 14px;
  font-weight: 600;
}
.wf-node-sub {
  font-size: 12px;
  color: var(--wf-text-2);
  margin-bottom: 10px;
}
.wf-inspector__run {
  margin-bottom: 4px;
}
.wf-field {
  margin-bottom: 8px;
}
.wf-field__label {
  display: block;
  font-size: 11px;
  color: var(--wf-text-3);
  margin-bottom: 3px;
}
.wf-field__ref {
  font-size: 12px;
  color: var(--wf-text-3);
}
.wf-inspector__state {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wf-inspector__summary {
  font-size: 12px;
  color: var(--wf-text-2);
  margin-top: 6px;
  word-break: break-word;
}
.wf-inspector__error {
  font-size: 12px;
  color: var(--wf-error);
  margin-top: 6px;
  word-break: break-word;
}
.wf-inspector__hint {
  font-size: 12px;
  color: var(--wf-text-3);
}
.wf-canvas__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
