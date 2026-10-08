> ## 本仓库的接入说明（非模板原文）
>
> 本包由 **MediaSandbox** 从 [pure-admin-thin](https://github.com/pure-admin/pure-admin-thin)
> `v6.2.0`（commit `f0ff132`，**MIT**）vendored 而来，用于与现有 React 前端
> （`packages/web`）**并存**，接结构化制作那一批新交互。许可证与署名保留在
> [LICENSE](./LICENSE)。
>
> **相对上游的改动（完整清单）**：
> 1. 包名 `pure-admin-thin` → `@mediasandbox/admin`
> 2. 删掉 `prepare: husky` 与 `preinstall: npx only-allow pnpm` 两个生命周期脚本，
>    并删掉 `.husky/` —— 否则安装时会改写**整个 monorepo** 的 git hook 配置
> 3. `dev` / `build` 去掉 `NODE_OPTIONS=--max-old-space-size=…` 前缀
>    （POSIX 写法在 Windows 的 cmd 下不成立，本仓库没开 shell emulator）
> 4. 未保留上游的 `pnpm-lock.yaml`（workspace 统一用仓库根锁文件）与 `.npmrc`
>    （其 `shamefully-hoist=true` 会摊平**整仓**依赖布局）。代价见第 5、6 条
> 5. 显式声明 `tippy.js`：上游靠摊平布局才解析得到它（`src/main.ts` 直接 import 了它的 CSS），
>    pnpm 隔离布局下必须自己声明
> 6. [build/cdn.ts](./build/cdn.ts) 改为导出工厂函数、[build/plugins.ts](./build/plugins.ts)
>    按 `VITE_CDN` 惰性构造。上游在**模块顶层**就调用 `importToCDN(...)`，而该调用会
>    **立刻**去读各模块 `package.json` 取版本号；`vue-demi` 不是直接依赖，于是在配置
>    加载阶段就报 `vue-demi package.json file does not exist` ——
>    `VITE_CDN ? cdn : null` 拦不住，因为实例在 import 时已经建好了
> 7. [build/plugins.ts](./build/plugins.ts) 去掉 `removeConsole` 的 `external` 选项（见坑一）
> 8. [src/assets/iconfont/iconfont.js](./src/assets/iconfont/iconfont.js) 里
>    `console && console.log(t)` 改为 `void t`
> 9. [src/components/ReIcon/src/iconifyIconOffline.ts](./src/components/ReIcon/src/iconifyIconOffline.ts)
>    加一处 `@ts-expect-error`：上游按旧签名写的 `addIcon(icon, icon)` 与
>    `@iconify/vue@4.2.0` 的 `addIcon(name: string, data: IconifyIcon)` 不匹配，
>    只屏蔽类型检查，**不改运行时行为**
>
> ### 怎么跑
>
> ```bash
> pnpm install                     # 在仓库根执行，admin 是 workspace 成员
> pnpm dev:admin                   # 开发服务器，默认 8848（见 .env）
> pnpm --filter @mediasandbox/admin build
> pnpm --filter @mediasandbox/admin typecheck
> ```
>
> 后端地址默认 `http://127.0.0.1:8787`，由 [vite.config.ts](./vite.config.ts) 的
> `server.proxy` 代理 `/api` 与 `/ws`；换后端设环境变量 `MEDIASANDBOX_BACKEND` 即可。
> **前端代码一律用相对路径**，不写死后端地址。
>
> ### 页面（`src/views/mediasandbox/`）
>
> | 路由 | 作用 |
> |---|---|
> | `/mediasandbox/workbench` | 创作工作台：提交目标（含**环境自动判定**与**成本闸门**）、实时步骤流、决策留痕、结构预览 |
> | `/mediasandbox/structure` | 结构画布：读一次运行的结构，定点增删移并**落库** |
> | `/mediasandbox/assets` | 素材管理：模板（沉淀/删除）与 block 池（分组浏览、注册自定义 block） |
> | `/mediasandbox/runs` | 运行与产物：项目视图、产物预览与下载、项目导出 ZIP、取消运行 |
> | `/mediasandbox/tools` | 工具目录：按环境筛选，标出「需授权」的工具 |
> | `/mediasandbox/sandbox` | 沙盒与环境：健康检查、provider、运行概览 |
>
> ### 两个会复发的坑
>
> **坑一、`removeConsole` 的 `external` 在本仓库永远失效。**
> 它把 `external` 用 `resolve(process.cwd(), x)` 变成绝对路径后，会经一个"路径规范化"
> 函数转成正斜杠，**但只要路径含非 Latin-1 字符（本仓库路径是中文）就原样返回、保留
> 反斜杠**；而 Vite 传进来的模块 id 是正斜杠形式，于是 `includes(id)` 恒为 false。
> 已用脚本复现：中文路径命中 `false`、英文对照路径命中 `true`。
> 后果是 `iconfont.js` 被照常剥离，而它把 `console` 当值用，剥离后成 `console && ;`，
> Rollup 直接报 `Expression expected`，**构建失败**。
> 因此本项目里**不要写** `console && x()`、`if (console)`、`console?.log()` 这类把
> console 当值用的代码；普通 `console.log(...)` 语句没问题（构建期被移除，符合预期）。
>
> **坑二、不要开 `shamefully-hoist`。** 上游默认摊平 node_modules，本仓库没摊平，
> 于是每一个"未声明的依赖"都会在构建时暴露（第 5、6 条就是这么发现的）。
> 这其实是好事，但升级模板时要留意同类问题。
>
> ### 已验证 / 未验证
>
> 已验证（本机实测）：`install`、`build`、`typecheck` 全绿；dev 服务器起得来；
> `/api` 与 `/ws` 两条代理都通（WebSocket 实测收到 `run_started` / `attempt_started` /
> `plan_assembled`）；六个新页面的模块都能被 Vite 编译；结构读改契约与
> `GET /api/runs/:id/structure`、`POST /api/runs/:id/structure/ops` 实测一致
> （含 400 与 409 两条错误路径）。
>
> **未验证**：浏览器里的实际渲染与交互 —— 本机没有可用的浏览器驱动，
> 只验证到"能编译 + 接口契约对得上"，**没有点过界面**。
> 上游 `lint:*` 系列脚本依赖 POSIX 花括号展开，没有跑过。
>
> **已知接不上的一处**：「改完结构重新生成」不可用。后端 `POST /api/runs` 目前还没有
> 读取 `pageSpec`（解析层 `parsePageSpecInput` 已实现，入口尚未接上）；
> 结构化编辑本身会立刻落库、重启后仍在，但要让改动体现到产物上还需要那个入口。
> 结构画布页已据实标注，没有做成假按钮。

<h1>vue-pure-admin精简版（非国际化版本）</h1>

[![license](https://img.shields.io/github/license/pure-admin/vue-pure-admin.svg)](LICENSE)

**中文** | [English](./README.en-US.md)

## 介绍

精简版是基于 [vue-pure-admin](https://github.com/pure-admin/vue-pure-admin) 提炼出的架子，包含主体功能，更适合实际项目开发，打包后的大小在全局引入 [element-plus](https://element-plus.org) 的情况下仍然低于 `2.3MB`，并且会永久同步完整版的代码。开启 `brotli` 压缩和 `cdn` 替换本地库模式后，打包大小低于 `350kb`

## 版本选择

当前是非国际化版本，如果您需要国际化版本 [请点击](https://github.com/pure-admin/pure-admin-thin/tree/i18n)

## 配套视频

[点我查看 UI 设计](https://www.bilibili.com/video/BV17g411T7rq)  
[点我查看快速开发教程](https://www.bilibili.com/video/BV1kg411v7QT)

## 配套保姆级文档

[点我查看 vue-pure-admin 文档](https://pure-admin.cn/)  
[点我查看 @pureadmin/utils 文档](https://pure-admin-utils.netlify.app)

## 高级服务

[点我查看详情](https://pure-admin.cn/pages/service/)

## 预览

[查看预览](https://pure-admin-thin.netlify.app/#/login)

## 维护者

[xiaoxian521](https://github.com/xiaoxian521)

## ⚠️ 注意

精简版不接受任何 `issues` 和 `pr`，如果有问题请到完整版 [issues](https://github.com/pure-admin/vue-pure-admin/issues/new/choose) 去提，谢谢！

## 许可证

[MIT © 2020-present, pure-admin](./LICENSE)
