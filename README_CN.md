![HNCode](imgs/HNCode.png)

# HNCode

---

[English](https://github.com/NiceHello666/HNCode/blob/main/README.md) | 简体中文 | [Wiki](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI_CN.md)

> **这是我vibe coding的产物. 我在尽全力让它变的完美, 所以如果你有何建议, 欢迎开一个issue.**

一个基于终端用户界面（TUI）的 AI 编程助手，灵感源自 [Kimi Code](https://github.com/MoonshotAI/kimi-code)。它提供青色蓝调 (Cyan-blue) 的 TUI 界面，支持 OpenAI 和 Anthropic 双协议，配备 MCP 风格的工具集和智能上下文管理。

---

## 核心特性

- **原生 TUI 渲染**: 使用原始终端序列渲染，完美兼容 Windows Terminal，解决 blessed 等库在 Windows 上的兼容性问题
- **双协议支持**: 同时支持 OpenAI-compatible API 和 Anthropic API
- **智能上下文管理**: 85% 使用率时自动压缩，AI 摘要保留历史对话
- **MCP 风格工具集**: Read, Write, Edit, Bash, Glob, Grep, TodoList, WebSearch, FetchURL 等
- **插件系统**: 可扩展的工具、命令和生命周期钩子
- **会话持久化**: 跨会话恢复对话
- **权限模式**: Ask, YOLO, Auto 三种工作流模式

---

## 安装

### 全局安装（推荐）

```bash
npm install -g @hncode/hncode
```

然后运行：
```bash
hncode
```

### 使用 npx（无需安装）

```bash
npx @hncode/hncode
```

---

## 文档

本文件只是简要介绍。**完整文档**（所有命令、配置项、架构说明、插件与开发指南）请见 Wiki：

- **[Wiki（英文）](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI.md)**
- **[Wiki（简体中文）](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI_CN.md)**

---

## 贡献

**欢迎：**
- 提交问题报告 bug 或提出建议
- Fork 并创建拉取请求
- 分享您使用 HNCode 的体验

---

## 许可证

本项目的许可受 [PolyForm Noncommercial License 1.0.0](https://github.com/NiceHello666/HNCode/blob/main/LICENSE) 保护。

**简单来说:**
1. ✅ 非商业用途免费——个人项目、学习、研究、业余爱好，以及非商业组织
2. ✅ 可以修改和分享，但任何副本都必须附带许可证全文和「不得商用」的声明
3. ❌ 禁止任何形式的商业使用（出售、作为付费产品的一部分、或用于运营商业服务）
4. ℹ️ 这**不是** copyleft 许可：你自己新增的部分无需开源。商业使用需向作者单独获取授权。

---

**NPM 包**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/HNCode](https://github.com/NiceHello666/HNCode)
