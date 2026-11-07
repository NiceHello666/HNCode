// Creating, joining and leaving a team.
//
// A team is a roster on disk plus a task list. Nothing here runs an agent — that is the runner's
// job, and keeping the two apart means the bookkeeping can be reasoned about (and tested)
// without spawning anything.
import fs from 'node:fs';
import {
  readTeamFile, writeTeamFile, deleteTeam, removeMember, updateMember,
  formatAgentId, sanitizeName, teamDir, listTeams, inboxPath,
} from './store.js';
import { clearMailbox, writeToMailbox, readMailbox, readUnread, markAllRead } from './mailbox.js';
import { pickColor } from './context.js';
import { TEAM_LEAD_NAME, MAX_TEAMMATES } from './constants.js';

/**
 * Create a team with `leadName` as its lead.
 *
 * A name already in use is REFUSED rather than silently replaced: the existing roster and task
 * history belong to a session that may still be running, and overwriting it would strand those
 * members with no lead.
 */
export function createTeam({ teamName, description = '', leadName = TEAM_LEAD_NAME, leadSessionId, cwd }) {
  const name = String(teamName || '').trim();
  if (!name) return { ok: false, error: 'a team name is required' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
    return { ok: false, error: `"${name}" is not usable as a team name — letters, digits, spaces, - and _ only` };
  }

  const existing = readTeamFile(name);
  if (existing) {
    return { ok: false, error: `team "${name}" already exists (${existing.members.length} member(s)). Pick another name, or delete it first.` };
  }

  // NO members yet. The first one added becomes the lead — see addMember — so a team is not
  // born with a placeholder on it, and "the first team member" is not quietly the second.
  const team = {
    name,
    description: String(description || ''),
    createdAt: Date.now(),
    // Filled in when the first member joins. Until then the team has no leader, which is a
    // true statement about it rather than a placeholder.
    leadAgentId: '',
    leadName,
    leadSessionId: leadSessionId || '',
    members: [],
  };
  writeTeamFile(name, team);
  return { ok: true, team };
}

/**
 * Put a member on the roster.
 *
 * Returns the member record. Re-adding an existing name updates it instead of duplicating —
 * which is what re-spawning a teammate that died should do, and a duplicate would make every
 * name-addressed message ambiguous.
 */
export function addMember(teamName, { name, agentType = 'general', model = '', taskId = null, cwd, prompt = '' }) {
  const team = readTeamFile(teamName);
  if (!team) return { ok: false, error: `no team "${teamName}"` };

  const memberName = String(name || '').trim();
  if (!memberName) return { ok: false, error: 'a teammate name is required' };
  const teamLead = (readTeamFile(teamName) || {}).leadName || TEAM_LEAD_NAME;
  if (memberName === teamLead) return { ok: false, error: `"${teamLead}" is the lead of this team` };

  const others = team.members.filter((m) => m.name !== memberName);
  if (others.length >= MAX_TEAMMATES) {
    return { ok: false, error: `team "${teamName}" already has ${others.length} members (max ${MAX_TEAMMATES})` };
  }

  // One sanitized name is one inbox FILE: `Bob` and `bob`, or `a-b` and `a_b`,
  // fold to the same path and would silently SHARE a mailbox, receiving each
  // other's mail. A new member whose folded name collides with an existing one
  // is refused — the caller picks a distinct name instead.
  const folded = sanitizeName(memberName);
  const clash = others.find((m) => sanitizeName(m.name) === folded);
  if (clash) {
    return { ok: false, error: `"${memberName}" folds to the same mailbox file as "${clash.name}" — pick a name that differs beyond case, dashes and underscores` };
  }

  const color = pickColor(memberName, others.map((m) => m.color));
  const member = {
    agentId: formatAgentId(memberName, teamName),
    name: memberName,
    agentType,
    // RANK, not trade. `agentType` says what a member does; this says where it sits.
    //
    // ALWAYS `member`. The first person added was made `lead`, on the reasoning that a team with no
    // leader is not a team — but that got it backwards for the only caller there is: `/team add`
    // recruits someone to DO the work, and the person typing is already in charge. Labelling the first
    // recruit a lead made it believe nobody had assigned it anything and that no message could have
    // arrived, which is exactly what it then reported.
    role: 'member',
    model,
    color,
    joinedAt: Date.now(),
    cwd: cwd || process.cwd(),
    taskId,
    prompt,
    isActive: true,
    // What the member is DOING. `isActive` alone could not say it: a round spends most of its
    // time blocked on the model, and a member that has never run is not working either.
    phase: 'starting',
  };
  team.members = [...others, member];
  writeTeamFile(teamName, team);
  return { ok: true, member };
}

/** Mark a member idle or active. Used by the roster view and by the lead's status line. */
/**
 * Record what a member is doing.
 *
 * `phase` is the real answer and `isActive` is derived from it, so a caller that only knows
 * one thing still gets a truthful roster.
 */
export function setMemberActive(teamName, memberName, isActive, phase) {
  const p = phase || (isActive === false ? 'idle' : 'starting');
  return updateMember(teamName, memberName, { isActive, phase: p });
}

/**
 * Take a member off the roster.
 *
 * Their inbox goes with them: it is addressed by name, so leaving the file behind means the next
 * member to take that name inherits a stranger's mail.
 */
export function removeTeammate(teamName, memberName) {
  const lead = (readTeamFile(teamName) || {}).leadName || TEAM_LEAD_NAME;
  if (memberName === lead) return { ok: false, error: 'the lead cannot be removed' };
  const team = readTeamFile(teamName);
  if (!team) return { ok: false, error: `no team "${teamName}"` };
  if (!team.members.some((m) => m.name === memberName)) {
    return { ok: false, error: `"${memberName}" is not on team "${teamName}"` };
  }
  removeMember(teamName, memberName);
  clearMailbox(teamName, memberName);
  return { ok: true };
}

/**
 * Dissolve a team.
 *
 * Members are told first, so a running teammate learns why its team vanished rather than finding
 * an empty roster on its next poll.
 */
export function disbandTeam(teamName, { reason = 'the lead ended the team' } = {}) {
  const team = readTeamFile(teamName);
  if (!team) return { ok: false, error: `no team "${teamName}"` };
  // By ROLE: a team whose leader is named something else still has exactly one.
  const members = team.members.filter((m) => m.role !== 'lead');
  for (const m of members) {
    try {
      writeToMailbox(teamName, m.name, {
        from: TEAM_LEAD_NAME,
        text: `[team ending] ${reason}`,
        summary: 'team ending',
      });
    } catch { /* the directory is about to go anyway */ }
  }
  deleteTeam(teamName);
  return { ok: true, told: members.length };
}

/** The roster entry for a name, or null. */
export function findMember(teamName, name) {
  const team = readTeamFile(teamName);
  if (!team) return null;
  return team.members.find((m) => m.name === name) || null;
}

/**
 * Record a member's permission mode: `ask` | `auto` | `yolo`.
 *
 * Stored on the roster rather than broadcast as a message, because the mode is a property of the member
 * that has to survive a restart — a respawn reads it here. A running member keeps the hook it was built
 * with, so a change takes effect next time it starts; that is stated in the panel's flash message rather
 * than left to surprise someone.
 *
 * `ask` is the default and the safe one: every tool call is a question. `auto` and `yolo` run without
 * asking, which is what makes them worth an explicit, per-member switch.
 */
export function setMemberMode(teamName, name, mode) {
  const team = readTeamFile(teamName);
  if (!team) return false;
  const m = team.members.find((x) => x.name === name);
  if (!m) return false;
  m.permissionMode = String(mode || 'ask');
  writeTeamFile(teamName, team);
  return true;
}

/** Everyone except `except`, used for broadcast. */
export function otherMembers(teamName, except) {
  const team = readTeamFile(teamName);
  if (!team) return [];
  return team.members.filter((m) => m.name !== except);
}

/**
 * The roster as a model should read it.
 *
 * One line per member with the state that affects what the reader should do: who is idle (can be
 * given work), who is busy (do not interrupt), what each owns.
 */
/**
 * The roster as a user or a model should read it, by NAME.
 *
 * `formatRoster` takes the team object; a caller usually holds only the name, and reading the
 * file is what the rest of this module does anyway.
 */
/**
 * The member list, by name. Empty when there is no such team.
 *
 * `readTeamFile` is store.js; this is the accessor the rest of the program should use, so a
 * caller never has to know which module owns the file.
 */
export function rosterOf(teamName) {
  const team = readTeamFile(teamName);
  return (team && Array.isArray(team.members)) ? team.members : [];
}

/**
 * The name of the member who leads this team.
 *
 * Falls back to the default name for a team written before `leadName` existed — nothing
 * about such a team can be improved by guessing a different leader.
 */
export function leadOf(teamName) {
  const team = readTeamFile(teamName);
  if (!team) return TEAM_LEAD_NAME;
  if (team.leadName) return team.leadName;
  const byRole = (team.members || []).find((m) => m.role === 'lead');
  return (byRole && byRole.name) || TEAM_LEAD_NAME;
}

/**
 * Mail for the team's lead that it has not read yet.
 *
 * "THE LEAD" IS A NAME, NOT NECESSARILY A ROSTERED AGENT. `createTeam` records `leadName` — `team-lead` by
 * default — and `addMember` gives every recruit the plain `member` role. Labelling the first recruit a lead
 * was tried and reversed: `/team add` recruits someone to DO the work, and the person typing is already in
 * charge, so a self-styled lead believed nobody had assigned it anything.
 *
 * `leadName` may still match a member on the roster, and when it does that member IS the lead and has a full
 * agent identity — `agentId`, `agentType`, `cwd`, a phase, its own inbox. Sending it an instruction is the
 * normal way to command the team.
 *
 * `TEAM_LEAD_NAME` is a separate thing: the fixed alias the USER'S OWN sends carry (`/team msg`,
 * the panel composer) and that harness notices use as their `from` (`disbandTeam`). A teammate
 * cannot be named it — `addMember` refuses — so mail under that alias is always the user's own
 * words, which is why the reader skips it. Both names are otherwise collected, because a member
 * may be addressed under the lead's roster name or the alias.
 */
export function readLeadInbox(teamName) {
  const team = readTeamFile(teamName);
  if (!team) return [];
  const leadNames = new Set([leadOf(teamName), TEAM_LEAD_NAME]);
  const out = [];
  for (const n of leadNames) {
    for (const m of readUnread(teamName, n)) {
      // Skip the USER'S OWN sends. Every message the user writes from the panel or `/team msg` is
      // stamped `from: TEAM_LEAD_NAME`, so it must not come back as mail from the team: typing
      // "hello" to the lead and being handed `team-lead: hello` as unread team traffic is the model
      // reading the person's own instruction as though an agent had sent it.
      //
      // The test is the SENDER being the alias — NOT the lead being the user. The lead is a
      // rostered agent; a message FROM it is real mail and is kept.
      if (m.from === TEAM_LEAD_NAME) continue;
      out.push({ ...m, _to: n });
    }
  }
  return out.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

/** Mark the messages `readLeadInbox` returned as read. */
export function markLeadInboxRead(teamName, messages) {
  const byName = new Map();
  for (const m of messages || []) {
    const to = m._to || leadOf(teamName);
    if (!byName.has(to)) byName.set(to, []);
    byName.get(to).push(m);
  }
  let n = 0;
  for (const [to, batch] of byName) n += markAllRead(teamName, to, batch);
  return n;
}


/**
 * The lead's unread mail as one block of text, or '' when there is none.
 *
 * `mark` decides whether reading it counts as seeing it. The caller that FEEDS it to the model
 * passes true — the model has now seen it — while a reader that only counts messages passes
 * false, or the count would empty the box before anyone read it.
 */
export function formatLeadInbox(teamName, { mark = false } = {}) {
  const unread = readLeadInbox(teamName);
  if (!unread.length) return '';
  if (mark) markLeadInboxRead(teamName, unread);
  // One block per message, delimited.
  //
  // Joined with nothing but a newline, two messages from the same sender read as one wall of text: a
  // reply that happens to begin with a number was indistinguishable from a list index, which is exactly
  // how "1: ..." twice in a row looked like broken numbering rather than two separate answers.
  const body = unread
    .map((m) => {
      const who = String(m.from || 'unknown');
      return `--- from ${who} ---\n${String(m.text || '').trim()}`;
    })
    .join('\n\n');
  return `${unread.length} unread message(s) for the team lead. Answer each with the SendMessage tool.\n\n${body}`;
}

export function readRoster(teamName) {
  return formatRoster(readTeamFile(teamName));
}

export function formatRoster(team) {
  if (!team) return 'No team.';
  const lines = [`Team "${team.name}"${team.description ? ` — ${team.description}` : ''}`];
  for (const m of team.members) {
    const isLead = m.role === 'lead';
    // `phase` when it is there; `isActive` for a member written by an older build.
    const phase = m.phase || (m.isActive === false ? 'idle' : 'starting');
    const state = isLead ? 'lead' : phase;
    // Unread mail from SOMEONE ELSE. The lead's count is reported rather than hidden — a
    // teammate waiting for an answer is what the roster should show — but the user's own sends
    // are excluded, or `readRoster` reports a message the user just typed as mail they received.
    const unread = readUnread(team.name, m.name).filter((x) => x.from !== TEAM_LEAD_NAME).length;
    const bits = [state];
    if (m.taskId) bits.push(`task ${m.taskId}`);
    if (unread) bits.push(`${unread} unread`);
    lines.push(`  ${m.name.padEnd(16)} ${bits.join(', ')}`);
  }
  return lines.join('\n');
}

/** Teams that exist on disk, for /team with no argument. */
export function knownTeams() {
  return listTeams().map((t) => ({
    name: t.name,
    description: t.description,
    members: t.members.length,
    createdAt: t.createdAt,
    leadSessionId: t.leadSessionId,
  }));
}
