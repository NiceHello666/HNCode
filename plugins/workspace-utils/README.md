# workspace-utils

三个 HNCode 没有的实用命令，全部基于公开 plugin API 实现，不依赖任何私人配置，也不与内置功能重叠。

## 命令

### `/todo-export [path]`
把当前会话的 TodoList 导出成 Markdown 清单文件（默认 `<cwd>/TODO.md`）。
HNCode 的 TodoList 工具只把待办显示在界面上，没法保存；这个命令把它落盘，方便交接或之后继续。

```bash
/todo-export                 # 写到 ./TODO.md
/todo-export notes/plan.md   # 指定路径
```

输出示例：
```markdown
# Todo list — 2026-09-27

_1 done, 1 in progress, 1 pending._

[x] 实现插件
[~] 写 README
[ ] 测试
```

### `/explain <file|dir>`
让 agent 用通俗语言讲解一个文件或目录，并把讲解写成 `<name>.explained.md` 存到旁边。
HNCode 能在聊天里回答「这个文件干嘛的」，但不会留下可反复阅读、可提交的笔记；这个命令把讲解固化成文件。

```bash
/explain src/agent.js
/explain src/tools
```

### `/deps [path]`
扫描声明的依赖（支持 `package.json` / `requirements.txt` / `go.mod`），让 agent 评估依赖健康度：落后大版本的包、有风险模式的包、未固定版本、缺失的常用依赖等。
HNCode 没有任何依赖相关工具，这是全新的能力。

```bash
/deps            # 扫描工作区根目录
/deps ./backend  # 指定目录
```

## 安装
```bash
/plugins install workspace-utils
```
然后重启 HNCode（插件在启动时加载）。

## 实现说明
- 仅使用 Node 内置模块 + 公开 plugin API（`api.writeFile`、`api.sendPrompt`、`api.notice`）和命令上下文（`ctx.state.todos`、`ctx.state.cwd`）。
- 不 import 任何 `../src/*`，因此安装到 `~/.hncode/plugins` 时也能正常加载。
- `explain` 和 `deps` 通过 `api.sendPrompt` 把任务交给 HNCode 自己的 agent（同一模型、同一套工具、同一套流式 UI），不重复实现 LLM 调用。

LICENSE: MIT
