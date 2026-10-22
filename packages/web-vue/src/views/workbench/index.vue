<script setup lang="ts">
/**
 * 创作工作台：外壳。
 *
 * 只做四件事：
 *   1. 从地址解析当前是哪一步（`/workbench/:step?`，步骤值由路由以 prop 传进来）
 *   2. 画进程导航：几步、当前在哪、哪步已完成、哪步还没解锁以及为什么
 *   3. 订阅运行事件流，把事件交给 store 折叠（外壳不渲染运行细节）
 *   4. 按步骤渲染对应的步骤页组件
 *
 * 内容全部在 `modules/step-*.vue`：外壳不该知道"候选块怎么选""结构怎么改"。
 */
import { computed, nextTick, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NTag, NTooltip, useThemeVars } from 'naive-ui';
import { isTerminal } from '@/api/types';
import { useRunStream } from '@/composables/use-run-stream';
import { useWorkbenchStore } from '@/store/modules/workbench';
import { useTabStore } from '@/store/modules/tab';
import { STATUS_STYLE } from '@/utils/format';
import {
  WORKBENCH_STEP_LIST,
  toWorkbenchStep,
  workbenchStepMeta,
  workbenchStepPath,
  type WorkbenchStep
} from '@/constants/workbench';
import StepGoal from './modules/step-goal.vue';
import StepDecision from './modules/step-decision.vue';
import StepInteraction from './modules/step-interaction.vue';
import StepResult from './modules/step-result.vue';
import RunProgress from './modules/run-progress.vue';

defineOptions({ name: 'Workbench' });

/** 步骤由路由以 prop 传进来（path 带 `:` 时 transform 会自动补 `props: true`）。 */
const props = defineProps<{ step?: string }>();

const router = useRouter();
const store = useWorkbenchStore();
const tabStore = useTabStore();
const themeVars = useThemeVars();

const currentStep = computed<WorkbenchStep>(() => toWorkbenchStep(props.step));
const currentMeta = computed(() => workbenchStepMeta(currentStep.value));

interface StepItem {
  readonly step: WorkbenchStep;
  readonly no: number;
  readonly label: string;
  readonly hint: string;
  readonly unlocked: boolean;
  readonly done: boolean;
  readonly active: boolean;
  /** 未解锁的原因，导航栏 tooltip 里说清楚。 */
  readonly reason: string;
}

const stepItems = computed<StepItem[]>(() => {
  const list: StepItem[] = [];
  for (const meta of WORKBENCH_STEP_LIST) {
    const active = meta.step === currentStep.value;
    if (meta.step === 'goal') {
      list.push({
        ...meta,
        unlocked: true,
        done: store.canGoNext,
        active,
        reason: ''
      });
      continue;
    }
    if (meta.step === 'decision') {
      list.push({
        ...meta,
        unlocked: store.canGoNext,
        // 完成 = 结构定稿且执行结束，不只是「提交过」。
        done: store.decisionSettled,
        active,
        reason: '先在第 1 步写好创作目标（目标、模态、页面元素都在这步定）'
      });
      continue;
    }
    if (meta.step === 'interaction') {
      list.push({
        ...meta,
        unlocked: store.decisionSettled,
        done: store.tested,
        active,
        reason: '先在第 2 步提交并等运行结束，拿到区块结构后才能点页面'
      });
      continue;
    }
    list.push({
      ...meta,
      unlocked: store.runId !== undefined,
      done: false,
      active,
      reason: '还没有可看的运行结果，先在第 2 步提交一次'
    });
  }
  return list;
});

/** 导航项上的状态字：完成 / 进行中 / 未开始 / 未解锁。 */
function stateLabel(item: StepItem): string {
  if (!item.unlocked) return '未解锁';
  if (item.active) return '进行中';
  if (item.done) return '已完成';
  return '未开始';
}

function go(step: WorkbenchStep): void {
  const target = stepItems.value.find(item => item.step === step);
  if (target === undefined || !target.unlocked) return;
  if (target.step === currentStep.value) return;
  // 用路径 push 而不是内部状态：前进后退可用、刷新后停在同一页。
  void router.push(workbenchStepPath(step));
}

/**
 * 主题色注入成 CSS 自定义属性供 `workbench.css` 取用。
 *
 * 导航栏在 NCard 外面，拿不到 Naive UI 组件级的 `--n-*` 变量。之前直接写
 * `var(--n-color-body)` 的教训是：变量不存在 -> 背景透明 -> 下方内容压着导航文字。
 */
const themeStyle = computed<Record<string, string>>(() => ({
  '--wb-primary': themeVars.value.primaryColor,
  '--wb-done': themeVars.value.primaryColor,
  '--wb-action': themeVars.value.actionColor,
  '--wb-border': themeVars.value.dividerColor,
  '--wb-text-1': themeVars.value.textColor1,
  '--wb-text-2': themeVars.value.textColor2,
  '--wb-text-3': themeVars.value.textColor3
}));

// ── 运行事件流 ──────────────────────────────────────────────────────
/** runId 变化时组合式函数会自动换订阅目标；服务端连上就补发历史，重连不丢状态。 */
const runIdRef = computed(() => store.runId);
const { events, connection } = useRunStream(runIdRef);
watch(events, list => store.applyEvents(list), { immediate: true });

const connectionLabel = computed(
  () => ({ connecting: '连接中', open: '实时通道已连接', closed: '已断开，重连中' })[connection.value]
);

// 运行进入终态：把产物与详情补齐。产物是**落定之后**才有的，晚于状态变化。
watch(
  () => store.status,
  (next, prev) => {
    if (next === prev || !isTerminal(next)) return;
    void store.loadArtifacts();
    void store.hydrate();
  }
);

// 标签栏里四个步骤分开显示（不加就成了四个同名标签）
watch(
  currentStep,
  () => {
    void nextTick(() => tabStore.setTabLabel(`${currentMeta.value.no}. ${currentMeta.value.label}`));
  },
  { immediate: true }
);

onMounted(() => {
  /*
   * 首页 tab 记的是路由声明里的原始 path（带可选参数时是 `/workbench/:step?`
   * 这个字面量），点它会跳到一个带 `:step?` 的地址，再被守卫折回来。
   * 直接把它指到第 1 步的真实地址：两者说的是同一个页面。
   */
  const home = tabStore.homeTab;
  if (home !== undefined && home.fullPath.includes(':step')) {
    home.fullPath = workbenchStepPath('goal');
    home.id = workbenchStepPath('goal');
  }

  if (store.runId !== undefined) {
    void store.hydrate();
    void store.loadArtifacts();
  }
});

/** 「重新开始」：清掉入参与运行快照，回到第 1 步。 */
function restart(): void {
  store.reset();
  tabStore.resetTabLabel();
  void router.push(workbenchStepPath('goal'));
}
</script>

<template>
  <div class="wb" :style="themeStyle">
    <!-- 进程导航（吸顶） -->
    <nav
      class="wb__nav"
      :style="{
        backgroundColor: themeVars.cardColor,
        borderBottomColor: themeVars.dividerColor
      }"
    >
      <NTooltip
        v-for="item in stepItems"
        :key="item.step"
        placement="bottom"
        :disabled="item.unlocked"
      >
        <template #trigger>
          <span class="wb__nav-slot">
            <button
              type="button"
              class="wb__nav-step"
              :class="{
                'wb__nav-step--active': item.active,
                'wb__nav-step--done': item.done && !item.active,
                'wb__nav-step--locked': !item.unlocked
              }"
              :disabled="!item.unlocked"
              :aria-current="item.active ? 'step' : undefined"
              @click="go(item.step)"
            >
              <span class="wb__nav-no">{{ item.no }}</span>
              <span class="wb__nav-label">{{ item.label }}</span>
              <span class="wb__nav-state">{{ stateLabel(item) }}</span>
            </button>
          </span>
        </template>
        {{ item.reason }}
      </NTooltip>

      <span class="wb__nav-fill" />

      <NTag v-if="store.runId" size="small" :type="STATUS_STYLE[store.status].type">
        {{ STATUS_STYLE[store.status].label }}
      </NTag>
      <NTag size="small" :type="connection === 'open' ? 'success' : 'warning'">
        {{ connectionLabel }}
      </NTag>
    </nav>

    <!-- 运行进度：进行中显示"做到哪一步、还剩多少、正在干嘛"，失败直接给原因 -->
    <RunProgress />

    <!-- 当前步骤。每步自己有独立地址，这里只负责挑一个渲染。 -->
    <StepGoal v-if="currentStep === 'goal'" @next="go('decision')" />
    <StepDecision
      v-else-if="currentStep === 'decision'"
      @next="go('interaction')"
      @back="go('goal')"
    />
    <StepInteraction
      v-else-if="currentStep === 'interaction'"
      @next="go('result')"
      @back="go('decision')"
    />
    <StepResult v-else @back="go('interaction')" @restart="restart" />
  </div>
</template>

<style src="./modules/workbench.css"></style>
