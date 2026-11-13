# plugins

Optional plugins shipped with hncode. Each plugin is one directory:

```
plugins/
  my-plugin/
    index.js
```

A plugin is an ESM module exporting `install(api)`. See `src/plugin.js` for the full
API (tools, commands, hooks, patches, config defaults).

```js
export function install(api) {
  api.registerCommand({ name: 'hello', description: 'Say hello', run: () => 'hi' });
}
export default { name: 'hello', version: '1.0.0' };   // both fields REQUIRED
```

`name` and `version` are **required**, and `version` must be semver (`1.0.0`). A
plugin missing either is refused at load with an error notice — an unversioned
plugin cannot be told apart from a stale one.

## Patching HNCode's own code (`api.patch`)

Beyond registering new tools/commands, a plugin can **wrap any exported function or
class method in HNCode's `src/`** by name:

```js
export function install(api) {
  // Wrap a top-level export:
  api.patch('git.js#commit', { before: (…args) => log(args) });

  // Wrap a class method:
  api.patch('llm.js#LLM.requestText', { after: (r) => decorate(r) });
}
```

Targets are `"file.js#symbol"` or `"file.js#Class.method"`. A handler may supply any of:

- `before(...args)` — runs before the call. Return an array to replace the arguments.
- `after(result, args)` — runs after. Return a non-`undefined` value to replace the result.
- `around(original, args, this)` — full control; its return value is the result.

Async functions are handled transparently (a returned promise is awaited before `after`
runs). The original source is never edited: HNCode appends a small footer that reassigns
the symbol at load time, so a function body is never parsed or rewritten.

Two constraints:

1. **Ordering.** Patching only works for modules that are imported *after* the plugin
   registers its target. HNCode's entry point (`bin/hncode`) loads plugins before the
   rest of `src/`, so any module is patchable; a module imported before the loader was
   installed is served from cache and cannot be patched.
2. **Legacy seams.** The original abstract seams (`systemPrompt`, `llmRequest`,
   `llmHeaders`, `llmBody`, `llmResponse`, `toolDispatch`, `toolResult`, `beforeRender`,
   `afterRender`) still work with their old chain signature `(ctx, next)`.

Both layouts load, and the directory name is used as the plugin name when no metadata
is given:

```
~/.hncode/plugins/my-plugin/index.js    # directory — the form /plugins install writes
~/.hncode/plugins/my-plugin.js          # single file
```

Within a directory the entry point is `index.js` / `index.mjs`, or the first `.js` /
`.mjs` beside it. A directory with no loadable file is skipped rather than failing the
whole load. If a plugin needs helper modules, put them next to the entry point — the
loader imports only the entry, and it can import its neighbours normally.

## Installing one

```
/plugins                # lists loaded plugins, what is on disk, and this folder
/plugins install <name> # downloads plugins/<name>/* into ~/.hncode/plugins/<name>/
/plugins remove <name>  # deletes the local copy
/plugins reload         # unload and re-read every plugin, without restarting
```

Only loadable file types are downloaded (`.js`, `.mjs`, `.cjs`, `.json`, `.md`), so a
stray asset in a plugin directory cannot land in the plugin folder.

`/plugins reload` is a real reload: every plugin's `dispose` runs, everything it
registered is undone, and each file is re-imported from disk (bypassing the module
cache), so an edited plugin takes effect immediately. One exception: `api.patch` only
rewrites a module as it loads, so a patch on a module that is already in memory still
needs a restart. The reload reports that case.

## Depending on another plugin (`inject`)

A plugin can publish a value under a name and another plugin can require it, instead of
importing the other plugin's file — which would break as soon as either is edited or
reloaded.

```js
// plugins/db/index.js
export const provides = ['signature-db'];
export function install(api) { api.provide('signature-db', { lookup: (h) => … }); }
export default { name: 'db', version: '1.0.0' };

// plugins/scan/index.js
export const inject = ['signature-db'];
export function install(api) {
  const db = api.require('signature-db');   // guaranteed ready here
  api.registerCommand({ name: 'scan', run: () => db.lookup(process.cwd()) });
}
export default { name: 'scan', version: '1.0.0' };
```

The loader orders the load by these declarations, so `scan` runs after `db` whatever the
directory order. A plugin whose dependencies can never be satisfied — nobody provides the
name, or the provider itself failed to start — is **skipped** with an error notice rather
than started half-wired. A circular `inject` is reported as such.

`api.provide` / `api.get` / `api.has` / `api.require` / `api.serviceNames` are the whole
service surface. Providing a name that is already taken throws, so two plugins cannot
quietly fight over one name.

## Cleanup (`dispose`, `api.onDispose`)

Everything a plugin registers through `api.*` is recorded, and `/plugins reload` (or
`unloadPlugins()`) undoes it in reverse order. For anything the API cannot know about —
a timer, a child process, a watcher — use one of these:

```js
export function install(api) {
  const timer = setInterval(poll, 5000);
  api.onDispose(() => clearInterval(timer));
}

// or the whole-plugin form, which runs BEFORE the registrations are undone:
export function dispose(api) { flushMyState(); }
```

`api.registerConfig` now returns an unregister function too, and a plugin whose
`install()` throws has everything it registered before the throw rolled back.

## Contributing

1. Fork the repo and add `plugins/<your-plugin>/` with at least one loadable file.
2. The directory name is what users pass to `/plugins install`, so keep it to plain
   words.
3. Open a PR.

These files are **not** published to npm (see the `files` field in `package.json`);
they are fetched from this repository on demand.
