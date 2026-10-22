/**
 * 用两个新版式拼一份 demo 文稿：切角卡片行 + 三栏图文卡。
 *
 * 图直接用上一次真实运行里生成的那张（data URI），不联网、不自造素材。
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { renderDeck } from '../../packages/orchestrator/dist/structured/deck-renderer.js';

const SRC = 'E:/aiPic/通用沙盒基建/MediaSandbox/workspaces/local/run-20261021122740-qo0svz-slides-a2f6ea9f/src/slides/b2.json';
const themeId = process.argv[2] ?? 'tech-cyan';
const outFile = process.argv[3] ?? 'E:/aiPic/通用沙盒基建/out/demo-cards.html';
// 第 4 个参数：只渲染第 N 页（1 起）。单页渲染才有全宽 16:9，多页并排会各自缩窄。
const only = Number(process.argv[4] ?? '0');

const gen = JSON.parse(readFileSync(SRC, 'utf8'));
const imgRef = gen.slots.image.ref;
const imgAlt = gen.slots.image.alt ?? '';

const text = (t) => ({ kind: 'text', text: t });
const list = (items) => ({ kind: 'list', items });
const image = (ref, alt) => ({ kind: 'image', ref, alt });

const blocks = [
  {
    id: 'b1',
    type: 'cover',
    status: 'filled',
    sources: {},
    slots: {
      eyebrow: text('校集 · 2025 高校创新创业大赛路演'),
      title: text('让校园闲置 48 小时成交'),
      subtitle: text('学籍实名 + 校内面交 + 平台担保，把校园二手的交易成本压到最低'),
    },
  },
  {
    id: 'b2',
    type: 'beveled-cards',
    status: 'filled',
    sources: {},
    slots: {
      heading: text('现有渠道撑不起这笔交易'),
      lede: text('不是没人想卖，是三个渠道各自缺一块。'),
      cards: list([
        '闲鱼|陌生人交易，先付款后失联；维权成本高于货值',
        '微信群|刷屏即沉底，没有搜索；没有担保，没有履约约束',
        '校内跳蚤市场|一年只开一次；只在毕业季；平时无处可去',
      ]),
    },
  },
  {
    id: 'b3',
    type: 'image-text-card',
    status: 'filled',
    sources: {},
    slots: {
      heading: text('三个场景，同一套机制'),
      lede: text('学籍实名、校内面交、平台担保，在三类场景里各解决一件最难的事。'),
      cards: list([
        '毕业季出清|三天内处理完宿舍；不用摆摊；价格由成交数据定',
        '新生入学采购|教材、小电器、床品；有学长验过货；当面看货',
        '日常低值流转|耳机、球拍、自行车；同校半小时到手；坏了能找到人',
      ]),
      images: { kind: 'list-image', refs: [image(imgRef, imgAlt), image(imgRef, imgAlt), image(imgRef, imgAlt)] },
    },
  },
  {
    id: 'b4',
    type: 'icon-grid',
    status: 'filled',
    sources: {},
    slots: {
      heading: text('校集凭什么在 48 小时内成交'),
      lede: text('四条机制叠在一起，才把交易成本压到这个数。'),
      items: list([
        '🪪|学籍实名|一人一号，学生证自动核验，陌生人风险降到最低',
        '📍|同校匹配|只推同校区三公里内，面交半小时能到',
        '🛡️|平台担保|钱先托管，确认收货才放款，纠纷平台垫付',
        '📊|成交定价|按最近七天同类成交价给区间，不靠人情开价',
      ]),
    },
  },
  {
    id: 'b5',
    type: 'process-flow',
    status: 'filled',
    sources: {},
    slots: {
      heading: text('一次交易，四步走完'),
      lede: text('从挂出到放款，试点校平均 41 小时。'),
      steps: list([
        '挂出|拍照上传，系统按品类给建议价',
        '匹配|同校推荐，推送半径三公里内的买家',
        '面交|校内固定点位，扫码验货',
        '放款|确认无误，平台即刻放款给卖家',
      ]),
    },
  },
  {
    id: 'b6',
    type: 'metric-grid',
    status: 'filled',
    sources: {},
    slots: {
      heading: text('试点三所高校的实测数据'),
      metrics: list([
        '41h|平均成交时长|比校园群快 3.2 倍',
        '68%|当日成交率|发布的商品当天成交',
        '0.7%|纠纷率|平台垫付后追回率 92%',
        '4.2万|活跃用户|三校在校生覆盖 31%',
        '¥19|客单价|单笔服务费抽成 2%',
        '9.1|NPS 净推荐|受试学生愿意推荐给同学',
      ]),
      note: text('统计周期 2025.03–2025.09，三校合计 4.2 万活跃用户'),
    },
  },
  {
    id: 'b7',
    type: 'closing',
    status: 'filled',
    sources: {},
    slots: {
      headline: text('把校园里每一次闲置，都变成一次 48 小时内的成交'),
      note: text('校集 · 2025'),
      contact: text('team@xiaoji.example'),
    },
  },
];

const spec = {
  projectId: 'deck-lab',
  goal: '校园二手交易平台 · 创赛路演（新版式 demo）',
  templateId: null,
  candidateBlockIds: blocks.map((b) => b.type),
  blocks: only > 0 ? [blocks[only - 1]] : blocks,
  qualityScore: 0,
  createdAt: Date.now(),
};

const html = renderDeck(spec, { title: '校园二手交易平台 · 创赛路演', themeId, composition: 'ranked' });
writeFileSync(outFile, html, 'utf8');
console.log(`写出 ${outFile}（主题 ${themeId}，${spec.blocks.length} 页${only > 0 ? `，只渲染第 ${only} 页` : ''}）`);
console.log(`版式: ${spec.blocks.map((b) => b.type).join(' → ')}`);
