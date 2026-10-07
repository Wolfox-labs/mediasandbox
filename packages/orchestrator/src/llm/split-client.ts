/**
 * 把文本生成与图像生成路由到**两个不同的端点**。
 *
 * ## 为什么需要
 *
 * `OpenAiCompatibleClient` 绑定一个 baseUrl + 一个 apiKey。但实际部署里，
 * 文本模型与图像模型常常来自**不同的服务商**（不同的域名、不同的密钥）：
 *
 *   LLM_BASE_URL=https://text-provider.example/v1      （文本）
 *   LLM_IMAGE_BASE_URL=https://image-provider.example/v1（图像）
 *
 * 硬要合成一个客户端，就得在 `OpenAiCompatibleClient` 内部再塞一套
 * "图像专用的 baseUrl / apiKey"，把简单的东西搅浑。
 * 这里改用组合：**一个薄路由器持有两个客户端**，各用各的凭据。
 *
 * ## 边界
 *
 * 它自己不做任何 HTTP。`complete` / `stream` 转发给文本客户端，
 * `generateImage` 转发给图像客户端 —— 后者不存在时**不挂这个方法**，
 * 于是 `render-image` 会走它已有的回落分支（文本补全 + data URL），
 * 行为与"单端点供应商没有图像能力"完全一致。
 */
import type {
  ImageRequest,
  ImageResponse,
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
} from './types.js';

export interface SplitLlmOptions {
  /** 文本生成客户端。必填。 */
  readonly text: LlmClient;
  /** 图像生成客户端。不给则本客户端不具备图像能力。 */
  readonly image?: LlmClient | undefined;
}

/**
 * 双端点生成层。
 *
 * 只有当两个端点确实不同时才需要用它；单一端点直接用一个
 * `OpenAiCompatibleClient` 即可。
 */
export class SplitLlmClient implements LlmClient {
  readonly kind = 'split';
  private readonly text: LlmClient;
  private readonly image: LlmClient | undefined;

  constructor(options: SplitLlmOptions) {
    this.text = options.text;
    this.image = options.image;
    // 图像端点存在时才挂上方法。`render-image` 靠 `generateImage !== undefined`
    // 判断该走端点还是回落，所以"不挂"就是正确的语义表达。
    if (this.image !== undefined && this.image.generateImage !== undefined) {
      this.generateImage = (request: ImageRequest): Promise<ImageResponse> => {
        // 绑定到 image 客户端，避免 this 指向路由器。
        return this.image!.generateImage!(request);
      };
    }
  }

  /** 图像端点可用时才有此方法。 */
  declare generateImage?: (request: ImageRequest) => Promise<ImageResponse>;

  complete(request: LlmRequest): Promise<LlmResponse> {
    return this.text.complete(request);
  }

  stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const text = this.text;
    const stream = text.stream;
    // 文本客户端没实现流式时回落到一次性 complete，与本接口的约定一致。
    if (stream === undefined) {
      return (async function* fallback(): AsyncIterable<LlmStreamChunk> {
        const response = await text.complete(request);
        yield { delta: response.text, done: true, usage: response.usage };
      })();
    }
    return stream.call(text, request);
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const text = await this.text.health();
    if (this.image === undefined) return text;
    const image = await this.image.health();
    // 文本端不可用就算整体不可用；图像端不可用只降级、不算故障 ——
    // 图像的回落路径（文本补全）还能work，只是大概率拿不到图。
    return {
      ok: text.ok,
      detail: `文本：${text.detail}；图像：${image.detail}`,
    };
  }
}
