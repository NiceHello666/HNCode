// The two swarm bugs, driven through the real code paths.
//
// BUG 1 — every cell but the first stayed "Queued…" for the whole run.
// `agent-swarm.js` reported progress only through `appendTaskOutput`, which feeds the
// BACKGROUND TASK buffer (TaskOutput, and the record that survives a detach). The
// transcript's progress block does not read that: it counts `[n/m] finished` lines out
// of `entry.liveOutput`, which is only written from `tool_output` events, i.e. from
// `ctx.onOutput`. Nothing ever wrote there, so the count stayed 0 and the "cell i ===
// done" rule put cell 0 on "Working…" and left every other cell at its initial phase.
//
// BUG 2 — AgentSwarm was offered on every turn. `state.swarm` only appended a paragraph
// to the system prompt; the tool stayed in the catalog, so 128 subagents could run in a
// session where the user had never opted in.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A store far away from the real one, in case anything here touches session state.
process.env.HNCODE_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-swarm-test-'));

const { renderSwarmProgress, membersFromOutput, normalizeMember } = await import('../src/swarm-progress.js');

// ---------------------------------------------------------------------------
// BUG 1: the live sink receives the progress lines
// ---------------------------------------------------------------------------

test('AgentSwarm reports progress to the live sink, not only the task buffer', () => {
  const src = fs.readFileSync(new URL('../src/tools/agent-swarm.js', import.meta.url), 'utf8');
  // The finish line must reach ctx.onOutput. Asserting on the source is deliberate: the
  // alternative is spawning a real swarm, and the defect being guarded is a MISSING call,
  // which no amount of unit-testing the surrounding code can observe.
  const at = src.indexOf('appendTaskOutput(task, line);');
  assert.ok(at > 0, 'the progress line is built in the worker');
  const around = src.slice(Math.max(0, at - 900), at + 300);
  assert.match(around, /ctx\.onOutput\(line\)/,
    'the progress line is also sent to ctx.onOutput (the channel the UI reads)');
  assert.match(around, /appendTaskOutput/,
    'and still to the task buffer, which is what survives a Ctrl+B detach');
});

test('AgentSwarm names the agent in each progress line, not just a running total', () => {
  const src = fs.readFileSync(new URL('../src/tools/agent-swarm.js', import.meta.url), 'utf8');
  // A bare `[n/m]` count forces the reader to guess WHICH agents are done, and the guess
  // is wrong whenever they finish out of order — which they do, since the workers pull from
  // a shared queue.
  assert.match(src, /\[#\$\{i \+ 1\}\] finished/, 'the finish line names its agent');
  assert.match(src, /\[#\$\{i \+ 1\}\] progress/, 'and a progress line reports one agent at a time');
  assert.match(src, /_onSubProgress/, 'fed by the subagent step counter');
  assert.match(src, /medianSteps\(finishedSteps\)/, 'paced against the swarm\'s own finished agents');
});

test('membersFromOutput attributes a finish to the agent that reported it', () => {
  // #2 finishes FIRST, while #1 is still working. The old count-based rule marked #1 done.
  const out = '[#1] started\n[#2] started\n[#3] started\n'
    + '[#1] progress 20\n[#2] progress 60\n[#2] finished [1/3]\n';
  const members = membersFromOutput(out, 3);
  assert.deepEqual(members.map((m) => m.phase), ['working', 'completed', 'working'],
    'the cell that finished is #2, not the first one in the list');
});

test('membersFromOutput reports each agent\'s own ratio', () => {
  const out = '[#1] started\n[#2] started\n[#1] progress 25\n[#2] progress 80\n';
  const members = membersFromOutput(out, 2);
  assert.deepEqual(members.map((m) => m.ratio), [0.25, 0.8],
    'two agents doing different amounts of work show different bars');
});

test('an agent that has not started yet reads as queued', () => {
  const out = '[#1] started\n';
  const members = membersFromOutput(out, 3);
  assert.deepEqual(members.map((m) => m.phase), ['working', 'queued', 'queued']);
});

test('normalizeMember carries the ratio through to the renderer', () => {
  // Dropping it here is what made every cell fall back to a placeholder no matter what the
  // agent reported: the wire carried a figure and `renderCell` never received one.
  const [m] = [normalizeMember({ phase: 'working', ratio: 0.75 }, 0)];
  assert.equal(m.ratio, 0.75);
  assert.equal(normalizeMember({ phase: 'working' }, 0).ratio, null, 'absent ratio stays null');
});

test('a cell with no ratio does not claim to be half done', () => {
  // The reported symptom: every running agent drew the same half-filled bar for its whole
  // life, so seven agents showed seven identical 50% bars and then jumped to 100%.
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const grid = renderSwarmProgress({ members: [{ phase: 'working' }] }, 40, { indent: '' });
  const row = grid.map(strip).find((l) => l.includes('001')) || '';
  // COUNT the filled cells. The old `!/\[#{5,}\]/` was vacuous: a bar is `#…#---…`, so the
  // run of `#` is always followed by `-`, and the pattern only matched if EVERY cell was
  // filled — it stayed green with the 0.5 placeholder restored. It also could not tell
  // 5% from 50%.
  const filled = (row.match(/#/g) || []).length;
  const total = filled + (row.match(/-/g) || []).length;
  assert.ok(total > 0, `the bar rendered: ${row}`);
  assert.ok(filled <= 1, `a ratio-less cell is not half full (${filled}/${total}): ${row}`);
});

// ---------------------------------------------------------------------------
// BUG 2: swarm mode gates the tool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BUG 2: swarm mode gates the tool
// ---------------------------------------------------------------------------

test('AgentSwarm is exposed only when swarm mode is on', () => {
  const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /t\.name === 'AgentSwarm' && !cfg\.swarm/,
    'the catalog filter drops AgentSwarm unless cfg.swarm is set');
  assert.match(src, /this\.swarmMode = !!cfg\.swarm/,
    'and the direct-call path has a matching flag');
});

test('a call to AgentSwarm with the mode off is refused, with the fix in the message', () => {
  const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /swarmMode !== true && tc\.name === 'AgentSwarm'/,
    'the executor blocks a stray call');
  assert.match(src, /swarm mode is OFF[\s\S]{0,200}\/swarm/,
    'and tells the model to ask for /swarm rather than just refusing');
});

test('the per-turn cfg carries swarm mode from the UI state', () => {
  // The mode lives on `state`, but the tool catalog is decided in the Agent constructor,
  // Format-agnostic: the object may be written on one line or spread over several, and
  // adding a key to it must not break a test about swarm mode.
  const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  // Extracted by BRACE MATCHING, not by a length-bounded regex: the object grows as keys are
  // added, and `{0,800}` silently stopped matching once it passed 1271 characters.
  const start = src.indexOf('cfg: {');
  assert.ok(start >= 0, 'the per-turn Agent cfg object was not found');
  let depth = 0;
  let end = start + 4;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) break; }
  }
  const cfgObj = src.slice(start, end + 1);
  assert.match(cfgObj, /swarm: !!state\.swarm/,
    "the turn passes swarm mode into the Agent cfg");
  assert.match(cfgObj, /tasks: \(state\.tasks = state\.tasks \|\| \{\}\)/,
    "and reuses the existing task registry rather than a fresh one");
});

test('the tool description says the mode is required', async () => {
  const { spec } = await import('../src/tools/agent-swarm.js');
  assert.match(spec.description, /swarm mode is on/i,
    'the model is told the tool needs the mode');
});

// ---------------------------------------------------------------------------
// the progress block still renders (the fix must not break the drawing)
// ---------------------------------------------------------------------------

test('a mixed swarm renders one cell per subagent plus a status line', () => {
  const lines = renderSwarmProgress({
    description: 'two jobs',
    model: 'coder',
    members: [
      { phase: 'completed', ratio: 1, latestText: '' },
      { phase: 'working', ratio: 0.5, latestText: 'reading a file' },
      { phase: 'queued', ratio: 0, latestText: '' },
    ],
  }, 100, { indent: ' ', availableGridHeight: 8 });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain.some((l) => l.includes('Agent Swarm')), 'header present');
  assert.ok(plain.some((l) => l.includes('001') && l.includes('Completed')), 'first cell completed');
  assert.ok(plain.some((l) => l.includes('002') && l.includes('Working')), 'second cell working');
  assert.ok(plain.some((l) => l.includes('003') && l.includes('Queued')), 'third cell still queued');
  assert.ok(plain.some((l) => /Working/.test(l) && /[━#]/.test(l)), 'overall status line with a pip bar');
});

test.after(() => {
  try { fs.rmSync(process.env.HNCODE_SESSIONS_DIR, { recursive: true, force: true }); } catch { /* temp */ }
  delete process.env.HNCODE_SESSIONS_DIR;
});
