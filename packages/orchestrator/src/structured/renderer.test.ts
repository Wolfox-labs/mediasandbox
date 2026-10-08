/**
 * 渲染器的测试。
 *
 * ## 最要紧的两条
 *
 * 1. **转义**。slot 内容来自用户目标，直接拼进 HTML 就是注入点。
 *    这里用带 `<script>` / 引号 / `&` 的值去撞它，断言输出里不出现可执行标记。
 * 2. **中间态也要渲染**。`pending` / `failed` / 未知类型都不该让整页失败——
 *    "部分完成"是结构化制作相对"一次性生成一整页"的核心优势，
 *    渲染器把它毁掉的话，那个优势就只剩说法。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBlockRegistry, BUILTIN_BLOCKS } from './block-spec.js';
import type { BlockInstance, PageSpec } from './page-spec.js';
import { createPageSpec } from './page-spec.js';
import { escapeHtml, pageStyles, renderPage } from './renderer.js';

const reg = createBlockRegistry();

function block(
  type: string,
  slots: BlockInstance['slots'] = {},
  status: BlockInstance['status'] = 'filled',
): BlockInstance {
  const sources: Record<string, 'deterministic'> = {};
  for (const name of Object.keys(slots)) sources[name] = 'deterministic';
  return { id: 'b1', type, slots, status, sources };
}

function page(blocks: readonly BlockInstance[]): PageSpec {
  return {
    ...createPageSpec({ projectId: 'proj', goal: '测试目标', candidateBlockIds: [] }),
    blocks,
  };
}

describe('渲染器：转义是安全底线', () => {
  it('脚本标签被转义，不产生可执行的 script', () => {
    const html = renderPage(
      page([block('text', { body: { kind: 'text', text: '<script>alert(1)</script>' } })]),
    );
    assert.ok(!html.includes('<script>alert(1)'), '注入了可执行脚本');
    assert.ok(html.includes('&lt;script&gt;'), '没有转义');
  });

  it('图片 alt 里的引号被转义，撑不破属性', () => {
    const html = renderPage(
      page([
        block('image', {
          prompt: { kind: 'image', ref: 'data:image/svg+xml,x', alt: '" onload="alert(1)' },
        }),
      ]),
    );
    assert.ok(!html.includes('onload="alert(1)"'), '属性被撑破，注入了事件处理器');
    assert.ok(html.includes('&quot;'), '引号没有转义');
  });

  it('标题里的尖括号被转义', () => {
    const html = renderPage(page([block('quote', { text: { kind: 'text', text: 'a' }, attribution: { kind: 'text', text: 'b' } })]), {
      title: '</title><script>x</script>',
    });
    assert.ok(!html.includes('</title><script>'), 'title 被撑破');
  });

  it('列表项逐条转义', () => {
    const html = renderPage(
      page([
        block('features', {
          heading: { kind: 'text', text: 'h' },
          items: { kind: 'list', items: ['<img src=x onerror=alert(1)>', '正常项'] },
        }),
      ]),
    );
    assert.ok(!html.includes('<img src=x onerror'), '列表项没转义');
    assert.ok(html.includes('正常项'));
  });

  it('代码块内容转义——否则代码块的示例代码会被当标签执行', () => {
    const html = renderPage(
      page([
        block('code', {
          language: { kind: 'text', text: 'html' },
          source: { kind: 'text', text: '<div onclick="x()">hi</div>' },
        }),
      ]),
    );
    assert.ok(!html.includes('<div onclick'), '代码内容没转义');
    assert.ok(html.includes('&lt;div'));
  });

  it('& 先被转义，不会造成二次转义错误', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    const html = renderPage(page([block('text', { body: { kind: 'text', text: 'A & B' } })]));
    assert.ok(html.includes('A &amp; B'));
  });

  it('正文里换行先转义再转换，顺序不能反', () => {
    const html = renderPage(
      page([block('text', { body: { kind: 'text', text: '<b>x</b>\n\n第二段' } })]),
    );
    // 若先转换后转义，`<p>` 会被转义成 `&lt;p&gt;`，页面结构就没了。
    assert.ok(html.includes('<p>'), '段落结构丢失——转义与转换的顺序反了');
    assert.ok(!html.includes('<b>x</b>'), '内容没转义');
    assert.ok(html.includes('第二段'));
  });
});

describe('渲染器：中间态与异常都不毁页', () => {
  it('pending 的块渲染占位，不抛错', () => {
    const html = renderPage(page([block('hero', {}, 'pending')]));
    assert.ok(html.includes('ms-block-pending'));
    assert.ok(html.includes('待填充'));
    assert.ok(html.includes('data-ms-block="b1"'), '中间态也必须带定位锚点');
  });

  it('failed 的块带上原因，便于定点重做', () => {
    const b: BlockInstance = { ...block('hero', {}, 'failed'), error: '生成层 502' };
    const html = renderPage(page([b]));
    assert.ok(html.includes('ms-block-error'));
    assert.ok(html.includes('502'), '失败原因没有出现在产物里');
  });

  it('skipped 的块标明已跳过', () => {
    const html = renderPage(page([block('cta', {}, 'skipped')]));
    assert.ok(html.includes('已跳过'));
  });

  it('未知类型渲染占位，不抛错', () => {
    const html = renderPage(page([block('no-such-type', {})]));
    assert.ok(html.includes('ms-unknown'));
    assert.ok(html.includes('no-such-type'), '占位里应当写明是哪种类型');
    assert.ok(html.includes('<!DOCTYPE html>'), '整页仍然产出了');
  });

  it('一页里混着 filled / pending / 未知类型时全部渲染', () => {
    const html = renderPage(
      page([
        block('hero', { title: { kind: 'text', text: 'T' }, subtitle: { kind: 'text', text: 'S' }, actionText: { kind: 'text', text: 'A' } }),
        { ...block('features', {}, 'pending'), id: 'b2' },
        { ...block('no-such', {}, 'filled'), id: 'b3' },
      ]),
    );
    for (const id of ['b1', 'b2', 'b3']) {
      assert.ok(html.includes(`data-ms-block="${id}"`), `${id} 没有被渲染`);
    }
  });

  it('单个 block 渲染器抛错时只影响那一块', () => {
    // 造一个会让渲染器抛错的值：list-image 的 refs 里放 null。
    const broken = {
      ...block('gallery', {}, 'filled'),
      slots: { heading: { kind: 'text', text: 'h' }, images: { kind: 'list-image', refs: [null] } },
    } as unknown as BlockInstance;
    const html = renderPage(page([broken, { ...block('cta', { text: { kind: 'text', text: 'C' }, buttonText: { kind: 'text', text: 'B' } }), id: 'b2' }]));
    // 第二块必须照常渲染出来。
    assert.ok(html.includes('data-ms-block="b2"'), '一块坏了把别的块也带没了');
  });
});

describe('渲染器：确定性', () => {
  it('同样的输入渲染两次逐字节相同', () => {
    const spec = page([
      block('hero', { title: { kind: 'text', text: 'T' }, subtitle: { kind: 'text', text: 'S' }, actionText: { kind: 'text', text: 'A' } }),
      { ...block('tabs', { tabs: { kind: 'list', items: ['a', 'b'] }, panels: { kind: 'list', items: ['x', 'y'] } }), id: 'b2' },
    ]);
    assert.equal(renderPage(spec), renderPage(spec));
  });

  it('输出里不含时间戳或随机值', () => {
    const html = renderPage(page([block('text', { body: { kind: 'text', text: 'x' } })]));
    // 有 Date.now() 或随机数就会体现在产物里，产物就不再可复现。
    assert.ok(!/\d{13}/.test(html), '产物里出现了 13 位数字（疑似时间戳）');
    assert.ok(!/Math\.random/.test(html));
  });

  it('块的渲染顺序就是数组顺序', () => {
    const html = renderPage(
      page([
        { ...block('nav', { brand: { kind: 'text', text: 'B' }, links: { kind: 'list', items: ['a', 'b'] } }), id: 'b1' },
        { ...block('cta', { text: { kind: 'text', text: 'C' }, buttonText: { kind: 'text', text: 'D' } }), id: 'b2' },
        { ...block('footer', { copyright: { kind: 'text', text: 'E' } }), id: 'b3' },
      ]),
    );
    const order = [...html.matchAll(/data-ms-block="(b\d)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['b1', 'b2', 'b3']);
  });
});

describe('渲染器：产物是自包含的', () => {
  it('是完整 HTML 文档，CSS 内联', () => {
    const html = renderPage(page([block('text', { body: { kind: 'text', text: 'x' } })]));
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="zh-CN">'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('</html>'));
  });

  it('不引用任何外部资源——页面要在 network=none 的容器里跑起来', () => {
    const html = renderPage(
      page([
        block('hero', { title: { kind: 'text', text: 'T' }, subtitle: { kind: 'text', text: 'S' }, actionText: { kind: 'text', text: 'A' }, media: { kind: 'image', ref: 'data:image/svg+xml,x', alt: 'm' } }),
        { ...block('tabs', { tabs: { kind: 'list', items: ['a', 'b'] }, panels: { kind: 'list', items: ['x', 'y'] } }), id: 'b2' },
      ]),
    );
    assert.ok(!/<link[^>]+href=/i.test(html), '有 link 引用');
    assert.ok(!/<script[^>]+src=/i.test(html), '有外部脚本');
    assert.ok(!/@import/i.test(html), '有 CSS @import');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/i.test(html), '有外部 URL');
  });

  it('每个块都带 data-ms-block 锚点，与 annotate 无关', () => {
    const spec = page([block('text', { body: { kind: 'text', text: 'x' } })]);
    assert.ok(renderPage(spec).includes('data-ms-block="b1"'));
    assert.ok(renderPage(spec, { annotate: true }).includes('data-ms-block="b1"'));
  });

  it('还带 status 与 type 锚点，供定点定位', () => {
    const html = renderPage(page([block('quote', { text: { kind: 'text', text: 'a' }, attribution: { kind: 'text', text: 'b' } })]));
    assert.ok(html.includes('data-ms-status="filled"'));
    assert.ok(html.includes('data-ms-type="quote"'));
  });
});

describe('渲染器：每个内置 block 都渲染得出东西', () => {
  it('15 类 block 逐个渲染都不抛错，且都有内容', () => {
    for (const spec of BUILTIN_BLOCKS) {
      // 造一个"已填"的块：把每个 slot 按声明类型填上确定性的值。
      const slots: Record<string, unknown> = {};
      for (const slot of spec.slots) {
        switch (slot.type) {
          case 'list-text':
            slots[slot.name] = { kind: 'list', items: ['一 | 二', '三 | 四'] };
            break;
          case 'image':
            slots[slot.name] = { kind: 'image', ref: 'data:image/svg+xml,x', alt: '图' };
            break;
          case 'list-image':
            slots[slot.name] = {
              kind: 'list-image',
              refs: [
                { ref: 'data:image/svg+xml,x', alt: '图1' },
                { ref: 'data:image/svg+xml,y', alt: '图2' },
              ],
            };
            break;
          default:
            slots[slot.name] = { kind: 'text', text: `${slot.name}的内容` };
        }
      }
      const html = renderPage(page([block(spec.id, slots as BlockInstance['slots'])]));
      assert.ok(html.includes(`data-ms-type="${spec.id}"`), `${spec.id} 没有渲染出来`);
      assert.ok(html.includes('</html>'), `${spec.id} 让整页崩了`);
      // 查的是**渲染出来的占位元素**，不是字符串 `ms-unknown`：
      // 样式表里总有 `.ms-unknown` 这条规则，按子串查会永远失败。
      assert.ok(
        !html.includes('class="ms-unknown"'),
        `${spec.id} 被判成未知类型`,
      );
      void reg;
    }
  });

  it('15 类都注册了渲染器（没有漏掉的）', () => {
    for (const spec of BUILTIN_BLOCKS) {
      const html = renderPage(page([block(spec.id, {}, 'pending')]));
      assert.ok(!html.includes('class="ms-unknown"'), `${spec.id} 没有渲染实现`);
    }
  });
});

describe('渲染器：交互元素必须真实可点', () => {
  it('标签页用 button + aria-selected + 面板 hidden 切换', () => {
    const html = renderPage(
      page([
        block('tabs', {
          tabs: { kind: 'list', items: ['甲', '乙'] },
          panels: { kind: 'list', items: ['内容一', '内容二'] },
        }),
      ]),
    );
    assert.ok(html.includes('role="tablist"'));
    assert.ok((html.match(/<button/g) ?? []).length >= 2, '标签不是 button');
    assert.ok(html.includes('aria-selected="true"'), '缺少选中状态');
    assert.ok(html.includes('hidden'), '非首个面板应当是 hidden');
    assert.ok(html.includes('data-ms-tab="b1:1"'), '缺少定位锚点');
    assert.ok(html.includes('data-ms-panel="b1:1"'), '面板缺少定位锚点');
  });

  it('标签页的切换脚本是内联的、用事件委托', () => {
    const html = renderPage(
      page([
        block('tabs', {
          tabs: { kind: 'list', items: ['甲', '乙'] },
          panels: { kind: 'list', items: ['一', '二'] },
        }),
      ]),
    );
    assert.ok(html.includes('<script>'), '缺少切换脚本');
    assert.ok(html.includes('addEventListener'), '脚本没有绑定事件');
    assert.ok(!/<script[^>]+src=/.test(html), '脚本不该是外部文件');
  });

  it('没有标签页时不注入脚本——用不到就不加', () => {
    const html = renderPage(page([block('text', { body: { kind: 'text', text: 'x' } })]));
    assert.ok(!html.includes('<script'), '没有交互块却注入了脚本');
  });

  it('折叠面板用原生 details/summary，不需要脚本', () => {
    const html = renderPage(
      page([block('accordion', { items: { kind: 'list', items: ['问一 | 答一', '问二 | 答二'] } })]),
    );
    assert.ok(html.includes('<details'));
    assert.ok(html.includes('<summary'));
    assert.ok(html.includes('data-ms-accordion="b1:1"'), '缺少定位锚点');
    assert.ok(!html.includes('<script'), '原生 details 不需要脚本');
  });

  it('表单提交被拦下，不发网络请求', () => {
    const html = renderPage(
      page([block('form', { heading: { kind: 'text', text: 'h' }, fields: { kind: 'list', items: ['姓名'] }, submitText: { kind: 'text', text: '提交' } })]),
    );
    assert.ok(html.includes('<form'));
    assert.ok(html.includes('preventDefault'), '提交没有被拦下');
    assert.ok(!html.includes('action="http'), '表单指向了外部地址');
    assert.ok(html.includes('data-ms-submit'), '提交按钮缺少定位锚点');
  });
});

describe('渲染器：图片处理', () => {
  it('data URI 直接用作 src', () => {
    const html = renderPage(
      page([block('image', { prompt: { kind: 'image', ref: 'data:image/png;base64,AAA', alt: '图' } })]),
    );
    assert.ok(html.includes('src="data:image/png;base64,AAA"'));
    assert.ok(html.includes('loading="lazy"'));
  });

  it('相对路径也直接用作 src，不做路径改写', () => {
    const html = renderPage(
      page([block('image', { prompt: { kind: 'image', ref: 'artifacts/x.png', alt: '图' } })]),
    );
    assert.ok(html.includes('src="artifacts/x.png"'), '相对路径被改写了');
  });

  it('ref 为空时渲染内联 SVG 占位，而不是空的 img src', () => {
    const html = renderPage(page([block('image', { prompt: { kind: 'image', ref: '', alt: '缺图' } })]));
    // `<img src="">` 会让浏览器把当前页面地址当图片地址再请求一次。
    assert.ok(!html.includes('src=""'), '出现了空 src');
    assert.ok(html.includes('<svg'), '没有回落成内联占位图');
  });

  it('alt 为空时也给占位图一个可读标签', () => {
    const html = renderPage(page([block('image', { prompt: { kind: 'image', ref: '', alt: '' } })]));
    assert.ok(html.includes('aria-label="图片待补充"'));
  });
});

describe('渲染器：样式', () => {
  it('pageStyles 可以单独取出，非空且含 CSS 变量', () => {
    const css = pageStyles();
    assert.ok(css.length > 500);
    assert.ok(css.includes(':root'));
    assert.ok(css.includes('--ms-fg'));
  });

  it('支持深色模式', () => {
    assert.ok(pageStyles().includes('prefers-color-scheme: dark'));
  });

  it('窄屏下多列退化为单列', () => {
    const css = pageStyles();
    assert.ok(css.includes('@media (min-width: 48rem)'), '缺少响应式断点');
    assert.ok(css.includes('grid-template-columns: 1fr'), '缺少单列基线');
  });
});

describe('渲染器：空与边界', () => {
  it('零块的页面也能渲染出合法文档', () => {
    const html = renderPage(page([]));
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('</html>'));
    assert.ok(html.includes('data-ms-blocks="0"'));
  });

  it('缺 slot 的 filled 块不崩（渲染层不做结构校验）', () => {
    // 结构校验是 validatePageSpec 的职责，渲染器只管画。
    // 在这里也抛错的话，一个漏填的 slot 会让整个产物拿不到。
    const html = renderPage(page([{ ...block('hero', {}, 'filled'), id: 'b1' }]));
    assert.ok(html.includes('data-ms-block="b1"'));
    assert.ok(html.includes('（待补充）') || html.includes('ms-hero'));
  });

  it('很长的内容不会截断', () => {
    const long = '字'.repeat(5000);
    const html = renderPage(page([block('text', { body: { kind: 'text', text: long } })]));
    assert.ok(html.includes(long), '长内容被截断了');
  });
});
