<script setup lang="ts">
/**
 * 沙盒环境（Vue 版）。
 *
 * 这一页回答"隔离到底做了什么"——安全性与资源约束平时藏在代码里看不见，
 * 竞赛评审会关心这些。所以把三类环境的预设、Docker 施加的 8 项约束、
 * 以及当前运行概况摊开。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NCard, NGi, NGrid, NSpin, NStatistic, NTag } from 'naive-ui';
import { api, ApiError } from '@/api/client';
import { ENV_LABELS, ENV_TYPES, type HealthResponse, type RunListItem } from '@/api/types';
import { formatBytes, formatTime, STATUS_STYLE } from '@/utils/format';

defineOptions({ name: 'Sandbox' });

/** 环境预设，与 `packages/sandbox/src/env-presets.ts` 对齐。 */
const ENV_PRESET_VIEW: Readonly<
  Record<string, { dirs: readonly string[]; commands: readonly string[]; image: string; size: string }>
> = {
  frontend: {
    dirs: ['src/', 'artifacts/', 'logs/'],
    commands: ['node', 'npm'],
    image: 'mediasandbox/frontend',
    size: '168 MB'
  },
  image: {
    dirs: ['in/', 'out/', 'artifacts/', 'logs/'],
    commands: ['python'],
    image: 'mediasandbox/image',
    size: '664 MB'
  },
  copy: {
    dirs: ['drafts/', 'artifacts/', 'logs/'],
    commands: ['node'],
    image: 'mediasandbox/copy',
    size: '168 MB'
  }
};

/**
 * Docker provider 施加的隔离约束，与 `docker-sandbox.ts` 对齐。
 *
 * 每条都写"为什么"，因为只说"我们设了 no-new-privileges"对读者没有意义——
 * 要让人明白它挡住的是哪一类问题。
 */
const DOCKER_CONSTRAINTS: readonly { label: string; value: string; why: string }[] = [
  { label: '网络', value: 'network = none', why: '容器没有网卡，产物无法外联' },
  { label: '根文件系统', value: 'readonly', why: '只有 /workspace 与 /tmp 可写' },
  { label: '运行用户', value: 'uid 1000（非 root）', why: '降权运行不可信代码' },
  { label: '能力', value: 'CapDrop: ALL', why: '剥离全部 Linux capabilities' },
  { label: '提权', value: 'no-new-privileges', why: '禁止 setuid 提权' },
  { label: '内存', value: '512 MB', why: '超限被内核 OOM kill' },
  { label: 'CPU', value: '1 核', why: 'NanoCpus 配额' },
  { label: '进程数', value: '256', why: 'PidsLimit 防 fork 炸弹' }
];

const health = ref<HealthResponse | null>(null);
const runs = ref<RunListItem[] | null>(null);
const loadError = ref<string | null>(null);

const runningCount = computed(
  () => runs.value?.filter(r => r.status === 'running' || r.status === 'queued').length ?? 0
);
const succeeded = computed(
  () => runs.value?.filter(r => r.status === 'succeeded').length ?? 0
);
const artifactsTotal = computed(
  () => runs.value?.reduce((sum, r) => sum + r.artifactCount, 0) ?? 0
);
const recent = computed(() => (runs.value ?? []).slice(0, 8));

async function load(): Promise<void> {
  try {
    const result = await api.listRuns();
    runs.value = result.runs;
    loadError.value = null;
  } catch (error) {
    runs.value = [];
    loadError.value = error instanceof ApiError ? error.message : '加载运行数据失败';
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  try {
    health.value = await api.health();
  } catch {
    // 健康检查失败不阻塞页面：下面会照实显示"能力未知"。
  }
  await load();
  timer = setInterval(load, 5000);
});
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <div class="sandbox">
    <NGrid :cols="24" :x-gap="12" :y-gap="12" item-responsive responsive="screen">
      <!-- 运行概况 -->
      <NGi span="24">
        <NCard title="运行概况" size="small" :bordered="false">
          <template #header-extra>
            <NTag size="tiny" :type="health?.ok ? 'success' : 'error'">
              {{ health?.ok ? '服务正常' : '服务不可达' }}
            </NTag>
          </template>
          <NAlert v-if="loadError" type="error" :bordered="false" class="mb-2">
            {{ loadError }}
          </NAlert>
          <div class="sandbox__stats">
            <NStatistic label="运行总数" :value="runs === null ? 0 : runs.length">
              <template v-if="runs === null" #default><NSpin size="small" /></template>
            </NStatistic>
            <NStatistic
              label="在途"
              :value="runningCount"
              :value-style="runningCount > 0 ? { color: '#2080f0' } : undefined"
            />
            <NStatistic label="成功" :value="succeeded" />
            <NStatistic label="产物总数" :value="artifactsTotal" />
          </div>
        </NCard>
      </NGi>

      <!-- provider 对比 -->
      <NGi span="24 m:12">
        <NCard title="沙盒 provider" size="small" :bordered="false" class="sandbox__card">
          <div class="sandbox__providers">
            <div class="sandbox__provider">
              <div class="sandbox__provider-name">
                local
                <NTag v-if="health?.defaultProvider === 'local'" size="tiny" type="success">
                  当前默认
                </NTag>
              </div>
              <p class="sandbox__provider-desc">
                路径级隔离：每个运行一个工作目录，靠 Node 的路径校验挡住越界读写。
                轻量、启动快，但只防"误操作"，不防"恶意代码"。
              </p>
            </div>
            <div class="sandbox__provider">
              <div class="sandbox__provider-name">
                docker
                <NTag v-if="health?.defaultProvider === 'docker'" size="tiny" type="success">
                  当前默认
                </NTag>
              </div>
              <p class="sandbox__provider-desc">
                容器级隔离：独立内核命名空间 + 只读根 + 无网络 + 资源配额。
                本机已构建四套镜像时才有真截图与真点击能力。
              </p>
            </div>
          </div>
          <div class="sandbox__capability">
            <div>
              截图：
              <NTag size="tiny" :type="health?.browser?.screenshot === 'chromium' ? 'success' : 'warning'">
                {{ health?.browser?.screenshot === 'chromium' ? '真 chromium' : '占位驱动' }}
              </NTag>
            </div>
            <div>
              交互验证：
              <NTag
                size="tiny"
                :type="health?.browser?.interaction === 'chromium' ? 'success' : 'warning'"
              >
                {{
                  health?.browser?.interaction === 'chromium' ? '真点击' : '不可用（接口回 503）'
                }}
              </NTag>
            </div>
          </div>
        </NCard>
      </NGi>

      <!-- 环境预设 -->
      <NGi span="24 m:12">
        <NCard title="环境预设" size="small" :bordered="false" class="sandbox__card">
          <div class="sandbox__presets">
            <div v-for="env in ENV_TYPES.filter(e => e !== 'webpage')" :key="env" class="sandbox__preset">
              <div class="sandbox__preset-head">
                <span class="sandbox__preset-name">{{ ENV_LABELS[env].label }}</span>
                <NTag size="tiny">{{ ENV_PRESET_VIEW[env]?.size }}</NTag>
              </div>
              <div class="sandbox__preset-row">
                <span class="sandbox__preset-key">镜像</span>
                <code>{{ ENV_PRESET_VIEW[env]?.image }}</code>
              </div>
              <div class="sandbox__preset-row">
                <span class="sandbox__preset-key">目录</span>
                <code>{{ ENV_PRESET_VIEW[env]?.dirs.join(' ') }}</code>
              </div>
              <div class="sandbox__preset-row">
                <span class="sandbox__preset-key">命令</span>
                <code>{{ ENV_PRESET_VIEW[env]?.commands.join(', ') }}</code>
              </div>
            </div>
          </div>
        </NCard>
      </NGi>

      <!-- 隔离约束 -->
      <NGi span="24 m:12">
        <NCard title="容器隔离的 8 项约束" size="small" :bordered="false" class="sandbox__card">
          <p class="sandbox__hint">
            这些不是宣传语，是 <code>docker-sandbox.ts</code> 里实际传给 Docker 的参数。
          </p>
          <table class="sandbox__table">
            <thead>
              <tr>
                <th>项</th>
                <th>取值</th>
                <th>为什么</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in DOCKER_CONSTRAINTS" :key="item.label">
                <td>{{ item.label }}</td>
                <td><code>{{ item.value }}</code></td>
                <td>{{ item.why }}</td>
              </tr>
            </tbody>
          </table>
        </NCard>
      </NGi>

      <!-- 最近运行 -->
      <NGi span="24 m:12">
        <NCard title="最近运行" size="small" :bordered="false" class="sandbox__card">
          <NSpin :show="runs === null">
            <div v-if="recent.length === 0" class="sandbox__empty">还没有运行记录</div>
            <table v-else class="sandbox__table">
              <thead>
                <tr>
                  <th>运行</th>
                  <th>环境</th>
                  <th>状态</th>
                  <th>产物</th>
                  <th>开始</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="run in recent" :key="run.id">
                  <td class="font-mono">{{ run.id.slice(-6) }}</td>
                  <td>{{ run.envType }}</td>
                  <td>
                    <NTag size="tiny" :type="STATUS_STYLE[run.status].type">
                      {{ STATUS_STYLE[run.status].label }}
                    </NTag>
                  </td>
                  <td>{{ run.artifactCount }}</td>
                  <td>{{ formatTime(run.startedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </NSpin>
        </NCard>
      </NGi>
    </NGrid>
  </div>
</template>

<style scoped>
.sandbox {
  height: 100%;
  overflow-y: auto;
}

.sandbox__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.sandbox__card {
  height: 100%;
}

.sandbox__providers {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sandbox__provider {
  padding: 8px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
}

.sandbox__provider-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: monospace;
  font-size: 12px;
  font-weight: 600;
}

.sandbox__provider-desc {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--n-text-color-3);
}

.sandbox__capability {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-size: 12px;
}

.sandbox__presets {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sandbox__preset {
  padding: 8px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
}

.sandbox__preset-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.sandbox__preset-name {
  font-size: 12px;
  font-weight: 600;
}

.sandbox__preset-row {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.8;
}

.sandbox__preset-key {
  width: 32px;
  color: var(--n-text-color-3);
}

.sandbox__preset-row code {
  font-family: monospace;
  color: var(--n-text-color-2);
}

.sandbox__hint {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.sandbox__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.sandbox__table th {
  text-align: left;
  padding: 4px 6px;
  font-weight: 600;
  color: var(--n-text-color-3);
  border-bottom: 1px solid var(--n-border-color);
}

.sandbox__table td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--n-border-color);
  color: var(--n-text-color-2);
}

.sandbox__table code {
  font-family: monospace;
  color: var(--n-color-target);
}

.sandbox__empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--n-text-color-3);
}
</style>
