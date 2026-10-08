<template>
  <el-card shadow="never" class="run-stream">
    <template #header>
      <div class="run-stream__header">
        <span class="run-stream__title">运行流水</span>
        <div class="run-stream__meta">
          <el-tag v-if="view.runId" size="small" type="info">{{ view.runId }}</el-tag>
          <el-tag size="small" :type="statusType">{{ statusText }}</el-tag>
          <el-tag size="small" :type="connectionType">{{ connectionText }}</el-tag>
        </div>
      </div>
    </template>

    <el-empty v-if="events.length === 0" description="还没有事件：提交一次创作，或从「运行与产物」里选一次运行" />

    <template v-else>
      <!-- 目标分类留痕：环境是谁定的、依据是什么，必须看得见 -->
      <el-alert
        v-if="view.envClassified"
        class="run-stream__env"
        type="info"
        :closable="false"
        show-icon
        :title="envClassifiedTitle"
        :description="view.envClassified.detail"
      />

      <el-alert
        v-if="view.reason"
        class="run-stream__env"
        type="warning"
        :closable="false"
        show-icon
        title="结束原因"
        :description="view.reason"
      />

      <div v-if="view.rationale.length > 0" class="run-stream__rationale">
        <p class="run-stream__section-title">排布依据</p>
        <ul class="run-stream__list">
          <li v-for="(line, i) in view.rationale" :key="i">{{ line }}</li>
        </ul>
      </div>

      <div v-for="attempt in view.attempts" :key="attempt.attempt" class="run-stream__attempt">
        <p class="run-stream__section-title">
          第 {{ attempt.attempt }} 次尝试
          <span v-if="attempt.switches > 0" class="run-stream__switch">
            （换方案 {{ attempt.switches }} 次）
          </span>
          <el-tag size="small" :type="attemptType(attempt.status)">{{ attempt.status }}</el-tag>
        </p>
        <p v-if="attempt.detail" class="run-stream__detail">{{ attempt.detail }}</p>

        <div v-for="node in attempt.nodes" :key="node.nodeId" class="run-stream__node">
          <div class="run-stream__node-head">
            <el-tag size="small" :type="nodeType(node.status)">{{ node.status }}</el-tag>
            <span class="run-stream__node-id">{{ node.nodeId }}</span>
            <span class="run-stream__node-tool">{{ node.toolId }}</span>
            <span v-if="node.attempts > 1" class="run-stream__node-retry">
              第 {{ node.attempts }} 次
            </span>
            <span v-if="node.durationMs !== undefined" class="run-stream__node-duration">
              {{ node.durationMs }} ms
            </span>
          </div>
          <p v-if="node.note" class="run-stream__node-note">{{ node.note }}</p>
          <p v-if="node.summary" class="run-stream__node-summary">{{ node.summary }}</p>
          <p v-if="node.error" class="run-stream__node-error">{{ node.error }}</p>
          <el-collapse v-if="node.logs.length > 0">
            <el-collapse-item :title="`日志（${node.logs.length}）`" :name="node.nodeId">
              <pre class="run-stream__logs">{{ node.logs.join("\n") }}</pre>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { foldEvents } from "@/api/mediasandbox/view-model";
import type { ConnectionState } from "@/composables/useRunStream";
import type { RunStatus, WireEvent } from "@/api/mediasandbox/types";

const props = defineProps<{
  events: readonly WireEvent[];
  connection: ConnectionState;
}>();

const view = computed(() => foldEvents(props.events));

const statusText = computed(() => {
  const status = view.value.status;
  if (status === "unknown") return "未开始";
  const labels: Record<RunStatus, string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    escalated: "已升级",
    cancelled: "已取消"
  };
  return labels[status];
});

const statusType = computed(() => {
  switch (view.value.status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "escalated":
      return "warning";
    case "cancelled":
      return "info";
    default:
      return "primary";
  }
});

const connectionText = computed(() => {
  switch (props.connection) {
    case "open":
      return "已连接";
    case "connecting":
      return "连接中";
    default:
      return "已断开（自动重连）";
  }
});

const connectionType = computed(() => (props.connection === "open" ? "success" : "info"));

const envClassifiedTitle = computed(() => {
  const classified = view.value.envClassified;
  if (classified === undefined) return "";
  const who = classified.source === "decision" ? "决策层判定" : "兜底（判定失败）";
  return `环境：${classified.envType}（${who}）`;
});

function nodeType(status: string): "success" | "danger" | "warning" | "info" | "primary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "primary";
    case "skipped":
      return "warning";
    default:
      return "info";
  }
}

function attemptType(status: string): "success" | "danger" | "primary" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "primary";
}
</script>

<style scoped lang="scss">
.run-stream {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__env {
    margin-bottom: 12px;
  }

  &__rationale {
    margin-bottom: 12px;
  }

  &__section-title {
    margin: 0 0 6px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--el-text-color-regular);
  }

  &__switch {
    margin: 0 6px;
    font-weight: 400;
    color: var(--el-color-warning);
  }

  &__list {
    margin: 0;
    padding-left: 18px;
    font-size: 0.75rem;
    line-height: 1.7;
    color: var(--el-text-color-secondary);
  }

  &__attempt {
    padding-top: 8px;
    border-top: 1px solid var(--el-border-color-lighter);
  }

  &__detail {
    margin: 0 0 8px;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__node {
    padding: 8px 10px;
    margin-bottom: 8px;
    background: var(--el-fill-color-lighter);
    border-radius: 6px;
  }

  &__node-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__node-id {
    font-family: monospace;
    font-size: 0.8125rem;
    color: var(--el-text-color-primary);
  }

  &__node-tool {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__node-retry {
    font-size: 0.75rem;
    color: var(--el-color-warning);
  }

  &__node-duration {
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__node-note,
  &__node-summary {
    margin: 4px 0 0;
    font-size: 0.75rem;
    color: var(--el-text-color-regular);
  }

  &__node-error {
    margin: 4px 0 0;
    font-size: 0.75rem;
    color: var(--el-color-danger);
  }

  &__logs {
    max-height: 200px;
    margin: 0;
    overflow: auto;
    font-size: 0.75rem;
    white-space: pre-wrap;
  }
}
</style>
