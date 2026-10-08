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
import type { PortType, ToolSpec } from '../tools/types.js';
import {
  PlanError,
  validatePlan,
  type ExecutionPlan,
  type PlanInput,
  type PlanNode,
} from './types.js';
import { assembleStructured } from '../structured/assembler.js';
import type { BlockRegistry } from '../structured/block-spec.js';
import type { PageSpec } from '../structured/page-spec.js';
import type { StructureStep } from '../structured/planner.js';
import type { TemplateSpec } from '../structured/template-spec.js';

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

  // ── 以下仅 `webpage` 环境（结构化链路）使用 ──────────────────────────
  /** 项目 id。结构化链路的计划里会用到，其它链路不需要。 */
  readonly projectId?: string | undefined;
  /**
   * 本次候选 block 类型。省略则用 block 池全集。
   *
   * 这是「用户从候选池里选取本次要用的 block」的落点：
   * **决策模型只在候选集里选**，与工具注册表那条原则同构。
   */
  readonly candidateBlockIds?: readonly string[] | undefined;
  /** 页面 block 数上限。防止"要不要继续"永远答是。 */
  readonly maxBlocks?: number | undefined;
  /** 站点名。结构化链路里由用户或确定性代码给，不让模型编。 */
  readonly brand?: string | undefined;
  /** 文案是否走生成层。默认 false —— **零成本是默认值**。 */
  readonly useGenerative?: boolean | undefined;
  /** 页面上是否标注每块的来源，便于演示与排查。 */
  readonly annotate?: boolean | undefined;
  /**
   * 是否在组装完成后**截一张图**（写入 `artifacts/screenshot.png`）。默认 **false**。
   *
   * 默认关闭的理由与"默认不调生成层"一致：截图不是交付必需品，而它要么花浏览器的
   * 钱、要么多一个产物。要求了才挂节点。
   */
  readonly screenshot?: boolean | undefined;
  /**
   * **定点重做**：只重填这些块，其余块原样透传（见 `assembleStructured`）。
   *
   * 只在给了 `pageSpec`（结构里有其它块的现成内容）时才有意义：
   * 没有内容可透传的话，"其余块"本来就得填。
   */
  readonly redoBlockIds?: readonly string[] | undefined;
  /**
   * **既定结构**：给了它就照它跑，结构不再由决策模型决定。
   *
   * 这是"带指定 PageSpec 重跑"的入口（用户改完结构再执行、或换目标补跑一次）。
   * 校验与版式规范化照旧执行——给定结构同样要合规，否则等于绕开词表。
   */
  readonly pageSpec?: PageSpec | undefined;
  /**
   * block 池。省略则用内置池。
   *
   * **必须能被传进来**：服务层装了外部来源（模型提议 / 用户手打 / 导入）的 block，
   * 而结构化链路此前自己 `createBlockRegistry()` 新建一个内置池——
   * 于是那些 block 在 `/api/blocks` 里列得出来、却**永远选不到**（池子不是同一个）。
   * 这条断链与「候选集来自注册表」的设计前提直接冲突。
   */
  readonly blocks?: BlockRegistry | undefined;
  /** 套用的模板。由调用方从模板池解析后传入（模板池在服务层）。 */
  readonly template?: TemplateSpec | undefined;
  /**
   * 是否放行"需要逐次许可"的工具（目前是生图 `render-image`）。**默认 false**。
   *
   * 默认关闭意味着 image 环境退到零成本的 `solid-image`；两个都没有就如实失败。
   * 这是刻意的：**失败比悄悄花掉一次生图好**。
   */
  readonly allowPaidGeneration?: boolean | undefined;
}

export interface AssembleResult {
  readonly plan: ExecutionPlan;
  /** 决策层的原始答案，保留用于存证与排查。 */
  readonly answers: Readonly<Record<string, unknown>>;
  /** 决策耗时（毫秒），含网络往返。 */
  readonly decisionLatencyMs: number;
  /**
   * **结构化链路专有**：逐块决策定稿的页面，以及每一轮的决策留痕。
   *
   * 单链链路没有这个东西——它的结构藏在生成出来的字符串里，拿不出来。
   * 结构化链路的结构是数据，所以能一路带到前端给用户看、给用户改。
   */
  readonly structure?:
    | {
        readonly page: PageSpec;
        readonly steps: readonly StructureStep[];
      }
    | undefined;
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
 * 需要"逐次许可"的工具 id，在没被放行时排除掉。
 *
 * 判据是 `ToolSpec.requiresPermission` 而不是写死 id 列表：加一个按次计费的工具时，
 * 在它的声明上标一下就够了，不用回来改这里（漏改就是悄悄花钱）。
 */
function paidToolsToExclude(registry: ToolRegistry, allowed: boolean): string[] {
  if (allowed) return [];
  return registry.specs().filter((s) => s.requiresPermission === true).map((s) => s.id);
}

/**
 * 各环境下的"收尾工具"。主产出之后要把东西落进 artifacts/ 并校验。
 *
 * `webpage` **刻意不在这里**：它走结构化链路，收尾由 `assemble-page` 自己完成
 * （写 `artifacts/index.html`），没有"挑一个收尾方式"这一步。
 * 给它编一个默认值只会让人以为那条路会用到它。
 */
const FINALIZE_BY_ENV: Readonly<Partial<Record<EnvType, string>>> = {
  frontend: 'build-frontend',
  image: 'process-image',
  copy: 'write-file',
};

/**
 * 该环境下**可以当主产出**的工具（角色为 generate）。
 * 收尾与校验类不参与主工具选择，否则模型可能选个"校验"当第一步，计划就废了。
 *
 * ## 两类排除，语义相反，绝不能混成一条通道
 *
 * | 通道 | 语义 | 全落空时 |
 * |---|---|---|
 * | `excludeTools`（软） | "换方案"：这个工具刚失败过，换一个 | **退回剩余全集**——有工具可用比严格遵守排除更重要 |
 * | `forbidden`（硬） | 成本闸门：这个工具要花钱，没有许可就不许碰 | **就是不许**，一个都不剩也认 |
 *
 * 这两条一旦共用一个列表就会出人命：软排除的"全落空就退回全集"兜底
 * 会把硬闸门放回来的工具一起复活。**实测踩到过**——`solid-image` 失败四次后
 * 软排除吃掉了仅剩的候选，兜底把被闸门挡住的 `render-image` 放了回来，
 * 于是**在未获许可的情况下真的调了一次生图**。
 *
 * 所以硬禁在**最前面**无条件过滤，软排除的兜底只在"还没被硬禁的"里面退回。
 */
function primaryCandidates(
  registry: ToolRegistry,
  envType: EnvType,
  excludeTools: readonly string[] = [],
  forbidden: readonly string[] = [],
): ToolSpec[] {
  const all = registry
    .filter({ envType, role: 'generate' })
    .filter((spec) => {
      // 图像后处理需要已有源图，不能作为第一步。
      return spec.id !== 'process-image';
    })
    // 硬禁：先于一切排除，且**任何兜底都不会把它放回来**。
    .filter((spec) => !forbidden.includes(spec.id));
  if (excludeTools.length === 0) return all;
  // 换方案时排除已失败的工具，逼决策层改选别的。
  const filtered = all.filter((spec) => !excludeTools.includes(spec.id));
  // 全被软排除时退回全集：有工具可用比"严格遵守排除"更重要。
  // 注意退的是 `all`（已经去掉硬禁的），不是原始全集。
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

    // ── 成本闸门：默认不碰"要逐次许可"的工具 ──────────────────────────
    //
    // 把用户那条纪律（"实测生图要经过我的许可"）写进代码，而不是靠人记着：
    // 一次疏忽就是真金白银。默认关闭时，`render-image` 不进候选，
    // image 环境会退到零成本的 `solid-image`；两个都没有就**如实失败**，
    // 而不是悄悄花掉一次生图。
    //
    // **硬禁与软排除分两条通道**（见 `primaryCandidates` 的说明）：
    // 合成一个列表的话，软排除的"全落空就退回全集"兜底会把闸门放回来的工具复活。
    const forbidden = paidToolsToExclude(registry, request.allowPaidGeneration === true);
    const softExcludes = this.options.excludeTools ?? [];

    // `webpage` 走**结构化链路**：结构由决策模型逐块决定，计划是"每块一个节点
    // + 一个组装节点"的扇入 DAG。它与下面那条单链路径不是同一个形状，
    // 所以在这里分流，而不是把两套逻辑缠在一个函数里。
    if (envType === 'webpage') {
      const structuredExcludes = [...new Set([...softExcludes, ...forbidden])];
      return await assembleStructured({
        registry,
        decision,
        request,
        ...(structuredExcludes.length > 0 ? { excludeTools: structuredExcludes } : {}),
      });
    }

    const candidates = primaryCandidates(registry, envType, softExcludes, forbidden);
    if (candidates.length === 0) {
      // 说清"为什么一个候选都没有"。笼统地说"没有主产出工具"会让人去翻注册表，
      // 而真实原因往往是成本闸门把它挡住了——那句话应当直接写在这里。
      const blocked = paidToolsToExclude(registry, false);
      const blockedHere = registry
        .filter({ envType, role: 'generate' })
        .filter((spec) => blocked.includes(spec.id))
        .map((spec) => spec.id);
      throw new PlanError(
        `环境 ${envType} 下没有任何可作为主产出的工具（角色为 generate）` +
          (blockedHere.length > 0
            ? `。被成本闸门挡住的：${blockedHere.join(', ')}` +
              `（要放行请显式传 allowPaidGeneration: true）`
            : ''),
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
    //
    // `lastNode` 成对记录「节点 id + 工具 spec」：下游连端口时要查上游**实际**产出了
    // 什么，只拿 id 是查不到的。端口名一律从这里推导，不写死。
    const refineAnswer = decided.answers[Q.needsRefine];
    let lastNode: UpstreamNode = { id: primaryNodeId, spec: primarySpec };
    if (refineAnswer !== undefined && refineAnswer.type === 'noul') {
      answersOut[Q.needsRefine] = refineAnswer;
      const wantsRefine = refineAnswer.value ?? (refineAnswer.yesProbability ?? 0) >= 0.5;
      if (wantsRefine && registry.has('refine-copy')) {
        const refineSpec = registry.getSpec('refine-copy');
        // 打磨的对象是**文案正文**，所以要求上游真的产出了文案（端口 text）。
        // html 类工具产出 html、图像类工具产出 prompt，都没有可打磨的文案：
        // 这里若硬接一个 text 端口，节点必在执行期拿不到值而失败。宁可不插。
        const upstreamHasText = lastNode.spec.outputs.some(
          (p) => p.name === 'text' && p.type === 'text',
        );
        if (!upstreamHasText) {
          rationale.push(
            `决策层要求打磨，但 ${lastNode.spec.id} 没有文案产出，跳过 refine-copy`,
          );
        } else {
          const refineNodeId = nodeId(cursor, refineSpec.id);
          nodes.push({
            id: refineNodeId,
            toolId: refineSpec.id,
            inputs: {
              text: { kind: 'ref', nodeId: lastNode.id, port: 'text' },
              instruction: {
                kind: 'literal',
                value: '保持原意，让表达更凝练、更有说服力，去掉空话。',
              },
            },
            dependsOn: [lastNode.id],
            retryable: true,
            note: '打磨文案表达',
          });
          rationale.push('决策层要求打磨文案，插入 refine-copy');
          lastNode = { id: refineNodeId, spec: refineSpec };
          cursor += 1;
        }
      }
    }

    // ── 3. 收尾：把主产出落进 artifacts/ ──────────────────────────────
    const finalizeAnswer = decided.answers[Q.finalize];
    if (finalizeAnswer !== undefined) answersOut[Q.finalize] = finalizeAnswer;

    const finalizeId = pickFinalize(registry, envType, finalizeAnswer);
    if (finalizeId !== null) {
      const finalizeSpec = registry.getSpec(finalizeId);
      const inputs = buildFinalizeInputs(finalizeSpec, lastNode, request);
      if (inputs === null) {
        // 收尾工具接不上上游（上游没有文本产出）。
        // 记录依据后跳过——插一个必挂的节点比不插更糟。
        rationale.push(
          `收尾工具 ${finalizeId} 需要文本入参，但上游 ${lastNode.spec.id} 没有文本产出，跳过收尾`,
        );
      } else if (finalizeId !== primarySpec.id) {
        // 依赖分两部分：
        //   1. 数据依赖——入参里引用了哪个节点；
        //   2. 顺序依赖——收尾必须在主产出/打磨之后跑。
        // 第 2 条不能省：`build-frontend` 的 entry 是字面量，没有数据依赖，
        // 但它必须等 src/index.html 被写出来，否则会因入口文件不存在而失败。
        const refNodeIds = Object.values(inputs)
          .filter((i): i is Extract<PlanInput, { kind: 'ref' }> => i.kind === 'ref')
          .map((i) => i.nodeId);
        const finalizeNodeId = nodeId(cursor, finalizeSpec.id);
        nodes.push({
          id: finalizeNodeId,
          toolId: finalizeSpec.id,
          inputs,
          dependsOn: unique([lastNode.id, ...refNodeIds]),
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

    // 组装完立刻静态校验：环、悬空依赖、**端口存在性**一次查清。
    // 传 registry 才能查端口——这正是此前漏掉、导致 10 种组合执行期才失败的那一项。
    validatePlan(plan, registry);

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
  // `webpage` 没有默认值——它走结构化链路，收尾由 assemble-page 自己完成。
  const fallback = FINALIZE_BY_ENV[envType];
  if (fallback !== undefined && registry.has(fallback) && fallback !== 'process-image') {
    return fallback;
  }
  return null;
}

/**
 * 上游节点：id + 它的工具 spec。
 *
 * 连端口必须知道上游**实际产出**了哪些端口，只拿节点 id 是查不到的——
 * 这正是"硬写 port: 'text'"这个 bug 的成因。
 */
interface UpstreamNode {
  readonly id: string;
  readonly spec: ToolSpec;
}

/**
 * 按上游**真实产出**挑一个能供数给 `wantedType` 入参的端口。
 *
 * 优先同名端口（`html` ← `html`），其次按常见程度回落（`text` → `html` → `copy`），
 * 最后取任意类型相符的端口。**都没有就返回 null** —— 让调用方决定跳过这个节点，
 * 而不是连一个上游根本不存在的端口，把失败推迟到执行期。
 */
function pickUpstreamPort(
  upstream: ToolSpec,
  wantedType: PortType,
  preferredNames: readonly string[] = [],
): string | null {
  const compatible = upstream.outputs.filter((p) => p.type === wantedType);
  if (compatible.length === 0) return null;
  for (const name of preferredNames) {
    if (compatible.some((p) => p.name === name)) return name;
  }
  return compatible[0]!.name;
}

/**
 * 收尾工具的入参：把上游产出接进来。
 *
 * 返回 `null` 表示**接不上**：收尾工具需要文本入参，而上游一个文本端口都没有。
 * 这时调用方应当**跳过这个收尾节点**，而不是插一个注定在执行期失败的节点。
 */
function buildFinalizeInputs(
  spec: ToolSpec,
  upstream: UpstreamNode,
  request: AssembleRequest,
): Record<string, PlanInput> | null {
  const inputs: Record<string, PlanInput> = {};
  for (const port of spec.inputs) {
    switch (port.name) {
      case 'entry': {
        // `entry` 是"要构建哪个文件"。此前这里写死 `src/index.html`，
        // 等于**断言**上游把页面写在了那里——但只有 html 类工具（scaffold-frontend /
        // static-page-from-template）真写那；draft-copy / template-copy 写 artifacts/copy.md、
        // render-image 写 artifacts/image.png，于是 build-frontend 必然报"入口文件不存在"。
        //
        // 改为从上游**真实产出**推导：上游有 html 产出，就用它报告的 file 路径。
        // 没有 html 产出，说明这不是一个网页，构建前端就没有意义 → 不插这个节点。
        const upstreamFilePort = upstream.spec.outputs.some(
          (p) => p.name === 'html' && p.type === 'text',
        )
          ? pickUpstreamPort(upstream.spec, 'file', ['file'])
          : null;
        if (upstreamFilePort === null) return null;
        inputs[port.name] = { kind: 'ref', nodeId: upstream.id, port: upstreamFilePort };
        break;
      }
      case 'text':
      case 'content':
      case 'html':
      case 'copy': {
        // 连上游**真实存在**的文本类端口，而不是写死 'text'。
        // 图像类工具产出 prompt、html 类工具产出 html，两者都没有 text 端口。
        const picked = pickUpstreamPort(upstream.spec, 'text', [
          port.name,
          'text',
          'html',
          'copy',
        ]);
        if (picked !== null) {
          inputs[port.name] = { kind: 'ref', nodeId: upstream.id, port: picked };
        } else if (port.required) {
          // 必需入参拿不到数据来源，这个节点接不起来。
          return null;
        }
        break;
      }
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
