/**
 * block 候选池面板。
 *
 * ## 它对应设计里的哪一步
 *
 * 设计稿的链路是：
 *
 * ```
 * ① 生成前  block 候选池（分组）→ 用户选取 → 本次候选集
 * ```
 *
 * 这个组件就是那一步的界面。**它不是一个装饰性的列表**——
 * 选中的集合会随请求提交给后端，而决策模型只在这个集合里逐块选择。
 * 换句话说：这里的勾选**直接决定**决策模型能选出什么结构。
 *
 * ## 为什么按分组展示
 *
 * 三类分组的用途不同（骨架决定版式、内容决定信息形态、交互是验证对象），
 * 平铺成 15 个复选框会让这层含义消失。分组标题带数量，一眼看得出池子里有什么。
 *
 * ## 为什么标出 `canLead` 与 `repeatable`
 *
 * 这两条**约束了决策模型的候选**：不能当首块的在第一轮不会出现，不可重复的
 * 用过一次就不再出现。把它们显示出来，用户在勾选时就知道哪些组合是可行的——
 * 否则会出现"勾了 footer，结果它不能开头"的困惑。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client.js';
import type { BlockGroup, BlockSpecDto, SlotType } from '../../api/types.js';
import { Chip, Spinner } from '../../ui/components.js';

/** slot 类型的中文说法与"由谁填"。 */
const SLOT_TYPE_LABELS: Readonly<Record<SlotType, { label: string; filler: string }>> = {
  text: { label: '文本', filler: '生成层' },
  title: { label: '标题', filler: '生成层' },
  image: { label: '图片', filler: '生图端点' },
  code: { label: '源码', filler: '生成层' },
  link: { label: '链接', filler: '确定性' },
  literal: { label: '常量', filler: '确定性' },
  'list-text': { label: '文本列表', filler: '生成层' },
  'list-image': { label: '图集', filler: '生图端点' },
};

const GROUP_ORDER: readonly BlockGroup[] = ['skeleton', 'content', 'interactive'];

export interface BlockPoolPanelProps {
  /** 当前选中的 block id 集合。 */
  readonly selected: readonly string[];
  readonly onSelectionChange: (next: readonly string[]) => void;
  /** 页面 block 数上限。 */
  readonly maxBlocks: number;
  readonly onMaxBlocksChange: (next: number) => void;
  /** 文案是否走生成层。 */
  readonly useGenerative: boolean;
  readonly onUseGenerativeChange: (next: boolean) => void;
  /** 页面上是否标注每块的来源（生成式/确定性/用户）。排查用。 */
  readonly annotate: boolean;
  readonly onAnnotateChange: (next: boolean) => void;
}

export function BlockPoolPanel(props: BlockPoolPanelProps): ReactNode {
  const [blocks, setBlocks] = useState<readonly BlockSpecDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .blocks()
      .then((r) => {
        if (cancelled) return;
        setBlocks(r.blocks);
        // 首次加载时**默认全选**：让用户不改任何东西就能直接开跑，
        // 而不是先面对一堆没勾的框不知道该怎么办。
        if (props.selected.length === 0) {
          props.onSelectionChange(r.blocks.map((b) => b.id));
        }
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 只在挂载时加载一次；props.selected 的变化不该触发重新拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string): void => {
    const next = props.selected.includes(id)
      ? props.selected.filter((x) => x !== id)
      : [...props.selected, id];
    props.onSelectionChange(next);
  };

  const setGroup = (group: BlockGroup, on: boolean): void => {
    const ids = blocks.filter((b) => b.group === group).map((b) => b.id);
    const rest = props.selected.filter((x) => !ids.includes(x));
    props.onSelectionChange(on ? [...rest, ...ids] : rest);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-slate-400">
        <Spinner /> 加载 block 池…
      </div>
    );
  }
  if (error !== null) {
    return (
      <p className="m-3 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-200">
        读取 block 池失败：{error}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3">
      <p className="text-[11px] leading-relaxed text-slate-500">
        勾选的 block 构成本次<strong className="text-slate-400">候选集</strong>。
        决策模型逐块决定结构时<strong className="text-slate-400">只在这个集合里选</strong>——
        池子越大，可选的结构越丰富。
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => props.onSelectionChange(blocks.map((b) => b.id))}
          className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-ink-700"
        >
          全选
        </button>
        <button
          type="button"
          onClick={() => props.onSelectionChange([])}
          className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-ink-700"
        >
          清空
        </button>
        <span className="ml-auto font-mono text-[11px] text-slate-500">
          {props.selected.length}/{blocks.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
        {GROUP_ORDER.map((group) => {
          const items = blocks.filter((b) => b.group === group);
          if (items.length === 0) return null;
          const selectedCount = items.filter((b) => props.selected.includes(b.id)).length;
          const allOn = selectedCount === items.length;
          return (
            <div key={group} className="rounded border border-ink-600">
              <div className="flex items-center gap-2 border-b border-ink-600 bg-ink-700/40 px-2 py-1">
                <span className="text-xs font-medium text-slate-300">
                  {items[0]?.groupLabel ?? group}
                </span>
                <span className="font-mono text-[11px] text-slate-500">
                  {selectedCount}/{items.length}
                </span>
                <button
                  type="button"
                  onClick={() => setGroup(group, !allOn)}
                  className="ml-auto text-[11px] text-slate-500 hover:text-slate-300"
                >
                  {allOn ? '取消本组' : '全选本组'}
                </button>
              </div>
              <ul className="divide-y divide-ink-700/60">
                {items.map((block) => {
                  const on = props.selected.includes(block.id);
                  const open = expanded === block.id;
                  return (
                    <li key={block.id}>
                      <div className="flex items-start gap-2 px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(block.id)}
                          className="mt-0.5 accent-[color:var(--accent)]"
                          aria-label={`选用 ${block.label}`}
                        />
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? undefined : block.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`text-xs ${on ? 'text-slate-200' : 'text-slate-500'}`}>
                              {block.label}
                            </span>
                            <span className="font-mono text-[10px] text-slate-600">{block.id}</span>
                            {block.canLead && (
                              <span className="chip bg-sky-500/15 text-[10px] text-sky-300">
                                可作首块
                              </span>
                            )}
                            {!block.repeatable && (
                              <span className="chip bg-violet-500/15 text-[10px] text-violet-300">
                                仅一次
                              </span>
                            )}
                            {block.costHint === 'slow' && (
                              <span className="chip bg-amber-500/15 text-[10px] text-amber-300">
                                慢
                              </span>
                            )}
                          </div>
                          {open && (
                            <div className="mt-1.5 space-y-1">
                              <p className="text-[11px] text-slate-500">{block.description}</p>
                              <div className="flex flex-wrap gap-1">
                                {block.slots.map((slot) => (
                                  <Chip key={slot.name} className="text-[10px]">
                                    {slot.name}
                                    <span className="text-slate-500">
                                      ：{SLOT_TYPE_LABELS[slot.type].label}
                                    </span>
                                    <span className="ml-1 text-slate-600">
                                      ← {SLOT_TYPE_LABELS[slot.type].filler}
                                    </span>
                                  </Chip>
                                ))}
                              </div>
                            </div>
                          )}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 border-t border-ink-600 pt-2">
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="shrink-0">最多几块</span>
          <input
            type="range"
            min={1}
            max={12}
            value={props.maxBlocks}
            onChange={(e) => props.onMaxBlocksChange(Number(e.target.value))}
            className="flex-1 accent-[color:var(--accent)]"
          />
          <span className="w-6 shrink-0 text-right font-mono text-slate-300">
            {props.maxBlocks}
          </span>
        </label>

        <label className="flex items-start gap-2 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={props.useGenerative}
            onChange={(e) => props.onUseGenerativeChange(e.target.checked)}
            className="mt-0.5 accent-[color:var(--accent)]"
          />
          <span>
            文案走生成层
            <span className="block text-slate-600">
              关闭时全部确定性填充——<strong>零成本、可复现</strong>，界面与链路完全一致
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={props.annotate}
            onChange={(e) => props.onAnnotateChange(e.target.checked)}
            className="mt-0.5 accent-[color:var(--accent)]"
          />
          <span>
            在页面上标注来源
            <span className="block text-slate-600">
              每块显示 id、状态与各 slot 的填充来源，便于核对与排查
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
