import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDeck } from '../../packages/orchestrator/dist/structured/deck-renderer.js';

const OUT = 'E:/aiPic/通用沙盒基建/out/bench';
mkdirSync(OUT, { recursive: true });
const inputPath = process.argv[2] || fileURLToPath(new URL('./deck-bench.json', import.meta.url));
const prefix = process.argv[3] || 'deck';
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const { spec, chrome } = input;

function still(html, index) {
  const inject = '<style>html,body{overflow:hidden;background:#000}'
    + '.deck__nav,.deck__hud{display:none}'
    + '.deck__stage{display:block;padding:0}'
    + '.slide__frame{width:1600px;height:900px;border-radius:0;box-shadow:none}'
    + '.slide[hidden]{display:none!important}</style>'
    + '<script>document.querySelectorAll("[data-ms-tab]")[' + index + '].click();</script>';
  return html.replace('</body>', inject + '</body>');
}

for (const label of ['chrome', 'plain']) {
  const opts = { title: spec.goal, themeId: 'deep-navy', composition: 'parallel' };
  if (label === 'chrome') opts.chrome = chrome;
  const html = renderDeck(spec, opts);
  writeFileSync(OUT + '/' + prefix + '-' + label + '.html', html, 'utf8');
  for (let i = 0; i < spec.blocks.length; i++) {
    writeFileSync(OUT + '/' + prefix + '-' + label + '-p' + (i + 1) + '.html', still(html, i), 'utf8');
  }
  console.log(label, 'ok');
}