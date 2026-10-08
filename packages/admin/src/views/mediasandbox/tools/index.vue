<template>
  <div class="ms-tools">
    <el-card shadow="never">
      <div class="ms-tools__bar">
        <el-radio-group v-model="envFilter">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="auto">自动判定</el-radio-button>
          <el-radio-button v-for="env in ENV_TYPES" :key="env" :value="env">
            {{ ENV_LABELS[env].label }}
          </el-radio-button>
        </el-radio-group>
        <el-button :loading="isLoading" @click="fetchTools">刷新</el-button>
        <span class="ms-tools__note">共 {{ tools.length }} 个工具</span>
      </div>

      <el-alert
        class="mt-3"
        type="info"
        :closable="false"
        show-icon
        title="工具体系（与 block 池同构）"
        description="候选集来自注册表：扩展 = 加一条工具声明，不重训模型。标注「需授权」的工具只有在成本闸门打开时才会进入候选。"
      />

      <el-table :data="tools" size="small" border class="mt-3">
        <el-table-column label="工具" min-width="200">
          <template #default="{ row }">
            <span class="ms-tools__label">{{ row.label }}</span>
            <span class="ms-tools__id">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="100">
          <template #default="{ row }">
            <el-tag size="small" type="info">{{ row.role }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="适用环境" min-width="180">
          <template #default="{ row }">
            <el-tag v-for="env in row.envTypes" :key="env" size="small" class="ms-tools__env">
              {{ env }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="120">
          <template #default="{ row }">{{ row.category }}</template>
        </el-table-column>
        <el-table-column label="成本" width="90">
          <template #default="{ row }">
            <span>{{ row.costHint ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="授权" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.requiresPermission" size="small" type="warning">需授权</el-tag>
            <span v-else class="ms-tools__muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="说明" min-width="240">
          <template #default="{ row }">
            <span class="ms-tools__desc">{{ row.description }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ApiError, MediaSandboxAPI } from "@/api/mediasandbox/client";
import { ENV_LABELS, ENV_TYPES, type EnvChoice, type ToolSpec } from "@/api/mediasandbox/types";

defineOptions({ name: "MsTools" });

const envFilter = ref<EnvChoice | "all">("all");
const tools = ref<ToolSpec[]>([]);
const isLoading = ref(false);

async function fetchTools(): Promise<void> {
  isLoading.value = true;
  try {
    const result = await MediaSandboxAPI.tools(
      envFilter.value === "all" ? undefined : envFilter.value
    );
    tools.value = result.tools;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "工具目录加载失败");
  } finally {
    isLoading.value = false;
  }
}

watch(envFilter, fetchTools);
onMounted(fetchTools);
</script>

<style scoped lang="scss">
.ms-tools {
  &__bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  &__note {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__label {
    margin-right: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__id {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__env {
    margin-right: 4px;
  }

  &__desc,
  &__muted {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }
}
</style>
