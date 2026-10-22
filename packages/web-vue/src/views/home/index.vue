<script setup lang="ts">
/**
 * 首页。
 *
 * 这一版不是模板市场那套演示图表：首页只需要回答三个问题——
 * **这是个什么东西、它现在什么状态、我从哪儿开始**。
 * 所以每一块数字都来自真实接口（健康检查 / 运行流水 / 项目产物 / 工作流），
 * 而不是写死的样例值。连不上就如实写"不可达"，不假装一切正常。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NCard, NEmpty, NGi, NGrid, NSkeleton, NTag } from 'naive-ui';
import { api } from '@/api/client';
import type { Artifact, HealthResponse, ProjectDto, RunListItem } from '@/api/types';
import { ENV_LABELS, type EnvType } from '@/api/types';
import { formatBytes, formatDateTime, STATUS_STYLE } from '@/utils/format';

defineOptions({ name: 'Home' });

interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly nodeCount?: number;
  readonly builtin?: boolean;
}

/** 首页展示的缩略图：只取图片产物，且只取最近几次运行。 */
interface Shot {
  readonly runId: string;
  readonly path: string;
  readonly size: number;
}

const router = useRouter();

const health = ref<HealthResponse | null>(null);
const runs = ref<readonly RunListItem[]>([]);
const projects = ref<readonly ProjectDto[]>([]);
const workflows = ref<readonly WorkflowSummary[]>([]);
const shots = ref<readonly Shot[]>([]);
const loading = ref(true);
const error = ref('');

const runCount = computed(() => runs.value.length);
const artifactCount = computed(() =>
  projects.value.reduce((sum, item) => sum + item.artifactCount, 0),
);
const succeededCount = computed(
  () => runs.value.filter(item => item.status === 'succeeded').length,
);
const queue = computed(() => health.value?.queue);

const recentRuns = computed(() => runs.value.slice(0, 6));

/** 三条链路：写清楚"这类目标该去哪条路"，而不是让人猜。 */
const lanes = [
  {
    key: 'workbench',
    title: '创作工作台',
    subtitle: '一句话目标 → 模型决策 → 交互验证 → 结果',
    detail:
      '适合网页、文案这类需要现场判断的目标：决策层逐个节点选工具，浏览器真点一遍验证页面能用，最后把产物列出来。',
    action: '开始创作',
    to: '/workbench/goal'
  },
  {
    key: 'workflows',
    title: '工作流画布',
    subtitle: '固定链路，节点级缓存，重跑只算改动的那几段',
    detail:
      '适合成组出稿：海报一次出四档尺寸、演示文稿按版式序列拼、网页按整页模板灌。改一版文案不必重新出图。',
    action: '打开画布',
    to: '/workflows'
  },
  {
    key: 'projects',
    title: '项目与产物',
    subtitle: '按项目归档，图片就地预览，可整包导出',
    detail:
      '跑过的每一次都留在这里：产物落定在 projects 目录，不随沙盒回收消失；同一项目的多次重跑按运行分组，不会互相覆盖。',
    action: '看产物',
    to: '/projects'
  }
] as const;

function statusTag(status: RunListItem['status']) {
  return STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
}

function envLabel(envType: string): string {
  return ENV_LABELS[envType as EnvType]?.label ?? envType;
}

function openArtifact(shot: Shot): void {
  window.open(api.artifactUrl(shot.runId, shot.path), '_blank', 'noopener');
}

/** 最近出图：只翻最近几个图片类运行，避免一进首页就发几十个请求。 */
async function loadShots(source: readonly RunListItem[]): Promise<void> {
  const imageRuns = source
    .filter(item => item.envType === 'image' && item.artifactCount > 0)
    .slice(0, 4);
  const collected: Shot[] = [];
  await Promise.all(
    imageRuns.map(async item => {
      try {
        const { artifacts } = await api.listArtifacts(item.id);
        for (const artifact of artifacts as readonly Artifact[]) {
          if (!artifact.path.endsWith('.png')) continue;
          collected.push({ runId: item.id, path: artifact.path, size: artifact.size });
        }
      } catch {
        /* 单个运行取不到就跳过：首页不该因为一张缩略图罢工 */
      }
    }),
  );
  shots.value = collected.slice(0, 6);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [healthResult, runsResult, projectsResult, workflowsResult] = await Promise.all([
      api.health().catch(() => null),
      api.listRuns().catch(() => ({ runs: [] as RunListItem[], queue: undefined })),
      api.listProjects().catch(() => ({ projects: [] as ProjectDto[] })),
      fetch('/api/workflows')
        .then(response => (response.ok ? response.json() : { workflows: [] }))
        .catch(() => ({ workflows: [] }))
    ]);
    health.value = healthResult;
    runs.value = [...runsResult.runs];
    projects.value = projectsResult.projects;
    workflows.value = (workflowsResult as { workflows?: WorkflowSummary[] }).workflows ?? [];
    void loadShots(runs.value);
  } catch (error_) {
    error.value = `读取运行数据失败：${String(error_)}`;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="home">
    <!-- 抬头：说清这是什么，以及此刻能不能用 -->
    <NCard :bordered="false">
      <div class="home__hero">
        <div class="home__hero-main">
          <h1 class="home__title">MediaSandbox · 通用 Agent 沙盒</h1>
          <p class="home__lead">
            给一句目标，跑出一个能直接交付的产物：网页、演示文稿、海报、文案。
            决策、生成、验证都在沙盒里完成，产物留档可回看。
          </p>
          <div class="home__actions">
            <NButton type="primary" @click="router.push('/workbench/goal')">开始创作</NButton>
            <NButton secondary @click="router.push('/workflows')">工作流画布</NButton>
            <NButton quaternary @click="router.push('/projects')">看已有产物</NButton>
          </div>
        </div>
        <div class="home__status">
          <div class="home__status-row">
            <span class="home__status-label">决策层</span>
            <NTag size="small" :type="health?.decision.ok ? 'success' : 'error'">
              {{ health === null ? '读取中' : health.decision.ok ? '就绪' : '不可达' }}
            </NTag>
          </div>
          <div class="home__status-row">
            <span class="home__status-label">生成层</span>
            <NTag size="small" :type="health?.llm.ok ? 'success' : 'error'">
              {{ health === null ? '读取中' : health.llm.ok ? '就绪' : '不可达' }}
            </NTag>
          </div>
          <div class="home__status-row">
            <span class="home__status-label">浏览器</span>
            <NTag size="small" :type="health?.browser?.screenshot === 'chromium' ? 'success' : 'warning'">
              {{ health?.browser?.screenshot === 'chromium' ? '真渲染' : '占位图' }}
            </NTag>
          </div>
          <div class="home__status-row">
            <span class="home__status-label">并发</span>
            <span class="home__status-value">
              {{ queue === undefined ? '—' : `${queue.running} 运行 · ${queue.waiting} 排队` }}
            </span>
          </div>
        </div>
      </div>
    </NCard>

    <!-- 四个数字：全部来自真实接口 -->
    <NGrid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <NGi v-for="item in [
        { label: '运行', value: runCount, unit: '次' },
        { label: '成功', value: succeededCount, unit: '次' },
        { label: '产物', value: artifactCount, unit: '个' },
        { label: '工具', value: health?.toolCount ?? 0, unit: '个' }
      ]" :key="item.label" span="12 s:6">
        <NCard :bordered="false" size="small" class="home__metric">
          <div class="home__metric-label">{{ item.label }}</div>
          <NSkeleton v-if="loading" text style="width: 60px" />
          <div v-else class="home__metric-value">
            {{ item.value }}<span class="home__metric-unit">{{ item.unit }}</span>
          </div>
        </NCard>
      </NGi>
    </NGrid>

    <!-- 三条链路 -->
    <NGrid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
      <NGi v-for="lane in lanes" :key="lane.key" span="24 m:8">
        <NCard :bordered="false" size="small" class="home__lane">
          <div class="home__lane-title">{{ lane.title }}</div>
          <div class="home__lane-sub">{{ lane.subtitle }}</div>
          <p class="home__lane-detail">{{ lane.detail }}</p>
          <NButton size="small" secondary @click="router.push(lane.to)">{{ lane.action }}</NButton>
        </NCard>
      </NGi>
    </NGrid>

    <!-- 最近出图：点开就是原图 -->
    <NCard v-if="shots.length > 0" :bordered="false" size="small" title="最近出图">
      <div class="home__shots">
        <button
          v-for="shot in shots"
          :key="`${shot.runId}/${shot.path}`"
          type="button"
          class="home__shot"
          :title="shot.path"
          @click="openArtifact(shot)"
        >
          <img :src="api.artifactUrl(shot.runId, shot.path)" :alt="shot.path" loading="lazy" />
          <span class="home__shot-meta">{{ formatBytes(shot.size) }}</span>
        </button>
      </div>
    </NCard>

    <!-- 最近运行 -->
    <NCard :bordered="false" size="small" title="最近运行">
      <template #header-extra>
        <NButton text size="tiny" @click="load">刷新</NButton>
      </template>
      <p v-if="error !== ''" class="home__error">{{ error }}</p>
      <NEmpty
        v-else-if="!loading && recentRuns.length === 0"
        size="small"
        description="还没有运行记录。从「开始创作」或「工作流画布」发起第一次"
      />
      <div v-else class="home__runs">
        <button
          v-for="item in recentRuns"
          :key="item.id"
          type="button"
          class="home__run"
          @click="router.push('/projects')"
        >
          <NTag size="tiny" :type="statusTag(item.status).type">{{ statusTag(item.status).label }}</NTag>
          <span class="home__run-goal" :title="item.goal">{{ item.goal }}</span>
          <span class="home__run-env">{{ envLabel(item.envType) }}</span>
          <span class="home__run-art">{{ item.artifactCount }} 产物</span>
          <span class="home__run-time">{{ formatDateTime(item.startedAt) }}</span>
        </button>
      </div>
      <div v-if="workflows.length > 0" class="home__wf">
        可跑的工作流：
        <span v-for="wf in workflows" :key="wf.id" class="home__wf-item">
          {{ wf.name }}<span v-if="wf.nodeCount"> · {{ wf.nodeCount }} 节点</span>
        </span>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 窄窗口下这一页会比屏幕长，让它自己滚。 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.home__hero {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.home__hero-main {
  flex: 1;
  min-width: 260px;
}
.home__title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
}
.home__lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--n-text-color-3);
  max-width: 620px;
}
.home__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.home__status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 168px;
  padding-left: 20px;
  border-left: 1px solid var(--n-border-color);
}
.home__status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.home__status-label {
  color: var(--n-text-color-3);
}
.home__status-value {
  color: var(--n-text-color-2);
}

.home__metric-label {
  font-size: 12px;
  color: var(--n-text-color-3);
}
.home__metric-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
}
.home__metric-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--n-text-color-3);
  margin-left: 4px;
}

.home__lane {
  height: 100%;
}
.home__lane-title {
  font-size: 14px;
  font-weight: 600;
}
.home__lane-sub {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin: 2px 0 8px;
}
.home__lane-detail {
  font-size: 12px;
  line-height: 1.7;
  color: var(--n-text-color-2);
  margin: 0 0 12px;
}

.home__shots {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.home__shot {
  position: relative;
  padding: 0;
  border: 1px solid var(--n-border-color);
  border-radius: 6px;
  overflow: hidden;
  background: var(--n-action-color);
  cursor: pointer;
  /* 高度统一、宽度随图自己走：海报有 3:4、1:1、横幅三种比例，
     硬塞进同一个方框会把标题裁掉，或者留一大片空白。 */
  height: 168px;
}
.home__shot img {
  height: 100%;
  width: auto;
  display: block;
}
.home__shot:hover {
  border-color: var(--n-color-target);
}
.home__shot-meta {
  position: absolute;
  right: 4px;
  bottom: 4px;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
}

.home__runs {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.home__run {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.home__run:hover {
  background: var(--n-action-color);
}
.home__run-goal {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home__run-env,
.home__run-art,
.home__run-time {
  font-size: 11px;
  color: var(--n-text-color-3);
  white-space: nowrap;
}
.home__error {
  font-size: 12px;
  color: var(--n-color-target);
  margin: 0;
}
.home__wf {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--n-border-color);
  font-size: 11px;
  color: var(--n-text-color-3);
  line-height: 1.8;
}
.home__wf-item + .home__wf-item::before {
  content: '·';
  margin: 0 6px;
}
</style>
