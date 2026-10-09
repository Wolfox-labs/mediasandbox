/**
 * 后端 REST 客户端（MediaSandbox 管理端）。
 *
 * 从 `packages/web/src/api/client.ts` 移植，并补上管理端新增的能力：
 * 模板与 block 的写入、结构读改（F5）、成本闸门与目标分类（F2/F3）。
 *
 * 开发时经 Vite 代理同源访问（见 vite.config.ts 的 `server.proxy`），
 * 所以这里一律用相对路径，不写死后端地址 —— 换环境只改代理配置。
 */
import type {
  Artifact,
  BlockGroup,
  BlockGroupSummary,
  BlockInput,
  BlockSpec,
  EnvChoice,
  HealthResponse,
  ProjectItem,
  RunListItem,
  RunRecord,
  StructureFix,
  StructureOp,
  StructureView,
  TemplateItem,
  TemplateInput,
  ToolSpec
} from "./types";

/** 后端返回的错误信封。 */
interface ErrorEnvelope {
  readonly error?: string;
  readonly detail?: string;
}

/** 调用失败时抛这个，带上 HTTP 状态码便于界面区分处理（409 与 400 的含义不同）。 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string | undefined
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
    // 网络层失败（后端没起、被断网）——给出可操作的提示，而不是裸的 TypeError。
    throw new ApiError(
      `无法连接后端服务（${path}）。请确认服务已启动。`,
      0,
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!response.ok) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      /* 响应体不是 JSON，用状态码兜底 */
    }
    throw new ApiError(
      envelope.error ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      envelope.detail
    );
  }

  return (await response.json()) as T;
}

/**
 * 整份结构（"带指定 PageSpec 重跑"的入参）。
 *
 * 与 `structure-input.ts` 的 `parsePageSpecInput` 对齐：只收**块序列与少量留痕**，
 * `projectId` / `goal` / `candidateBlockIds` 由本次运行决定，不从请求体里读。
 *
 * ⚠️ 截至本次改动，后端的 `POST /api/runs` **还没有读取这个字段**
 * （`parsePageSpecInput` 已实现并被 import，但尚未接进路由）。类型先备好，
 * 入口一接上就能用，界面上也据实标注了这一点。
 */
export interface PageSpecInput {
  readonly blocks: readonly {
    readonly id: string;
    readonly type: string;
    readonly slots?: Readonly<Record<string, unknown>> | undefined;
    readonly status?: string | undefined;
    readonly slotPlans?: Readonly<Record<string, string>> | undefined;
  }[];
  readonly templateId?: string | null | undefined;
  readonly qualityScore?: number | null | undefined;
}

/** 提交一次创作的入参。 */
export interface CreateRunInput {
  readonly goal: string;
  /** `'auto'` = 由决策层判定环境类型（F2）。 */
  readonly envType: EnvChoice;
  readonly tone?: string | undefined;
  readonly minArtifacts?: number | undefined;
  readonly provider?: string | undefined;
  /**
   * 是否允许**付费**生成调用（F3）。**默认 false**，即成本闸门关闭状态。
   * 打开才会放行 `requiresPermission` 的工具（如真实生图）。
   */
  readonly allowPaidGeneration?: boolean | undefined;
  /** 带指定结构重跑（后端入口尚未接上，见 `PageSpecInput` 的说明）。 */
  readonly pageSpec?: PageSpecInput | undefined;

  // ── 以下仅 `webpage` 环境（结构化制作）使用 ──────────────────────────
  /** 本次候选 block 类型。省略则用池子全集；给出时**决策模型只在这里面选**。 */
  readonly candidateBlockIds?: readonly string[] | undefined;
  /** 页面 block 数上限。 */
  readonly maxBlocks?: number | undefined;
  /** 站点名。 */
  readonly brand?: string | undefined;
  /** 文案是否走生成层。**默认 false**，零成本。 */
  readonly useGenerative?: boolean | undefined;
  /** 页面上是否标注每块的来源（生成式/确定性/用户）。 */
  readonly annotate?: boolean | undefined;
}

export const MediaSandboxAPI = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>("/api/health");
  },

  tools(envChoice?: EnvChoice): Promise<{ tools: ToolSpec[] }> {
    const query = envChoice !== undefined ? `?envType=${envChoice}` : "";
    return request<{ tools: ToolSpec[] }>(`/api/tools${query}`);
  },

  /** block 池目录：结构化制作的候选集来源。 */
  blocks(
    group?: BlockGroup,
    options: { includeDisabled?: boolean } = {}
  ): Promise<{ blocks: BlockSpec[]; groups: BlockGroupSummary[] }> {
    const params = new URLSearchParams();
    if (group !== undefined) params.set("group", group);
    if (options.includeDisabled === true) params.set("includeDisabled", "1");
    const query = params.toString() === "" ? "" : `?${params.toString()}`;
    return request<{ blocks: BlockSpec[]; groups: BlockGroupSummary[] }>(`/api/blocks${query}`);
  },

  /** 注册一个 block。**提议不等于决定**：入池后仍要由决策模型选中才会用。 */
  createBlock(input: BlockInput): Promise<{ block: { id: string; label: string; group: string }; note: string }> {
    return request<{ block: { id: string; label: string; group: string }; note: string }>("/api/blocks", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  /**
   * 改一个自定义 block。内置的会被后端拒绝（400）。
   *
   * id 不允许改：结构里存的是旧 id，换 id 等于让历史运行引用悬空。
   */
  updateBlock(
    blockId: string,
    input: BlockInput
  ): Promise<{ block: { id: string; label: string; group: string; disabled: boolean }; note: string }> {
    return request<{
      block: { id: string; label: string; group: string; disabled: boolean };
      note: string;
    }>(`/api/blocks/${encodeURIComponent(blockId)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },

  /**
   * 停用或彻底删除一个自定义 block。
   *
   * 默认**停用**：不再参与新页面的候选，但历史结构照样能渲染。
   * `purge` 才是物理删除，且只允许从未被任何运行用过的（否则后端 400）。
   */
  deleteBlock(
    blockId: string,
    options: { purge?: boolean } = {}
  ): Promise<{ block: { id: string; disabled?: boolean; removed?: boolean }; usedByRuns: number; note: string }> {
    const suffix = options.purge === true ? "?purge=1" : "";
    return request<{
      block: { id: string; disabled?: boolean; removed?: boolean };
      usedByRuns: number;
      note: string;
    }>(`/api/blocks/${encodeURIComponent(blockId)}${suffix}`, { method: "DELETE" });
  },

  templates(): Promise<{ templates: TemplateItem[] }> {
    return request<{ templates: TemplateItem[] }>("/api/templates");
  },

  /** 沉淀模板：给 `fromRunId`（从历史提取）或给 `blocks`（手工定义起手结构）。 */
  createTemplate(
    input: TemplateInput
  ): Promise<{ template: { id: string; label: string; builtin: boolean } }> {
    return request<{ template: { id: string; label: string; builtin: boolean } }>("/api/templates", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  /** 删除模板。内置的删不掉（后端返回 409）。 */
  deleteTemplate(templateId: string): Promise<{ templateId: string; deleted: boolean }> {
    return request<{ templateId: string; deleted: boolean }>(
      `/api/templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" }
    );
  },

  createRun(input: CreateRunInput): Promise<{ runId: string; status: string }> {
    return request<{ runId: string; status: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  listRuns(): Promise<{ runs: RunListItem[] }> {
    return request<{ runs: RunListItem[] }>("/api/runs");
  },

  /** 项目维度视图：运行按 `projectId` 分组。 */
  listProjects(): Promise<{ projects: ProjectItem[] }> {
    return request<{ projects: ProjectItem[] }>("/api/projects");
  },

  /**
   * 项目导出 ZIP 的地址。
   *
   * 返回地址而不是直接下载：导出是 GET，交给浏览器原生下载即可。
   */
  exportProjectUrl(projectId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/export`;
  },

  getRun(runId: string): Promise<RunRecord> {
    return request<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
  },

  listArtifacts(runId: string): Promise<{ artifacts: Artifact[] }> {
    return request<{ artifacts: Artifact[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  },

  cancelRun(runId: string): Promise<{ runId: string; cancelled: boolean }> {
    return request<{ runId: string; cancelled: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" }
    );
  },

  // ── 结构：读与改（F5） ────────────────────────────────────────────────

  /**
   * 单独取一份结构。
   *
   * 与 run 详情、WebSocket 推的是**同一个压缩函数**，前端只写一套解析。
   * 非结构化链路（或尚未定稿）会返回 **409**，不是 404 —— 运行本身是存在的。
   */
  structure(runId: string): Promise<{ runId: string; structure: StructureView }> {
    return request<{ runId: string; structure: StructureView }>(
      `/api/runs/${encodeURIComponent(runId)}/structure`
    );
  },

  /**
   * 定点编辑结构并落库。
   *
   * 整批**要么全收要么全拒**；跑动中改会被拒（409），因为运行结束会把结构整体覆盖，
   * 用户刚做的编辑会"看起来生效、随后无声消失"。
   */
  applyStructureOps(
    runId: string,
    ops: readonly StructureOp[]
  ): Promise<{
    runId: string;
    applied: number;
    structure: StructureView;
    fixes: readonly StructureFix[];
  }> {
    return request<{
      runId: string;
      applied: number;
      structure: StructureView;
      fixes: readonly StructureFix[];
    }>(`/api/runs/${encodeURIComponent(runId)}/structure/ops`, {
      method: "POST",
      body: JSON.stringify({ ops })
    });
  },

  // ── 产物 ────────────────────────────────────────────────────────────

  /**
   * 产物下载地址。
   *
   * `name` 只取 `artifacts/` 下的文件名——后端路由是单段参数，
   * 整个 `artifacts/x.md` 传进去会 404。
   */
  artifactUrl(runId: string, artifactPath: string): string {
    const name = artifactPath.split("/").pop() ?? artifactPath;
    return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
  },

  /** 取产物文本内容（预览用）。二进制产物不要走这个。 */
  async artifactText(runId: string, artifactPath: string): Promise<string> {
    const url = MediaSandboxAPI.artifactUrl(runId, artifactPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ApiError(`读取产物失败（HTTP ${response.status}）`, response.status);
    }
    return await response.text();
  }
};

/** 判断产物是否适合当文本预览。 */
export function isTextArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeHint.toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime.includes("json") || mime.includes("javascript") || mime.includes("xml")) return true;
  const ext = artifact.path.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "txt", "html", "htm", "css", "js", "ts", "json", "svg", "csv", "yml", "yaml"].includes(ext);
}

/** 判断产物是否适合当图片预览。 */
export function isImageArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeHint.toLowerCase();
  if (mime.startsWith("image/")) return true;
  const ext = artifact.path.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext);
}

/** 判断产物是否是可直接预览的网页。 */
export function isHtmlArtifact(artifact: Artifact): boolean {
  const ext = artifact.path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return true;
  return artifact.mimeHint.toLowerCase().includes("text/html");
}

/** 人类可读的体积。 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
