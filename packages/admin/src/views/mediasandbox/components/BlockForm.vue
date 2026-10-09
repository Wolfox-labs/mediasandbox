<template>
  <el-dialog
    :model-value="visible"
    :title="isEditing ? `编辑 block：${editingId}` : '注册一个 block'"
    width="720px"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-alert
      class="mb-3"
      type="info"
      :closable="false"
      show-icon
      title="提议 ≠ 决定"
      :description="
        isEditing
          ? '改完立刻生效、重启后仍在。id 不能改：结构里存的是旧 id，换 id 会让已有运行引用不到它。'
          : '入池后仍要由决策模型选中才会被用到。校验与内置 block 完全一致：类型、slot 形态、能否打头、能否重复。'
      "
    />

    <el-form label-position="top">
      <div class="block-form__row">
        <el-form-item label="id（进 HTML 属性与文件名，字符集受限）">
          <!-- 编辑时锁住 id：它是历史结构引用这个 block 的唯一凭据。 -->
          <el-input v-model="form.id" :disabled="isEditing" placeholder="例如 pricing-table" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="form.label" placeholder="例如 价格表" />
        </el-form-item>
      </div>

      <el-form-item label="说明">
        <el-input v-model="form.description" type="textarea" :rows="2" />
      </el-form-item>

      <div class="block-form__row">
        <el-form-item label="分组">
          <el-select v-model="form.group">
            <el-option label="骨架（skeleton）" value="skeleton" />
            <el-option label="内容（content）" value="content" />
            <el-option label="交互（interactive）" value="interactive" />
          </el-select>
        </el-form-item>
        <el-form-item label="成本提示">
          <el-select v-model="form.costHint">
            <el-option label="快（fast）" value="fast" />
            <el-option label="中（medium）" value="medium" />
            <el-option label="慢（slow）" value="slow" />
          </el-select>
        </el-form-item>
        <el-form-item label="版式位置">
          <el-select v-model="form.placement">
            <el-option label="不限（any）" value="any" />
            <el-option label="固定开头（first）" value="first" />
            <el-option label="固定末尾（last）" value="last" />
          </el-select>
        </el-form-item>
      </div>

      <div class="block-form__row">
        <el-form-item label="可以打头（canLead）">
          <el-switch v-model="form.canLead" />
        </el-form-item>
        <el-form-item label="允许重复（repeatable）">
          <el-switch v-model="form.repeatable" />
        </el-form-item>
      </div>

      <el-divider content-position="left">slot 声明</el-divider>
      <p class="block-form__hint">
        渲染器按这里的类型推版式：title 出小标题、text 出段落、code 出代码块、
        link 出链接、image 出图、list-* 出列表与图集。
      </p>

      <div v-for="(slot, index) in form.slots" :key="index" class="block-form__slot">
        <el-input v-model="slot.name" placeholder="slot 名" class="block-form__slot-name" />
        <el-select v-model="slot.type" class="block-form__slot-type">
          <el-option v-for="type in SLOT_TYPES" :key="type" :label="type" :value="type" />
        </el-select>
        <el-input v-model="slot.description" placeholder="说明" />
        <el-checkbox v-model="slot.required">必需</el-checkbox>
        <el-button link type="danger" @click="removeSlot(index)">删除</el-button>
      </div>
      <el-button link type="primary" @click="addSlot">+ 添加 slot</el-button>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="isSubmitting" @click="handleSubmit">
        {{ isEditing ? "保存" : "注册" }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ApiError, MediaSandboxAPI } from "@/api/mediasandbox/client";
import type { BlockGroup, BlockPlacement, BlockSpec, SlotType } from "@/api/mediasandbox/types";

const props = defineProps<{
  visible: boolean;
  /** 给了就是编辑模式（保存到 `PUT /api/blocks/:id`）。 */
  editing?: BlockSpec | null;
}>();
const emit = defineEmits<{
  "update:visible": [visible: boolean];
  created: [note: string];
}>();
const isEditing = computed(() => props.editing != null);
const editingId = computed(() => props.editing?.id ?? "");

const SLOT_TYPES: readonly SlotType[] = [
  "title",
  "text",
  "code",
  "link",
  "image",
  "literal",
  "list-text",
  "list-image"
];

interface SlotDraft {
  name: string;
  type: SlotType;
  description: string;
  required: boolean;
}

interface BlockDraft {
  id: string;
  label: string;
  description: string;
  group: BlockGroup;
  costHint: "fast" | "medium" | "slow";
  placement: BlockPlacement;
  canLead: boolean;
  repeatable: boolean;
  slots: SlotDraft[];
}

function createEmptyDraft(): BlockDraft {
  return {
    id: "",
    label: "",
    description: "",
    group: "content",
    costHint: "fast",
    // 默认不限位置：`first`/`last` 会被规范化强制归位，非必要不要设。
    placement: "any",
    canLead: false,
    repeatable: true,
    slots: [{ name: "title", type: "title", description: "小标题", required: true }]
  };
}

const form = reactive<BlockDraft>(createEmptyDraft());
const isSubmitting = ref(false);

/** 把池子里的 spec 转成表单草稿。编辑时用它预填，而不是让用户重敲一遍。 */
function draftFromSpec(spec: BlockSpec): BlockDraft {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: spec.group,
    costHint: spec.costHint,
    placement: spec.placement,
    canLead: spec.canLead,
    repeatable: spec.repeatable,
    slots: spec.slots.map(slot => ({
      name: slot.name,
      type: slot.type,
      description: slot.description,
      required: slot.required
    }))
  };
}

watch(
  () => props.visible,
  visible => {
    if (!visible) return;
    Object.assign(
      form,
      props.editing != null ? draftFromSpec(props.editing) : createEmptyDraft()
    );
  }
);

function addSlot(): void {
  form.slots.push({ name: "", type: "text", description: "", required: true });
}

function removeSlot(index: number): void {
  form.slots.splice(index, 1);
}

async function handleSubmit(): Promise<void> {
  if (form.id.trim() === "" || form.label.trim() === "" || form.description.trim() === "") {
    ElMessage.warning("id、显示名、说明都要填");
    return;
  }
  if (form.slots.length === 0 || form.slots.some(slot => slot.name.trim() === "")) {
    ElMessage.warning("至少一个 slot，且 slot 名不能为空");
    return;
  }
  isSubmitting.value = true;
  try {
    const payload = {
      id: form.id.trim(),
      label: form.label.trim(),
      description: form.description.trim(),
      group: form.group,
      canLead: form.canLead,
      repeatable: form.repeatable,
      costHint: form.costHint,
      ...(form.placement === "any" ? {} : { placement: form.placement }),
      slots: form.slots.map(slot => ({
        name: slot.name.trim(),
        type: slot.type,
        description: slot.description.trim() === "" ? slot.name.trim() : slot.description.trim(),
        required: slot.required
      }))
    };
    const result =
      props.editing != null
        ? await MediaSandboxAPI.updateBlock(props.editing.id, payload)
        : await MediaSandboxAPI.createBlock(payload);
    ElMessage.success(isEditing.value ? `已更新：${result.block.id}` : `已入池：${result.block.id}`);
    emit("created", result.note);
    emit("update:visible", false);
  } catch (error) {
    ElMessage.error(
      error instanceof ApiError ? error.message : isEditing.value ? "保存失败" : "注册失败"
    );
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<style scoped lang="scss">
.block-form {
  &__row {
    display: flex;
    gap: 16px;
  }

  &__hint {
    margin: 0 0 8px;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__slot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__slot-name {
    width: 160px;
  }

  &__slot-type {
    width: 140px;
  }
}
</style>
