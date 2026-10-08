// ── 决策层 ────────────────────────────────────────────────────────────────
export * from './decision/types.js';
export { RizzoFlowClient, type RizzoFlowClientOptions } from './decision/rizzo-client.js';
export { StubDecisionClient } from './decision/stub-client.js';
export { DemoDecisionClient, type DemoDecisionOptions } from './decision/demo-client.js';

// ── 生成层 ────────────────────────────────────────────────────────────────
export * from './llm/types.js';
export {
  OpenAiCompatibleClient,
  PROVIDERS,
  type OpenAiCompatibleOptions,
  type ProviderProfile,
} from './llm/openai-client.js';
export { SplitLlmClient, type SplitLlmOptions } from './llm/split-client.js';

// ── 工具层 ────────────────────────────────────────────────────────────────
export * from './tools/types.js';
export {
  ToolRegistry,
  type CandidateOption,
  type CandidateQuery,
} from './tools/registry.js';
export { BUILTIN_TOOLS } from './tools/builtin.js';

// ── 结构化制作层（P1/P2） ─────────────────────────────────────────────────
export {
  BlockError,
  BlockRegistry,
  BLOCK_GROUPS,
  BLOCK_GROUP_LABELS,
  BUILTIN_BLOCKS,
  builtinBlockIds,
  createBlockRegistry,
  type BlockErrorCode,
  type BlockGroup,
  type BlockOption,
  type BlockPlacement,
  type BlockQuery,
  type BlockSpec,
  type SlotSpec,
  type SlotType,
} from './structured/block-spec.js';
export {
  appendBlock,
  blockTypesOf,
  createPageSpec,
  describePageSpec,
  insertBlock,
  moveBlock,
  nextBlockId,
  normalizePageSpec,
  PageSpecError,
  removeBlock,
  replaceBlock,
  validatePageSpec,
  valueKindFor,
  type BlockInstance,
  type BlockStatus,
  type ImageRef,
  type PageSpec,
  type PageSpecErrorCode,
  type SlotSource,
  type SlotValue,
  type StructureFix,
} from './structured/page-spec.js';
export {
  blockTypeSequence,
  CONTINUE_NO_THRESHOLD,
  CONTINUE_YES_THRESHOLD,
  DEFAULT_MAX_BLOCKS,
  isFilled,
  StructureError,
  StructurePlanner,
  STRUCTURE_QUESTIONS,
  type PlanStructureRequest,
  type PlanStructureResult,
  type StructureErrorCode,
  type StructureStep,
} from './structured/planner.js';
export {
  deriveBrand,
  fillBlock,
  fillPage,
  isWebpageEnv,
  nonEmptyLines,
  placeholderImageDataUri,
  shorten,
  type FillOptions,
  type FilledBlock,
  type GenerateSlotRequest,
  type GenerateSlotResult,
} from './structured/filler.js';
export { escapeHtml, pageStyles, renderPage, type RenderOptions } from './structured/renderer.js';
export {
  assemblePageTool,
  fillBlockTool,
  STRUCTURED_TOOLS,
} from './structured/tools.js';
export { assembleStructured } from './structured/assembler.js';

// ── 计划层 ────────────────────────────────────────────────────────────────
export * from './plan/types.js';
export { PlanAssembler, type AssembleRequest, type AssembleResult } from './plan/assembler.js';
export {
  PlanExecutor,
  type NodeState,
  type NodeStatus,
  type NodeErrorInfo,
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

// ── 编排入口 ──────────────────────────────────────────────────────────────
export {
  Orchestrator,
  type AttemptRecord,
  type OrchestrationEvent,
  type RunOptions,
  type RunRequest,
  type RunResult,
} from './orchestrator.js';

// ── 测试辅助 ──────────────────────────────────────────────────────────────
export {
  defineDecisionContract,
  type DecisionContractOptions,
} from './testing/decision-contract.js';
export { MockLlmClient, type MockLlmOptions, type MockRule } from './testing/mock-llm.js';
