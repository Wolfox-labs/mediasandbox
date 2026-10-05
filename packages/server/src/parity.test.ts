import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import Docker from 'dockerode';
import {
  DockerSandbox,
  IMAGE_BY_ENV,
  LocalSandbox,
  type DockerApi,
  type SandboxProvider,
} from '@mediasandbox/sandbox';
import {
  BUILTIN_TOOLS,
  DEFAULT_POLICY,
  Orchestrator,
  StubDecisionClient,
  ToolRegistry,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '@mediasandbox/orchestrator';

/**
 * 双 provider 一致性：同一个目标、同样的决策答案，在 Local 与 Docker 上
 * 必须产出**内容相同**的交付物。
 *
 * 这是 M5 的核心验收标准——沙盒抽象成立与否，就看这一点。
 *
 * 生成层用固定输出的桩：真实的 LLM 每次输出都不同，那样就分不清差异
 * 是来自 provider 还是来自模型。这里要验的是**沙盒行为一致**，不是模型一致。
 */

const rootDir = path.join(os.tmpdir(), `mediasandbox-parity-${process.pid}`);

/** 固定输出的生成层，保证两个 provider 拿到完全相同的文本。 */
class FixedLlmClient implements LlmClient {
  readonly kind = 'fixed';
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  async complete(_request: LlmRequest): Promise<LlmResponse> {
    return {
      text: this.text,
      model: 'fixed',
      usage: { inputTokens: 0, outputTokens: this.text.length },
      finishReason: 'stop',
      latencyMs: 0,
      raw: {},
    };
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'fixed' };
  }
}

const FIXED_TEXT = '固定的文案内容，两个 provider 应当得到逐字节相同的结果。';

const DECISION = () =>
  new StubDecisionClient()
    .onChoice('primary_tool', 'draft-copy')
    .onNoul('needs_refine', false)
    .onChoice('finalize', 'write-file')
    .onNoul('needs_verify', true);

const FAST_POLICY = { ...DEFAULT_POLICY, backoffBaseMs: 0, backoffCapMs: 0 };

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function dockerReady(): Promise<{ ok: boolean; detail: string }> {
  try {
    const docker = new Docker();
    await docker.listContainers({ all: false });
    for (const image of Object.values(IMAGE_BY_ENV)) {
      try {
        await docker.getImage(image).inspect();
      } catch {
        return { ok: false, detail: `镜像未构建: ${image}` };
      }
    }
    return { ok: true, detail: 'Docker 可用且镜像齐备' };
  } catch (error) {
    return { ok: false, detail: `Docker 不可用: ${String(error)}` };
  }
}

const dockerStatus = await dockerReady();

describe('双 provider 产物一致性', () => {
  const local = new LocalSandbox({ rootDir: path.join(rootDir, 'local') });
  let docker: DockerSandbox | undefined;

  before(() => {
    if (dockerStatus.ok) {
      // dockerode 的方法签名比我们声明的 DockerApi 更宽，结构上兼容；
      // 断言一次即可，不必给每个方法补类型。
      const api = new Docker() as unknown as DockerApi;
      docker = new DockerSandbox({ docker: api, rootDir: path.join(rootDir, 'docker') });
    }
  });

  after(async () => {
    // 两个 provider 都清掉各自的临时目录。
  });

  /** 在指定 provider 上跑一次，返回产物内容哈希。 */
  async function runOnce(
    provider: SandboxProvider,
    providerLabel: string,
  ): Promise<{ status: string; hashes: Map<string, string>; artifactPaths: string[] }> {
    const result = await new Orchestrator().run(
      {
        projectId: `parity${process.pid}${providerLabel}`,
        goal: '写一段产品介绍',
        envType: 'copy',
        minArtifacts: 1,
      },
      {
        registry: new ToolRegistry().registerAll(BUILTIN_TOOLS),
        decision: DECISION(),
        sandbox: provider,
        llm: new FixedLlmClient(FIXED_TEXT),
        policy: FAST_POLICY,
      },
    );

    const hashes = new Map<string, string>();
    for (const artifact of result.execution?.artifacts ?? []) {
      const bytes = await provider.readFile(result.handle, artifact.path);
      hashes.set(artifact.path, sha256(bytes));
    }

    // 读完后销毁，避免残留容器与目录。
    await provider.destroy(result.handle);

    return {
      status: result.status,
      hashes,
      artifactPaths: [...hashes.keys()].sort(),
    };
  }

  it('Local 与 Docker 产出内容完全相同', async (t) => {
    if (docker === undefined) {
      t.skip(dockerStatus.detail);
      return;
    }

    const localRun = await runOnce(local, 'L');
    const dockerRun = await runOnce(docker, 'D');

    assert.equal(localRun.status, 'succeeded', '本地应成功');
    assert.equal(dockerRun.status, 'succeeded', '容器应成功');

    // 产物路径集合一致。
    assert.deepEqual(
      dockerRun.artifactPaths,
      localRun.artifactPaths,
      '两个 provider 的产物路径应一致',
    );
    assert.ok(localRun.artifactPaths.length > 0, '应至少有一个产物');

    // 每个产物的内容哈希一致——这是"逐字节相同"的强断言。
    for (const [artifactPath, hash] of localRun.hashes) {
      assert.equal(
        dockerRun.hashes.get(artifactPath),
        hash,
        `产物 ${artifactPath} 的内容在两个 provider 上应逐字节相同`,
      );
    }
  });

  it('两个 provider 得到相同的计划结构', async (t) => {
    if (docker === undefined) {
      t.skip(dockerStatus.detail);
      return;
    }

    const runWith = async (provider: SandboxProvider, label: string) => {
      const result = await new Orchestrator().run(
        {
          projectId: `planparity${process.pid}${label}`,
          goal: '写一段介绍',
          envType: 'copy',
        },
        {
          registry: new ToolRegistry().registerAll(BUILTIN_TOOLS),
          decision: DECISION(),
          sandbox: provider,
          llm: new FixedLlmClient(FIXED_TEXT),
          policy: FAST_POLICY,
        },
      );
      const shape = result.plan?.nodes.map((n) => ({ toolId: n.toolId, deps: n.dependsOn }));
      await provider.destroy(result.handle);
      return shape;
    };

    const localShape = await runWith(local, 'PL');
    const dockerShape = await runWith(docker, 'PD');
    assert.deepEqual(dockerShape, localShape, '计划结构应与 provider 无关');
  });

  it('确定性工具在两个 provider 上都不调用生成层', async (t) => {
    if (docker === undefined) {
      t.skip(dockerStatus.detail);
      return;
    }

    let calls = 0;
    const countingLlm: LlmClient = {
      kind: 'counting',
      async complete(): Promise<LlmResponse> {
        calls += 1;
        return {
          text: 'should not be used',
          model: 'counting',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'stop',
          latencyMs: 0,
          raw: {},
        };
      },
      async health() {
        return { ok: true, detail: 'counting' };
      },
    };

    const decision = new StubDecisionClient()
      .onChoice('primary_tool', 'template-copy')
      .onChoice('finalize', 'write-file')
      .onNoul('needs_verify', false);

    for (const provider of [local, docker] as SandboxProvider[]) {
      const result = await new Orchestrator().run(
        {
          projectId: `nocall${process.pid}${provider.kind}`,
          goal: '模板路线',
          envType: 'copy',
        },
        {
          registry: new ToolRegistry().registerAll(BUILTIN_TOOLS),
          decision,
          sandbox: provider,
          llm: countingLlm,
          policy: FAST_POLICY,
        },
      );
      assert.equal(result.status, 'succeeded', `${provider.kind} 应成功`);
      await provider.destroy(result.handle);
    }

    assert.equal(calls, 0, '模板工具在任何 provider 上都不该调用生成层');
  });
});
