/**
 * 画布自动排布：按依赖深度分列，同列按声明顺序分行。
 *
 * 为什么不用力导向：工作流是**有向无环**的，深度就是天然的"从左到右"，
 * 力导向反而会让"谁依赖谁"看不出来。这里只做一件事——
 * 没有坐标的节点给一个能看的初始位置，用户拖过之后以用户的位置为准。
 */
import type { WorkflowNodeDef } from './types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

const COLUMN_GAP = 300;
const ROW_GAP = 120;

function sourcesOf(node: WorkflowNodeDef): string[] {
  const deps: string[] = [...(node.dependsOn ?? [])];
  for (const input of Object.values(node.inputs ?? {})) {
    if (!('from' in input)) continue;
    const from = (input as { from: string | readonly { nodeId: string }[] }).from;
    if (typeof from === 'string') deps.push(from);
    else for (const source of from) deps.push(source.nodeId);
  }
  return deps;
}

export function layoutNodes(
  nodes: readonly WorkflowNodeDef[],
): Record<string, Point> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>();

  const visit = (id: string, stack: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0;
    const node = byId.get(id);
    if (node === undefined) return 0;
    stack.add(id);
    let value = 0;
    for (const source of sourcesOf(node)) {
      if (!byId.has(source)) continue;
      value = Math.max(value, visit(source, stack) + 1);
    }
    stack.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const node of nodes) visit(node.id, new Set());

  const rows = new Map<number, number>();
  const result: Record<string, Point> = {};
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    result[node.id] = { x: column * COLUMN_GAP + 40, y: row * ROW_GAP + 40 };
  }
  return result;
}
