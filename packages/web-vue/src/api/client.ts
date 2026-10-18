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
  /** 页面 block 数上限。 */
  readonly maxBlocks?: number | undefined;
  readonly brand?: string | undefined;
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
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  tools(envType?: EnvType): Promise<{ tools: ToolSpecDto[] }> {
    const query = envType !== undefined ? `?envType=${envType}` : '';
    return request<{ tools: ToolSpecDto[] }>(`/api/tools${query}`);
  },

  /** block 池目录：结构化制作的候选集来源。 */
  blocks(group?: BlockGroup): Promise<{ blocks: BlockSpecDto[]; groups: BlockGroupDto[] }> {
    const query = group !== undefined ? `?group=${group}` : '';
    return request<{ blocks: BlockSpecDto[]; groups: BlockGroupDto[] }>(`/api/blocks${query}`);
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

  /** 取产物文本内容（预览用）。二进制产物不要走这个。 */
  async artifactText(runId: string, artifactPath: string): Promise<string> {
    const url = api.artifactUrl(runId, artifactPath);
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
