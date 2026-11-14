// The team panel: who is on the team, what each is doing, and a composer to message them.
//
// WHY A PANEL AND NOT ONLY THE COMMAND
// ------------------------------------
// `/team msg alice ...` works, but a team is a thing you WATCH. The question a user has is "is
// anyone stuck, and who do I need to nudge" — and answering it from the command line means running
// `/team list`, reading four lines, and remembering them. The panel keeps the roster and each
// member's recent traffic on screen while you type.
//
// SHAPE
// -----
// Left: the roster, one line per member — name, live state, unread count. Below it a one-line
// composer. Enter sends to the selected member; Tab moves between members; Esc leaves.
//
// It follows tasks-browser.js: a pure renderer plus a key handler, so both are testable without a
// terminal.
import fs from 'node:fs';
import { C } from './colors.js';
import { visualWidth, fit } from './term.js';
import { readTeamFile } from './team/store.js';
import { readMailbox, writeToMailbox } from './team/mailbox.js';
import { readTasks, formatTasks } from './team/tasks.js';
import { TEAM_LEAD_NAME } from './team/constants.js';


/** The state a panel needs, created once when it opens. */
export function makeTeamPanel(teamName) {
  return {
    teamName,
    selectedIndex: 0,
    /** 'roster' or 'compose', so a keystroke means one thing at a time. */
    mode: 'roster',
    /**
     * Which VIEW: 'list' shows the roster, 'detail' zooms into one member.
     *
     * Two levels, like Claude Code's TeamsDialog (`teammateList` → `teammateDetail`). The roster is for
     * scanning many members; the detail is for one — its prompt, its mode, its tasks, its model. A single
     * flat screen cannot do both: the roster wants its rows, and the detail wants the space.
     *
     * `←` goes back, `Enter` goes in.
     */
    level: 'list',
    composing: '',
    caret: 0,
    flash: '',
    /**
     * How many ROWS of the conversation to show.
     *
     * Rows, not messages: messages are wrapped now, so how many fit depends on how long they are. Four
     * was chosen when each message was forced onto a single line — a multi-line answer showed only its
     * opening line and the panel reported a conversation nobody could read. The layout caps this against
     * the space actually left in the panel, so raising it cannot overflow.
     */
    mailLines: 12,
    /**
     * Each member's CONVERSATION — the entries the chat pane draws when that member is selected.
     *
     * This is the shape Claude Code uses: it renders a teammate by handing
     * `viewedAgentTask.messages` to the same `<Messages>` component the main transcript uses
     * (REPL.tsx: `displayedMessages = viewedAgentTask.messages`). One conversation per member, and the
     * view switches which one is shown — not a status line appended under a roster row.
     *
     * Entries: `{ kind: 'text'|'think'|'tool'|'tool_result', text, tool, detail }`. A `text` entry grows
     * in place while the answer streams, so the pane shows one bubble rather than a fragment per delta.
     */
    chat: {},
    /**
     * A member's outstanding permission request, if any:
     * `{ requestId, agentId, toolName, description, input }`.
     *
     * Only one at a time. Two members can block at once, and the second request waits in the inbox rather
     * than overwriting this — a prompt that changed under the user's fingers would authorise the wrong
     * call.
     */
    pendingPermission: null,
  };
}


/**
 * Whether the panel should close itself.
 *
 * The rule mirrors `useTeammateViewAutoExit`: a member that was KILLED or FAILED takes its view with it,
 * because there is nothing left to watch — but a COMPLETED one stays open, since that is exactly when a
 * person wants to read what it did. The distinction is the whole point: exiting on completion would slam
 * the transcript shut at the moment it became worth reading.
 *
 * `status` is what the roster records, not a live probe: this is called from the render path and must not
 * touch disk.
 */
export function shouldAutoExit(status) {
  if (!status) return false;
  return status === 'killed' || status === 'failed' || status === 'stopped';
}
/** How many entries a member's conversation keeps before the oldest are dropped. */
const CHAT_MAX = 400;

/**
 * The last few lines of a member's conversation, oldest of them first.
 *
 * Mirrors `getMessagePreview` in Claude Code's TeammateSpinnerLine: walk the conversation BACKWARDS, take
 * up to `n` lines, then reverse so they read in order. Text contributes its own lines; a tool call
 * contributes ONE line, preferring something descriptive over the tool's name.
 *
 * That preference is what makes the preview useful — `Bash` says nothing, `npm test` says what the member
 * is actually doing.
 */
export function previewLines(panel, name, n = 3, cols = 80) {
  const log = (panel && panel.chat && panel.chat[name]) || [];
  const out = [];
  const width = Math.max(8, cols - 10);
  const cut = (s) => {
    const one = String(s || '').replace(/\s+/g, ' ').trim();
    return one.length > width ? `${one.slice(0, width - 1)}…` : one;
  };

  for (let i = log.length - 1; i >= 0 && out.length < n; i--) {
    const e = log[i];
    if (e.kind === 'tool') {
      // A result's first line often says more than the tool's name — "npm test" over "Bash".
      const detail = String(e.detail || '').split('\n')[0];
      out.push(cut(detail || `Using ${e.tool}…`));
    } else if (e.kind === 'tool_result') {
      const first = String(e.detail || '').split('\n')[0];
      if (first) out.push(cut(first));
    } else if (e.kind === 'text' || e.kind === 'think') {
      const lines = String(e.text || '').split('\n').filter((l) => l.trim());
      for (let j = lines.length - 1; j >= 0 && out.length < n; j--) out.push(cut(lines[j]));
    }
  }
  return out.reverse();
}

/**
 * Append a live event to a member's conversation.
 *
 * THE CHAT PANE, not the roster row. The roster said `working` and nothing else, and a single activity
 * line under the name gave no history: switching to a member who was busy showed nothing at all, which
 * is the reported fault. Streaming text, tool calls and their results are appended here as entries, and
 * the pane renders them in order.
 *
 * A streaming answer is ONE entry that grows: every `text` delta appends to the last entry when it is
 * also text. Creating an entry per delta would put a bubble on every few characters and make the pane
 * unreadable for the very reason it exists.
 *
 * Bounded, because a member can produce megabytes and the pane draws a screenful.
 */
export function noteActivity(panel, stream) {
  if (!panel || !stream || !stream.name) return;
  if (!panel.chat) panel.chat = {};
  const log = panel.chat[stream.name] || (panel.chat[stream.name] = []);
  const kind = stream.kind;
  const last = log[log.length - 1];

  if (kind === 'text' || kind === 'think') {
    const chunk = String(stream.text || '');
    if (!chunk) return;
    // Consecutive deltas of the same stream merge into the entry already being written.
    if (last && last.kind === kind) last.text += chunk;
    else log.push({ kind, text: chunk });
  } else if (kind === 'tool') {
    log.push({ kind: 'tool', tool: String(stream.tool || ''), text: '' });
  } else if (kind === 'tool_result') {
    // Paired with the call it finished, by tool name: the id is not always present, and a result with
    // no call above it would read as output from nowhere.
    const call = [...log].reverse().find((e) => e.kind === 'tool' && e.tool === stream.tool && !e.done);
    if (call) {
      call.done = true;
      call.detail = String(stream.detail || '');
    } else {
      log.push({ kind: 'tool_result', tool: String(stream.tool || ''), detail: String(stream.detail || '') });
    }
  }

  if (log.length > CHAT_MAX) log.splice(0, log.length - CHAT_MAX);
}

/**
 * The members as rows, in roster order.
 *
 * The LEAD is included and is selectable: the user is the boss, and talking to the lead is how
 * they give the team its work.
 */
export function teamRows(panel) {
  const team = readTeamFile(panel.teamName);
  if (!team || !Array.isArray(team.members)) return [];
  return team.members.map((m) => {
    // Unread mail TO this member from someone ELSE. The user's own sends are stamped
    // `from: TEAM_LEAD_NAME` and sit in the recipient's box until it reads them, so counting
    // them made the roster show `1 new` for a message the user had just typed themselves —
    // a badge nothing could ever clear and nothing ever delivered.
    const unread = readMailbox(panel.teamName, m.name)
      .filter((x) => !x.read && x.from !== TEAM_LEAD_NAME).length;
    return {
      name: m.name,
      model: m.model || '',
      color: m.color || '',
      // By ROLE: a team that names its own leader still shows it as the lead.
      isLead: m.role === 'lead',
      unread,
      // The member's own PHASE — what it is doing, not whether a flag is set. `starting` covers
      // one written before the phase existed; `working` means a tool is actually running, and
      // `thinking` means it is blocked on the model, which is most of a round.
      //
      // `lead` is decided by ROLE, not by the name matching the wire alias. The alias test never
      // matched a real lead (`addMember` gives the role to the first member added, whose name is
      // its own — `NiceHello_01`, not `team-lead`), so the branch was dead and every lead fell
      // through to its phase.
      state: (m.role === 'lead') ? 'lead'
        : (m.phase || (m.isActive === false ? 'idle' : 'starting')),
      // Carried for the DETAIL view: what it runs as, what it was assigned, where it works. The roster row
      // does not draw these, but opening a member should not need a second read of the team file.
      permissionMode: m.permissionMode || 'ask',
      taskId: m.taskId || '',
      cwd: m.cwd || '',
    };
  });
}

/**
 * The traffic for one member, newest last: what was said TO them and what THEY said.
 *
 * TWO MAILBOXES, not one. A member's own inbox holds only what others sent it — everything it SAID
 * lives in the recipient's box. Reading one side meant the panel showed the user's own messages back to
 * them and nothing the member ever answered, which is why a working team looked like a silent one: the
 * member replied, the reply went to the lead's inbox, and the panel never looked there.
 *
 * Both sides are merged and ordered by time so a conversation reads in the order it happened.
 */
export function memberTraffic(teamName, name, limit = 40) {
  // THE WHOLE TEXT IS KEPT. It used to be `split('\n')[0].slice(0, 100)`: the first line only, cut at a
  // hundred characters. A member answering with a list — a capability summary, a plan, a stack trace —
  // was reduced to its opening line, so the panel showed a message that said nothing. Truncation belongs
  // in the ROW LAYOUT, where the available height is known, not here.
  //
  // ORDERED BY THE GLOBAL `seq`, not by `timestamp` and not by file position. Position is meaningful
  // only WITHIN one file, and a millisecond timestamp ties messages written in two files at once — so
  // merging by either put the user's two consecutive messages above the answer to the first one, which
  // is exactly what was reported.
  const toThem = readMailbox(teamName, name).map((m) => ({
    from: m.from,
    text: String(m.text || ''),
    at: m.timestamp,
    order: Number.isFinite(m.seq) ? m.seq : null,
  }));
  // What this member sent to the LEAD. Its other conversations (peer to peer, and on a shared task) go
  // to those recipients' boxes; the lead is the reader this panel is drawn for.
  const fromThem = readMailbox(teamName, TEAM_LEAD_NAME)
    .filter((m) => m.from === name)
    .map((m) => ({
      from: m.from,
      text: String(m.text || ''),
      at: m.timestamp,
      order: Number.isFinite(m.seq) ? m.seq : null,
    }));
  const seen = new Set();
  return [...toThem, ...fromThem]
    // A message can appear in both only if the member messaged itself; drop the copy rather than
    // showing it twice.
    .filter((m) => {
      const key = `${m.from}\u0000${m.text}\u0000${m.at || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // By the GLOBAL sequence number, which is the only key that orders messages written to two different
    // files. Falls back to the timestamp for a message written before `seq` existed.
    .sort((a, b) => {
      if (a.order != null && b.order != null) return a.order - b.order;
      return Number(a.at || 0) - Number(b.at || 0);
    })
    .map(({ order, ...rest }) => rest)
    .slice(-limit);
}

/** Draw the panel. Exactly `rows` lines, each `cols` wide. */
export function renderTeamPanel(panel, cols, rows) {
  const out = [];
  const push = (s) => { out.push(fit(s, cols)); };

  const team = readTeamFile(panel.teamName);
  const memberCount = (team && team.members) ? team.members.length : 0;
  const title = team
    ? ` Team "${panel.teamName}" — ${memberCount} member(s)`
    : ` Team "${panel.teamName}" — the roster is gone`;

  push(C.border + '─'.repeat(cols) + C.reset);
  push(C.cyan + C.bold + title + C.reset
    + (panel.flash ? `   ${C.yellow}${panel.flash}${C.reset}` : ''));

  const roster = teamRows(panel);
  // The roster, then the selected member's traffic, then the composer.

  // THE DETAIL VIEW: one member, filling the panel.
  //
  // Claude Code's `teammateDetail` does the same thing — the roster is for scanning many members, the
  // detail is for one, and a single flat screen cannot serve both. What matters when you are looking at
  // ONE member is not the roster row it came from: it is what it was asked to do, what mode it runs in,
  // how long it has been going, and what it has been saying.
  //
  // `←` returns, so everything below this block is the list view.
  if (panel.level === 'detail' && roster.length) {
    const m = roster[Math.min(panel.selectedIndex, roster.length - 1)];
    push('');
    push(`  ${C.cyan}${C.bold}@${m.name}${C.reset}  ${C.gray}${m.state || ''}${C.reset}`);
    push(`  ${C.gray}${m.model || '(no model set)'}${m.model ? '' : ''}${C.reset}`);
    push(`  ${C.gray}mode: ${m.permissionMode || 'ask'}${C.reset}`);
    if (m.taskId) push(`  ${C.gray}task: ${m.taskId}${C.reset}`);
    if (m.cwd) push(`  ${C.gray}cwd:  ${m.cwd}${C.reset}`);
    push('');
    push(`  ${C.gray}── what it is doing ──${C.reset}`);
    const live = (panel.chat && panel.chat[m.name]) || [];
    const preview = previewLines(panel, m.name, Math.max(3, rows - 14), cols);
    if (!preview.length) push(`  ${C.gray}(nothing yet)${C.reset}`);
    for (const line of preview) push(`  ${C.gray}${line}${C.reset}`);
    void live;
    while (out.length < rows - 3) push('');
    push(C.border + '─'.repeat(cols) + C.reset);
    push(`  ${C.gray}← back · Enter message · k kill · s stop · m mode${C.reset}`);
    push('');
    return out.slice(0, rows);
  }

  if (!roster.length) {
    push('  ' + C.gray + 'No members. Add one with /team add <name>.' + C.reset);
  }

  // The roster, then the selected member's traffic, then the composer.
  const composerRows = 3;
  // THE TRAFFIC TAKES WHATEVER THE ROSTER LEAVES.
  //
  // It used to be capped at `panel.mailLines + 2`, a fixed number that had no relation to the panel's
  // height: on a tall panel most of the space sat empty below a two-message conversation, and a member's
  // long answer was cut off while there was room to draw it. `mailLines` is now a FLOOR rather than a
  // ceiling — enough rows are always offered that a message is unlikely to be sliced — and the caller's
  // height does the rest.
  const reserved = roster.length + composerRows + 6; // title, rules, hint, the `── name ──` header
  const trafficRoom = Math.max(0, Math.max(panel.mailLines, rows - reserved));

  for (let i = 0; i < roster.length && out.length < rows - composerRows - trafficRoom - 2; i++) {
    const m = roster[i];
    const sel = i === panel.selectedIndex;
    const ptr = sel ? `${C.cyan}>${C.reset} ` : '  ';
    const name = (m.isLead ? `${m.name} (lead)` : m.name).padEnd(20);
    // The states a member can be in, each with its own colour: green is a tool actually running,
    // cyan is blocked on the model, grey is waiting for work, yellow is an agent that has not
    // begun. `starting` used to fall through to `not started`, so a lead mid-launch claimed the
    // one thing that was certainly false about it — this is the row the user read as "my lead
    // never came up", and the correct reading was "it is on its way".
    const state = m.state === 'lead' ? `${C.gray}lead${C.reset}`
      : m.state === 'working' ? `${C.green}working${C.reset}`
        : m.state === 'thinking' ? `${C.cyan}thinking${C.reset}`
          : m.state === 'idle' ? `${C.gray}idle${C.reset}`
            : m.state === 'starting' ? `${C.yellow}starting${C.reset}`
              : `${C.yellow}not started${C.reset}`;
    const mail = m.unread ? `${C.yellow} ${m.unread} new${C.reset}` : '';
    const model = m.model ? `${C.gray} ${m.model}${C.reset}` : '';
    push(sel
      ? `${ptr}${C.cyan}${name}${C.reset}${state}${mail}${model}`
      : `${ptr}${name}${state}${mail}${model}`);

    // A THREE-LINE PREVIEW under the name, drawn from that member's own conversation.
    //
    // This is Claude Code's arrangement (`getMessagePreview` in TeammateSpinnerLine): the roster says what
    // a member is DOING without opening it, and the full transcript is one keystroke away. Removing the
    // preview entirely — which I did — left the roster claiming `working` with no evidence, so a member
    // running a long test and one that had hung looked identical.
    //
    // Newest first, then reversed for reading order. A tool call shows a DESCRIPTION rather than its name
    // where one exists (`command`, `description`, `query`, `pattern`): "npm test" says more than "Bash".
    const preview = previewLines(panel, m.name, 3, cols);
    for (const line of preview) {
      if (out.length >= rows - composerRows - 4) break;
      push(`      ${C.gray}${'│'} ${String(line).slice(0, Math.max(8, cols - 10))}${C.reset}`);
    }
  }

  // What the selected member has been saying.
  const sel = roster[panel.selectedIndex];
  if (sel && trafficRoom > 0) {
    push('');
    const rendered = [];
    const bodyW = Math.max(8, cols - 6);

    /**
     * Wrap one line of text to `bodyW`, on spaces. Panel-local rather than `wrapWords` from tui.js,
     * which is module-private; a word longer than the row is cut, since leaving it would push the line
     * past the panel's edge.
     */
    const wrapOne = (ln) => {
      if (ln === '') return [''];
      const out2 = [];
      let cur = '';
      for (const word of String(ln).split(' ')) {
        if (!cur) { cur = word; continue; }
        if (visualWidth(cur) + 1 + visualWidth(word) <= bodyW) cur += ' ' + word;
        else { out2.push(cur); cur = word; }
      }
      if (cur) out2.push(cur);
      return out2;
    };

    /** A message from the mailboxes, drawn as `<who>: text`, appended to `into`. */
    const renderMail = (t, into) => {
      const mine = t.from === TEAM_LEAD_NAME;
      const who = mine ? 'you' : t.from;
      const colour = mine ? C.gray : C.cyan;
      String(t.text || '').replace(/\r\n/g, '\n').split('\n').forEach((ln, i) => {
        const segs = wrapOne(ln);
        segs.forEach((seg, j) => {
          into.push(i === 0 && j === 0
            ? `  ${colour}${who}:${C.reset} ${seg}`
            : `  ${' '.repeat(who.length + 2)}${seg}`);
        });
      });
    };

    // THE MEMBER'S OWN WORK, drawn in the chat pane — its answer, the tools it called and what they
    // returned. This is the piece that was missing: the mailbox holds only what was sent to it and what
    // it chose to send back, so a member thinking and running commands showed nothing here at all, and
    // switching to it looked like an empty channel while the roster said `working`.
    //
    // Claude Code draws a teammate exactly this way — the same transcript component, switched to that
    // member's messages — so the two kinds of entry belong in one stream rather than the live stream
    // being bolted under the roster.
    const live = (panel.chat && panel.chat[sel.name]) || [];
    for (const e of live) {
      if (e.kind === 'think') {
        for (const seg of wrapOne(String(e.text || '').replace(/\s+/g, ' ').trim())) {
          if (seg) rendered.push(`  ${C.gray}${C.italic || ''}${seg}${C.reset}`);
        }
      } else if (e.kind === 'text') {
        String(e.text || '').replace(/\r\n/g, '\n').split('\n').forEach((ln, i) => {
          wrapOne(ln).forEach((seg, j) => {
            rendered.push(i === 0 && j === 0
              ? `  ${C.cyan}${sel.name}:${C.reset} ${seg}`
              : `  ${' '.repeat(sel.name.length + 2)}${seg}`);
          });
        });
      } else if (e.kind === 'tool') {
        // A tool call reads as one line: the name, then its result's first line when it has one.
        const head = String(e.tool || 'tool');
        const detail = String(e.detail || '').split('\n')[0].trim();
        rendered.push(`  ${C.green}${'⏺'}${C.reset} ${head}${detail ? C.gray + ': ' + detail + C.reset : ''}`);
      } else if (e.kind === 'tool_result') {
        for (const seg of wrapOne(`${e.tool}: ${String(e.detail || '').split('\n')[0]}`)) {
          rendered.push(`  ${C.gray}${seg}${C.reset}`);
        }
      }
    }

    // What was SAID TO this member, before its work. Those messages are the instructions it acted on,
    // and leaving them at the end put the cause after the effect — the pane read as though the member
    // had worked unprompted and then been asked.
    //
    // What the member SENT is not repeated here: its answer is already a `text` entry above, and the
    // mailbox copy would show the same words twice.
    const traffic = memberTraffic(panel.teamName, sel.name, 40);
    const mail = [];
    for (const t of traffic) {
      if (t.from === sel.name) continue;
      renderMail(t, mail);
    }
    rendered.unshift(...mail);

    if (!rendered.length) push('  ' + C.gray + '(nothing yet)' + C.reset);
    const room = Math.max(1, trafficRoom);
    for (const line of rendered.slice(-room)) push(line);
  }

  // A MEMBER IS BLOCKED ON A PERMISSION, and only the person here can unblock it.
  //
  // Drawn at the bottom of the panel, just above the composer, because that is where the answer is
  // given. A pending request is the one state where doing nothing costs time: the member polls until the
  // timeout, up to ten minutes.
  //
  // `y` / `n` are the whole interaction — the decision is binary, and anything more elaborate would need
  // a focus model this panel does not have.
  const req = panel.pendingPermission;
  if (req && out.length < rows - composerRows - 3) {
    const cut2 = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(8, cols - 4));
    const who = String(req.agentId || 'a member');
    const what = String(req.description || req.toolName || 'a tool call');
    push(`  ${C.yellow}${cut2(`${who} wants ${req.toolName}: ${what}`)}${C.reset}`);
    const inputLine = req.input && typeof req.input === 'object'
      ? Object.entries(req.input).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join('  ')
      : '';
    if (inputLine) push(`  ${C.gray}${cut2(inputLine)}${C.reset}`);
    push(`  ${C.yellow}y${C.reset} allow   ${C.yellow}n${C.reset} deny`);
  }

  // The shared task list, one line, so "is the team moving" needs no second screen.
  const tasks = readTasks(panel.teamName);
  if (tasks.length && out.length < rows - composerRows - 1) {
    const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
    push('  ' + C.gray + `${tasks.length - open}/${tasks.length} tasks done${C.reset}`);
  }

  while (out.length < rows - composerRows) out.push(' '.repeat(cols));

  // The composer. One line, always visible, and it SAYS who it will go to — the failure mode of a
  // chat box is sending to the wrong person and only finding out afterwards.
  push(C.border + '─'.repeat(cols) + C.reset);
  if (panel.mode === 'compose') {
    push(`  ${C.cyan}→ ${sel ? sel.name : '?'}${C.reset} ${panel.composing}${C.cyan}█${C.reset}`);
    push('  ' + C.gray + 'Enter send · Esc cancel' + C.reset);
  } else {
    push('  ' + C.gray + 'Enter write · Tab next · ↑↓ select · Esc close' + C.reset);
    // The roster actions, named so they are discoverable rather than folklore. A second line because
    // squeezing six shortcuts onto one makes all of them unreadable.
    push('  ' + C.gray + 'k kill · s stop · p prune idle · m mode · r read' + C.reset);
  }

  return out.slice(0, rows);
}

/**
 * Keys for the panel.
 *
 * Returns an action for the caller to perform, rather than performing it: the panel does not own
 * the frame, the agent or the clipboard, and a renderer that acts is a renderer that cannot be
 * tested.
 */
export function handleTeamPanelKey(panel, t) {
  if (!t) return { handled: false };

  // A PENDING PERMISSION OWNS THE KEYS, ahead of composing.
  //
  // It is asked at the bottom of the panel and must be answered before anything else is typed: otherwise
  // `y` while composing would send the letter instead of approving, and the member would keep blocking.
  if (panel.pendingPermission) {
    if (t.ch === 'y') return { handled: true, action: 'permission', approved: true };
    if (t.ch === 'n' || t.key === 'escape') return { handled: true, action: 'permission', approved: false };
    // Every other key is swallowed: an unrelated keystroke must not move the roster out from under a
    // decision that is waiting.
    return { handled: true };
  }

  if (panel.mode === 'compose') {
    if (t.key === 'escape') { panel.mode = 'roster'; panel.composing = ''; panel.caret = 0; return { handled: true }; }
    if (t.key === 'enter') {
      const text = panel.composing.trim();
      const roster = teamRows(panel);
      const to = roster[panel.selectedIndex];
      panel.composing = '';
      panel.caret = 0;
      panel.mode = 'roster';
      if (!text || !to) return { handled: true };
      return { handled: true, action: 'send', to: to.name, text };
    }
    if (t.key === 'backspace') {
      panel.composing = panel.composing.slice(0, -1);
      panel.caret = panel.composing.length;
      return { handled: true };
    }
    if (t.ch && !t.key?.startsWith('c-')) { panel.composing += t.ch; panel.caret = panel.composing.length; return { handled: true }; }
    return { handled: true };
  }

  const roster = teamRows(panel);
  const n = roster.length;

  if (t.key === 'escape' || t.ch === 'q') return { handled: true, action: 'close' };

  // ---- two levels, like Claude Code's TeamsDialog ----
  //
  // `←` goes back. In the detail view it returns to the roster; in the list it closes the panel, which is
  // what a person pressing "back" at the top level means.
  if (t.key === 'left') {
    if (panel.level === 'detail') { panel.level = 'list'; return { handled: true }; }
    return { handled: true, action: 'close' };
  }

  // `Enter` goes IN. In the detail view it starts composing a message to that member, because writing to
  // them is the one thing you reach for once you are looking at them.
  if (t.key === 'enter') {
    if (!n) return { handled: true };
    if (panel.level === 'list') { panel.level = 'detail'; return { handled: true }; }
    panel.mode = 'compose';
    panel.composing = '';
    return { handled: true };
  }

  if (t.key === 'tab' || t.key === 'down') { if (n) panel.selectedIndex = (panel.selectedIndex + 1) % n; return { handled: true }; }
  if (t.key === 's-tab' || t.key === 'up') { if (n) panel.selectedIndex = (panel.selectedIndex - 1 + n) % n; return { handled: true }; }
  if (t.key === 'home') { panel.selectedIndex = 0; return { handled: true }; }
  if (t.key === 'end') { if (n) panel.selectedIndex = n - 1; return { handled: true }; }
  // already looked at in the traffic pane.
  if (t.ch === 'r' && n) return { handled: true, action: 'markRead', name: roster[panel.selectedIndex].name };

  // ---- roster actions, matching Claude Code's TeamsDialog ----
  //
  // `k` KILLS the selected member: the abort controller fires and the run unwinds. Until this existed a
  // member could not be stopped at all — closing the panel left it working in the background, which is
  // the one thing a person watching a runaway agent most needs.
  if (t.ch === 'k' && n) return { handled: true, action: 'kill', name: roster[panel.selectedIndex].name };

  // `s` asks it to STOP GRACEFULLY: a `shutdown_request` on its mailbox, which it may refuse if it is
  // mid-task. A kill takes no answer; a shutdown does. Both are needed — killing a member that is
  // halfway through a write leaves the file half-written.
  if (t.ch === 's' && n) return { handled: true, action: 'shutdown', name: roster[panel.selectedIndex].name };

  // `p` PRUNES every idle member at once. With five idle teammates the roster is mostly noise, and
  // killing them one at a time is five round trips.
  if (t.ch === 'p' && n) {
    const idle = roster.filter((m) => !m.isLead && m.state === 'idle').map((m) => m.name);
    return { handled: true, action: 'prune', names: idle };
  }

  // `m` cycles the selected member's permission mode: ask → auto → yolo → ask.
  //
  // Per member, not per team: one member doing desktop work may need `yolo` while another editing the
  // repository should still ask. Claude Code exposes the same control as shift+tab in its detail view.
  if (t.ch === 'm' && n) return { handled: true, action: 'cycleMode', name: roster[panel.selectedIndex].name };

  return { handled: false };
}

/** Deliver a message from the panel. Separated so the key handler stays pure. */
export function sendFromPanel(teamName, to, text) {
  if (!to || !text) return false;
  writeToMailbox(teamName, to, { from: TEAM_LEAD_NAME, text: String(text) });
  return true;
}
