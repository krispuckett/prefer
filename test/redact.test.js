'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const tm = require('../prefer.js');

const root = path.join(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const out = path.join(__dirname, `.out-${process.pid}`);
const fake = path.join(__dirname, 'fake-claude');
after(() => fs.rmSync(out, { recursive: true, force: true }));

function run(args, claude = fake, dir = out) {
  const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), ...args, '--out', dir,
    '--projects-dir', path.join(fixtures, 'projects'), '--deny', path.join(fixtures, 'deny.txt')],
  { encoding: 'utf8', env: { ...process.env, PREFER_CLAUDE: claude } });
  return { ...r, all: r.stdout + r.stderr };
}

function allText(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? allText(p) : fs.readFileSync(p, 'utf8');
  }).join('\n');
}

const SECRETS = [/globex/i, /alex\.rivera@example\.com/, /sk-test1234567890/, /\/Users\/alex/, /AKIAABCDEFGHIJKLMNOP/, /303-555-0142/, /10\.0\.0\.12/, /session=8812/];

test('mine redacts the deny list, emails, keys, and home paths everywhere under --out', () => {
  const r = run(['mine', '--yes']);
  assert.strictEqual(r.status, 0, r.all);
  const text = allText(out);
  for (const secret of SECRETS) { assert.doesNotMatch(text, secret); assert.doesNotMatch(r.all, secret); }
  assert.match(text, /\[name\]/);
  assert.match(text, /\[email\]/);
  assert.match(text, /\[key\]/);

  const cands = fs.readFileSync(path.join(out, 'candidates.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(cands.length, 2, 'one verdict per fixture session');
  assert.deepStrictEqual(cands.map((c) => c.project), ['Developer-Lumen', 'Developer-Lumen']);
  assert.strictEqual(cands[0].options.length, 2);
  assert.strictEqual(cands[1].has_image, true);
  for (const marker of ['META_MARKER', 'COMMAND_MARKER', 'PEER_MARKER', 'TASK_MARKER', 'SYSTEM_MARKER', 'SIDECHAIN_MARKER', 'REMINDER_MARKER']) {
    assert.doesNotMatch(text, new RegExp(marker), `${marker} is not a human turn`);
  }
  assert.match(r.stdout, /Dana Whitfield {2}\(2 sessions\)/);
});

test('mine classifies through the clean call and writes valid verdicts', () => {
  const verdicts = fs.readFileSync(path.join(out, 'verdicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(verdicts.map((v) => v.id), ['v_0001', 'v_0002']);
  for (const v of verdicts) assert.ok(tm.validVerdict(v));
  assert.strictEqual(verdicts[0].date, '2026-09-01');
  assert.ok(!('user' in verdicts[0]), 'raw user text never enters a verdict');
  assert.ok(fs.existsSync(path.join(out, 'batches', 'classify_001.md')));
  assert.deepStrictEqual(fs.readdirSync(path.join(out, '.clean-cwd')), []);
});

test('rerun resumes from the cache with no model calls', () => {
  const calls = () => (fs.existsSync(path.join(out, 'fake-log.txt')) ? fs.readFileSync(path.join(out, 'fake-log.txt'), 'utf8').match(/classify/g) || [] : []).length;
  const before = calls();
  const r = run(['mine', '--yes']);
  assert.strictEqual(r.status, 0, r.all);
  assert.match(r.stdout, /2 verdicts, 0 skipped, 0 invalid/);
  assert.strictEqual(calls(), before);
});

test('skill writes SKILL.md from training verdicts and flags weak or leaked evidence', () => {
  const r = run(['skill', '--cutoff', '2026-09-10']);
  assert.strictEqual(r.status, 0, r.all);
  assert.match(r.stdout, /Cutoff 2026-09-10: 1 testable verdicts on or after it, 1 training verdicts before it/);
  const md = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: my-taste/);
  assert.match(r.stdout, /outside the training set: v_0099/);
  assert.match(r.stdout, /fewer than two sessions/);
  for (const secret of SECRETS) assert.doesNotMatch(allText(out), secret);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).cutoff, '2026-09-10');
});

test('skill explains a history too thin to test', () => {
  const r = run(['skill']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.all, /Found 2 verdicts, 2 of them testable[^]*needs about 30/);
});

test('skill with a cutoff before every verdict says to pick an earlier one', () => {
  const r = run(['skill', '--cutoff', '2020-01-01']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.all, /No verdicts before 2020-01-01 to learn from/);
});

test('--cutoff takes only YYYY-MM-DD', () => {
  assert.match(run(['skill', '--cutoff', '2026-9-1']).stderr, /--cutoff needs a date like/);
});

test('redaction catches logins in URLs, KEY=value secrets, international phones, Windows and root paths, and fused deny names', () => {
  const r = tm.makeRedactor(['Acme']);
  const text = 'db postgres://admin:hunter2@localhost:5432 and API_KEY=abc12345 and password: "s3cretpw" call +44 20 7946 0958 ' +
    'see C:\\Users\\alex\\proj and /root/.ssh and AcmeCorp at acmecorp.atlassian.net';
  const got = r(text);
  for (const leak of ['hunter2', 'abc12345', 's3cretpw', '7946', 'alex', '/root', 'AcmeCorp', 'acmecorp']) assert.ok(!got.includes(leak), `${leak} leaked: ${got}`);
  assert.match(got, /postgres:\/\/\[login\]@localhost/);
  assert.match(got, /\[name\]\.atlassian\.net/);
  for (const keep of ['version 1.2.3 on 2026-09-10, 120 items', 'keyframes: 0.3s ease', 'design token: accent-blue', 'monkey: banana']) assert.strictEqual(r(keep), keep);
});

test('signTest gives the exact two-sided p', () => {
  assert.strictEqual(tm.signTest(0, 0), 1);
  assert.strictEqual(Math.round(tm.signTest(7, 3) * 1000) / 1000, 0.344);
  assert.strictEqual(Math.round(tm.signTest(10, 0) * 1000) / 1000, 0.002);
});

test('refuses to run without --out', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'scan', '--yes'], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--out DIR is required/);
});

test('sampleByMonth spreads the cap evenly across months', () => {
  const cands = [];
  for (const [month, n] of [['2026-06', 3], ['2026-07', 50], ['2026-08', 200]]) for (let i = 0; i < n; i++) cands.push({ timestamp: `${month}-10T00:00:00Z`, i });
  const kept = tm.sampleByMonth(cands, 63);
  const count = (m) => kept.filter((c) => c.timestamp.startsWith(m)).length;
  assert.deepStrictEqual([count('2026-06'), count('2026-07'), count('2026-08')], [3, 30, 30]);
});

test('defaultCutoff leaves the last quarter of testable verdicts, at least 20', () => {
  const v = (d) => ({ date: d, options: ['a', 'b'], pick: 0, confidence: 0.9 });
  const days = (n) => Array.from({ length: n }, (_, i) => v(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)));
  const after = (vs, c) => vs.filter((x) => x.date >= c).length;
  assert.strictEqual(after(days(200), tm.defaultCutoff(days(200))), 50);
  assert.strictEqual(after(days(40), tm.defaultCutoff(days(40))), 20);
  assert.strictEqual(tm.defaultCutoff([{ date: '2026-01-01', options: ['a'], pick: 0, confidence: 1 }]), null);
});

test('cleanEnv keeps sign-in, provider and proxy settings and drops the rest', () => {
  const env = tm.cleanEnv({ HOME: '/h', PATH: '/p', USER: 'u', TERM: 'xterm', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'us-east-1', https_proxy: 'http://proxy', NODE_EXTRA_CA_CERTS: '/ca.pem', CLAUDE_CODE_ENTRYPOINT: 'cli', OPENAI_API_KEY: 'x', SECRET: 'y' });
  assert.deepStrictEqual(Object.keys(env).sort(),
    ['ANTHROPIC_API_KEY', 'AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK', 'HOME', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TERM', 'USER', 'https_proxy']);
  assert.strictEqual(env.TERM, 'dumb');
});

test('an API key reaches the clean call', () => {
  const dir = `${out}-key`;
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'prefer.js'), 'skill', '--out', dir, '--projects-dir', path.join(fixtures, 'projects')],
      { encoding: 'utf8', env: { ...process.env, PREFER_CLAUDE: fake, ANTHROPIC_API_KEY: 'sk-ant-fake' } });
    assert.ok(fs.existsSync(path.join(dir, 'fake-env.txt')), r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed check shows the reason Claude Code printed, before reading any history', () => {
  const dir = `${out}-limit`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ preflight: 'Claude usage limit reached. Your limit will reset at 5pm.' }));
    const r = run(['mine', '--yes'], fake, dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage limit reached/);
    assert.doesNotMatch(r.stdout, /files, .* total/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing claude command says how to fix it', () => {
  const r = run(['scan', '--yes'], '/nonexistent/claude', `${out}-missing`);
  fs.rmSync(`${out}-missing`, { recursive: true, force: true });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not find .*PREFER_CLAUDE/);
});

// Real model, costs a few cents. Run with PREFER_SMOKE=1 node --test
test('smoke: real sonnet classifies the fixture candidates', { skip: !process.env.PREFER_SMOKE }, () => {
  const dir = `${out}-smoke`;
  try {
    const r = run(['mine', '--yes', '--classify-model', 'sonnet'], 'claude', dir);
    assert.strictEqual(r.status, 0, r.all);
    const lines = fs.readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    for (const v of lines) assert.ok(tm.validVerdict(v));
    for (const secret of SECRETS) assert.doesNotMatch(allText(dir), secret);
    console.log(r.stdout.split('\n').slice(-2).join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
