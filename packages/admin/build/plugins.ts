import { createCdn } from "./cdn";
import vue from "@vitejs/plugin-vue";
import { viteBuildInfo } from "./info";
import svgLoader from "vite-svg-loader";
import Icons from "unplugin-icons/vite";
import type { PluginOption } from "vite";
import vueJsx from "@vitejs/plugin-vue-jsx";
import tailwindcss from "@tailwindcss/vite";
import { configCompressPlugin } from "./compress";
import removeNoMatch from "vite-plugin-router-warn";
import { visualizer } from "rollup-plugin-visualizer";
import removeConsole from "vite-plugin-remove-console";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { vitePluginFakeServer } from "vite-plugin-fake-server";

export function getPluginsList(
  VITE_CDN: boolean,
  VITE_COMPRESSION: ViteCompression
): PluginOption[] {
  const lifecycle = process.env.npm_lifecycle_event;
  return [
    tailwindcss(),
    vue(),
    // jsx、tsx语法支持
    vueJsx(),
    /**
     * 在页面上按住组合键时，鼠标在页面移动即会在 DOM 上出现遮罩层并显示相关信息，点击一下将自动打开 IDE 并将光标定位到元素对应的代码位置
     * Mac 默认组合键 Option + Shift
     * Windows 默认组合键 Alt + Shift
     * 更多用法看 https://inspector.fe-dev.cn/guide/start.html
     */
    codeInspectorPlugin({
      bundler: "vite",
      hideConsole: true
    }),
    viteBuildInfo(),
    /**
     * 开发环境下移除非必要的vue-router动态路由警告No match found for location with path
     * 非必要具体看 https://github.com/vuejs/router/issues/521 和 https://github.com/vuejs/router/issues/359
     * vite-plugin-router-warn只在开发环境下启用，只处理vue-router文件并且只在服务启动或重启时运行一次，性能消耗可忽略不计
     */
    removeNoMatch(),
    // mock支持
    vitePluginFakeServer({
      logger: false,
      include: "mock",
      infixName: false,
      enableProd: true
    }),
    // svg组件化支持
    svgLoader(),
    // 自动按需加载图标
    Icons({
      compiler: "vue3",
      scale: 1
    }),
    VITE_CDN ? createCdn() : null,
    configCompressPlugin(VITE_COMPRESSION),
    // 线上环境删除console
    /**
     * **本仓库改动（MediaSandbox）**：去掉上游的 `external: ["src/assets/iconfont/iconfont.js"]`。
     *
     * 那个选项在本仓库**永远不可能生效**：插件把 `external` 用
     * `resolve(process.cwd(), x)` 变成绝对路径后，会经一个"路径规范化"函数转成正斜杠，
     * 但只要路径含非 Latin-1 字符（我们的仓库路径是中文）就直接原样返回、保留反斜杠；
     * 而 Vite 传进来的模块 id 是正斜杠形式，于是 `includes(id)` 恒为 false。
     * 已用脚本复现：中文路径命中 false，英文路径命中 true。
     *
     * 后果是 `iconfont.js` 会被照常剥离，而它里面有 `console && console.log(t);`
     * 这种把 console 当值用的写法，剥离后变成 `console && ;`，Rollup 直接报
     * `Expression expected`。该行已就地改掉（见 src/assets/iconfont/iconfont.js 的注释）。
     *
     * ⚠️ 因此本项目里**不要写** `console && x()`、`if (console)`、`console?.log()`
     * 这类把 console 当值用的代码——构建期会被剥坏。普通 `console.log(...)` 语句没问题。
     */
    removeConsole(),
    // 打包分析
    lifecycle === "report"
      ? visualizer({ open: true, brotliSize: true, filename: "report.html" })
      : (null as any)
  ];
}
