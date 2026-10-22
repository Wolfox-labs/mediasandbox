/**
 * MediaSandbox 后端 REST 客户端（Vue 版）。
 *
 * ## 为什么不用模板自带的 `@sa/axios` / 请求层
 *
 * soybean-admin 的请求层内建一套「业务信封」约定：响应必须是
 * `{ code, data, msg }`，`code === '0000'` 才算成功，否则按登出/过期等
 * 业务码做全局处理，还带 token 刷新与登录态回跳。
 *
 * MediaSandbox 的后端**不是那套约定**：它是裸 JSON + 标准 HTTP 状态码
 * （200 成功、400 参数错、409 冲突、410 已回收、429 队满、503 能力缺失）。
 * 硬套信封的话要写一层反解 + 把 HTTP 状态码丢掉，而这层反解恰恰会掩盖
 * 界面最该如实展示的信息（"这次到底是失败了、还是本机能力不支持"）。
 *
 * 所以这里**直接用 fetch**，保持与后端一致：状态码即语义。
 * 模板的 `@sa/*` 包、路由、布局、主题、图标仍然全部照用——只在数据层让路。
 *
 * ## 开发期如何连后端
 *
 * `vite.config.ts` 里把 `/api` 与 `/ws` 反代到 `MEDIASANDBOX_BACKEND`
 * （默认 `http://127.0.0.1:8787`），所以这里写相对路径即可，
 * 生产环境与后端同源时也不用改。
 */
import type {
  Artifact,
  BlockGroup,
  BlockGroupDto,
  BlockSpecDto,
  CreateRunResult,
  EnvType,
  HealthResponse,
  InteractionVerdict,
  ProjectDto,
  QueueSnapshot,
  RunListItem,
  RunRecord,
  ToolSpecDto
} from './types';

/** 后端返回的错误信封（只有出错时才有）。 */
interface ErrorEnvelope {
  readonly error?: string;
  readonly detail?: string;
}

/**
 * 调用失败时抛这个，带上 HTTP 状态码便于界面区分处理。
 *
 * `status === 0` 表示**请求根本没发出去**（后端没起、被断网）。
 * 这个区分很重要：它该被显示成"连不上服务"，而不是"操作失败"。
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly detail?: string | undefined;

  constructor(message: string, status: number, detail?: string | undefined) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
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
 * 结构编辑的最小动作集，与 `packages/server/src/structure-input.ts` 的
 * `parseStructureOps` 对齐。
 *
 * 字段名是 `op` 而不是 `type`（`type` 在 append/insert 里表示**区块类型**），
 * `move` 用 `blockId + toIndex` 定位——按后端来，别自己发明。
 */
export type StructureOpInput =
  | { readonly op: 'remove'; readonly blockId: string }
  | { readonly op: 'move'; readonly blockId: string; readonly toIndex: number }
  | { readonly op: 'append'; readonly type: string }
  | { readonly op: 'insert'; readonly index: number; readonly type: string };

/** 提交一次创作的入参。 */
export interface CreateRunInput {
  readonly goal: string;
  readonly envType: EnvType;
  readonly tone?: string | undefined;
  readonly minArtifacts?: number | undefined;
  readonly provider?: string | undefined;

  // ── 以下仅 webpage 环境（结构化制作）使用 ──────────────────────────
  /** 本次候选 block 类型；省略则用池子全集。 */
  readonly candidateBlockIds?: readonly string[] | undefined;
  /**
   * 起手结构：这几类块**先铺上**（确定性纳入），其余仍由决策模型决定。
   *
   * 与 `candidateBlockIds` 是两件事，可以同时给：那个决定"模型能选哪些"，
   * 这个决定"哪些先用上"。两者都比 `templateId` 更具体，同给时以它们为准。
   */
  readonly seedBlocks?: readonly string[] | undefined;
  /** 选定模板：给了就按它的起手结构来，不给则由决策模型自由决定。 */
  readonly templateId?: string | undefined;
  /** 页面 block 数上限。 */
  readonly maxBlocks?: number | undefined;
  readonly brand?: string | undefined;
  /**
   * 用户自己的图片素材（`POST /api/assets` 返回的 assetId，按顺序）。
   *
   * 按块序号轮转填进图片 slot，来源记为 `user`，优先于生成与搜图。
   * 只对 `webpage` 生效。
   */
  readonly assets?: readonly string[] | undefined;
  /** 文案是否走生成层。**默认 false**，零成本。 */
  readonly useGenerative?: boolean | undefined;
  /** 页面上是否标注每块的来源。 */
  readonly annotate?: boolean | undefined;
  /**
   * 是否在链路里加一个截图节点，产出 `artifacts/screenshot.png`。
   *
   * 后端一直支持这个参数；界面必须显式传出去，否则运行的计划里
   * 根本不会有 `screenshot-page` 节点，产物里自然找不到截图。
   */
  readonly screenshot?: boolean | undefined;
  /**
   * 是否跑一次统筹规划（大模型出的"这页讲哪几段"）。
   *
   * 后端默认开：规划只跑一次、成本固定，而它是"计划与实际结构的偏差"
   * 唯一的来源。不确定时才显式传。
   */
  readonly useBlueprint?: boolean | undefined;

  // ── 定点重做：只重填某次运行里的几块，其余原样保留 ────────────────────
  /** 从哪一次运行读回现成内容。只对 `webpage` 有意义。 */
  readonly redoFrom?: string | undefined;
  /** 要重填的块 id（必须属于 `redoFrom` 那次运行的结构）。 */
  readonly blockIds?: readonly string[] | undefined;
}

/**
 * 新建 / 修改 block 的请求体。
 *
 * 两边共用同一个形状：`PUT` 时后端会额外校验 `id` 与路径一致——**不允许改 id**，
 * 因为结构里存的是旧 id，换了 id 会让历史运行引用不到它。
 */
export interface BlockInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: BlockGroup;
  readonly canLead?: boolean | undefined;
  readonly repeatable?: boolean | undefined;
  readonly costHint?: 'fast' | 'medium' | 'slow' | undefined;
  /**
   * 只在**修改**时有意义：`true` 停用、`false` 重新启用。
   * 后端按请求体重建声明，所以省略它等价于"未停用"（即启用）。
   */
  readonly disabled?: boolean | undefined;
  readonly slots: readonly {
    readonly name: string;
    readonly type: string;
    readonly required?: boolean | undefined;
    readonly description: string;
    readonly countRange?: { readonly min: number; readonly max: number } | undefined;
  }[];
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  tools(envType?: EnvType): Promise<{ tools: ToolSpecDto[] }> {
    const query = envType !== undefined ? `?envType=${envType}` : '';
    return request<{ tools: ToolSpecDto[] }>(`/api/tools${query}`);
  },

  /**
   * block 池目录：结构化制作的候选集来源。
   *
   * **默认不含已停用的**——后端就是这样，要看停用的必须显式传 `includeDisabled`。
   * 元素池管理页必须传 `true`：否则"停用"会变成单向门，停完就再也看不见，
   * 也就无从恢复（这正是改造前 admin 那边的真实缺陷）。
   */
  blocks(
    group?: BlockGroup,
    options: { includeDisabled?: boolean } = {}
  ): Promise<{ blocks: BlockSpecDto[]; groups: BlockGroupDto[] }> {
    const params = new URLSearchParams();
    if (group !== undefined) params.set('group', group);
    if (options.includeDisabled === true) params.set('includeDisabled', '1');
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return request<{ blocks: BlockSpecDto[]; groups: BlockGroupDto[] }>(`/api/blocks${query}`);
  },

  /**
   * 演示文稿版式池。
   *
   * 与 `blocks()` **分开一条端点**：后端就是两个注册表。
   * 合成一条会让界面以为它们是同一批东西，而"网页的候选里冒出章节分隔页"
   * 正是要防的错。
   */
  slideLayouts(): Promise<{ layouts: BlockSpecDto[]; groups: BlockGroupDto[] }> {
    return request<{ layouts: BlockSpecDto[]; groups: BlockGroupDto[] }>('/api/slide-layouts');
  },

  createRun(input: CreateRunInput): Promise<CreateRunResult> {
    return request<CreateRunResult>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  },

  listRuns(): Promise<{ runs: RunListItem[]; queue: QueueSnapshot }> {
    return request<{ runs: RunListItem[]; queue: QueueSnapshot }>('/api/runs');
  },

  /**
   * 注册一个新 block（用户手打 / 导入 / 模型提议）。
   *
   * 走与内置 block **完全相同**的校验：提议不等于决定，能进池子的前提是
   * 它先是一份合法声明。所以这里的失败信息（400）要原样带到界面上。
   */
  createBlock(input: BlockInput): Promise<{ block: { id: string; label: string; group: string }; note?: string }> {
    return request<{ block: { id: string; label: string; group: string }; note?: string }>(
      '/api/blocks',
      { method: 'POST', body: JSON.stringify(input) }
    );
  },

  /**
   * 改一个自定义 block。**内置的会被后端拒绝**（400），界面应据此禁用按钮。
   */
  updateBlock(
    blockId: string,
    input: BlockInput
  ): Promise<{
    block: { id: string; label: string; group: string; disabled: boolean };
    note: string;
  }> {
    return request<{
      block: { id: string; label: string; group: string; disabled: boolean };
      note: string;
    }>(`/api/blocks/${encodeURIComponent(blockId)}`, {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  },

  /**
   * 停用 / 彻底删除一个自定义 block。
   *
   * 默认**停用**：退出候选池，但用过它的历史运行仍能照常渲染。
   * `purge` 才是物理删除，且**只允许从未被任何运行用过**的，否则后端 400
   * 并把"是哪几次运行用过"一起带回来——界面要原样显示那个原因。
   */
  deleteBlock(
    blockId: string,
    options: { purge?: boolean } = {}
  ): Promise<{
    block: { id: string; disabled?: boolean; removed?: boolean };
    usedByRuns: number;
    note: string;
  }> {
    const suffix = options.purge === true ? '?purge=1' : '';
    return request<{
      block: { id: string; disabled?: boolean; removed?: boolean };
      usedByRuns: number;
      note: string;
    }>(`/api/blocks/${encodeURIComponent(blockId)}${suffix}`, { method: 'DELETE' });
  },

  /** 项目维度视图：运行按 `projectId` 分组。 */
  listProjects(): Promise<{ projects: ProjectDto[] }> {
    return request<{ projects: ProjectDto[] }>('/api/projects');
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
      { method: 'POST' }
    );
  },

  /**
   * 对一次已完成的运行做真浏览器交互验证。
   *
   * 失败原因要能被界面区分：404 没有这次运行 / 409 没有可验证的页面 /
   * 410 沙盒已回收 / 503 本机点不了。所以这里**不吞错误**，
   * 由调用方按 `ApiError.status` 决定怎么说。
   */
  verifyInteraction(runId: string): Promise<InteractionVerdict> {
    return request<InteractionVerdict>(
      `/api/runs/${encodeURIComponent(runId)}/verify-interaction`,
      { method: 'POST' }
    );
  },

  // ── 模板池 ──────────────────────────────────────────────────────────
  /** 模板目录：起手可以用哪几套结构。 */
  templates(): Promise<{ templates: TemplateItem[] }> {
    return request<{ templates: TemplateItem[] }>('/api/templates');
  },

  /**
   * 新建模板。两种做法：
   *   - 给 `fromRunId`：把某次已完成运行的结构沉淀下来
   *   - 给 `blocks`：用指定的区块类型人工组一套起手结构
   */
  createTemplate(
    input: { label: string; description?: string; blocks?: readonly { type: string }[]; fromRunId?: string }
  ): Promise<{ template: { id: string; label: string } }> {
    return request<{ template: { id: string; label: string } }>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  },

  // ── 结构干预 ────────────────────────────────────────────────────────
  /**
   * 对已完成运行的结构做增量编辑（增删移）。
   *
   * 走 ops 而不是整份覆盖：前端拿到的是压缩视图（块只有 id/type/status），
   * 覆盖式会把它没看见的内容一并抹掉。
   */
  structureOps(
    runId: string,
    ops: readonly StructureOpInput[]
  ): Promise<{
    applied: number;
    structure: { page: { blocks: readonly { id: string; type: string; status: string }[] } };
    fixes: readonly string[];
  }> {
    return request(`/api/runs/${encodeURIComponent(runId)}/structure/ops`, {
      method: 'POST',
      body: JSON.stringify({ ops })
    });
  },

  /**
   * 产物下载地址。
   *
   * `name` 只取 `artifacts/` 下的文件名——后端路由是单段参数，
   * 整个 `artifacts/x.md` 传进去会 404。
   */
  artifactUrl(runId: string, artifactPath: string): string {
    const name = artifactPath.split('/').pop() ?? artifactPath;
    return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
  },

  /**
   * 单元效果预览地址（网页 block / 演示文稿版式 / 模板）。
   *
   * 后端用**确定性填充 + 渲染**产出静态 HTML：所以看到的是"这块大概长什么样"
   * （示例文案、真实版式），**不调生成层**、不花 token。
   */
  blockPreviewUrl(blockId: string): string {
    return `/api/blocks/${encodeURIComponent(blockId)}/preview`;
  },

  slideLayoutPreviewUrl(layoutId: string): string {
    return `/api/slide-layouts/${encodeURIComponent(layoutId)}/preview`;
  },

  templatePreviewUrl(templateId: string): string {
    return `/api/templates/${encodeURIComponent(templateId)}/preview`;
  },

  /** 取产物文本内容（预览用）。二进制产物不要走这个。 */
  async artifactText(runId: string, artifactPath: string): Promise<string> {
    const url = api.artifactUrl(runId, artifactPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ApiError(`读取产物失败（HTTP ${response.status}）`, response.status);
    }
    return await response.text();
  },

  /**
   * 上传一张用户素材。
   *
   * body 直接是文件字节（不用 FormData）：后端用 `express.raw` 收，
   * 省掉 multipart 解析，也就没有"边界符写错"这一类失败。
   * 返回的 `assetId` 放进 `POST /api/runs` 的 `assets` 里即可。
   */
  async uploadAsset(file: File): Promise<{ assetId: string; mime: string; bytes: number }> {
    const response = await fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file
    });
    const body = (await response.json().catch(() => ({}))) as {
      assetId?: string;
      mime?: string;
      bytes?: number;
      error?: string;
      detail?: string;
    };
    if (!response.ok || body.assetId === undefined) {
      throw new ApiError(body.error ?? `上传失败（HTTP ${response.status}）`, response.status, body.detail);
    }
    return { assetId: body.assetId, mime: body.mime ?? file.type, bytes: body.bytes ?? file.size };
  },

  /** 素材预览地址。 */
  assetUrl(assetId: string): string {
    return `/api/assets/${encodeURIComponent(assetId)}`;
  }
};

/** 判断产物是否适合当文本预览。 */
export function isTextArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeHint.toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('javascript') || mime.includes('xml')) return true;
  const ext = artifact.path.split('.').pop()?.toLowerCase() ?? '';
  return ['md', 'txt', 'html', 'htm', 'css', 'js', 'ts', 'json', 'svg', 'csv', 'yml', 'yaml'].includes(
    ext
  );
}

/** 判断产物是否适合当图片预览。 */
export function isImageArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeHint.toLowerCase();
  if (mime.startsWith('image/')) return true;
  const ext = artifact.path.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext);
}

/** 判断产物是否是可直接预览的网页。 */
export function isHtmlArtifact(artifact: Artifact): boolean {
  const ext = artifact.path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'html' || ext === 'htm') return true;
  return artifact.mimeHint.toLowerCase().includes('text/html');
}

/** 模板池里的一项（`GET /api/templates`）。 */
export interface TemplateItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 内置模板（我们提供的）还是从项目里沉淀的。 */
  readonly builtin: boolean;
  /**
   * `starter`：只给起手块，其余由决策层逐块决定。
   * `page`：整页固定结构，段数/顺序/版式/收尾都写死，模型只写内容。
   */
  readonly kind?: 'starter' | 'page';
  readonly blocks: readonly {
    readonly type: string;
    readonly layout?: string | null;
    readonly counts?: Readonly<Record<string, number>> | null;
  }[];
  readonly allowedBlockIds: readonly string[] | null;
}
