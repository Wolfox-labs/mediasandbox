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
import type { BlockRegistry } from '../structured/block-spec.js';
import type { BlockInstance, SlotFillPlan, SlotValue } from '../structured/page-spec.js';
import type { TemplateSpec } from '../structured/template-spec.js';
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

export interface PageWorkflowOptions {
  /** 整页模板：块序、版式、项数都由它定死。 */
  readonly template: TemplateSpec;
  readonly goal: string;
  readonly brand?: string | undefined;
  /** block 池，用来展开每个块的 slot 声明。 */
  readonly blocks: BlockRegistry;
  /** 是否在组装后截图。 */
  readonly screenshot?: boolean | undefined;
}

/**
 * 网页工作流：**整页模板 → 可执行 DAG**。
 *
 * 与自由模式的区别：块序、版式、项数全部来自模板，不再问决策模型。
 * 于是同一份模板每次跑出来的图**结构完全一样**，只有文案与缓存状态会变——
 * 这正是"预设工作流"该有的确定性，也让它在画布上每次都是同一张图。
 *
 * 图片默认走确定性占位而不是搜图/生图：预设不该因为一次点击就产生外部调用。
 * 需要真图时，把某个 fill 节点的 `slotPlans` 改成 `web` 再另存为自定义工作流。
 */
export function pageWorkflow(options: PageWorkflowOptions): WorkflowDef {
  const { template, blocks } = options;

  const instances: BlockInstance[] = template.blocks.map((entry, index) => {
    const spec = blocks.get(entry.type);
    const slots: Record<string, SlotValue> = { ...(entry.slots ?? {}) };
    const slotPlans: Record<string, SlotFillPlan> = {};
    for (const slot of spec.slots) {
      if (slot.type === 'image' || slot.type === 'list-image') {
        // 预设默认**不出网**：图片走确定性占位（内联 SVG），不生图也不搜图。
        // 否则点一次"运行预设"就会产生外部调用与费用，而预设的本意是"稳、可复现"。
        slotPlans[slot.name] = 'deterministic';
        if (slot.type === 'list-image') {
          const count = entry.counts?.[slot.name] ?? slot.countRange?.min ?? 1;
          slots[slot.name] = {
            kind: 'list-image',
            refs: Array.from({ length: count }, () => ({ ref: '', alt: '' })),
          };
        }
        continue;
      }
      if (slot.type !== 'list-text') continue;
      const count = entry.counts?.[slot.name] ?? slot.countRange?.min ?? 1;
      slots[slot.name] = { kind: 'list', items: Array.from({ length: count }, () => '') };
    }
    return {
      id: `b${index + 1}`,
      type: entry.type,
      slots,
      status: 'pending',
      sources: {},
      ...(Object.keys(slotPlans).length > 0 ? { slotPlans } : {}),
      ...(entry.layout !== undefined ? { layout: entry.layout } : {}),
    };
  });

  const pageJson = {
    projectId: 'workflow',
    goal: options.goal,
    templateId: template.id,
    candidateBlockIds: [...new Set(instances.map((block) => block.type))],
    blocks: instances,
    qualityScore: 1,
    createdAt: 0,
  };

  const nodes: WorkflowNodeDef[] = [
    {
      id: 'write',
      toolId: 'write-page-copy',
      inputs: {
        blocksJson: { value: JSON.stringify(instances) },
        goal: { value: options.goal },
        ...(options.brand !== undefined ? { brand: { value: options.brand } } : {}),
      },
      note: '一次执笔整页文案',
      position: { x: 0, y: 0 },
    },
  ];

  const refs: { nodeId: string; port: string }[] = [];
  instances.forEach((block, index) => {
    const id = `fill-${block.id}`;
    nodes.push({
      id,
      toolId: 'fill-block',
      inputs: {
        blockJson: { value: JSON.stringify(block) },
        goal: { value: options.goal },
        ...(options.brand !== undefined ? { brand: { value: options.brand } } : {}),
        index: { value: index },
        useGenerative: { value: true },
        written: { from: 'write', port: 'written' },
      },
      note: `填充 ${block.type}`,
      position: { x: 320, y: index * 120 },
    });
    refs.push({ nodeId: id, port: 'block' });
  });

  nodes.push(
    {
      id: 'assemble',
      toolId: 'assemble-page',
      inputs: {
        pageJson: { value: JSON.stringify(pageJson) },
        blocks: { from: refs },
        title: { value: options.goal },
        annotate: { value: false },
      },
      note: '组装为完整页面',
      position: { x: 640, y: 0 },
    },
    {
      id: 'verify',
      toolId: 'verify-artifact',
      inputs: { minFiles: { value: 1 } },
      // 校验读的是沙盒里的产物，入参没有上游引用，必须显式声明等组装完成。
      dependsOn: ['assemble'],
      note: '校验产物非空',
      position: { x: 960, y: 0 },
    },
  );

  if (options.screenshot === true) {
    nodes.push({
      id: 'screenshot',
      toolId: 'screenshot-page',
      inputs: {
        file: { value: 'artifacts/index.html' },
        // 把组装产出的 HTML 接进来当缓存指纹：页面内容变了，截图必须重截。
        html: { from: 'assemble', port: 'html' },
      },
      dependsOn: ['assemble'],
      note: '把页面截成一张图',
      position: { x: 1280, y: 0 },
    });
  }

  return {
    id: `page-${template.id}`,
    name: `网页：${template.label}`,
    description: `${instances.length} 块的固定结构（模板 ${template.id}）`,
    envType: 'webpage',
    nodes,
  };
}
