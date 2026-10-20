# MediaSandbox

**通用 Agent 沙盒**：用户给一个目标，系统自己排布工具链、在隔离环境里执行、产出交付物。

> 仓库名 `MediaSandbox` 是项目早期的历史包袱，不代表能力边界。沙盒本身是**领域无关**的——
> `SandboxProvider` 不关心跑的是网页、图像还是别的什么，差异全部收敛在 `envType` 这一层
> 环境预设里。当前预置 `frontend` / `image` / `copy` / `webpage` / `slides` 五类，
> 这是**起步配置，不是范围上限**。

---

## 它解决什么问题

用户丢进来一个目标（"做个产品介绍网页"），系统自动完成：

```
目标 → 决策层选工具 → 确定性代码拼 DAG → 沙盒里执行 → 生成 → 产物
```

**职责分界**（这是设计地基，不要混）：

| 层 | 谁来做 | 做什么 |
|---|---|---|
| 决策层 | 本地 Jev 类模型 | **只回答封闭问题**：选哪个工具、要不要校验、几个步骤 |
| 编排层 | **确定性代码** | 把答案组装成 DAG 并执行。不调用模型做规划 |
| 生成层 | 第三方多模态 API | 真正生成文本 / 图像 / 代码 |
| 执行层 | 沙盒 | 隔离运行，管控网络、文件、资源 |

**关键约束**：决策层模型**不生成文本、不产出自由形式的计划**。它只在有限候选集里选一个值。
把答案拼成执行流程是确定性代码的活——这保证了行为可复现、可测试、可兜底。

---

## 快速开始

需要 **Node ≥ 24** 与 **pnpm ≥ 11**。

```bash
pnpm install
pnpm -r build
pnpm -r test          # 608 项测试（604 通过 / 4 按环境跳过）
```

### 起服务

```bash
cp .env.example .env   # 按需填写（生成层 key 等，全部可选）
pnpm start             # → http://127.0.0.1:8787/
```

打开浏览器就是**创作工作台**。前端由后端一并托管，所以只有一个地址，
不需要另起前端服务。

### 四种运行模式

| 模式 | 配置 | 用途 |
|---|---|---|
| **纯离线演示** | `MEDIASANDBOX_DECISION=stub`，不配 LLM | 无任何外部依赖，跑通全链路（产物是占位文本） |
| **演示模式**（默认） | `MEDIASANDBOX_DECISION=demo` + 配 LLM | 关键词选工具 + 真实内容生成 |
| **接真实决策模型** | `MEDIASANDBOX_DECISION=rizzo` | 需先部署 [rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow) |
| **容器隔离** | `SANDBOX_PROVIDER=docker` | 跑不可信代码时用 |

`demo` 是按目标关键词选工具的**演示替身**，不是决策模型 —— 它存在的意义是让
演示链路自洽（"做一个网页"确实产出网页，而不是按字母序选中文案工具）。
真实模型接上后它完全不参与。

### 也可以只用 API

```bash
curl -X POST http://127.0.0.1:8787/api/runs \
  -H 'content-type: application/json' \
  -d '{"goal":"写一段产品介绍","envType":"copy"}'
# → {"runId":"run-...","status":"queued"}

curl http://127.0.0.1:8787/api/runs/<runId>
```

### 前端开发模式

改前端时用 Vite 热更新（`/api` 与 `/ws` 自动代理到后端）：

```bash
pnpm start     # 终端 1：后端 → http://127.0.0.1:8787/
pnpm dev       # 终端 2：React 工作台 → http://127.0.0.1:5173/
pnpm dev:admin # 终端 2 的另一选择：Vue 管理端 → http://127.0.0.1:8848/
```

**两套前端并存**（设计稿的"先并存后切换"）：`packages/web`（React）是后端托管的那套；
`packages/admin`（Vue 3 + Element Plus，由 pure-admin-thin 模板落成）是新的管理端，
结构化制作这批新交互只在它上面做。管理端目前**只跑在开发服务器上**，尚未由后端托管；
它访问的后端地址由 Vite 代理给 `http://127.0.0.1:8787`（可用 `MEDIASANDBOX_BACKEND` 覆盖）。
详见 [packages/admin/README.md](packages/admin/README.md)。

### Docker 沙盒

```powershell
# 构建三套镜像（构建后会起容器跑探针，验证运行时真的可用）
pwsh -File scripts/build-images.ps1

# 让服务用容器 provider
$env:SANDBOX_PROVIDER='docker'
```

> **注意**：Dockerfile 里的 `FROM` 写的是完整镜像源前缀。本机实测 `registry-mirrors`
> 对短名拉取不生效，写 `node:22-alpine` 会去 `registry-1.docker.io` 直连并超时。

---

## 架构

```
packages/
├── web/             前端工作台（React 18 + Vite + Tailwind）
│   ├── api/                   REST 客户端 + 与后端对齐的类型
│   ├── hooks/useRunStream     WebSocket 订阅 + 断线重连
│   ├── state/                 事件流 → 视图模型（纯函数折叠）
│   ├── features/workbench/    ★ 创作工作台（决策过程 + 分层步骤）
│   ├── features/projects/     项目与产物（文件树 + ZIP 导出 + 模板）
│   ├── features/preview/      实时预览（网页 / 图片 / 文本）
│   ├── features/sandbox/      沙盒环境管理
│   └── features/tools/        工具链（候选集可视化）
│
├── admin/           管理端（Vue 3 + Element Plus，由 pure-admin-thin 模板落成，与 web 并存）
│   ├── api/mediasandbox/      REST 客户端 + 与后端对齐的类型 + 事件流折叠（纯函数）
│   ├── composables/           useRunStream（WebSocket 订阅 + 断线重连）
│   ├── router/modules/        六个页面的路由与菜单（自动导入）
│   └── views/mediasandbox/    创作工作台 / 结构画布 / 素材管理 / 运行与产物 / 工具目录 / 沙盒
│
├── sandbox/         沙盒抽象 + 两个实现
│   ├── types.ts               ★ SandboxProvider 接口
│   ├── local/                 LocalSandbox（路径级隔离）
│   ├── docker/                DockerSandbox（真隔离）
│   ├── images/                三套 Dockerfile
│   └── testing/               provider 一致性套件
│
├── orchestrator/    编排核心
│   ├── decision/              决策层契约 + rizzo 客户端 + 桩 + 演示层
│   ├── tools/                 工具注册表 + 11 个内置工具
│   ├── plan/                  DAG 组装器 + 执行器
│   ├── fallback/              兜底状态机
│   ├── llm/                   OpenAI 兼容客户端 + 双端点路由器
│   └── orchestrator.ts        ★ 编排入口
│
└── server/          HTTP + WebSocket 服务（托管前端产物）
    └── zip.ts                 自写 ZIP 写入器（导出产物用）
```

### 前端：决策过程可见

普通对话式 AI 只给结果，本工作台把**过程**摊开：

| 面板 | 展示什么 |
|---|---|
| 决策过程 | 组装依据（选了哪个工具、为什么）、每次尝试、重试与换方案 |
| 执行步骤 | 按依赖分层，同层标注"并发 N 个"——这解释了"为什么失败时兄弟节点会跑完" |
| 实时预览 | 网页走 iframe（沙盒化，产物脚本碰不到工作台）、图片、文本双视图 |

四个标签页：**创作工作台**（过程）、**项目与产物**（成果归集与导出）、
**沙盒环境**（隔离约束）、**工具链**（候选集）。工作台盯"这一次运行"，
项目页盯"这个项目攒下了什么"—— 一个项目可能跑过多次。

事件流用**纯函数从零折叠**（一次运行几十条事件，量很小），换来的是无状态：
不用管乱序、不用管重连补发重复，同样的输入永远得到同样的视图。

### 两个核心抽象

**`SandboxProvider`** —— 上层编排代码只依赖这个接口，两个实现可互换：

| | LocalSandbox | DockerSandbox |
|---|---|---|
| 隔离强度 | 路径级 | 容器级 |
| 网络 | 不限制 | `none`（默认无网卡） |
| 文件 | 目录边界 + 符号链接校验 | 只挂载工作区 |
| 资源 | 无 | 内存 / CPU / PID 配额 |
| 根文件系统 | — | 只读 |
| 用途 | 开发、测试、降级 | 执行不可信代码 |

**"适配完成"的定义**：同一套 `provider-suite`（18 项）在两个实现上**都全绿**。
这不是形式要求——正是它让 DockerSandbox 写完后不需要重新想测什么。

**`DecisionClient`** —— 对接 rizzo-flow 的 `POST /v1/systemone`：

| 原语 | 用途 |
|---|---|
| `noul` | 二值判定（要不要某能力） |
| `choice` | 有限选项单选（选工具 / 技术栈） |
| `score` | 标量打分（执行结果好坏） |
| `numeric` | 数值估计（步骤数） |

三个设计要点：

1. **批量是主接口**。一次请求带多个问题共享同一次 prefill，
   官方数据：21 问批量 1.0s vs 逐问 8.1s。
2. **弃权是合法输入**。模型答"不知道"时 `value` 为 `null`，
   兜底按确定性默认继续，**不当错误**。
3. **候选集来自工具注册表**。所以**扩展工具链 = 改注册表，不需要重训模型**。

### 兜底策略（确定性，不用模型）

```
执行失败 ─→ 重试（≤3 次） ─→ 换方案 ─→ 熔断转人工
```

**刻意不用概率模型**：兜底逻辑若依赖模型，就会在失败时二次失败——而它存在的意义
正是在事情已经出错时可靠地做决定。

---

## 工具

内置 11 个工具。每类环境都提供**两条路线**，这是刻意设计：

| 路线 | 例子 | 特点 |
|---|---|---|
| 生成式 | `draft-copy` / `render-image` / `scaffold-frontend` | 质量高，慢，有成本 |
| 确定性 | `template-copy` / `solid-image` / `static-page-from-template` | 朴素，零延迟，零成本，完全可复现 |

有两条路线，`choice` 才有真实的选择可做；而且**生成层不可用时确定性路线就是降级方案**。

所有产物写入沙盒的 `artifacts/`。空文件与 `.gitkeep` 之类的占位文件**不算产物**。

### 结构化制作（`webpage` 环境）

另有两个只在 `webpage` 环境装配的工具，把"做网页"从"调一次大模型吐 HTML"
变成**决策模型逐块决定结构**：

| 工具 | 作用 |
|---|---|
| `fill-block` | 填充**一个**区块。每块一个节点 → 同层并发、独立重试、可定点重做 |
| `assemble-page` | 把各块的产出**扇入**组装成整页，顺序即页面顺序 |

`webpage` 与既有 `frontend` 并存，单链路径未改动。详见
[docs/结构化制作链路设计.md](docs/结构化制作链路设计.md)。

### 演示文稿（`slides` 环境）

第二种结构化模态。同样是"版式池 + 决策模型逐个选"，但单元是**版式**、
一次产出是**多页**：

| 工具 | 作用 |
|---|---|
| `fill-slide` | 填充**一页**。每页一个节点 → 同层并发、独立重试 |
| `assemble-deck` | 把各页扇入组装成一份文稿，写 `artifacts/deck.html` 与 `artifacts/deck.json` |
| `screenshot-deck` | 把首页截成 `artifacts/deck.png`（显式要求才跑） |

产物是**可放映的 16:9 HTML 演示文稿**（方向键翻页、浏览器打印成一页一张的 PDF），
**不是 `.pptx` 文件**——边界写在 [docs/两个模型与第二种模态.md](docs/两个模型与第二种模态.md) 里。
它与 `webpage` 的版式池是**两个注册表**，id 不重叠，互不污染。

### 两个模型的分工

网页与演示文稿两条链路都会先跑**统筹规划**：

| 角色 | 谁 | 输出 |
|---|---|---|
| 统筹规划 | 生成层（`LlmClient`，开放生成） | 一份内容计划：要讲哪几段、建议用什么块 |
| 结构决策 | 决策层（`DecisionClient`，封闭问题） | 逐轮选块 / 页，回答"还要不要继续""要几项" |

规划**不选块**——它只写"要讲哪几段"，选哪个仍由决策层的 `choice` 回答。
计划以 `facts` 形式进入决策上下文，并在结果里与定稿结构并列展示，
带一行"计划 3 段，实际 4 块，对得上"的对照。规划不可用时如实写明原因，
不伪造计划，也不让整次运行失败。详见
[docs/两个模型与第二种模态.md](docs/两个模型与第二种模态.md)。

---

## 数据落在哪

三处，职责分明——**工作区是临时空间，交付物与记录是成果**：

| 目录 | 内容 | 生命周期 |
|---|---|---|
| `workspaces/` | 沙盒工作区（跑一次留一个） | 按 `SANDBOX_RETENTION` 回收（默认最近 20 个） |
| `projects/<项目>/runs/<runId>/` | **交付物落定副本** | 不随沙盒回收消失 |
| `data/` | 运行记录、事件流水、自定义 block、沉淀的模板 | 长期；启动时读回 |

`data/` 的布局：

```
data/runs/<runId>/meta.json        运行状态（含结构与逐轮决策留痕）
data/runs/<runId>/events.ndjson    事件流水，一行一条、追加式
data/blocks.json                   用户手打 / 导入 / 提议的 block
data/templates.json                从历史沉淀的模板
```

想换个位置就设 `MEDIASANDBOX_DATA`。这三处都在 `.gitignore` 里。

---

## 测试

```bash
pnpm -r test
```

| 包 | 项数 | 覆盖 |
|---|---:|---|
| sandbox | 49 | provider 一致性 18 项 × 两个实现、容器隔离约束、产物判定 |
| orchestrator | 381 | 决策契约、注册表、组装器、执行器、兜底、LLM 客户端（含图像端点）、结构化链路（block 池 / 逐块决策 / 填充 / 渲染 / 模板 / 版式规范化）、端到端 |
| server | 57 | REST、WebSocket、双 provider 一致性、沙盒保留策略、ZIP 写入器、**JSON 落盘与重启重建**、交付物落定 |

共 **608 项，0 失败**（4 项按环境如实跳过：3 项要 Docker、1 项要宿主 `python`）。
数字会随改动增长，以 `pnpm test` 的实际输出为准。

**几个刻意设计的测试**：

- **契约测试**：一套用例跑遍所有实现。任何一边挂掉，说明抽象漏了。
- **环境缺失如实跳过**：例如宿主 `python` 是 WindowsApps 存根时，相关用例 `skip`
  并说明原因，**不假装通过**。
- **双 provider 产物一致性**：同一目标在 Local 与 Docker 上产出的文件
  **SHA-256 逐字节相同**。这是沙盒抽象成立与否的最终验收。
- **穷举回归**：`envType × 主产出 × 打磨 × 收尾` 共 54 种组合全部组装并校验，
  任一组合出现非法端口引用即失败。

---

## 已知限制

| 项 | 说明 |
|---|---|
| **目标分类：能力已实现，旧界面无入口** | 决策层会判定任务类型并在流水里留痕（`env_classified`，含判定依据与来源）；Vue 管理端可选「自动判定」并显示留痕。旧的 React 工作台仍需手动指定环境 |
| **管理端只跑在开发服务器上** | `packages/admin` 目前不随后端一起托管（后端托管的是 React 产物），要 `pnpm dev:admin` 另起。设计稿的"覆盖完再下线旧前端"这一步没做 |
| **改完结构不能重新生成** | 结构编辑（增删移）会立刻落库、重启后仍在；带上 `pageSpec` 提交也能照给定结构跑；但**把编辑结果一键丢回一次新运行**还没有入口（工作台仍要手工拼 `pageSpec`） |
| 自定义 block 的渲染 | **不是占位块**：`renderCustomBlock()` 会按 slot 声明推出 title / text / code / link / image / list 版式。但它只能按声明推，**没有专属版式**——想要精细排版得把它做进内置类型 |
| 沙盒句柄不跨重启 | 运行记录已落盘（重启后还在、产物也下载得到），但 `DockerSandbox.adopt()` 不在接口里，重启后无法接管旧容器 |
| 模板与 block 无版本管理 | 改了模板，已有项目不会跟着变（也不该变，但"怎么办"还没定） |
| Docker exec 流分离 | 按 Docker 多路复用帧格式解帧。若容器分配 TTY，帧格式不同，当前实现不处理 |
| 宿主 `python` | 本机 `python` 指向 WindowsApps 存根（假壳）。容器内的 python 是真的 |
| `registry-mirrors` | 对短名拉取不生效，Dockerfile 的 `FROM` 必须写完整前缀 |
| 交付物只增不减 | `projects/` 里的落定副本不会被自动清理。这是刻意的取舍（原先"回收交付物"是反的），但需要一个清理策略（`PROJECTS_RETENTION` 配了额度才清） |
| 排队不跨重启 | 并发有上限、超出会排队（`MAX_CONCURRENT_RUNS` / `RUN_QUEUE_LIMIT`），但队列只在内存里：服务重启后排队中的运行**不会**自己复活，会被如实标成"已取消（服务重启）"。这是刻意的——宁让人重新提交，也不做"幽灵运行" |

---

## 合规声明

本项目使用 [rizzo-flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)（Apache-2.0），
这是一个**独立的第三方开源项目，与 TypeSafe 无关联**。其权重底座为 **Spark-X2.5**，
**并非 TypeSafe Jev 的官方权重**。"Jev" 与 "TypeSafe" 商标归 TypeSafe 所有。

| 组件 | 许可证 |
|---|---|
| rizzo-flow | Apache-2.0 |
| Spark-X2.5（4B / 1.7B） | Apache-2.0 |
| llama.cpp | MIT |

---

## 相关文档

> **约定：文档与实现不符按缺陷处理，随改动同批修。**
>
> 这条不是口号——判断标准是"文档里每一条能力陈述都能在代码或测试里找到落点"。
> 找不到落点的陈述要么改文档、要么补代码，不许两边各说一套：
> 评审时被问到"这里写着未开始，代码里怎么已经跑了"，比功能没做更难看。

- [docs/系统说明.md](docs/系统说明.md) —— **面向评审**：它是什么、怎么用、怎么做的、怎么验证的
- [架构说明.md](架构说明.md) —— 详细的实现说明与踩坑记录
- [docs/设计文档.md](docs/设计文档.md) —— **目标形态**（动工前一天的蓝图）：描述设想中的系统，与代码有 11 条偏差
- [架构与业务逻辑.md](架构与业务逻辑.md) —— 与设计蓝图的逐条对照，含偏差清单
- [docs/结构化制作链路设计.md](docs/结构化制作链路设计.md) —— block 级制作链路的设计与实现状态
- [docs/两个模型与第二种模态.md](docs/两个模型与第二种模态.md) —— 统筹规划与结构决策的分工、演示文稿模态怎么加
- [docs/用户要求与协作经验.md](docs/用户要求与协作经验.md) —— **接手前必读**：用户的硬性约束、架构主张、协作纠正
- [docs/screenshots/](docs/screenshots) —— 界面截图（根目录是旧 React 界面；[vue/](docs/screenshots/vue) 是当前 Vue 步骤页工作台）
