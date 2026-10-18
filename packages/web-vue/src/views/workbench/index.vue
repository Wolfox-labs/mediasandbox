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
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NGi,
  NGrid,
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
  ENV_TYPES,
  isTerminal,
  type Artifact,
  type BlockSpecDto,
  type EnvType,
  type HealthResponse,
  type InteractionVerdict,
  type QueueSnapshot,
  type RunListItem
} from '@/api/types';
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

const envOptions = ENV_TYPES.map(env => ({
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
const selectedEnvIsStructured = computed(() => envType.value === 'webpage');

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

const isStructuredRun = computed(() => vm.value.structure !== undefined);
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
          ? `本机没有可用的浏览器驱动，无法真点击（${error.message}）`
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
    <NGrid :cols="24" :x-gap="12" :y-gap="12" item-responsive responsive="screen">
      <!-- ── 左栏：提交与历史 ───────────────────────────────────── -->
      <NGi span="24 m:24 l:7">
        <div class="workbench__column">
          <NCard title="创作目标" size="small" :bordered="false" class="workbench__card">
            <NInput
              v-model:value="goal"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 6 }"
              placeholder="描述你想做的作品…（Ctrl+Enter 提交）"
              @keydown.ctrl.enter.prevent="submit"
            />
            <div class="workbench__field">
              <span class="workbench__label">环境类型</span>
              <NSelect v-model:value="envType" :options="envOptions" size="small" />
            </div>
            <div class="workbench__field">
              <span class="workbench__label">沙盒 provider</span>
              <NSelect
                v-model:value="provider"
                size="small"
                :options="[
                  { label: 'docker（容器级隔离）', value: 'docker' },
                  { label: 'local（路径级隔离）', value: 'local' }
                ]"
              />
            </div>

            <!-- 结构化参数只在 webpage 环境有意义 -->
            <template v-if="selectedEnvIsStructured">
              <div class="workbench__field">
                <span class="workbench__label">block 数上限：{{ maxBlocks }}</span>
                <input v-model.number="maxBlocks" type="range" min="1" max="12" class="w-full" />
              </div>
              <NCheckbox v-model:checked="useGenerative" size="small">
                文案走生成层
                <span class="workbench__hint">
                  关闭时全部确定性填充——零成本、可复现
                </span>
              </NCheckbox>
              <NCheckbox v-model:checked="annotate" size="small">
                在页面上标注来源
                <span class="workbench__hint">每块显示 id、状态与各 slot 的填充来源</span>
              </NCheckbox>
              <NCheckbox v-model:checked="screenshot" size="small">
                截图
                <span class="workbench__hint">
                  {{
                    screenshotReady
                      ? '产出 artifacts/screenshot.png（真 chromium，多花 3–10 秒）'
                      : '当前服务没有真浏览器驱动，产出的是占位图'
                  }}
                </span>
              </NCheckbox>
            </template>

            <NButton
              type="primary"
              block
              class="mt-3"
              :loading="submitting"
              @click="submit"
            >
              开始创作
            </NButton>
            <NAlert v-if="submitNote" type="info" :bordered="false" class="mt-2" closable>
              {{ submitNote }}
            </NAlert>
            <NAlert v-if="submitError" type="error" :bordered="false" class="mt-2">
              {{ submitError }}
            </NAlert>
          </NCard>

          <NCard
            title="运行历史"
            size="small"
            :bordered="false"
            class="workbench__card workbench__card--grow"
            content-style="padding: 4px;"
          >
            <template #header-extra>
              <NButton text size="tiny" @click="refreshRuns">刷新</NButton>
            </template>
            <div v-if="queue && queue.waiting > 0" class="workbench__queue">
              队列 {{ queue.running }}/{{ queue.maxConcurrent }} 在跑，{{ queue.waiting }} 个在排
            </div>
            <div class="workbench__runlist">
              <button
                v-for="run in runs"
                :key="run.id"
                type="button"
                class="workbench__run"
                :class="{ 'workbench__run--active': run.id === activeRunId }"
                @click="activeRunId = run.id"
              >
                <div class="workbench__run-goal">{{ run.goal }}</div>
                <div class="workbench__run-meta">
                  <span class="font-mono">{{ run.id.slice(-6) }}</span>
                  <span>{{ run.envType }}</span>
                  <span>{{ run.artifactCount }} 个产物</span>
                  <span
                    class="workbench__run-status"
                    :class="`workbench__run-status--${run.status}`"
                  >
                    {{ run.status }}
                  </span>
                </div>
              </button>
              <div v-if="runs.length === 0" class="workbench__empty">还没有运行记录</div>
            </div>
          </NCard>
        </div>
      </NGi>

      <!-- ── 中栏：决策过程 / 结构 / 交互验证 / 步骤 ────────────── -->
      <NGi span="24 m:24 l:10">
        <div class="workbench__column">
          <NCard :bordered="false" size="small" class="workbench__card">
            <template #header>
              <div class="workbench__header">
                <span>决策过程</span>
                <NTag size="tiny" :type="connection === 'open' ? 'success' : 'warning'">
                  {{ connectionLabel }}
                </NTag>
              </div>
            </template>
            <div v-if="vm.rationale.length === 0" class="workbench__empty">等待计划…</div>
            <ul v-else class="workbench__rationale">
              <li v-for="(line, index) in vm.rationale" :key="index">{{ line }}</li>
            </ul>
            <NAlert v-if="vm.reason" type="warning" :bordered="false" class="mt-2">
              {{ vm.reason }}
            </NAlert>
          </NCard>

          <NCard
            v-if="vm.structure"
            title="页面结构"
            size="small"
            :bordered="false"
            class="workbench__card"
          >
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

          <NCard
            v-if="isStructuredRun && terminal"
            title="交互验证"
            size="small"
            :bordered="false"
            class="workbench__card"
          >
            <p class="workbench__hint workbench__hint--block">
              让真浏览器打开产物页面、点一个最值得点的元素，再由代码判定"点完有没有变化"。
              {{ interactionReady ? '' : '（本机没有浏览器驱动，接口会如实回 503）' }}
            </p>
            <NButton
              size="small"
              :loading="verifying"
              :disabled="activeRunId === undefined"
              @click="verifyInteraction"
            >
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

          <NCard
            title="执行步骤"
            size="small"
            :bordered="false"
            class="workbench__card workbench__card--grow"
          >
            <template #header-extra>
              <NButton
                v-if="activeRunId && !terminal"
                text
                size="tiny"
                type="error"
                @click="cancel"
              >
                取消
              </NButton>
            </template>
            <div v-if="vm.current === undefined || vm.current.nodes.length === 0" class="workbench__empty">
              {{ activeRunId === undefined ? '选择或新建一次创作' : '等待计划…' }}
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
        </div>
      </NGi>

      <!-- ── 右栏：候选池 / 预览 ────────────────────────────────── -->
      <NGi span="24 m:24 l:7">
        <div class="workbench__column">
          <NCard
            v-if="selectedEnvIsStructured && activeRunId === undefined"
            title="block 候选池"
            size="small"
            :bordered="false"
            class="workbench__card workbench__card--grow"
            content-style="padding: 8px;"
          >
            <template #header-extra>
              <span class="workbench__hint">勾选后参与本次制作</span>
            </template>
            <NSpin :show="blocksLoading">
              <div v-for="entry in groupedBlocks" :key="entry.group" class="workbench__group">
                <div class="workbench__group-head">
                  <span>{{ entry.label }}</span>
                  <span class="workbench__hint">
                    {{ entry.items.filter(i => candidateBlockIds.includes(i.id)).length }}/{{
                      entry.items.length
                    }}
                  </span>
                  <NButton
                    text
                    size="tiny"
                    @click="
                      toggleGroup(
                        entry.group,
                        entry.items.some(i => !candidateBlockIds.includes(i.id))
                      )
                    "
                  >
                    {{
                      entry.items.some(i => !candidateBlockIds.includes(i.id)) ? '全选' : '清空'
                    }}
                  </NButton>
                </div>
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
            </NSpin>
          </NCard>

          <NCard
            title="实时预览"
            size="small"
            :bordered="false"
            class="workbench__card workbench__card--grow"
            content-style="padding: 0;"
          >
            <template #header-extra>
              <span class="workbench__hint">{{ artifacts.length }} 个产物</span>
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
                <pre v-else-if="artifactView.kind === 'text'" class="workbench__code">{{
                  artifactText
                }}</pre>
                <div v-else-if="artifactView.kind === 'binary'" class="workbench__empty">
                  这个产物不适合在页面里预览，请下载后查看
                </div>
              </div>
            </template>
          </NCard>
        </div>
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.workbench {
  height: 100%;
  min-height: 0;
}

.workbench__column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  height: 100%;
}

.workbench__card {
  min-height: 0;
}

.workbench__card--grow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.workbench__field {
  margin-top: 8px;
}

.workbench__label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--n-text-color-3);
}

.workbench__hint {
  font-size: 11px;
  color: var(--n-text-color-3);
  margin-left: 6px;
}

.workbench__hint--block {
  display: block;
  margin: 0 0 8px;
}

.workbench__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workbench__queue {
  margin: 4px 8px 8px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--n-text-color-3);
  background: var(--n-action-color);
}

.workbench__runlist {
  overflow-y: auto;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workbench__run {
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}

.workbench__run:hover {
  background: var(--n-action-color);
}

.workbench__run--active {
  background: var(--n-action-color);
  box-shadow: inset 2px 0 0 var(--n-color-target);
}

.workbench__run-goal {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workbench__run-meta {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: var(--n-text-color-3);
  margin-top: 2px;
}

.workbench__run-status--succeeded {
  color: #18a058;
}

.workbench__run-status--failed,
.workbench__run-status--escalated {
  color: #d03050;
}

.workbench__run-status--queued,
.workbench__run-status--running {
  color: #2080f0;
}

.workbench__empty {
  padding: 16px;
  font-size: 12px;
  text-align: center;
  color: var(--n-text-color-3);
}

.workbench__rationale {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}

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

.workbench__verdict-detail {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--n-text-color-2);
}

.workbench__attempts {
  margin: 6px 0 0;
  padding-left: 16px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.workbench__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
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
  color: var(--n-text-color-3);
  font-size: 11px;
}

.workbench__step-summary,
.workbench__step-error {
  flex-basis: 100%;
  font-size: 11px;
  padding-left: 8px;
  border-left: 2px solid var(--n-border-color);
  color: var(--n-text-color-2);
}

.workbench__step-error {
  border-left-color: #d03050;
  color: #d03050;
}

.workbench__group {
  padding: 6px 4px;
}

.workbench__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--n-border-color);
}

.workbench__block-id {
  margin-left: 6px;
  font-family: monospace;
  font-size: 10px;
  color: var(--n-text-color-3);
}

.workbench__tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--n-border-color);
}

.workbench__tab {
  border: none;
  background: transparent;
  padding: 2px 8px;
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
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.workbench__frame {
  width: 100%;
  height: 100%;
  min-height: 320px;
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
