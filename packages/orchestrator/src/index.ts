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
  type SlotFillPlan,
  type SlotValue,
  type StructureFix,
  type ValidatePageSpecOptions,
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
// 截图：接口 + 确定性占位实现。真浏览器驱动将来作为另一个实现接进来。
export {
  DEFAULT_VIEWPORT,
  PlaceholderScreenshotDriver,
  defaultScreenshotDriver,
  encodePng,
  type Screenshot,
  type ScreenshotDriver,
  type ScreenshotRequest,
} from './render/screenshot.js';
export {
  ChromiumScreenshotDriver,
  chromiumDriverFor,
  type BrowserContainer,
  type BrowserDocker,
  type ChromiumDriverOptions,
} from './render/chromium.js';
// 模拟点击：可点元素发现 + 判定 + 真驱动。判定完全不依赖浏览器，真驱动才需要。
export {
  cssAttrValue,
  describeClickTargets,
  findClickTarget,
  parseClickTargets,
  type ClickKind,
  type ClickTarget,
} from './render/click-targets.js';
export {
  buildClickScript,
  CLICK_VIEWPORT,
  defaultClickDriver,
  judgeClick,
  parseClickScriptResult,
  PlaceholderClickDriver,
  type ClickDriver,
  type ClickObservation,
  type ClickRequest,
  type ClickResult,
} from './render/click.js';
export {
  ChromiumClickDriver,
  chromiumClickDriverFor,
  type ChromiumClickDriverOptions,
  type ClickContainer,
  type ClickDocker,
} from './render/chromium-click.js';
export {
  verifyInteraction,
  type InteractionVerification,
  type VerifyInteractionRequest,
} from './structured/interaction.js';
export {
  applyTemplate,
  builtinTemplates,
  createTemplateRegistry,
  extractTemplate,
  narrowCandidates,
  TemplateError,
  TemplateRegistry,
  validateTemplate,
  type TemplateBlock,
  type TemplateErrorCode,
  type TemplateSpec,
} from './structured/template-spec.js';
export {
  createAssemblePageTool,
  createFillBlockTool,
  createPassthroughBlockTool,
  createScreenshotPageTool,
  createStructuredTools,
  STRUCTURED_TOOLS,
} from './structured/tools.js';
export { assembleStructured } from './structured/assembler.js';
// ── 演示文稿链路（第二种结构化模态） ───────────────────────────────────────
export {
  BUILTIN_SLIDE_LAYOUTS,
  builtinSlideLayoutIds,
  createSlideRegistry,
} from './structured/deck-spec.js';
export { renderDeck, type RenderDeckOptions, type SlideLayoutId } from './structured/deck-renderer.js';
export { makeSlotGenerator } from './structured/tools.js';
export {
  createAssembleDeckTool,
  createDeckTools,
  createFillSlideTool,
  createScreenshotDeckTool,
  DECK_TOOLS,
} from './structured/deck-tools.js';
export { assembleDeck } from './structured/deck-assembler.js';
export {
  DEFAULT_DECK_WRITE_TIMEOUT_MS,
  writeDeck,
  type DeckWriteOutcome,
  type DeckWritePagePlan,
  type DeckWriteRequest,
  type WrittenDeck,
  type WrittenPage,
  type WrittenSlotText,
} from './structured/deck-write.js';
export {
  candidateEnvs,
  classifyEnvType,
  ENV_QUESTION_ID,
  ENV_TYPE_LABELS,
  type EnvClassification,
} from './env-classify.js';

// ── 计划层 ────────────────────────────────────────────────────────────────
export * from './plan/types.js';
export {
  BlueprintError,
  blueprintFacts,
  describeAlignment,
  planBlueprint,
  type BlueprintOutcome,
  type BlueprintSection,
  type PageBlueprint,
  type PlanBlueprintRequest,
} from './plan/blueprint.js';
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

// ── 工作流：定义、校验、执行、缓存 ────────────────────────────────────
export {
  dependenciesOf,
  isRef,
  isRefs,
  toPlan,
  type RefSource,
  type RefsSources,
  type WorkflowDef,
  type WorkflowInput,
  type WorkflowNodeDef,
} from './workflow/types.js';
export { validateWorkflow, WorkflowError, type WorkflowErrorCode } from './workflow/validate.js';
export { runWorkflow, type RunWorkflowOptions, type WorkflowRunResult } from './workflow/runner.js';
export { FileNodeCache, type FileNodeCacheOptions } from './workflow/node-cache.js';
export { posterWorkflow, pageWorkflow, type PosterWorkflowOptions, type PageWorkflowOptions } from './workflow/presets.js';
export { cacheKeyFor, hashString, stableStringify, type NodeCache, type CachedNodeResult } from './plan/cache.js';

// ── 海报 ──────────────────────────────────────────────────────────────
export {
  DEFAULT_PALETTE as DEFAULT_POSTER_PALETTE,
  DEFAULT_POSTER_SIZE,
  normalizeBrief,
  POSTER_SIZES,
  renderPosterHtml,
  resolvePosterSize,
  type PosterBrief,
  type PosterSize,
} from './structured/poster.js';
export { createPosterTools } from './structured/poster-tools.js';
