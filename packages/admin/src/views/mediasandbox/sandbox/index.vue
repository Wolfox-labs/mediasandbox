<template>
  <div class="ms-sandbox">
    <el-card shadow="never">
      <template #header>
        <div class="ms-sandbox__header">
          <span class="ms-sandbox__title">后端健康状况</span>
          <el-button :loading="isLoading" @click="fetchHealth">刷新</el-button>
        </div>
      </template>

      <el-empty v-if="!health" description="还没取到健康信息（后端没起？看下面的错误）" />

      <template v-else>
        <div class="ms-sandbox__grid">
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">服务</p>
            <el-tag :type="health.ok ? 'success' : 'danger'">
              {{ health.ok ? "正常" : "异常" }}
            </el-tag>
          </div>
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">决策层</p>
            <el-tag :type="health.decision.ok ? 'success' : 'danger'">
              {{ health.decision.ok ? "可用" : "不可用" }}
            </el-tag>
            <p class="ms-sandbox__detail">{{ health.decision.detail }}</p>
          </div>
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">生成层（LLM）</p>
            <el-tag :type="health.llm.ok ? 'success' : 'danger'">
              {{ health.llm.ok ? "可用" : "不可用" }}
            </el-tag>
            <p class="ms-sandbox__detail">{{ health.llm.detail }}</p>
          </div>
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">工具数</p>
            <span class="ms-sandbox__value">{{ health.toolCount }}</span>
          </div>
        </div>

        <el-divider content-position="left">沙盒实现</el-divider>
        <div class="ms-sandbox__providers">
          <el-tag
            v-for="provider in health.providers"
            :key="provider"
            :type="provider === health.defaultProvider ? 'primary' : 'info'"
          >
            {{ provider }}{{ provider === health.defaultProvider ? "（默认）" : "" }}
          </el-tag>
        </div>

        <el-divider content-position="left">运行概览</el-divider>
        <div class="ms-sandbox__grid">
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">运行记录</p>
            <span class="ms-sandbox__value">{{ runCount }}</span>
          </div>
          <div class="ms-sandbox__item">
            <p class="ms-sandbox__label">项目</p>
            <span class="ms-sandbox__value">{{ projectCount }}</span>
          </div>
        </div>
      </template>

      <el-alert
        v-if="errorText"
        class="mt-3"
        type="error"
        :closable="false"
        show-icon
        title="取健康信息失败"
        :description="errorText"
      />
    </el-card>

    <el-card shadow="never" class="mt-4">
      <template #header>
        <span class="ms-sandbox__title">说明</span>
      </template>
      <ul class="ms-sandbox__list">
        <li>Local 与 Docker 两个沙盒实现跑同一套契约测试，产物 SHA-256 逐字节一致。</li>
        <li>容器默认 <code>network=none</code>：产物必须自包含，任何外链都是必然失败。</li>
        <li>运行记录、自定义 block、沉淀模板都已落盘，重启后仍在（<code>data/</code>）。</li>
        <li>运行期数据目录：<code>data/</code>（记录）、<code>workspaces/</code>（沙盒工作区）、<code>projects/</code>（交付物落定副本，只增不减）。</li>
      </ul>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiError, MediaSandboxAPI } from "@/api/mediasandbox/client";
import type { HealthResponse } from "@/api/mediasandbox/types";

defineOptions({ name: "MsSandbox" });

const health = ref<HealthResponse | null>(null);
const runCount = ref(0);
const projectCount = ref(0);
const isLoading = ref(false);
const errorText = ref("");

async function fetchHealth(): Promise<void> {
  isLoading.value = true;
  errorText.value = "";
  try {
    health.value = await MediaSandboxAPI.health();
  } catch (error) {
    health.value = null;
    errorText.value = error instanceof ApiError ? `${error.message}${error.detail ?? ""}` : "未知错误";
  } finally {
    isLoading.value = false;
  }
}

async function fetchCounts(): Promise<void> {
  try {
    const [runs, projects] = await Promise.all([
      MediaSandboxAPI.listRuns(),
      MediaSandboxAPI.listProjects()
    ]);
    runCount.value = runs.runs.length;
    projectCount.value = projects.projects.length;
  } catch {
    // 概览取不到不影响健康信息本身，静默即可。
  }
}

onMounted(async () => {
  await Promise.all([fetchHealth(), fetchCounts()]);
});
</script>

<style scoped lang="scss">
.ms-sandbox {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }

  &__item {
    padding: 10px 12px;
    background: var(--el-fill-color-lighter);
    border-radius: 6px;
  }

  &__label {
    margin: 0 0 6px;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__value {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__detail {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
    word-break: break-all;
  }

  &__providers {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__list {
    margin: 0;
    padding-left: 18px;
    font-size: 0.8125rem;
    line-height: 1.9;
    color: var(--el-text-color-regular);
  }
}
</style>
