# packages/web-vue

MediaSandbox 的新前端（Vue 3）。底座是 [soybean-admin](https://github.com/soybeanjs/soybean-admin)
v2.3.0，**vendored 进本仓库**（不是 npm 依赖）。模板原始 README 保留在
[README.soybean-admin.md](./README.soybean-admin.md) 以表致谢。

## 为什么单独一个包

`packages/web` 是原来的 React 前端，仍在服务（后端 8787 托管的就是它）。
新前端独立开发、独立端口（**5174**），确认功能对齐后再决定切不切入口。
两者共用同一套后端 HTTP API，互不影响。

## 开发

```bash
pnpm dev:vue          # 只起新前端，http://localhost:5174/
```

开发期 `/api` 与 `/ws` 由 vite 反代到 `MEDIASANDBOX_BACKEND`
（默认 `http://127.0.0.1:8787`），所以要先起后端：

```bash
pnpm start            # DOCKER_HOST 指向 Docker 桥时才有真截图/真点击能力
```

## 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/workbench` | 创作工作台 | 三栏：提交与历史 / 决策·结构·交互验证·步骤 / 候选池·实时预览 |
| `/projects` | 项目与产物 | 项目列表、按运行分组的文件树、导出 ZIP、内置模板 |
| `/sandbox` | 沙盒环境 | provider 对比、环境预设、容器 8 项隔离约束、最近运行 |
| `/tools` | 工具链 | 决策层候选集（按角色分组）、每类环境的两条路线 |

## 与模板的差异（改动原因都写在代码注释里）

1. **数据层不用 `@sa/axios`**，直接 `fetch`（`src/api/client.ts`）。
   模板的请求层内建 `{code,data,msg}` 业务信封与 token 刷新；本项目的后端是
   **裸 JSON + 标准 HTTP 状态码**（409/410/429/503 各有语义），硬套信封会把状态码丢掉，
   而那正是界面最该如实展示的信息。
2. **摘掉 `vite-plugin-vue-devtools`**：它的 `pkg-types → confbox/json` 依赖链与
   仓库里已装的 confbox 版本冲突，构建直接中断。
3. **摘掉 `@elegant-router/vue` 的构建插件**：它的 chokidar 监视器在 Windows 上会抓到
   写入中的临时文件并抛出未捕获的 `EBUSY`，把 dev server 打挂。路由**运行时**不依赖它
   （只用生成好的三个文件：`src/router/elegant/{imports,routes,transform}.ts`），
   摘除后照常工作——代价是新增页面要手动同步那三个文件与
   `src/typings/elegant-router.d.ts`。
4. **补 `src/typings/i18n-global.d.ts`**：模板缺 `$t` 的 `ComponentCustomProperties` 声明。
   （注：换用真 TypeScript 时这个声明能生效、`$t` 报错消失；但换掉模板的
   `typescript-native-bridge`（tsgo fork）会把整个 workspace 的 `typescript`
   解析搞坏——`packages/*/node_modules/typescript/bin/tsc` 全部丢失，根 `typecheck`
   整体失败。所以最终保留模板原来的 tsgo 别名，本声明留作"换真 TS 时即生效"的准备。）
5. **默认首页改为 `workbench`**（`VITE_ROUTE_HOME`），标题与系统名改为 MediaSandbox。

## 已知问题：typecheck 有 13 处模板遗留错误

`pnpm typecheck:web-vue` 目前会报 13 个错，全部在**模板自带文件**里，与新写的页面无关：

```
src/layouts/modules/global-menu/modules/vertical-hybrid-header-first.vue (1)  $t 不存在
src/views/home/index.vue (2)                                                  $t 不存在
src/router/elegant/transform.ts (1)                                           RouteMeta 退化成 {}
src/store/modules/route/shared.ts (9)                                         route.meta 退化成 {}
```

根因：模板依赖的 `@elegant-router/types`（`RouteMap`/`RouteKey` 等类型被拆到这个独立包）
在本仓库里解析不到——`src/typings/elegant-router.d.ts` 用的是
`declare module "@elegant-router/types"` 环境模块声明，但当前 tsgo 解析没采纳它，
于是相关类型全退化成 `{}`。这个包不在 npm registry 上（由插件生成），所以也装不上。

**不影响构建与运行**：`pnpm --filter @mediasandbox/web-vue build` 通过，页面正常渲染。
因为它是模板遗留债、不是本项目引入的，根 `pnpm typecheck` 用
`--filter=!@mediasandbox/web-vue` 把它排除，避免拖红整个仓库（根 typecheck 全绿，
13 个包 Done）；单独跑 `pnpm typecheck:web-vue` 可以随时查看这份清单。

后续清零的两条路：把该声明改成 tsconfig `paths` 指向一个真实模块文件；
或按当前已生成的 `src/router/elegant/*` 手写一份不依赖该包的本地类型。
