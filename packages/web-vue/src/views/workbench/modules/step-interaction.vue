<script setup lang="ts">
/**
 * 第 3 步：模型交互测试。
 *
 * 做的是**真点击**：后端用真浏览器打开上次产出的页面，挑一个可点元素点一下，
 * 由代码判断点击后页面有没有变化（`POST /api/runs/:id/verify-interaction`）。
 *
 * 结论只有三种，界面必须分清：
 *   - 点成了：`passed`
 *   - 点了但没点中 / 没变化：`passed === false`，原因在 `detail`
 *   - 页面上没有可点目标：`targetCount === 0`，**如实说没做验证**，不冒充成功
 *
 * 能力缺失（本机没有浏览器驱动）也要提前说：先查 `/api/health` 的 browser 字段，
 * 免得用户点下去才看到 503。
 */
import { computed, onMounted, ref } from 'vue';
import { NAlert, NButton, NCard, NSpin, NTag, useMessage } from 'naive-ui';
import { api, ApiError } from '@/api/client';
import { useWorkbenchStore } from '@/store/modules/workbench';
import { formatDuration, STATUS_STYLE } from '@/utils/format';

const emit = defineEmits<{ next: []; back: [] }>();

const store = useWorkbenchStore();
const message = useMessage();

/** undefined = 还没查过；true/false = 本机能不能真点。 */
const interactionCapable = ref<boolean | undefined>(undefined);
const healthError = ref<string | undefined>(undefined);

const verdict = computed(() => store.verdict);
const passed = computed(() => store.verdict?.passed === true);
const skipped = computed(
  () => store.verdict !== null && store.verdict.targetCount === 0 && !store.verdict.passed
);

const verdictType = computed<'success' | 'warning' | 'error'>(() => {
  if (passed.value) return 'success';
  return skipped.value ? 'warning' : 'error';
});

const verdictLabel = computed(() => {
  if (passed.value) return '点成了';
  if (skipped.value) return '没有可点的目标，未做验证';
  return '没点中';
});

async function runTest(): Promise<void> {
  if (store.runId === undefined) {
    message.warning('还没有运行：先在第 2 步提交一次');
    return;
  }
  await store.verifyInteraction();
  if (store.verifyError !== undefined) message.error(store.verifyError);
}

function goNext(): void {
  if (store.interactionBlocker !== null) return;
  emit('next');
}

onMounted(async () => {
  if (store.runId !== undefined) {
    // 刷新后回到这一步时，把结论相关的状态补齐（结论本身不落盘，重测一次才有）。
    void store.hydrate();
  }
  try {
    const health = await api.health();
    interactionCapable.value = health.browser?.interaction === 'chromium';
  } catch (error) {
    healthError.value = error instanceof ApiError ? error.message : '读取本机能力失败';
  }
});
</script>

<template>
  <div class="wb__stack">
    <div class="wb__head">
      <span class="wb__title">模型交互测试</span>
      <span class="wb__sub">真浏览器点一下，由代码判断点没点中</span>
    </div>

    <NCard size="small" :bordered="false" class="wb__card">
      <template #header>
        <span class="wb__no">3</span>
        <span>点一下页面</span>
        <span v-if="store.runId" class="wb__hint">
          {{ store.runId }} · {{ STATUS_STYLE[store.status].label }}
        </span>
      </template>

      <div v-if="store.runId === undefined" class="wb__empty">
        还没有运行。先去第 2 步提交一次，产出页面之后这里才有东西可点。
        <div class="wb__actions" style="justify-content: center">
          <NButton size="small" secondary @click="emit('back')">回第 2 步</NButton>
        </div>
      </div>

      <template v-else>
        <p class="wb__note">
          用真浏览器打开这次运行的页面，挑一个可点元素点一下，看点击后页面有没有变化。
          点不中、点了没变化、没有可点目标，都会如实算作没通过。
        </p>

        <NAlert
          v-if="interactionCapable === false"
          type="warning"
          :bordered="false"
          class="mb-2"
        >
          本机没有可用的浏览器驱动：接口会返回 503，这一步只能跳过，结果页仍可看产物。
        </NAlert>
        <NAlert v-if="healthError" type="default" :bordered="false" class="mb-2">
          读取本机能力失败（不影响尝试）：{{ healthError }}
        </NAlert>

        <div class="wb__actions" style="margin-top: 4px">
          <NButton type="primary" :loading="store.verifying" @click="runTest">
            {{ verdict === null ? '开始交互测试' : '再测一次' }}
          </NButton>
          <span class="wb__hint">
            调用 POST /api/runs/:runId/verify-interaction，按次真开浏览器
          </span>
        </div>

        <NAlert v-if="store.verifyError" type="error" :bordered="false" class="mt-2">
          {{ store.verifyError }}
        </NAlert>

        <div v-if="verdict" class="wb__section">
          <div class="wb__section-head">
            <NTag size="small" :type="verdictType">{{ verdictLabel }}</NTag>
            <span class="wb__section-count">
              驱动 {{ verdict.driver }}
              <template v-if="verdict.placeholder">· 占位驱动，不代表真浏览器</template>
            </span>
            <span v-if="store.verifyMs !== undefined" class="wb__section-count">
              · 接口往返 {{ formatDuration(store.verifyMs) }}
            </span>
          </div>

          <div class="wb__verdict">{{ verdict.detail }}</div>

          <div class="wb__verdict">
            <span class="wb__kv">
              <span class="wb__kv-key">可点目标</span>{{ verdict.targetCount }} 个
            </span>
            <span v-if="verdict.picked" class="wb__kv">
              <span class="wb__kv-key">点了</span>
              {{ verdict.picked.label }}（{{ verdict.picked.kind }} / {{ verdict.picked.key }}）
            </span>
            <span v-else class="wb__kv">
              <span class="wb__kv-key">点了</span>没有点中任何元素
            </span>
          </div>

          <NAlert v-if="skipped" type="warning" :bordered="false" class="mt-2">
            页面上没有可点的目标，这次没有做验证——不是通过，也不是失败。
          </NAlert>

          <ul v-if="(verdict.attempts?.length ?? 0) > 0" class="wb__attempts">
            <li v-for="(line, index) in verdict.attempts ?? []" :key="index">{{ line }}</li>
          </ul>

          <img
            v-if="verdict.screenshotPath"
            :src="api.artifactUrl(store.runId ?? '', verdict.screenshotPath)"
            class="wb__click-shot"
            alt="点击后截图"
          />
        </div>

        <div v-else-if="store.verifying" class="wb__empty">
          <NSpin size="small" />
          <span style="margin-left: 8px">正在打开页面并点击……</span>
        </div>

        <div v-else class="wb__empty">还没测过。点上面的「开始交互测试」。</div>

        <div class="wb__actions">
          <NButton size="small" secondary @click="emit('back')">上一步</NButton>
          <NButton type="primary" size="small" :disabled="store.interactionBlocker !== null" @click="goNext">
            下一步：看结果
          </NButton>
          <span v-if="verdict === null" class="wb__hint">没测过也可以直接看结果</span>
        </div>
      </template>
    </NCard>
  </div>
</template>
