<template>
  <div class="ms-workbench">
    <div class="ms-workbench__left">
      <RunForm @submitted="handleSubmitted" />
    </div>

    <div class="ms-workbench__right">
      <RunStream :events="events" :connection="connection" />
      <StructureSummary class="mt-4" :structure="view.structure" :blocks="blocks" />

      <div v-if="view.runId" class="ms-workbench__actions">
        <el-button
          type="primary"
          link
          @click="router.push({ path: '/mediasandbox/structure', query: { runId: view.runId } })"
        >
          在结构画布中打开这次运行 →
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import RunForm from "@/views/mediasandbox/components/RunForm.vue";
import RunStream from "@/views/mediasandbox/components/RunStream.vue";
import StructureSummary from "@/views/mediasandbox/components/StructureSummary.vue";
import { useRunStream } from "@/composables/useRunStream";
import { foldEvents } from "@/api/mediasandbox/view-model";
import { MediaSandboxAPI, ApiError } from "@/api/mediasandbox/client";
import type { BlockSpec } from "@/api/mediasandbox/types";

defineOptions({ name: "MsWorkbench" });

const router = useRouter();
const activeRunId = ref<string | undefined>(undefined);
const blocks = ref<BlockSpec[]>([]);

const { events, connection } = useRunStream(() => activeRunId.value);
const view = computed(() => foldEvents(events.value));

function handleSubmitted(runId: string): void {
  // 换 runId 会自动重订阅：服务端会补发该次运行的历史事件，不需要前端拼接。
  activeRunId.value = runId;
}

async function loadBlockPool(): Promise<void> {
  try {
    blocks.value = (await MediaSandboxAPI.blocks()).blocks;
  } catch (error) {
    ElMessage.warning(error instanceof ApiError ? error.message : "block 池加载失败");
  }
}

onMounted(loadBlockPool);
</script>

<style scoped lang="scss">
.ms-workbench {
  display: grid;
  grid-template-columns: minmax(320px, 420px) 1fr;
  gap: 16px;
  align-items: start;

  @media (max-width: 1100px) {
    grid-template-columns: 1fr;
  }

  &__actions {
    margin-top: 8px;
  }
}
</style>
