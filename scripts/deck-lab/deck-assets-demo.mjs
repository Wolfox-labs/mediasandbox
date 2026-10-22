/** 素材位三种来源的验收：本地文件 → data URI → 自包含产物。 */
import { writeFileSync } from 'node:fs';
import { renderDeck } from '../../packages/orchestrator/dist/structured/deck-renderer.js';
import { imageRefFromFile } from '../../packages/orchestrator/dist/structured/deck-assets.js';

const OUT = 'E:/aiPic/通用沙盒基建/out/bench';
const files = [
  'E:/aiPic/通用沙盒基建/out/theme-opera-sand.png',
  'E:/aiPic/通用沙盒基建/out/theme-red-gold.png',
  'E:/aiPic/通用沙盒基建/out/demo-cards-s3.png',
];
const refs = await Promise.all(files.map((file) => imageRefFromFile(file, '参考页')));

const blocks = [
  {
    id: 'b1',
    type: 'phone-row',
    status: 'filled',
    sources: {},
    slots: {
      heading: { kind: 'text', text: '三个界面就是移动端的全部入口' },
      lede: { kind: 'text', text: '图来自本地文件，内联成 data URI，产物仍然单文件自包含。' },
      items: { kind: 'list', items: ['文件浏览|定位目录中的实际产物', '文本编辑|改完直接保存回宿主', '远程终端|执行宿主命令核对结果'] },
      images: { kind: 'list-image', refs },
    },
  },
];
const spec = { projectId: 'assets', goal: '素材位验收', templateId: null, candidateBlockIds: ['phone-row'], blocks, qualityScore: 0, createdAt: 0 };
const html = renderDeck(spec, {
  title: '素材位验收',
  themeId: 'deep-navy',
  chrome: { brand: '智驭寰枢', mark: '驭', sections: ['项目背景', '解决方案'], pages: [{ section: '解决方案', sectionIndex: 1, note: '图与文字同一份产物，断网可看' }] },
});
writeFileSync(OUT + '/assets-demo.html', html, 'utf8');
console.log('bytes', html.length, '| 含 data URI:', html.includes('data:image/png;base64,'));