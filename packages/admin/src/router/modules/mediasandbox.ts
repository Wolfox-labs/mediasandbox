/**
 * MediaSandbox 的路由与菜单。
 *
 * 模板的路由是**自动导入** `src/router/modules/**` 下的 `.ts`（见 `router/index.ts`），
 * 所以这里只要导出一个模块即可，不需要去改路由注册表。
 *
 * 六个页面的分工：
 *   - 创作工作台  提交目标（含环境自动判定与成本闸门）、看实时步骤流与决策留痕
 *   - 结构画布    读一份结构、定点增删移（F5）
 *   - 素材管理    模板与 block 池（F4）
 *   - 运行与产物  运行流水、产物预览与下载、项目导出
 *   - 工具目录    可用工具及其环境/角色/成本
 *   - 沙盒与环境  健康检查、provider 列表
 */
const Layout = () => import("@/layout/index.vue");

export default {
  path: "/mediasandbox",
  name: "MediaSandbox",
  component: Layout,
  redirect: "/mediasandbox/workbench",
  meta: {
    icon: "ep/magic-stick",
    title: "创作台",
    rank: 1
  },
  children: [
    {
      path: "/mediasandbox/workbench",
      name: "MsWorkbench",
      component: () => import("@/views/mediasandbox/workbench/index.vue"),
      meta: { title: "创作工作台" }
    },
    {
      path: "/mediasandbox/structure",
      name: "MsStructure",
      component: () => import("@/views/mediasandbox/structure/index.vue"),
      meta: { title: "结构画布" }
    },
    {
      path: "/mediasandbox/assets",
      name: "MsAssets",
      component: () => import("@/views/mediasandbox/assets/index.vue"),
      meta: { title: "素材管理" }
    },
    {
      path: "/mediasandbox/runs",
      name: "MsRuns",
      component: () => import("@/views/mediasandbox/runs/index.vue"),
      meta: { title: "运行与产物" }
    },
    {
      path: "/mediasandbox/tools",
      name: "MsTools",
      component: () => import("@/views/mediasandbox/tools/index.vue"),
      meta: { title: "工具目录" }
    },
    {
      path: "/mediasandbox/sandbox",
      name: "MsSandbox",
      component: () => import("@/views/mediasandbox/sandbox/index.vue"),
      meta: { title: "沙盒与环境" }
    }
  ]
} satisfies RouteConfigsTable;
