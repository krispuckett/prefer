'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const tm = require('../prefer.js');

const root = path.join(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const base = path.join(__dirname, `.blind-${process.pid}`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const Q = ['How should the card header be treated?', 'Which face should the settings rows use?', 'How should the empty state on the reading screen look?',
  'How should the tab bar icons be drawn?', 'What color should the primary button carry?', 'How should the sheet enter the screen?',
  'How should pulled quotes be marked?', 'How dense should the timeline rows be?', 'What should the onboarding title say?',
  'How should the chart axis labels be placed?', 'How should the loading state animate?', 'How should the photo grid crop images?',
  'What corner radius should the cards use?'];
const PAIR = ['Set in a serif face with wide tracking', 'Set in a mono face with tight tracking'];

function setup(name, fake) {
  const out = path.join(base, name);
  fs.mkdirSync(out, { recursive: true });
  const v = (i, date, extra = {}) => ({ id: `v_${String(i).padStart(4, '0')}`, candidate: `c_${String(i).padStart(4, '0')}`, date, project: 'Developer-Lumen',
    session: `s${i}`, kind: i % 3 ? 'visual' : 'motion', judged: Q[i - 1] || 'x', options: PAIR, pick: i % 2, reason: 'r', polarity: 'pick', confidence: 0.9, has_image: false, files: [], ...extra });
  const verdicts = [v(1, '2026-08-01'), ...Q.slice(1).map((_, k) => v(k + 2, `2026-09-${11 + k}`)),
    v(14, '2026-09-25', { judged: 'Which face should the settings rows use' }),
    v(15, '2026-09-26', { judged: 'How should the header bar be styled?', options: ['Keep a solid bar across the top', 'A thin line across the top edge'] }),
    v(16, '2026-09-27', { judged: 'How should sections be divided?', options: ['A dot', 'A thin rule across the full width'] }),
    v(17, '2026-09-28', { judged: 'How should the map pins look?', confidence: 0.6 }),
    v(18, '2026-09-29', { judged: 'How should the widget be framed?', options: ['A frame'], pick: 0 })];
  fs.writeFileSync(path.join(out, 'verdicts.jsonl'), verdicts.map((x) => JSON.stringify(x)).join('\n') + '\n');
  // candidates 2 through 5 offered a menu
  fs.writeFileSync(path.join(out, 'candidates.jsonl'), verdicts.map((x, i) => JSON.stringify({ id: x.candidate, options: i >= 1 && i <= 4 ? ['one', 'two'] : [] })).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'SKILL.md'), '---\nname: my-taste\ndescription: test\n---\n# Calibration\n');
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ cutoff: '2026-09-10', seed: 42, projects: { 'Developer-Lumen': {} }, possible_names: ['Dana Whitfield'] }));
  if (fake) fs.writeFileSync(path.join(out, 'fake.json'), JSON.stringify(fake));
  return out;
}

function run(out, args = []) {
  const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'test', '--out', out, ...args,
    '--projects-dir', path.join(fixtures, 'projects'), '--deny', path.join(fixtures, 'deny.txt')],
  { encoding: 'utf8', env: { ...process.env, PREFER_CLAUDE: path.join(__dirname, 'fake-claude') } });
  return { ...r, all: r.stdout + r.stderr };
}

const read = (out, f) => fs.readFileSync(path.join(out, f), 'utf8');
const json = (out, f) => JSON.parse(read(out, f));
const logOf = (out) => read(out, 'fake-log.txt').trim().split('\n');
function allText(dir, skip = 'fake.json') {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== skip).map((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? allText(p, skip) : fs.readFileSync(p, 'utf8');
  }).join('\n');
}

test('test writes and hashes a neutral, balanced key before any prediction runs', () => {
  const out = setup('clean');
  const r = run(out);
  assert.strictEqual(r.status, 0, r.all);
  const items = json(out, 'test/items.json'), key = json(out, 'test/key.json');
  assert.strictEqual(items.length, 13, '12 distinct, one padded on retry; duplicate, banned word, low confidence, one option all out');
  for (const it of items) for (const o of it.options) assert.doesNotMatch(o.text, /\bkeep\b/i);
  assert.ok(tm.balanced(key.answers.map((k) => ({ options: ['a', 'b'], answer: 'AB'.indexOf(k.answer) }))));

  const hash = crypto.createHash('sha256').update(read(out, 'test/key.json')).digest('hex');
  assert.strictEqual(json(out, 'manifest.json').key_sha256, hash);
  assert.ok(r.stdout.indexOf(hash) >= 0 && r.stdout.indexOf(hash) < r.stdout.indexOf('Predicting'));
  const log = logOf(out);
  assert.ok(log.indexOf('canary') < log.indexOf('predict-with') && log.indexOf('context') < log.indexOf('predict-no'));
  assert.strictEqual(log.filter((l) => l === 'predict-with').length, 3, 'repeats are separate calls');
  assert.strictEqual(log.filter((l) => l === 'predict-no').length, 3);

  const rep = json(out, 'report.json'), nA = key.answers.filter((k) => k.answer === 'A').length;
  assert.strictEqual(rep.clean, true);
  assert.deepStrictEqual([rep.n, rep.duplicates, rep.dropped_by_wording_check], [13, 1, 1]);
  assert.deepStrictEqual(rep.with_skill, { mean: 13, runs: [13, 13, 13] });
  assert.deepStrictEqual(rep.no_history.runs, [nA, nA, nA]);
  assert.strictEqual(rep.gap_items, 13 - nA);
  assert.deepStrictEqual([rep.by_source.menu.n, rep.by_source.correction.n], [4, 9], 'v_0002 to v_0005 offered menus');
  assert.strictEqual(rep.by_source.menu.with_skill.mean, 4);
  for (const q of Q) assert.ok(!read(out, 'report.json').includes(q), 'report.json holds numbers only');
  assert.match(read(out, 'report.md'), /Sign test p = [\d.]+\./);
  assert.strictEqual(typeof json(out, 'report.json').sign_test_p, 'number');
  assert.match(read(out, 'report.md'), /source: correction \| 9 \|/);
  assert.strictEqual(json(out, 'test/canary.json').canary.pass, true);
  assert.doesNotMatch(allText(out), /Orchid|Ferrule/, 'MEMORY.md words never land in output');

  const again = run(out);
  assert.strictEqual(again.status, 0, again.all);
  assert.deepStrictEqual(logOf(out).slice(log.length).sort(), ['canary', 'context'], 'rerun: proof runs fresh, everything else from cache');
});

test('a canary hit marks the report contaminated and runs no predictions', () => {
  const out = setup('dirty', { canary: 'They are known for Orchid and Lumen.' });
  const r = run(out);
  assert.strictEqual(r.status, 1, r.all);
  assert.match(r.stderr, /CONTAMINATED/);
  const md = read(out, 'report.md'), rep = json(out, 'report.json');
  assert.match(md, /^# Prefer blind test\n\n\*\*CONTAMINATED\.\*\*/);
  assert.doesNotMatch(md, /Gap:|## Score/);
  assert.strictEqual(rep.clean, false);
  assert.ok(!('with_skill' in rep));
  const canary = json(out, 'test/canary.json').canary;
  assert.deepStrictEqual([canary.pass, canary.names_matched], [false, 2]);
  assert.doesNotMatch(allText(out), /Orchid/, 'the reply is redacted');
  assert.ok(!logOf(out).some((l) => l.startsWith('predict')));
  assert.ok(fs.existsSync(path.join(out, 'test/key.json')));
});

test('a context check reply other than NONE marks the report contaminated', () => {
  const out = setup('context', { context: 'You are a helpful assistant with a memory file.' });
  const r = run(out);
  assert.strictEqual(r.status, 1, r.all);
  assert.strictEqual(json(out, 'test/canary.json').context_check.pass, false);
  assert.match(read(out, 'report.md'), /CONTAMINATED/);
});

test('--source menu restricts the items', () => {
  const out = setup('menu');
  const r = run(out, ['--source', 'menu']);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(json(out, 'report.json').n, 4);
  assert.ok(json(out, 'test/key.json').answers.every((k) => k.source === 'menu'));
});

test('test refuses a cutoff earlier than the one SKILL.md was written with', () => {
  const r = run(setup('early'), ['--cutoff', '2026-09-01']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.all, /own training verdicts/);
});

test('lexicalCheck catches length gaps, banned words, and bad shapes', () => {
  assert.strictEqual(tm.lexicalCheck({ question: 'How should the rows be set?', options: ['Serif type, wide', 'Mono type, tight'] }, 2), null);
  assert.match(tm.lexicalCheck({ question: 'q?', options: ['A dot', 'A long thin rule across the card'] }, 2), /20 percent/);
  for (const w of ['Keep', 'cleaner', 'back', 'original', 'still', 'instead', 'newer']) {
    assert.match(tm.lexicalCheck({ question: 'q?', options: [`${w} the bar there`, `${w} the bar here`] }, 2), /uses the word/, w);
  }
  assert.strictEqual(tm.lexicalCheck({ question: 'What background color?', options: ['Bold ink panel', 'Soft gray wash'] }, 2), null, 'whole words only');
  assert.strictEqual(tm.lexicalCheck({ question: 'q?', options: ['one option'] }, 2), 'wrong shape');
  assert.strictEqual(tm.lexicalCheck(undefined, 2), 'wrong shape');
});

test('balance shuffles every item and meets the key rules', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i, options: [`right ${i}`, `wrong ${i}`], answer: 0 }));
  for (const seed of [1, 7, 42, 99999]) {
    const b = tm.balance(items, seed);
    assert.ok(b.balanced && tm.balanced(b.items));
    const nA = b.items.filter((it) => it.answer === 0).length;
    assert.ok(nA >= 12 && nA <= 18, `A share ${nA} of 30`);
    b.items.forEach((it, i) => assert.strictEqual(it.options[it.answer], `right ${i}`));
    assert.deepStrictEqual(tm.balance(items, seed).items, b.items, 'same seed, same shuffle');
  }
  const run4 = [0, 1, 1, 1, 1, 0].map((answer) => ({ options: ['a', 'b'], answer }));
  assert.strictEqual(tm.balanced(run4), false, 'four in a row fails');
  assert.strictEqual(tm.balanced([0, 0, 0, 1, 1, 1].map((answer) => ({ options: ['a', 'b'], answer }))), true);
});

test('parseAnswers reads N: X lines and refuses thin replies', () => {
  const got = tm.parseAnswers('1: B | warm\n**2**: A. a guess\n3: (C) because', 3);
  assert.deepStrictEqual(got.map((g) => g.pick), ['B', 'A', 'C']);
  assert.strictEqual(got[0].reason, 'warm');
  assert.throws(() => tm.parseAnswers('1: A', 4), /answered 1 of 4/);
});

test('dedupe merges near-identical questions only', () => {
  const v = (judged) => ({ judged });
  assert.strictEqual(tm.dedupe([v('How should the rows be set?'), v('how should the rows be set'), v('How should the sheet enter?')]).length, 2);
});

test('install copies the skill, script, and prompts into --skills-dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-skills-'));
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'install', '--skills-dir', dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const dest = path.join(dir, 'prefer');
    for (const f of ['SKILL.md', 'prefer.js', 'prompts/classify.md', 'prompts/skill.md', 'prompts/neutralize.md', 'prompts/predict.md']) assert.ok(fs.existsSync(path.join(dest, f)), f);
    const md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
    assert.match(md, /^---\nname: prefer[\s\S]*employer, their clients/);
    assert.ok(!md.includes('CLAUDE_PLUGIN_ROOT') && md.includes(`node "${dest}/prefer.js" scan`));
    const again = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'install', '--skills-dir', dir], { encoding: 'utf8' });
    assert.notStrictEqual(again.status, 0);
    assert.match(again.stderr, /already holds a skill. Rerun with --yes/);
    const usage = spawnSync(process.execPath, [path.join(dest, 'prefer.js')], { encoding: 'utf8' });
    assert.match(usage.stderr, /usage: prefer/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a canary reply of NONE that echoes words from its own prompt passes', () => {
  const out = setup('echo-words', { canary: 'NONE. Nothing in the system prompt or any memory tells me which projects this designer works on.' });
  const r = run(out);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(json(out, 'test/canary.json').canary.pass, true);
});

test('a context reply that only names the account email passes, with the block recorded', () => {
  const out = setup('email', { context: 'The only extra block states the account email: someone@example.com' });
  const r = run(out);
  assert.strictEqual(r.status, 0, r.all);
  assert.deepStrictEqual([json(out, 'test/canary.json').context_check.pass, json(out, 'test/canary.json').context_check.email_block_seen], [true, true]);
});

test('a test item that repeats a question from before the cutoff is dropped', () => {
  const out = setup('repeat');
  const extra = { id: 'v_0019', candidate: 'c_0019', date: '2026-09-30', project: 'Developer-Lumen', session: 's19', kind: 'visual',
    judged: 'How should the card header be treated?', options: ['Set in a serif face with wide tracking', 'Set in a mono face with tight tracking'],
    pick: 0, reason: 'r', polarity: 'pick', confidence: 0.9, has_image: false, files: [] };
  fs.appendFileSync(path.join(out, 'verdicts.jsonl'), JSON.stringify(extra) + '\n');
  const r = run(out);
  assert.strictEqual(r.status, 0, r.all);
  assert.match(r.stdout, /1 items repeat a question from before the cutoff/);
  assert.strictEqual(json(out, 'report.json').repeats_of_training_dropped, 1);
  assert.ok(!json(out, 'test/key.json').answers.some((x) => x.verdict === 'v_0019'));
});

test('a usage limit while rewording stops the test with the reason', () => {
  const out = setup('limit', { neutralizeFail: true });
  const r = run(out);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /usage limit reached/);
  assert.doesNotMatch(r.all, /failed the wording check|No items passed/);
});

test('install --out installs the generated taste skill under its own name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-own-'));
  try {
    const out = setup('own');
    const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'install', '--out', out, '--skills-dir', dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'my-taste', 'SKILL.md'), 'utf8'), read(out, 'SKILL.md'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('after NONE, a canary word in ordinary lowercase use is no leak, and a capitalized one is', () => {
  const ok = setup('lower', { canary: 'NONE. Nothing names an orchid or ferrule this designer works on.' });
  assert.strictEqual(run(ok).status, 0);
  assert.strictEqual(json(ok, 'test/canary.json').canary.pass, true);
  const bad = setup('upper', { canary: 'NONE, though Orchid comes to mind.' });
  assert.notStrictEqual(run(bad).status, 0);
  assert.strictEqual(json(bad, 'test/canary.json').canary.pass, false);
});

test('a context reply describing the attached account note without the word email passes', () => {
  const out = setup('account', { context: 'There was no CLAUDE.md, memory file or skill. The only extra context was an auto-attached note about your account.' });
  const r = run(out);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(json(out, 'test/canary.json').context_check.email_block_seen, true);
});

test('a context reply of NONE plus chatter passes, and NONE followed by a quote fails', () => {
  const ok = setup('chatter', { context: "NONE\n\nNo items were included in your message, so there are no answers to give. Send the questions and I'll answer." });
  assert.strictEqual(run(ok).status, 0);
  assert.strictEqual(json(ok, 'test/canary.json').context_check.pass, true);
  const bad = setup('quoted', { context: 'NONE of note, apart from "Always use the house palette."', context2: 'NONE, apart from "Always use the house palette."' });
  assert.notStrictEqual(run(bad).status, 0);
  assert.strictEqual(json(bad, 'test/canary.json').context_check.pass, false);
});
