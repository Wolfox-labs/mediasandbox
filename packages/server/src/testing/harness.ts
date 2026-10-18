/**
 * 服务端用例的公共脚手架：起一个真实的 HTTP + WebSocket 服务。
 *
 * 抽出来是因为**不止一个**测试文件要起服务（`app.test.ts` 验路由，
 * `concurrency.test.ts` 验并发与排队）。复制一份 `startServer` 到第二个文件里，
 * 两边迟早会长出不同的默认值——那时"测试里模拟的"和"真正跑的"就不是同一条了。
 *
 * 不 mock Express：路由、JSON 解析、状态码这些正是要验的东西。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { LocalSandbox } from '@mediasandbox/sandbox';
import type { SandboxProvider } from '@mediasandbox/sandbox';
import {
  BUILTIN_TOOLS,
  createBlockRegistry,
  createStructuredTools,
  createDeckTools,
  createSlideRegistry,
  createTemplateRegistry,
  DEFAULT_POLICY,
  StubDecisionClient,
  ToolRegistry,
  type BlockRegistry,
  type ClickDriver,
  type MockLlmClient,
  type TemplateRegistry,
} from '@mediasandbox/orchestrator';
import { createServer } from '../app.js';
import { JsonPersist } from '../persist.js';
import type { LoadedPools } from '../boot.js';
import { loadPersistedPools } from '../boot.js';

const rootDir = path.join(os.tmpdir(), `mediasandbox-server-test-${process.pid}`);
const localSandbox = new LocalSandbox({ rootDir });

/** 每个用例用独立的决策桩，避免预设互相干扰。 */
export function makeDecision(): StubDecisionClient {
  return new StubDecisionClient()
    .onChoice('primary_tool', 'template-copy')
    .onChoice('finalize', 'write-file')
    .onNoul('needs_verify', true);
}

export const FAST_POLICY = { ...DEFAULT_POLICY, backoffBaseMs: 0, backoffCapMs: 0 };

export async function startServer(
  overrides: {
    decision?: StubDecisionClient;
    llm?: MockLlmClient;
    /** 用空注册表，制造不可恢复的计划级失败。 */
    emptyRegistry?: boolean;
    /** 沙盒保留额度。不传则用 createServer 的默认值。 */
    maxRuns?: number;
    /** 装配结构化链路：block 池 + 模板池 + 两个结构化工具。 */
    structured?: boolean;
    /** 落盘目录。给了就启用持久化，并从这里读回历史运行记录。 */
    dataDir?: string;
    /** 预先装好的池子（模拟重启时的装载结果）。省略则用内置池。 */
    pools?: LoadedPools;
    /** 交付物落定目录。给了之后产物不随沙盒回收消失。 */
    projectsDir?: string;
    /** 落定产物清理额度。省略 = 默认不清理（一个都不删）。 */
    projectsRetention?: { maxRunsPerProject?: number };
    /** 覆盖沙盒 provider（"重启后接管沙盒"这类用例要指定自己的工作区根目录）。 */
    providers?: Record<string, SandboxProvider>;
    /** 收集服务端日志，用于断言"接管沙盒"这类只留日志的动作。 */
    onLog?: (message: string) => void;
    /** 并发上限与队列长度。不传则用 createServer 的默认值（2 / 16）。 */
    concurrency?: { maxConcurrentRuns?: number; queueLimit?: number };
    /** 交互验证的点击驱动。不传即"这台机器点不了"，端点会如实回 503。 */
    clickDriver?: ClickDriver;
  } = {},
): Promise<{
  origin: string;
  close: () => Promise<void>;
  store: ReturnType<typeof createServer>['store'];
  blocks: BlockRegistry;
  templates: TemplateRegistry;
  waitForIdle: () => Promise<void>;
  flushPersist: () => Promise<void>;
  wsUrl: string;
}> {
  const registry = new ToolRegistry();
  if (overrides.emptyRegistry !== true) {
    registry.registerAll(BUILTIN_TOOLS);
  }

  const persist =
    overrides.dataDir !== undefined ? new JsonPersist({ rootDir: overrides.dataDir }) : undefined;

  /*
   * 与 main.ts 同一条启动顺序：**先把落盘的池子装回来，再建服务、装工具**。
   *
   * 这一步是关键：`loadPersistedPools()` 会走 `parseBlockSpec` 与模板校验，
   * 于是"重启后还在"这条性质在测试里与线上走的是**同一条装载代码路径**。
   * 此前脚手架跳过了它，测试里"重启"出来的服务永远只有内置池——
   * 既会让"改动落盘了没有"这类用例假失败，也会掩盖真正的装载问题。
   */
  const loadedPools =
    persist !== undefined
      ? await loadPersistedPools(persist, (message) => overrides.onLog?.(message))
      : undefined;

  // block 池与工具必须成对出现：工具装在哪个池子上，规划器就得用哪个池子。
  const blocks =
    overrides.pools?.blocks ??
    loadedPools?.blocks ??
    (overrides.structured === true || overrides.dataDir !== undefined
      ? createBlockRegistry()
      : undefined);
  if (blocks !== undefined) {
    registry.registerAll(createStructuredTools(blocks));
  }
  // 演示文稿链路。`structured: true` 同时装两条结构化链路：
  // 它们各自声明 envTypes，混装在一个注册表里不会互相串。
  const slideLayouts =
    overrides.structured === true || blocks !== undefined ? createSlideRegistry() : undefined;
  if (slideLayouts !== undefined) {
    registry.registerAll(createDeckTools(slideLayouts));
  }
  const templates =
    blocks !== undefined
      ? createTemplateRegistry(blocks, [
          ...(overrides.pools?.userTemplates ?? loadedPools?.userTemplates ?? []),
        ])
      : undefined;

  const instance = createServer({
    registry,
    ...(blocks !== undefined ? { blocks } : {}),
    ...(slideLayouts !== undefined ? { slideLayouts } : {}),
    ...(templates !== undefined ? { templates } : {}),
    ...(persist !== undefined ? { persist } : {}),
    ...(overrides.projectsDir !== undefined ? { projectsDir: overrides.projectsDir } : {}),
    ...(overrides.projectsRetention !== undefined
      ? { projectsRetention: overrides.projectsRetention }
      : {}),
    decision: overrides.decision ?? makeDecision(),
    ...(overrides.llm !== undefined ? { llm: overrides.llm } : {}),
    ...(overrides.clickDriver !== undefined ? { clickDriver: overrides.clickDriver } : {}),
    ...(overrides.onLog !== undefined ? { onLog: overrides.onLog } : {}),
    providers: overrides.providers ?? { local: localSandbox },
    defaultProvider: 'local',
    policy: FAST_POLICY,
    ...(overrides.maxRuns !== undefined
      ? { sandboxRetention: { maxRuns: overrides.maxRuns } }
      : {}),
    ...(overrides.concurrency !== undefined ? { concurrency: overrides.concurrency } : {}),
  });

  const server: Server = http.createServer(instance.app);
  instance.attachWebSocket(server);

  // 与 main.ts 一样：**listen 之前**把历史运行记录装回来。
  await instance.loadPersisted();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法获取监听端口');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    store: instance.store,
    blocks: blocks ?? createBlockRegistry(),
    templates: templates ?? createTemplateRegistry(createBlockRegistry()),
    waitForIdle: () => instance.waitForIdle(),
    flushPersist: () => instance.flushPersist(),
    close: async () => {
      await instance.waitForIdle();
      await instance.flushPersist();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
