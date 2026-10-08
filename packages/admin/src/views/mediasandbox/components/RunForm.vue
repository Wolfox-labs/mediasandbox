<template>
  <el-card shadow="never" class="run-form">
    <template #header>
      <div class="run-form__header">
        <span class="run-form__title">新建创作</span>
        <span class="run-form__subtitle">
          结构由决策模型逐块决定；生成层只提供素材，不决定结构
        </span>
      </div>
    </template>

    <el-form label-position="top" @submit.prevent>
      <el-form-item label="目标">
        <el-input
          v-model="form.goal"
          type="textarea"
          :rows="3"
          placeholder="例如：做一个咖啡品牌的落地页，突出单品与门店故事"
        />
      </el-form-item>

      <el-form-item label="环境">
        <el-radio-group v-model="form.envChoice">
          <el-radio-button value="auto">自动判定</el-radio-button>
          <el-radio-button v-for="env in ENV_TYPES" :key="env" :value="env">
            {{ ENV_LABELS[env].label }}
          </el-radio-button>
        </el-radio-group>
        <p class="run-form__hint">{{ envHint }}</p>
      </el-form-item>

      <el-form-item label="成本闸门">
        <el-switch
          v-model="form.allowPaidGeneration"
          active-text="允许付费生成调用"
          inactive-text="关闭（默认）"
        />
        <p v-if="form.allowPaidGeneration" class="run-form__hint run-form__hint--warn">
          打开后本次运行会放行**需要逐次授权**的工具（例如真实生图），
          可能产生费用。默认关闭时这些工具会被硬性排除，连候选都不会进入计划。
        </p>
        <p v-else class="run-form__hint">
          关闭状态下，需要授权的生成工具不会进入候选；页面仍会产出——
          素材走确定性占位或本地实现。
        </p>
      </el-form-item>

      <template v-if="isStructuredLikely">
        <el-divider content-position="left">结构化网页选项</el-divider>
        <p class="run-form__hint">
          当前环境可能落到结构化网页（{{ form.envChoice === "auto" ? "取决于判定结果" : "已选" }}），
          以下选项仅在该链路生效。
        </p>

        <el-form-item label="候选 block（不选=池子全集）">
          <el-select
            v-model="form.candidateBlockIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="选取本次允许参与排布的 block"
            class="run-form__select"
          >
            <el-option-group
              v-for="group in groupOptions"
              :key="group.id"
              :label="`${group.label}（${group.blocks.length}）`"
            >
              <el-option
                v-for="block in group.blocks"
                :key="block.id"
                :label="block.label"
                :value="block.id"
              >
                <span>{{ block.label }}</span>
                <span class="run-form__option-id">{{ block.id }}</span>
              </el-option>
            </el-option-group>
          </el-select>
        </el-form-item>

        <div class="run-form__row">
          <el-form-item label="block 数上限">
            <el-input-number v-model="form.maxBlocks" :min="1" :max="20" />
          </el-form-item>
          <el-form-item label="站点名">
            <el-input v-model="form.brand" placeholder="留空则从目标中取" />
          </el-form-item>
        </div>

        <el-form-item label="文案走生成层">
          <el-switch v-model="form.useGenerative" />
          <p class="run-form__hint">
            默认**关闭**：文案走确定性填充，零生成调用、零成本。
          </p>
        </el-form-item>

        <el-form-item label="页面上标注每块来源">
          <el-switch v-model="form.annotate" />
        </el-form-item>
      </template>

      <div class="run-form__actions">
        <el-button type="primary" :loading="isSubmitting" @click="handleSubmit">
          开始创作
        </el-button>
        <el-button @click="resetForm">重置</el-button>
      </div>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { MediaSandboxAPI, ApiError, type CreateRunInput } from "@/api/mediasandbox/client";
import {
  AUTO_ENV_LABEL,
  ENV_LABELS,
  ENV_TYPES,
  type BlockGroup,
  type BlockSpec,
  type EnvChoice
} from "@/api/mediasandbox/types";

const emit = defineEmits<{ submitted: [runId: string] }>();

interface RunFormState {
  goal: string;
  envChoice: EnvChoice;
  allowPaidGeneration: boolean;
  candidateBlockIds: string[];
  maxBlocks: number;
  brand: string;
  useGenerative: boolean;
  annotate: boolean;
}

function createEmptyForm(): RunFormState {
  return {
    goal: "",
    // 默认交给决策层判定：这正是"目标分类"能力的入口。
    envChoice: "auto",
    // 成本闸门默认关。开它意味着放行付费工具，必须由人显式打开。
    allowPaidGeneration: false,
    candidateBlockIds: [],
    maxBlocks: 8,
    brand: "",
    useGenerative: false,
    annotate: false
  };
}

const form = reactive<RunFormState>(createEmptyForm());
const isSubmitting = ref(false);
const blocks = ref<BlockSpec[]>([]);
const groups = ref<{ id: BlockGroup; label: string; count: number }[]>([]);

const envHint = computed(() =>
  form.envChoice === "auto" ? AUTO_ENV_LABEL.hint : ENV_LABELS[form.envChoice].hint
);

/** `auto` 也可能落到结构化网页，所以这两种情况都要把选项露出来。 */
const isStructuredLikely = computed(
  () => form.envChoice === "webpage" || form.envChoice === "auto"
);

const groupOptions = computed(() =>
  groups.value.map(group => ({
    id: group.id,
    label: group.label,
    blocks: blocks.value.filter(block => block.group === group.id)
  }))
);

async function loadBlockPool(): Promise<void> {
  try {
    const result = await MediaSandboxAPI.blocks();
    blocks.value = result.blocks;
    groups.value = result.groups;
  } catch (error) {
    // 池子取不到不该挡住整个表单：不选候选集时后端会用全集。
    ElMessage.warning(error instanceof ApiError ? error.message : "block 池加载失败");
  }
}

function resetForm(): void {
  Object.assign(form, createEmptyForm());
}

function buildPayload(): CreateRunInput {
  const payload: CreateRunInput = {
    goal: form.goal.trim(),
    envType: form.envChoice,
    allowPaidGeneration: form.allowPaidGeneration
  };
  if (!isStructuredLikely.value) return payload;
  return {
    ...payload,
    ...(form.candidateBlockIds.length > 0
      ? { candidateBlockIds: [...form.candidateBlockIds] }
      : {}),
    maxBlocks: form.maxBlocks,
    ...(form.brand.trim() === "" ? {} : { brand: form.brand.trim() }),
    useGenerative: form.useGenerative,
    annotate: form.annotate
  };
}

async function handleSubmit(): Promise<void> {
  if (form.goal.trim() === "") {
    ElMessage.warning("请先填写目标");
    return;
  }
  isSubmitting.value = true;
  try {
    const result = await MediaSandboxAPI.createRun(buildPayload());
    ElMessage.success(`已提交：${result.runId}`);
    emit("submitted", result.runId);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "提交失败");
  } finally {
    isSubmitting.value = false;
  }
}

onMounted(loadBlockPool);
</script>

<style scoped lang="scss">
.run-form {
  &__header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__subtitle {
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__hint {
    margin: 4px 0 0;
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }

  &__hint--warn {
    color: var(--el-color-warning);
  }

  &__select {
    width: 100%;
  }

  &__option-id {
    margin-left: 8px;
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__row {
    display: flex;
    gap: 16px;
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
}
</style>
