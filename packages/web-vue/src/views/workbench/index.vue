<script setup lang="ts">
/**
 * 创作工作台（线性四段式）。
 *
 *   ① 创作目标   —— 目标描述、目标类型、页面元素、模板
 *   ② 模型决策   —— 决策过程，且允许用户干涉（改结构、定点重做）
 *   ③ 模型交互测试 —— 真浏览器点击并由代码判定
 *   ④ 结果展示   —— 产物预览
 *
 * 顶部有一条吸顶步骤导航：全程几步、当前在哪、点一下跳过去。
 *
 * ## 为什么是单列
 *
 * 三栏并排时视线要左右横跳，预览还被压窄。线性布局下读者的动线
 * 就是一次运行的动线，从上往下读一遍就讲完了。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NDialog,
  NEmpty,
  NInput,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpin,
  NTag,
  useMessage,
  useThemeVars
} from 'naive-ui';
import {
  api,
  ApiError,
  isHtmlArtifact,
  isImageArtifact,
  isTextArtifact
} from '@/api/client';
import type {
  Artifact,
  BlockSpecDto,
  EnvType,
  InteractionVerdict,
  QueueSnapshot,
  RunListItem
} from '@/api/types';
import type { TemplateItem } from '@/api/client';
import { useRunStream } from '@/composables/use-run-stream';
import { foldEvents } from '@/state/run-view-model';
import { STATUS_STYLE } from '@/utils/format';

defineOptions({ name: 'Workbench' });

const message = useMessage();
const route = useRoute();

/**
 * 吸顶导航必须有不透明背景，否则内容滚到下面会从它后面透出来
 * （实测：写 `var(--n-color-body)` 时该变量在本项目主题里不存在，
 *  背景等于透明，截图里能看到区块文字压着导航）。
 * 用 Naive 的主题变量对象取值，深浅色模式都能跟着变。
 */
const themeVars = useThemeVars();
const router = useRouter();

// ── ① 创作目标 ──────────────────────────────────────────────────────
const goal = ref('做一个中文产品介绍落地页，包含首屏、特性与行动号召');

/**
 * 目标类型。后端只有网页 / 图像 / 文案三类环境；"海报"归到图像。
 * 不写"结构化网页"这类内部分类——对用户来说选的就是要做什么东西。
 */
const TARGET_TYPES = [
  { label: '网页', value: 'webpage' as EnvType, hint: '逐块组装成整页，可预览、可截图' },
  { label: '海报 / 图片', value: 'image' as EnvType, hint: '产出一张图片' },
  { label: '文案', value: 'copy' as EnvType, hint: '产出一份 Markdown 文稿' }
] as const;

const envType = ref<EnvType>('webpage');
const provider = ref<'docker' | 'local'>('docker');
const maxBlocks = ref(6);
const useGenerative = ref(false);
const annotate = ref(true);
const screenshot = ref(true);

const isWebpage = computed(() => envType.value === 'webpage');

// ── 页面元素（block） ───────────────────────────────────────────────
const blocks = ref<BlockSpecDto[]>([]);
const blocksLoading = ref(false);
const candidateBlockIds = ref<string[]>([]);

const groupedBlocks = computed(() => {
  const order = ['skeleton', 'content', 'interactive'] as const;
  return order
    .map(group => ({
      group,
      label: blocks.value.find(b => b.group === group)?.groupLabel ?? group,
      items: blocks.value.filter(b => b.group === group)
    }))
    .filter(entry => entry.items.length > 0);
});

async function loadBlocks(): Promise<void> {
  blocksLoading.value = true;
  try {
    const result = await api.blocks();
    blocks.value = result.blocks;
    if (candidateBlockIds.value.length === 0) {
      candidateBlockIds.value = result.blocks.map(b => b.id);
    }
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载区块失败');
  } finally {
    blocksLoading.value = false;
  }
}

function toggleBlock(blockId: string, checked: boolean): void {
  const set = new Set(candidateBlockIds.value);
  if (checked) set.add(blockId);
  else set.delete(blockId);
  candidateBlockIds.value = [...set];
}

function toggleGroup(group: string, checked: boolean): void {
  const ids = blocks.value.filter(b => b.group === group).map(b => b.id);
  const set = new Set(candidateBlockIds.value);
  for (const id of ids) {
    if (checked) set.add(id);
    else set.delete(id);
  }
  candidateBlockIds.value = [...set];
}

// ── 新建 block ──────────────────────────────────────────────────────
const blockDialog = ref(false);
const newBlock = ref({ id: '', label: '', group: 'content', description: '' });
const creatingBlock = ref(false);

async function createBlock(): Promise<void> {
  const draft = newBlock.value;
  if (draft.id.trim() === '' || draft.label.trim() === '') {
    message.warning('id 和显示名都要填');
    return;
  }
  creatingBlock.value = true;
  try {
    await fetch('/api/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: draft.id.trim(),
        label: draft.label.trim(),
        description: draft.description.trim() === '' ? draft.label.trim() : draft.description.trim(),
        group: draft.group,
        canLead: false,
        repeatable: true,
        costHint: 'fast',
        // 最小可用形态：一个文本 slot。更复杂的 slot 形态到素材管理页改。
        slots: [{ name: 'text', type: 'text', required: true, description: draft.label.trim() }]
      })
    }).then(async response => {
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error ?? '新建区块失败', response.status);
      }
    });
    message.success(`已加入区块池：${draft.id}`);
    blockDialog.value = false;
    newBlock.value = { id: '', label: '', group: 'content', description: '' };
    await loadBlocks();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '新建区块失败');
  } finally {
    creatingBlock.value = false;
  }
}

// ── 模板 ────────────────────────────────────────────────────────────
const templates = ref<TemplateItem[]>([]);
/** 模板来源：blank（空白，由模型自由决定）/ saved（历史模板）/ new（用当前区块新建）。 */
const templateMode = ref<'blank' | 'saved' | 'new'>('blank');
const templateId = ref<string | undefined>(undefined);
const newTemplateLabel = ref('');

async function loadTemplates(): Promise<void> {
  try {
    const result = await api.templates();
    templates.value = result.templates;
  } catch {
    templates.value = [];
  }
}

/** 提交时真正要带的 templateId：只有选「历史模板」才带。 */
const effectiveTemplateId = computed(() =>
  templateMode.value === 'saved' ? templateId.value : undefined
);

// ── 运行列表 ────────────────────────────────────────────────────────
const runs = ref<RunListItem[]>([]);
const queue = ref<QueueSnapshot | null>(null);
const activeRunId = ref<string | undefined>(
  typeof route.query['runId'] === 'string' ? route.query['runId'] : undefined
);

async function refreshRuns(): Promise<void> {
  try {
    const result = await api.listRuns();
    runs.value = result.runs;
    queue.value = result.queue;
    if (activeRunId.value === undefined && result.runs.length > 0) {
      activeRunId.value = result.runs[0]?.id;
    }
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载运行历史失败');
  }
}

// ── 事件流与视图模型 ────────────────────────────────────────────────
const activeRunIdRef = computed(() => activeRunId.value);
const { events, connection, eventsReset } = useRunStream(activeRunIdRef);
const vm = computed(() => foldEvents(events.value));

const terminal = computed(
  () => vm.value.status !== 'unknown' && ['succeeded', 'failed', 'escalated', 'cancelled'].includes(vm.value.status)
);
const hasStructure = computed(() => vm.value.structure !== undefined);

watch(activeRunId, id => {
  if (id !== undefined) {
    void router.replace({ query: { ...route.query, runId: id } }).catch(() => undefined);
  }
  eventsReset();
  refreshedFor = undefined;
  structureDraft.value = [];
});

let refreshedFor: string | undefined;
watch(
  () => vm.value.status,
  status => {
    const id = activeRunId.value;
    if (id === undefined || refreshedFor === id) return;
    if (!['succeeded', 'failed', 'escalated', 'cancelled'].includes(status)) return;
    refreshedFor = id;
    void refreshRuns();
  }
);

// 结构变化时同步"可编辑草稿"（干涉决策的入口）
const structureDraft = ref<{ id: string; type: string; status: string }[]>([]);
watch(
  () => vm.value.structure?.page.blocks,
  list => {
    if (list !== undefined) {
      structureDraft.value = list.map(b => ({ id: b.id, type: b.type, status: b.status }));
    }
  },
  { immediate: true }
);

// ── 干涉决策：改结构 ────────────────────────────────────────────────
const applyingOps = ref(false);

/** 上移 / 下移 / 删除一个区块。走 ops 接口，只提交最小改动。 */
async function moveBlock(index: number, delta: -1 | 1): Promise<void> {
  const runId = activeRunId.value;
  const target = structureDraft.value[index];
  if (runId === undefined || target === undefined) return;
  const to = index + delta;
  if (to < 0 || to >= structureDraft.value.length) return;
  applyingOps.value = true;
  try {
    const result = await api.structureOps(runId, [
      { op: 'move', blockId: target.id, toIndex: to }
    ]);
    structureDraft.value = result.structure.page.blocks.map(b => ({
      id: b.id,
      type: b.type,
      status: b.status
    }));
    // 后端规范化改了什么要显示出来：静默挪块会让人以为是自己记错了。
    if (result.fixes.length > 0) message.info(result.fixes.join('；'));
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '调整结构失败');
  } finally {
    applyingOps.value = false;
  }
}

async function removeBlock(index: number): Promise<void> {
  const runId = activeRunId.value;
  if (runId === undefined) return;
  applyingOps.value = true;
  try {
    const result = await api.structureOps(runId, [
      { op: 'remove', blockId: structureDraft.value[index]!.id }
    ]);
    structureDraft.value = result.structure.page.blocks.map(b => ({
      id: b.id,
      type: b.type,
      status: b.status
    }));
    message.success('已移除该区块');
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '移除区块失败');
  } finally {
    applyingOps.value = false;
  }
}

// ── 干涉决策：定点重做 ──────────────────────────────────────────────
const redoSelection = ref<string[]>([]);
const redoing = ref(false);

async function redoSelected(): Promise<void> {
  const source = activeRunId.value;
  if (source === undefined || redoSelection.value.length === 0) {
    message.warning('先勾选要重做的区块');
    return;
  }
  redoing.value = true;
  try {
    const result = await api.createRun({
      goal: goal.value.trim() || (vm.value.goal ?? '重做选中的区块'),
      envType: 'webpage',
      provider: provider.value,
      redoFrom: source,
      blockIds: redoSelection.value
    } as never);
    message.success(`已提交重做：${result.runId}`);
    activeRunId.value = result.runId;
    redoSelection.value = [];
    await refreshRuns();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '提交重做失败');
  } finally {
    redoing.value = false;
  }
}

// ── 产物 ────────────────────────────────────────────────────────────
const artifacts = ref<Artifact[]>([]);
const selectedArtifact = ref<string | undefined>(undefined);
const artifactText = ref('');
const artifactLoading = ref(false);

watch(
  () => [activeRunId.value, terminal.value] as const,
  async ([runId, done]) => {
    if (runId === undefined || !done) {
      artifacts.value = [];
      selectedArtifact.value = undefined;
      artifactText.value = '';
      return;
    }
    try {
      const result = await api.listArtifacts(runId);
      artifacts.value = result.artifacts;
      selectedArtifact.value =
        result.artifacts.find(a => isHtmlArtifact(a))?.path ??
        result.artifacts.find(a => isImageArtifact(a))?.path ??
        result.artifacts[0]?.path;
    } catch {
      artifacts.value = [];
    }
  },
  { immediate: true }
);

const activeArtifact = computed(() => artifacts.value.find(a => a.path === selectedArtifact.value));

const artifactView = computed(() => {
  const artifact = activeArtifact.value;
  if (artifact === undefined) return { kind: 'none' as const };
  const url = api.artifactUrl(activeRunId.value ?? '', artifact.path);
  if (isHtmlArtifact(artifact)) return { kind: 'html' as const, url };
  if (isImageArtifact(artifact)) return { kind: 'image' as const, url };
  if (isTextArtifact(artifact)) return { kind: 'text' as const, url };
  return { kind: 'binary' as const, url };
});

watch(
  () => [activeRunId.value, selectedArtifact.value, artifactView.value.kind] as const,
  async ([runId, path, kind]) => {
    if (runId === undefined || path === undefined || kind !== 'text') {
      artifactText.value = '';
      return;
    }
    artifactLoading.value = true;
    try {
      artifactText.value = await api.artifactText(runId, path);
    } catch {
      artifactText.value = '（读取失败）';
    } finally {
      artifactLoading.value = false;
    }
  },
  { immediate: true }
);

// ── 交互测试 ────────────────────────────────────────────────────────
const health = ref<{
  browser?: { screenshot: string; interaction: string };
  defaultProvider?: string;
} | null>(null);
const screenshotReady = computed(() => health.value?.browser?.screenshot === 'chromium');
const interactionReady = computed(() => health.value?.browser?.interaction === 'chromium');

const verifying = ref(false);
const verdict = ref<InteractionVerdict | null>(null);
const verifyError = ref<string | null>(null);

async function runInteractionTest(): Promise<void> {
  const runId = activeRunId.value;
  if (runId === undefined) return;
  verifying.value = true;
  verifyError.value = null;
  verdict.value = null;
  try {
    verdict.value = await api.verifyInteraction(runId);
  } catch (error) {
    if (error instanceof ApiError) {
      verifyError.value =
        error.status === 503
          ? `本机没有浏览器驱动，无法真点击（${error.message}）`
          : error.status === 410
            ? `沙盒已回收，无法再验证（${error.message}）`
            : error.status === 409
              ? `这次运行没有可验证的页面（${error.message}）`
              : error.message;
    } else {
      verifyError.value = '交互测试失败';
    }
  } finally {
    verifying.value = false;
  }
}

// ── 提交 ────────────────────────────────────────────────────────────
const submitting = ref(false);
const submitNote = ref<string | null>(null);
const submitError = ref<string | null>(null);

async function submit(): Promise<void> {
  const trimmed = goal.value.trim();
  if (trimmed === '') {
    message.warning('先写一句目标');
    return;
  }
  submitting.value = true;
  submitError.value = null;
  submitNote.value = null;
  try {
    let template = effectiveTemplateId.value;
    // 「用当前区块新建模板」：先把勾选的区块存成模板，再用它跑这一单。
    if (templateMode.value === 'new' && isWebpage.value) {
      const label = newTemplateLabel.value.trim();
      if (label === '') {
        submitError.value = '给新模板起个名字，或者改选「空白」';
        submitting.value = false;
        return;
      }
      const created = await api.createTemplate({
        label,
        blocks: candidateBlockIds.value.map(type => ({ type }))
      });
      template = created.template.id;
      await loadTemplates();
      message.success(`已保存模板：${label}`);
    }

    const result = await api.createRun({
      goal: trimmed,
      envType: envType.value,
      provider: provider.value,
      ...(isWebpage.value
        ? {
            candidateBlockIds: candidateBlockIds.value.length > 0 ? candidateBlockIds.value : undefined,
            maxBlocks: maxBlocks.value,
            useGenerative: useGenerative.value,
            annotate: annotate.value,
            screenshot: screenshot.value,
            ...(template !== undefined ? { templateId: template } : {})
          }
        : {})
    });
    activeRunId.value = result.runId;
    await refreshRuns();
    submitNote.value =
      result.queuePosition !== undefined
        ? `已排队，第 ${result.queuePosition} 位，轮到时自动开始`
        : `已提交：${result.runId}`;
  } catch (error) {
    submitError.value = error instanceof ApiError ? error.message : '提交失败';
  } finally {
    submitting.value = false;
  }
}

async function cancel(): Promise<void> {
  const runId = activeRunId.value;
  if (runId === undefined) return;
  try {
    await api.cancelRun(runId);
    message.success('已请求取消');
    await refreshRuns();
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '取消失败');
  }
}

// ── 步骤导航 ────────────────────────────────────────────────────────
interface StepNavItem {
  readonly key: string;
  readonly no: number;
  readonly label: string;
  readonly enabled: boolean;
}

const stepNav = computed<StepNavItem[]>(() => [
  { key: 'goal', no: 1, label: '创作目标', enabled: true },
  { key: 'decisions', no: 2, label: '模型决策', enabled: true },
  { key: 'interaction', no: 3, label: '模型交互测试', enabled: hasStructure.value && terminal.value },
  { key: 'result', no: 4, label: '结果展示', enabled: true }
]);

const activeStep = ref('goal');
const sectionRefs = new Map<string, HTMLElement>();

function setSectionRef(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) sectionRefs.set(key, el);
  else sectionRefs.delete(key);
}

function scrollToStep(key: string): void {
  sectionRefs.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let observer: IntersectionObserver | undefined;

const connectionLabel = computed(
  () => ({ connecting: '连接中', open: '实时通道已连接', closed: '已断开，重连中' })[connection.value]
);

function stepType(status: string): 'default' | 'info' | 'success' | 'error' | 'warning' {
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

const templateOptions = computed(() =>
  templates.value.map(t => ({
    label: `${t.label}${t.builtin ? '' : '（自建）'}`,
    value: t.id
  }))
);

const runOptions = computed(() =>
  runs.value.map(r => ({
    label: `${r.id.slice(-6)} · ${r.goal.slice(0, 24)} · ${STATUS_STYLE[r.status].label}`,
    value: r.id
  }))
);

onMounted(async () => {
  try {
    health.value = await api.health();
    const provider0 = health.value.defaultProvider;
    if (provider0 === 'local' || provider0 === 'docker') provider.value = provider0;
  } catch {
    /* 能力未知时界面按"占位图"提示 */
  }
  await Promise.all([refreshRuns(), loadBlocks(), loadTemplates()]);

  observer = new IntersectionObserver(
    entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const key = visible?.target.getAttribute('data-step');
      if (key !== null && key !== undefined) activeStep.value = key;
    },
    { rootMargin: '-64px 0px -55% 0px', threshold: 0 }
  );
  for (const el of sectionRefs.values()) observer.observe(el);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="wb">
    <!-- 步骤导航（吸顶） -->
    <nav
      class="wb__nav"
      :style="{
        backgroundColor: themeVars.cardColor,
        borderBottomColor: themeVars.dividerColor
      }"
    >
      <button
        v-for="step in stepNav"
        :key="step.key"
        type="button"
        class="wb__nav-item"
        :class="{
          'wb__nav-item--active': activeStep === step.key,
          'wb__nav-item--disabled': !step.enabled
        }"
        :disabled="!step.enabled"
        @click="scrollToStep(step.key)"
      >
        <span class="wb__nav-no">{{ step.no }}</span>
        <span>{{ step.label }}</span>
      </button>
      <span class="wb__nav-spacer" />
      <NTag size="small" :type="connection === 'open' ? 'success' : 'warning'">
        {{ connectionLabel }}
      </NTag>
    </nav>

    <!-- ① 创作目标 -->
    <NCard :ref="el => setSectionRef('goal', el)" data-step="goal" size="small" :bordered="false" class="wb__card">
      <template #header>
        <span class="wb__no">1</span>
        <span>创作目标</span>
      </template>

      <label class="wb__field">
        <span class="wb__label">目标描述</span>
        <NInput
          v-model:value="goal"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          placeholder="例如：做一个中文产品介绍落地页，包含首屏、特性与行动号召"
          @keydown.ctrl.enter.prevent="submit"
        />
      </label>

      <div class="wb__row">
        <label class="wb__field wb__field--half">
          <span class="wb__label">目标类型</span>
          <NSelect
            v-model:value="envType"
            size="small"
            :options="TARGET_TYPES.map(t => ({ label: t.label, value: t.value }))"
          />
          <span class="wb__hint">{{ TARGET_TYPES.find(t => t.value === envType)?.hint }}</span>
        </label>
        <label class="wb__field wb__field--half">
          <span class="wb__label">沙盒</span>
          <NSelect
            v-model:value="provider"
            size="small"
            :options="[
              { label: 'docker（容器级隔离）', value: 'docker' },
              { label: 'local（路径级隔离）', value: 'local' }
            ]"
          />
        </label>
      </div>

      <template v-if="isWebpage">
        <!-- 页面元素 -->
        <div class="wb__section">
          <div class="wb__section-head">
            <span class="wb__label">页面元素</span>
            <span class="wb__hint">{{ candidateBlockIds.length }} / {{ blocks.length }} 已选</span>
            <NButton text size="tiny" @click="blockDialog = true">新建区块</NButton>
          </div>
          <NSpin :show="blocksLoading">
            <div v-for="entry in groupedBlocks" :key="entry.group" class="wb__group">
              <div class="wb__group-head">
                <span>{{ entry.label }}</span>
                <NButton
                  text
                  size="tiny"
                  @click="toggleGroup(entry.group, entry.items.some(i => !candidateBlockIds.includes(i.id)))"
                >
                  {{ entry.items.some(i => !candidateBlockIds.includes(i.id)) ? '全选' : '清空' }}
                </NButton>
              </div>
              <div class="wb__blocks">
                <NCheckbox
                  v-for="block in entry.items"
                  :key="block.id"
                  :checked="candidateBlockIds.includes(block.id)"
                  size="small"
                  @update:checked="checked => toggleBlock(block.id, checked)"
                >
                  {{ block.label }}
                  <span class="wb__block-id">{{ block.id }}</span>
                  <NTag v-if="block.costHint === 'slow'" size="tiny" type="warning">慢</NTag>
                  <NTag v-if="!block.repeatable" size="tiny">仅一次</NTag>
                </NCheckbox>
              </div>
            </div>
          </NSpin>
        </div>

        <!-- 模板 -->
        <div class="wb__section">
          <span class="wb__label">模板</span>
          <NRadioGroup v-model:value="templateMode" size="small" class="wb__radios">
            <NRadio value="blank">空白（模型自己排）</NRadio>
            <NRadio value="saved">历史模板</NRadio>
            <NRadio value="new">新建模板</NRadio>
          </NRadioGroup>

          <div v-if="templateMode === 'saved'" class="wb__template-body">
            <NSelect
              v-model:value="templateId"
              size="small"
              clearable
              placeholder="选一套起手结构"
              :options="templateOptions"
            />
            <span v-if="templates.length === 0" class="wb__hint">还没有模板，可以先选「空白」</span>
          </div>
          <div v-else-if="templateMode === 'new'" class="wb__template-body">
            <NInput
              v-model:value="newTemplateLabel"
              size="small"
              placeholder="给这套结构起个名字，提交时会存进模板池"
            />
          </div>
        </div>
      </template>

      <div class="wb__actions">
        <NButton type="primary" :loading="submitting" @click="submit">开始创作</NButton>
        <NButton v-if="activeRunId && !terminal" type="error" secondary @click="cancel">取消运行</NButton>
        <label class="wb__inline">
          <NSelect
            v-model:value="activeRunId"
            size="small"
            clearable
            placeholder="查看历史运行"
            :options="runOptions"
            class="wb__run-select"
          />
        </label>
      </div>
      <NAlert v-if="submitNote" type="info" :bordered="false" class="mt-2" closable>
        {{ submitNote }}
      </NAlert>
      <NAlert v-if="submitError" type="error" :bordered="false" class="mt-2">{{ submitError }}</NAlert>
    </NCard>

    <!-- ② 模型决策 -->
    <NCard
      :ref="el => setSectionRef('decisions', el)"
      data-step="decisions"
      size="small"
      :bordered="false"
      class="wb__card"
    >
      <template #header>
        <span class="wb__no">2</span>
        <span>模型决策</span>
        <span v-if="vm.goal" class="wb__hint">{{ vm.goal }}</span>
      </template>

      <div v-if="vm.rationale.length === 0" class="wb__empty">
        {{ activeRunId === undefined ? '还没有运行。先在上一步提交目标' : '等待模型给出结构' }}
      </div>
      <template v-else>
        <ul class="wb__rationale">
          <li v-for="(line, index) in vm.rationale" :key="index">{{ line }}</li>
        </ul>
        <NAlert v-if="vm.reason" type="warning" :bordered="false" class="mt-2">{{ vm.reason }}</NAlert>

        <!-- 干涉：改结构 -->
        <div v-if="structureDraft.length > 0" class="wb__section">
          <div class="wb__section-head">
            <span class="wb__label">结构（可改）</span>
            <span class="wb__hint">上移 / 下移 / 删除会立即保存到这次运行</span>
          </div>
          <ol class="wb__structure">
            <li v-for="(block, index) in structureDraft" :key="block.id" class="wb__structure-item">
              <NTag size="tiny" :type="block.status === 'filled' ? 'success' : 'default'">
                {{ block.type }}
              </NTag>
              <span class="wb__block-id">{{ block.id }}</span>
              <span class="wb__structure-ops">
                <NButton text size="tiny" :disabled="index === 0 || applyingOps" @click="moveBlock(index, -1)">
                  上移
                </NButton>
                <NButton
                  text
                  size="tiny"
                  :disabled="index === structureDraft.length - 1 || applyingOps"
                  @click="moveBlock(index, 1)"
                >
                  下移
                </NButton>
                <NButton text size="tiny" type="error" :disabled="applyingOps" @click="removeBlock(index)">
                  删除
                </NButton>
              </span>
            </li>
          </ol>

          <!-- 干涉：定点重做 -->
          <div class="wb__section-head">
            <span class="wb__label">只重做选中的区块</span>
          </div>
          <div class="wb__blocks">
            <NCheckbox
              v-for="block in structureDraft"
              :key="`redo-${block.id}`"
              :checked="redoSelection.includes(block.id)"
              size="small"
              @update:checked="checked => {
                const set = new Set(redoSelection)
                if (checked) set.add(block.id)
                else set.delete(block.id)
                redoSelection = [...set]
              }"
            >
              {{ block.type }} {{ block.id }}
            </NCheckbox>
          </div>
          <NButton size="tiny" secondary :loading="redoing" class="mt-2" @click="redoSelected">
            重做选中区块
          </NButton>
        </div>

        <!-- 执行步骤 -->
        <div v-if="vm.current && vm.current.nodes.length > 0" class="wb__section">
          <span class="wb__label">执行步骤</span>
          <ol class="wb__steps">
            <li v-for="node in vm.current.nodes" :key="node.nodeId" class="wb__step">
              <NTag size="tiny" :type="stepType(node.status)">{{ node.status }}</NTag>
              <span class="wb__step-tool">{{ node.toolId }}</span>
              <span class="wb__step-note">{{ node.note }}</span>
              <div v-if="node.summary" class="wb__step-summary">{{ node.summary }}</div>
              <div v-if="node.error" class="wb__step-error">{{ node.error }}</div>
            </li>
          </ol>
        </div>
      </template>
    </NCard>

    <!-- ③ 模型交互测试 -->
    <NCard
      v-if="hasStructure && terminal"
      :ref="el => setSectionRef('interaction', el)"
      data-step="interaction"
      size="small"
      :bordered="false"
      class="wb__card"
    >
      <template #header>
        <span class="wb__no">3</span>
        <span>模型交互测试</span>
      </template>
      <p class="wb__note">
        用真浏览器打开页面并点击一个元素，由代码判断点击后有没有变化。
        {{ interactionReady ? '' : '本机没有浏览器驱动时，接口返回 503。' }}
      </p>
      <NButton size="small" :loading="verifying" :disabled="activeRunId === undefined" @click="runInteractionTest">
        开始交互测试
      </NButton>
      <NAlert v-if="verifyError" type="error" :bordered="false" class="mt-2">{{ verifyError }}</NAlert>
      <div v-if="verdict" class="mt-2">
        <NTag :type="verdict.passed ? 'success' : 'warning'" size="small">
          {{ verdict.passed ? '通过' : verdict.targetCount === 0 ? '未做验证' : '未通过' }}
        </NTag>
        <span class="wb__verdict">{{ verdict.detail }}</span>
        <ul v-if="(verdict.attempts?.length ?? 0) > 0" class="wb__attempts">
          <li v-for="(line, index) in verdict.attempts ?? []" :key="index">{{ line }}</li>
        </ul>
        <img
          v-if="verdict.screenshotPath"
          :src="api.artifactUrl(activeRunId ?? '', verdict.screenshotPath)"
          class="wb__click-shot"
          alt="点击后截图"
        />
      </div>
    </NCard>

    <!-- ④ 结果展示 -->
    <NCard
      :ref="el => setSectionRef('result', el)"
      data-step="result"
      size="small"
      :bordered="false"
      class="wb__card"
    >
      <template #header>
        <span class="wb__no">4</span>
        <span>结果展示</span>
        <span class="wb__hint">{{ artifacts.length }} 个文件</span>
      </template>
      <div v-if="artifacts.length === 0" class="wb__empty">还没有产物</div>
      <template v-else>
        <div class="wb__tabs">
          <button
            v-for="artifact in artifacts"
            :key="artifact.path"
            type="button"
            class="wb__tab"
            :class="{ 'wb__tab--active': artifact.path === selectedArtifact }"
            @click="selectedArtifact = artifact.path"
          >
            {{ artifact.path.replace('artifacts/', '') }}
          </button>
        </div>
        <div class="wb__preview">
          <iframe
            v-if="artifactView.kind === 'html'"
            :src="artifactView.url"
            class="wb__frame"
            sandbox="allow-scripts"
            title="产物预览"
          />
          <img v-else-if="artifactView.kind === 'image'" :src="artifactView.url" class="wb__image" alt="产物" />
          <NSpin v-else-if="artifactLoading" size="small" />
          <pre v-else-if="artifactView.kind === 'text'" class="wb__code">{{ artifactText }}</pre>
          <div v-else class="wb__empty">这个文件不适合在页面里预览，请下载后查看</div>
        </div>
      </template>
    </NCard>

    <!-- 新建区块 -->
    <NDialog v-model:show="blockDialog" title="新建区块" preset="card" style="width: 460px">
      <div class="wb__dialog">
        <label class="wb__field">
          <span class="wb__label">id（进 HTML 属性与文件名，只能用字母数字和 - _ .）</span>
          <NInput v-model:value="newBlock.id" size="small" placeholder="例如 price-table" />
        </label>
        <label class="wb__field">
          <span class="wb__label">显示名</span>
          <NInput v-model:value="newBlock.label" size="small" placeholder="例如 价格表" />
        </label>
        <label class="wb__field">
          <span class="wb__label">分组</span>
          <NSelect
            v-model:value="newBlock.group"
            size="small"
            :options="[
              { label: '页面骨架', value: 'skeleton' },
              { label: '内容块', value: 'content' },
              { label: '交互块', value: 'interactive' }
            ]"
          />
        </label>
        <label class="wb__field">
          <span class="wb__label">说明（可留空）</span>
          <NInput v-model:value="newBlock.description" size="small" />
        </label>
        <p class="wb__hint">
          新建的区块先带一个文本 slot；更复杂的 slot 到「项目与产物」里的素材管理改。
        </p>
        <div class="wb__dialog-actions">
          <NButton size="small" @click="blockDialog = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creatingBlock" @click="createBlock">创建</NButton>
        </div>
      </div>
    </NDialog>
  </div>
</template>

<style scoped>
.wb {
  max-width: 1080px;
  margin: 0 auto;
  padding-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 吸顶步骤导航 ─────────────────────────────────────────────── */
.wb__nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 4px;
  /* 背景色由内联样式按主题给，这里只留布局 */
  border-bottom: 1px solid transparent;
}

.wb__nav-spacer {
  flex: 1;
}

.wb__nav-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

.wb__nav-item:hover:not(:disabled) {
  background: var(--n-action-color);
}

.wb__nav-item--active {
  color: var(--n-color-target);
  border-color: var(--n-color-target);
}

.wb__nav-item--disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.wb__nav-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  background: var(--n-action-color);
}

.wb__nav-item--active .wb__nav-no {
  background: var(--n-color-target);
  color: #fff;
}

/* ── 卡片与段落 ───────────────────────────────────────────────── */
.wb__card {
  width: 100%;
  scroll-margin-top: 52px;
}

.wb__no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 8px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: var(--n-color-target);
}

.wb__row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}

.wb__field {
  display: block;
  flex: 1;
  min-width: 200px;
  margin-top: 10px;
}

.wb__field--half {
  flex: 1 1 calc(50% - 6px);
}

.wb__label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--n-text-color-3);
}

.wb__hint {
  margin-left: 6px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.wb__section {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--n-border-color);
}

.wb__section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.wb__group + .wb__group {
  margin-top: 8px;
}

.wb__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  padding-bottom: 3px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--n-border-color);
}

.wb__blocks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.wb__block-id {
  margin-left: 6px;
  font-family: monospace;
  font-size: 10px;
  color: var(--n-text-color-3);
}

.wb__radios {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
}

.wb__template-body {
  margin-top: 8px;
  max-width: 420px;
}

.wb__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.wb__run-select {
  width: 260px;
}

.wb__empty {
  padding: 12px;
  font-size: 12px;
  text-align: center;
  color: var(--n-text-color-3);
}

/* ── 决策过程 ─────────────────────────────────────────────────── */
.wb__rationale {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
}

/* ── 结构编辑 ─────────────────────────────────────────────────── */
.wb__structure {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wb__structure-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  font-size: 12px;
  border-radius: 4px;
  background: var(--n-action-color);
}

.wb__structure-ops {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

/* ── 执行步骤 ─────────────────────────────────────────────────── */
.wb__steps {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wb__step {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.wb__step-tool {
  font-family: monospace;
}

.wb__step-note {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.wb__step-summary,
.wb__step-error {
  flex-basis: 100%;
  padding-left: 8px;
  font-size: 11px;
  border-left: 2px solid var(--n-border-color);
  color: var(--n-text-color-2);
}

.wb__step-error {
  border-left-color: #d03050;
  color: #d03050;
}

/* ── 交互测试 ─────────────────────────────────────────────────── */
.wb__note {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-text-color-3);
}

.wb__verdict {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--n-text-color-2);
}

.wb__attempts {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.wb__click-shot {
  margin-top: 8px;
  max-width: 100%;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
}

/* ── 结果展示 ─────────────────────────────────────────────────── */
.wb__tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  overflow-x: auto;
  border-bottom: 1px solid var(--n-border-color);
}

.wb__tab {
  border: none;
  background: transparent;
  padding: 2px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

.wb__tab--active {
  background: var(--n-action-color);
  color: var(--n-text-color-1);
}

.wb__preview {
  min-height: 420px;
}

.wb__frame {
  width: 100%;
  height: 640px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
  background: #fff;
}

.wb__image {
  max-width: 100%;
  border-radius: 4px;
}

.wb__code {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.wb__dialog {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wb__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
