/**
 * 实验室里的独立渲染入口：拿一次真实运行的产物页，用指定的主题重渲染。
 *
 * 存在的理由：主仓库有别人在改，跑到一半可能被改坏。这里是一个干净 worktree，
 * 只认 dist 里的渲染器，所以"红色的测试"不会和别人的半成品混在一起。
 *
 * 用法：
 *   node deck-lab.mjs <slides目录> <输出html> [themeId] [composition]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { renderDeck } from '../../packages/orchestrator/dist/structured/deck-renderer.js';

const [slidesDir, outFile, themeId = 'tech-cyan', composition = 'ranked'] = process.argv.slice(2);
if (!slidesDir || !outFile) {
  console.error('用法: node deck-lab.mjs <slides目录> <输出html> [themeId] [composition]');
  process.exit(2);
}

const files = readdirSync(slidesDir)
  .filter((f) => /^b\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

const blocks = files.map((f) => JSON.parse(readFileSync(path.join(slidesDir, f), 'utf8')));

// PageSpec 的最小形状：渲染器只读 projectId / goal / blocks。
const spec = {
  projectId: 'deck-lab',
  goal: '实验室渲染：校园二手交易平台',
  templateId: null,
  candidateBlockIds: blocks.map((b) => b.type),
  blocks,
  qualityScore: 0,
  createdAt: Date.now(),
};

const html = renderDeck(spec, {
  title: '校园二手交易平台 · 创赛路演',
  themeId,
  composition,
});

writeFileSync(outFile, html, 'utf8');
console.log(`渲染 ${blocks.length} 页 → ${outFile}`);
console.log(`版式序: ${blocks.map((b) => b.type).join(' → ')}`);
console.log(`主题: ${themeId} / 构图: ${composition}`);
