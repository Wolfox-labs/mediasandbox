/**
 * 创作工作台的跨步骤状态。
 *
 * ## 为什么要有这个 store
 *
 * 工作台拆成了 4 个**带独立地址**的步骤页（`/workbench/:step?`）。切步骤 =
 * 组件卸载重建，所以"写了什么目标、选了哪些块、这次跑到哪一步"不能各页各存一份，
 * 只能放在比页面活得久的地方。
 *
 * ## 存什么、不存什么
 *
 * 存两类：
 *   1. 第 1 步收集的**入参**：目标、模态、候选块、模板、上限、品牌、生成开关
 *   2. 第 2 步提交后的**运行快照**：runId、状态、统筹规划、结构、产物、交互验证结论
 *
 * 不存"事件流"本身：它是原始数据，而且服务端在 WebSocket 连上时会**补发历史**，
 * 刷新后重连照样能重建（`foldEvents` 是无状态的全量折叠）。存一份事件流只会
 * 让"到底以谁为准"变成第二个问题。
 *
 * 入参与 runId 落 localStorage：刷新后停在同一页，上次写到哪、跑的是哪一次都还在。
 * 运行快照不落盘——那是服务端的事实来源，页面加载后用 `GET /api/runs/:id` 取。
 */
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { api, ApiError, type CreateRunInput } from '@/api/client';
import {
  ENV_LABELS,
  UI_ENV_TYPES,
  isTerminal,
  type Artifact,
  type BlueprintView,
  type CreateRunResult,
  type EnvType,
  type InteractionVerdict,
  type RunStatus,
  type StructureView,
  type WireEvent
} from '@/api/types';
import { foldEvents, type RunViewModel } from '@/state/run-view-model';
import { SetupStoreId } from '@/enum';

/** 模板来源：空白（模型自由排）/ 历史模板 / 新建模板。 */
export type TemplateMode = 'blank' | 'saved' | 'new';

/** 沙盒实现。docker 是容器级隔离，local 是路径级隔离。 */
export type SandboxProvider = 'docker' | 'local';

/** 落盘的状态形状。运行快照不在里面，理由见文件头。 */
interface WorkbenchSnapshot {
  goal: string;
  envType: EnvType;
  candidateBlockIds: string[];
  poolSkipped: boolean;
  templateMode: TemplateMode;
  templateId: string | null;
  newTemplateLabel: string;
  newTemplateDescription: string;
  maxBlocks: number;
  brand: string;
  useGenerative: boolean;
  annotate: boolean;
  screenshot: boolean;
  provider: SandboxProvider;
  runId: string | null;
}

const STORAGE_KEY = `${import.meta.env.VITE_STORAGE_PREFIX || ''}workbench-state`;

function readSnapshot(): Partial<WorkbenchSnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<WorkbenchSnapshot>;
  } catch {
    // 存的东西坏了就当没存过：这里不该把整个工作台卡在启动阶段。
    return {};
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asEnvType(value: unknown): EnvType {
  return UI_ENV_TYPES.includes(value as EnvType) ? (value as EnvType) : 'webpage';
}

function asTemplateMode(value: unknown): TemplateMode {
  return value === 'saved' || value === 'new' ? value : 'blank';
}

function asProvider(value: unknown): SandboxProvider {
  return value === 'local' ? 'local' : 'docker';
}

/**
 * 从事件流里取**当前生效**的统筹规划。
 *
 * 取最后一条 `plan_assembled` 的字段（哪怕那条没带 blueprint）：
 * 换方案重跑时，界面上显示的必须是本次生效的计划，而不是上一次的残留。
 */
function lastBlueprint(events: readonly WireEvent[]): BlueprintView | undefined {
  let found: BlueprintView | undefined;
  for (const event of events) {
    if (event.type === 'plan_assembled') found = event.blueprint;
  }
  return found;
}

/** 从事件流里取最后一次补发的产物清单（已结束的运行会带）。 */
function lastArtifacts(events: readonly WireEvent[]): Artifact[] | undefined {
  let found: Artifact[] | undefined;
  for (const event of events) {
    if (event.type === 'run_state') found = [...event.artifacts];
  }
  return found;
}

export const useWorkbenchStore = defineStore(SetupStoreId.Workbench, () => {
  const saved = readSnapshot();

  // ── 第 1 步：创作目标 ──────────────────────────────────────────────
  const goal = ref(asString(saved.goal, ''));
  const envType = ref<EnvType>(asEnvType(saved.envType));
  /** 选中的候选 block 类型。空数组 = 没选（提交时不传，等于用池子全集）。 */
  const candidateBlockIds = ref<string[]>(asStringList(saved.candidateBlockIds));
  /** 跳过 block 选择：本次不限定候选集，把选块的决定权全交给模型。 */
  const poolSkipped = ref(asBoolean(saved.poolSkipped, false));

  const templateMode = ref<TemplateMode>(asTemplateMode(saved.templateMode));
  const templateId = ref<string | undefined>(
    typeof saved.templateId === 'string' ? saved.templateId : undefined
  );
  const newTemplateLabel = ref(asString(saved.newTemplateLabel, ''));
  const newTemplateDescription = ref(asString(saved.newTemplateDescription, ''));
  /** 「新建模板」是否已经存进模板池。没存就不许往下走，否则这个选择等于空话。 */
  const templateSaved = ref(false);

  const maxBlocks = ref(typeof saved.maxBlocks === 'number' ? saved.maxBlocks : 6);
  const brand = ref(asString(saved.brand, ''));
  const useGenerative = ref(asBoolean(saved.useGenerative, false));
  const annotate = ref(asBoolean(saved.annotate, true));
  const screenshot = ref(asBoolean(saved.screenshot, true));

  const provider = ref<SandboxProvider>(asProvider(saved.provider));
  /** 沙盒实现是不是用户定过的。没定过时采用 `/api/health` 报的默认值。 */
  const providerPinned = ref(typeof saved.provider === 'string');

  // ── 第 2 步：运行快照 ──────────────────────────────────────────────
  const runId = ref<string | undefined>(
    typeof saved.runId === 'string' ? saved.runId : undefined
  );
  const status = ref<RunStatus | 'unknown'>('unknown');
  const blueprint = ref<BlueprintView | undefined>(undefined);
  const structure = ref<StructureView | undefined>(undefined);
  const artifacts = ref<Artifact[]>([]);
  /** 由事件流折叠出来的完整视图（执行步骤、重试、依据）。 */
  const viewModel = ref<RunViewModel | undefined>(undefined);
  const durationMs = ref<number | undefined>(undefined);
  const reason = ref<string | undefined>(undefined);
  const error = ref<string | undefined>(undefined);
  const queuePosition = ref<number | undefined>(undefined);
  const hydrating = ref(false);
  /** 运行详情都取不到时的原因（后端没起、运行不存在）。 */
  const hydrateError = ref<string | undefined>(undefined);

  // ── 第 3 步：交互验证结论 ──────────────────────────────────────────
  const verdict = ref<InteractionVerdict | null>(null);
  const verifyError = ref<string | undefined>(undefined);
  /** 验证请求的往返耗时（客户端计时）。结论里没有这个字段。 */
  const verifyMs = ref<number | undefined>(undefined);
  const verifying = ref(false);

  // ── 派生判断 ───────────────────────────────────────────────────────
  const goalFilled = computed(() => goal.value.trim() !== '');
  const isWebpage = computed(() => envType.value === 'webpage');
  /** 演示文稿：第二种结构化模态。单元是版式，一次产出多页。 */
  const isSlides = computed(() => envType.value === 'slides');
  /**
   * 是否走**结构化链路**（网页 / 演示文稿）。
   *
   * 这两种模态共用同一套"选单元 → 决策 → 交互测试 → 结果"的流程，
   * 差别在单元池（block / 版式）与产物。界面按这个判断显示哪些区块，
   * 而不是到处写 `envType === 'webpage' || envType === 'slides'`。
   */
  const isStructured = computed(() => isWebpage.value || isSlides.value);
  /** 单元的中文叫法。写死在文案里会出现"页面元素"配"章节分隔页"这种错位。 */
  const unitNoun = computed(() => (isSlides.value ? '版式' : '区块'));
  const envLabel = computed(() => ENV_LABELS[envType.value].label);

  const runActive = computed(() => runId.value !== undefined && !isTerminal(status.value));
  const runFinished = computed(() => runId.value !== undefined && isTerminal(status.value));
  const structureReady = computed(
    () => structure.value !== undefined && structure.value.page.blocks.length > 0
  );
  /** 决策这一步算完成：提交过运行，且结构定稿（执行完不代表结构一定有）。 */
  const decisionSettled = computed(() => runId.value !== undefined && runFinished.value && structureReady.value);
  const tested = computed(() => verdict.value !== null);

  /**
   * 第 1 步能不能往下走；不能时有**具体原因**而不是一个灰按钮。
   *
   * 「新建模板」停在未保存状态时卡住是有意的：那时提交参数里既没有模板、
   * 也不知道用户到底想套什么，放过去等于悄悄忽略了这一步的选择。
   */
  const goalBlocker = computed<string | null>(() => {
    if (!goalFilled.value) return '先写一句目标：要做什么、给谁看';
    if (isWebpage.value && templateMode.value === 'new' && !templateSaved.value) {
      return '新模板还没保存：点「保存模板」，或改选「空白」';
    }
    if (isWebpage.value && templateMode.value === 'saved' && templateId.value === undefined) {
      return '选了「历史模板」但还没挑具体哪一套';
    }
    return null;
  });

  const canGoNext = computed(() => goalBlocker.value === null);

  /** 第 2 步能不能往下走。 */
  const decisionBlocker = computed<string | null>(() => {
    if (runId.value === undefined) return '先点「提交并开始决策」';
    if (!runFinished.value) return '运行还没结束，等结构和产物出来';
    if (!structureReady.value) return '这次运行没有区块结构，去不了交互测试';
    return null;
  });

  /** 第 3 步能不能往下走。没做测试也允许直接看结果：可能本机没有浏览器驱动。 */
  const interactionBlocker = computed<string | null>(() =>
    runId.value === undefined ? '还没有运行' : null
  );

  /** 提交参数。**只在一处组装**，避免两个按钮传出两套参数。 */
  function buildCreateInput(): CreateRunInput {
    const trimmedGoal = goal.value.trim();
    // 结构化模态（网页 / 演示文稿）用的是同一组参数：候选集、页数上限、
    // 生成式开关。差别只有"模板"——模板池是按 block 建的，演示文稿没有。
    const structured = isStructured.value;
    const useSavedTemplate =
      isWebpage.value && templateMode.value === 'saved' && templateId.value !== undefined;
    return {
      goal: trimmedGoal,
      envType: envType.value,
      provider: provider.value,
      ...(structured
        ? {
            // 跳过时**不传候选集**：那个字段的意思正是"只在这些里选"，
            // 传全集与不传并不等价（池子会在运行期间变）。
            ...(poolSkipped.value || candidateBlockIds.value.length === 0
              ? {}
              : { candidateBlockIds: [...candidateBlockIds.value] }),
            maxBlocks: maxBlocks.value,
            useGenerative: useGenerative.value,
            ...(isWebpage.value ? { annotate: annotate.value } : {}),
            screenshot: screenshot.value,
            ...(brand.value.trim() === '' ? {} : { brand: brand.value.trim() }),
            ...(useSavedTemplate ? { templateId: templateId.value } : {})
          }
        : {})
    };
  }

  /** 换一次运行：把上一轮的快照清干净，再记新的。传 `undefined` 就是清空。 */
  function adoptRun(nextRunId: string | undefined, note?: { queuePosition?: number | undefined }): void {
    runId.value = nextRunId;
    status.value = 'queued';
    blueprint.value = undefined;
    structure.value = undefined;
    artifacts.value = [];
    viewModel.value = undefined;
    durationMs.value = undefined;
    reason.value = undefined;
    error.value = undefined;
    hydrateError.value = undefined;
    verdict.value = null;
    verifyError.value = undefined;
    verifyMs.value = undefined;
    queuePosition.value = note?.queuePosition;
  }

  /**
   * 提交一次运行。
   *
   * 抛 `ApiError`（400/429/503 都有语义），由调用方决定怎么说——
   * 这一层不吞错，界面才可能如实说明"是被队列挡了、还是参数不合格"。
   */
  async function submitRun(): Promise<CreateRunResult> {
    const result = await api.createRun(buildCreateInput());
    adoptRun(result.runId, { queuePosition: result.queuePosition });
    return result;
  }

  /**
   * 定点重做：只重填选中的块，其余块复用 `fromRunId` 那次运行的现成内容。
   *
   * 走 `redoFrom + blockIds` 而不是"把结构发下去再发上来"：内容由服务端从
   * 沙盒里那一份读回来，少一圈往返，也不会出现两份内容不一致。
   */
  async function submitRedo(fromRunId: string, blockIds: readonly string[]): Promise<CreateRunResult> {
    const result = await api.createRun({
      goal: goal.value.trim() === '' ? '定点重做' : goal.value.trim(),
      envType: 'webpage',
      provider: provider.value,
      redoFrom: fromRunId,
      blockIds: [...blockIds]
    });
    adoptRun(result.runId, { queuePosition: result.queuePosition });
    return result;
  }

  /**
   * 重新规划：用同样的目标再跑一次，重新出统筹规划与结构。
   *
   * 后端没有"只重跑规划"的入口（规划是结构决策的输入，不是独立产物），
   * 所以这里就是再提交一次运行，并**显式要求**跑规划。
   */
  async function replan(): Promise<CreateRunResult> {
    const result = await api.createRun({ ...buildCreateInput(), useBlueprint: true });
    adoptRun(result.runId, { queuePosition: result.queuePosition });
    return result;
  }

  /** 把事件流折叠成界面状态。shell 每收到一条事件就调用一次。 */
  function applyEvents(events: readonly WireEvent[]): void {
    const current = runId.value;
    if (current === undefined) return;
    // 只认这一次运行的事件：没有 runId 过滤时流里会有别处的运行。
    const mine = events.filter(event => event.runId === current);
    if (mine.length === 0) return;

    const vm = foldEvents(mine);
    viewModel.value = vm;
    if (vm.status !== 'unknown') status.value = vm.status;
    if (vm.structure !== undefined) structure.value = vm.structure;
    const plan = lastBlueprint(mine);
    if (plan !== undefined) blueprint.value = plan;
    const settled = lastArtifacts(mine);
    if (settled !== undefined) artifacts.value = settled;
    if (vm.finished !== undefined) durationMs.value = vm.finished.durationMs;
    if (vm.reason !== undefined) reason.value = vm.reason;
  }

  /**
   * 用 REST 详情补齐快照。
   *
   * 为什么要有它：WebSocket 只推**事件**，而"刷新页面时那次运行早就结束了"
   * 这种情况只能靠 `GET /api/runs/:id` 把结构、规划、产物取回来。
   */
  async function hydrate(): Promise<void> {
    const current = runId.value;
    if (current === undefined) return;
    hydrating.value = true;
    hydrateError.value = undefined;
    try {
      const detail = await api.getRun(current);
      if (runId.value !== current) return; // 期间切过运行，这份结果作废。
      status.value = detail.status;
      if (detail.structure !== null && detail.structure !== undefined) structure.value = detail.structure;
      // `null` 表示"这条路没跑"，与 `ok:false`（跑了没成 / 被关掉）不是一件事，
      // 所以只有拿到真东西才覆盖，别把 WS 先到的结果擦掉。
      if (detail.blueprint !== null && detail.blueprint !== undefined) blueprint.value = detail.blueprint;
      artifacts.value = [...detail.artifacts];
      if (detail.reason !== undefined) reason.value = detail.reason;
      if (detail.error !== undefined) error.value = detail.error;
      if (detail.finishedAt !== undefined) durationMs.value = detail.finishedAt - detail.startedAt;
      queuePosition.value = detail.queuePosition;
    } catch (caught) {
      hydrateError.value = caught instanceof ApiError ? caught.message : '读取运行详情失败';
    } finally {
      hydrating.value = false;
    }
  }

  /**
   * 打开一次已有运行（结果页的"查看历史运行"）。
   *
   * 换运行号之后立刻用 REST 把详情取回来：那一次运行可能早就结束了，
   * 等 WebSocket 补发也行，但点一下要立刻有东西看。
   */
  async function openRun(nextRunId: string): Promise<void> {
    adoptRun(nextRunId);
    await hydrate();
  }

  /** 重新取产物清单（产物在运行结束后才落定，所以会晚于状态变化）。 */
  async function loadArtifacts(): Promise<void> {
    const current = runId.value;
    if (current === undefined) return;
    try {
      const result = await api.listArtifacts(current);
      if (runId.value !== current) return;
      artifacts.value = result.artifacts;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status !== 404) {
        hydrateError.value = caught.message;
      }
    }
  }

  /**
   * 改结构后的回写。
   *
   * 接口只回 `{id,type,status}`，所以**按 id 合并**：`slotNames` 等字段
   * 用原来那份补回来，否则界面上"这块有哪些 slot"会凭空消失。
   */
  function applyStructureBlocks(
    blocks: readonly { readonly id: string; readonly type: string; readonly status: string }[]
  ): void {
    const current = structure.value;
    if (current === undefined) return;
    const slotNamesById = new Map(current.page.blocks.map(block => [block.id, block.slotNames]));
    structure.value = {
      ...current,
      page: {
        ...current.page,
        blocks: blocks.map(block => ({
          id: block.id,
          type: block.type,
          status: block.status,
          slotNames: slotNamesById.get(block.id) ?? []
        }))
      }
    };
  }

  /**
   * 真浏览器交互验证。
   *
   * 失败按状态码说不同的话：503 本机没有浏览器驱动、410 沙盒已回收、
   * 409 这次运行没有可验证的页面——三者都不该被糊成"测试失败"。
   */
  async function verifyInteraction(): Promise<void> {
    const current = runId.value;
    if (current === undefined) return;
    verifying.value = true;
    verifyError.value = undefined;
    verifyMs.value = undefined;
    const startedAt = Date.now();
    try {
      verdict.value = await api.verifyInteraction(current);
      verifyMs.value = Date.now() - startedAt;
    } catch (caught) {
      verdict.value = null;
      if (caught instanceof ApiError) {
        verifyError.value =
          caught.status === 503
            ? `本机没有浏览器驱动，无法真点击（${caught.message}）`
            : caught.status === 410
              ? `沙盒已回收，无法再验证（${caught.message}）`
              : caught.status === 409
                ? `这次运行没有可验证的页面（${caught.message}）`
                : caught.status === 404
                  ? `找不到这次运行（${caught.message}）`
                  : caught.message;
      } else {
        verifyError.value = '交互测试失败';
      }
    } finally {
      verifying.value = false;
    }
  }

  /** 采用后端报的默认沙盒；用户自己选过就不动。 */
  function adoptDefaultProvider(name: string): void {
    if (providerPinned.value) return;
    if (name !== 'docker' && name !== 'local') return;
    provider.value = name;
  }

  function setProvider(next: SandboxProvider): void {
    provider.value = next;
    providerPinned.value = true;
  }

  /** 新建模板存好之后：切到「历史模板」并选中它，这一次运行就真的套上它。 */
  function markTemplateSaved(id: string): void {
    templateSaved.value = true;
    templateMode.value = 'saved';
    templateId.value = id;
  }

  /** 「重新开始」：清掉入参与运行快照，回到第 1 步的空白状态。 */
  function reset(): void {
    goal.value = '';
    envType.value = 'webpage';
    candidateBlockIds.value = [];
    poolSkipped.value = false;
    templateMode.value = 'blank';
    templateId.value = undefined;
    newTemplateLabel.value = '';
    newTemplateDescription.value = '';
    templateSaved.value = false;
    maxBlocks.value = 6;
    brand.value = '';
    useGenerative.value = false;
    annotate.value = true;
    screenshot.value = true;
    providerPinned.value = false;
    adoptRun(undefined);
    status.value = 'unknown';
    hydrating.value = false;
    queuePosition.value = undefined;
  }

  // 入参与 runId 落盘。快照不落盘（见文件头）。
  watch(
    [
      goal,
      envType,
      candidateBlockIds,
      poolSkipped,
      templateMode,
      templateId,
      newTemplateLabel,
      newTemplateDescription,
      maxBlocks,
      brand,
      useGenerative,
      annotate,
      screenshot,
      provider,
      runId
    ],
    () => {
      const snapshot: WorkbenchSnapshot = {
        goal: goal.value,
        envType: envType.value,
        candidateBlockIds: [...candidateBlockIds.value],
        poolSkipped: poolSkipped.value,
        templateMode: templateMode.value,
        templateId: templateId.value ?? null,
        newTemplateLabel: newTemplateLabel.value,
        newTemplateDescription: newTemplateDescription.value,
        maxBlocks: maxBlocks.value,
        brand: brand.value,
        useGenerative: useGenerative.value,
        annotate: annotate.value,
        screenshot: screenshot.value,
        provider: provider.value,
        runId: runId.value ?? null
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // 存储满了 / 被禁用了：功能照用，只是刷新后不记得。
      }
    },
    { deep: true }
  );

  return {
    // 第 1 步
    goal,
    envType,
    candidateBlockIds,
    poolSkipped,
    templateMode,
    templateId,
    newTemplateLabel,
    newTemplateDescription,
    templateSaved,
    maxBlocks,
    brand,
    useGenerative,
    annotate,
    screenshot,
    provider,
    // 第 2 步
    runId,
    status,
    blueprint,
    structure,
    artifacts,
    viewModel,
    durationMs,
    reason,
    error,
    queuePosition,
    hydrating,
    hydrateError,
    // 第 3 步
    verdict,
    verifyError,
    verifyMs,
    verifying,
    // 派生
    goalFilled,
    isWebpage,
    isSlides,
    isStructured,
    unitNoun,
    envLabel,
    runActive,
    runFinished,
    structureReady,
    decisionSettled,
    tested,
    goalBlocker,
    canGoNext,
    decisionBlocker,
    interactionBlocker,
    // 动作
    buildCreateInput,
    submitRun,
    submitRedo,
    replan,
    applyEvents,
    hydrate,
    openRun,
    loadArtifacts,
    applyStructureBlocks,
    verifyInteraction,
    adoptDefaultProvider,
    setProvider,
    markTemplateSaved,
    reset
  };
});
