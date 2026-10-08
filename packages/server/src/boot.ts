/**
 * 启动时把持久化的池子装回来。
 *
 * ## 为什么单独一个模块
 *
 * "重启后还在"这句话有两半：**写下去**（`persist.ts`）与**装回来**（这里）。
 * 只测写不测装，等于只验了一半——而真正会出问题的是装载这一侧：
 * 文件是手改过的、上个版本写的、写到一半被杀掉的，形态都可能不对。
 *
 * 抽出来之后，服务启动与测试走的是**同一条代码路径**，
 * 不会出现"测试里模拟的装入逻辑和 main.ts 里的不一样"。
 *
 * ## 一条坏数据不该让服务起不来
 *
 * 但也不能静默：每条跳过都往日志里写一行，否则"我明明加过这个 block"
 * 会变成一个查不出来的悬案。这两件事必须同时做到。
 */
import {
  createBlockRegistry,
  validateTemplate,
  type BlockRegistry,
  type BlockSpec,
  type TemplateSpec,
} from '@mediasandbox/orchestrator';
import { JsonPersist } from './persist.js';
import { parseBlockSpec } from './block-input.js';

export interface LoadedPools {
  readonly blocks: BlockRegistry;
  /** 从盘上装回来的自定义 block（不含内置）。 */
  readonly externalBlocks: readonly BlockSpec[];
  /** 从盘上装回来的用户模板（不含内置）。 */
  readonly userTemplates: readonly TemplateSpec[];
}

export async function loadPersistedPools(
  persist: JsonPersist,
  log: (message: string) => void = () => undefined,
): Promise<LoadedPools> {
  const externalBlocks: BlockSpec[] = [];
  for (const entry of await persist.loadExternalBlocks()) {
    try {
      externalBlocks.push(parseBlockSpec(entry));
    } catch (error) {
      log(
        `跳过无法解析的自定义 block: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // block 池必须先建：模板的校验要查模板里的块类型是否存在。
  const blocks = createBlockRegistry(externalBlocks);

  const userTemplates: TemplateSpec[] = [];
  for (const entry of await persist.loadTemplates()) {
    const candidate = entry as TemplateSpec;
    if (
      typeof candidate?.id !== 'string' ||
      typeof candidate?.label !== 'string' ||
      !Array.isArray(candidate?.blocks)
    ) {
      log(`跳过形态不对的模板记录: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    const spec: TemplateSpec = { ...candidate, builtin: false };
    try {
      // 与在线注册走**同一套校验**。装回来的时候放水，
      // 等于给"重启之后行为不一样"开了一道门。
      validateTemplate(spec, blocks);
      userTemplates.push(spec);
    } catch (error) {
      log(
        `跳过无法通过校验的模板 ${spec.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { blocks, externalBlocks, userTemplates };
}

/** 默认数据目录下的 `JsonPersist`。测试与脚本用同一套构造参数。 */
export function openPersist(rootDir: string, log?: (message: string) => void): JsonPersist {
  return new JsonPersist({
    rootDir,
    onError: (message, error) => {
      log?.(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}
