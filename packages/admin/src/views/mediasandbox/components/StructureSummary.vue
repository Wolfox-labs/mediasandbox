<template>
  <el-card shadow="never" class="structure-summary">
    <template #header>
      <div class="structure-summary__header">
        <span class="structure-summary__title">页面结构</span>
        <div v-if="structure" class="structure-summary__meta">
          <el-tag size="small" type="info">{{ structure.page.blocks.length }} 块</el-tag>
          <el-tag v-if="structure.page.templateId" size="small" type="warning">
            模板 {{ structure.page.templateId }}
          </el-tag>
          <el-tag v-if="qualityScoreText" size="small">{{ qualityScoreText }}</el-tag>
        </div>
      </div>
    </template>

    <el-empty v-if="!structure" description="这次运行没有结构化留痕（只有 webpage 链路会产出结构）" />

    <template v-else>
      <ol class="structure-summary__blocks">
        <li v-for="(block, index) in structure.page.blocks" :key="block.id" class="structure-summary__block">
          <span class="structure-summary__index">{{ index + 1 }}</span>
          <div class="structure-summary__body">
            <div class="structure-summary__line">
              <span class="structure-summary__type">{{ labelOf(block.type) }}</span>
              <span class="structure-summary__id">{{ block.id }}</span>
              <el-tag size="small" :type="statusType(block.status)">{{ block.status }}</el-tag>
              <el-tag v-if="placementOf(block.type)" size="small" type="warning">
                {{ placementOf(block.type) === "first" ? "固定开头" : "固定末尾" }}
              </el-tag>
            </div>
            <p v-if="block.slotNames.length > 0" class="structure-summary__slots">
              slots：{{ block.slotNames.join("、") }}
            </p>
          </div>
        </li>
      </ol>

      <el-collapse v-if="structure.steps.length > 0" class="structure-summary__steps">
        <el-collapse-item :title="`逐轮决策留痕（${structure.steps.length} 轮）`" name="steps">
          <div v-for="step in structure.steps" :key="step.round" class="structure-summary__step">
            <div class="structure-summary__line">
              <span class="structure-summary__round">第 {{ step.round }} 轮</span>
              <el-tag size="small" type="info">{{ kindLabel(step.kind) }}</el-tag>
              <span v-if="step.pickedBlockId" class="structure-summary__picked">
                选中 {{ labelOf(step.pickedBlockId) }}
              </span>
              <span v-if="step.continued !== null" class="structure-summary__prob">
                继续概率 {{ step.continueProbability?.toFixed(3) ?? "-" }}
                → {{ step.continued ? "继续" : "停止" }}
              </span>
              <span v-if="step.score !== null" class="structure-summary__prob">
                结构评分 {{ step.score.toFixed(3) }}
              </span>
              <span class="structure-summary__latency">{{ step.latencyMs }} ms</span>
            </div>
            <p v-if="Object.keys(step.counts).length > 0" class="structure-summary__counts">
              项数决策：{{ countsText(step.counts) }}
            </p>
            <p v-if="step.rationale" class="structure-summary__rationale">{{ step.rationale }}</p>
          </div>
        </el-collapse-item>
      </el-collapse>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { BlockSpec, StructureView } from "@/api/mediasandbox/types";

const props = defineProps<{
  structure: StructureView | undefined;
  /** block 池：用来把类型 id 显示成中文名，并提示"固定开头/末尾"。 */
  blocks?: readonly BlockSpec[] | undefined;
}>();

const structure = computed(() => props.structure);

const qualityScoreText = computed(() => {
  const score = props.structure?.page.qualityScore;
  return score === null || score === undefined ? "" : `结构评分 ${score.toFixed(3)}`;
});

function specOf(type: string): BlockSpec | undefined {
  return props.blocks?.find(block => block.id === type);
}

function labelOf(type: string): string {
  return specOf(type)?.label ?? type;
}

/** 版式位置约束：`first` / `last` 会被规范化强制归位，界面要说清。 */
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

function kindLabel(kind: string): string {
  switch (kind) {
    case "select":
      return "选块";
    case "count_only":
      return "只问项数";
    case "quality":
      return "评分";
    default:
      return kind;
  }
}

function countsText(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([name, value]) => `${name}=${value}`)
    .join("，");
}
</script>

<style scoped lang="scss">
.structure-summary {
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
    gap: 6px;
  }

  &__blocks {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  &__block {
    display: flex;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  &__index {
    min-width: 20px;
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }

  &__body {
    flex: 1;
  }

  &__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__type {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  &__id,
  &__round {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__slots,
  &__counts,
  &__rationale {
    margin: 2px 0 0;
    font-size: 0.75rem;
    color: var(--el-text-color-secondary);
  }

  &__steps {
    margin-top: 12px;
  }

  &__step {
    padding: 6px 0;
  }

  &__picked {
    font-size: 0.75rem;
    color: var(--el-color-primary);
  }

  &__prob,
  &__latency {
    font-size: 0.75rem;
    color: var(--el-text-color-placeholder);
  }
}
</style>
