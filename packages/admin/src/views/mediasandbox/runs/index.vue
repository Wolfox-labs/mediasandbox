<template>
  <div class="ms-runs">
    <el-card shadow="never">
      <div class="ms-runs__bar">
        <el-radio-group v-model="viewMode">
          <el-radio-button value="projects">项目</el-radio-button>
          <el-radio-button value="runs">运行流水</el-radio-button>
        </el-radio-group>
        <el-button :loading="isLoading" @click="fetchAll">刷新</el-button>
        <span class="ms-runs__note">点开一次运行可以看产物、预览、下载与取消</span>
      </div>

      <el-table
        v-if="viewMode === 'projects'"
        :data="projects"
        size="small"
        border
        class="mt-3"
        row-key="projectId"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="ms-runs__nested">
              <div v-for="run in row.runs" :key="run.id" class="ms-runs__nested-row">
                <span class="ms-runs__goal">{{ run.goal.slice(0, 40) }}</span>
                <span class="ms-runs__mono">{{ run.id }}</span>
                <el-tag size="small" :type="statusType(run.status)">{{ run.status }}</el-tag>
                <span class="ms-runs__muted">{{ run.artifactCount }} 个产物</span>
                <el-button link @click="openRun(run.id)">查看产物</el-button>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="项目" min-width="200">
          <template #default="{ row }">
            <span class="ms-runs__goal">{{ row.goal.slice(0, 36) }}</span>
            <span class="ms-runs__mono">{{ row.projectId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="环境" width="110">
          <template #default="{ row }">{{ row.envType }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="运行/产物" width="120">
          <template #default="{ row }">{{ row.runCount }} 次 / {{ row.artifactCount }} 个</template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }">
            <el-button link @click="handleExport(row.projectId)">导出 ZIP</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-table v-else :data="runs" size="small" border class="mt-3">
        <el-table-column label="目标" min-width="240">
          <template #default="{ row }">
            <span class="ms-runs__goal">{{ row.goal.slice(0, 44) }}</span>
            <span class="ms-runs__mono">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="环境" width="110">
          <template #default="{ row }">{{ row.envType }}</template>
        </el-table-column>
        <el-table-column label="provider" width="100">
          <template #default="{ row }">{{ row.provider }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="产物" width="70">
          <template #default="{ row }">{{ row.artifactCount }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <el-button link @click="openRun(row.id)">产物</el-button>
            <el-button
              link
              type="danger"
              :disabled="isTerminalStatus(row.status)"
              @click="handleCancel(row.id)"
            >
              取消
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="isArtifactVisible" :title="`产物 · ${activeRunId}`" width="820px">
      <el-table :data="artifacts" size="small" border>
        <el-table-column label="文件" min-width="240">
          <template #default="{ row }">
            <span class="ms-runs__mono">{{ row.path }}</span>
            <el-tag v-if="row.settled" size="small" type="success">已落定</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="140">
          <template #default="{ row }">{{ row.mimeHint }}</template>
        </el-table-column>
        <el-table-column label="体积" width="100">
          <template #default="{ row }">{{ formatBytes(row.size) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link @click="handlePreview(asArtifact(row))">预览</el-button>
            <el-button link @click="handleDownload(asArtifact(row))">下载</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="previewText !== ''" class="ms-runs__preview">
        <p class="ms-runs__preview-title">{{ previewTitle }}</p>
        <pre class="ms-runs__preview-body">{{ previewText }}</pre>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  ApiError,
  MediaSandboxAPI,
  formatBytes,
  isTextArtifact
} from "@/api/mediasandbox/client";
import {
  isTerminal,
  type Artifact,
  type ProjectItem,
  type RunListItem,
  type RunStatus
} from "@/api/mediasandbox/types";

defineOptions({ name: "MsRuns" });

const viewMode = ref<"projects" | "runs">("projects");
const projects = ref<ProjectItem[]>([]);
const runs = ref<RunListItem[]>([]);
const artifacts = ref<Artifact[]>([]);
const activeRunId = ref("");
const isArtifactVisible = ref(false);
const isLoading = ref(false);
const previewText = ref("");
const previewTitle = ref("");

function reportError(error: unknown): void {
  ElMessage.error(error instanceof ApiError ? error.message : "操作失败");
}

/** el-table 的插槽行类型是 `DefaultRow`，业务函数只认产物，这里收窄一次。 */
function asArtifact(row: unknown): Artifact {
  return row as Artifact;
}

function statusType(status: string): "success" | "danger" | "warning" | "info" | "primary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "escalated":
      return "warning";
    case "running":
      return "primary";
    default:
      return "info";
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return isTerminal(status);
}

async function fetchAll(): Promise<void> {
  isLoading.value = true;
  try {
    const [projectResult, runResult] = await Promise.all([
      MediaSandboxAPI.listProjects(),
      MediaSandboxAPI.listRuns()
    ]);
    projects.value = projectResult.projects;
    runs.value = runResult.runs;
  } catch (error) {
    reportError(error);
  } finally {
    isLoading.value = false;
  }
}

async function openRun(runId: string): Promise<void> {
  activeRunId.value = runId;
  previewText.value = "";
  try {
    artifacts.value = (await MediaSandboxAPI.listArtifacts(runId)).artifacts;
    isArtifactVisible.value = true;
  } catch (error) {
    reportError(error);
  }
}

async function handlePreview(artifact: Artifact): Promise<void> {
  if (!isTextArtifact(artifact)) {
    ElMessage.info("这个产物不是文本类型，直接下载看吧");
    return;
  }
  try {
    previewTitle.value = artifact.path;
    previewText.value = await MediaSandboxAPI.artifactText(activeRunId.value, artifact.path);
  } catch (error) {
    reportError(error);
  }
}

function handleDownload(artifact: Artifact): void {
  window.open(MediaSandboxAPI.artifactUrl(activeRunId.value, artifact.path), "_blank");
}

function handleExport(projectId: string): void {
  window.open(MediaSandboxAPI.exportProjectUrl(projectId), "_blank");
}

async function handleCancel(runId: string): Promise<void> {
  try {
    const result = await MediaSandboxAPI.cancelRun(runId);
    ElMessage.success(result.cancelled ? "已取消" : "这次运行已经结束了");
    await fetchAll();
  } catch (error) {
    reportError(error);
  }
}

onMounted(fetchAll);
</script>

<style scoped lang="scss">
.ms-runs {
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

  &__nested {
    padding: 4px 12px;
  }

  &__nested-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
  }

  &__goal {
    margin-right: 8px;
    font-size: 0.8125rem;
    color: var(--el-text-color-primary);
  }

  &__mono {
    margin-right: 8px;
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__muted {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__preview {
    margin-top: 12px;
  }

  &__preview-title {
    margin: 0 0 4px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__preview-body {
    max-height: 360px;
    padding: 10px;
    margin: 0;
    overflow: auto;
    font-size: 0.75rem;
    white-space: pre-wrap;
    background: var(--el-fill-color-lighter);
    border-radius: 6px;
  }
}
</style>
