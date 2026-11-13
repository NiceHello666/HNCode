# @hncode/hncode-sdk

Types and runtime helpers for writing [HNCode](https://npmjs.com/package/@hncode/hncode) plugins.

A plugin runs **inside** the HNCode process: the host calls your `install(api)` and
hands you the `api` object. So a plugin never imports HNCode itself — but at author
time you want completion for `api.` and, for `api.patch`, the list of symbols you
may target. That is what this package provides.

- **`HncodePluginApi`** — the type of the `api` object (every method, its
  signature and return).
- **`PatchTarget`** — a literal union of every symbol a plugin may patch
  (`'llm.js#LLM.requestText'`, `'git.js#commit'`, …), so the target string
  completes and is checked.
- **Runtime helpers** — `definePlugin`, `parsePatchTarget`, `HOOK_NAMES`,
  `LEGACY_SEAMS`, and the generated `PATCH_TARGETS` list.

It has **zero dependencies** and pulls in none of the CLI.

## Install

```bash
npm i -D @hncode/hncode-sdk
```

## Write a plugin

```js
// plugins/hello/index.js
import { definePlugin, HOOK_NAMES } from '@hncode/hncode-sdk';

export default definePlugin({
  name: 'hello',
  version: '1.0.0',
  install(api) {
    api.registerCommand({
      name: 'hello',
      description: 'Say hello',
      run: () => 'hi',
    });
  },
});
```

In TypeScript (or with JSDoc `checkJs`), `api` is typed automatically once the
plugin's default export is annotated:

```ts
import type { HncodePlugin } from '@hncode/hncode-sdk';

const plugin: HncodePlugin = {
  name: 'hello',
  version: '1.0.0',
  install(api) {
    api.registerCommand({ name: 'hello', description: 'Say hello', run: () => 'hi' });
  },
};
export default plugin;
```

## Patching HNCode's own code

`api.patch(target, handler)` wraps an exported function or class method in
HNCode's `src/` without editing it (the equivalent of a Minecraft mixin).

```js
import { isPatchTarget } from '@hncode/hncode-sdk/targets';

export default {
  name: 'audit', version: '1.0.0',
  install(api) {
    // `target` is typed as PatchTarget, so it completes.
    api.patch('git.js#commit', {
      before: (...args) => console.log('commit', args),
      after: (result) => result,
    });
  },
};
```

A handler may supply any of:

- `before(...args)` — runs before the call. Return an array to **replace** the args.
- `after(result, args)` — runs after. Return a non-`undefined` value to **replace** the result.
- `around(original, args, this)` — full control; its return value is the result.

Async functions are handled transparently.

## Logging

`api.log` is callable **and** carries the four methods, like `console`:

```js
api.log('plain call');          // -> an info notice
api.log.warn('careful');        // -> a warning notice
api.log.error('failed');
```

There are no separate `api.info` / `api.warn` / `api.error` members. Everything reaches
the chat and is mirrored to the terminal, so a plugin author watching stderr sees it too.

## Introspection

What the current load has registered, live (not a snapshot):

```js
api.tools;      // ToolSpec[]  — including other plugins'
api.commands;   // CommandSpec[]
api.hooks;      // { [hookName]: fn[] }
api.config;     // plugin-supplied defaults, before user overrides
api.plugins;    // [{ name, version }] in install order
```

Useful for avoiding a name collision before calling `registerTool` / `registerCommand`.

## Driving the UI

```js
api.openFileTree('src');   // the /files browser; false if it could not open
api.closeFileTree();

api.themeNames;            // ['auto','dark','light','nord','dracula','gruvbox','mono']
api.getTheme();            // the one in force
api.setTheme('gruvbox');   // false for an unknown name
```

`openFileTree` returns whether the browser actually opened. An empty workspace or a
headless host gives `false`, so a plugin can tell rather than waiting on a panel that never
appeared.

## Subagents

The same controls the model has as tools, for a plugin:

```js
for (const a of api.subagents()) {
  // { id, runId, taskId, type, description, startedAt }
}

api.messageSubagent(a.id, 'also check the tests');  // { ok, message }
api.interruptSubagent(a.id);                        // omit the id to stop all
api.closeSubagent(a.id);                            // stop AND drop from the list
```

`api.subagents()` lists only what is running now — a finished agent is no longer
controllable. The live handles (`steer`, `interrupt`) are not exposed; the calls above are
the whole surface.

## Keybindings

```js
api.isKeyBound('ctrl+t');  // true if a built-in, another plugin or the user took it
api.boundKeys;             // every claimed token
```

`registerKeybind` overwrites silently, so check first if you want to be polite. Any
spelling works — `'ctrl+t'` and `'c-t'` are the same key.

## Lifecycle hooks

`api.registerHook(name, fn)`. The names the host actually fires:

`onStartup`, `onShutdown`, `onTurnStart`, `onTurnEnd`, `onBeforeRequest`,
`onAfterRequest`, `onToolExecute`, `onToolResult`, `onNewMessage`, `onSessionSave`.

`HOOK_NAMES` holds the same list at runtime.

## Regenerating the target list

`targets.js` / `targets.d.ts` are generated from the main package's `src/`, so they
must be refreshed whenever the main package changes:

```bash
# from a checkout where hncode-sdk/ sits next to hncode's src/
node scripts/gen-targets.mjs            # uses the parent directory
node scripts/gen-targets.mjs D:\hncode  # or point at the root explicitly
```

This runs automatically on `prepublishOnly`.

## License

PolyForm Noncommercial 1.0.0 — same as hncode.
