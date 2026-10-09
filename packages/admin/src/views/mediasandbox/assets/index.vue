<template>
  <div class="ms-assets">
    <el-card shadow="never">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="模板" name="templates">
          <div class="ms-assets__bar">
            <el-select
              v-model="fromRunId"
              filterable
              clearable
              placeholder="从哪次运行的定稿结构沉淀"
              class="ms-assets__run-select"
            >
              <el-option
                v-for="run in runs"
                :key="run.id"
                :label="`${run.goal.slice(0, 28)}（${run.envType}·${run.status}）`"
                :value="run.id"
              />
            </el-select>
            <el-input v-model="templateLabel" placeholder="模板显示名（可留空）" class="ms-assets__label-input" />
            <el-button type="primary" :disabled="!fromRunId" @click="handleCreateTemplate">
              沉淀为模板
            </el-button>
            <el-button :loading="isLoading" @click="fetchTemplates">刷新</el-button>
          </div>

          <el-alert
            class="mt-3"
            type="info"
            :closable="false"
            show-icon
            title="模板是数据"
            description="两种用法：限定候选范围（allowedBlockIds）、或给一个起手结构。内置模板删不掉，沉淀的可以删。"
          />

          <el-table :data="templates" size="small" border class="mt-3">
            <el-table-column label="模板" min-width="180">
              <template #default="{ row }">
                <span class="ms-assets__type">{{ row.label }}</span>
                <span class="ms-assets__id">{{ row.id }}</span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.builtin ? 'info' : 'success'">
                  {{ row.builtin ? "内置" : "沉淀" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="起手结构" min-width="200">
              <template #default="{ row }">
                <span class="ms-assets__slots">
                  {{ row.blocks.map((b: { type: string }) => b.type).join(" → ") || "（无）" }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="限定候选" min-width="160">
              <template #default="{ row }">
                <span class="ms-assets__slots">
                  {{ row.allowedBlockIds === null ? "不限定" : row.allowedBlockIds.join("、") }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }">
                <el-button
                  link
                  type="danger"
                  :disabled="row.builtin"
                  @click="handleDeleteTemplate(row.id)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane :label="`block 组件（${blocks.length}）`" name="blocks">
          <div class="ms-assets__bar">
            <el-button type="primary" @click="openCreate">注册 block</el-button>
            <el-button :loading="isLoading" @click="fetchBlocks">刷新</el-button>
            <span class="ms-assets__note">
              分组：{{ groups.map(group => `${group.label} ${group.count}`).join(" · ") }}
            </span>
          </div>

          <el-alert
            v-if="blockNote"
            class="mt-3"
            type="success"
            :closable="true"
            show-icon
            title="刚注册的 block"
            :description="blockNote"
            @close="blockNote = ''"
          />

          <el-table :data="blocks" size="small" border class="mt-3">
            <el-table-column label="block" min-width="180">
              <template #default="{ row }">
                <span class="ms-assets__type">{{ row.label }}</span>
                <span class="ms-assets__id">{{ row.id }}</span>
              </template>
            </el-table-column>
            <el-table-column label="分组" width="120">
              <template #default="{ row }">{{ row.groupLabel }}</template>
            </el-table-column>
            <el-table-column label="约束" width="200">
              <template #default="{ row }">
                <el-tag v-if="row.canLead" size="small" type="info">可打头</el-tag>
                <el-tag v-if="!row.repeatable" size="small" type="warning">不可重复</el-tag>
                <el-tag v-if="row.placement !== 'any'" size="small" type="warning">
                  {{ row.placement === "first" ? "固定开头" : "固定末尾" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="slots" min-width="240">
              <template #default="{ row }">
                <span class="ms-assets__slots">
                  {{ row.slots.map((s: { name: string; type: string }) => `${s.name}:${s.type}`).join("、") }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="成本" width="80">
              <template #default="{ row }">{{ row.costHint }}</template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="row.builtin ? 'info' : 'success'">
                  {{ row.builtin ? "内置" : "自定义" }}
                </el-tag>
                <el-tag v-if="row.disabled" size="small" type="warning">已停用</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <!-- 内置 block 的改/删会被后端拒绝，所以按钮直接禁用：
                     让用户点了才报错，不如一开始就说明为什么点不了。 -->
                <el-button link type="primary" :disabled="row.builtin" @click="openEdit(row)">
                  编辑
                </el-button>
                <el-button
                  link
                  type="warning"
                  :disabled="row.builtin || row.disabled"
                  @click="handleDisableBlock(row)"
                >
                  停用
                </el-button>
                <el-button
                  link
                  type="danger"
                  :disabled="row.builtin"
                  @click="handlePurgeBlock(row)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <BlockForm
      v-model:visible="isBlockFormVisible"
      :editing="editingBlock"
      @created="handleBlockCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import BlockForm from "@/views/mediasandbox/components/BlockForm.vue";
import { ApiError, MediaSandboxAPI } from "@/api/mediasandbox/client";
import type { BlockGroup, BlockSpec, RunListItem, TemplateItem } from "@/api/mediasandbox/types";

defineOptions({ name: "MsAssets" });

const activeTab = ref("templates");
const templates = ref<TemplateItem[]>([]);
const blocks = ref<BlockSpec[]>([]);
const groups = ref<{ id: BlockGroup; label: string; count: number }[]>([]);
const runs = ref<RunListItem[]>([]);
const fromRunId = ref("");
const templateLabel = ref("");
const blockNote = ref("");
const isLoading = ref(false);
const isBlockFormVisible = ref(false);
/** 正在编辑的 block；为 null 时表单是"注册"模式。 */
const editingBlock = ref<BlockSpec | null>(null);

function reportError(error: unknown): void {
  ElMessage.error(error instanceof ApiError ? error.message : "操作失败");
}

async function fetchTemplates(): Promise<void> {
  isLoading.value = true;
  try {
    templates.value = (await MediaSandboxAPI.templates()).templates;
  } catch (error) {
    reportError(error);
  } finally {
    isLoading.value = false;
  }
}

async function fetchBlocks(): Promise<void> {
  isLoading.value = true;
  try {
    const result = await MediaSandboxAPI.blocks();
    blocks.value = result.blocks;
    groups.value = result.groups;
  } catch (error) {
    reportError(error);
  } finally {
    isLoading.value = false;
  }
}

async function fetchRuns(): Promise<void> {
  try {
    runs.value = (await MediaSandboxAPI.listRuns()).runs;
  } catch (error) {
    reportError(error);
  }
}

async function handleCreateTemplate(): Promise<void> {
  try {
    await MediaSandboxAPI.createTemplate({
      fromRunId: fromRunId.value,
      ...(templateLabel.value.trim() === "" ? {} : { label: templateLabel.value.trim() })
    });
    ElMessage.success("已沉淀");
    templateLabel.value = "";
    await fetchTemplates();
  } catch (error) {
    reportError(error);
  }
}

async function handleDeleteTemplate(templateId: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除模板 ${templateId}？`, "确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await MediaSandboxAPI.deleteTemplate(templateId);
    ElMessage.success("已删除");
    await fetchTemplates();
  } catch (error) {
    reportError(error);
  }
}

function handleBlockCreated(note: string): void {
  blockNote.value = note;
  void fetchBlocks();
}

/** 打开注册：必须把上一次的编辑目标清掉，否则表单会带着旧 block 预填。 */
function openCreate(): void {
  editingBlock.value = null;
  isBlockFormVisible.value = true;
}

/** 打开编辑：把这一行原样交给表单预填。 */
function openEdit(row: BlockSpec): void {
  editingBlock.value = row;
  isBlockFormVisible.value = true;
}

/**
 * 停用：不再参与新页面的候选，**历史结构照样能渲染**。
 * 所以这里只提示"不再被选中"，不说"已删除"——两件事不一样。
 */
async function handleDisableBlock(row: BlockSpec): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `停用 ${row.id}？它会退出候选池，但用过它的历史运行仍能照常渲染。`,
      "确认停用",
      { type: "warning" }
    );
  } catch {
    return;
  }
  try {
    const result = await MediaSandboxAPI.deleteBlock(row.id);
    ElMessage.success(
      result.usedByRuns > 0
        ? `已停用；${result.usedByRuns} 次历史运行用过它，那些结构仍可渲染`
        : "已停用"
    );
    await fetchBlocks();
  } catch (error) {
    reportError(error);
  }
}

/**
 * 物理删除：只对**从未被任何运行用过**的允许。
 * 后端会拒绝并说清是哪次运行用过——这里把原因照原样显示出来，不吞掉。
 */
async function handlePurgeBlock(row: BlockSpec): Promise<void> {
  try {
    await ElMessageBox.confirm(`彻底删除 ${row.id}？此操作不可撤销（未被任何运行用过的才允许）。`, "确认删除", {
      type: "error"
    });
  } catch {
    return;
  }
  try {
    await MediaSandboxAPI.deleteBlock(row.id, { purge: true });
    ElMessage.success("已删除");
    await fetchBlocks();
  } catch (error) {
    reportError(error);
  }
}

onMounted(async () => {
  await Promise.all([fetchTemplates(), fetchBlocks(), fetchRuns()]);
});
</script>

<style scoped lang="scss">
.ms-assets {
  &__bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__run-select {
    width: 320px;
  }

  &__label-input {
    width: 200px;
  }

  &__note {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__type {
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

  &__slots {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }
}
</style>
