<script setup lang="ts">
/**
 * 「工具链」（Vue 版）。
 *
 * 这一页对应设计里最关键的一句话——**扩充工具链只需改注册表，不需重训模型**。
 * 所以把注册表的实际内容（每个工具的环境、角色、输入输出端口）摊开，
 * 让人看到"模型能选的东西就是这个列表"。
 */
import { computed, onMounted, ref } from 'vue';
import { NAlert, NCard, NEmpty, NSpin, NTag } from 'naive-ui';
import { api, ApiError } from '@/api/client';
import { ENV_LABELS, ENV_TYPES, type EnvType, type ToolSpecDto } from '@/api/types';
import { ROLE_LABEL } from '@/utils/format';

defineOptions({ name: 'Tools' });

/**
 * 每类环境的"两条路线"说明——这是刻意的设计。
 *
 * 有两条路线，`choice` 才有真实的选择可做；而且生成层不可用时，
 * 确定性路线就是降级方案。
 */
const ROUTE_NOTE: Readonly<Record<EnvType, { generative: string; deterministic: string }>> = {
  copy: {
    generative: 'draft-copy（调生成模型写）',
    deterministic: 'template-copy（拼 Markdown）'
  },
  image: {
    generative: 'render-image（调生成模型画）',
    deterministic: 'solid-image（Pillow 画纯色图）'
  },
  frontend: {
    generative: 'scaffold-frontend（调生成模型写 HTML）',
    deterministic: 'static-page-from-template（内置模板）'
  },
  // 结构化链路的两条路线**不在"工具"这一层**，而在每个 slot 上：
  // 结构永远由决策模型逐块决定，只有 slot 内容选择生成式还是确定性。
  webpage: {
    generative: 'fill-block（文案走生成层，逐 slot 调用）',
    deterministic: 'fill-block（全部确定性填充，零成本）'
  }
};

const ROLE_TAG: Record<string, 'success' | 'info' | 'warning' | 'default'> = {
  generate: 'warning',
  transform: 'info',
  verify: 'success',
  execute: 'default'
};

const tools = ref<ToolSpecDto[] | null>(null);
const error = ref<string | null>(null);
const filter = ref<EnvType | 'all'>('all');

const filtered = computed(() => {
  const list = tools.value;
  if (list === null) return [];
  if (filter.value === 'all') return list;
  return list.filter(tool => tool.envTypes.includes(filter.value));
});

/** 按角色分组展示，便于一眼看出"生成式 / 确定性"两条路线。 */
const grouped = computed(() => {
  const map = new Map<string, ToolSpecDto[]>();
  for (const tool of filtered.value) {
    const list = map.get(tool.role) ?? [];
    list.push(tool);
    map.set(tool.role, list);
  }
  const order = ['generate', 'transform', 'verify', 'execute'];
  return order
    .filter(role => map.has(role))
    .map(role => ({ role, label: ROLE_LABEL[role] ?? role, tools: map.get(role) ?? [] }));
});

const filterOptions = computed(() => [
  { label: '全部环境', value: 'all' as const },
  ...ENV_TYPES.map(env => ({ label: ENV_LABELS[env].label, value: env }))
]);

onMounted(async () => {
  try {
    const { tools: list } = await api.tools();
    tools.value = list;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '加载工具链失败';
    tools.value = [];
  }
});
</script>

<template>
  <div class="tools">
    <NCard title="决策层的候选集" size="small" :bordered="false" class="tools__card">
      <template #header-extra>
        <span class="tools__count">{{ filtered.length }} 个工具</span>
      </template>
      <NAlert v-if="error" type="error" :bordered="false" class="mb-2">{{ error }}</NAlert>
      <p class="tools__hint">
        决策模型就是在这个列表里选。列在这里的每一项都对应注册表里的一个工具——
        <strong>扩充工具链只需改注册表，不需要重训模型</strong>。
      </p>
      <div class="tools__filters">
        <button
          v-for="option in filterOptions"
          :key="option.value"
          type="button"
          class="tools__filter"
          :class="{ 'tools__filter--active': filter === option.value }"
          @click="filter = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <NSpin :show="tools === null">
        <NEmpty v-if="tools !== null && filtered.length === 0" description="这个环境没有工具" size="small" />
        <div v-else class="tools__groups">
          <div v-for="group in grouped" :key="group.role" class="tools__group">
            <div class="tools__group-head">
              <NTag size="small" :type="ROLE_TAG[group.role] ?? 'default'">{{ group.label }}</NTag>
              <span class="tools__count">{{ group.tools.length }} 个</span>
            </div>
            <div class="tools__items">
              <div v-for="tool in group.tools" :key="tool.id" class="tools__item">
                <div class="tools__item-head">
                  <code class="tools__item-id">{{ tool.id }}</code>
                  <span class="tools__item-label">{{ tool.label }}</span>
                  <NTag v-if="tool.costHint === 'slow'" size="tiny" type="warning">慢</NTag>
                  <NTag v-for="env in tool.envTypes" :key="env" size="tiny">
                    {{ env }}
                  </NTag>
                </div>
                <p class="tools__item-desc">{{ tool.description }}</p>
                <div v-if="tool.inputs?.length" class="tools__io">
                  <span class="tools__io-key">输入</span>
                  <span class="tools__io-list">
                    <code v-for="input in tool.inputs" :key="input.name">{{ input.name }}:{{ input.type }}</code>
                  </span>
                </div>
                <div v-if="tool.outputs?.length" class="tools__io">
                  <span class="tools__io-key">输出</span>
                  <span class="tools__io-list">
                    <code v-for="output in tool.outputs" :key="output.name">{{ output.name }}:{{ output.type }}</code>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </NSpin>
    </NCard>

    <NCard title="每类环境的两条路线" size="small" :bordered="false" class="tools__card">
      <p class="tools__hint">
        两条路线是刻意设计——有两条，<code>choice</code> 才有真实的选择可做；
        而且生成层不可用时，确定性路线就是降级方案。
      </p>
      <table class="tools__table">
        <thead>
          <tr>
            <th>环境</th>
            <th>生成式（调模型）</th>
            <th>确定性（不调模型）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="env in ENV_TYPES" :key="env">
            <td>{{ ENV_LABELS[env].label }}</td>
            <td><code>{{ ROUTE_NOTE[env].generative }}</code></td>
            <td><code>{{ ROUTE_NOTE[env].deterministic }}</code></td>
          </tr>
        </tbody>
      </table>
    </NCard>
  </div>
</template>

<style scoped>
.tools {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tools__count {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.tools__hint {
  margin: 0 0 10px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--n-text-color-3);
}

.tools__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.tools__filter {
  border: 1px solid var(--n-border-color);
  background: transparent;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  color: var(--n-text-color-2);
}

.tools__filter--active {
  border-color: var(--n-color-target);
  color: var(--n-color-target);
  background: var(--n-action-color);
}

.tools__groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tools__group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.tools__items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 8px;
}

.tools__item {
  padding: 8px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
}

.tools__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tools__item-id {
  font-family: monospace;
  font-size: 12px;
  color: var(--n-color-target);
}

.tools__item-label {
  font-size: 12px;
  font-weight: 600;
}

.tools__item-desc {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--n-text-color-3);
}

.tools__io {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  font-size: 10px;
}

.tools__io-key {
  width: 28px;
  color: var(--n-text-color-3);
}

.tools__io-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tools__io-list code {
  font-family: monospace;
  color: var(--n-text-color-2);
}

.tools__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.tools__table th {
  text-align: left;
  padding: 4px 6px;
  font-weight: 600;
  color: var(--n-text-color-3);
  border-bottom: 1px solid var(--n-border-color);
}

.tools__table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--n-border-color);
  color: var(--n-text-color-2);
}

.tools__table code {
  font-family: monospace;
  color: var(--n-color-target);
}
</style>
