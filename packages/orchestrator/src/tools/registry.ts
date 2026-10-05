/**
 * 工具注册表。
 *
 * 职责：
 *   1. 保存工具 spec 与执行器
 *   2. **导出决策层的候选集** —— 这是它最重要的工作。决策模型只在注册表给出的
 *      选项里选，所以"支持新工具"这件事的代价是往注册表加一条，不是重训模型。
 *   3. 按环境类型、分组筛选候选
 *
 * 候选集上限：决策层每问最多 26 项（`MAX_OPTIONS_PER_QUESTION`）。注册表工具数超过
 * 上限时，`candidatesFor` 会抛错并提示用 category 做分层——不静默截断，否则模型会
 * 在不知情的情况下失去一批选项。
 */
import { MAX_OPTIONS_PER_QUESTION } from '../decision/types.js';
import type { EnvType } from '@mediasandbox/sandbox';
import {
  ToolError,
  type ToolExecutor,
  type ToolRegistration,
  type ToolSpec,
} from './types.js';

export interface CandidateOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface CandidateQuery {
  /** 限定环境类型。省略则不筛选。 */
  readonly envType?: EnvType | undefined;
  /** 限定角色。 */
  readonly role?: ToolSpec['role'] | undefined;
  /** 限定分组。 */
  readonly category?: string | undefined;
  /** 排除指定工具 id。用于"换方案"时避免重选已经失败的工具。 */
  readonly exclude?: readonly string[] | undefined;
}

function validateSpec(spec: ToolSpec): void {
  if (spec.id.trim() === '') {
    throw new ToolError('工具 id 不能为空', 'BAD_SPEC', spec.id);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) {
    throw new ToolError(
      `工具 id 只允许小写字母、数字与连字符: ${spec.id}`,
      'BAD_SPEC',
      spec.id,
    );
  }
  if (spec.envTypes.length === 0) {
    throw new ToolError(`工具 ${spec.id} 未声明任何环境类型`, 'BAD_SPEC', spec.id);
  }
  const inputNames = new Set<string>();
  for (const port of spec.inputs) {
    if (inputNames.has(port.name)) {
      throw new ToolError(`工具 ${spec.id} 的入参端口重名: ${port.name}`, 'BAD_SPEC', spec.id);
    }
    inputNames.add(port.name);
  }
  const outputNames = new Set<string>();
  for (const port of spec.outputs) {
    if (outputNames.has(port.name)) {
      throw new ToolError(`工具 ${spec.id} 的产出端口重名: ${port.name}`, 'BAD_SPEC', spec.id);
    }
    outputNames.add(port.name);
  }
  if (spec.outputs.length === 0) {
    throw new ToolError(`工具 ${spec.id} 未声明任何产出`, 'BAD_SPEC', spec.id);
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  /** 注册一个工具。id 重复即抛错——静默覆盖会让执行计划指向错误的实现。 */
  register(spec: ToolSpec, execute: ToolExecutor): this {
    validateSpec(spec);
    if (this.tools.has(spec.id)) {
      throw new ToolError(`工具 id 已被注册: ${spec.id}`, 'DUPLICATE_TOOL', spec.id);
    }
    this.tools.set(spec.id, { spec, execute });
    return this;
  }

  /** 批量注册。任一条失败则整体失败，不做部分注册。 */
  registerAll(entries: readonly ToolRegistration[]): this {
    for (const entry of entries) validateSpec(entry.spec);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.spec.id)) {
        throw new ToolError(`批量注册中存在重复 id: ${entry.spec.id}`, 'DUPLICATE_TOOL', entry.spec.id);
      }
      seen.add(entry.spec.id);
      if (this.tools.has(entry.spec.id)) {
        throw new ToolError(`工具 id 已被注册: ${entry.spec.id}`, 'DUPLICATE_TOOL', entry.spec.id);
      }
    }
    for (const entry of entries) {
      this.tools.set(entry.spec.id, entry);
    }
    return this;
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  get(toolId: string): ToolRegistration {
    const entry = this.tools.get(toolId);
    if (entry === undefined) {
      throw new ToolError(`未注册的工具: ${toolId}`, 'UNKNOWN_TOOL', toolId);
    }
    return entry;
  }

  getSpec(toolId: string): ToolSpec {
    return this.get(toolId).spec;
  }

  /** 全部工具 spec，按 id 排序保证确定性。 */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((e) => e.spec).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** 全部分组名，按字母序。组装器用它做分层候选。 */
  categories(): string[] {
    return [...new Set(this.specs().map((s) => s.category))].sort();
  }

  /** 按查询条件筛选工具 spec。结果按 id 排序。 */
  filter(query: CandidateQuery = {}): ToolSpec[] {
    const exclude = new Set(query.exclude ?? []);
    return this.specs().filter((spec) => {
      if (exclude.has(spec.id)) return false;
      if (query.envType !== undefined && !spec.envTypes.includes(query.envType)) return false;
      if (query.role !== undefined && spec.role !== query.role) return false;
      if (query.category !== undefined && spec.category !== query.category) return false;
      return true;
    });
  }

  /**
   * 导出决策层可用的候选集。
   *
   * 超出单问上限时抛错，而不是截断——静默截断会让模型在不知情的情况下少一批选项，
   * 这类问题在结果里看不出来，很难排查。调用方应改用 category 分层。
   */
  candidatesFor(query: CandidateQuery = {}): CandidateOption[] {
    const specs = this.filter(query);
    if (specs.length === 0) {
      throw new ToolError(
        `候选集为空（查询条件: ${JSON.stringify(query)}）`,
        'BAD_SPEC',
        '(registry)',
      );
    }
    if (specs.length > MAX_OPTIONS_PER_QUESTION) {
      throw new ToolError(
        `候选集有 ${specs.length} 项，超过决策层单问上限 ${MAX_OPTIONS_PER_QUESTION}。` +
          `请用 category 分层选择。`,
        'BAD_SPEC',
        '(registry)',
      );
    }
    return specs.map((spec) => ({
      id: spec.id,
      label: spec.label,
      detail: spec.description,
    }));
  }

  /**
   * 转成决策层 `choice` 原语要的 criteria 结构（id → 描述）。
   * 描述里带上 role 与产出类型，让模型能区分相近工具。
   */
  criteriaFor(query: CandidateQuery = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const option of this.candidatesFor(query)) {
      out[option.id] = `${option.detail}（${option.label}）`;
    }
    return out;
  }

  get size(): number {
    return this.tools.size;
  }
}
