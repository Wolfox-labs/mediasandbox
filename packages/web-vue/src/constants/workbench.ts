/**
 * 创作工作台的四个步骤。
 *
 * 步骤是**路径参数**（`/workbench/:step?`），不是页面内部状态：
 * 每一步有独立地址，浏览器前进后退可用、刷新后停在同一步。
 *
 * `goal` 是缺省值：缺参数（`/workbench`）或传了不认识的值，
 * 一律按第 1 步处理——见 `toWorkbenchStep`。路由守卫用同一个函数做归一化，
 * 所以地址栏里永远只会出现这四个值之一。
 */
export const WORKBENCH_STEPS = ['goal', 'decision', 'interaction', 'result'] as const;

export type WorkbenchStep = (typeof WORKBENCH_STEPS)[number];

export interface WorkbenchStepMeta {
  readonly step: WorkbenchStep;
  /** 序号，从 1 开始，导航栏显示用。 */
  readonly no: number;
  readonly label: string;
  /** 这一步要做什么，页头与导航 tooltip 都用它。 */
  readonly hint: string;
}

export const WORKBENCH_STEP_LIST: readonly WorkbenchStepMeta[] = [
  {
    step: 'goal',
    no: 1,
    label: '创作目标',
    hint: '写清要做什么，选模态、页面元素与模板'
  },
  {
    step: 'decision',
    no: 2,
    label: '模型决策',
    hint: '提交后看统筹规划与逐块决策，结构可以改'
  },
  {
    step: 'interaction',
    no: 3,
    label: '模型交互测试',
    hint: '用真浏览器打开页面点一下，由代码判断点没点中'
  },
  {
    step: 'result',
    no: 4,
    label: '结果展示',
    hint: '预览页面、下载产物、看失败原因'
  }
];

const STEP_SET: ReadonlySet<string> = new Set(WORKBENCH_STEPS);

export function isWorkbenchStep(value: unknown): value is WorkbenchStep {
  return typeof value === 'string' && STEP_SET.has(value);
}

/** 缺省 / 非法值一律折算成第 1 步。 */
export function toWorkbenchStep(value: unknown): WorkbenchStep {
  return isWorkbenchStep(value) ? value : 'goal';
}

/** 取一步的元信息（序号 / 名称 / 说明）。 */
export function workbenchStepMeta(value: unknown): WorkbenchStepMeta {
  const step = toWorkbenchStep(value);
  return WORKBENCH_STEP_LIST.find(item => item.step === step) ?? WORKBENCH_STEP_LIST[0];
}

/**
 * 某一步的地址。
 *
 * **全项目只有这里拼 `/workbench/...`**：路由声明、导航、重定向共用一份，
 * 改步骤名时不用满仓库找字符串。
 */
export function workbenchStepPath(step: WorkbenchStep): string {
  return `/workbench/${step}`;
}
