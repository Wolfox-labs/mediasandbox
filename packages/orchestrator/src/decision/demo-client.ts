/**
 * 演示用决策层：**按目标文本做关键词判断**，让演示链路自洽。
 *
 * ## 为什么需要它
 *
 * `StubDecisionClient` 的默认答案是"候选集里按 id 排序的第一个"，与目标无关。
 * 于是一个"做一个网页"的目标在 `frontend` 环境下会选中 `draft-copy`（因为
 * `draft-copy` 字母序在前），最后产出一个 Markdown 文件——**技术上没错，
 * 但演示时说不通**。
 *
 * ## 它是什么，不是什么
 *
 * - 它是**演示替身**，不是决策模型。用关键词匹配冒充"理解目标"，只为了让
 *   演示链路看起来合理。
 * - 它**不改变** `StubDecisionClient` 的语义——后者仍是"固定回答"，契约测试
 *   与单元测试继续用它。这一层只在 `main.ts` 里按环境变量启用。
 * - 真实 `RizzoFlowClient` 接上后，本文件完全不参与。
 *
 * 关键词表刻意保持小且透明：要能一眼看出"它凭什么这么选"，而不是伪装成智能。
 */
import type {
  Answer,
  ChoiceAnswer,
  DecisionBatchResult,
  DecisionClient,
  DecisionContext,
  Question,
} from './types.js';
import { DecisionError } from './types.js';

/** 问题 id，与 assembler 的 `Q` 常量对齐。 */
const Q = {
  primaryTool: 'primary_tool',
  needsVerify: 'needs_verify',
  needsRefine: 'needs_refine',
  finalize: 'finalize',
} as const;

/** 关键词 → 工具 id 的映射表。按顺序匹配，先命中者胜。 */
interface Rule {
  readonly keywords: readonly string[];
  readonly toolId: string;
}

/** 图像类目标的关键词。 */
const IMAGE_RULES: readonly Rule[] = [
  { keywords: ['纯色', '占位', '色块'], toolId: 'solid-image' },
  { keywords: ['图', '海报', '封面', '插画', '照片', '视觉', 'banner'], toolId: 'render-image' },
];

/** 网页类目标的关键词。 */
const FRONTEND_RULES: readonly Rule[] = [
  {
    keywords: ['模板', '简单页面', '静态页'],
    toolId: 'static-page-from-template',
  },
  {
    keywords: ['网页', '页面', '落地页', '网站', '前端', 'html', '站点', '展示页'],
    toolId: 'scaffold-frontend',
  },
];

function matches(goal: string, keywords: readonly string[]): boolean {
  const lower = goal.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** 按规则表挑工具；没有命中就返回 undefined，交给调用方回落。 */
function pickByRules(goal: string, rules: readonly Rule[]): string | undefined {
  for (const rule of rules) {
    if (matches(goal, rule.keywords)) return rule.toolId;
  }
  return undefined;
}

export interface DemoDecisionOptions {
  /** 决策耗时下限（毫秒）。给一点延迟让界面上的"决策中"可见。 */
  readonly latencyMs?: number | undefined;
}

export class DemoDecisionClient implements DecisionClient {
  readonly kind = 'stub' as const;
  private readonly latencyMs: number;

  constructor(options: DemoDecisionOptions = {}) {
    this.latencyMs = options.latencyMs ?? 120;
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    return { ok: true, detail: '演示决策层（关键词判断，非真实模型）' };
  }

  async decide(
    context: DecisionContext,
    questions: Readonly<Record<string, Question>>,
    _options: { readonly timeoutMs?: number } = {},
  ): Promise<DecisionBatchResult> {
    const startedAt = Date.now();
    if (Object.keys(questions).length === 0) {
      throw new DecisionError('至少需要一个决策问题', 'BAD_REQUEST');
    }

    const goal = context.goal;
    const answers: Record<string, Answer> = {};

    /** 已经选定的主产出工具，供后续问题参考。 */
    let primary: string | undefined;

    for (const [id, question] of Object.entries(questions)) {
      answers[id] = this.answerFor(id, question, goal, context, () => primary, (v) => {
        primary = v;
      });
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    return {
      answers,
      meta: { latencyMs: Date.now() - startedAt, source: 'stub' },
      usage: { inputTokens: 0, outputTokens: 0 },
      raw: { demo: true },
    };
  }

  private answerFor(
    id: string,
    question: Question,
    goal: string,
    context: DecisionContext,
    getPrimary: () => string | undefined,
    setPrimary: (value: string) => void,
  ): Answer {
    // ── 主产出工具：这是唯一需要"理解目标"的问题 ──────────────────
    if (id === Q.primaryTool && question.type === 'choice') {
      const available = Object.keys(question.criteria);
      const chosen = this.choosePrimary(context, goal, available);
      setPrimary(chosen);
      return this.choiceAnswer(chosen, available);
    }

    // ── 要不要打磨：只有文案类产出才值得打磨 ──────────────────────
    if (id === Q.needsRefine && question.type === 'noul') {
      const primary = getPrimary();
      // 只有主产出是文案时才有东西可打磨；html/图像类没有文案端口，
      // 答"是"会被组装器跳过（组装器已能识别并记录依据，但演示时不该出现这种噪音）。
      const wants = primary === 'draft-copy' || primary === 'template-copy';
      return { type: 'noul', value: wants, yesProbability: wants ? 0.86 : 0.1 };
    }

    // ── 要不要校验：总是要，让"校验产物"这一步在演示里可见 ────────
    if (id === Q.needsVerify && question.type === 'noul') {
      return { type: 'noul', value: true, yesProbability: 0.9 };
    }

    // ── 收尾方式：优先能"构建"的那个，否则落盘 ────────────────────
    if (id === Q.finalize && question.type === 'choice') {
      const available = Object.keys(question.criteria);
      const preferred = available.includes('build-frontend') ? 'build-frontend' : available[0];
      if (preferred === undefined) {
        throw new DecisionError('收尾候选集为空', 'BAD_REQUEST');
      }
      return this.choiceAnswer(preferred, available);
    }

    // ── 其余问题走确定性默认 ──────────────────────────────────────
    return this.fallback(question);
  }

  /** 按环境与目标关键词挑主产出；候选集里没有就退到第一个可用项。 */
  private choosePrimary(context: DecisionContext, goal: string, available: readonly string[]): string {
    const pick = (candidate: string | undefined): string | undefined =>
      candidate !== undefined && available.includes(candidate) ? candidate : undefined;

    // 目标里明确提到图像 → 优先图像（哪怕在 frontend 环境里做配图）。
    const imageHit = pick(pickByRules(goal, IMAGE_RULES));
    const frontendHit = pick(pickByRules(goal, FRONTEND_RULES));

    // 环境决定主基调：frontend 环境里网页关键词优先于图像关键词。
    const ordered =
      context.envType === 'frontend'
        ? [frontendHit, imageHit, pick('scaffold-frontend'), pick('static-page-from-template')]
        : context.envType === 'image'
          ? [imageHit, pick('render-image'), pick('solid-image')]
          : [pick('draft-copy'), pick('template-copy')];

    for (const candidate of ordered) {
      if (candidate !== undefined) return candidate;
    }
    const first = available[0];
    if (first === undefined) {
      throw new DecisionError('主产出候选集为空', 'BAD_REQUEST');
    }
    return first;
  }

  /** 构造带概率分布的 choice 答案。分布不重要，但要是合法概率。 */
  private choiceAnswer(value: string, available: readonly string[]): ChoiceAnswer {
    const probabilities: Record<string, number> = {};
    const others = available.filter((id) => id !== value);
    const othersShare = others.length > 0 ? 0.3 / others.length : 0;
    for (const id of available) probabilities[id] = id === value ? 0.7 : othersShare;
    return { type: 'choice', value, probabilities };
  }

  /** 其余问题的默认答案：确定性、与输入无关。 */
  private fallback(question: Question): Answer {
    switch (question.type) {
      case 'noul':
        return { type: 'noul', value: false, yesProbability: 0.1 };
      case 'choice': {
        const first = Object.keys(question.criteria)[0];
        if (first === undefined) {
          throw new DecisionError('候选集为空，无法给出默认答案', 'BAD_REQUEST');
        }
        return this.choiceAnswer(first, Object.keys(question.criteria));
      }
      case 'score':
        return { type: 'score', value: 0.5 };
      case 'numeric': {
        const range = question.range;
        return { type: 'numeric', value: range === undefined ? 0 : Math.round((range.min + range.max) / 2) };
      }
    }
  }
}
