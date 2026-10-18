<script setup lang="ts">
/**
 * 第 2 步：模型决策。
 *
 * 这一页分四块，对应后端真实的三个阶段：
 *
 *   ① 提交 —— `POST /api/runs`，拿 runId 后由外壳订阅 WebSocket
 *   ② 统筹规划 —— `plan_assembled.blueprint`（或 `GET /api/runs/:id` 的 blueprint）：
 *      "这页讲哪几段"由规划模型定，"每段用哪块"由决策模型定。**失败原因原样显示**，
 *      留空会让人以为功能没做
 *   ③ 逐块决策 —— `structure.steps` 按轮次展示：问了什么、选了哪块、继续概率、评分、依据
 *   ④ 执行步骤 —— `plan_assembled.nodes` 的逐节点状态
 *
 * 另外保留干涉能力（"决策可见且可干预"的落点）：
 *   上移 / 下移 / 删除 → `POST /api/runs/:id/structure/ops`
 *   定点重做 / 按当前结构重跑 → `POST /api/runs` 带 `redoFrom + blockIds`
 *   重新规划 → 再提交一次并显式要求跑统筹规划
 */
import { computed, ref } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NSpin, NTag, useMessage } from 'naive-ui';
import { api, ApiError } from '@/api/client';
import { isTerminal } from '@/api/types';
import type { BlueprintView } from '@/api/types';
import { useWorkbenchStore } from '@/store/modules/workbench';
import { formatDuration, STATUS_STYLE } from '@/utils/format';

const emit = defineEmits<{ next: []; back: [] }>();

const store = useWorkbenchStore();
const message = useMessage();

const submitting = ref(false);
const replanning = ref(false);
const submitError = ref<string | undefined>(undefined);
const submitNote = ref<string | undefined>(undefined);

const structure = computed(() => store.structure);
const structureBlocks = computed(() => store.structure?.page.blocks ?? []);
const rounds = computed(() => store.structure?.steps ?? []);

/**
 * 规划的四种状态，界面上说四种不同的话。
 *
 * `absent`（没这个字段）与 `failed`（ok:false）**不能合并**：前者是"这条路不适用"，
 * 后者是"试了，但被关掉或失败了"，后者必须把 detail 原样给出来。
 */
const blueprintState = computed<'idle' | 'pending' | 'ok' | 'failed' | 'absent'>(() => {
  const plan = store.blueprint;
  if (plan !== undefined) return plan.ok ? 'ok' : 'failed';
  if (store.runId === undefined) return 'idle';
  return store.runFinished ? 'absent' : 'pending';
});

type BlueprintOk = Extract<BlueprintView, { ok: true }>;

/** 拆成窄类型便于模板里直接用，避免在模板里对 store 的深路径做类型收窄。 */
const blueprintOk = computed<BlueprintOk | undefined>(() => {
  const plan = store.blueprint;
  return plan !== undefined && plan.ok ? plan : undefined;
});

/** `ok:false` 的原因，原样显示。 */
const blueprintDetail = computed<string | undefined>(() => {
  const plan = store.blueprint;
  return plan !== undefined && !plan.ok ? plan.detail : undefined;
});

const KIND_LABEL: Record<'select' | 'count_only' | 'quality', string> = {
  select: '选块',
  count_only: '定数量',
  quality: '质量评估'
};

/** 决策问题的中文说法。认不出来的键名原样显示——猜错的翻译比原样更糟。 */
const QUESTION_LABEL: Record<string, string> = {
  next_block: '下一块用哪个',
  continue_structuring: '还要继续排吗',
  structure_quality: '整页质量'
};

function questionLabel(id: string): string {
  const exact = QUESTION_LABEL[id];
  if (exact !== undefined) return exact;
  if (id.startsWith('slot_count:')) return `「${id.slice('slot_count:'.length)}」要几项`;
  if (id.startsWith('slot_source:')) return `「${id.slice('slot_source:'.length)}」内容从哪来`;
  return id;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function countsText(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '';
  return entries.map(([name, count]) => `${name} × ${count}`).join('、');
}

const rationale = computed(() => store.viewModel?.rationale ?? []);
const nodes = computed(() => store.viewModel?.current?.nodes ?? []);

function nodeType(status: string): 'default' | 'info' | 'success' | 'error' | 'warning' {
  switch (status) {
    case 'running':
      return 'info';
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'warning';
    default:
      return 'default';
  }
}

// ── 提交 ────────────────────────────────────────────────────────────
async function submit(): Promise<void> {
  if (store.goalBlocker !== null) {
    message.warning(store.goalBlocker);
    return;
  }
  submitting.value = true;
  submitError.value = undefined;
  submitNote.value = undefined;
  try {
    const result = await store.submitRun();
    submitNote.value =
      result.queuePosition !== undefined
        ? `已排队，第 ${result.queuePosition} 位，轮到时自动开始`
        : `已提交 ${result.runId}：正在等统筹规划与结构`;
  } catch (error) {
    submitError.value =
      error instanceof ApiError
        ? error.status === 429
          ? `队列已满：${error.message}`
          : error.status === 503
            ? `本机缺能力，这次跑不了：${error.message}`
            : error.message
        : '提交失败';
  } finally {
    submitting.value = false;
  }
}

async function cancel(): Promise<void> {
  const runId = store.runId;
  if (runId === undefined) return;
  try {
    await api.cancelRun(runId);
    message.success('已请求取消');
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '取消失败');
  }
}

async function replan(): Promise<void> {
  if (store.goalBlocker !== null) {
    message.warning(store.goalBlocker);
    return;
  }
  replanning.value = true;
  submitError.value = undefined;
  try {
    const result = await store.replan();
    submitNote.value = `已重新规划：${result.runId}`;
    redoSelection.value = [];
  } catch (error) {
    submitError.value = error instanceof ApiError ? error.message : '重新规划失败';
  } finally {
    replanning.value = false;
  }
}

// ── 干涉：改结构 ────────────────────────────────────────────────────
const applyingOps = ref(false);

/** 上移 / 下移 / 删除：只提交最小改动（ops），不整份覆盖结构。 */
async function moveBlock(index: number, delta: -1 | 1): Promise<void> {
  const runId = store.runId;
  const target = structureBlocks.value[index];
  if (runId === undefined || target === undefined) return;
  const to = index + delta;
  if (to < 0 || to >= structureBlocks.value.length) return;
  applyingOps.value = true;
  try {
    const result = await api.structureOps(runId, [
      { op: 'move', blockId: target.id, toIndex: to }
    ]);
    store.applyStructureBlocks(result.structure.page.blocks);
    // 后端规范化改了什么要说：静默挪块会让人以为是自己记错了。
    if (result.fixes.length > 0) message.info(result.fixes.join('；'));
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '调整结构失败');
  } finally {
    applyingOps.value = false;
  }
}

async function removeBlock(index: number): Promise<void> {
  const runId = store.runId;
  const target = structureBlocks.value[index];
  if (runId === undefined || target === undefined) return;
  applyingOps.value = true;
  try {
    const result = await api.structureOps(runId, [{ op: 'remove', blockId: target.id }]);
    store.applyStructureBlocks(result.structure.page.blocks);
    redoSelection.value = redoSelection.value.filter(id => id !== target.id);
    message.success(`已移除区块 ${target.type}`);
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '移除区块失败');
  } finally {
    applyingOps.value = false;
  }
}

// ── 干涉：定点重做 ──────────────────────────────────────────────────
const redoSelection = ref<string[]>([]);
const redoing = ref(false);

function toggleRedo(id: string, checked: boolean): void {
  const next = new Set(redoSelection.value);
  if (checked) next.add(id);
  else next.delete(id);
  redoSelection.value = [...next];
}

async function redoSelected(): Promise<void> {
  const source = store.runId;
  if (source === undefined) return;
  if (redoSelection.value.length === 0) {
    message.warning('先勾选要重做的区块');
    return;
  }
  redoing.value = true;
  try {
    const result = await store.submitRedo(source, redoSelection.value);
    message.success(`已提交重做：${result.runId}`);
    redoSelection.value = [];
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '提交重做失败');
  } finally {
    redoing.value = false;
  }
}

/** 按当前（可能刚改过的）结构整份重跑：所有块都重填一遍。 */
async function redoAll(): Promise<void> {
  const source = store.runId;
  if (source === undefined || structureBlocks.value.length === 0) return;
  redoing.value = true;
  try {
    const result = await store.submitRedo(
      source,
      structureBlocks.value.map(block => block.id)
    );
    message.success(`已按当前结构重跑：${result.runId}`);
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '提交重跑失败');
  } finally {
    redoing.value = false;
  }
}

function goNext(): void {
  if (store.decisionBlocker !== null) return;
  emit('next');
}
</script>

<template>
  <div class="wb__stack">
    <div class="wb__head">
      <span class="wb__title">模型决策</span>
      <span class="wb__sub">规划模型定"讲哪几段"，决策模型定"每段用哪块"</span>
    </div>

    <NCard size="small" :bordered="false" class="wb__card">
      <template #header>
        <span class="wb__no">2</span>
        <span>提交这次创作</span>
        <span v-if="store.runId" class="wb__hint">{{ store.runId }}</span>
      </template>

      <p class="wb__note">
        提交后后端跑一次运行：先出统筹规划，再逐块问决策模型，最后按结构填充并组装页面。
        进度通过实时通道推过来。
      </p>

      <div class="wb__actions" style="margin-top: 4px">
        <NButton type="primary" :loading="submitting" :disabled="store.runActive" @click="submit">
          {{ store.runId === undefined ? '提交并开始决策' : '用当前参数再跑一次' }}
        </NButton>
        <NButton v-if="store.runId && !store.runFinished" type="error" secondary @click="cancel">
          取消运行
        </NButton>
        <span v-if="store.runId" class="wb__hint">
          {{ STATUS_STYLE[store.status].label }}
          <template v-if="store.durationMs !== undefined">
            · {{ formatDuration(store.durationMs) }}
          </template>
          <template v-if="store.queuePosition !== undefined">
            · 排队第 {{ store.queuePosition }} 位
          </template>
        </span>
      </div>

      <NAlert v-if="submitNote" type="info" :bordered="false" class="mt-2">{{ submitNote }}</NAlert>
      <NAlert v-if="submitError" type="error" :bordered="false" class="mt-2">
        {{ submitError }}
      </NAlert>
      <NAlert v-if="store.goalBlocker" type="default" :bordered="false" class="mt-2">
        第 1 步还没准备好：{{ store.goalBlocker }}
        <NButton text size="tiny" @click="emit('back')">回去补</NButton>
      </NAlert>
      <NAlert v-if="store.error" type="error" :bordered="false" class="mt-2">
        运行失败：{{ store.error }}
      </NAlert>
      <NAlert v-if="store.reason" type="warning" :bordered="false" class="mt-2">
        {{ store.reason }}
      </NAlert>

      <!-- ① 统筹规划 -->
      <div class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">统筹规划</span>
          <span class="wb__section-count">"这页要讲哪几段"由规划模型先定</span>
        </div>

        <div v-if="blueprintState === 'idle'" class="wb__empty">
          还没提交，先在上面点「提交并开始决策」
        </div>

        <div v-else-if="blueprintState === 'pending'" class="wb__empty">
          <NSpin size="small" />
          <span style="margin-left: 8px">规划中……</span>
        </div>

        <NAlert v-else-if="blueprintState === 'absent'" type="default" :bordered="false">
          这次运行没有规划结果：部署里没有配置生成层，或者这条链路不走统筹规划。
        </NAlert>

        <!-- ok:false 的原因**原样**显示：后端说"按要求关闭""调用失败：……"，照抄 -->
        <NAlert
          v-else-if="blueprintDetail !== undefined"
          type="warning"
          :bordered="false"
          title="这次没有拿到统筹规划"
        >
          {{ blueprintDetail }}
        </NAlert>

        <template v-else-if="blueprintOk !== undefined">
          <div class="wb__bp-head">
            <span class="wb__bp-title">{{ blueprintOk.title }}</span>
            <NTag size="tiny" :type="blueprintOk.status === 'ok' ? 'success' : 'warning'">
              {{ blueprintOk.status === 'ok' ? '结构化输出' : '按行文退回解析' }}
            </NTag>
            <span class="wb__bp-meta">
              {{ blueprintOk.model }} · {{ formatDuration(blueprintOk.latencyMs) }}
            </span>
          </div>
          <div class="wb__bp-meta">
            <span class="wb__kv"><span class="wb__kv-key">定位</span>{{ blueprintOk.positioning }}</span>
            <span class="wb__kv"><span class="wb__kv-key">受众</span>{{ blueprintOk.audience }}</span>
            <span class="wb__kv"><span class="wb__kv-key">语气</span>{{ blueprintOk.tone }}</span>
          </div>
          <ol class="wb__bp-sections">
            <li
              v-for="(section, index) in blueprintOk.sections"
              :key="index"
              class="wb__bp-section"
            >
              <div class="wb__bp-purpose">
                <span>第 {{ index + 1 }} 段</span>
                <span>{{ section.purpose }}</span>
              </div>
              <div class="wb__bp-detail">{{ section.detail }}</div>
              <div v-if="section.blockIds.length > 0" class="wb__bp-blocks">
                <span class="wb__kv-key">建议块</span>
                <NTag v-for="id in section.blockIds" :key="id" size="tiny">{{ id }}</NTag>
              </div>
            </li>
          </ol>
          <ul v-if="blueprintOk.notes.length > 0" class="wb__bp-notes">
            <li v-for="(note, index) in blueprintOk.notes" :key="index">{{ note }}</li>
          </ul>
        </template>

        <div v-if="store.runId !== undefined" class="wb__actions">
          <NButton
            size="tiny"
            secondary
            :loading="replanning"
            :disabled="store.runActive"
            @click="replan"
          >
            重新规划
          </NButton>
          <span class="wb__hint">
            规划是运行的一部分，没有单独入口：重新规划 = 用同样的目标与参数再跑一次
          </span>
        </div>
      </div>

      <!-- ② 逐块决策 -->
      <div class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">逐块决策</span>
          <span class="wb__section-count">
            {{ rounds.length }} 轮 · 结构 {{ structureBlocks.length }} 块
            <template v-if="structure && structure.page.qualityScore !== null">
              · 质量评分 {{ structure.page.qualityScore }}
            </template>
          </span>
        </div>

        <div v-if="rounds.length === 0" class="wb__empty">
          {{
            store.runId === undefined
              ? '还没有运行。先在上面提交'
              : store.runFinished
                ? `这次运行没有决策留痕（模态不是网页/演示文稿，或者结构由调用方给定）`
                : '等模型给出第一轮决策……'
          }}
        </div>

        <ol v-else class="wb__rounds">
          <li v-for="step in rounds" :key="step.round" class="wb__round">
            <div class="wb__round-head">
              <span class="wb__round-no">第 {{ step.round + 1 }} 轮</span>
              <NTag size="tiny">{{ KIND_LABEL[step.kind] }}</NTag>
              <NTag v-if="step.pickedBlockId" size="tiny" type="success">
                选中 {{ step.pickedBlockId }}
              </NTag>
              <span class="wb__kv">
                <span class="wb__kv-key">继续概率</span>{{ percent(step.continueProbability) }}
              </span>
              <span v-if="step.continued !== null" class="wb__kv">
                <span class="wb__kv-key">判定</span>{{ step.continued ? '继续' : '停' }}
              </span>
              <span v-if="step.score !== null" class="wb__kv">
                <span class="wb__kv-key">评分</span>{{ step.score }}
              </span>
              <span class="wb__kv">
                <span class="wb__kv-key">耗时</span>{{ formatDuration(step.latencyMs) }}
              </span>
            </div>
            <div class="wb__round-body">
              <div>
                <span class="wb__kv-key">问的是：</span>
                {{ step.questionIds.map(questionLabel).join('、') || '—' }}
              </div>
              <div v-if="countsText(step.counts) !== ''">
                <span class="wb__kv-key">数量：</span>{{ countsText(step.counts) }}
              </div>
              <div><span class="wb__kv-key">依据：</span>{{ step.rationale }}</div>
            </div>
          </li>
        </ol>
      </div>

      <!-- ③ 干涉：改结构 -->
      <div v-if="structureBlocks.length > 0" class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">结构（可改）</span>
          <span class="wb__section-count">上移 / 下移 / 删除会立刻保存到这次运行</span>
        </div>

        <ol class="wb__structure">
          <li v-for="(block, index) in structureBlocks" :key="block.id" class="wb__structure-item">
            <NTag size="tiny" :type="block.status === 'filled' ? 'success' : 'default'">
              {{ block.type }}
            </NTag>
            <span class="wb__block-id">{{ block.id }}</span>
            <span class="wb__structure-ops">
              <NButton
                text
                size="tiny"
                :disabled="index === 0 || applyingOps"
                @click="moveBlock(index, -1)"
              >
                上移
              </NButton>
              <NButton
                text
                size="tiny"
                :disabled="index === structureBlocks.length - 1 || applyingOps"
                @click="moveBlock(index, 1)"
              >
                下移
              </NButton>
              <NButton
                text
                size="tiny"
                type="error"
                :disabled="applyingOps"
                @click="removeBlock(index)"
              >
                删除
              </NButton>
            </span>
          </li>
        </ol>

        <div class="wb__section-head" style="margin-top: 10px">
          <span class="wb__label" style="margin: 0">只重做选中的区块</span>
          <span class="wb__section-count">其余块复用这次运行的现成内容，不重新生成</span>
        </div>
        <div class="wb__blocks">
          <NCheckbox
            v-for="block in structureBlocks"
            :key="`redo-${block.id}`"
            :checked="redoSelection.includes(block.id)"
            size="small"
            @update:checked="checked => toggleRedo(block.id, checked)"
          >
            {{ block.type }}
            <span class="wb__block-id">{{ block.id }}</span>
          </NCheckbox>
        </div>
        <div class="wb__actions">
          <NButton size="tiny" secondary :loading="redoing" @click="redoSelected">
            重做选中区块
          </NButton>
          <NButton size="tiny" secondary :loading="redoing" @click="redoAll">按当前结构重跑</NButton>
          <span class="wb__hint">重做与重跑都是新的一次运行，会换成新的运行号</span>
        </div>
      </div>

      <!-- ④ 执行步骤 -->
      <div v-if="nodes.length > 0" class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">执行步骤</span>
          <span class="wb__section-count">结构定稿后按计划节点逐条执行</span>
        </div>
        <ol class="wb__steps">
          <li v-for="node in nodes" :key="node.nodeId" class="wb__step">
            <NTag size="tiny" :type="nodeType(node.status)">{{ node.status }}</NTag>
            <span class="wb__step-tool">{{ node.toolId }}</span>
            <span class="wb__step-note">{{ node.note }}</span>
            <div v-if="node.summary" class="wb__step-summary">{{ node.summary }}</div>
            <div v-if="node.error" class="wb__step-error">{{ node.error }}</div>
          </li>
        </ol>
      </div>

      <div v-if="rationale.length > 0" class="wb__section">
        <span class="wb__label">组装依据</span>
        <ul class="wb__rationale">
          <li v-for="(line, index) in rationale" :key="index">{{ line }}</li>
        </ul>
      </div>

      <div class="wb__actions">
        <NButton size="small" secondary @click="emit('back')">上一步</NButton>
        <NButton
          type="primary"
          size="small"
          :disabled="store.decisionBlocker !== null"
          @click="goNext"
        >
          下一步：交互测试
        </NButton>
        <span v-if="store.decisionBlocker" class="wb__hint">{{ store.decisionBlocker }}</span>
        <span v-else-if="!store.tested" class="wb__hint">结构已定稿，可以去点一下页面了</span>
      </div>
      <span
        v-if="isTerminal(store.status) && !store.structureReady"
        class="wb__hint wb__hint--block"
      >
        运行已结束但没有{{ store.unitNoun }}结构：这次运行失败了，或者模态不是网页/演示文稿。
      </span>
    </NCard>
  </div>
</template>
