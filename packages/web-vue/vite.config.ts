import process from 'node:process';
import { defineConfig, loadEnv } from 'vite-plus';
import { fmt, lint } from '@soybeanjs/oxc-config';
import { createViteProxy, getBuildTime } from './build/config';
import { setupVitePlugins } from './build/plugins';

export default defineConfig(configEnv => {
  const viteEnv = loadEnv(configEnv.mode, process.cwd()) as unknown as Env.ImportMeta;

  const buildTime = getBuildTime();

  const enableProxy = configEnv.command === 'serve' && !configEnv.isPreview;

  // 后端地址：开发期把 /api 与 /ws 反代到它，避免浏览器跨域。
  // 用环境变量覆盖，默认指向本机服务。
  const backendUrl = process.env.MEDIASANDBOX_BACKEND ?? 'http://127.0.0.1:8787';

  return {
    base: viteEnv.VITE_BASE_URL,
    staged: {
      '*': 'vp check --fix'
    },
    lint,
    fmt: {
      ...fmt,
      ignorePatterns: [
        'CHANGELOG.md',
        'src/typings/components.d.ts',
        'src/typings/elegant-router.d.ts',
        'src/router/elegant'
      ]
    },
    resolve: {
      tsconfigPaths: true
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
          additionalData: `@use "@/styles/scss/global.scss" as *;`
        }
      }
    },
    plugins: setupVitePlugins(viteEnv, buildTime),
    define: {
      BUILD_TIME: JSON.stringify(buildTime)
    },
    server: {
      host: '0.0.0.0',
      port: 5174,
      open: false,
      proxy: {
        // 本项目自己的两条：直连后端，不经过模板的 service 约定。
        // 模板的 createViteProxy 期待 {code,data,msg} 信封，而 MediaSandbox
        // 的 API 是裸 JSON + HTTP 状态码，因此单独声明更直白。
        '/api': { target: backendUrl, changeOrigin: true },
        '/ws': { target: backendUrl.replace(/^http/, 'ws'), ws: true },
        ...createViteProxy(viteEnv, enableProxy)
      }
    },
    preview: {
      port: 9725
    },
    build: {
      reportCompressedSize: false,
      sourcemap: viteEnv.VITE_SOURCE_MAP === 'Y',
      commonjsOptions: {
        ignoreTryCatch: false
      }
    }
  };
});
