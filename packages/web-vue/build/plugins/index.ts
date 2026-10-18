import type { PluginOption } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import progress from 'vite-plugin-progress';
import vueRootValidator from 'vite-plugin-vue-transition-root-validator';
import { setupHtmlPlugin } from './html';
import { setupUnocss } from './unocss';
import { setupUnplugin } from './unplugin';

/**
 * 这里**没有** `setupElegantRouter()`（模板原本有）。
 *
 * 它做的事是"扫描 `src/views` 自动生成路由 + 开一个 chokidar 监视器热更新"。
 * 两个问题：
 *
 * 1. **监视器会把 dev server 直接搞崩**。它在 Windows 上会抓到写入中的临时文件：
 *
 *      EBUSY: resource busy or locked, watch '...\.index.vue.21368.*.tmpdir\index.vue.tmp'
 *
 *    这个错误没有被 catch，抛出后进程退出。实测新建页面文件时就触发。
 *
 * 2. **它依赖 `chokidar@3`，而本仓库里同时存在 `chokidar@5`**（unocss 带入）。
 *    两者对 `readdirp` 的要求不同（v3 要 `ReaddirpStream`，v5 已移除该导出），
 *    提升后解析到 v5 就会在加载 vite.config 时报错：
 *
 *      The requested module 'readdirp' does not provide an export named 'ReaddirpStream'
 *
 * 而路由**运行时并不依赖这个插件**：`src/router/routes/index.ts` 只 import
 * `src/router/elegant/{imports,routes,transform}.ts` 这三个**已生成**的文件。
 * 所以摘掉插件，路由照旧工作，只是新增/重命名页面时要手动同步那三个文件
 * （它们本来就是 eslint-disable 的生成物，人工维护成本很低）。
 */
export function setupVitePlugins(viteEnv: Env.ImportMeta, buildTime: string) {
  const plugins: PluginOption = [
    vue(),
    vueJsx(),
    setupUnocss(viteEnv),
    ...setupUnplugin(viteEnv),
    progress(),
    setupHtmlPlugin(buildTime),
    vueRootValidator()
  ];

  return plugins;
}
