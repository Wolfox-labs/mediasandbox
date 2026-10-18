<script setup lang="ts">
/**
 * 第 4 步：结果展示。
 *
 * 展示的是**这次运行的真实结局**：
 *   - 运行状态与耗时（排队位次也带上：排队中的人最想知道"排第几"）
 *   - 失败时的原因（`error` / `reason` 原样显示，不糊成"出错了"）
 *   - 产物清单：文件名、大小、下载
 *   - 预览：网页走 iframe（直接指向后端产物地址）、图片 <img>、文本 <pre>
 *
 * 另外保留"查看历史运行"：换一次运行号就把整份快照换成那一次的，产物也能重看。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NSelect, NSpin, NTag, useMessage } from 'naive-ui';
import { api, ApiError, isHtmlArtifact, isImageArtifact, isTextArtifact } from '@/api/client';
import type { RunListItem } from '@/api/types';
import { useWorkbenchStore } from '@/store/modules/workbench';
import { formatBytes, formatDuration, STATUS_STYLE } from '@/utils/format';

const emit = defineEmits<{ back: []; restart: [] }>();

const store = useWorkbenchStore();
const message = useMessage();

const artifacts = computed(() => store.artifacts);
const selectedPath = ref<string | undefined>(undefined);
const artifactText = ref('');
const textLoading = ref(false);

const selected = computed(() => artifacts.value.find(item => item.path === selectedPath.value));

const view = computed(() => {
  const artifact = selected.value;
  if (artifact === undefined) return { kind: 'none' as const, url: '' };
  const url = api.artifactUrl(store.runId ?? '', artifact.path);
  if (isHtmlArtifact(artifact)) return { kind: 'html' as const, url };
  if (isImageArtifact(artifact)) return { kind: 'image' as const, url };
  if (isTextArtifact(artifact)) return { kind: 'text' as const, url };
  return { kind: 'binary' as const, url };
});

/** 默认选中第一个能预览的产物：网页优先，其次图片，最后随便一个。 */
watch(
  artifacts,
  list => {
    if (list.length === 0) {
      selectedPath.value = undefined;
      return;
    }
    if (selectedPath.value !== undefined && list.some(item => item.path === selectedPath.value)) {
      return;
    }
    const preferred =
      list.find(item => isHtmlArtifact(item)) ?? list.find(item => isImageArtifact(item));
    selectedPath.value = (preferred ?? list[0]).path;
  },
  { immediate: true }
);

/** 预览目标（换了运行、换了文件、换了类型都要重读）。 */
const previewTarget = computed(() => ({
  runId: store.runId,
  path: selectedPath.value,
  kind: view.value.kind
}));

watch(
  previewTarget,
  async target => {
    if (target.runId === undefined || target.path === undefined || target.kind !== 'text') {
      artifactText.value = '';
      return;
    }
    textLoading.value = true;
    try {
      artifactText.value = await api.artifactText(target.runId, target.path);
    } catch {
      artifactText.value = '（读取失败：产物可能已随沙盒回收）';
    } finally {
      textLoading.value = false;
    }
  },
  { immediate: true }
);

// ── 历史运行回看 ────────────────────────────────────────────────────
const runs = ref<RunListItem[]>([]);
const runsLoading = ref(false);
const historyValue = ref<string | undefined>(undefined);

const runOptions = computed(() =>
  runs.value.map(item => ({
    label: `${item.id.slice(-6)} · ${item.goal.slice(0, 22)} · ${STATUS_STYLE[item.status].label}`,
    value: item.id
  }))
);

async function loadRuns(): Promise<void> {
  runsLoading.value = true;
  try {
    const result = await api.listRuns();
    runs.value = result.runs;
  } catch (error) {
    message.error(error instanceof ApiError ? error.message : '加载运行历史失败');
  } finally {
    runsLoading.value = false;
  }
}

async function openHistory(value: string | number | null): Promise<void> {
  if (typeof value !== 'string') return;
  historyValue.value = value;
  await store.openRun(value);
  if (store.hydrateError !== undefined) message.error(store.hydrateError);
}

function downloadName(path: string): string {
  return path.split('/').pop() ?? path;
}

function restart(): void {
  emit('restart');
}

onMounted(async () => {
  await loadRuns();
  if (store.runId !== undefined) {
    historyValue.value = store.runId;
    await store.loadArtifacts();
  }
});
</script>

<template>
  <div class="wb__stack">
    <div class="wb__head">
      <span class="wb__title">结果展示</span>
      <span class="wb__sub">产物、状态、失败原因都在这一页</span>
    </div>

    <NCard size="small" :bordered="false" class="wb__card">
      <template #header>
        <span class="wb__no">4</span>
        <span>这次运行的结果</span>
        <NTag v-if="store.runId" size="small" :type="STATUS_STYLE[store.status].type">
          {{ STATUS_STYLE[store.status].label }}
        </NTag>
        <span v-if="store.durationMs !== undefined" class="wb__hint">
          耗时 {{ formatDuration(store.durationMs) }}
        </span>
      </template>

      <div v-if="store.runId === undefined" class="wb__empty">
        还没有运行结果。先去第 2 步提交一次。
        <div class="wb__actions" style="justify-content: center">
          <NButton size="small" secondary @click="emit('back')">回上一步</NButton>
        </div>
      </div>

      <template v-else>
        <div class="wb__row" style="margin-top: 0">
          <label class="wb__field wb__field--half">
            <span class="wb__label">查看历史运行</span>
            <NSelect
              :value="historyValue"
              size="small"
              filterable
              :loading="runsLoading"
              placeholder="挑一次运行回看它的产物"
              :options="runOptions"
              @update:value="openHistory"
            />
          </label>
          <div class="wb__field wb__field--half">
            <span class="wb__label">运行信息</span>
            <div class="wb__verdict" style="margin-top: 0">
              <span class="wb__kv"><span class="wb__kv-key">运行号</span>{{ store.runId }}</span>
              <span v-if="store.queuePosition !== undefined" class="wb__kv">
                <span class="wb__kv-key">排队</span>第 {{ store.queuePosition }} 位
              </span>
              <span class="wb__kv">
                <span class="wb__kv-key">产物</span>{{ artifacts.length }} 个
              </span>
            </div>
            <div class="wb__actions" style="margin-top: 6px">
              <NButton size="tiny" secondary @click="store.loadArtifacts()">刷新产物</NButton>
              <NButton size="tiny" secondary @click="loadRuns">刷新运行列表</NButton>
            </div>
          </div>
        </div>

        <NAlert v-if="store.error" type="error" :bordered="false" class="mt-2">
          运行失败：{{ store.error }}
        </NAlert>
        <NAlert v-if="store.reason" type="warning" :bordered="false" class="mt-2">
          {{ store.reason }}
        </NAlert>
        <NAlert v-if="store.hydrateError" type="default" :bordered="false" class="mt-2">
          读取运行详情失败：{{ store.hydrateError }}
        </NAlert>

        <!-- 产物清单 -->
        <div class="wb__section">
          <div class="wb__section-head">
            <span class="wb__label" style="margin: 0">产物清单</span>
            <span class="wb__section-count">
              {{ store.runFinished ? '运行已结束' : '运行还没结束，产物可能还不全' }}
            </span>
          </div>

          <div v-if="artifacts.length === 0" class="wb__empty">
            {{
              store.runFinished
                ? '这次运行没有产物。失败原因见上面的提示。'
                : '运行还没结束，等一会儿再点「刷新产物」。'
            }}
          </div>

          <table v-else class="wb__files">
            <thead>
              <tr>
                <th>文件</th>
                <th>大小</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="artifact in artifacts" :key="artifact.path">
                <td class="wb__files-name">{{ downloadName(artifact.path) }}</td>
                <td>{{ formatBytes(artifact.size) }}</td>
                <td>
                  <NButton text size="tiny" @click="selectedPath = artifact.path">预览</NButton>
                  <a
                    class="wb__hint"
                    :href="api.artifactUrl(store.runId ?? '', artifact.path)"
                    :download="downloadName(artifact.path)"
                    style="margin-left: 8px"
                  >
                    下载
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 预览 -->
        <div v-if="artifacts.length > 0" class="wb__section">
          <div class="wb__section-head">
            <span class="wb__label" style="margin: 0">预览</span>
            <span class="wb__section-count">
              网页与演示文稿都用 iframe 直接打开后端产物地址，不经过前端二次加工
            </span>
          </div>

          <div class="wb__tabs">
            <button
              v-for="artifact in artifacts"
              :key="artifact.path"
              type="button"
              class="wb__tab"
              :class="{ 'wb__tab--active': artifact.path === selectedPath }"
              @click="selectedPath = artifact.path"
            >
              {{ downloadName(artifact.path) }}
            </button>
          </div>

          <div class="wb__preview">
            <iframe
              v-if="view.kind === 'html'"
              :src="view.url"
              class="wb__frame"
              sandbox="allow-scripts"
              title="产物预览"
            />
            <img v-else-if="view.kind === 'image'" :src="view.url" class="wb__image" alt="产物" />
            <NSpin v-else-if="textLoading" size="small" />
            <pre v-else-if="view.kind === 'text'" class="wb__code">{{ artifactText }}</pre>
            <div v-else class="wb__empty">这个文件不适合在页面里预览，下载后查看</div>
          </div>
        </div>

        <div class="wb__actions">
          <NButton size="small" secondary @click="emit('back')">上一步</NButton>
          <NButton size="small" type="primary" @click="restart">重新开始</NButton>
          <span class="wb__hint">重新开始会清掉这次的目标、区块选择与运行号</span>
        </div>
      </template>
    </NCard>
  </div>
</template>
