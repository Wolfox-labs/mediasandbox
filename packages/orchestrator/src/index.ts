// ── 决策层 ────────────────────────────────────────────────────────────────
export * from './decision/types.js';
export { RizzoFlowClient, type RizzoFlowClientOptions } from './decision/rizzo-client.js';
export { StubDecisionClient } from './decision/stub-client.js';

// ── 生成层 ────────────────────────────────────────────────────────────────
export * from './llm/types.js';
export {
  OpenAiCompatibleClient,
  PROVIDERS,
  type OpenAiCompatibleOptions,
  type ProviderProfile,
} from './llm/openai-client.js';

// ── 工具层 ────────────────────────────────────────────────────────────────
export * from './tools/types.js';
export {
  ToolRegistry,
  type CandidateOption,
  type CandidateQuery,
} from './tools/registry.js';
export { BUILTIN_TOOLS } from './tools/builtin.js';

// ── 计划层 ────────────────────────────────────────────────────────────────
export * from './plan/types.js';
export { PlanAssembler, type AssembleRequest, type AssembleResult } from './plan/assembler.js';
export {
  PlanExecutor,
  type NodeState,
  type NodeStatus,
  type ExecutionEvent,
  type ExecutionListener,
  type ExecuteOptions,
  type ExecutionResult,
  type NodeOutcome,
} from './plan/executor.js';

// ── 兜底层 ────────────────────────────────────────────────────────────────
export {
  AbstentionError,
  classifyFailure,
  DEFAULT_POLICY,
  FallbackStateMachine,
  waitBackoff,
  type FailureClassification,
  type FailureKind,
  type FallbackDecision,
  type FallbackPolicy,
  type FallbackState,
} from './fallback/state-machine.js';

// ── 测试辅助 ──────────────────────────────────────────────────────────────
export {
  defineDecisionContract,
  type DecisionContractOptions,
} from './testing/decision-contract.js';
export { MockLlmClient, type MockLlmOptions, type MockRule } from './testing/mock-llm.js';
