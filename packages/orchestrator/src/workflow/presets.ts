/**
 * 内置工作流预设。
 *
 * 预设不是"另一条代码路径"，而是一份**普通的工作流定义**：
 * 与用户在工作流编辑器里拼出来的东西结构完全一样，只是它被随代码一起发布。
 * 这样"改预设"与"改自己的工作流"用的是同一个校验器、同一个执行器、同一份缓存。
 *
 * 目前唯一的预设是海报：它的版式与节点数都是固定的，最适合当工作流的样板。
 * 网页/演示文稿的结构在运行期由决策模型逐块决定，节点数不固定，
 * 不能写成静态定义——它们走的是"动态组装"（`assembleStructured`）。
 */
import { POSTER_SIZES, resolvePosterSize } from '../structured/poster.js';
import type { WorkflowDef, WorkflowNodeDef } from './types.js';

export interface PosterWorkflowOptions {
  /** 海报要表达的目标。写进 brief 节点的字面量。 */
  readonly goal: string;
  /** 主办方/品牌。 */
  readonly brand?: string | undefined;
  /** 语气要求。 */
  readonly tone?: string | undefined;
  /** 要导出的尺寸 id；省略就是四个全出。 */
  readonly sizeIds?: readonly string[] | undefined;
}

/**
 * 海报工作流：一次执笔，四个尺寸各排版一次、导出一次。
 *
 * ```
 * brief ─┬─ render-story  ─ export-story
 *        ├─ render-square ─ export-square
 *        ├─ render-banner ─ export-banner
 *        └─ render-a4     ─ export-a4
 * ```
 *
 * 四个分支互不依赖，执行器会并发跑；每个分支的 export 只依赖自己的 render。
 */
export function posterWorkflow(options: PosterWorkflowOptions): WorkflowDef {
  const sizes = (options.sizeIds ?? POSTER_SIZES.map((size) => size.id)).map((id) =>
    resolvePosterSize(id),
  );

  const nodes: WorkflowNodeDef[] = [
    {
      id: 'brief',
      toolId: 'poster-brief',
      inputs: {
        goal: { value: options.goal },
        ...(options.tone !== undefined && options.tone !== '' ? { tone: { value: options.tone } } : {}),
        ...(options.brand !== undefined && options.brand !== '' ? { brand: { value: options.brand } } : {}),
      },
      note: '写海报文案',
      position: { x: 0, y: 0 },
    },
  ];

  sizes.forEach((size, index) => {
    const renderId = `render-${size.id}`;
    const exportId = `export-${size.id}`;
    nodes.push(
      {
        id: renderId,
        toolId: 'poster-render',
        inputs: {
          brief: { from: 'brief', port: 'brief' },
          sizeId: { value: size.id },
        },
        note: `排版 ${size.label}`,
        position: { x: 320, y: index * 140 },
      },
      {
        id: exportId,
        toolId: 'poster-export',
        inputs: {
          file: { from: renderId, port: 'file' },
          sizeId: { value: size.id },
        },
        note: `导出 ${size.label}`,
        position: { x: 640, y: index * 140 },
      },
    );
  });

  return {
    id: 'poster',
    name: '海报（多尺寸）',
    description: `${sizes.length} 个尺寸：${sizes.map((size) => size.label).join('、')}`,
    envType: 'image',
    nodes,
  };
}
