// AskUserQuestion tool — ask the user 1-4 structured multiple-choice questions
// mid-turn and block until they answer. Mirrors kimi-code's AskUserQuestion:
// the same input shape, the same duplicate validation, and the same result
// JSON, so a model trained on either behaves the same.
//
// The TUI supplies the actual UI through `ctx.askQuestion` (a function injected
// by the Agent). When it is absent — headless `-p` mode, a plugin harness, or a
// client that cannot prompt — the tool FAILS with a message telling the model to
// ask in plain text instead of silently returning an empty answer, which would
// look like "the user declined".

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// The user always gets an escape hatch for free input, so the model must not
// waste one of its 2-4 option slots on an "Other" of its own.
export const OTHER_LABEL = 'Other';

// A SECOND free-text row, shown once after the LAST question: not an answer to
// anything, just somewhere to add context that no option covered. Reported as
// `additional` on the result (NOT `note`, which already means "dismissed").
export const SUPPLEMENT_LABEL = 'Add a note';

const UNIQUENESS_HINT =
  'Question texts must be unique across questions, and option labels must be unique within each question.';

// Validate the two uniqueness rules kimi enforces. Returns an error string, or
// null when the input is acceptable. Checks run BEFORE any UI is shown so a
// malformed call never interrupts the user.
export function questionUniquenessError(questions) {
  const texts = new Set();
  for (const q of questions) {
    if (texts.has(q.question)) {
      return `Invalid questions: duplicate question text ${JSON.stringify(q.question)}. ${UNIQUENESS_HINT} Rephrase the duplicates and call the tool again.`;
    }
    texts.add(q.question);
    const labels = new Set();
    for (const o of q.options) {
      if (labels.has(o.label)) {
        return `Invalid questions: duplicate option label ${JSON.stringify(o.label)} in question ${JSON.stringify(q.question)}. ${UNIQUENESS_HINT} Rephrase the duplicates and call the tool again.`;
      }
      labels.add(o.label);
    }
  }
  return null;
}

const DESCRIPTION = `Ask the user a question with structured options, during execution. Use it when the answer
genuinely changes what you do next: a preference, an ambiguous instruction, a choice between approaches.

Do NOT use it for what you can infer from context, or for trivial decisions — overusing it interrupts the user's flow.

Usage:
- Users always get an "Other" option; do not create one.
    + 'For an answer that cannot be enumerated (a name, a path, a description), set free_text: true and omit'
    + ' options — the user gets a focused field instead of a list.',
- 2-4 distinct options per question, labels 1-5 words, descriptions carry the trade-offs. Labels unique within a question, question texts unique across the call.
- 1-4 questions at a time, related ones grouped. multi_select allows several answers.
- Put a recommended option first and append "(Recommended)" to its label.
- The result is JSON: an \`answers\` object keyed by question text, each value the chosen label (comma-separated for multi_select, or the user's own words for "Other"). An empty \`answers\` with a \`note\` means they dismissed it — that is NOT a vote for the recommended option; decide from context and do not re-ask. A free-form \`additional\` note, when present, is extra context for the whole request.`;

export const spec = {
  name: 'AskUserQuestion',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: 'The questions to ask the user (1-4 questions).',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: "A specific, actionable question. End with '?'.",
            },
            header: {
              type: 'string',
              description: "Short category tag (max 12 chars, e.g. 'Auth', 'Style').",
            },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              description:
                "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically.",
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: "Concise display text (1-5 words). If recommended, append '(Recommended)'.",
                  },
                  description: {
                    type: 'string',
                    description: 'Brief explanation of trade-offs or implications.',
                  },
                },
                required: ['label'],
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user can select multiple options.',
            },
            free_text: {
              type: 'boolean',
              description:
                'Ask for a WRITTEN answer with no options: the field is focused immediately and the reply is'
                + ' the text typed. Use it when the answer cannot be enumerated — a name, a path, a'
                + ' description. Omit options when this is true.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },

  async execute(args, ctx) {
    // AUTO ("Never Ask") forbids asking by definition — the whole point of the
    // mode is that the agent decides for itself. Checked FIRST so the model gets
    // a clear instruction back instead of a dialog the user never wanted. The
    // wording mirrors kimi-code's `auto-mode-ask-user-question-deny` policy; the
    // `Error:` prefix is ours — it is what marks the call as failed to the TUI, so
    // the status bullet turns RED instead of staying green on a refusal.
    if (ctx && ctx.permissionMode === 'auto') {
      return 'Error: AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.';
    }

    const raw = (args && args.questions) || [];
    if (!Array.isArray(raw) || raw.length === 0) {
      return 'Error: `questions` must be a non-empty array (1-4 questions).';
    }
    if (raw.length > MAX_QUESTIONS) {
      return `Error: at most ${MAX_QUESTIONS} questions per call (got ${raw.length}). Group related questions to minimize interruptions.`;
    }

    // Normalize + validate BEFORE showing any UI: a malformed call must not
    // interrupt the user, it must come straight back to the model.
    const questions = [];
    for (const q of raw) {
      const text = String((q && q.question) || '').trim();
      if (!text) return 'Error: every question needs a non-empty `question` string.';
      const opts = Array.isArray(q && q.options) ? q.options : [];
      const freeText = !!(q && q.free_text);
      // A FREE-TEXT QUESTION HAS NO OPTIONS. The 2-4 rule exists so a choice is a real choice; applying it here
      // would force a question like "what should the release be called?" to invent two decoys first.
      if (!freeText && (opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS)) {
        return `Error: question ${JSON.stringify(text)} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (got ${opts.length}).`;
      }
      const options = [];
      for (const o of opts) {
        const label = String((o && o.label) || '').trim();
        if (!label) return `Error: every option in ${JSON.stringify(text)} needs a non-empty \`label\`.`;
        options.push({ label, description: String((o && o.description) || '') });
      }
      questions.push({
        question: text,
        header: String((q && q.header) || '').trim().slice(0, 12),
        options,
        multiSelect: !!(q && q.multi_select),
        // CARRIED THROUGH AS `freeText`, which is the name the dialog reads. Without this the flag stopped at
        // the tool: the question arrived with no options AND no marker, so the dialog drew the option list —
        // empty apart from its "Other" row — and the field never opened.
        freeText,
      });
    }
    const dup = questionUniquenessError(questions);
    if (dup) return dup;

    // No interactive client: say so explicitly. Returning `{answers:{}}` would be
    // read as "the user refused to answer", which is a different signal.
    if (typeof ctx.askQuestion !== 'function') {
      return 'The connected client does not support interactive questions. Do NOT call this tool again. Ask the user directly in your text response instead.';
    }

    let result;
    try {
      result = await ctx.askQuestion(questions, ctx);
    } catch (err) {
      // An aborted turn (Esc / Ctrl-C) is not a dismissal — let the agent see the
      // interruption instead of a fabricated empty answer.
      if (ctx.signal && ctx.signal.aborted) throw err;
      return `Error: could not ask the user: ${(err && err.message) || String(err)}`;
    }

    // Dismissed (Esc) or nothing answered: kimi's exact semantics — an empty
    // answers object plus a note telling the model NOT to treat it as consent.
    // A dismissal also drops any note the user had started typing.
    const answers = (result && typeof result === 'object' && result.answers) || null;
    const additional = (result && typeof result === 'object' && result.additional) || '';
    if (!answers || Object.keys(answers).length === 0) {
      return JSON.stringify({
        answers: {},
        note: 'User dismissed the question without answering.',
      });
    }
    // `additional` is OPTIONAL: omit the key entirely when the user left the
    // supplement blank, so the model does not see a meaningless empty field.
    const out = { answers };
    if (additional) out.additional = additional;
    return JSON.stringify(out);
  },
};
