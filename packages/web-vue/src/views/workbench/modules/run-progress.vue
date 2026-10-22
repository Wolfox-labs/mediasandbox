<!--
  运行进度条：把事件流里的节点状态折叠成"还要多久、现在在干嘛"。

  这一块回答的是"人工什么时候该介入"：没有它，用户只能对着
  "运行中"三个字一直等，或者以为卡死了——上一版就出现过
  "其实已经失败，界面还显示在跑"的情况。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NProgress } from 'naive-ui';
import { api } from '@/api/client';
import { useWorkbenchStore } from '@/store/modules/workbench';

const store = useWorkbenchStore();

const TOOL_LABEL: Record<string, string> = {
  'fill-block': '填充区块',
  'assemble-page': '组装页面',
  'verify-artifact': '校验产物',
  'screenshot-page': '截图',
  'write-file': '写文件',
  'process-image': '处理图片',
  'refine-copy': '润色文案'
};

const nodes = computed(() => store.viewModel?.current?.nodes ?? []);
const total = computed(() => nodes.value.length);
const done = computed(
  () =>
    nodes.value.filter((node) =>
      node.status === 'succeeded' || node.status === 'failed' || node.status === 'skipped'
    ).length
);
const running = computed(() => nodes.value.find((node) => node.status === 'running'));
const percent = computed(() => {
  if (total.value === 0) return store.runActive ? 5 : 100;
  return Math.max(5, Math.round((done.value / total.value) * 100));
});

const currentText = computed(() => {
  const node = running.value;
  if (node === undefined) {
    return store.status === 'queued' ? '排队中…' : '等待下一步…';
  }
  const label = TOOL_LABEL[node.toolId] ?? node.toolId;
  const lastLog = node.logs.at(-1);
  return lastLog === undefined ? `${label}…` : `${label}：${lastLog}`;
});

const elapsedText = computed(() => {
  const starts = nodes.value
    .map((node) => node.startedAt)
    .filter((value): value is number => typeof value === 'number');
  if (starts.length === 0) return '';
  const ms = now.value - Math.min(...starts);
  if (ms < 60_000) return `已用 ${Math.round(ms / 1000)} 秒`;
  return `已用 ${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
});

/**
 * 粗估剩余时间：按"已完成节点的平均耗时"外推。
 *
 * 生图和文本填充的耗时差一个数量级，所以这里给的是**区间感**而不是承诺：
 * 宁愿写"约 1–2 分钟"，也不写一个会被打脸的精确秒数。
 */
const etaText = computed(() => {
  const starts = nodes.value
    .map((node) => node.startedAt)
    .filter((value): value is number => typeof value === 'number');
  if (!store.runActive || done.value === 0 || starts.length === 0 || total.value === 0) return '';
  const elapsed = now.value - Math.min(...starts);
  const remaining = Math.max(0, total.value - done.value);
  const perNode = elapsed / done.value;
  const ms = perNode * remaining;
  if (ms < 30_000) return '预计不到 1 分钟';
  if (ms < 90_000) return '预计 1–2 分钟';
  return `预计约 ${Math.round(ms / 60_000)} 分钟`;
});

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});

/** 失败原因：取当前这次尝试的 detail，原文展示，不加工。 */
const failure = computed(() => {
  const attempt = store.viewModel?.current;
  if (attempt === undefined) return undefined;
  if (attempt.status === 'failed') return attempt.detail ?? '这次尝试失败，原因未记录';
  return undefined;
});

const cancelling = ref(false);

async function cancel(): Promise<void> {
  if (store.runId === undefined) return;
  cancelling.value = true;
  try {
    await api.cancelRun(store.runId);
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <div v-if="store.runActive || failure" class="rp">
    <div class="rp__row">
      <NProgress
        type="line"
        :percentage="percent"
        :status="failure ? 'error' : store.status === 'succeeded' ? 'success' : 'default'"
        :show-indicator="false"
        :height="6"
      />
      <span class="rp__count">{{ done }}/{{ total }}</span>
      <NButton
        v-if="store.runActive"
        size="tiny"
        quaternary
        type="error"
        :loading="cancelling"
        @click="cancel"
      >
        取消运行
      </NButton>
    </div>
    <div class="rp__meta">
      <span class="rp__now">{{ currentText }}</span>
      <span v-if="elapsedText" class="rp__elapsed">{{ elapsedText }}</span>
      <span v-if="etaText" class="rp__eta">{{ etaText }}</span>
    </div>
    <div v-if="failure" class="rp__error">失败原因：{{ failure }}</div>
  </div>
</template>

<style scoped>
.rp {
  padding: 8px 24px 10px;
  border-bottom: 1px solid var(--n-divider-color, #e5e7eb);
  background: var(--n-card-color, #fff);
}
.rp__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rp__row :deep(.n-progress) {
  flex: 1;
}
.rp__count {
  font-variant-numeric: tabular-nums;
  color: #6b7280;
  font-size: 12px;
}
.rp__meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}
.rp__now {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rp__error {
  margin-top: 6px;
  font-size: 12px;
  color: #b91c1c;
  white-space: pre-wrap;
}
</style>
