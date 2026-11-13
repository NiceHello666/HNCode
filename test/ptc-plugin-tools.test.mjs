// Which tools generated code may reach, and how a plugin joins that set.
//
// WHY THIS FILE EXISTS: the list was hardcoded, so a plugin's tools could never be called from PTC — the core
// cannot keep a list of names it has never heard of. The rule now: the built-ins are listed here because whether
// `Write` belongs in a sandbox is a decision about THIS program; a plugin declares `programmatic: true` on the
// spec, which is the only place that knows what its own tool touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { callableTools, CALLABLE_TOOLS, runProgrammatic } = await import('../src/ptc.js');
const { pluginTools } = await import('../src/plugin.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-ptc-plugin-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the built-in set is the read-only one', () => {
  // A shell or a write inside the sandbox would hand the model the machine and no structure.
  for (const banned of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
    assert.ok(!CALLABLE_TOOLS.includes(banned), `${banned} must not be callable from code`);
  }
  assert.ok(CALLABLE_TOOLS.includes('Read'));
  assert.ok(CALLABLE_TOOLS.includes('Glob'));
});

test('a plugin tool joins the set only when it declares itself', async () => {
  const pdir = path.join(dir, 'ptc-declares');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'index.js'), `
export function install(api) {
  api.registerTool({
    name: 'SafePluginTool',
    programmatic: true,
    description: 'declares itself',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ran'; },
  });
  api.registerTool({
    name: 'QuietPluginTool',
    description: 'does not declare itself',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ran'; },
  });
}
export default { name: 'ptc-declares', version: '1.0.0' };
`, 'utf8');

  const loader = await import('../src/plugin.js');
  const load = loader.loadPlugin || loader.loadPluginDir || loader.loadPlugins || loader.installPlugin;
  assert.equal(typeof load, 'function', 'the plugin loader must be reachable');
  await load(pdir);

  assert.ok(pluginTools.some((t) => t.name === 'SafePluginTool'), 'the plugin loaded');

  const names = callableTools();
  assert.ok(names.includes('SafePluginTool'), 'a declared tool joins the callable set');
  assert.ok(!names.includes('QuietPluginTool'), 'an undeclared one does not');
});

test('generated code can call a declared plugin tool, and cannot call an undeclared one', async () => {
  const ctx = { cwd: dir, workspace: dir, readPool: new Map() };

  const ok = await runProgrammatic("print(await callTool('SafePluginTool', {}));", ctx);
  assert.equal(ok.ok, true, ok.error);
  assert.match(String(ok.output), /ran/);

  const refused = await runProgrammatic("await callTool('QuietPluginTool', {});", ctx);
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /not callable from code/);
});

test('the sandbox still refuses a shell', async () => {
  const refused = await runProgrammatic("await callTool('Bash', { command: 'echo hi' });", {
    cwd: dir, workspace: dir, readPool: new Map(),
  });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error), /not callable/);
});
