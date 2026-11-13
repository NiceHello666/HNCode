![HNCode](imgs/HNCode.png)

# HNCode

---

English | [简体中文](https://github.com/NiceHello666/HNCode/blob/main/README_CN.md) | [Wiki](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI.md)

> **This is a product of my vibe coding session. I'm trying my best to make it perfect, so if you have any suggestions, feel free to open an issue.**

A cyan-blue terminal user interface (TUI) coding agent inspired by [Kimi Code](https://github.com/MoonshotAI/kimi-code), with OpenAI + Anthropic support, an MCP-style toolbelt, and intelligent context management.

---

## Features

- **Cyan-blue TUI**: Raw terminal renderer for perfect Windows Terminal compatibility
- **Dual Protocol Support**: Works with both OpenAI-compatible APIs and Anthropic
- **Smart Context Management**: Auto-compaction at 85% usage, AI-summarized history retention
- **Prompt Caching**: Explicit cache breakpoints for the stable prefix (`/cache`)
- **MCP-style Toolbelt**: Read, Write, Edit, Bash, Glob, Grep, TodoList, WebSearch, etc.
- **MCP Client**: Connect real Model Context Protocol servers (stdio + HTTP) and use their tools
- **Skills**: Package reusable prompts as Markdown (`/import-skill`, `/skill:<name>` with tab-completion, plus a manager that installs them from the repo)
- **Skills & plugins manager**: `/skills` and `/plugins` browse what is installed *and* what the repo offers, with descriptions, and install/remove in place
- **Shell Hooks**: Run your own commands at lifecycle events (`PreToolUse`, `PostToolUse`, …)
- **Git Workflow**: `/git`, `/commit`, `/branch`, `/worktree`, `/pr` plus a `Git` tool for the agent
- **Plan Review**: Review what a plan will touch, edit it, then approve before any file changes
- **Plugin System**: Extend with custom tools, commands, and hooks
- **Session Persistence**: Resume conversations across sessions
- **Permission Modes**: Ask, YOLO, or Auto modes for different workflows
- **Shell Passthrough**: type `!` on an empty prompt to switch the composer into shell mode — no model round-trip
- **CI / Scripting**: Headless `-p` with `json` / `stream-json` output and outcome-based exit codes
- **Remote Control**: `--control` exposes a local socket to prompt/status/interrupt a running session

### CI usage

```bash
# One prompt, machine-readable result, exit code reflects the outcome.
hncode -p "fix the failing tests" --output-format json
# -> {"type":"result","ok":true,"reply":"…","toolCalls":["Bash"],"files":["src/a.js"],…}

# Exit codes: 0 ok · 1 failure · 2 config · 3 no answer · 4 interrupted
hncode -p "run the linter and fix everything" --output-format stream-json | jq -c 'select(.type=="result")'
```

### Shell passthrough

Type `!` on an **empty** prompt to switch the composer into shell mode — the `!`
becomes the prompt symbol and the line runs directly, with no model involved:

```
! git add -A && git push
! npm test
```

The `!` is a mode marker, not part of what you type, so it appears exactly once.
Press `Esc` or `Backspace` on an empty line to leave the mode. Output appears in
the transcript as a `↳` receipt.

### Remote control

```bash
hncode --control                       # in one terminal (TUI)
hncode control status                  # in another
hncode control prompt "run the tests"  # queue a prompt on the running session
hncode control interrupt
```

---

## Installation

### Global Installation (Recommended)

```bash
npm install -g @hncode/hncode
```

Then run:
```bash
hncode
```

### Using npx (No installation required)

```bash
npx @hncode/hncode
```

---

## Documentation

This file is a quick overview. For the **full documentation** — every command, config option, architecture notes, and the plugin/development guide — see the Wiki:

- **[Wiki (English)](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI.md)**
- **[Wiki (简体中文)](https://github.com/NiceHello666/HNCode/blob/main/README_WIKI_CN.md)**

---

## Contributing

**Feel free to:**
- Submit issues for bugs or suggestions
- Fork and create pull requests
- Share your experience using HNCode

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://github.com/NiceHello666/HNCode/blob/main/LICENSE).

**In short:**
1. ✅ Free for noncommercial use — personal projects, learning, research, hobby work, and noncommercial organizations
2. ✅ You may modify and share it, provided you keep the license text and the noncommercial notice with any copy
3. ❌ No commercial use of any kind (selling it, shipping it inside a paid product, or using it to run a commercial service)
4. ℹ️ This is *not* a copyleft license: your own additions do not have to be published. Commercial use requires a separate license from the author.

---

**NPM Package**: [@hncode/hncode](https://www.npmjs.com/package/@hncode/hncode)  
**GitHub**: [NiceHello666/HNCode](https://github.com/NiceHello666/HNCode)
