/**
 * 后端 REST 客户端。
 *
 * 开发时经 Vite 代理同源访问（见 vite.config.ts），所以这里用相对路径，
 * 不写死后端地址——换环境只改代理配置。
 */
import type {
  Artifact,
  EnvType,
  HealthResponse,
  ProjectDto,
  RunListItem,
  RunRecord,
  ToolSpecDto,
} from './types.js';

/** 后端返回的错误信封。 */
interface ErrorEnvelope {
  readonly error?: string;
  readonly detail?: string;
}

/** 调用失败时抛这个，带上 HTTP 状态码便于界面区分处理。 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string | undefined,
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
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    // 网络层失败（后端没起、被断网）——给出可操作的提示，而不是裸的 TypeError。
    throw new ApiError(
      `无法连接后端服务（${path}）。请确认服务已启动。`,
      0,
      error instanceof Error ? error.message : String(error),
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
      envelope.detail,
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
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health');
  },

  tools(envType?: EnvType): Promise<{ tools: ToolSpecDto[] }> {
    const query = envType !== undefined ? `?envType=${envType}` : '';
    return request<{ tools: ToolSpecDto[] }>(`/api/tools${query}`);
  },

  createRun(input: CreateRunInput): Promise<{ runId: string; status: string }> {
    return request<{ runId: string; status: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listRuns(): Promise<{ runs: RunListItem[] }> {
    return request<{ runs: RunListItem[] }>('/api/runs');
  },

  /** 项目维度视图：运行按 `projectId` 分组。 */
  listProjects(): Promise<{ projects: ProjectDto[] }> {
    return request<{ projects: ProjectDto[] }>('/api/projects');
  },

  /**
   * 项目导出 ZIP 的地址。
   *
   * 返回地址而不是直接下载：导出是 GET，交给浏览器原生下载即可，
   * 不必先取到内存再构造 Blob 触发下载。
   */
  exportProjectUrl(projectId: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/export`;
  },

  getRun(runId: string): Promise<RunRecord> {
    return request<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
  },

  listArtifacts(runId: string): Promise<{ artifacts: Artifact[] }> {
    return request<{ artifacts: Artifact[] }>(
      `/api/runs/${encodeURIComponent(runId)}/artifacts`,
    );
  },

  cancelRun(runId: string): Promise<{ runId: string; cancelled: boolean }> {
    return request<{ runId: string; cancelled: boolean }>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
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
  },
};

/** 判断产物是否适合当文本预览。 */
export function isTextArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeHint.toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('javascript') || mime.includes('xml')) return true;
  const ext = artifact.path.split('.').pop()?.toLowerCase() ?? '';
  return ['md', 'txt', 'html', 'htm', 'css', 'js', 'ts', 'json', 'svg', 'csv', 'yml', 'yaml'].includes(ext);
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
