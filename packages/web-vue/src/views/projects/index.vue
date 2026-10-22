<script setup lang="ts">
/**
 * 「项目与产物」（Vue 版）。
 *
 * 与工作台的区别是**视角**：工作台盯"这一次运行"的过程，这里盯
 * "我这个项目攒下了什么"——一个项目可能跑过多次（重试 / 换方案 / 改目标重来），
 * 产物要按项目归到一起看。
 *
 * 三栏：项目列表 / 按运行分组的文件树 / 内置模板。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NGi,
  NGrid,
  NModal,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui';
import { api, ApiError, isHtmlArtifact, isImageArtifact, isTextArtifact } from '@/api/client';
import ArtifactPreview from '@/components/common/artifact-preview.vue';
import { ENV_LABELS, type EnvType } from '@/api/types';
import { formatBytes, formatDateTime, STATUS_STYLE } from '@/utils/format';

defineOptions({ name: 'Projects' });

const message = useMessage();

interface ProjectRun {
  readonly id: string;
  readonly goal: string;
  readonly envType: string;
  readonly status: keyof typeof STATUS_STYLE;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly artifactCount: number;
}

interface Project {
  readonly projectId: string;
  readonly goal: string;
  readonly envType: string;
  readonly provider: string;
  readonly status: keyof typeof STATUS_STYLE;
  readonly runCount: number;
  readonly artifactCount: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly runs: readonly ProjectRun[];
}

interface ArtifactNode {
  readonly runId: string;
  readonly path: string;
  readonly size: number;
  readonly mimeHint: string;
}

/**
 * 内置模板。设计文档 §5.4 说模板"同时充当决策层的默认选型起点"。
 *
 * 这里如实标注：**当前实现里模板并不充当决策起点**，只是给用户的起手式示例。
 * 写明这一点比含糊过去好——免得读的人以为模板参与了决策。
 */
const TEMPLATES: readonly {
  id: string;
  name: string;
  envType: EnvType;
  goal: string;
  tools: string;
}[] = [
  {
    id: 'product-page',
    name: '产品介绍页',
    envType: 'webpage',
    goal: '做一个产品介绍落地页，含标题、特性列表和页脚',
    tools: 'scaffold-frontend → build-frontend'
  },
  {
    id: 'static-page',
    name: '静态页（模板路线）',
    envType: 'webpage',
    goal: '用模板生成一个简洁的静态页面',
    tools: 'static-page-from-template → build-frontend'
  },
  {
    id: 'product-copy',
    name: '产品文案',
    envType: 'copy',
    goal: '为通用 Agent 沙盒平台写一段产品介绍，面向高校竞赛评委',
    tools: 'draft-copy → refine-copy → write-file'
  },
  {
    id: 'md-doc',
    name: 'Markdown 文稿（模板路线）',
    envType: 'copy',
    goal: '写一份数字媒体竞赛的项目摘要',
    tools: 'template-copy → write-file'
  },
  {
    id: 'cover-image',
    name: '封面图',
    envType: 'image',
    goal: '生成一张科技感的作品封面图',
    tools: 'render-image'
  }
];

const projects = ref<Project[] | null>(null);
const selected = ref<string | undefined>(undefined);
const artifacts = ref<ArtifactNode[]>([]);
const loadingArtifacts = ref(false);
const exporting = ref(false);
const notice = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    const { projects: list } = await api.listProjects();
    projects.value = list;
    if (
      selected.value === undefined ||
      !list.some(p => p.projectId === selected.value)
    ) {
      // 默认选**最近一个有产物的**：列表第一条往往是刚跑失败的那次，
      // 选中它只会得到一句"这个项目还没有产物"，看着像页面坏了。
      selected.value = (list.find(p => p.artifactCount > 0) ?? list[0])?.projectId;
    }
  } catch (error) {
    projects.value = [];
    message.error(error instanceof ApiError ? error.message : '加载项目失败');
  }
}

const project = computed(() => projects.value?.find(p => p.projectId === selected.value));

/** 按 run 分组的产物：同一项目跑多次时，两个 index.html 各占一组，不会混淆。 */
const groupedArtifacts = computed(() => {
  const map = new Map<string, ArtifactNode[]>();
  for (const node of artifacts.value) {
    const list = map.get(node.runId) ?? [];
    list.push(node);
    map.set(node.runId, list);
  }
  return [...map.entries()].map(([runId, nodes]) => ({ runId, nodes }));
});

// 拉该项目的全部产物（跨所有 run）。列表接口只给数量，清单要逐个 run 取。
watch(
  project,
  async current => {
    if (current === undefined) {
      artifacts.value = [];
      return;
    }
    loadingArtifacts.value = true;
    try {
      const groups = await Promise.all(
        current.runs.map(async run => {
          const result = await api.listArtifacts(run.id).catch(() => ({ artifacts: [] }));
          return result.artifacts.map(artifact => ({
            runId: run.id,
            path: artifact.path,
            size: artifact.size,
            mimeHint: artifact.mimeHint
          }));
        })
      );
      artifacts.value = groups.flat();
    } finally {
      loadingArtifacts.value = false;
    }
  },
  { immediate: true }
);

function onExport(): void {
  const current = project.value;
  if (current === undefined || exporting.value) return;
  exporting.value = true;
  notice.value = null;
  // 用浏览器原生下载：导出是 GET，直接开 URL 即可，不必先取到内存再触发下载。
  window.location.href = api.exportProjectUrl(current.projectId);
  window.setTimeout(() => {
    exporting.value = false;
    notice.value = '已发起下载。产物所在的沙盒若已被回收，压缩包里会缺少对应文件。';
  }, 1500);
}

function useTemplate(template: (typeof TEMPLATES)[number]): void {
  // 复制到剪贴板后让用户去工作台粘贴——不做"一键直接提交"：
  // 提交会真实调用生成层（有成本），应当由人确认目标后再发起。
  void navigator.clipboard
    ?.writeText(template.goal)
    .then(() => {
      notice.value = `已复制目标到剪贴板，到「创作工作台」粘贴即可（环境选 ${
        ENV_LABELS[template.envType].label
      }）`;
    })
    .catch(() => {
      notice.value = `目标：${template.goal}`;
    });
}

/** 产物地址。`<a href>` 留着，浏览器自带的"新标签打开 / 复制链接 / 另存为"才都还在。 */
function previewUrl(node: ArtifactNode): string {
  return api.artifactUrl(node.runId, node.path);
}

function artifactOf(node: ArtifactNode): { path: string; size: number; mimeHint: string } {
  return { path: node.path, size: node.size, mimeHint: node.mimeHint };
}

/** 网页 / 图片 / 文本都能在站内看；其它类型只能下载。 */
function canPreview(node: ArtifactNode): boolean {
  const artifact = artifactOf(node);
  return isHtmlArtifact(artifact) || isImageArtifact(artifact) || isTextArtifact(artifact);
}

/** 正在站内预览的产物；`undefined` 表示弹层关着。 */
const previewNode = ref<ArtifactNode | undefined>(undefined);

/**
 * 点击产物：**默认在站内预览**，`Ctrl / Cmd / Shift` 与中键仍交给浏览器开新标签。
 *
 * 只拦"普通左键"这一种情况：其余（含右键菜单里的各项）保持链接的默认语义，
 * 这样"想在新标签里看原文件"的习惯不会被破坏。
 */
function onArtifactClick(event: MouseEvent, node: ArtifactNode): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!canPreview(node)) return;
  event.preventDefault();
  previewNode.value = node;
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await refresh();
  timer = setInterval(refresh, 8000);
});
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <div class="projects">
    <NGrid :cols="24" :x-gap="12" :y-gap="12" item-responsive responsive="screen">
      <!-- 左：项目列表 -->
      <NGi span="24 s:9 m:9 l:7">
        <NCard title="项目" size="small" :bordered="false" class="projects__card">
          <template #header-extra>
            <NButton text size="tiny" @click="refresh">刷新</NButton>
          </template>
          <NSpin :show="projects === null">
            <NEmpty
              v-if="projects !== null && projects.length === 0"
              description="还没有项目。到「创作工作台」提交一次目标"
              size="small"
            />
            <div v-else class="projects__list">
              <button
                v-for="item in projects ?? []"
                :key="item.projectId"
                type="button"
                class="projects__item"
                :class="{ 'projects__item--active': item.projectId === selected }"
                @click="selected = item.projectId"
              >
                <div class="projects__item-head">
                  <span class="projects__item-goal">{{ item.goal }}</span>
                  <NTag size="tiny" :type="STATUS_STYLE[item.status].type">
                    {{ STATUS_STYLE[item.status].label }}
                  </NTag>
                </div>
                <div class="projects__item-meta">
                  <span>{{ item.envType }}</span>
                  <span>·</span>
                  <span>{{ item.runCount }} 次运行</span>
                  <span>·</span>
                  <span>{{ item.artifactCount }} 产物</span>
                </div>
                <div class="projects__item-time">
                  最近更新 {{ formatDateTime(item.updatedAt) }}
                </div>
              </button>
            </div>
          </NSpin>
        </NCard>
      </NGi>

      <!-- 中：文件树 -->
      <NGi span="24 s:15 m:15 l:11">
        <NCard
          size="small"
          :bordered="false"
          class="projects__card projects__card--grow"
          title="项目文件"
        >
          <template #header-extra>
            <NButton
              v-if="project !== undefined"
              size="tiny"
              type="primary"
              :loading="exporting"
              @click="onExport"
            >
              导出 ZIP
            </NButton>
          </template>
          <NAlert v-if="notice" type="info" :bordered="false" class="mb-2" closable>
            {{ notice }}
          </NAlert>
          <NSpin :show="loadingArtifacts">
            <NEmpty
              v-if="artifacts.length === 0"
              description="这个项目还没有产物"
              size="small"
            />
            <div v-else class="projects__tree">
              <div v-for="group in groupedArtifacts" :key="group.runId" class="projects__group">
                <div class="projects__group-head">
                  <span class="font-mono">{{ group.runId }}</span>
                  <span>{{ group.nodes.length }} 个产物</span>
                </div>
                <ul class="projects__files">
                  <li v-for="node in group.nodes" :key="node.path" class="projects__file">
                    <a
                      :href="previewUrl(node)"
                      :target="canPreview(node) ? '_blank' : undefined"
                      :download="canPreview(node) ? undefined : true"
                      rel="noreferrer"
                      @click="onArtifactClick($event, node)"
                    >
                      {{ node.path }}
                    </a>
                    <span class="projects__file-size">{{ formatBytes(node.size) }}</span>
                    <span class="projects__file-mime">{{ node.mimeHint }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </NSpin>
        </NCard>
      </NGi>

      <!-- 右：内置模板 -->
      <NGi span="24 s:24 m:24 l:6">
        <NCard title="内置模板" size="small" :bordered="false" class="projects__card">
          <p class="projects__hint">
            这些是起手式示例，不参与决策。点一下复制目标，到工作台粘贴即可。
          </p>
          <div class="projects__templates">
            <div v-for="template in TEMPLATES" :key="template.id" class="projects__template">
              <div class="projects__template-head">
                <span class="projects__template-name">{{ template.name }}</span>
                <NTag size="tiny">{{ ENV_LABELS[template.envType].label }}</NTag>
              </div>
              <div class="projects__template-goal">{{ template.goal }}</div>
              <div class="projects__template-tools">{{ template.tools }}</div>
              <NButton size="tiny" secondary @click="useTemplate(template)">
                复制目标
              </NButton>
            </div>
          </div>
        </NCard>
      </NGi>
    </NGrid>

    <!-- 站内预览：普通左键走这里；Ctrl / Cmd / 中键走浏览器新标签（见 onArtifactClick） -->
    <NModal
      :show="previewNode !== undefined"
      preset="card"
      :title="previewNode?.path ?? '产物预览'"
      style="width: min(1200px, calc(100vw - 32px))"
      @update:show="
        value => {
          if (!value) previewNode = undefined;
        }
      "
    >
      <template v-if="previewNode" #header-extra>
        <a
          :href="previewUrl(previewNode)"
          target="_blank"
          rel="noreferrer"
          class="projects__preview-open"
        >
          在新标签打开
        </a>
      </template>
      <div v-if="previewNode" class="projects__preview">
        <ArtifactPreview
          :run-id="previewNode.runId"
          :path="previewNode.path"
          :size="previewNode.size"
          :mime-hint="previewNode.mimeHint"
        />
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.projects__preview {
  height: clamp(360px, 62vh, 900px);
}

.projects__preview-open {
  font-size: 12px;
  text-decoration: none;
}
.projects {
  height: 100%;
  min-height: 0;
  /* 窄窗口下三栏会换行，整页要能滚——否则第三块被切掉还找不到滚动条。 */
  overflow-y: auto;
}

.projects__card {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.projects__card--grow {
  overflow: hidden;
}

.projects__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  /* 60 多个项目时列表会把整页撑到几千像素，把右边的文件树顶到看不见的地方。
     这里硬性封顶：卡片的 `height: 100%` 在换行布局里没有可比对的参照高度，
     `max-height: 100%` 等于没限制。 */
  max-height: min(64vh, 620px);
}

.projects__item {
  text-align: left;
  padding: 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: inherit;
}

.projects__item:hover {
  background: var(--n-action-color);
}

.projects__item--active {
  background: var(--n-action-color);
  box-shadow: inset 2px 0 0 var(--n-color-target);
}

.projects__item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.projects__item-goal {
  flex: 1;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.projects__item-meta,
.projects__item-time {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--n-text-color-3);
  margin-top: 2px;
}

.projects__tree {
  overflow-y: auto;
  max-height: min(64vh, 620px);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.projects__group-head {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--n-text-color-3);
  padding: 4px 0;
  border-bottom: 1px dashed var(--n-border-color);
}

.projects__files {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.projects__file {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}

.projects__file a {
  flex: 1;
  color: var(--n-color-target);
  text-decoration: none;
  font-family: monospace;
  word-break: break-all;
}

.projects__file a:hover {
  text-decoration: underline;
}

.projects__file-size,
.projects__file-mime {
  font-size: 10px;
  color: var(--n-text-color-3);
  white-space: nowrap;
}

.projects__hint {
  font-size: 11px;
  color: var(--n-text-color-3);
  line-height: 1.6;
  margin: 0 0 10px;
}

.projects__templates {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.projects__template {
  padding: 8px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
}

.projects__template-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.projects__template-name {
  font-size: 12px;
  font-weight: 600;
}

.projects__template-goal {
  font-size: 11px;
  color: var(--n-text-color-2);
  margin: 4px 0;
  line-height: 1.5;
}

.projects__template-tools {
  font-family: monospace;
  font-size: 10px;
  color: var(--n-text-color-3);
  margin-bottom: 6px;
}
</style>
