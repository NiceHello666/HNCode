// The lead's inbox: how a teammate reaches the agent that commands the team.
//
// WHY THIS FILE EXISTS
// --------------------
// A team of four came back as a lead with no members and five unread messages nobody had ever
// opened. Separate defects produced that:
//
//   1. NOTHING READ THE LEAD'S INBOX. Teammates drain their own box through `waitForMail`; the
//      lead had no reader at all, and `formatRoster` hardcoded its unread count to 0. So a
//      member asking "what should I work on?" wrote into a file nobody opened.
//   2. A FINISHED TEAMMATE WAS REMOVED FROM THE ROSTER, taking its inbox with it
//      (`removeTeammate` clears the mailbox). A member that had reported in and was waiting for
//      work vanished, along with everything it had said.
//   3. The idle timeout made a member quit after two quiet minutes, so a later instruction
//      arrived with nobody there to receive it.
//
// A FOURTH, SELF-INFLICTED DEFECT SHAPES THE TESTS BELOW.
// A first fix for (1) decided "the lead" must be the user, filtered the inbox down to messages
// from non-lead senders, and refused to send TO the lead. That broke the one thing the user
// wanted — commanding the team — and it was a misreading: `lead` is a ROLE on a real agent
// record. See "the lead is a rostered member with its own inbox, not the user".
//
// ROSTER FACTS THIS FILE RELIES ON (both are the real, documented behaviour):
//   * `createTeam` leaves the roster EMPTY on purpose.
//   * `addMember` makes the FIRST member added the lead, overwriting any `leadName` passed to
//     `createTeam`. So `/team create` + `/team add` is what puts a lead on the roster, and the
//     lead's roster name is not the fixed `team-lead` alias.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-leadbox-'));
process.env.HNCODE_HOME = home;
process.env.USERPROFILE = home;
process.env.HOME = home;

const teamMod = await import('../src/team/team.js');
const { writeToMailbox } = await import('../src/team/mailbox.js');

/**
 * A team with two recruits on the roster, the way `/team create` plus two `/team add`s produces one.
 *
 * NEITHER RECRUIT IS THE LEAD. `createTeam` records `leadName: team-lead` and `addMember` gives every recruit
 * the plain `member` role. `leadName` is the box `readLeadInbox` opens, so `lead` here is that NAME, not a
 * member — the two recruits are `teammate` and `other`, and both have real inboxes of their own.
 */
function freshTeam(teamName) {
  const r = teamMod.createTeam({ teamName, cwd: process.cwd() });
  assert.ok(r && r.ok !== false, `team created: ${JSON.stringify(r)}`);
  // The name the reader opens. Asking `leadOf` rather than hardcoding keeps the fixture honest if
  // `createTeam` is ever given a different lead.
  const lead = teamMod.leadOf(teamName);
  const teammate = 'NiceHello_01';
  const other = 'NiceHello_02';
  const a = teamMod.addMember(teamName, { name: teammate, cwd: process.cwd() });
  assert.ok(a && a.ok !== false, `first recruit added: ${JSON.stringify(a)}`);
  assert.equal(a.member.role, 'member', 'a recruit is a member, not a lead');
  const b = teamMod.addMember(teamName, { name: other, cwd: process.cwd() });
  assert.ok(b && b.ok !== false, `second recruit added: ${JSON.stringify(b)}`);
  return { teamName, lead, teammate, other };
}

// ---------------------------------------------------------------------------
// the lead is an agent, not the user
// ---------------------------------------------------------------------------

test('the lead name is the wire alias, and recruits are members', () => {
  // `createTeam` records `leadName: team-lead`; `addMember` gives every recruit the plain `member` role.
  // Promoting the first recruit to lead was tried and reversed — see the note in team.js.
  const { teamName, lead, teammate } = freshTeam('leadidentity');
  assert.equal(lead, 'team-lead', 'the lead name is the alias');
  const member = teamMod.findMember(teamName, teammate);
  assert.ok(member, 'the recruit is on the roster');
  assert.equal(member.role, 'member', 'a recruit carries the member rank');
  assert.match(member.agentId, /@/, 'and it still has a real agent id');
});

test('the panel can send to the lead, because the lead is an agent', () => {
  // Commanding the team means instructing its lead. Refusing that made the one message the user
  // most wants to send impossible.
  //
  // The message lands in the LEAD's own inbox for the lead's own `waitForMail` to pick up — it is
  // deliberately not read back by `readLeadInbox`, which serves the user's session and skips
  // anything carrying the user's own `team-lead` alias. Asserting on the box directly is what
  // distinguishes "delivered to the lead" from "echoed to the sender".
  const { teamName, lead } = freshTeam('panelsend');
  return import('../src/team-panel.js').then(async ({ sendFromPanel }) => {
    assert.equal(sendFromPanel(teamName, lead, 'take the swarm review'), true);
    const { readMailbox } = await import('../src/team/mailbox.js');
    const box = readMailbox(teamName, lead);
    assert.equal(box.length, 1, 'it is in the lead\'s inbox, for the lead to read');
    assert.equal(box[0].text, 'take the swarm review');
    assert.equal(box[0].from, 'team-lead', 'stamped with the user as the sender');
    assert.deepEqual(teamMod.readLeadInbox(teamName), [],
      'and the user is not handed their own message back');
  });
});

// ---------------------------------------------------------------------------
// reading the lead's mail
// ---------------------------------------------------------------------------

test('a teammate\'s mail is read whichever name it was addressed under', () => {
  const { teamName, lead } = freshTeam('inboxlead');
  // A teammate replies to the name it sees on the roster...
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'roster name' });
  // ...and a reply can also arrive addressed through the fixed alias.
  writeToMailbox(teamName, 'team-lead', { from: 'NiceHello_02', text: 'wire alias' });

  const texts = teamMod.readLeadInbox(teamName).map((m) => m.text).sort();
  assert.deepEqual(texts, ['roster name', 'wire alias']);
});

test('the user\'s own message to the lead is NOT read back as team mail', () => {
  // The reported symptom: the user sent a short greeting to the lead from the panel and was handed
  // `<team-inbox>team-lead: <their own words></team-inbox>` on the next turn — their own instruction
  // presented to the model as though a teammate had sent it.
  //
  // Every send from the panel or `/team msg` is stamped `from: TEAM_LEAD_NAME`, so the alias on a
  // message means THE USER WROTE IT. That is the filter — not "the lead is the user", which is the
  // misreading that once deleted this check.
  const { teamName, lead } = freshTeam('selfsent');
  writeToMailbox(teamName, lead, { from: 'team-lead', text: '你好' });
  assert.deepEqual(teamMod.readLeadInbox(teamName), [],
    'the user\'s own words are not mail from the team');
  assert.equal(teamMod.formatLeadInbox(teamName, { mark: true }), '');

  // A teammate's message beside it still comes through.
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'a real question' });
  const got = teamMod.readLeadInbox(teamName);
  assert.equal(got.length, 1, `only the teammate's: ${JSON.stringify(got.map((m) => m.text))}`);
  assert.equal(got[0].from, 'NiceHello_02');
});

test('a sender the roster does not know is still delivered', () => {
  // An agent that has since left, or a name written by another tool. The box is the record of
  // what arrived; deciding it "should not be there" would silently drop a real message.
  const { teamName, lead } = freshTeam('ghostsender');
  writeToMailbox(teamName, lead, { from: 'SomeoneWhoLeft', text: 'still here?' });
  assert.equal(teamMod.readLeadInbox(teamName).length, 1);
});

test('reading without marking leaves the mail where it is', () => {
  // A count-only reader must not consume anything, or the roster would empty the box before the
  // model ever saw it. This is why `mark` is an option rather than the default.
  const { teamName, lead } = freshTeam('countonly');
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'hello' });
  assert.equal(teamMod.readLeadInbox(teamName).length, 1);
  assert.ok(teamMod.formatLeadInbox(teamName).length > 0, 'formatting without mark works');
  assert.equal(teamMod.readLeadInbox(teamName).length, 1, 'and consumed nothing');
});

test('marking consumes exactly the batch that was handed over', () => {
  const { teamName, lead } = freshTeam('marking');
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'first' });
  const batch = teamMod.readLeadInbox(teamName);
  assert.equal(batch.length, 1);
  teamMod.markLeadInboxRead(teamName, batch);
  assert.equal(teamMod.readLeadInbox(teamName).length, 0, 'consumed');

  // A message arriving AFTER the batch was taken must survive — the same read-then-mark window
  // the teammate path guards with `markAllRead(…, ids)`.
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'second' });
  assert.equal(teamMod.readLeadInbox(teamName).length, 1, 'the later message is still waiting');
});

test('formatting WITH mark consumes it, so the model sees each message once', () => {
  const { teamName, lead } = freshTeam('formatmark');
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'task please' });
  const first = teamMod.formatLeadInbox(teamName, { mark: true });
  assert.match(first, /task please/);
  assert.equal(teamMod.formatLeadInbox(teamName, { mark: true }), '',
    'a later turn does not repeat mail the model already read');
});

test('the block names the sender and says how to answer', () => {
  const { teamName, lead } = freshTeam('formatting');
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'idle and ready, what should I do?' });
  const block = teamMod.formatLeadInbox(teamName);
  assert.match(block, /from NiceHello_02/, 'the sender is named');
  assert.match(block, /SendMessage/, 'and the model is told how to answer');
});

test('an empty inbox renders as an empty string, not a stray heading', () => {
  const { teamName } = freshTeam('emptybox');
  assert.equal(teamMod.formatLeadInbox(teamName), '');
});

test('the roster reports the lead\'s unread count instead of hiding it', () => {
  // `const unread = isLead ? 0 : …` made the roster claim the lead had nothing waiting while
  // five messages sat in its inbox — the reading that made the team look dead.
  const { teamName, lead } = freshTeam('rosterunread');
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'a' });
  writeToMailbox(teamName, lead, { from: 'NiceHello_02', text: 'b' });
  const block = teamMod.formatLeadInbox(teamName);
  assert.match(block, /2 unread message/, `the count shows:\n${block}`);
});

test('a missing team reads as an empty inbox rather than throwing', () => {
  assert.deepEqual(teamMod.readLeadInbox('no-such-team'), []);
  assert.equal(teamMod.formatLeadInbox('no-such-team'), '');
});

// ---------------------------------------------------------------------------
// the teammate lifecycle: it must survive to be given work
// ---------------------------------------------------------------------------

test('the idle timeout defaults to waiting forever', async () => {
  const { TEAMMATE_IDLE_TIMEOUT_MS } = await import('../src/team/constants.js');
  assert.equal(TEAMMATE_IDLE_TIMEOUT_MS, 0, 'the constant means "no timeout"');

  const { waitForMail } = await import('../src/team/runner.js');
  const { teamName, lead } = freshTeam('waits');
  writeToMailbox(teamName, 'NiceHello_02', { from: lead, text: 'a job for you' });
  const got = await waitForMail(teamName, 'NiceHello_02', { pollMs: 10 });
  assert.equal(got.length, 1, 'delivered without waiting out a deadline');
  assert.equal(got[0].text, 'a job for you');
});

test('waitForMail still honours shouldStop, so a disband is prompt', async () => {
  const { waitForMail } = await import('../src/team/runner.js');
  const { teamName } = freshTeam('stops');
  let calls = 0;
  const got = await waitForMail(teamName, 'Nobody', { pollMs: 5, shouldStop: () => ++calls > 2 });
  assert.equal(got, null, 'stopping returns null rather than hanging');
});

test('a bounded wait still expires when the caller asks for one', async () => {
  const { waitForMail } = await import('../src/team/runner.js');
  const { teamName } = freshTeam('bounded');
  const started = Date.now();
  const got = await waitForMail(teamName, 'Nobody', { timeoutMs: 60, pollMs: 10 });
  assert.equal(got, null, 'a positive timeout still ends the wait');
  assert.ok(Date.now() - started >= 50, 'and it actually waited');
});

test('spawn keeps the member on the roster when its run ends', () => {
  // The removal is what erased a waiting teammate and its mail. Asserted at the source because
  // the alternative is spawning a real teammate with a real model.
  const src = fs.readFileSync(path.resolve('src/team/spawn.js'), 'utf8');
  const at = src.indexOf('} finally {');
  assert.ok(at > 0, 'the finally block was found');
  const body = src.slice(at, src.indexOf('running.set(', at));
  assert.ok(!/removeTeammate\s*\(/.test(body), 'the finally does not remove the teammate');
  assert.match(src, /setMemberActive\(teamName, name, false\)/,
    'it only marks the member inactive, so a later message still finds it');
});
