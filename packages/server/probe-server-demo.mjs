/**
 * 演示版本冒烟脚本：对着**已经起好的服务**跑一遍完整链路。
 *
 * 与 `probe-screenshot.mjs` / `probe-click.mjs` 的分工：
 *   - 那两个直接调 orchestrator，验证的是**驱动**；
 *   - 这个走 HTTP API，验证的是**整台服务**（含落定、下载、结构化链路）。
 *
 * 用法：
 *   1. 另开一个终端：pnpm start
 *   2. node packages/server/probe-server-demo.mjs
 *
 * 退出码 0 表示演示链路正常；任何一步不对就非 0 退出并打印实际拿到的东西。
 */
const origin = process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:8787';

function fail(message, extra) {
  console.error(`✗ ${message}`, extra === undefined ? '' : extra);
  process.exit(1);
}

async function json(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// 1. 服务活着吗
const health = await json('/api/health');
if (health.status !== 200) fail(`健康检查失败：${health.status}`, health.body);
console.log('✓ 服务健康', JSON.stringify(health.body));

// 2. 提一次结构化运行（带截图）。全用确定性能力：不调生成模型，也不需要决策模型在线。
const submit = await json('/api/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    goal: '做一个中文产品介绍落地页，包含首屏、特性与行动号召',
    envType: 'webpage',
    projectId: 'demo-freeze',
    candidateBlockIds: ['hero', 'features', 'cta', 'footer'],
    maxBlocks: 4,
    screenshot: true,
  }),
});
if (submit.status !== 202) fail(`提交运行失败：${submit.status}`, submit.body);
const runId = submit.body.runId;
console.log('✓ 已提交运行', runId);

// 3. 等它结束
const deadline = Date.now() + 180_000;
let run;
for (;;) {
  if (Date.now() > deadline) fail('运行超时', run?.status);
  const got = await json(`/api/runs/${runId}`);
  run = got.body;
  if (['succeeded', 'failed', 'escalated', 'cancelled'].includes(run.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (run.status !== 'succeeded') fail(`运行没有成功：${run.status}`, run.error ?? '');
console.log('✓ 运行成功，产出', run.artifacts.length, '个产物');

// 4. 产物要下得下来（先落定副本，再回沙盒）
for (const artifact of run.artifacts) {
  const name = artifact.path.split('/').pop();
  const response = await fetch(`${origin}/api/runs/${runId}/artifacts/${name}`);
  if (response.status !== 200) fail(`${artifact.path} 下载失败：${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== artifact.size) {
    fail(`${artifact.path} 大小对不上：清单 ${artifact.size}，实下 ${bytes.byteLength}`);
  }
  console.log(`✓ ${artifact.path} ${bytes.byteLength}B`);
}

// 5. 有截图的话确认它是一张真 PNG（魔数 + 尺寸）
const shot = run.artifacts.find((a) => a.path.endsWith('screenshot.png'));
if (shot !== undefined) {
  const response = await fetch(`${origin}/api/runs/${runId}/artifacts/screenshot.png`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== '\x89PNG') fail(`截图不是 PNG：魔数 ${JSON.stringify(magic)}`);
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width < 100 || height < 100) fail(`截图尺寸不合理：${width}x${height}`);
  console.log(`✓ 截图是真 PNG：${width}x${height}，${bytes.byteLength}B`);
} else {
  console.log('· 本次没有截图产物（未启用截图时属正常）');
}

console.log('\n演示链路冒烟通过。');
