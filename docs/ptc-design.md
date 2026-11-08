# PTC (Programmatic Tool Calling) 设计

## 官方机制（Anthropic）

模型写**代码**而不是逐个调工具。中间结果不进上下文，只有最终输出回到模型。

```python
team = await get_team_members("engineering")
budgets = {lv: b for lv, b in zip(levels, await asyncio.gather(*[get_budget_by_level(l) for l in levels]))}
expenses = await asyncio.gather(*[get_expenses(m["id"], "Q3") for m in team])
exceeded = [...]   # 2000 条明细在这里被消化
print(json.dumps(exceeded))   # 只有这几个人进上下文
```

协议层：
- 工具带 `allowed_callers: ["code_execution_..."]`
- 执行器要调工具时，返回 `pause_turn` 让 API 挂起
- 外部调用完再交回去，代码继续跑

效果：43,588 → 27,297 tokens（-37%），20 次调用省掉 19 次推理。

## 我们的做法

Anthropic 的沙箱在它服务器上，我们没有。用**本地执行器**替代：

| 层 | 做法 |
|---|---|
| 执行环境 | `worker_threads` + `vm` —— 独立线程，超时可杀，不污染主进程 |
| 工具桥 | worker 里注入 `await callTool(name, args)`，消息回主线程执行 |
| 安全 | 只能调 `getTool()` 白名单里的工具；不能 require、不能访问 fs |
| 输出 | 只回 `stdout` + 返回值，中间结果留在 worker |

## 为什么不是直接跑 Bash

`Bash` 能跑任意命令，等于把沙箱交出去。PTC 的价值是**受控**地编排工具，不是给模型一个 shell。

## 分阶段

1. **执行器**：worker + vm，注入 `callTool`，超时可杀
2. **工具**：新增 `ProgrammaticToolCall`，参数是代码
3. **提示词**：说明何时用代码而不是逐个调
4. **权限**：代码里调用的工具仍走各自的审批

## 已知取舍

- 只支持 JS（Node 里跑 Python 要额外依赖，项目零依赖）
- 递归深度限制，防止工具里再调 PTC
- 输出上限截断，防止一个死循环塞爆上下文
