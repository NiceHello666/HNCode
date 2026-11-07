// Verify the free-text question through the REAL tool path: call the tool with free_text, catch the questions
// object it hands to ctx.askQuestion, then render that object and check the field is what gets drawn.
import os from 'node:os';

const out = process.stdout.write.bind(process.stdout);
const say = (s) => out(s + '\n');

const cfg = { model: 'p/m', provider: 'p', innerModel: 'm', baseUrl: 'x', endpoint: 'x', protocol: 'openai',
  maxContextTokens: 100000, maxOutputTokens: 8192, reasoning: false, workspace: os.tmpdir(),
  raw: { providers: {}, models: { 'p/m': {} } } };

const tui = await import('../src/tui.js');
const { spec } = await import('../src/tools/ask-user-question.js');

let captured = null;
// The tool hands a normalized `questions` array to ctx.askQuestion and waits for the answers.
const ctx = {
  askQuestion: (questions) => { captured = questions; return Promise.resolve({ answers: { 'What should the release be called?': 'v0.7.0' } }); },
  permissionMode: 'ask',
};
const result = await spec.execute({ questions: [{ question: 'What should the release be called?', header: 'Name', free_text: true }] }, ctx);

say('captured questions: ' + JSON.stringify(captured));
say('freeText flag     : ' + (captured && captured[0] && captured[0].freeText ? 'true' : 'MISSING'));
say('options           : ' + JSON.stringify(captured && captured[0] && captured[0].options));
say('tool returned     : ' + String(result).slice(0, 90));

// Now render that exact object and see whether the dialog draws a field or a list.
const st = tui.makeState({ cfg, session: { id: 's', workspace: os.tmpdir(), model: 'p/m', messages: [] }, opts: {} });
st.chat = [];
st.question = {
  items: captured, index: 0, sel: 0, picked: new Set(), answers: {},
  editing: captured[0].freeText ? 'other' : null, editingText: '', editingCaret: 0,
  otherText: '', supplement: '', resolve: () => {},
};
const f = tui.composeFrame(st, 80, 24);
const painted = f.lines.map((l) => String(l).replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
say('');
say('question shown : ' + (/What should the release be called/.test(painted) ? 'yes' : 'NO'));
say('input field    : ' + (/❯/.test(painted) ? 'yes' : 'NO'));
say('option list    : ' + (/Other/.test(painted) ? 'DRAWN (wrong)' : 'absent (correct)'));
