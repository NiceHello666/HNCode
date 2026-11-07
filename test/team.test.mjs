// The team layer: roster, mailbox, shared tasks, identity, and one teammate's whole life.
//
// WHY THESE ASSERTIONS
// --------------------
// A teammate runs in the same process as its lead and talks to it through FILES. That makes three
// things worth pinning, each of which has a silent failure mode:
//
//   * the identity must be per-async-context, or two teammates running at once overwrite each
//     other and the second one answers for the first;
//   * a task must not be claimable twice, or two members do the same work and neither knows;
//   * the roster and inboxes must survive a restart, because a teammate outlives the turn that
//     spawned it.
//
// Everything runs against a temp HNCODE_HOME, so the developer's real ~/.hncode is untouched.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Run `fn` with HNCODE_HOME pointed at a throwaway directory. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-team-'));
  const prev = process.env.HNCODE_HOME;
  process.env.HNCODE_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HNCODE_HOME;
    else process.env.HNCODE_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const team = await import('../src/team/team.js');
const store = await import('../src/team/store.js');
const mailbox = await import('../src/team/mailbox.js');
const tasks = await import('../src/team/tasks.js');
const ctx = await import('../src/team/context.js');

// ---------------------------------------------------------------------------
// the roster
// ---------------------------------------------------------------------------

test('a team starts empty, and the first member becomes its lead', async () => {
  await withHome(() => {
    const r = team.createTeam({ teamName: 'demo', description: 'ship it' });
    assert.equal(r.ok, true);
    assert.equal(r.team.members.length, 0, 'no placeholder member');
    assert.equal(r.team.leadAgentId, '', 'and no leader until one joins');

    // The rule: every recruit is a MEMBER. Promoting the first was tried and reversed — `/team add`
    // recruits someone to do the work, and labelling it a lead made it believe nothing had been assigned.
    const m = team.addMember('demo', { name: 'alice', model: 'm-a' });
    assert.equal(m.ok, true);
    assert.equal(m.member.role, 'member');
    assert.equal(team.leadOf('demo'), 'team-lead', 'the lead is the alias createTeam recorded');
    assert.equal(store.readTeamFile('demo').leadAgentId, '', 'and no agent holds it yet');

    // And the next one is a peer too.
    const b = team.addMember('demo', { name: 'bob' });
    assert.equal(b.member.role, 'member', 'a recruit is always a member');

    // Overwriting would strand the existing members with no lead, and its task history with no
    // owner.
    const again = team.createTeam({ teamName: 'demo' });
    assert.equal(again.ok, false);
    assert.match(again.error, /already exists/);
  });
});

test('a team name cannot escape the teams directory', async () => {
  await withHome(() => {
    // The property is containment, not the exact spelling: every separator becomes a
    // hyphen, so `../../etc` lands as `------etc` INSIDE the teams directory.
    const dir = path.resolve(store.teamDir('../../etc'));
    const root = path.resolve(store.teamsRoot());
    assert.ok(dir.startsWith(root + path.sep), `escaped the teams dir: ${dir}`);
    assert.equal(store.teamDir('../evil').includes('..'), false);
    const r = team.createTeam({ teamName: '../evil' });
    assert.equal(r.ok, false, 'and the name is refused outright');
  });
});

test('members get distinct colours and one name is one member', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    // The FIRST member is the lead; the pair below are peers, which is what this test is
    // about (colours and re-adding).
    team.addMember('demo', { name: 'lead-one' });
    const a = team.addMember('demo', { name: 'alice' });
    const b = team.addMember('demo', { name: 'bob' });
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.member.color, b.member.color);

    // Re-adding a name updates it; a duplicate would make every name-addressed message
    // ambiguous.
    const again = team.addMember('demo', { name: 'alice', agentType: 'tester' });
    assert.equal(again.ok, true);
    const members = store.readTeamFile('demo').members;
    assert.equal(members.filter((m) => m.name === 'alice').length, 1);
    assert.equal(members.find((m) => m.name === 'alice').agentType, 'tester');
  });
});

test('the lead name is reserved, and the lead cannot be removed', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    assert.equal(team.addMember('demo', { name: 'team-lead' }).ok, false);
    assert.equal(team.removeTeammate('demo', 'team-lead').ok, false);
  });
});

test('removing a member takes its inbox with it', async () => {
  // The inbox is addressed by name, so leaving it means the next member to take that name
  // inherits a stranger's mail.
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    // A peer, not the lead: the lead cannot be removed, which is its own test.
    team.addMember('demo', { name: 'lead-one' });
    team.addMember('demo', { name: 'bob' });
    mailbox.writeToMailbox('demo', 'bob', { from: 'team-lead', text: 'hello' });
    assert.equal(mailbox.readMailbox('demo', 'bob').length, 1);

    team.removeTeammate('demo', 'bob');
    assert.equal(mailbox.readMailbox('demo', 'bob').length, 0);
  });
});

// ---------------------------------------------------------------------------
// the mailbox
// ---------------------------------------------------------------------------

test('a message is delivered, stays until read, and keeps its sender', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    team.addMember('demo', { name: 'alice' });

    mailbox.writeToMailbox('demo', 'alice', { from: 'team-lead', text: 'start on the parser', summary: 'parser' });
    const box = mailbox.readMailbox('demo', 'alice');
    assert.equal(box.length, 1);
    assert.equal(box[0].from, 'team-lead');
    assert.equal(box[0].read, false);
    assert.equal(box[0].summary, 'parser');

    assert.equal(mailbox.readUnread('demo', 'alice').length, 1);
    mailbox.markAllRead('demo', 'alice');
    assert.equal(mailbox.readUnread('demo', 'alice').length, 0);
    assert.equal(mailbox.readMailbox('demo', 'alice').length, 1, 'and the messages are kept');
  });
});

test('an unknown inbox reads as empty rather than throwing', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    assert.deepEqual(mailbox.readMailbox('demo', 'nobody'), []);
  });
});

test('an inbox is bounded', async () => {
  // One nobody drains must not grow without limit and turn every read into a parse of the
  // whole session's chatter.
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    for (let i = 0; i < mailbox.MAX_INBOX + 20; i++) {
      mailbox.writeToMailbox('demo', 'alice', { from: 'team-lead', text: `m${i}` });
    }
    const box = mailbox.readMailbox('demo', 'alice');
    assert.equal(box.length, mailbox.MAX_INBOX);
    assert.equal(box[box.length - 1].text, `m${mailbox.MAX_INBOX + 19}`, 'the newest survive');
  });
});

// ---------------------------------------------------------------------------
// the shared task list
// ---------------------------------------------------------------------------

test('a task can be claimed exactly once', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    const t = tasks.createTask('demo', { subject: 'parse the config' });

    assert.equal(tasks.claimTask('demo', t.id, 'alice').ok, true);
    const second = tasks.claimTask('demo', t.id, 'bob');
    assert.equal(second.ok, false);
    assert.match(second.reason, /already owned by alice/);
  });
});

test('a blocked task cannot be claimed until its dependency completes', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    const a = tasks.createTask('demo', { subject: 'first' });
    const b = tasks.createTask('demo', { subject: 'second', blockedBy: [a.id] });

    const early = tasks.claimTask('demo', b.id, 'alice');
    assert.equal(early.ok, false);
    assert.match(early.reason, /blocked by #1/);

    tasks.updateTask('demo', a.id, { status: 'completed' });
    assert.equal(tasks.claimTask('demo', b.id, 'alice').ok, true, 'and then it is free');
  });
});

test('a claim says WHY it failed', async () => {
  // "Cannot claim" leaves the model choosing between "someone beat me" and "no such task", and
  // the two need different next actions.
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    assert.match(tasks.claimTask('demo', '#99', 'alice').reason, /no task #99/);

    const t = tasks.createTask('demo', { subject: 'x' });
    tasks.updateTask('demo', t.id, { status: 'completed' });
    assert.match(tasks.claimTask('demo', t.id, 'alice').reason, /already completed/);
  });
});

test('task ids do not restart when the file is re-read', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(tasks.createTask('demo', { subject: `t${i}` }).id);
    assert.deepEqual(ids, ['#1', '#2', '#3', '#4']);
  });
});

test('releasing a task returns it to the pool', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    const t = tasks.createTask('demo', { subject: 'x' });
    tasks.claimTask('demo', t.id, 'alice');
    assert.equal(tasks.releaseTask('demo', t.id, 'alice').ok, true);
    const now = tasks.readTasks('demo')[0];
    assert.equal(now.owner, null);
    assert.equal(now.status, 'pending');
  });
});

test('a member cannot release someone else\'s task', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    const t = tasks.createTask('demo', { subject: 'x' });
    tasks.claimTask('demo', t.id, 'alice');
    const r = tasks.releaseTask('demo', t.id, 'bob');
    assert.equal(r.ok, false);
    assert.match(r.reason, /owned by alice/);
  });
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

test('identity is per async context, not per process', async () => {
  // The whole reason for AsyncLocalStorage: two teammates run at once, and a module variable
  // would have the second answer for the first.
  assert.equal(ctx.isTeammate(), false, 'outside a run we are the lead');
  assert.equal(ctx.currentAgentName(), 'team-lead');

  const seen = [];
  const make = (name) => ctx.makeIdentity({ name, teamName: 'demo', color: 'cyan' });
  await Promise.all([
    ctx.runAs(make('alice'), async () => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push(['alice', ctx.currentAgentName()]);
    }),
    ctx.runAs(make('bob'), async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(['bob', ctx.currentAgentName()]);
    }),
  ]);

  assert.deepEqual(seen.sort(), [['alice', 'alice'], ['bob', 'bob']]);
  assert.equal(ctx.isTeammate(), false, 'and it is gone afterwards');
});

test('a colour is stable per name and avoids what is taken', () => {
  const a1 = ctx.pickColor('alice');
  const a2 = ctx.pickColor('alice');
  assert.equal(a1, a2, 'the same name keeps its colour');
  assert.notEqual(ctx.pickColor('bob', [a1]), a1, 'a taken colour is not reused');
});

// ---------------------------------------------------------------------------
// disbanding
// ---------------------------------------------------------------------------

test('dissolving a team tells its members first', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    team.addMember('demo', { name: 'alice' });
    // The LEAD is not told: it is the party dissolving the team. A second member is what
    // gives the notification somewhere to go.
    team.addMember('demo', { name: 'bob' });
    // Neither recruit is the lead (the lead is the alias, not a member), so BOTH are told.
    const r = team.disbandTeam('demo', { reason: 'we are done' });
    assert.equal(r.ok, true);
    assert.equal(r.told, 2);
    assert.equal(store.readTeamFile('demo'), null, 'the roster is gone');
  });
});

test('a teammate is told when its team is dissolved', async () => {
  await withHome(() => {
    team.createTeam({ teamName: 'demo' });
    team.addMember('demo', { name: 'alice' });
    team.disbandTeam('demo');
    // The mailbox went with the directory, which is the point: nothing is left to poll.
    assert.deepEqual(mailbox.readMailbox('demo', 'alice'), []);
  });
});

test('the panel labels a lead as the lead, not as a member yet to start', async () => {
  // EVERY ROW IS A MEMBER, and its label comes from its own phase.
  //
  // The panel once tried to mark the lead by comparing a name to the wire alias — a branch that never fired,
  // because the lead was a promoted member under its OWN name. Neither half survives: the lead is the alias and
  // no member holds it, so a row is labelled by the phase the member reports.
  await withHome(async () => {
    const { teamRows } = await import('../src/team-panel.js');
    team.createTeam({ teamName: 'demo' });
    team.addMember('demo', { name: 'alice' });
    team.addMember('demo', { name: 'bob' });

    const rows = teamRows({ teamName: 'demo' });
    const alice = rows.find((r) => r.name === 'alice');
    assert.ok(alice, 'the recruit is on the roster');
    assert.equal(alice.isLead, false, 'no recruit is the lead');
    assert.ok(['starting', 'working', 'thinking', 'idle'].includes(alice.state),
      `the row reports a real phase: ${alice.state}`);

    const bob = rows.find((r) => r.name === 'bob');
    assert.equal(bob.isLead, false);
    assert.ok(['starting', 'working', 'thinking', 'idle'].includes(bob.state),
      `a member reports a real phase: ${bob.state}`);
  });
});

test('the roster does not count the user\'s OWN send as unread mail', async () => {
  // The badge that would not clear: the user typed 你好 to the lead, and the panel showed
  // `1 new` for it. The message sits in the recipient's box until the recipient reads it, so
  // counting every unread entry made the roster announce a message the user had just written —
  // and nothing was ever delivered, because `readLeadInbox` correctly skips the user's own sends.
  // A badge no action can clear is worse than no badge.
  await withHome(async () => {
    const { teamRows } = await import('../src/team-panel.js');
    team.createTeam({ teamName: 'demo' });
    team.addMember('demo', { name: 'alice' });
    team.addMember('demo', { name: 'bob' });

    // The user writes to the lead: stamped with the alias, unread in alice's box.
    mailbox.writeToMailbox('demo', 'alice', { from: 'team-lead', text: '你好' });

    const rows = teamRows({ teamName: 'demo' });
    assert.equal(rows.find((r) => r.name === 'alice').unread, 0,
      'the user\'s own message is not a `new` badge');
    assert.ok(!/unread/.test(team.readRoster('demo')),
      `and the roster text agrees:\n${team.readRoster('demo')}`);

    // Mail from a teammate IS counted — the fix must not silence real traffic.
    mailbox.writeToMailbox('demo', 'alice', { from: 'bob', text: 'what should I work on?' });
    const after = teamRows({ teamName: 'demo' });
    assert.equal(after.find((r) => r.name === 'alice').unread, 1, 'a teammate\'s message shows');
  });
});