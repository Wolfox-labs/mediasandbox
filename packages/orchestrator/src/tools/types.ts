/**
 * 工具契约。
 *
 * 一个"工具"是一次可被编排的原子操作：生成一段文案、渲染一张图、跑一次构建、校验产物。
 *
 * 三条设计约束：
 *   1. **候选集来自注册表**。决策层只在注册表导出的选项里选，因此扩展工具链 =
 *      往注册表里加条目，**不需要重训模型**。
 *   2. **执行器是纯函数式的**：入参从 runtime 拿，产物写进沙盒的 artifacts/。
 *   3. **声明式**：spec 描述"能做什么、需要什么、产出什么"，组装器据此判断依赖与顺序。
 */
import type { Artifact, EnvType, SandboxHandle, SandboxProvider } from '@mediasandbox/sandbox';
import type { LlmClient } from '../llm/types.js';

/** 工具在执行计划里承担的角色。组装器用它判断能否并发、是否需要串接。 */
export type ToolRole =
  /** 从无到有产出内容（调生成层）。 */
  | 'generate'
  /** 对既有产物做变换（格式化、转换、拼装）。 */
  | 'transform'
  /** 校验产物是否符合要求。 */
  | 'verify'
  /** 在沙盒里执行命令（构建、打包、运行测试）。 */
  | 'execute';

/** 端口类型。用于组装器做类型匹配。 */
export type PortType =
  /** 自由文本。 */
  | 'text'
  /** 结构化 JSON。 */
  | 'json'
  /** 沙盒内的文件路径（相对 workDir）。 */
  | 'file'
  /** 产物的逻辑标识。 */
  | 'artifact'
  /** 数值。 */
  | 'number'
  /** 布尔。 */
  | 'boolean';

export interface ToolPort {
  readonly name: string;
  readonly type: PortType;
  readonly required: boolean;
  readonly description: string;
}

export interface ToolSpec {
  /** 稳定标识。组装器与注册表都用它引用。 */
  readonly id: string;
  /** 展示给决策模型的名称。 */
  readonly label: string;
  /** 补充说明，让决策模型区分相近工具。 */
  readonly description: string;
  /** 该工具可运行的环境类型。 */
  readonly envTypes: readonly EnvType[];
  readonly role: ToolRole;
  /** 分组。候选集超过单问上限时，组装器按分组做分层选择。 */
  readonly category: string;
  /** 入参端口。 */
  readonly inputs: readonly ToolPort[];
  /** 产出端口。 */
  readonly outputs: readonly ToolPort[];
  /** 该工具需要沙盒里存在哪些命令。用于启动前体检，不参与执行成败判定。 */
  readonly requiresCommands?: readonly string[] | undefined;
  /** 耗时量级提示。组装器可用它做并发调度。 */
  readonly costHint?: 'fast' | 'medium' | 'slow' | undefined;
}

/** 工具执行时能拿到的一切。 */
export interface ToolRuntime {
  readonly sandbox: SandboxProvider;
  readonly handle: SandboxHandle;
  /** 生成层客户端。纯本地工具（如跑构建）不需要它。 */
  readonly llm: LlmClient | undefined;
  /** 上游产出。键为上游工具的输出端口名。 */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** 取消信号。组装器在熔断或用户取消时触发。 */
  readonly signal: AbortSignal | undefined;
  /** 结构化日志。编排层收集后回传前端。 */
  readonly log: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** 本次工具调用的超时毫秒。 */
  readonly timeoutMs: number;
}

export interface ToolResult {
  readonly outputs: Readonly<Record<string, unknown>>;
  /** 写入 artifacts/ 的产物。 */
  readonly artifacts: readonly Artifact[];
  /**
   * 人类可读摘要。会进入后续决策的 evidence，也会显示在前端。
   * 保持简短——它会被塞进决策层的 state。
   */
  readonly summary: string;
}

export type ToolExecutor = (runtime: ToolRuntime) => Promise<ToolResult>;

/** 一条注册记录：spec 描述能力，execute 是真实实现。 */
export interface ToolRegistration {
  readonly spec: ToolSpec;
  readonly execute: ToolExecutor;
}

export class ToolError extends Error {
  override readonly name = 'ToolError';
  constructor(
    message: string,
    readonly code: ToolErrorCode,
    readonly toolId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type ToolErrorCode =
  /** 注册表里没有这个工具。 */
  | 'UNKNOWN_TOOL'
  /** 工具 id 重复注册。 */
  | 'DUPLICATE_TOOL'
  /** spec 本身不合法。 */
  | 'BAD_SPEC'
  /** 执行器抛错。 */
  | 'EXECUTION_FAILED'
  /** 工具不支持当前环境类型。 */
  | 'ENV_NOT_SUPPORTED';
