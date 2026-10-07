# MediaSandbox

**通用 Agent 沙盒**：用户给一个目标，系统自己排布工具链、在隔离环境里执行、产出交付物。

> 仓库名 `MediaSandbox` 是项目早期的历史包袱，不代表能力边界。沙盒本身是**领域无关**的——
> `SandboxProvider` 不关心跑的是网页、图像还是别的什么，差异全部收敛在 `envType` 这一层
> 环境预设里。当前预置 `frontend` / `image` / `copy` 三类，这是**起步配置，不是范围上限**。

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
pnpm -r test          # 204 项测试
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
pnpm start   # 终端 1：后端
pnpm dev     # 终端 2：前端 → http://127.0.0.1:5173/
```

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

---

## 测试

```bash
pnpm -r test
```

| 包 | 项数 | 覆盖 |
|---|---:|---|
| sandbox | 49 | provider 一致性 18 项 × 两个实现、容器隔离约束、产物判定 |
| orchestrator | 129 | 决策契约、注册表、组装器、执行器、兜底、LLM 客户端（含图像端点）、端到端 |
| server | 26 | REST、WebSocket、双 provider 一致性、沙盒保留策略、ZIP 写入器 |

共 **204 项，0 失败**（1 项按环境如实跳过）。

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
| **目标分类未实现** | `envType` 由调用方指定，决策层没参与"这是什么类型的任务"的判断 |
| `score` / `numeric` | 实现了但从未被使用，是纯储备代码 |
| Docker exec 流分离 | 按 Docker 多路复用帧格式解帧。若容器分配 TTY，帧格式不同，当前实现不处理 |
| 宿主 `python` | 本机 `python` 指向 WindowsApps 存根（假壳）。容器内的 python 是真的 |
| `registry-mirrors` | 对短名拉取不生效，Dockerfile 的 `FROM` 必须写完整前缀 |
| 单实例 | 服务无持久化，重启后运行记录丢失；沙盒句柄需重新 `adopt()` |
| 无队列 | 多个请求并发执行，无上限 |

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

- [docs/系统说明.md](docs/系统说明.md) —— **面向评审**：它是什么、怎么用、怎么做的、怎么验证的
- [架构说明.md](架构说明.md) —— 详细的实现说明与踩坑记录
- [架构与业务逻辑.md](架构与业务逻辑.md) —— 与设计蓝图的逐条对照，含偏差清单
- [docs/screenshots/](docs/screenshots) —— 界面截图
