import { Plugin as importToCDN } from "vite-plugin-cdn-import";

/**
 * @description 打包时采用`cdn`模式，仅限外网使用（默认不采用，如果需要采用cdn模式，请在 .env.production 文件，将 VITE_CDN 设置成true）
 * 平台采用国内cdn：https://www.bootcdn.cn，当然你也可以选择 https://unpkg.com 或者 https://www.jsdelivr.com
 * 注意：上面提到的仅限外网使用也不是完全肯定的，如果你们公司内网部署的有相关js、css文件，也可以将下面配置对应改一下，整一套内网版cdn
 *
 * **本仓库改动（MediaSandbox）**：由「模块顶层直接构造插件」改为**工厂函数**。
 * 原因：`importToCDN(...)` 在**调用时**就会去读各模块的 `package.json` 取版本号，
 * 而下面 modules 里的 `vue-demi` 并非直接依赖（pinia 的依赖，见第 22 行注释）。
 * 上游之所以不出错，是靠它 `.npmrc` 里的 `shamefully-hoist=true` 把 node_modules 摊平；
 * 本仓库是 pnpm workspace、没有摊平，于是在**配置加载阶段**就报
 * `vue-demi package.json file does not exist`——`plugins.ts` 里那句
 * `VITE_CDN ? cdn : null` 拦不住，因为实例在 import 时已经建好了。
 * 改成按需构造后，默认（`VITE_CDN=false`）不再触碰这条路径。
 * 若要真的启用 CDN 模式，请自行确认 `vue-demi` 可被解析（例如显式安装它）。
 */
export const createCdn = () =>
  importToCDN({
  //（prodUrl解释： name: 对应下面modules的name，version: 自动读取本地package.json中dependencies依赖中对应包的版本号，path: 对应下面modules的path，当然也可写完整路径，会替换prodUrl）
  prodUrl: "https://cdn.bootcdn.net/ajax/libs/{name}/{version}/{path}",
  modules: [
    {
      name: "vue",
      var: "Vue",
      path: "vue.global.prod.min.js"
    },
    {
      name: "vue-router",
      var: "VueRouter",
      path: "vue-router.global.min.js"
    },
    // 项目中没有直接安装vue-demi，但是pinia用到了，所以需要在引入pinia前引入vue-demi（https://github.com/vuejs/pinia/blob/v2/packages/pinia/package.json#L77）
    {
      name: "vue-demi",
      var: "VueDemi",
      path: "index.iife.min.js"
    },
    {
      name: "pinia",
      var: "Pinia",
      path: "pinia.iife.min.js"
    },
    {
      name: "element-plus",
      var: "ElementPlus",
      path: "index.full.min.js",
      css: "index.min.css"
    },
    {
      name: "axios",
      var: "axios",
      path: "axios.min.js"
    },
    {
      name: "dayjs",
      var: "dayjs",
      path: "dayjs.min.js"
    },
    {
      name: "echarts",
      var: "echarts",
      path: "echarts.min.js"
    }
  ]
});
