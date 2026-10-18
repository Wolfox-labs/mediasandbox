<script setup lang="ts">
/**
 * 产物预览。工作台结果页与「项目与产物」共用**同一份**渲染规则。
 *
 * 为什么能直接内联渲染：后端产物接口只设 `content-type`、**没有
 * Content-Disposition**（见 `packages/server/src/app.ts` 的产物路由），
 * 所以 iframe / img 指向它就能就地显示，不需要前端二次加工。
 *
 * 四类：
 *   - 网页、演示文稿 → iframe。`sandbox="allow-scripts"` 且**不含
 *     allow-same-origin**：产物 HTML 拿不到父页面的 DOM 与存储。
 *   - 图片 → img
 *   - 文本 → pre（内容要经接口取回，所以有独立加载态）
 *   - 其它 → 如实说明"不适合在页面里预览"，不假装能看
 */
import { computed, ref, watch } from 'vue';
import { NSpin } from 'naive-ui';
import { api, isHtmlArtifact, isImageArtifact, isTextArtifact } from '@/api/client';

const props = defineProps<{
  runId: string;
  path: string;
  size?: number | undefined;
  mimeHint?: string | undefined;
  /** 预览区高度。不给就由外层 CSS 决定（例如 `clamp()`）。 */
  height?: string | undefined;
}>();

const kind = computed(() => {
  const artifact = { path: props.path, size: props.size ?? 0, mimeHint: props.mimeHint ?? '' };
  if (isHtmlArtifact(artifact)) return 'html' as const;
  if (isImageArtifact(artifact)) return 'image' as const;
  if (isTextArtifact(artifact)) return 'text' as const;
  return 'binary' as const;
});

const url = computed(() => api.artifactUrl(props.runId, props.path));

const text = ref('');
const textLoading = ref(false);

watch(
  () => [props.runId, props.path, kind.value] as const,
  async ([runId, path, k]) => {
    if (k !== 'text') {
      text.value = '';
      return;
    }
    textLoading.value = true;
    try {
      text.value = await api.artifactText(runId, path);
    } catch {
      text.value = '（读取失败：产物可能已随沙盒回收）';
    } finally {
      textLoading.value = false;
    }
  },
  { immediate: true }
);
</script>

<template>
  <div class="artifact-preview" :style="height !== undefined ? { height } : undefined">
    <iframe
      v-if="kind === 'html'"
      :src="url"
      class="artifact-preview__frame"
      sandbox="allow-scripts"
      title="产物预览"
    />
    <img v-else-if="kind === 'image'" :src="url" class="artifact-preview__image" alt="产物" />
    <NSpin v-else-if="textLoading" size="small" />
    <pre v-else-if="kind === 'text'" class="artifact-preview__code">{{ text }}</pre>
    <div v-else class="artifact-preview__empty">这个文件不适合在页面里预览，下载后查看</div>
  </div>
</template>

<style scoped>
.artifact-preview {
  width: 100%;
}

.artifact-preview__frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.4));
  border-radius: 4px;
  background: #fff;
}

.artifact-preview__image {
  max-width: 100%;
  border-radius: 4px;
}

.artifact-preview__code {
  margin: 0;
  padding: 10px;
  max-height: 60vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.4));
  border-radius: 4px;
}

.artifact-preview__empty {
  padding: 24px;
  text-align: center;
  opacity: 0.7;
}
</style>
