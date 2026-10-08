<template>
  <div class="ms-structure">
    <el-card shadow="never" class="ms-structure__toolbar">
      <div class="ms-structure__bar">
        <el-select
          v-model="runId"
          filterable
          placeholder="选择一次运行"
          class="ms-structure__run-select"
          @change="loadStructure"
        >
          <el-option
            v-for="run in runs"
            :key="run.id"
            :label="`${run.goal.slice(0, 28)}（${run.envType}·${run.status}）`"
            :value="run.id"
          />
        </el-select>
        <el-button :loading="isLoading" @click="loadStructure">读取结构</el-button>
      </div>

      <el-alert
        v-if="!canRerun"
        class="mt-3"
        type="warning"
        :closable="false"
        show-icon
        title="「改完结构重新生成」暂不可用"
        description="后端 POST /api/runs 目前还没有读取 pageSpec 字段（解析层 parsePageSpecInput 已实现，入口尚未接上）。
编辑本身会立刻落库、重启后仍在，但要让改动体现到产物上，还需要那个入口。"
      />
    </el-card>

    <el-card shadow="never" class="mt-4">
      <template #header>
        <div class="ms-structure__header">
          <span class="ms-structure__title">结构编辑</span>
          <div class="ms-structure__insert">
            <el-select v-model="insertType" placeholder="要插入的 block 类型" class="ms-structure__type-select">
              <el-option
                v-for="block in blocks"
                :key="block.id"
                :label="`${block.label}（${block.groupLabel}）`"
                :value="block.id"
              />
            </el-select>
            <el-button :disabled="runId === '' || insertType === ''" @click="handleAppend">
              追加到末尾
            </el-button>
          </div>
        </div>
      </template>

      <el-empty v-if="!structure" description="选一次运行再读取结构" />

      <template v-else>
        <p class="ms-structure__hint">
          {{ structure.page.blocks.length }} 块 · 项目 {{ structure.page.projectId }} ·
          结构评分 {{ structure.page.qualityScore ?? "—" }}
        </p>

        <div v-if="fixes.length > 0" class="ms-structure__fixes">
          <el-alert
            type="info"
            :closable="true"
            show-icon
            title="版式规范化改动了这些地方"
            @close="fixes = []"
          >
            <ul class="ms-structure__fix-list">
              <li v-for="(fix, i) in fixes" :key="i">
                {{ fix.kind === "moved" ? "移位" : "移除" }} {{ fix.blockId }}：{{ fix.detail }}
              </li>
            </ul>
          </el-alert>
        </div>

        <el-table :data="rows" size="small" border>
          <el-table-column label="#" width="48">
            <template #default="{ $index }">{{ $index + 1 }}</template>
          </el-table-column>
          <el-table-column label="block" min-width="200">
            <template #default="{ row }">
              <span class="ms-structure__type">{{ labelOf(row.block.type) }}</span>
              <span class="ms-structure__id">{{ row.block.id }}</span>
              <el-tag v-if="placementOf(row.block.type)" size="small" type="warning">
                {{ placementOf(row.block.type) === "first" ? "固定开头" : "固定末尾" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="statusType(row.block.status)">
                {{ row.block.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="slots" min-width="160">
            <template #default="{ row }">
              <span class="ms-structure__slots">{{ row.block.slotNames.join("、") }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="260">
            <template #default="{ row }">
              <el-button link :disabled="row.index === 0 || isBusy" @click="handleMove(row.index, -1)">
                上移
              </el-button>
              <el-button
                link
                :disabled="row.index === rows.length - 1 || isBusy"
                @click="handleMove(row.index, 1)"
              >
                下移
              </el-button>
              <el-button link :disabled="insertType === '' || isBusy" @click="handleInsert(row.index)">
                前插
              </el-button>
              <el-button link type="danger" :disabled="isBusy" @click="handleRemove(row.block.id)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-card>

    <StructureSummary class="mt-4" :structure="structure ?? undefined" :blocks="blocks" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import StructureSummary from "@/views/mediasandbox/components/StructureSummary.vue";
import { ApiError, MediaSandboxAPI } from "@/api/mediasandbox/client";
import type {
  BlockSpec,
  RunListItem,
  StructureFix,
  StructureOp,
  StructureView
} from "@/api/mediasandbox/types";

defineOptions({ name: "MsStructure" });

const route = useRoute();

/** 后端尚未在 `POST /api/runs` 上读取 `pageSpec`，所以"重新生成"这个动作做不了。 */
const canRerun = false;

const runs = ref<RunListItem[]>([]);
const blocks = ref<BlockSpec[]>([]);
const structure = ref<StructureView | null>(null);
const fixes = ref<StructureFix[]>([]);
const runId = ref<string>(typeof route.query.runId === "string" ? route.query.runId : "");
const insertType = ref("");
const isLoading = ref(false);
const isBusy = ref(false);

const rows = computed(() =>
  (structure.value?.page.blocks ?? []).map((block, index) => ({ block, index }))
);

function specOf(type: string): BlockSpec | undefined {
  return blocks.value.find(block => block.id === type);
}

function labelOf(type: string): string {
  return specOf(type)?.label ?? type;
}

function placementOf(type: string): "first" | "last" | undefined {
  const placement = specOf(type)?.placement;
  return placement === undefined || placement === "any" ? undefined : placement;
}

function statusType(status: string): "success" | "danger" | "warning" | "info" {
  switch (status) {
    case "filled":
      return "success";
    case "failed":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "info";
  }
}

function reportError(error: unknown): void {
  if (error instanceof ApiError) {
    // 409 与 400 的含义不同：前者是"现在不能改"，后者是"这条指令本身不合法"。
    ElMessage.error(error.detail ? `${error.message}：${error.detail}` : error.message);
    return;
  }
  ElMessage.error("操作失败");
}

async function loadStructure(): Promise<void> {
  if (runId.value === "") {
    ElMessage.warning("请先选择一次运行");
    return;
  }
  isLoading.value = true;
  fixes.value = [];
  try {
    structure.value = (await MediaSandboxAPI.structure(runId.value)).structure;
  } catch (error) {
    structure.value = null;
    reportError(error);
  } finally {
    isLoading.value = false;
  }
}

/** 一次只提交一条 op：整批原子，单条失败时用户能立刻知道是哪一步不成立。 */
async function applyOp(op: StructureOp): Promise<void> {
  isBusy.value = true;
  try {
    const result = await MediaSandboxAPI.applyStructureOps(runId.value, [op]);
    structure.value = result.structure;
    fixes.value = [...result.fixes];
    if (result.fixes.length > 0) {
      ElMessage.info("版式规范化调整了结构，见上方提示");
    }
  } catch (error) {
    reportError(error);
  } finally {
    isBusy.value = false;
  }
}

function handleMove(index: number, delta: number): void {
  const block = structure.value?.page.blocks[index];
  if (block === undefined) return;
  void applyOp({ op: "move", blockId: block.id, toIndex: index + delta });
}

function handleInsert(index: number): void {
  void applyOp({ op: "insert", index, type: insertType.value });
}

function handleAppend(): void {
  void applyOp({ op: "append", type: insertType.value });
}

function handleRemove(blockId: string): void {
  void applyOp({ op: "remove", blockId });
}

async function loadOptions(): Promise<void> {
  try {
    const [runResult, blockResult] = await Promise.all([
      MediaSandboxAPI.listRuns(),
      MediaSandboxAPI.blocks()
    ]);
    runs.value = runResult.runs;
    blocks.value = blockResult.blocks;
  } catch (error) {
    reportError(error);
  }
  if (runId.value !== "") await loadStructure();
}

onMounted(loadOptions);
</script>

<style scoped lang="scss">
.ms-structure {
  &__bar {
    display: flex;
    gap: 8px;
  }

  &__run-select {
    width: 420px;
    max-width: 100%;
  }

  &__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__insert {
    display: flex;
    gap: 8px;
  }

  &__type-select {
    width: 260px;
  }

  &__hint {
    margin: 0 0 8px;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__fixes {
    margin-bottom: 10px;
  }

  &__fix-list {
    margin: 0;
    padding-left: 18px;
    font-size: 0.75rem;
  }

  &__type {
    margin-right: 8px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__id {
    margin-right: 8px;
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__slots {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }
}
</style>
