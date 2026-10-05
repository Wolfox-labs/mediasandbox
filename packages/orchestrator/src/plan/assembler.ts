/**
 * DAG 组装器：决策答案 → 执行计划。
 *
 * **这是确定性代码，不调用生成模型。** 决策层负责在候选集里选（选哪个工具、要不要
 * 校验、几个步骤），组装器负责把选择拼成可执行的结构。分开的理由：
 *
 *   - 可复现：同样的答案永远得到同样的计划
 *   - 可测试：不用跑模型就能验组装逻辑
 *   - 可校验：计划在跑之前就能静态查出环、缺依赖、端口不匹配
 *
 * 流程：一次批量决策拿到全部答案（共享 prefill）→ 按答案挑选工具 → 连端口 → 校验。
 */
import type { EnvType } from '@mediasandbox/sandbox';
import type { DecisionClient, DecisionContext, Question } from '../decision/types.js';
import { argmaxDeterministic } from '../decision/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSpec } from '../tools/types.js';
import {
  PlanError,
  validatePlan,
  type ExecutionPlan,
  type PlanInput,
  type PlanNode,
} from './types.js';

export interface AssembleRequest {
  readonly context: DecisionContext;
  readonly envType: EnvType;
  /** 用户目标原文。作为生成类工具的入参。 */
  readonly goal: string;
  /** 可选：语气/风格等自由文本参数。 */
  readonly tone?: string | undefined;
  /** 可选：要求的最少产物数，传给校验工具。 */
  readonly minArtifacts?: number | undefined;
  /** 决策超时。 */
  readonly decisionTimeoutMs?: number | undefined;
}

export interface AssembleResult {
  readonly plan: ExecutionPlan;
  /** 决策层的原始答案，保留用于存证与排查。 */
  readonly answers: Readonly<Record<string, unknown>>;
  /** 决策耗时（毫秒），含网络往返。 */
  readonly decisionLatencyMs: number;
}

/** 决策问题 id。集中定义，避免散落的字符串。 */
const Q = {
  primaryTool: 'primary_tool',
  needsVerify: 'needs_verify',
  needsRefine: 'needs_refine',
  refineInstruction: 'refine_instruction',
  finalize: 'finalize',
} as const;

/**
 * 各环境下的"收尾工具"。主产出之后要把东西落进 artifacts/ 并校验。
 */
const FINALIZE_BY_ENV: Readonly<Record<EnvType, string>> = {
  frontend: 'build-frontend',
  image: 'process-image',
  copy: 'write-file',
};

/**
 * 该环境下**可以当主产出**的工具（角色为 generate）。
 * 收尾与校验类不参与主工具选择，否则模型可能选个"校验"当第一步，计划就废了。
 *
 * `excludeTools` 用于"换方案"：把已失败的工具排除，逼决策层改选别的。
 * 排除后若一个候选都不剩，会回落到"不排除"（宁可重试同一工具，也不能无工具可用）。
 */
function primaryCandidates(
  registry: ToolRegistry,
  envType: EnvType,
  excludeTools: readonly string[] = [],
): ToolSpec[] {
  const all = registry.filter({ envType, role: 'generate' }).filter((spec) => {
    // 图像后处理需要已有源图，不能作为第一步。
    return spec.id !== 'process-image';
  });
  if (excludeTools.length === 0) return all;
  // 换方案时排除已失败的工具，逼决策层改选别的。
  const filtered = all.filter((spec) => !excludeTools.includes(spec.id));
  // 全被排除时退回全集：有工具可用比"严格遵守排除"更重要。
  return filtered.length > 0 ? filtered : all;
}

/**
 * 收尾工具的候选集。
 *
 * 两组排除，都是真实运行里暴露出来的：
 *
 *   1. **process-image** 需要 `in/` 下已有源图。渲染出来的图不在这里，
 *      选它当收尾会引用不存在的输入。
 *
 *   2. **refine-copy** 已经有自己的 `needsRefine` 问句。把它同时列为通用收尾选项
 *      是重复建模——而且会出事：模板路线（不调模型）配上 refine-copy 收尾，
 *      生成层不可用时整条链路熔断，尽管主产出本来完全不需要模型。
 *
 * 收尾只留纯落盘/构建类工具，它们的成败不依赖生成层。
 */
function finalizeCandidates(registry: ToolRegistry, envType: EnvType): ToolSpec[] {
  const EXCLUDED = new Set(['process-image', 'refine-copy']);
  return registry
    .filter({ envType })
    .filter((spec) => spec.role === 'transform' || spec.role === 'execute')
    .filter((spec) => !EXCLUDED.has(spec.id));
}

/** 生成节点 id：按序号 + 工具 id，稳定可读且便于人看。 */
function nodeId(index: number, toolId: string): string {
  return `n${index + 1}-${toolId}`;
}

export class PlanAssembler {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly decision: DecisionClient,
    /** 换方案时排除的工具 id（已试过且失败的）。 */
    private readonly options: { readonly excludeTools?: readonly string[] } = {},
  ) {}

  async assemble(request: AssembleRequest): Promise<AssembleResult> {
    const { registry, decision } = this;
    const { context, envType } = request;

    const candidates = primaryCandidates(registry, envType, this.options.excludeTools ?? []);
    if (candidates.length === 0) {
      throw new PlanError(
        `环境 ${envType} 下没有任何可作为主产出的工具（角色为 generate）`,
        'UNKNOWN_TOOL',
      );
    }
    // 候选唯一时不必问模型：问一个只有一个选项的问题没有意义，
    // 直接采用并记录依据，省一次决策往返。
    const singleCandidate = candidates.length === 1 ? candidates[0]! : null;

    // ── 一次批量决策，全部问题共享同一次 prefill ──────────────────────
    const questions: Record<string, Question> = {};

    if (singleCandidate === null) {
      questions[Q.primaryTool] = {
        type: 'choice',
        instructions:
          '针对该目标，选择最合适的**主产出**工具。只考虑能直接产出内容的那一个，' +
          '不要选校验或收尾类工具。',
        criteria: Object.fromEntries(
          candidates.map((spec) => [spec.id, `${spec.label}：${spec.description}`]),
        ),
      };
    }

    questions[Q.needsVerify] = {
      type: 'noul',
      instructions: '该目标是否需要在交付前做一次产物校验？',
    };

    const finalizeOptions = finalizeCandidates(registry, envType);
    if (finalizeOptions.length >= 2) {
      questions[Q.finalize] = {
        type: 'choice',
        instructions: '选择把主产出落盘为最终交付物的收尾方式。',
        criteria: Object.fromEntries(
          finalizeOptions.map((spec) => [spec.id, `${spec.label}：${spec.description}`]),
        ),
      };
    }

    // 只对文案类问"要不要打磨"，其他环境加这个问没意义。
    const copyCandidate = candidates.find((spec) => spec.id === 'draft-copy');
    if (copyCandidate !== undefined && registry.has('refine-copy')) {
      questions[Q.needsRefine] = {
        type: 'noul',
        instructions: '初稿写完后是否需要再打磨一轮语气与表达？',
      };
    }

    const decided = await decision.decide(
      context,
      questions,
      request.decisionTimeoutMs !== undefined ? { timeoutMs: request.decisionTimeoutMs } : {},
    );

    const rationale: string[] = [];
    const nodes: PlanNode[] = [];
    const answersOut: Record<string, unknown> = {};

    // ── 1. 主产出工具 ─────────────────────────────────────────────────
    let primarySpec: ToolSpec;
    if (singleCandidate !== null) {
      // 唯一候选，直接采用，没有可问的。
      primarySpec = singleCandidate;
      rationale.push(`主产出工具：${primarySpec.id}（该环境下唯一候选，无需决策）`);
    } else {
      const primaryAnswer = decided.answers[Q.primaryTool];
      if (primaryAnswer === undefined || primaryAnswer.type !== 'choice') {
        throw new PlanError('决策层未返回主工具选择', 'MISSING_INPUT');
      }
      answersOut[Q.primaryTool] = primaryAnswer;

      // 弃权（value 为 null）是合法输入，必须回落到确定性默认，不能当错误。
      // 概率分布可能为空（弃权时服务端常返回 {}），此时按候选集顺序取第一个——
      // 候选集已按 id 排序，因此回落结果稳定可复现。
      let primaryId: string;
      if (primaryAnswer.value !== null) {
        primaryId = primaryAnswer.value;
      } else {
        const usableIds = Object.keys(primaryAnswer.probabilities).filter((id) =>
          candidates.some((c) => c.id === id),
        );
        primaryId =
          usableIds.length > 0
            ? argmaxDeterministic(usableIds, primaryAnswer.probabilities)
            : candidates[0]!.id;
      }

      const picked = registry.has(primaryId) ? registry.getSpec(primaryId) : undefined;
      if (picked === undefined || !candidates.some((c) => c.id === picked.id)) {
        throw new PlanError(
          `决策层选了 ${primaryId}，但它不在环境 ${envType} 的主产出候选集内`,
          'ENV_MISMATCH',
        );
      }
      primarySpec = picked;
      rationale.push(
        `主产出工具：${primarySpec.id}` +
          (primaryAnswer.value === null
            ? `（决策层弃权，回落到 ${primaryId}）`
            : ''),
      );
    }

    let cursor = 0;
    const primaryNodeId = nodeId(cursor, primarySpec.id);
    nodes.push({
      id: primaryNodeId,
      toolId: primarySpec.id,
      inputs: buildPrimaryInputs(primarySpec, request),
      dependsOn: [],
      retryable: true,
      note: `产出主内容（${primarySpec.label}）`,
    });
    cursor += 1;

    // ── 2. 可选：打磨一轮 ─────────────────────────────────────────────
    const refineAnswer = decided.answers[Q.needsRefine];
    let lastTextNode = primaryNodeId;
    if (refineAnswer !== undefined && refineAnswer.type === 'noul') {
      answersOut[Q.needsRefine] = refineAnswer;
      const wantsRefine = refineAnswer.value ?? (refineAnswer.yesProbability ?? 0) >= 0.5;
      if (wantsRefine && registry.has('refine-copy')) {
        const refineSpec = registry.getSpec('refine-copy');
        const refineNodeId = nodeId(cursor, refineSpec.id);
        nodes.push({
          id: refineNodeId,
          toolId: refineSpec.id,
          inputs: {
            text: { kind: 'ref', nodeId: lastTextNode, port: 'text' },
            instruction: {
              kind: 'literal',
              value: '保持原意，让表达更凝练、更有说服力，去掉空话。',
            },
          },
          dependsOn: [lastTextNode],
          retryable: true,
          note: '打磨文案表达',
        });
        rationale.push('决策层要求打磨文案，插入 refine-copy');
        lastTextNode = refineNodeId;
        cursor += 1;
      }
    }

    // ── 3. 收尾：把主产出落进 artifacts/ ──────────────────────────────
    const finalizeAnswer = decided.answers[Q.finalize];
    if (finalizeAnswer !== undefined) answersOut[Q.finalize] = finalizeAnswer;

    const finalizeId = pickFinalize(registry, envType, finalizeAnswer);
    if (finalizeId !== null) {
      const finalizeSpec = registry.getSpec(finalizeId);
      const inputs = buildFinalizeInputs(finalizeSpec, lastTextNode, request);
      if (finalizeId !== primarySpec.id) {
        const finalizeNodeId = nodeId(cursor, finalizeSpec.id);
        nodes.push({
          id: finalizeNodeId,
          toolId: finalizeSpec.id,
          inputs,
          dependsOn: unique([lastTextNode, ...Object.values(inputs)
            .filter((i): i is Extract<PlanInput, { kind: 'ref' }> => i.kind === 'ref')
            .map((i) => i.nodeId)]),
          retryable: false,
          note: `收尾落盘（${finalizeSpec.label}）`,
        });
        rationale.push(`收尾工具：${finalizeSpec.id}`);
        cursor += 1;
      }
    }

    // ── 4. 可选：产物校验 ─────────────────────────────────────────────
    const verifyAnswer = decided.answers[Q.needsVerify];
    if (verifyAnswer !== undefined && verifyAnswer.type === 'noul') {
      answersOut[Q.needsVerify] = verifyAnswer;
      const wantsVerify = verifyAnswer.value ?? (verifyAnswer.yesProbability ?? 0) >= 0.5;
      if (wantsVerify && registry.has('verify-artifact')) {
        const verifySpec = registry.getSpec('verify-artifact');
        const lastNode = nodes[nodes.length - 1]!;
        nodes.push({
          id: nodeId(cursor, verifySpec.id),
          toolId: verifySpec.id,
          inputs: {
            minFiles: { kind: 'literal', value: Math.max(1, request.minArtifacts ?? 1) },
          },
          dependsOn: [lastNode.id],
          retryable: false,
          note: '校验产物非空',
        });
        rationale.push('决策层要求校验，追加 verify-artifact');
        cursor += 1;
      }
    }

    const plan: ExecutionPlan = {
      envType,
      nodes,
      rationale,
      createdAt: Date.now(),
    };

    // 组装完立刻静态校验：环、悬空依赖、端口引用一次查清。
    validatePlan(plan);

    return {
      plan,
      answers: answersOut,
      decisionLatencyMs: decided.meta.latencyMs,
    };
  }
}

function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 主产出工具的入参：来自用户目标，而不是上游节点。 */
function buildPrimaryInputs(
  spec: ToolSpec,
  request: AssembleRequest,
): Record<string, PlanInput> {
  const inputs: Record<string, PlanInput> = {};
  for (const port of spec.inputs) {
    switch (port.name) {
      case 'goal':
        inputs[port.name] = { kind: 'literal', value: request.goal };
        break;
      case 'tone':
        inputs[port.name] = { kind: 'literal', value: request.tone ?? '简洁、具体' };
        break;
      case 'prompt':
        inputs[port.name] = { kind: 'literal', value: request.goal };
        break;
      case 'entry':
        inputs[port.name] = { kind: 'literal', value: 'src/index.html' };
        break;
      case 'path':
        inputs[port.name] = { kind: 'literal', value: 'artifacts/draft.md' };
        break;
      case 'content':
        inputs[port.name] = { kind: 'literal', value: request.goal };
        break;
      case 'source':
        inputs[port.name] = { kind: 'literal', value: 'in/source.png' };
        break;
      default:
        if (!port.required) continue;
        throw new PlanError(
          `主工具 ${spec.id} 的必需入参 ${port.name} 无法从上下文推导，需要显式提供`,
          'MISSING_INPUT',
        );
    }
  }
  return inputs;
}

/** 挑选收尾工具。返回 null 表示不需要收尾。 */
function pickFinalize(
  registry: ToolRegistry,
  envType: EnvType,
  answer: unknown,
): string | null {
  // 决策答案本身就是从收尾候选里选的；校验它确实可用。
  // 弃权（value 为 null）时不做取最大——概率分布可能为空，直接走下面的回落。
  if (answer !== undefined && answer !== null && typeof answer === 'object') {
    const record = answer as Record<string, unknown>;
    if (record['type'] === 'choice' && typeof record['value'] === 'string') {
      const picked = record['value'];
      const spec = registry.has(picked) ? registry.getSpec(picked) : undefined;
      if (
        spec !== undefined &&
        spec.envTypes.includes(envType) &&
        (spec.role === 'transform' || spec.role === 'execute')
      ) {
        // 图像后处理需要已有源图，而主产出是"渲染"，此时源图不是 in/ 下的文件。
        // 这种情况下不插收尾，避免计划引用不存在的输入。
        if (spec.id === 'process-image') return null;
        return spec.id;
      }
    }
  }

  // 弃权或不可用：回落到该环境的确定性默认。
  const fallback = FINALIZE_BY_ENV[envType];
  if (registry.has(fallback) && fallback !== 'process-image') return fallback;
  return null;
}

/** 收尾工具的入参：把上游产出接进来。 */
function buildFinalizeInputs(
  spec: ToolSpec,
  upstreamNodeId: string,
  request: AssembleRequest,
): Record<string, PlanInput> {
  const inputs: Record<string, PlanInput> = {};
  for (const port of spec.inputs) {
    switch (port.name) {
      case 'entry':
        inputs[port.name] = { kind: 'literal', value: 'src/index.html' };
        break;
      case 'text':
      case 'content':
      case 'html':
      case 'copy':
        inputs[port.name] = { kind: 'ref', nodeId: upstreamNodeId, port: 'text' };
        break;
      case 'instruction':
        inputs[port.name] = { kind: 'literal', value: '整理为最终交付版本。' };
        break;
      case 'path':
        inputs[port.name] = { kind: 'literal', value: 'artifacts/copy.md' };
        break;
      case 'minFiles':
        inputs[port.name] = { kind: 'literal', value: Math.max(1, request.minArtifacts ?? 1) };
        break;
      case 'width':
        inputs[port.name] = { kind: 'literal', value: 1024 };
        break;
      case 'size':
        inputs[port.name] = { kind: 'literal', value: '1024x1024' };
        break;
      default:
        if (!port.required) continue;
        if (port.type === 'number') {
          inputs[port.name] = { kind: 'literal', value: 1 };
          break;
        }
        inputs[port.name] = { kind: 'literal', value: request.goal };
    }
  }
  return inputs;
}
