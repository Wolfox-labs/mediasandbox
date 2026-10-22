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
  /** 用图像模型画主视觉（默认开）。一张图复用给所有尺寸。 */
  readonly visual?: boolean | undefined;
  /** 追加的主视觉风格要求。 */
  readonly style?: string | undefined;
  /** 是否搜一张实景图当背景（只搜图、不生图）。给了 visual 时忽略。 */
  readonly background?: boolean | undefined;
  /** 叠在图上的品牌落款。 */
  readonly logo?: string | undefined;
}

/**
 * 海报工作流：一次执笔，一张主视觉，四个尺寸各排版一次、导出一次。
 *
 * ```
 * brief ─┬─ visual ─┬─ render-story  ─ export-story
 *        │          ├─ render-square ─ export-square
 *        │          ├─ render-banner ─ export-banner
 *        │          └─ render-a4     ─ export-a4
 *        └──────────────┘   （no-visual 时 render 直接吃 brief）
 * ```
 *
 * 四个分支互不依赖，执行器会并发跑；每个分支的 export 只依赖自己的 render。
 * 主视觉只画一张、四个尺寸共用：多画三张要多花三份钱，而裁切已经能覆盖四种比例。
 */
export function posterWorkflow(options: PosterWorkflowOptions): WorkflowDef {
  const sizes = (options.sizeIds ?? POSTER_SIZES.map((size) => size.id)).map((id) =>
    resolvePosterSize(id),
  );
  const useVisual = options.visual === true;
  // 搜图只在明确要"实景照片"、且没有开生图时用。
  const useBackground = !useVisual && options.background === true;
  // 全部尺寸都是横的才按横构图取景；混合尺寸（默认四种）按竖版。
  const allWide = sizes.length > 0 && sizes.every((size) => size.width > size.height);

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

  if (useVisual) {
    nodes.push({
      id: 'visual',
      toolId: 'poster-visual',
      inputs: {
        brief: { from: 'brief', port: 'brief' },
        goal: { value: options.goal },
        aspect: { value: allWide ? 'wide' : 'tall' },
        ...(options.style !== undefined && options.style !== '' ? { style: { value: options.style } } : {}),
      },
      note: '画一张主视觉',
      position: { x: 320, y: 0 },
    });
  }

  if (useBackground) {
    nodes.push({
      id: 'background',
      toolId: 'poster-background',
      inputs: {
        goal: { value: options.goal },
        source: { value: 'web' },
      },
      note: '找一张背景图',
      position: { x: 320, y: 0 },
    });
  }

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
          ...(useVisual ? { background: { from: 'visual', port: 'image' } } : {}),
          ...(useBackground ? { background: { from: 'background', port: 'image' } } : {}),
          ...(options.logo !== undefined && options.logo !== '' ? { logo: { value: options.logo } } : {}),
        },
        note: `排版 ${size.label}`,
        position: { x: 640, y: index * 140 },
      },
      {
        id: exportId,
        toolId: 'poster-export',
        inputs: {
          file: { from: renderId, port: 'file' },
          sizeId: { value: size.id },
          html: { from: renderId, port: 'html' },
        },
        note: `导出 ${size.label}`,
        position: { x: 960, y: index * 140 },
      },
    );
  });

  return {
    id: 'poster',
    name: '海报（多尺寸）',
    description: `${sizes.length} 个尺寸：${sizes.map((size) => size.label).join('、')}${useVisual ? '（含 AI 主视觉）' : ''}`,
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

export interface DeckWorkflowOptions {
  readonly goal: string;
  /** 版式序列，例如 ['cover','bullets','bullets','closing']。 */
  readonly layouts?: readonly string[] | undefined;
  readonly brand?: string | undefined;
  readonly screenshot?: boolean | undefined;
}

/** 没有指定时用一套最朴素的页序：封面 → 两页要点 → 收尾。 */
const DEFAULT_DECK_LAYOUTS = ['cover', 'bullets', 'bullets', 'closing'] as const;

/**
 * 演示文稿工作流：**版式序列 → 可执行 DAG**。
 *
 * 与网页预设同一条思路：页序与版式来自参数而不是决策模型，于是每次跑出来的
 * 骨架完全一致。幻灯片与网页的区别只在工具与产物（deck.html / deck.json）。
 */
export function deckWorkflow(options: DeckWorkflowOptions): WorkflowDef {
  const layouts = options.layouts !== undefined && options.layouts.length > 0
    ? options.layouts
    : [...DEFAULT_DECK_LAYOUTS];

  const slides: BlockInstance[] = layouts.map((layout, index) => ({
    id: `b${index + 1}`,
    type: layout,
    slots: {},
    status: 'pending',
    sources: {},
  }));

  const skeleton = {
    projectId: 'workflow',
    goal: options.goal,
    candidateBlockIds: [...new Set(layouts)],
    blocks: slides,
    qualityScore: 1,
    createdAt: 0,
  };

  const nodes: WorkflowNodeDef[] = [];
  const refs: { nodeId: string; port: string }[] = [];
  slides.forEach((slide, index) => {
    const id = `fill-${slide.id}`;
    nodes.push({
      id,
      toolId: 'fill-slide',
      inputs: {
        slideJson: { value: JSON.stringify(slide) },
        goal: { value: options.goal },
        ...(options.brand !== undefined ? { brand: { value: options.brand } } : {}),
        index: { value: index },
        useGenerative: { value: true },
      },
      note: `填充第 ${index + 1} 页（${slide.type}）`,
      position: { x: 0, y: index * 120 },
    });
    refs.push({ nodeId: id, port: 'slide' });
  });

  nodes.push(
    {
      id: 'assemble',
      toolId: 'assemble-deck',
      inputs: {
        deckJson: { value: JSON.stringify(skeleton) },
        slides: { from: refs },
        title: { value: options.goal },
        composition: { value: 'ranked' },
      },
      note: '组装为完整文稿',
      position: { x: 320, y: 0 },
    },
  );

  if (options.screenshot === true) {
    nodes.push({
      id: 'screenshot',
      toolId: 'screenshot-deck',
      inputs: {
        file: { value: 'artifacts/deck.html' },
        html: { from: 'assemble', port: 'html' },
      },
      dependsOn: ['assemble'],
      note: '把首页截成一张图',
      position: { x: 960, y: 0 },
    });
  }

  return {
    id: 'deck',
    name: '演示文稿（版式序列）',
    description: `${slides.length} 页：${layouts.join(' → ')}`,
    envType: 'slides',
    nodes,
  };
}
