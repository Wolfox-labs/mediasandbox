<script setup lang="ts">
/**
 * 创作工作台（Vue 版）。
 *
 * 三栏布局，与 React 版功能等价：
 *   左：创作目标 / 环境 / 结构化参数 / 运行历史
 *   中：决策过程（组装依据）/ 页面结构 / 交互验证 / 执行步骤
 *   右：block 候选池（仅结构化）/ 实时预览
 *
 * ## 为什么自己写这页而不是套模板的示例页
 *
 * 模板的 `home` 是图表仪表盘，与本项目"看决策过程"的核心诉求无关。
 * 这里保留模板的布局外壳（侧边栏/面包屑/主题/暗色模式）与 Naive UI 组件，
 * 但页面结构按业务来。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NInput,
  NProgress,
  NSelect,
  NSkeleton,
  NSpin,
  NStatistic,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { api, ApiError, isHtmlArtifact, isImageArtifact, isTextArtifact } from '@/api/client';
import {
  ENV_LABELS,
  UI_ENV_TYPES,
  isTerminal,
  type Artifact,
  type BlockSpecDto,
  type EnvType,
  type HealthResponse,
  type InteractionVerdict,
  type QueueSnapshot,
  type RunListItem
} from '@/api/types';
import { STATUS_STYLE } from '@/utils/format';
import { useRunStream } from '@/composables/use-run-stream';
import { foldEvents } from '@/state/run-view-model';

defineOptions({ name: 'Workbench' });

const message = useMessage();

/** URL 里的深链：`#/workbench?runId=xxx` 也能直接打开某次运行。 */
const route = useRoute();
const router = useRouter();
const deepLinkRunId = computed(() => {
  const value = route.query['runId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
});

// ── 提交表单 ────────────────────────────────────────────────────────
const goal = ref('做一个中文产品介绍落地页，包含首屏、特性与行动号召');
const envType = ref<EnvType>('webpage');
const provider = ref<'docker' | 'local'>('docker');
const maxBlocks = ref(6);
const useGenerative = ref(false);
const annotate = ref(true);
/** 截图开关。默认开：这是演示的主要看点之一。 */
const screenshot = ref(true);
const candidateBlockIds = ref<string[]>([]);
const submitting = ref(false);
const submitNote = ref<string | null>(null);
const submitError = ref<string | null>(null);

const envOptions = UI_ENV_TYPES.map(env => ({
  label: ENV_LABELS[env].label,
  value: env,
  /** 提示放在 label 下方的说明里，select 不支持富文本，这里靠 title 兜底 */
  title: ENV_LABELS[env].hint
}));

// ── 服务能力 ────────────────────────────────────────────────────────
const health = ref<HealthResponse | null>(null);
const screenshotReady = computed(() => health.value?.browser?.screenshot === 'chromium');
const interactionReady = computed(() => health.value?.browser?.interaction === 'chromium');

// ── block 候选池 ────────────────────────────────────────────────────
const blocks = ref<BlockSpecDto[]>([]);
const blocksLoading = ref(false);
const isWebpage = computed(() => envType.value === 'webpage');

async function loadBlocks(): Promise<void> {
  blocksLoading.value = true;
  try {
    const { blocks: list } = await api.blocks();
    blocks.value = list;
    // 默认全选：演示时要的是"能出东西"，逐个勾选反而是负担。
    candidateBlockIds.value = list.map(b => b.id);
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载 block 池失败');
  } finally {
    blocksLoading.value = false;
  }
}

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

function toggleGroup(group: string, checked: boolean): void {
  const ids = blocks.value.filter(b => b.group === group).map(b => b.id);
  const set = new Set(candidateBlockIds.value);
  for (const id of ids) {
    if (checked) set.add(id);
    else set.delete(id);
  }
  candidateBlockIds.value = [...set];
}

/**
 * 单个 block 的勾选。
 *
 * 不用 `v-model:checked` + `:value` 绑数组：NCheckbox 的单选只支持 boolean，
 * 数组绑定要靠 NCheckboxGroup。这里显式改数组更直白，也便于和"按组全选"共用逻辑。
 */
function toggleBlock(blockId: string, checked: boolean): void {
  const set = new Set(candidateBlockIds.value);
  if (checked) set.add(blockId);
  else set.delete(blockId);
  candidateBlockIds.value = [...set];
}

// ── 运行列表 ────────────────────────────────────────────────────────
const runs = ref<RunListItem[]>([]);
const queue = ref<QueueSnapshot | null>(null);
const activeRunId = ref<string | undefined>(deepLinkRunId.value);

function normalizeProvider(value: string): 'docker' | 'local' {
  return value === 'docker' ? 'docker' : 'local';
}

async function refreshRuns(): Promise<void> {
  try {
    const result = await api.listRuns();
    runs.value = result.runs;
    queue.value = result.queue;
    if (activeRunId.value === undefined && result.runs.length > 0) {
      activeRunId.value = result.runs[0]?.id;
    }
  } catch (error) {
    // 运行列表拉不到时不要打断页面——工作台的主线是"提交并观察"，
    // 历史只是辅助。把原因说清楚即可。
    message.error(error instanceof ApiError ? error.message : '加载运行历史失败');
  }
}

// ── 事件流与视图模型 ────────────────────────────────────────────────
const activeRunIdRef = computed(() => activeRunId.value);
const { events, connection, eventsReset } = useRunStream(activeRunIdRef);
const vm = computed(() => foldEvents(events.value));

watch(activeRunId, id => {
  if (id !== undefined) {
    // 用 router.replace 而不是 route.replace：后者是"当前路由对象"，
    // 没有导航方法。写错会在运行时报错而不是编译期，所以这里显式用 router。
    void router
      .replace({ query: { ...route.query, runId: id } })
      .catch(() => undefined);
  }
  eventsReset();
  refreshedFor = undefined;
});

/** 终态后只刷新一次列表，避免事件流抖动导致反复请求。 */
let refreshedFor: string | undefined;
watch(
  () => vm.value.status,
  status => {
    if (activeRunId.value === undefined) return;
    if (!isTerminal(status)) return;
    if (refreshedFor === activeRunId.value) return;
    refreshedFor = activeRunId.value;
    void refreshRuns();
  }
);

const hasStructure = computed(() => vm.value.structure !== undefined);
const terminal = computed(() => isTerminal(vm.value.status));

// ── 产物 ────────────────────────────────────────────────────────────
const artifacts = ref<Artifact[]>([]);
const selectedArtifact = ref<string | undefined>(undefined);
const artifactText = ref<string>('');
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
      const { artifacts: list } = await api.listArtifacts(runId);
      artifacts.value = list;
      const preferred =
        list.find(a => isHtmlArtifact(a))?.path ??
        list.find(a => isImageArtifact(a))?.path ??
        list[0]?.path;
      selectedArtifact.value = preferred;
    } catch {
      artifacts.value = [];
    }
  },
  { immediate: true }
);

const activeArtifact = computed(() =>
  artifacts.value.find(a => a.path === selectedArtifact.value)
);

const artifactView = computed(() => {
  const artifact = activeArtifact.value;
  if (artifact === undefined) return { kind: 'none' as const };
  if (isHtmlArtifact(artifact)) {
    return {
      kind: 'html' as const,
      url: api.artifactUrl(activeRunId.value ?? '', artifact.path)
    };
  }
  if (isImageArtifact(artifact)) {
    return {
      kind: 'image' as const,
      url: api.artifactUrl(activeRunId.value ?? '', artifact.path)
    };
  }
  if (isTextArtifact(artifact)) return { kind: 'text' as const };
  return { kind: 'binary' as const };
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
    } catch (error) {
      artifactText.value = error instanceof ApiError ? `（${error.message}）` : '（读取失败）';
    } finally {
      artifactLoading.value = false;
    }
  },
  { immediate: true }
);

// ── 交互验证 ────────────────────────────────────────────────────────
const verifying = ref(false);
const verdict = ref<InteractionVerdict | null>(null);
const verifyError = ref<string | null>(null);

async function verifyInteraction(): Promise<void> {
  const runId = activeRunId.value;
  if (runId === undefined) return;
  verifying.value = true;
  verifyError.value = null;
  verdict.value = null;
  try {
    verdict.value = await api.verifyInteraction(runId);
  } catch (error) {
    if (error instanceof ApiError) {
      // 状态码本身就是信息：503 = 本机点不了，410 = 沙盒已回收，409 = 没有可点页面。
      verifyError.value =
        error.status === 503
          ? `本机没有浏览器驱动，无法真点击（${error.message}）`
          : error.status === 410
            ? `沙盒已回收，无法再验证（${error.message}）`
            : error.status === 409
              ? `这次运行没有可验证的页面（${error.message}）`
              : error.message;
    } else {
      verifyError.value = '交互验证失败（未知错误）';
    }
  } finally {
    verifying.value = false;
  }
}

// ── 提交与取消 ──────────────────────────────────────────────────────
async function submit(): Promise<void> {
  const trimmed = goal.value.trim();
  if (trimmed === '') {
    message.warning('先写一个创作目标');
    return;
  }
  submitting.value = true;
  submitError.value = null;
  submitNote.value = null;
  try {
    const result = await api.createRun({
      goal: trimmed,
      envType: envType.value,
      provider: provider.value,
      ...(envType.value === 'webpage'
        ? {
            candidateBlockIds:
              candidateBlockIds.value.length > 0 ? candidateBlockIds.value : undefined,
            maxBlocks: maxBlocks.value,
            useGenerative: useGenerative.value,
            annotate: annotate.value,
            screenshot: screenshot.value
          }
        : {})
    });
    activeRunId.value = result.runId;
    await refreshRuns();
    submitNote.value =
      result.queuePosition !== undefined
        ? `已排入队列，当前第 ${result.queuePosition} 位；轮到时自动开始，不需要重新提交`
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

/** 步骤的展示图标：状态一眼可见。 */
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


/* ── 步骤导航 ────────────────────────────────────────────────────────
 *
 * 单列布局下页面很长，没有导航就不知道"还剩几步、现在在哪"。
 * 这里定义八个步骤，每个对应下面一个 section；`enabled` 决定它是否可点，
 * 不适用的步骤保持可见但禁用（而不是消失——步数会变，反而容易迷路）。
 */
interface StepNavItem {
  readonly key: string;
  readonly no: number;
  readonly label: string;
  readonly enabled: boolean;
}

const stepNav = computed<StepNavItem[]>(() => [
  { key: 'goal', no: 1, label: '创作目标', enabled: true },
  { key: 'blocks', no: 2, label: '选择区块', enabled: isWebpage.value },
  { key: 'history', no: 3, label: '运行历史', enabled: true },
  { key: 'decisions', no: 4, label: '决策过程', enabled: true },
  { key: 'structure', no: 5, label: '页面结构', enabled: hasStructure.value },
  { key: 'steps', no: 6, label: '执行步骤', enabled: true },
  {
    key: 'verify',
    no: 7,
    label: '交互验证',
    enabled: hasStructure.value && terminal.value
  },
  { key: 'artifacts', no: 8, label: '产物', enabled: true }
]);

/** 当前视口内的步骤（吸顶导航高亮用）。 */
const activeStep = ref<string>('goal');

/** 每个 section 的 DOM，供点击跳转与观察器使用。 */
const sectionRefs = new Map<string, HTMLElement>();
function setSectionRef(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) sectionRefs.set(key, el);
  else sectionRefs.delete(key);
}

/** 点击导航：滚到对应段落。 */
function scrollToStep(key: string): void {
  sectionRefs.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 用 IntersectionObserver 跟踪当前段落。
 *
 * 用观察器而不是监听 scroll 自己算位置：滚动时算偏移容易和吸顶导航的高度
 * 打架，而观察器只需一个"哪块露出来了"的判定，几何细节交给浏览器。
 */
let observer: IntersectionObserver | undefined;
onMounted(() => {
  observer = new IntersectionObserver(
    entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const key = visible?.target.getAttribute('data-step');
      if (key !== null && key !== undefined) activeStep.value = key;
    },
    // 顶部留出吸顶导航的高度，底部收窄，避免同时命中多段时来回跳。
    { rootMargin: '-64px 0px -60% 0px', threshold: 0 }
  );
  for (const el of sectionRefs.values()) observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());

const connectionLabel = computed(
  () => ({ connecting: '连接中', open: '实时通道已连接', closed: '已断开，重连中' })[connection.value]
);

onMounted(async () => {
  try {
    health.value = await api.health();
    provider.value = normalizeProvider(health.value.defaultProvider);
  } catch {
    // 健康检查失败不阻塞页面：界面会照实显示"未知能力"。
  }
  await Promise.all([refreshRuns(), loadBlocks()]);
});
</script>

<template>
  <div class="workbench">
    <!-- 步骤导航（吸顶） -->
    <nav class="workbench__nav">
      <button
        v-for="step in stepNav"
        :key="step.key"
        type="button"
        class="workbench__nav-item"
        :class="{
          'workbench__nav-item--active': activeStep === step.key,
          'workbench__nav-item--disabled': !step.enabled
        }"
        :disabled="!step.enabled"
        @click="scrollToStep(step.key)"
      >
        <span class="workbench__nav-no">{{ step.no }}</span>
        <span>{{ step.label }}</span>
      </button>
    </nav>

    <!-- ① 创作目标 -->
    <NCard :ref="el => setSectionRef('goal', el)" data-step="goal" size="small" :bordered="false" class="workbench__card">
      <template #header>
        <span class="workbench__step-no">1</span>
        <span>创作目标</span>
      </template>

      <NInput
        v-model:value="goal"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder="描述你想做的作品（Ctrl+Enter 提交）"
        @keydown.ctrl.enter.prevent="submit"
      />

      <div class="workbench__row">
        <label class="workbench__field">
          <span class="workbench__label">环境类型</span>
          <NSelect v-model:value="envType" :options="envOptions" size="small" />
        </label>
        <label class="workbench__field">
          <span class="workbench__label">沙盒 provider</span>
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
        <div class="workbench__field workbench__field--mt">
          <span class="workbench__label">block 数上限：{{ maxBlocks }}</span>
          <input v-model.number="maxBlocks" type="range" min="1" max="12" class="w-full" />
        </div>
        <div class="workbench__checks">
          <NCheckbox v-model:checked="useGenerative" size="small">
            文案走生成层
            <span class="workbench__hint">关闭时全部确定性填充，零成本，可复现</span>
          </NCheckbox>
          <NCheckbox v-model:checked="annotate" size="small">
            在页面上标注来源
            <span class="workbench__hint">每块显示 id、状态和填充来源</span>
          </NCheckbox>
          <NCheckbox v-model:checked="screenshot" size="small">
            截图
            <span class="workbench__hint">
              {{
                screenshotReady
                  ? '产出 artifacts/screenshot.png，真 chromium 渲染，多花 3 到 10 秒'
                  : '当前服务没有浏览器驱动，产出的是占位图'
              }}
            </span>
          </NCheckbox>
        </div>
      </template>

      <div class="workbench__actions">
        <NButton type="primary" :loading="submitting" @click="submit">开始创作</NButton>
        <NButton v-if="activeRunId && !terminal" type="error" secondary @click="cancel">
          取消运行
        </NButton>
        <NTag size="small" :type="connection === 'open' ? 'success' : 'warning'">
          {{ connectionLabel }}
        </NTag>
      </div>
      <NAlert v-if="submitNote" type="info" :bordered="false" class="mt-2" closable>
        {{ submitNote }}
      </NAlert>
      <NAlert v-if="submitError" type="error" :bordered="false" class="mt-2">
        {{ submitError }}
      </NAlert>
    </NCard>

    <!-- ② 选择区块 -->
    <NCard
      v-if="isWebpage"
      :ref="el => setSectionRef('blocks', el)"
      data-step="blocks"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">2</span>
        <span>选择区块</span>
        <span class="workbench__hint">{{ candidateBlockIds.length }} 个已选</span>
      </template>
      <NSpin :show="blocksLoading">
        <div v-for="entry in groupedBlocks" :key="entry.group" class="workbench__group">
          <div class="workbench__group-head">
            <span>{{ entry.label }}</span>
            <NButton
              text
              size="tiny"
              @click="toggleGroup(entry.group, entry.items.some(i => !candidateBlockIds.includes(i.id)))"
            >
              {{ entry.items.some(i => !candidateBlockIds.includes(i.id)) ? '全选' : '清空' }}
            </NButton>
          </div>
          <div class="workbench__blocks">
            <NCheckbox
              v-for="block in entry.items"
              :key="block.id"
              :checked="candidateBlockIds.includes(block.id)"
              size="small"
              @update:checked="checked => toggleBlock(block.id, checked)"
            >
              {{ block.label }}
              <span class="workbench__block-id">{{ block.id }}</span>
              <NTag v-if="block.costHint === 'slow'" size="tiny" type="warning">慢</NTag>
              <NTag v-if="block.canLead" size="tiny">可作首块</NTag>
              <NTag v-if="!block.repeatable" size="tiny">仅一次</NTag>
            </NCheckbox>
          </div>
        </div>
      </NSpin>
    </NCard>

    <!-- ③ 运行历史 -->
    <NCard
      :ref="el => setSectionRef('history', el)"
      data-step="history"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">3</span>
        <span>运行历史</span>
        <NButton text size="tiny" class="ml-2" @click="refreshRuns">刷新</NButton>
      </template>
      <template #header-extra>
        <span v-if="queue && queue.waiting > 0" class="workbench__hint">
          队列 {{ queue.running }}/{{ queue.maxConcurrent }} 在跑，{{ queue.waiting }} 个在排
        </span>
      </template>
      <div v-if="runs.length === 0" class="workbench__empty">还没有运行记录</div>
      <div v-else class="workbench__runs">
        <button
          v-for="run in runs"
          :key="run.id"
          type="button"
          class="workbench__run"
          :class="{ 'workbench__run--active': run.id === activeRunId }"
          @click="activeRunId = run.id"
        >
          <span class="workbench__run-goal">{{ run.goal }}</span>
          <span class="workbench__run-meta">
            <span class="font-mono">{{ run.id.slice(-6) }}</span>
            <span>{{ run.envType }}</span>
            <span>{{ run.artifactCount }} 个产物</span>
            <NTag size="tiny" :type="STATUS_STYLE[run.status].type">
              {{ STATUS_STYLE[run.status].label }}
            </NTag>
          </span>
        </button>
      </div>
    </NCard>

    <!-- ④ 决策过程 -->
    <NCard
      :ref="el => setSectionRef('decisions', el)"
      data-step="decisions"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">4</span>
        <span>决策过程</span>
        <span v-if="vm.goal" class="workbench__hint">{{ vm.goal }}</span>
      </template>
      <div v-if="vm.rationale.length === 0" class="workbench__empty">
        {{ activeRunId === undefined ? '选择或新建一次创作' : '等待计划' }}
      </div>
      <ul v-else class="workbench__rationale">
        <li v-for="(line, index) in vm.rationale" :key="index">{{ line }}</li>
      </ul>
      <NAlert v-if="vm.reason" type="warning" :bordered="false" class="mt-2">
        {{ vm.reason }}
      </NAlert>
    </NCard>

    <!-- ⑤ 页面结构 -->
    <NCard
      v-if="vm.structure"
      :ref="el => setSectionRef('structure', el)"
      data-step="structure"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">5</span>
        <span>页面结构</span>
        <span class="workbench__hint">{{ vm.structure.page.blocks.length }} 个区块</span>
      </template>
      <div class="workbench__structure">
        <NTag
          v-for="block in vm.structure.page.blocks"
          :key="block.id"
          size="small"
          :type="block.status === 'filled' ? 'success' : 'default'"
        >
          {{ block.type }}
          <span class="workbench__structure-id">{{ block.id }}</span>
        </NTag>
      </div>
    </NCard>

    <!-- ⑥ 执行步骤 -->
    <NCard
      :ref="el => setSectionRef('steps', el)"
      data-step="steps"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">6</span>
        <span>执行步骤</span>
        <span v-if="vm.current" class="workbench__hint">{{ vm.current.nodes.length }} 个节点</span>
      </template>
      <div v-if="vm.current === undefined || vm.current.nodes.length === 0" class="workbench__empty">
        {{ activeRunId === undefined ? '选择或新建一次创作' : '等待计划' }}
      </div>
      <ol v-else class="workbench__steps">
        <li v-for="node in vm.current.nodes" :key="node.nodeId" class="workbench__step">
          <NTag size="tiny" :type="stepType(node.status)">{{ node.status }}</NTag>
          <span class="workbench__step-tool">{{ node.toolId }}</span>
          <span class="workbench__step-note">{{ node.note }}</span>
          <div v-if="node.summary" class="workbench__step-summary">{{ node.summary }}</div>
          <div v-if="node.error" class="workbench__step-error">{{ node.error }}</div>
        </li>
      </ol>
    </NCard>

    <!-- ⑦ 交互验证 -->
    <NCard
      v-if="hasStructure && terminal"
      :ref="el => setSectionRef('verify', el)"
      data-step="verify"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">7</span>
        <span>交互验证</span>
      </template>
      <p class="workbench__note">
        用真浏览器打开页面并点击，由代码判断点击后有没有变化。
        {{ interactionReady ? '' : '本机没有浏览器驱动时，接口返回 503。' }}
      </p>
      <NButton size="small" :loading="verifying" :disabled="activeRunId === undefined" @click="verifyInteraction">
        交互验证
      </NButton>
      <NAlert v-if="verifyError" type="error" :bordered="false" class="mt-2">
        {{ verifyError }}
      </NAlert>
      <div v-if="verdict" class="mt-2">
        <NTag :type="verdict.passed ? 'success' : 'warning'" size="small">
          {{ verdict.passed ? '通过' : verdict.targetCount === 0 ? '未做验证' : '未通过' }}
        </NTag>
        <span class="workbench__verdict-detail">{{ verdict.detail }}</span>
        <ul v-if="(verdict.attempts?.length ?? 0) > 0" class="workbench__attempts">
          <li v-for="(line, index) in verdict.attempts ?? []" :key="index">{{ line }}</li>
        </ul>
      </div>
    </NCard>

    <!-- ⑧ 产物 -->
    <NCard
      :ref="el => setSectionRef('artifacts', el)"
      data-step="artifacts"
      size="small"
      :bordered="false"
      class="workbench__card"
    >
      <template #header>
        <span class="workbench__step-no">8</span>
        <span>产物</span>
        <span class="workbench__hint">{{ artifacts.length }} 个文件</span>
      </template>
      <div v-if="artifacts.length === 0" class="workbench__empty">还没有产物</div>
      <template v-else>
        <div class="workbench__tabs">
          <button
            v-for="artifact in artifacts"
            :key="artifact.path"
            type="button"
            class="workbench__tab"
            :class="{ 'workbench__tab--active': artifact.path === selectedArtifact }"
            @click="selectedArtifact = artifact.path"
          >
            {{ artifact.path.replace('artifacts/', '') }}
          </button>
        </div>
        <div class="workbench__preview">
          <iframe
            v-if="artifactView.kind === 'html'"
            :src="artifactView.url"
            class="workbench__frame"
            sandbox="allow-scripts"
            title="产物预览"
          />
          <img
            v-else-if="artifactView.kind === 'image'"
            :src="artifactView.url"
            class="workbench__image"
            alt="产物图片"
          />
          <NSpin v-else-if="artifactLoading" size="small" />
          <pre v-else-if="artifactView.kind === 'text'" class="workbench__code">{{ artifactText }}</pre>
          <div v-else-if="artifactView.kind === 'binary'" class="workbench__empty">
            这个产物不适合在页面里预览，请下载后查看
          </div>
        </div>
      </template>
    </NCard>
  </div>
</template>

<style scoped>
/*
 * 竖向线性布局：单列、内容宽度、最大 1080px 居中。
 * 不设内部滚动容器，让整页跟着浏览器滚动——"执行步骤"变长时
 * 不会把下面的产物预览挤没。
 */
.workbench {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 0 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── 步骤导航（吸顶） ─────────────────────────────────────────── */
.workbench__nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 4px;
  /* 背景不能透明：吸顶后下面的内容会从缝隙里透出来 */
  background: var(--n-color-body);
  border-bottom: 1px solid var(--n-border-color);
}

.workbench__nav-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

.workbench__nav-item:hover:not(:disabled) {
  background: var(--n-action-color);
}

.workbench__nav-item--active {
  color: var(--n-color-target);
  border-color: var(--n-color-target);
}

.workbench__nav-item--disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.workbench__nav-no {
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

.workbench__nav-item--active .workbench__nav-no {
  background: var(--n-color-target);
  color: #fff;
}

/* 每个 section 上方留出导航高度，跳转时才不会被吸顶栏挡住 */
.workbench__card {
  width: 100%;
  scroll-margin-top: 52px;
}

.workbench__step-no {
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

.workbench__row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
}

.workbench__field {
  flex: 1;
  min-width: 200px;
}

.workbench__field--mt {
  margin-top: 10px;
}

.workbench__label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--n-text-color-3);
}

.workbench__checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}

.workbench__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.workbench__hint {
  margin-left: 6px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.workbench__note {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-text-color-3);
}

.workbench__empty {
  padding: 12px;
  font-size: 12px;
  text-align: center;
  color: var(--n-text-color-3);
}

/* ── 运行历史 ─────────────────────────────────────────────────── */
.workbench__runs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}

.workbench__run {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: inherit;
  text-align: left;
}

.workbench__run:hover {
  background: var(--n-action-color);
}

.workbench__run--active {
  background: var(--n-action-color);
  box-shadow: inset 2px 0 0 var(--n-color-target);
}

.workbench__run-goal {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workbench__run-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

/* ── 决策过程 ─────────────────────────────────────────────────── */
.workbench__rationale {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
}

.workbench__rationale li + li {
  margin-top: 2px;
}

/* ── 页面结构 ─────────────────────────────────────────────────── */
.workbench__structure {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.workbench__structure-id {
  margin-left: 4px;
  font-family: monospace;
  opacity: 0.6;
}

/* ── 执行步骤 ─────────────────────────────────────────────────── */
.workbench__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.workbench__step {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.workbench__step-tool {
  font-family: monospace;
}

.workbench__step-note {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.workbench__step-summary,
.workbench__step-error {
  flex-basis: 100%;
  padding-left: 8px;
  font-size: 11px;
  border-left: 2px solid var(--n-border-color);
  color: var(--n-text-color-2);
}

.workbench__step-error {
  border-left-color: #d03050;
  color: #d03050;
}

/* ── 候选池 ───────────────────────────────────────────────────── */
.workbench__group + .workbench__group {
  margin-top: 8px;
}

.workbench__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  padding-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--n-border-color);
}

.workbench__blocks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}

.workbench__block-id {
  margin-left: 6px;
  font-family: monospace;
  font-size: 10px;
  color: var(--n-text-color-3);
}

/* ── 交互验证 ─────────────────────────────────────────────────── */
.workbench__verdict-detail {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--n-text-color-2);
}

.workbench__attempts {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ── 产物预览 ─────────────────────────────────────────────────── */
.workbench__tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  overflow-x: auto;
  border-bottom: 1px solid var(--n-border-color);
}

.workbench__tab {
  border: none;
  background: transparent;
  padding: 2px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

.workbench__tab--active {
  background: var(--n-action-color);
  color: var(--n-text-color-1);
}

.workbench__preview {
  min-height: 420px;
}

.workbench__frame {
  width: 100%;
  height: 640px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
  background: #fff;
}

.workbench__image {
  max-width: 100%;
  border-radius: 4px;
}

.workbench__code {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
