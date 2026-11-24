/**
 * The Goal tool: the agent's own objective across turns.
 *
 * A turn ends when the model stops. Some work does not fit in one turn — a refactor across a dozen files, a
 * migration, a suite that needs several rounds — and without a goal the agent simply stops halfway and waits
 * to be told to continue. The goal makes that explicit: a line the agent wrote for itself, shown in the status
 * panel, and the turn loop restarts the agent while one is set.
 *
 * ONE STORE, NOT TWO. The objective lives in the TUI's `state.objective` — the same field `/goal` writes — and
 * this module only borrows it through a listener. A second copy here would drift the moment the user typed
 * `/goal cancel`, and the loop would restart against an objective nobody could see.
 *
 * THREE ACTIONS:
 *
 *   set      Start or replace the objective.
 *   status   Read it back, so a resumed turn can re-read what it was doing.
 *   clear    Finish. Nothing restarts after this, which is why it has to be deliberate.
 */

/** Read the goal. Installed by startTUI, backed by `state.objective`. */
let readGoal = () => '';
/** Write the goal. Installed by startTUI. */
let writeGoal = () => {};
/**
 * Who set the goal: 'user' or 'agent'.
 *
 * THE DISTINCTION IS THE POINT. The user's `/goal set` and the agent's `Goal {action:'set'}` write the same field, so
 * without this the agent could silently REPLACE the objective the person gave it — and worse, `Goal clear` could wipe an
 * objective the user was still working towards, which stops the loop for a goal nobody has met.
 *
 * A goal the USER set is not the agent's to change. The tool refuses both `set` and `clear` against one.
 */
/** Set by installGoalStore; reports who owns the objective currently stored. */
let readOwner = () => 'agent';

/**
 * @param {{get: () => string, set: (goal: string, owner?: 'user'|'agent') => void, owner?: () => string}} api
 */
export function installGoalStore(api) {
  if (api && typeof api.get === 'function') readGoal = api.get;
  if (api && typeof api.set === 'function') writeGoal = api.set;
  if (api && typeof api.owner === 'function') readOwner = api.owner;
}

/** The current objective, or ''. */
export function getGoal() {
  try { return String(readGoal() || '').trim(); } catch { return ''; }
}

/** Who set the current objective. */
export function getGoalOwner() {
  try { return String(readOwner() || 'agent'); } catch { return 'agent'; }
}

export const spec = {
  name: 'Goal',
  description: [
    'Set, read or clear the objective you are working towards across turns.',
    '',
    'A turn ends when you stop responding. While a goal is set the agent restarts you with it quoted back, so',
    'use it for work that genuinely needs several turns — not for something you can finish now.',
    '',
    '- set: start or replace it. Write a finishable outcome ("all callers of X migrated and the suite passes"),',
    '  not an activity ("work on X").',
    '- status: read it back.',
    '- clear: you are done. Call this the moment the goal is met; otherwise the loop restarts you again.',
    '',
    'The user can set the same goal with /goal and can pause it. Never clear a goal you have not met.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'status', 'clear'],
        description: 'set = start or replace, status = read back, clear = finished.',
      },
      goal: {
        type: 'string',
        description: 'The objective. Required for `set`; a finishable outcome, not an activity.',
      },
    },
    required: ['action'],
  },

  /**
   * @param {{action: string, goal?: string}} args
   * @returns {string}
   */
  execute(args) {
    const action = String((args && args.action) || '').toLowerCase();
    const owner = getGoalOwner();
    if (action === 'set') {
      const goal = String((args && args.goal) || '').trim();
      if (!goal) return 'Error: `set` needs a goal — the outcome you are working towards.';
      // THE USER'S GOAL IS NOT YOURS TO REPLACE.
      //
      // `/goal set` and this tool write the same field, so without this check a `set` silently overwrote whatever the
      // person had asked for — and the loop then restarted against an objective they never wrote and could not see.
      // Refused rather than merged: two objectives are not one goal.
      const current = getGoal();
      if (current && owner === 'user') {
        return `Refused: the user set this goal and it is still active.\n\nGoal: ${current}\n\n`
          + 'Work towards it. Do not replace it — the user changes it with /goal, and only they can clear it.';
      }
      try { writeGoal(goal, 'agent'); } catch { return 'Error: could not store the goal.'; }
      return `Goal set: ${goal}\nThe turn loop restarts you with this until you call Goal with action clear.`;
    }
    if (action === 'status') {
      const goal = getGoal();
      return goal ? `Goal: ${goal}${owner === 'user' ? ' (set by the user)' : ''}` : 'No goal is set.';
    }
    if (action === 'clear') {
      const goal = getGoal();
      if (!goal) return 'No goal to clear.';
      // CLEARING SOMEONE ELSE'S GOAL STOPS A LOOP THAT WAS NOT YOURS.
      //
      // The user set an objective and is waiting for it. Reporting it done resets `state.objective`, so the turn loop
      // stops restarting — the work is abandoned mid-way and nothing says so. Tell the user what was finished instead;
      // they decide whether the goal is met.
      if (owner === 'user') {
        return `Not cleared: this goal was set by the user, so only they can finish it.\n\nGoal: ${goal}\n\n`
          + 'Report what you completed and stop. The user will clear the goal, or tell you to continue.';
      }
      try { writeGoal('', 'agent'); } catch { return 'Error: could not clear the goal.'; }
      return `Goal cleared: ${goal}\nNothing will restart this turn now.`;
    }
    return `Error: unknown action "${args && args.action}". Use set, status or clear.`;
  },
};
