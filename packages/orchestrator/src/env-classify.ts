/**
 * 目标分类：**让决策层回答"这是什么类型的任务"**。
 *
 * ## 为什么这是一条真实缺口
 *
 * 设计稿 §3.2 的排布流程，第一问就是：
 *
 * ```
 * [choice] 目标类型 → 网页应用 / 移动应用 / 图像作品 / 视频作品 / 文案
 * ```
 *
 * 而实现里 `envType` 是**从请求体直接读的**。含义因此变了：
 * 设计说的是"用户给目标，系统自己判断该用哪套环境"，
 * 实际是"用户必须自己说清楚要哪套环境"。
 *
 * 后果很具体：不传 `envType` 时默认 `copy`，于是**一个图像需求会被静默当成文案任务处理**；
 * 而决策层从头到尾没有参与过这个判断——那恰恰是它最该干的活。
 *
 * ## 为什么放在编排入口而不是组装器里
 *
 * 组装器 `PlanAssembler` 的入参签名里 `envType` 是必填的，它的视角是
 * "环境已经确定了，我来选工具"。分类必须发生在**调用组装器之前**。
 *
 * ## 候选集来自工具注册表（同一条原则）
 *
 * 候选不是写死的四个，而是**注册表里真的有主产出工具的那些环境**。
 * 于是"扩环境 = 注册工具"，不需要改这里。
 */
import { ENV_TYPES, type EnvType } from '@mediasandbox/sandbox';
import { argmaxDeterministic, type DecisionClient } from './decision/types.js';
import type { ToolRegistry } from './tools/registry.js';

/** 分类问题 id。 */
export const ENV_QUESTION_ID = 'env_type';

/**
 * 环境的说明文案，喂给决策层。
 *
 * 要写**区别**而不是名字：`frontend` 与 `webpage` 都能做网页，
 * 只说"网页"模型没法选。差别在"一次生成整页、结构不可干预"与
 * "逐块决定结构、每块可改可重做"。
 */
export const ENV_TYPE_LABELS: Readonly<Record<EnvType, string>> = {
  frontend: '网页（整页生成）：一次生成完整 HTML，快，但结构拿不出来、改不了',
  webpage: '网页（结构化制作）：逐块决定结构再填充，慢一点，但每块可改、可重做、可沉淀',
  slides: '演示文稿：一页一个版式，多页组成一份 16:9 可放映的文稿，页序与版式可改',
  image: '图像作品：交付物是图片文件',
  copy: '文案：交付物是文字稿',
};

export interface EnvClassification {
  readonly envType: EnvType;
  /** `decision` = 决策层答的；`fallback` = 没问成，按确定性规则回落。 */
  readonly source: 'decision' | 'fallback';
  readonly rationale: string;
  /** 决策层调用次数。0 表示没问（候选唯一或没有候选）。 */
  readonly calls: number;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/**
 * 注册表里**真的有主产出工具**的环境。
 *
 * 过滤掉没有主产出的环境很关键：把一个选了就必然失败的环境放进候选，
 * 等于给模型挖坑——它会选，然后链路报"没有可用的主产出工具"。
 */
export function candidateEnvs(registry: ToolRegistry): EnvType[] {
  return ENV_TYPES.filter((env) => registry.filter({ envType: env, role: 'generate' }).length > 0);
}

/**
 * 问决策层"这是什么类型的任务"。
 *
 * ## 三种不提问的情形，都要留痕
 *
 * - **候选唯一**：问一个只有一个选项的问题没有意义（与组装器同一条约定）
 * - **候选为空**：配置有问题，回落到 `fallbackEnv` 并说明
 * - **决策层不可用 / 答不出来**：回落到 `fallbackEnv` 并说明
 *
 * 回落**不抛错**是刻意的：分类是整条链路的第一步，它失败就等于整个目标做不了。
 * 而 `copy` 这个回落目标与改动前的默认行为完全一致——**最坏情况不比从前差**。
 */
export async function classifyEnvType(args: {
  readonly goal: string;
  readonly registry: ToolRegistry;
  readonly decision: DecisionClient;
  readonly constraints?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  /** 决策层不可用时的回落目标。默认 `copy`（与既有默认一致）。 */
  readonly fallbackEnv?: EnvType | undefined;
}): Promise<EnvClassification> {
  const fallbackEnv = args.fallbackEnv ?? 'copy';
  const candidates = candidateEnvs(args.registry);

  const fallback = (rationale: string): EnvClassification => ({
    envType: fallbackEnv,
    source: 'fallback',
    rationale,
    calls: 0,
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  if (candidates.length === 0) {
    return fallback(`注册表里没有任何环境有主产出工具，回落到 ${fallbackEnv}`);
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      envType: only,
      source: 'fallback',
      rationale: `只有一个环境可用（${only}），无需决策`,
      calls: 0,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const criteria: Record<string, string> = {};
  for (const env of candidates) criteria[env] = ENV_TYPE_LABELS[env];

  let decided;
  try {
    decided = await args.decision.decide(
      {
        goal: args.goal,
        // **刻意不给 envType**：这一问要回答的就是它。填一个进去等于先给了答案。
        ...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
        facts: { 可选环境数: String(candidates.length) },
      },
      {
        [ENV_QUESTION_ID]: {
          type: 'choice',
          instructions:
            '用户给了一个创作目标。它应该用哪一套环境来做？' +
            '看交付物是什么：要网页、要图片、还是要文字稿。' +
            '如果都能做网页，看目标更像"一次做完"还是"要能逐块改"。',
          criteria,
        },
      },
      args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
    );
  } catch (error) {
    return fallback(
      `决策层不可达（${error instanceof Error ? error.message : String(error)}），回落到 ${fallbackEnv}`,
    );
  }

  const usage = decided.usage;
  const latencyMs = decided.meta.latencyMs;
  const answer = decided.answers[ENV_QUESTION_ID];
  if (answer === undefined || answer.type !== 'choice') {
    return {
      ...fallback(`决策层未返回 ${ENV_QUESTION_ID} 的答案，回落到 ${fallbackEnv}`),
      calls: 1,
      latencyMs,
      usage,
    };
  }

  const picked = answer.value;
  if (picked !== null && candidates.includes(picked as EnvType)) {
    return {
      envType: picked as EnvType,
      source: 'decision',
      rationale: `决策层判定为 ${picked}（${ENV_TYPE_LABELS[picked as EnvType]}）`,
      calls: 1,
      latencyMs,
      usage,
    };
  }

  // 弃权，或选了一个候选外的值。两条都退到"按概率取最大"，
  // 再没有就回落——**追问一次不如当场给出确定性结论**。
  const usable = Object.keys(answer.probabilities).filter((id) =>
    candidates.includes(id as EnvType),
  );
  if (usable.length > 0) {
    const best = argmaxDeterministic(usable, answer.probabilities) as EnvType;
    return {
      envType: best,
      source: 'decision',
      rationale:
        picked === null
          ? `决策层弃权，按概率回落到 ${best}`
          : `决策层选了候选外的 ${picked}，按概率回落到 ${best}`,
      calls: 1,
      latencyMs,
      usage,
    };
  }

  return {
    ...fallback(
      picked === null
        ? `决策层弃权且没有可用的概率分布，回落到 ${fallbackEnv}`
        : `决策层选了候选外的 ${picked}，且没有可用的概率分布，回落到 ${fallbackEnv}`,
    ),
    calls: 1,
    latencyMs,
    usage,
  };
}
