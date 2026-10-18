<script setup lang="ts">
/**
 * 元素池管理。
 *
 * 为什么单开一页：池子是结构化制作的**候选集来源**。"池子里有什么、哪个块建错了
 * 要下线"属于运维动作，不该只能在一次运行的流程里顺手做——放上侧边栏，它才是
 * 一个能反复回来的地方。
 *
 * 三条与后端对齐的规矩，界面上也要说清：
 *   1. **内置块不能改也不能删**（后端 400）。按钮直接禁用，而不是让人点了才报错。
 *   2. **停用是可逆的**。停用只让它退出候选池，历史结构照常渲染；要看停用的必须
 *      带 `includeDisabled=1` —— 以前"停完就从列表里消失、无从恢复"的病根就在这。
 *   3. **物理删除只对从未被任何运行用过的块开放**，否则后端拒绝并说明是哪几次用过，
 *      那个原因要原样显示出来。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui';
import { api, ApiError, type BlockInput } from '@/api/client';
import type { BlockGroup, BlockSpecDto, SlotType } from '@/api/types';

defineOptions({ name: 'Blocks' });

const message = useMessage();

const blocks = ref<BlockSpecDto[]>([]);
const loading = ref(false);
/** 默认带上停用的：看不见它们就等于没有恢复入口。 */
const includeDisabled = ref(true);

const GROUPS: readonly { label: string; value: BlockGroup }[] = [
  { label: '页面骨架', value: 'skeleton' },
  { label: '内容块', value: 'content' },
  { label: '交互块', value: 'interactive' },
  { label: '版式（演示文稿）', value: 'deck' }
];

const SLOT_TYPES: readonly SlotType[] = [
  'title',
  'text',
  'image',
  'code',
  'link',
  'literal',
  'list-text',
  'list-image'
];

const SLOT_TYPE_OPTIONS = SLOT_TYPES.map(type => ({ label: type, value: type }));

const COST_HINTS: readonly { label: string; value: 'fast' | 'medium' | 'slow' }[] = [
  { label: '快', value: 'fast' },
  { label: '中', value: 'medium' },
  { label: '慢', value: 'slow' }
];

function isListType(type: SlotType): boolean {
  return type === 'list-text' || type === 'list-image';
}

function reportError(error: unknown): void {
  message.error(error instanceof ApiError ? error.message : '操作失败');
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.blocks(undefined, { includeDisabled: includeDisabled.value });
    blocks.value = result.blocks;
  } catch (error) {
    reportError(error);
  } finally {
    loading.value = false;
  }
}

/** 按分组归拢。顺序用固定顺序（骨架 → 内容 → 交互 → 版式），不是字母序。 */
const grouped = computed(() =>
  GROUPS.map(group => ({
    group: group.value,
    label: blocks.value.find(item => item.group === group.value)?.groupLabel ?? group.label,
    items: blocks.value.filter(item => item.group === group.value)
  })).filter(entry => entry.items.length > 0)
);

// ── 新建 / 编辑 ──────────────────────────────────────────────────────
interface SlotDraft {
  name: string;
  type: SlotType;
  required: boolean;
  description: string;
  min: number | null;
  max: number | null;
}

interface BlockDraft {
  id: string;
  label: string;
  description: string;
  group: BlockGroup;
  canLead: boolean;
  repeatable: boolean;
  costHint: 'fast' | 'medium' | 'slow';
  slots: SlotDraft[];
}

function emptyDraft(): BlockDraft {
  return {
    id: '',
    label: '',
    description: '',
    group: 'content',
    canLead: false,
    repeatable: true,
    costHint: 'fast',
    slots: [{ name: 'text', type: 'text', required: true, description: '', min: null, max: null }]
  };
}

const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const submitting = ref(false);
const formError = ref('');
const draft = reactive<BlockDraft>(emptyDraft());

function openCreate(): void {
  editingId.value = null;
  formError.value = '';
  Object.assign(draft, emptyDraft());
  dialogVisible.value = true;
}

function openEdit(spec: BlockSpecDto): void {
  editingId.value = spec.id;
  formError.value = '';
  Object.assign(draft, {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group,
    canLead: spec.canLead,
    repeatable: spec.repeatable,
    costHint: spec.costHint,
    slots: spec.slots.map(slot => ({
      name: slot.name,
      type: slot.type,
      required: slot.required,
      description: slot.description,
      min: slot.countRange?.min ?? null,
      max: slot.countRange?.max ?? null
    }))
  });
  dialogVisible.value = true;
}

function addSlot(): void {
  draft.slots.push({ name: '', type: 'text', required: false, description: '', min: null, max: null });
}

function removeSlot(index: number): void {
  if (draft.slots.length <= 1) return;
  draft.slots.splice(index, 1);
}

/** 把一份池子里的声明转成可提交的请求体（启用时要用它把原样送回去）。 */
function toInput(spec: BlockSpecDto): BlockInput {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group,
    canLead: spec.canLead,
    repeatable: spec.repeatable,
    costHint: spec.costHint,
    slots: spec.slots.map(slot => ({
      name: slot.name,
      type: slot.type,
      required: slot.required,
      description: slot.description,
      ...(slot.countRange !== undefined
        ? { countRange: { min: slot.countRange.min, max: slot.countRange.max } }
        : {})
    }))
  };
}

function buildPayload(): BlockInput | string {
  const id = draft.id.trim();
  const label = draft.label.trim();
  if (id === '') return 'id 不能为空';
  if (label === '') return '显示名不能为空';
  for (const slot of draft.slots) {
    const name = slot.name.trim();
    if (name === '') return '每个 slot 都要有名字';
    if (isListType(slot.type) && (slot.min === null || slot.max === null)) {
      return `slot ${name} 是列表型，必须给 countRange 的 min/max（后端会直接拒绝）`;
    }
  }
  return {
    id,
    label,
    description: draft.description.trim() === '' ? label : draft.description.trim(),
    group: draft.group,
    canLead: draft.canLead,
    repeatable: draft.repeatable,
    costHint: draft.costHint,
    slots: draft.slots.map(slot => ({
      name: slot.name.trim(),
      type: slot.type,
      required: slot.required,
      description: slot.description.trim() === '' ? slot.name.trim() : slot.description.trim(),
      ...(isListType(slot.type) && slot.min !== null && slot.max !== null
        ? { countRange: { min: slot.min, max: slot.max } }
        : {})
    }))
  };
}

async function submit(): Promise<void> {
  const payload = buildPayload();
  if (typeof payload === 'string') {
    formError.value = payload;
    return;
  }
  submitting.value = true;
  formError.value = '';
  try {
    if (editingId.value === null) {
      const result = await api.createBlock(payload);
      message.success(`已入池：${result.block.id}`);
    } else {
      const result = await api.updateBlock(editingId.value, payload);
      message.success(`已更新：${result.block.id}`);
    }
    dialogVisible.value = false;
    await refresh();
  } catch (error) {
    // 后端把"为什么不行"写得很具体（内置不可改、重名、slot 形态不对……），原样显示。
    formError.value = error instanceof ApiError ? error.message : '保存失败';
  } finally {
    submitting.value = false;
  }
}

// ── 停用 / 启用 / 物理删除 ───────────────────────────────────────────
async function disable(spec: BlockSpecDto): Promise<void> {
  try {
    const result = await api.deleteBlock(spec.id);
    message.success(
      result.usedByRuns > 0
        ? `已停用；${result.usedByRuns} 次历史运行用过它，那些结构仍可渲染`
        : '已停用'
    );
    await refresh();
  } catch (error) {
    reportError(error);
  }
}

/**
 * 启用 = 把这份声明原样 `PUT` 回去。
 *
 * 后端按请求体**重建**声明，因此"不含 disabled"就等价于启用。
 * 这里仍显式写 `disabled: false`，让意图留在请求里，而不是靠副作用。
 */
async function enable(spec: BlockSpecDto): Promise<void> {
  try {
    await api.updateBlock(spec.id, { ...toInput(spec), disabled: false });
    message.success(`已启用：${spec.id}`);
    await refresh();
  } catch (error) {
    reportError(error);
  }
}

async function purge(spec: BlockSpecDto): Promise<void> {
  try {
    const result = await api.deleteBlock(spec.id, { purge: true });
    message.success(result.note);
    await refresh();
  } catch (error) {
    reportError(error);
  }
}

onMounted(refresh);
</script>

<template>
  <div class="blocks">
    <NCard size="small" :bordered="false">
      <template #header>
        <div class="blocks__title">
          元素池
          <span class="blocks__hint">
            结构化制作的候选集来源。这里的增删改立刻生效并落盘，重启后仍在。
          </span>
        </div>
      </template>
      <template #header-extra>
        <NSpace :size="8" align="center">
          <span class="blocks__hint">显示已停用</span>
          <NSwitch v-model:value="includeDisabled" size="small" @update:value="refresh" />
          <NButton size="tiny" secondary :loading="loading" @click="refresh">刷新</NButton>
          <NButton size="tiny" type="primary" @click="openCreate">新建区块</NButton>
        </NSpace>
      </template>

      <NSpin :show="loading">
        <NEmpty v-if="blocks.length === 0" size="small" description="池子是空的" />
        <div v-for="entry in grouped" :key="entry.group" class="blocks__group">
          <div class="blocks__group-title">
            {{ entry.label }}
            <span class="blocks__count">{{ entry.items.length }}</span>
          </div>
          <div
            v-for="spec in entry.items"
            :key="spec.id"
            class="blocks__item"
            :class="{ 'blocks__item--off': spec.disabled === true }"
          >
            <div class="blocks__item-main">
              <div class="blocks__item-head">
                <span class="blocks__label">{{ spec.label }}</span>
                <code class="blocks__id">{{ spec.id }}</code>
                <NTag size="tiny" :type="spec.builtin === true ? 'info' : 'success'">
                  {{ spec.builtin === true ? '内置' : '自定义' }}
                </NTag>
                <NTag v-if="spec.disabled === true" size="tiny" type="warning">已停用</NTag>
                <NTag v-if="spec.costHint !== 'fast'" size="tiny" type="warning">
                  {{ spec.costHint }}
                </NTag>
                <NTag v-if="!spec.repeatable" size="tiny">仅一次</NTag>
              </div>
              <div class="blocks__desc">{{ spec.description }}</div>
              <div class="blocks__slots">
                <span v-for="slot in spec.slots" :key="slot.name" class="blocks__slot">
                  {{ slot.name }}<span class="blocks__slot-type">:{{ slot.type }}</span
                  ><span v-if="slot.required" class="blocks__req">*</span>
                </span>
              </div>
            </div>

            <NSpace :size="4" align="center">
              <NButton
                size="tiny"
                secondary
                :disabled="spec.builtin === true"
                @click="openEdit(spec)"
              >
                编辑
              </NButton>

              <NPopconfirm v-if="spec.disabled === true" @positive-click="enable(spec)">
                <template #trigger>
                  <NButton size="tiny" secondary :disabled="spec.builtin === true">启用</NButton>
                </template>
                重新加回候选池？
              </NPopconfirm>
              <NPopconfirm v-else @positive-click="disable(spec)">
                <template #trigger>
                  <NButton size="tiny" secondary :disabled="spec.builtin === true">停用</NButton>
                </template>
                停用后退出候选池；用过它的历史运行仍能照常渲染。确认停用？
              </NPopconfirm>

              <NPopconfirm @positive-click="purge(spec)">
                <template #trigger>
                  <NButton size="tiny" secondary type="error" :disabled="spec.builtin === true">
                    删除
                  </NButton>
                </template>
                彻底删除不可撤销。只允许**从未被任何运行用过**的块，否则后端会拒绝并说明。
              </NPopconfirm>
            </NSpace>
          </div>
        </div>
      </NSpin>
    </NCard>

    <NModal
      v-model:show="dialogVisible"
      preset="card"
      :title="editingId === null ? '新建区块' : `编辑区块：${editingId}`"
      style="width: min(760px, calc(100vw - 32px))"
    >
      <div class="blocks__form">
        <label class="blocks__field">
          <span class="blocks__field-label">
            id（进 HTML 属性与文件名，小写字母开头，可含数字与连字符）
          </span>
          <NInput
            v-model:value="draft.id"
            size="small"
            :disabled="editingId !== null"
            placeholder="例如 price-table"
          />
        </label>
        <p v-if="editingId !== null" class="blocks__hint">
          id 不能改：结构里存的是旧 id，换 id 会让已有运行引用不到它。
        </p>

        <label class="blocks__field">
          <span class="blocks__field-label">显示名</span>
          <NInput v-model:value="draft.label" size="small" placeholder="例如 价格表" />
        </label>
        <label class="blocks__field">
          <span class="blocks__field-label">分组</span>
          <NSelect v-model:value="draft.group" size="small" :options="GROUPS" />
        </label>
        <label class="blocks__field">
          <span class="blocks__field-label">说明（留空就用显示名）</span>
          <NInput v-model:value="draft.description" size="small" />
        </label>

        <div class="blocks__row">
          <NCheckbox v-model:checked="draft.canLead" size="small">可以打头</NCheckbox>
          <NCheckbox v-model:checked="draft.repeatable" size="small">可重复</NCheckbox>
          <span class="blocks__field-label">成本</span>
          <NSelect
            v-model:value="draft.costHint"
            size="small"
            style="width: 100px"
            :options="COST_HINTS"
          />
        </div>

        <div class="blocks__slots-head">
          <span class="blocks__field-label">
            slot 声明（决定每个位置由谁来填；列表型必须给 min/max）
          </span>
          <NButton size="tiny" secondary @click="addSlot">加一个 slot</NButton>
        </div>
        <div v-for="(slot, index) in draft.slots" :key="index" class="blocks__slot-row">
          <NInput
            v-model:value="slot.name"
            size="tiny"
            placeholder="slotName"
            style="width: 130px"
          />
          <NSelect
            v-model:value="slot.type"
            size="tiny"
            style="width: 120px"
            :options="SLOT_TYPE_OPTIONS"
          />
          <NCheckbox v-model:checked="slot.required" size="small">必填</NCheckbox>
          <NInput
            v-model:value="slot.description"
            size="tiny"
            placeholder="说明（留空就用 slot 名）"
          />
          <template v-if="isListType(slot.type)">
            <NInputNumber
              v-model:value="slot.min"
              size="tiny"
              :min="1"
              placeholder="min"
              style="width: 84px"
            />
            <NInputNumber
              v-model:value="slot.max"
              size="tiny"
              :min="1"
              placeholder="max"
              style="width: 84px"
            />
          </template>
          <NButton
            size="tiny"
            quaternary
            type="error"
            :disabled="draft.slots.length <= 1"
            @click="removeSlot(index)"
          >
            移除
          </NButton>
        </div>

        <NAlert v-if="formError" type="error" :bordered="false" class="mt-2">
          {{ formError }}
        </NAlert>

        <div class="blocks__dialog-actions">
          <NButton size="small" @click="dialogVisible = false">取消</NButton>
          <NButton size="small" type="primary" :loading="submitting" @click="submit">
            {{ editingId === null ? '创建' : '保存' }}
          </NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.blocks {
  padding: 12px;
}

.blocks__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.blocks__hint {
  font-size: 11px;
  font-weight: normal;
  color: var(--n-text-color-3);
}

.blocks__group {
  margin-bottom: 14px;
}

.blocks__group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--n-border-color);
}

.blocks__count {
  font-size: 11px;
  font-weight: normal;
  color: var(--n-text-color-3);
}

.blocks__item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--n-border-color);
}

.blocks__item--off {
  opacity: 0.55;
}

.blocks__item-main {
  min-width: 0;
}

.blocks__item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.blocks__label {
  font-size: 13px;
  font-weight: 600;
}

.blocks__id {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.blocks__desc {
  font-size: 11px;
  color: var(--n-text-color-2);
  margin-top: 2px;
}

.blocks__slots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.blocks__slot {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--n-action-color, rgba(128, 128, 128, 0.12));
}

.blocks__slot-type {
  color: var(--n-text-color-3);
}

.blocks__req {
  color: #d03050;
}

.blocks__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.blocks__field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.blocks__field-label {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.blocks__row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.blocks__slots-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}

.blocks__slot-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.blocks__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>
