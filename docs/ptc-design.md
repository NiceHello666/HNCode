# PTC (Programmatic Tool Calling) design

## The upstream mechanism (Anthropic)

The model writes **code** instead of calling tools one at a time. Intermediate results never enter the context;
only what the code prints comes back to the model.

```python
team = await get_team_members("engineering")
budgets = {lv: b for lv, b in zip(levels, await asyncio.gather(*[get_budget_by_level(l) for l in levels]))}
expenses = await asyncio.gather(*[get_expenses(m["id"], "Q3") for m in team])
exceeded = [...]   # 2000 detail rows are consumed here
print(json.dumps(exceeded))   # only these few people reach the context
```

At the protocol level:
- A tool is marked `allowed_callers: ["code_execution_..."]`.
- When the executor needs to call a tool, the API returns `pause_turn` and suspends the turn.
- The external call is made, the result is handed back, and the code resumes.

Reported effect: 43,588 → 27,297 tokens (-37%), and 19 of 20 inference passes eliminated.

## Our implementation

Anthropic runs its sandbox on its own servers; we do not have one. A **local executor** takes its place:

| Layer | Approach |
|---|---|
| Runtime | `worker_threads` + `vm` — a separate thread that can be killed on timeout, leaving the main process untouched |
| Tool bridge | `await callTool(name, args)` is injected into the worker; the call is sent back to the main thread |
| Safety | Only tools on the `getTool()` allowlist are callable; no `require`, no filesystem access |
| Output | Only `stdout` and the return value come back; intermediate results stay in the worker |

## Why not just run Bash

`Bash` can execute arbitrary commands, which hands the sandbox away. PTC's value is orchestrating tools under
control, not giving the model a shell. `/ptc` makes that a hard guarantee: the model is offered only the `PTC`
tool, so a loop cannot bypass the sandbox with a shell command.

## Phases

1. **Executor**: worker + vm, inject `callTool`, kill on timeout.
2. **Tool**: add `PTC`, whose parameter is the code body.
3. **Prompt**: explain when to write code instead of making individual calls.
4. **Permissions**: tools called from inside the code still go through their own approval rules.

## Known trade-offs

- JavaScript only (running Python inside Node would need an extra dependency, and the project has none).
- Recursion is bounded, so a tool cannot call PTC again.
- Output is truncated, so a runaway loop cannot flood the context.
