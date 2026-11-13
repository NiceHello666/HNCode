![HNCode](imgs/HNCode.png)

---

# HNCode Wiki

[English](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI.md) | 简体中文 | [返回 README](https://github.com/NiceHello666/HNCode/blob/main/README_CN.md)

HNCode 的完整文档 —— 一个运行在终端用户界面（TUI）里的 AI 编程助手。

---

## 目录

1. [HNCode 是什么](#1-HNCode-是什么)
2. [环境要求](#2-环境要求)
3. [安装](#3-安装)
4. [首次运行](#4-首次运行)
5. [配置](#5-配置)
   - [5.1 基础：全部在 TUI 里配置](#51-基础全部在-tui-里配置)
   - [5.2 进阶：手写 config.toml](#52-进阶手写-configtoml)
   - [5.3 环境变量](#53-环境变量)
6. [命令行接口](#6-命令行接口)
7. [斜杠命令](#7-斜杠命令)
8. [快捷键](#8-快捷键)
9. [工具集](#9-工具集)
10. [权限模式](#10-权限模式)
11. [上下文管理与自动压缩](#11-上下文管理与自动压缩)
12. [会话](#12-会话)
13. [插件系统](#13-插件系统)
   - [最小的可用插件](#最小的可用插件)
   - [确认它加载了](#确认它加载了)
   - [注册斜杠命令](#注册斜杠命令)
   - [注册钩子](#注册钩子)
   - [API 完整一览](#api-完整一览)
   - [容易踩的坑](#容易踩的坑)
14. [技能（Skills）](#14-技能skills)
15. [从仓库安装技能与插件](#15-从仓库安装技能与插件)
16. [开发者指南](#16-开发者指南)
17. [故障排查](#17-故障排查)
18. [致谢](#18-致谢)
19. [许可证](#19-许可证)

---

## 1. HNCode 是什么

HNCode 是一个住在终端里的编程助手。你描述一个任务，它就会读写文件、执行 shell 命令、搜索代码库、抓取网页，并一直工作到任务完成 —— 具体行为取决于你选择的权限模式。

它灵感源自 [Kimi Code](https://github.com/MoonshotAI/kimi-code)，思路类似：使用原始终端（而非 `blessed`）渲染的青色蓝调 TUI、由模型驱动的工具调用循环，以及来自 OpenAI 兼容端点或 Anthropic 的流式响应。

主要特点：

- **这是 TUI**：这是一个交互式全屏界面。同时也提供非交互的 `-p` 提示模式，方便脚本调用。
- **双协议**：OpenAI 兼容（`/chat/completions`）和 Anthropic（`/messages`）。
- **零运行时依赖**：纯 Node.js，无原生模块，无第三方包。
- **不绑定模型**：任何遵循 OpenAI 或 Anthropic 线格式的服务都能用。

---

## 2. 环境要求

- **Node.js ≥ 20**
- 一个终端。Windows 上推荐 **Windows Terminal**。
- 至少一个服务商的 API Key（OpenAI 兼容或 Anthropic）。

> **Windows 提示**：最好安装 [Git for Windows](https://gitforwindows.org/)，以便需要 POSIX shell 的工具能找到 `bash`。

---

## 3. 安装

### 全局安装（推荐）

```bash
npm install -g @hncode/hncode
hncode
```

### 免安装运行

```bash
npx @hncode/hncode
```

### 安装钩子

包声明了两个 npm 生命周期脚本：

| 脚本 | 文件 | 作用 |
|------|------|------|
| `preinstall` | `bin/preinstall.js` | 检查 Node ≥ 20，打印平台，若已全局安装则给出提示。 |
| `install` | `bin/install.js` | 创建 `~/.hncode/`（含 `config.toml`、`sessions/`、`plugins/`），写入初始配置，然后提示如何在 Windows / macOS / Linux 上刷新 shell 的 `PATH`。 |

两个脚本都不会执行你的代码、也不会联网，只会在本地创建目录和一个默认配置文件。

### 从源码安装

```bash
git clone https://github.com/NiceHello666/HNCode.git
cd hncode
npm link          # 全局暴露 `HNCode` 命令
```

---

## 4. 首次运行

1. 启动 `HNCode`。首次运行时安装脚本已创建 `~/.hncode/config.toml`。
2. **在 TUI 里**添加服务商：运行 `/provider`，挑选已知服务商（或添加自定义服务商），粘贴你的 API Key。模型会自动登记。（如果你已设置 `HNCODE_API_KEY`，此步可跳过。）
3. 输入任务，按 **Enter**。

详见[配置](#5-配置)。

界面分为：

- **对话区**（顶部）：你的消息、模型的回答，以及每次工具调用及其结果。
- **待办面板**：当助手在跟踪任务时出现。
- **输入框**（底部）：你打字的地方。
- **状态行**：模型、权限模式、思考强度、工作目录。
- **上下文行**（最底）：实时的 token 用量 / 上下文窗口。

---

## 5. 配置

HNCode **只**读取 `~/.hncode/config.toml`（以及 `HNCODE_*` 环境变量），不会读取其他产品的配置。

**通常你不需要手写这个文件。** 服务商和模型都可以在 TUI 里配置，HNCode 会替你写入 `config.toml`。直接编辑 TOML 属于*进阶*用法 —— 适合脚本化部署、特殊端点，或向导没暴露的设置。

### 5.1 基础：全部在 TUI 里配置

在 HNCode 打开时运行这些斜杠命令：

| 命令 | 作用 |
|------|------|
| `/provider` | 管理服务商 —— **添加**、**编辑**或**删除**。 |
| `/model` | 选择模型，或在已添加的模型之间切换。 |
| `/effort [off\|on\|high\|medium\|low]` | 设置当前模型的思考强度。 |

**添加服务商**（`/provider` → Add）：

- 从 [models.dev](https://models.dev) 目录挑选**已知服务商** —— base URL 会自动预填，或
- 添加**自定义服务商** —— 你自己提供名称、base URL、API Key 和协议（`OpenAI` 或 `Anthropic`）。

保存后，HNCode 会调用该服务商的 `/models` 端点并**自动登记所有模型**，同时记录各自的上下文窗口和思考能力。你事先不需要知道这些。

**编辑服务商**（`/provider` → 在某个服务商上按 Enter）可以修改它的名称、base URL、API Key 和协议类型。

所有改动都会立即持久化到 `~/.hncode/config.toml`，重启后依然有效。

### 5.2 进阶：手写 `config.toml`

`~/.hncode/config.toml` 包含三部分：顶层默认值、`[providers.*]` 和 `[models.*]`。

最小示例：

```toml
default_model = "gpt-4o-mini"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "sk-..."

[models.gpt-4o-mini]
provider = "openai"
model = "gpt-4o-mini"
```

**服务商** —— `[providers.<name>]`：

| 键 | 含义 |
|----|------|
| `base_url` | Base URL。HNCode 会追加 `/chat/completions`（OpenAI）或 `/messages`（Anthropic）。 |
| `api_key` | 该服务商的密钥。 |
| `protocol` | `openai`（默认）或 `anthropic`。 |

**模型** —— `[models.<alias>]`：

| 键 | 含义 |
|----|------|
| `provider` | 该模型所属的服务商。 |
| `model` | 发送给 API 的字面模型 id。 |
| `display_name` | 界面上显示的友好名称。 |
| `context_length` | 上下文窗口（token），用于驱动上下文计量。 |
| `max_tokens` | 最大输出 token。 |
| `efforts` | 可选思考强度数组，例如 `["low","medium","high"]`。 |
| `reasoning` | `true`/`false`，模型是否能思考。 |
| `always_thinking` | 为 `true` 时思考无法关闭。 |

改完文件后运行 `/reload` 即可生效，无需重启。

### 5.3 环境变量

下面的每一项都会**覆盖** `config.toml` 里的同名设置 —— 适合 CI，或避免把密钥写进文件：

| 变量 | 含义 |
|------|------|
| `HNCODE_API_KEY` | API 密钥。 |
| `HNCODE_PROVIDER` | 要使用的服务商名。 |
| `HNCODE_MODEL` | 要使用的模型别名。 |
| `HNCODE_BASE_URL` | 覆盖 base URL。 |
| `HNCODE_PROTOCOL` | `openai` 或 `anthropic`。 |
| `HNCODE_MAX_CONTEXT` | 覆盖上下文窗口大小（token）。 |
| `HNCODE_MAX_OUTPUT` | 覆盖单次请求最大输出 token。 |
| `HNCODE_REASONING` | `1`/`true` 标记模型具备推理能力。 |
| `HNCODE_SYSTEM_PROMPT` | 覆盖系统提示词。 |
| `HNCODE_CALM_MODE` | `1`/`true` 开启简洁模式。 |
| `HNCODE_ALLOW_EXTERNAL` | `1` 允许工具访问工作区之外的路径。 |
| `HNCODE_CONFIG` | 备用配置文件路径（供 `doctor config` 使用）。 |
| `HNCODE_SESSIONS_DIR` | 会话保存目录。 |
| `HNCODE_PLUGINS` | 插件目录。 |

---

## 6. 命令行接口

```
HNCode [options] [command]
```

### 选项

| 选项 | 说明 |
|------|------|
| `-V, --version` | 打印版本号。 |
| `-S, --session [id]` | 恢复会话（可带 id，或交互选择）。 |
| `-c, --continue` | 继续**当前目录**最近的会话。 |
| `-y, --yolo` | Ask When Needed：工作区内的编辑/命令自动执行；工作区外路径与破坏性命令仍会询问。 |
| `--auto` | Never Ask：全部自动执行。 |
| `-m, --model <model>` | 本次调用使用的模型别名。 |
| `-p, --prompt <prompt>` | 非交互式运行一次提示并打印回复。 |
| `--output-format <format>` | 提示模式输出：`text`（默认）或 `stream-json`。 |
| `--plan` | 以 plan 模式启动（只研究，不写入）。 |
| `--add-dir <dir>` | 额外的工作区目录，可重复。 |
| `-h, --help` | 显示帮助。 |

### 子命令

| 命令 | 说明 |
|------|------|
| `session list` | 列出会话（最新在前）。 |
| `provider list` | 显示已配置的服务商及其模型数量。 |
| `doctor config [path]` | 校验 `config.toml`。 |
| `init` | 创建带默认值的 `~/.hncode/config.toml`。 |
| `export [id]` | 导出会话到 `~/.hncode/export/<id>.json`。 |

### 无头模式

```bash
HNCode -p "解释一下 src/agent.js 做什么"
HNCode -p "列出 TODO" --output-format stream-json
```

`stream-json` 模式下，每个事件打印为一行 JSON 对象，方便管道传给其他工具。

---

## 7. 斜杠命令

在输入框中输入 `/` 打开命令菜单；**Tab** 补全，**Enter** 运行。

### 会话与工作区

| 命令 | 别名 | 说明 |
|------|------|------|
| `/new` | `/clear` | 在当前工作区新建会话（并清空待办面板）。 |
| `/sessions` | `/resume` | 浏览并恢复**当前目录**的历史会话。 |
| `/fork` | — | 把当前会话复制成新会话（不切换过去）。 |
| `/title <title>` | `/rename` | 设置（或显示）会话标题；同时设置终端窗口标题。 |
| `/move <path>` | — | 把当前会话迁移到另一个已存在的目录。 |
| `/add-dir [list] \| <path>` | — | 添加或列出额外的工作区目录。 |
| `/undo [count]` | — | 从对话中撤回最近若干条提示。 |
| `/init` | — | 分析代码库并生成 `AGENTS.md`。 |
| `/export-md [path]` | `/export` | 把当前会话导出为 Markdown 文件。 |
| `/import-session <file.md>` | `/import` | 把 Markdown 文件附加到提示中，让模型无需工具调用即可读取。 |

### 模型与服务商

| 命令 | 别名 | 说明 |
|------|------|------|
| `/model <name>` | — | 切换模型。单独 `/model` 打开选择器。 |
| `/provider` | `/providers` | 添加 / 编辑 / 删除服务商。 |
| `/effort [off\|on\|high\|medium\|low]` | `/thinking` | 切换思考强度。 |
| `/logout` | `/disconnect` | 登出已配置的服务商。 |
| `/reload` | — | 重新加载 `config.toml`。 |

### 行为

| 命令 | 别名 | 说明 |
|------|------|------|
| `/ask` | `/manual` | Always Ask 模式。 |
| `/yolo` | `/yes` | Ask When Needed 模式。 |
| `/auto` | — | Never Ask 模式。 |
| `/plan [on\|off\|clear]` | — | Plan 模式：只研究，不写入。 |
| `/focus [on\|off]` | — | Focus 模式：以最小工具子集起步。 |
| `/calm-mode [on\|off]` | — | 简洁回复；模型不再叙述过程。 |
| `/set-system-prompt` | `/system-prompt` | 编辑并保存系统提示词（持久化到 `config.toml`）。 |
| `/personal [global\|project]` | `/preferences` | 编辑每轮都会注入的个人偏好。`project` → `<工作区>/.hncode/PERSONAL.md`（仅当前工作区），`global` → `~/.hncode/PERSONAL.md`（所有工作区）。不带参数时先选择作用域。 |
| `/goal [status\|pause\|resume\|cancel] \| <objective>` | `/objective` | 启动或管理自主目标。 |

### 上下文与诊断

| 命令 | 说明 |
|------|------|
| `/compact [ratio]` | 压缩对话：AI 摘要较早部分，保留最近 20%（给参数则保留 `1-ratio`）。 |
| `/usage` | 显示会话 token 与上下文窗口。 |
| `/status` | 显示会话与运行时状态。 |
| `/tasks` | 浏览后台任务。 |
| `/mcp` | 显示 MCP 服务状态。 |
| `/mcp-config` | 配置 MCP 服务（列出 / 添加 / 移除）。 |
| `/plugins` | 打开插件管理器：已加载、磁盘上的文件、以及仓库里可用的。`install <名字>` / `remove <名字>` 可跳过面板。 |
| `/skills` | 打开技能管理器（已安装 + 可用）。`install <名字>` / `remove <名字>` 可跳过面板。 |
| `/statusline` | 配置状态行显示哪些项目。 |
| `/settings` | 打开设置菜单（模型 / 权限 / 状态行）。 |
| `/copy` | 复制最后一条助手消息到剪贴板。 |
| `/help` | 显示所有命令与快捷键。 |
| `/version` | 显示版本信息。 |
| `/exit` | `/quit`、`/q` —— 退出。 |

未知的 `/命令` 会报错，**不会**发送给模型。

---

## 8. 快捷键

| 按键 | 作用 |
|------|------|
| `Enter` | 发送消息。 |
| `Shift+Enter` | 在输入框中插入换行。 |
| `Ctrl-Shift-C` | 复制当前鼠标选中内容（无选中则复制最后一条回答）。 |
| `Ctrl-Shift-V` | 粘贴剪贴板。多行粘贴会折叠成 `[paste #N +L lines]` 标记。 |
| `↑` / `↓` | 输入框为空时：调出历史输入。否则：滚动对话。 |
| `/` | 打开命令菜单；`Tab` 循环选择。 |
| `@` | 文件/文件夹补全；`Tab` 补全。 |
| `Esc` | 取消菜单/对话框，或打断当前回合。 |
| `Ctrl-E` | 用编辑器打开 `config.toml`。 |
| `Ctrl-B` | 把正在运行的 Bash 命令移到后台。 |
| `Ctrl-S` | 把排队输入直接注入正在运行的回合。 |
| `↑`（排队时） | 取回最后一条排队消息以便编辑。 |
| `Ctrl-O` | 展开/折叠工具输出与思考内容。 |
| `Ctrl-T` | 展开/折叠待办面板。 |
| `Ctrl-C` 两次 | 退出 HNCode。 |

### 粘贴

- **文本**：原样插入（多行会折叠成标记）。
- **文件**：插入其绝对路径，模型可据此 `Read`。
- **图片**（如截图）：保存为临时 `.png`，插入其**路径**。
- 剪贴板通过**预热**的后台 PowerShell 读取，所以重复粘贴约为 10ms，而不是数秒。

### 鼠标

- 拖拽选择对话文本；右键弹出复制/粘贴菜单。
- 拖拽待办面板顶部横线可调整大小。
- 在对话区或 `/` 菜单上滚轮滚动。

---

## 9. 工具集

模型可以调用以下内置工具。每个返回一个字符串；失败会以**红色**显示，并把该工具的状态圆点变红。

| 工具 | 用途 |
|------|------|
| `Read` | 读取文本文件（默认全文；可用 `start_line` / `end_line` 指定范围）。 |
| `Write` | 写入文件（新建或覆盖）。 |
| `Edit` | 用 `new_string` 替换精确匹配的 `old_string`（除非 `replace_all`，否则必须唯一）。 |
| `Bash` | 执行 shell 命令；支持后台任务。 |
| `Glob` | 按模式查找文件。 |
| `Grep` | 按正则搜索文件内容。 |
| `TodoList` | 维护待办面板中的任务列表。 |
| `TaskList` / `TaskOutput` / `TaskStop` / `TaskWait` | 管理后台任务。 |
| `FetchURL` | 抓取 URL 并返回文本。 |
| `WebSearch` | 网络搜索。 |
| `ReadMediaFile` | 读取图片/媒体文件。 |
| `FileLines` | 统计（或查看）文件行数。 |
| `AskUserQuestion` | 在回合中向用户提 1-4 个结构化选择题并等待作答。每题末尾的「Other」自由输入项由系统自动加上，不要自己创建；最后一题之后还有一个「Add a note」全局补充项。返回 JSON：`{"answers":{"<问题>":"<选项>"},"additional":"<补充>"}`，`additional` 仅在用户写了补充时出现；用户按 Esc 放弃时返回 `{"answers":{},"note":"User dismissed…"}`。 |

### Edit 的安全模型

`Edit` 不会盲改：
- 必须先 `Read` 文件再 `Edit`。否则报：`Edit rejected: you have not read the lines you are editing…`。
- 必须先 `Read` 文件再 `Edit`，且被编辑区域必须在你实际读过的快照内。否则报：`Edit rejected: you have not read the lines you are editing…`。
- 若文件在你读取后发生了变化：`Edit rejected: <path> changed since it was Read…`。重新 `Read` 再编辑。

这些保护用于避免覆盖并发修改。

### 失败如何展示

- **Bash**：非 0 退出码会把圆点变红，命令自身输出说明原因。内部的 `[exit code: N]` 行不会显示给你。
- **Edit / Write**：正文被 diff 取代，因此失败时会在工具调用下方显示一行红色原因。
- **Read / Grep / Glob 等**：完整结果照常显示，失败时为红色。

---

## 10. 权限模式

| 模式 | 命令 | 行为 |
|------|------|------|
| **Always Ask** | `/ask` | 只读工具自动执行；其他操作一律先询问。 |
| **Ask When Needed** | `/yolo` | 工作区内的编辑/命令自动执行。工作区外路径、破坏性命令、提问与计划仍会询问。 |
| **Never Ask** | `/auto` | 不打断你；一切自动决定并执行。同时解除工作区路径限制，Agent 可以在任意位置读写 —— 相当于本次会话开启 `HNCODE_ALLOW_EXTERNAL=1`。 |

模式显示在状态行，并且**持久化在会话中**，恢复会话时一并恢复。命令行标志（`--auto`、`-y`）会在本次调用中覆盖它。

Plan 模式（`/plan`）把工具限制为只读。Focus 模式（`/focus`）以最小工具子集起步。

---

## 11. 上下文管理与自动压缩

每次请求都会携带此前的对话。当估算大小达到模型上下文窗口的 **85%** 时，HNCode 会**自动压缩**：

1. 保留最近的 **20%** 消息。
2. 请模型**摘要**较早部分（目标、决策、涉及的文件、当前状态）。
3. 摘要作为一条系统消息插入，从而保留对话脉络。

也可以手动压缩：

```
/compact          # 保留最近 20%，AI 摘要其余部分
/compact 0.3      # 丢弃最旧的 30%，保留 70%
```

token 估算采用与 Kimi Code 相同的启发式：`ceil(ASCII 字符数 / 4) + 非 ASCII 字符数`。屏幕底部的实时计量每步刷新。

---

## 12. 会话

一个会话记录 `id`、`title`、`workspace`、`model`、`messages`、`rounds`、`steps` 以及运行时模式标志。

- 保存在 `~/.hncode/sessions/<id>.json`。
- `/sessions` 只列出**当前目录**的会话。
- `HNCode --continue` 恢复**当前目录**最近的会话。
- `/move <path>` 把会话迁移到另一个目录。
- `/new` 新建会话（并清空待办面板）。
- 模式标志（权限 / plan / focus / effort）随会话持久化。

---

## 13. 插件系统

一个插件就是一个 `.js`/`.mjs` 文件，放进 `~/.hncode/plugins/`（或用 `HNCODE_PLUGINS`
指定目录）即可。它就是普通的 ES 模块 —— 不需要构建、不需要清单文件、不需要任何依赖。
文件名就是插件 id。

### 最小的可用插件

保存为 `~/.hncode/plugins/echo.mjs`，重启 HNCode，模型就多了一个可以调用的工具：

```javascript
export function install(api) {
  api.registerTool({
    name: 'Echo',
    description: '把传入的文本原样返回。用户要求回显时使用。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本。' } },
      required: ['text'],
    },
    async execute(args, ctx) {
      return args.text;
    },
  });
}

export default { name: 'echo', version: '1.0.0' };
```

能跑起来靠两点：

- **`install(api)` 是入口。** 具名导出，或者 `default.install` 都行。没有它的文件会被
  跳过，并在 stderr 上给出提示。
- **`export default` 只是元信息** —— `{ name, version }`，供 `/plugins` 显示。不写也能
  正常工作，只是会用文件名代替名字。

### 确认它加载了

`/plugins` 会列出已加载的插件、版本，以及它添加的命令：

```
Loaded plugins:
  • echo v1.0.0 (echo.mjs)
```

如果插件没出现，原因打在了 **stderr** 上 —— TUI 占着整个屏幕，所以加载失败会输出到
终端而不是对话里。工具名或命令名重复时抛的错也在那里。

### 注册斜杠命令

```javascript
api.registerCommand({
  name: 'greet',              // 就是 /greet
  aliases: ['hi'],
  description: '打个招呼。',
  argumentHint: '[name]',
  run: async (arg, ctx) => {
    // `arg` 是命令名后面输入的全部内容。
    // 返回字符串就会显示出来；不返回则表示什么都不做。
    return `你好，${arg || 'world'}！`;
  },
});
```

### 注册钩子

钩子是插件介入 agent 循环的方式。每个钩子都是可选的，参数都是普通数据 ——
插件不需要去碰任何内部结构。

| 钩子 | 触发时机 | 参数 |
|------|----------|------|
| `onTurnStart` | 一个回合开始 | `({ messages })` |
| `onBeforeRequest` | 调用模型前 | `(messages, cfg)` |
| `onAfterRequest` | 流式响应读完 | `(messages, cfg)` |
| `onNewMessage` | 助手消息写入历史时 | `(message, allMessages)` |
| `onToolExecute` | 工具执行前 | `(toolName, args, ctx)` |
| `onToolResult` | 工具返回后 | `(toolName, result, ctx)` |
| `onTurnEnd` | 回合结束（被打断也算） | `({ messages, stopped })` |

一个实用的例子 —— 审计 agent 执行的每一条 shell 命令：

```javascript
export function install(api) {
  api.registerHook('onToolExecute', (name, args) => {
    if (name === 'Bash') console.error('[audit] bash:', args.command);
  });
}
```

两条可以放心依赖的保证：

- **钩子抛异常不会破坏回合。** 每个钩子都在 `try/catch` 里执行，错误输出到 stderr，
  agent 继续正常工作。
- **钩子按注册顺序执行**，可以是 async。

### 注册配置默认值

`api.registerConfig({ ... })` 合并的值会进入 `resolveConfig`。它们在内置默认值之后、
用户的 `config.toml` **之前**生效，所以用户始终优先。

### API 完整一览

| 成员 | 类型 | 用途 |
|------|------|------|
| `api.registerTool(spec)` | 函数 | 添加工具。返回反注册函数。 |
| `api.registerCommand(cmd)` | 函数 | 添加 `/命令`。返回反注册函数。 |
| `api.registerHook(name, fn)` | 函数 | 添加生命周期钩子。返回反注册函数。 |
| `api.registerConfig(defaults)` | 函数 | 合并默认配置值。 |
| `api.ctx` | getter | 运行时 agent 上下文。只在钩子内有意义。 |
| `api.tools` / `api.commands` / `api.hooks` / `api.config` / `api.plugins` | getter | 副本，用于内省。 |

三个 `register*` 都返回一个可以撤销注册的函数，因此插件能自己卸载：

```javascript
const off = api.registerTool({ /* … */ });
// 之后：
off();
```

### 容易踩的坑

- **名字在所有插件之间必须唯一。** 注册两次 `Echo` 会抛错；两个插件不能抢同一个
  工具名或命令名。
- **插件只在启动时加载一次。** 改了插件文件需要重启。`/reload` 重载的是
  `config.toml`，不是插件代码。
- **钩子外面 `api.ctx` 是 null。** 它是 agent 运行时注入的，所以要写在钩子回调里，
  而不是 install 阶段。
- **工具的 `execute` 必须返回字符串。** 这个字符串就是模型看到的内容。如果选择抛错，
  对话里会出现 `Error running <工具名>: …`。
- **用 `api.log`，不要用 `console`。** TUI 独占屏幕，`console.log` 写在你看不到的
  终端里。`api.log` 会把消息放进对话区。
- **install() 里抛错的插件不会被加载。** 它的工具没有注册，所以会被报成失败、不出现在
  `/plugins` 的 Loaded 里，而不是「列出来了但什么都没有」。

### 向用户汇报

用 `api.log` 而不是 `console`。TUI 独占屏幕，插件里的 `console.log` 写进的是一个
HNCode 运行期间你看不到的终端；`api.log` 会把消息放进对话区，也就是你正在看的地方：

```javascript
export function install(api) {
  api.log.info('registered 3 tools');
  api.log.warn('the legacy option is ignored');
}
```

```
 • plugin: loaded my-plugin v1.0.0
 • plugin: registered 3 tools
 ! plugin: the legacy option is ignored
```

HNCode 自己的插件事件也走同一套 —— 加载成功、`install()` 抛错、文件里没有 `install()`
导出，这三种都会在对话区显示，而不是只写到 stderr。`api.log` 同时镜像到终端，所以盯着
stderr 的插件作者也能看到。

---

## 14. 技能（Skills）

**技能**是一段保存好的提示词片段 —— 一个 Markdown 文件，用名字激活。和插件不同，它不含
任何代码，只是指令，所以不需要重启，也不可能搞坏运行时。

```
/skill:review-pr 顺便确认错误分支都覆盖到了
```

输入 `/skill:` 会弹出已安装技能的补全菜单。名字后面写的文字会追加到技能正文之后，作为
提示词发出去 —— 技能定方法，你写的是具体的要求。

### 激活技能时的显示

对话区显示的是一张「激活卡片」，而不是你敲的斜杠命令：

```
▶ Activated skill: review-pr
  顺便确认错误分支都覆盖到了
```

技能正文是作为 **system** 消息注入的，所以它能影响模型的行为，但永远不会显示成「你说的话」。
有一个后果值得知道：只写 `/skill:名字` 不带文字时，**不会发送任何用户消息** —— 技能正文
就是全部指令。想追问什么，就把文字写在名字后面。

### 技能放在哪

| 位置 | 作用范围 |
|------|----------|
| `~/.hncode/skills/<名字>.md` | 所有工作区。 |
| `<工作区>/.hncode/skills/<名字>.md` | 仅当前工作区。 |

文件名就是技能名：`review-pr.md` 用 `/skill:review-pr` 激活。

可选的 YAML front-matter 用来提供名字和 `/skills` 里显示的描述：

```markdown
---
name: review-pr
description: 审查 PR，只找真正会发上线的 bug
---

读 diff，然后检查……
```

正文是结尾 `---` 之后的全部内容。front-matter 是可选的 —— 没有它时整个文件都是正文，
名字取自文件名。

### 管理技能

| 命令 | 说明 |
|------|------|
| `/skills` | 打开技能管理器（见下一节）。 |
| `/skills install <名字>` | 从仓库下载，不打开面板。 |
| `/skills remove <名字>` | 删除本地副本。 |
| `/import-skill <文件.md> [名字]` | 把磁盘上的 Markdown 文件复制进技能目录。 |

```
/skills            # 管理器
/skills install root-cause
/import-skill ./my-notes.md release-checklist
```

---

## 15. 从仓库安装技能与插件

HNCode 的 npm 包里**不含**任何技能和插件。它们是按需从项目仓库拉取的，这样安装包很小，
而且更新一个技能不需要发版。

仓库里每个条目一个目录：

```
skills/<名字>/SKILL.md      ->  ~/.hncode/skills/<名字>.md
plugins/<名字>/index.js     ->  ~/.hncode/plugins/<名字>/index.js
```

### 管理器

`/skills` 和 `/plugins`（不带参数，或加 `list`）会打开一个全屏管理器：

```
────────────────────────────────────────────────────────────────
 Plugins
 Tab switch · ↑↓ select · Enter install/remove · Esc close

 [Loaded (1)]  On disk (2)   Available (3)

 ❯ my-plugin/                     restart
     not loaded — restart HNCode to load it
   secret-guard                   installed
     Catch credentials before they are written

 Enter removes the local copy of my-plugin
────────────────────────────────────────────────────────────────
```

- **Tab** 切页；**↑/↓** 移动；**Enter** 安装或删除；**Esc** 关闭；**r** 重新拉取。
- 每行都带**描述**，所以你知道装的是什么。
- 插件的三个分页含义不同，所以需要三个：
  - **Loaded** —— 本次会话已加载的插件。
  - **On disk** —— `~/.hncode/plugins` 里的文件，不管加载没加载。在这里但不在 Loaded 的
    条目需要**重启**。
  - **Available** —— 仓库里提供的，若本地已有会标 `installed`。
- 技能只有两个分页：**Installed** 和 **Available**。

覆盖安装是被允许的，会报告为「更新」—— 这就是升级方式。

### 各个按钮做什么

| 操作 | 效果 |
|------|------|
| 安装（技能） | 下载 `skills/<名字>/SKILL.md` 到 `~/.hncode/skills/<名字>.md`。立刻可用。 |
| 安装（插件） | 下载 `plugins/<名字>/*` 到 `~/.hncode/plugins/<名字>/`。**需要重启才加载。** |
| 删除 | 删除本地副本。正在运行的插件要重启才真正卸载。 |

### 注意事项

- **列表是实时拉取的**，不缓存 —— 五分钟前刚合并的技能，下次打开就能看到。拉取失败时
  只有 **Available** 分页会提示；本地分页照常工作，因为它们读的是文件系统。
- 插件只下载可加载的文件类型（`.js`、`.mjs`、`.cjs`、`.json`、`.md`），所以插件目录里
  混的图片不会落到你的插件目录里。
- 技能目录**必须**包含 `SKILL.md`。没有的话会被标成无法安装，而不是生成一个没内容的技能。
- 安装前会校验名字：含 `/`、`\` 或以 `.` 开头的一律拒绝。
- 用 `HNCODE_REPO` / `HNCODE_REPO_REF` 指向 fork（默认 `NiceHello666/HNCode` @ `main`）。
- **关于 GitHub 限流**：列表走的是未认证的 GitHub API，每个 IP 每小时 60 次。打开一次
  `/skills` 会消耗 1 次列目录 + 每个技能 1 次（读描述），所以技能很多时会触发限流 ——
  面板会说明，本地分页照常可用。

### 贡献一个

加 `skills/<你的技能>/SKILL.md` 或 `plugins/<你的插件>/index.js`，然后提 PR。目录名就是
安装名，所以请用普通单词。完整约定见各目录下的 `README.md`。

这些文件**不会**发布到 npm —— `package.json` 的白名单里只有 `bin/`、`src/` 和顶层文档。

---

## 16. 开发者指南

### 项目结构

```
bin/            命令行入口（HNCode、.cmd、.ps1）+ 安装钩子
src/
  index.js      argv 解析、子命令、无头模式、TUI 分发
  tui.js        原始 TTY 渲染器、按键处理、斜杠命令
  agent.js      工具循环（请求 → 工具调用 → 重复）
  llm.js        OpenAI + Anthropic 客户端（流式与非流式）
  config.js     config.toml 解析、服务商、模型、思考强度
  session.js    会话存储
  plugin.js     插件宿主与注册表
  tools/        每个工具一个文件
  colors.js     ANSI 颜色辅助
  term.js       token 估算、宽度计算、换行
```

### agent 循环

`src/agent.js` 的执行流程：构建请求 → 流式接收回复 → 若模型发出工具调用则执行并追加结果 → 重复，直到模型给出不含工具调用的最终回答、用户打断，或步数预算（如有）耗尽。若模型在任务中途停下，完成度守卫会提醒它继续（最多 `MAX_NUDGES` 次）。

### 添加工具

1. 新建 `src/tools/mytool.js`，导出 `spec`，包含 `name`、`description`、`parameters`（JSON schema）和 `async execute(args, ctx)`。
2. 在 `src/tools/index.js` 中注册。

### token 估算

`src/term.js` 中的 `estimateTokens(text)`：ASCII 约 4 字符/token，非 ASCII 约 1 字符/token。

### 检查

项目未接入测试运行器；保持 `node --check <file>` 通过，并手动验证改动。

---

## 17. 故障排查

| 现象 | 可能原因 / 处理 |
|------|----------------|
| `HNCode: interactive mode requires a TTY` | 你在管道中运行。非交互请用 `HNCode -p \"…\"`。 |
| `no api_key configured` | 设置 `HNCODE_API_KEY`，或配置服务商（`/provider`）。运行 `HNCode doctor config`。 |
| Windows 上界面乱码 | 使用 **[Windows Terminal](https://github.com/microsoft/terminal)**；老式 `cmd.exe` 控制台渲染很差。微软商店可免费安装，HNCode 的渲染就是为它设计的。 |
| 粘贴很慢 | 首次粘贴后应约为 10ms（剪贴板助手已预热）。首次极慢是 PowerShell 冷启动所致。 |
| `Edit rejected: you have not read the lines…` | 先 `Read` 文件（相关行），再 `Edit`。 |
| 上下文计量接近 100% | 运行 `/compact`，或等 85% 时自动压缩触发。 |
| 自己写的插件没加载 | 现在原因会出现在**对话区**（`✗ plugin: …`），同时仍写到 stderr。名字必须唯一；目录式插件需要有 `index.js`。 |
| `/plugins` 提示列表拉取失败 | GitHub 不可达，或触发了未认证 API 的限流（每小时 60 次）。**Loaded** 和 **On disk** 不受影响，它们读的是文件系统。 |
| 装好的插件在 **On disk** 但不在 **Loaded** | 插件只在启动时加载，重启 HNCode。 |
| `/skills install` 报没有 `SKILL.md` | 仓库里那个条目有问题：每个技能目录都必须包含 `SKILL.md`。 |

---

## 18. 许可证

[PolyForm Noncommercial License 1.0.0](https://github.com/NiceHello666/HNCode/blob/main/LICENSE)。

1. ✅ 非商业用途免费——个人项目、学习、研究、业余爱好，以及非商业组织。
2. ✅ 可以修改和分享，但任何副本都必须附带许可证全文和「不得商用」的声明。
3. ❌ 禁止任何形式的商业使用（出售、作为付费产品的一部分、或用于运营商业服务）。
4. ℹ️ 这不是 copyleft 许可：你自己新增的部分无需开源。商业使用需向作者单独获取授权。

---

[返回 README](https://github.com/NiceHello666/HNCode/blob/main/README_CN.md) · [English Wiki](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI.md)
