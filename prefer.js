#!/usr/bin/env node
// Prefer: find your design verdicts in your own Claude Code history. Local only, zero dependencies.
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const readline = require('node:readline'), crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');

const COMMANDS = ['scan', 'mine', 'skill', 'test', 'run', 'install'];
const UI_EXT = /\.(swift|html|css|tsx|jsx|metal|svg)$/i;
const WRITE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const DESIGN_NOUN = /\b(layouts?|colou?rs?|type|typography|fonts?|shaders?|animations?|spacing|cards?|hero|icons?|glass)\b/i;
const VERDICT = new RegExp('\\b(' + [
  'love', 'dig', 'rad', 'amazing', 'incredible', 'beautiful', 'dope', 'perfect', 'ship it', 'yes', 'keep', "that['’]?s it",
  'hate', 'no', "don['’]?t love", 'not loving', 'ugly', 'janky', 'busy', 'weird', 'slop', 'worse', 'revert', 'kill', 'get rid of', 'remove',
  'fine', 'ok', 'okay', 'meh', 'not bad', 'better', 'closer', 'more', 'less', 'bigger', 'smaller', 'too',
  '\\w+ over \\w+', 'the (first|second|third|last) one', 'option \\w+', 'go with',
].join('|') + ')\\b', 'i');
// Records that look like user turns but were written by the harness, a hook, or another agent.
const INJECTED = /^\s*(<command-|<local-command|<system-reminder>|<task-notification>|<bash-|<user-prompt-submit-hook>|Caveat:|\[Request interrupted)/;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const KINDS = ['visual', 'motion', 'interaction', 'copy', 'product'];
const POLARITY = ['approve', 'reject', 'mixed', 'reject-then-pick', 'pick'];
const PROMPTS = path.join(__dirname, 'prompts');
const CLAUDE = process.env.PREFER_CLAUDE || 'claude';

const die = (msg) => { console.error(msg); process.exit(1); };
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const tilde = (p) => p.replace(os.homedir(), '~');
const mb = (n) => n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseArgs(argv) {
  const home = process.env.CLAUDE_CONFIG_DIR ? path.resolve(expand(process.env.CLAUDE_CONFIG_DIR)) : path.join(os.homedir(), '.claude');
  const a = { cmd: argv[0], projectsDir: path.join(home, 'projects'), maxCandidates: 4000, yes: false,
    classifyModel: 'sonnet', skillModel: 'opus', predictModel: 'sonnet', repeats: 3, source: 'all', skillsDir: path.join(home, 'skills') };
  if (!COMMANDS.includes(a.cmd)) die(`usage: prefer <${COMMANDS.join('|')}> --out DIR [--deny FILE] [--cutoff DATE] [--projects-dir DIR]\n  [--max-candidates N] [--calibration FILE] [--classify-model M] [--skill-model M] [--predict-model M] [--repeats N]\n  [--source menu|correction|all] [--skills-dir DIR] [--yes]\n  install [--out DIR] installs your taste skill from DIR, or Prefer itself without it`);
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (argv[i + 1] == null) die(`${k} needs a value`); return argv[++i]; };
    if (k === '--out') a.out = path.resolve(expand(v()));
    else if (k === '--deny') a.deny = path.resolve(expand(v()));
    else if (k === '--projects-dir') a.projectsDir = path.resolve(expand(v()));
    else if (k === '--cutoff') { a.cutoff = v(); if (!/^\d{4}-\d{2}-\d{2}$/.test(a.cutoff) || isNaN(Date.parse(a.cutoff))) die('--cutoff needs a date like 2026-09-01'); }
    else if (k === '--max-candidates') { a.maxCandidates = parseInt(v(), 10); if (!(a.maxCandidates > 0)) die('--max-candidates needs a positive number'); }
    else if (k === '--calibration') a.calibration = path.resolve(expand(v()));
    else if (k === '--classify-model') a.classifyModel = v();
    else if (k === '--skill-model') a.skillModel = v();
    else if (k === '--predict-model') a.predictModel = v();
    else if (k === '--repeats') { a.repeats = parseInt(v(), 10); if (!(a.repeats > 0)) die('--repeats needs a positive number'); }
    else if (k === '--source') { a.source = v(); if (!['menu', 'correction', 'all'].includes(a.source)) die('--source is menu, correction, or all'); }
    else if (k === '--skills-dir') a.skillsDir = path.resolve(expand(v()));
    else if (k === '--yes') a.yes = true;
    else die(`unknown flag ${k}`);
  }
  if (a.cmd !== 'install' && !a.out) die('--out DIR is required. Prefer writes only inside that folder.');
  if (a.out && (a.out + path.sep).startsWith(a.projectsDir + path.sep)) die('--out cannot be inside the projects folder.');
  return a;
}

const readManifest = (out) => { try { return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); } catch { return {}; } };
const updateManifest = (out, patch) => writeOut(out, 'manifest.json', JSON.stringify({ ...readManifest(out), ...patch }, null, 2) + '\n');

// Every file write goes through here, so nothing lands outside --out.
function writeOut(out, rel, data) {
  const p = path.resolve(out, rel);
  if (!p.startsWith(out + path.sep)) die(`refusing to write outside --out: ${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

// ---- redaction

function loadDeny(file) {
  const names = file ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
  const git = (k) => { try { return execFileSync('git', ['config', '--global', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const email = git('user.email');
  names.push(os.userInfo().username, git('user.name'), email.includes('@') ? email.split('@')[0] : '');
  return [...new Set(names.map((s) => s.trim()).filter((s) => s.length >= 2))].sort((x, y) => y.length - x.length);
}

function makeRedactor(names) {
  // Names of four or more letters also go when fused into a longer word or domain, like acmecorp.atlassian.net.
  const long = names.filter((n) => n.length >= 4), short = names.filter((n) => n.length < 4);
  const deny = names.length ? new RegExp([long.length && `[A-Za-z0-9_]*(?:${long.map(escapeRe).join('|')})[A-Za-z0-9_]*`,
    short.length && `(?<!\\w)(?:${short.map(escapeRe).join('|')})(?!\\w)`].filter(Boolean).join('|'), 'gi') : null;
  const rules = [
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, '$1[login]@'],
    // NAME_KEY=value and password: value. Values without a digit stay unless long, so 'design token: accent' survives.
    [/\b((?:[A-Z0-9]+_)*(?:API_?KEY|[A-Z0-9]+_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)(?:_[A-Z0-9]+)*)(\s*[=:]\s*)(["']?)([^\s"',;]{6,})\3/gi,
      (m, k, sep, q, v) => (/\d/.test(v) || v.length >= 16 ? `${k}${sep}[secret]` : m)],
    [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[token]'],
    [/\b(sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})/g, '[key]'],
    [/(https?:\/\/[^\s?#"'<>)]+)\?[^\s"'<>)\]]*/g, '$1?[query]'],
    [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
    [/\/(Users|home)\/[^/\s"'`]+/g, '~'],
    [/[A-Za-z]:\\+Users\\+[^\\\s"'`]+/gi, '~'],
    [/(?<![\w.~])\/root(?=\/|\b)/g, '~'],
    [/\b(\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
    [/(?<![\w.])(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g, '[phone]'],
    [/(?<![\w.+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?!\w)/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '[phone]' : m)],
    // long hex or base64 runs; dashed names and UUIDs pass unless they mix case and digits
    [/[A-Za-z0-9+_=-]{32,}/g, (m) => (/\d/.test(m) && /[a-z]/i.test(m) && (!m.includes('-') || (/[A-Z]/.test(m) && /[a-z]/.test(m)))) ? '[key]' : m],
  ];
  if (deny) rules.push([deny, '[name]']);
  const one = (s) => rules.reduce((t, [re, rep]) => t.replace(re, rep), s);
  const deep = (v) => typeof v === 'string' ? one(v) : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  return deep;
}

const NAME_STOP = new Set(('The This That These Those When What Where Which While With And But For From Into Then There Here Make Use Add ' +
  'Fix Let Now Next Also Just Not Yes One Two New Old All Any Each Every Our Your Its His Her Why How Who Did Does Can Could Should Would ' +
  'Will Was Were Are Has Have Had After Before Because Since Until Okay Please Love Ship Keep').split(' '));

function collectNames(text, session, seen) {
  for (const m of text.matchAll(/\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g)) {
    if (NAME_STOP.has(m[1]) || NAME_STOP.has(m[2])) continue;
    (seen[m[0]] ||= new Set()).add(session);
  }
}

// ---- discovery and parsing

const projectName = (folder) => folder.replace(/^-(Users|home)-[^-]+(-|$)/, '') || 'home';

// Folder names are the session cwd with every non-alphanumeric turned into a dash.
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function discover(dir, out) {
  if (!fs.existsSync(dir)) die(`no projects folder at ${dir}`);
  const files = [];
  for (const folder of fs.readdirSync(dir).sort()) {
    // skip this tool's own sessions and scratch sessions
    if (folder.includes('taste-miner') || folder.includes(slug(out)) || /^-(private-)?tmp/.test(folder)) continue;
    const pd = path.join(dir, folder);
    if (!fs.statSync(pd).isDirectory()) continue;
    for (const f of fs.readdirSync(pd).sort()) {
      const p = path.join(pd, f);
      if (f.endsWith('.jsonl') && fs.statSync(p).isFile()) files.push({ path: p, folder, project: projectName(folder), size: fs.statSync(p).size });
    }
  }
  return files;
}

async function confirm(q) {
  if (!process.stdin.isTTY) die('No terminal to confirm in. Rerun with --yes to read these files.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => rl.question(q, r));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

const freshTurn = () => ({ text: '', files: new Set(), urls: new Set(), visual: false });

function absorbAssistant(turn, blocks) {
  for (const b of blocks) {
    if (b.type === 'text' && b.text) turn.text = (turn.text + '\n' + b.text).slice(-4000);
    if (b.type !== 'tool_use') continue;
    const inp = b.input || {};
    for (const k of ['file_path', 'path', 'notebook_path']) {
      if (typeof inp[k] !== 'string') continue;
      turn.files.add(inp[k]);
      if (WRITE_TOOLS.test(b.name) && UI_EXT.test(inp[k])) turn.visual = true;
    }
    if (typeof inp.url === 'string') turn.urls.add(inp.url);
    const shot = inp.action === 'screenshot' || (Array.isArray(inp.actions) && inp.actions.some((x) => x?.input?.action === 'screenshot'));
    if (b.name === 'Artifact' || /screenshot/i.test(b.name || '') || shot) turn.visual = true;
  }
}

function humanTurn(r, blocks) {
  if (r.isMeta || r.isCompactSummary || r.promptSource === 'system') return null;
  if (r.origin && r.origin.kind !== 'human') return null;
  let text = '', image = false;
  for (const b of blocks) {
    if (b.type === 'image') image = true;
    else if (b.type === 'text' && b.text && !INJECTED.test(b.text)) text += '\n' + b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  }
  text = text.trim();
  return text || image ? { text, image } : null;
}

function offeredOptions(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(?:\(?(?:[1-9]|[A-H])[.):]|Option\s+[1-9A-H]\b[:.)]?)(?:\*\*)?\s+(.{3,})/i);
    if (m) out.push(m[1].slice(0, 160));
  }
  return out.length >= 2 ? out.slice(0, 8) : [];
}

async function parseFile(f, stats, cands, redact, names) {
  const st = (stats[f.project] ||= { files: 0, bytes: 0, sessions: new Set(), user_turns: 0, first: null, last: null });
  st.files++; st.bytes += f.size;
  let turn = freshTurn();
  const rl = readline.createInterface({ input: fs.createReadStream(f.path), crlfDelay: Infinity });
  for await (const line of rl) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain) continue;
    const session = r.sessionId || path.basename(f.path, '.jsonl');
    st.sessions.add(session);
    if (r.timestamp) { if (!st.first || r.timestamp < st.first) st.first = r.timestamp; if (!st.last || r.timestamp > st.last) st.last = r.timestamp; }
    const c = r.message?.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (r.type === 'assistant') { absorbAssistant(turn, blocks); continue; }
    if (blocks.some((b) => b.type === 'tool_result')) {
      if (blocks.some((b) => Array.isArray(b.content) && b.content.some((x) => x?.type === 'image'))) turn.visual = true;
      continue;
    }
    const h = humanTurn(r, blocks);
    if (!h) continue;
    st.user_turns++;
    collectNames(redact(h.text), sha(session), names);
    const visual = turn.visual || DESIGN_NOUN.test(turn.text);
    if (visual && (h.text.length < 600 || h.image) && VERDICT.test(h.text)) {
      cands.push(redact({
        project: f.project, session: sha(session), timestamp: r.timestamp || '', has_image: h.image,
        user: h.text, assistant: turn.text.slice(-1500).trim(),
        files: [...turn.files].slice(-12), urls: [...new Set([...turn.urls, ...(turn.text.match(URL_RE) || [])])].slice(0, 10),
        options: offeredOptions(turn.text),
      }));
    }
    turn = freshTurn();
  }
}

// ---- model calls

// Every model call runs here: empty cwd, stripped env, no tools, no settings, no saved session.
// Results are cached by (model, system, prompt, salt), so reruns resume for free. A null salt skips the cache.
let inFlight = 0;
const waiting = [];
const takeSlot = () => new Promise((r) => (inFlight < 4 ? (inFlight++, r()) : waiting.push(r)));
const giveSlot = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };

// Sign-in, cloud provider and network settings. Everything else in the environment is dropped.
const PASS_ENV = /^(ANTHROPIC_\w+|CLAUDE_CODE_USE_\w+|CLAUDE_CODE_SKIP_\w+|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|AWS_\w+|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|CLOUD_ML_REGION|VERTEX_REGION_\w+|HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
function cleanEnv(from = process.env) {
  const env = { HOME: from.HOME, PATH: from.PATH, USER: from.USER, TERM: 'dumb' };
  for (const [k, v] of Object.entries(from)) if (PASS_ENV.test(k) && v != null) env[k] = v;
  return env;
}

// The reason a call failed. Claude Code prints most of them (usage limit, sign-in, model) on stdout.
function failure(err, stdout, stderr) {
  if (err.code === 'ENOENT') return `could not find "${CLAUDE}". Install Claude Code, or set PREFER_CLAUDE to its full path.`;
  if (err.killed) return 'no reply after 15 minutes.';
  const [out, errText] = [stdout, stderr].map((s) => String(s || '').trim());
  return (out || errText).slice(0, 400) || `exit code ${err.code}`;
}

async function callClaude(out, prompt, systemFile, model, parse = (t) => t, salt = '') {
  const system = fs.readFileSync(systemFile, 'utf8');
  const key = crypto.createHash('sha256').update(`${model}\0${system}\0${prompt}` + (salt ? `\0${salt}` : '')).digest('hex');
  const cached = path.join(out, 'cache', `${key}.txt`);
  if (salt !== null && fs.existsSync(cached)) { try { return parse(fs.readFileSync(cached, 'utf8')); } catch {} } // a broken cache file gets a fresh call
  if (Buffer.byteLength(prompt) > 800e3) throw new Error('prompt too large for one call');
  const cwd = path.join(out, '.clean-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  if (fs.readdirSync(cwd).length) die(`${cwd} must stay empty.`);
  // The prompt goes in on stdin, so its size never runs into the command-line limit.
  const args = ['-p', '--system-prompt-file', systemFile, '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--model', model];
  await takeSlot();
  try {
    const text = await new Promise((resolve, reject) => {
      const child = execFile(CLAUDE, args, { cwd, env: cleanEnv(), maxBuffer: 64e6, timeout: 15 * 60e3 },
        (err, stdout, stderr) => (err ? reject(new Error(`claude -p (${model}) failed: ${failure(err, stdout, stderr)}`)) : resolve(stdout)));
      child.stdin.on('error', () => {}); // the exit callback reports it
      child.stdin.end(prompt);
    });
    let parsed;
    try { parsed = parse(text); } catch (e) { throw new Error(`${e.message}. The reply began: ${text.trim().slice(0, 200)}`); }
    if (salt !== null) writeOut(out, `cache/${key}.txt`, text); // only cache replies that parse
    return parsed;
  } finally { giveSlot(); }
}

// System prompt = prompts/<name>.md plus an optional block, written under --out so the call can read it.
function composeSystem(out, name, calibration) {
  let text = fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');
  if (calibration != null) text += `\n\n# Calibration for this designer\n\n${calibration.trim()}\n`;
  writeOut(out, `prompts/${name}.md`, text);
  return path.join(out, 'prompts', `${name}.md`);
}

// The first complete JSON array in the reply, ignoring any text the model adds around it.
function jsonArray(text) {
  const s = text.indexOf('[');
  if (s < 0) throw new Error('reply held no JSON array');
  for (let e = text.indexOf(']', s); e >= 0; e = text.indexOf(']', e + 1)) {
    try { const arr = JSON.parse(text.slice(s, e + 1)); if (Array.isArray(arr)) return arr; } catch {}
  }
  throw new Error('reply held no complete JSON array');
}

function validVerdict(v) {
  return !!v && KINDS.includes(v.kind) && typeof v.judged === 'string' && v.judged.trim() !== ''
    && Array.isArray(v.options) && v.options.length <= 8 && v.options.every((o) => typeof o === 'string' && o.trim() !== '')
    && (v.pick === null || (Number.isInteger(v.pick) && v.pick >= 0 && v.pick < v.options.length))
    && typeof v.reason === 'string' && POLARITY.includes(v.polarity)
    && typeof v.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1;
}

// Over the cap, take an even share from every month, spread across each month.
function sampleByMonth(cands, cap) {
  if (cands.length <= cap) return cands;
  const months = {};
  for (const c of cands) (months[(c.timestamp || '').slice(0, 7)] ||= []).push(c);
  const groups = Object.values(months).sort((x, y) => x.length - y.length);
  const out = [];
  let left = cap;
  groups.forEach((g, i) => {
    const q = Math.min(g.length, Math.floor(left / (groups.length - i)));
    for (let j = 0; j < q; j++) out.push(g[Math.floor((j * g.length) / q)]);
    left -= q;
  });
  return out;
}

// ---- commands

async function scan(a, { writeCandidates }) {
  const files = discover(a.projectsDir, a.out);
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log(`Prefer reads your Claude Code history on this machine.` + (writeCandidates ? ' Redacted excerpts go to Claude through your own sign-in, and nowhere else.\n' : ' This step sends nothing.\n'));
  for (const f of files) console.log(`  ${tilde(f.path)}  ${mb(f.size)}`);
  console.log(`\n${files.length} files, ${mb(total)} total.`);
  if (!files.length) die('No session files found.');
  if (!a.yes && !(await confirm('Read these files? [y/N] '))) die('Stopped. Nothing was read.');

  const redact = makeRedactor(loadDeny(a.deny));
  const stats = {}, cands = [], names = {};
  for (const f of files) await parseFile(f, stats, cands, redact, names);

  const kept = sampleByMonth(cands, a.maxCandidates).sort((x, y) => (x.timestamp < y.timestamp ? -1 : 1)).map((c, i) => ({ id: `c_${String(i + 1).padStart(4, '0')}`, ...c }));
  const projects = Object.fromEntries(Object.entries(stats).map(([p, s]) => [p, { ...s, sessions: s.sessions.size }]));
  const possible = Object.entries(names).filter(([, s]) => s.size >= 2).sort((x, y) => y[1].size - x[1].size).slice(0, 25);
  const prior = readManifest(a.out);
  writeOut(a.out, 'manifest.json', JSON.stringify(redact({
    created: new Date().toISOString(), command: a.cmd, projects_dir: tilde(a.projectsDir), cutoff: a.cutoff || prior.cutoff || null,
    seed: prior.seed || null, possible_names: possible.map(([n]) => n),
    files: files.map((f) => ({ path: tilde(f.path), size: f.size })), total_bytes: total, projects,
    candidates_found: cands.length, candidates_kept: writeCandidates ? kept.length : null, max_candidates: a.maxCandidates,
  }), null, 2) + '\n');
  if (writeCandidates) writeOut(a.out, 'candidates.jsonl', kept.map((c) => JSON.stringify(c)).join('\n') + (kept.length ? '\n' : ''));

  console.log('\nproject                          sessions  turns  first       last');
  for (const [p, s] of Object.entries(projects)) console.log(`${p.slice(0, 32).padEnd(33)}${String(s.sessions).padStart(8)}${String(s.user_turns).padStart(7)}  ${(s.first || '').slice(0, 10)}  ${(s.last || '').slice(0, 10)}`);
  console.log(`\n${cands.length} candidate verdict turns found.` + (writeCandidates ? ` Kept ${kept.length}` + (cands.length > kept.length ? `, sampled evenly across months (cap ${a.maxCandidates}).` : '.') : ''));
  if (possible.length) {
    console.log('\nPossible names, seen in more than one session. Add any real ones to your deny list:');
    for (const [n, s] of possible) console.log(`  ${n}  (${s.size} sessions)`);
  }
  console.log(`\nWrote ${tilde(path.join(a.out, 'manifest.json'))}` + (writeCandidates ? ` and candidates.jsonl` : ''));
  return { kept, redact };
}

async function mine(a) {
  const { kept, redact } = await scan(a, { writeCandidates: true });
  const system = composeSystem(a.out, 'classify', a.calibration ? fs.readFileSync(a.calibration, 'utf8')
    : 'No calibration given. Read approval and rejection from their plain meaning.');
  const batches = [];
  for (let i = 0; i < kept.length; i += 25) batches.push(kept.slice(i, i + 25));
  console.log(`\nClassifying ${kept.length} candidates in ${batches.length} batches with ${a.classifyModel}. Calls run through your own Claude Code sign-in.`);
  const byId = Object.fromEntries(kept.map((c) => [c.id, c]));
  const tally = { verdicts: 0, skipped: 0, invalid: 0, failed: 0 };
  const results = await Promise.all(batches.map(async (batch, i) => {
    const items = batch.map(({ id, project, timestamp, has_image, user, assistant, files, options }) =>
      ({ id, date: timestamp.slice(0, 10), project, has_image, user, assistant, files, options }));
    const prompt = `Classify these ${items.length} candidates. Reply with the JSON array only.\n\n${JSON.stringify(items, null, 1)}`;
    writeOut(a.out, `batches/classify_${String(i + 1).padStart(3, '0')}.md`, prompt);
    try { return await callClaude(a.out, prompt, system, a.classifyModel, jsonArray); }
    catch (e) { tally.failed++; console.error(`  batch ${i + 1}: ${e.message}`); return []; }
  }));
  const verdicts = [];
  for (const row of results.flat()) {
    const c = byId[row?.id];
    if (!c) { tally.invalid++; continue; }
    if (row.verdict == null) { tally.skipped++; continue; }
    const v = { ...row.verdict, pick: row.verdict.pick ?? null };
    if (!validVerdict(v)) { tally.invalid++; continue; }
    verdicts.push(redact({
      id: c.id.replace('c_', 'v_'), candidate: c.id, date: c.timestamp.slice(0, 10), project: c.project, session: c.session,
      kind: v.kind, judged: v.judged, options: v.options, pick: v.pick, reason: v.reason, polarity: v.polarity,
      confidence: v.confidence, has_image: c.has_image, files: c.files,
    }));
  }
  verdicts.sort((x, y) => (x.id < y.id ? -1 : 1));
  writeOut(a.out, 'verdicts.jsonl', verdicts.map((v) => JSON.stringify(v)).join('\n') + (verdicts.length ? '\n' : ''));
  tally.verdicts = verdicts.length;
  console.log(`${tally.verdicts} verdicts, ${tally.skipped} skipped, ${tally.invalid} invalid` +
    (tally.failed ? `, ${tally.failed} batches failed (rerun to retry them; finished batches are cached)` : '') + '. Wrote verdicts.jsonl');
  if (tally.failed) process.exitCode = 1;
}

const MIN_TESTABLE = 30;
const testable = (v) => v.options.length >= 2 && v.pick !== null && v.confidence >= 0.7;

// The date that leaves the last quarter of testable verdicts on or after it, and at least 20.
function defaultCutoff(verdicts) {
  const dates = verdicts.filter(testable).map((v) => v.date).sort();
  if (dates.length < MIN_TESTABLE) return null;
  return dates[dates.length - Math.min(dates.length, Math.max(20, Math.ceil(dates.length / 4)))];
}

// Each rule's Ids line must point at training verdicts from two or more sessions.
function checkSkill(md, train) {
  const byId = Object.fromEntries(train.map((v) => [v.id, v]));
  const warnings = [];
  let section = '';
  for (const line of md.split('\n')) {
    if (/^# /.test(line)) section = line.slice(2).trim().toLowerCase();
    const ids = /^\s*-?\s*Ids?:/i.test(line) ? line.match(/v_\d+/g) || [] : [];
    if (!ids.length) continue;
    const outside = ids.filter((id) => !byId[id]);
    if (outside.length) warnings.push(`cites verdicts outside the training set: ${outside.join(', ')}`);
    const sessions = new Set(ids.filter((id) => byId[id]).map((id) => byId[id].session));
    if (!section.startsWith('seen once') && sessions.size < 2) warnings.push(`rule backed by fewer than two sessions: ${ids.join(', ')}`);
  }
  for (const h of ['Calibration', 'Hard bans', 'Positive laws', 'Context rules']) if (!new RegExp(`^# ${h}`, 'mi').test(md)) warnings.push(`missing section: ${h}`);
  return warnings;
}

async function skill(a) {
  const file = path.join(a.out, 'verdicts.jsonl');
  if (!fs.existsSync(file)) die('No verdicts.jsonl in --out. Run mine first.');
  const verdicts = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cutoff = a.cutoff || defaultCutoff(verdicts);
  const nTestable = verdicts.filter(testable).length;
  if (!cutoff) die(`Found ${verdicts.length} verdicts, ${nTestable} of them testable (a choice between options, a recorded pick, confidence 0.7 or more).\n` +
    `The blind test needs about ${MIN_TESTABLE}: enough to learn from and 20 to test. Run it again after more design work with Claude Code, or pass --cutoff DATE to try anyway.`);
  const nTest = verdicts.filter((v) => testable(v) && v.date >= cutoff).length;
  const train = verdicts.filter((v) => v.date < cutoff && v.confidence >= 0.6);
  console.log(`Cutoff ${cutoff}: ${nTest} testable verdicts on or after it, ${train.length} training verdicts before it.`);
  if (nTest < 20) console.log(`Only ${nTest} testable verdicts after the cutoff. The blind test wants 20 or more.`);
  if (!train.length) die(`No verdicts before ${cutoff} to learn from. Pick an earlier --cutoff.`);
  const manifestPath = path.join(a.out, 'manifest.json');
  if (fs.existsSync(manifestPath)) writeOut(a.out, 'manifest.json', JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), cutoff }, null, 2) + '\n');

  // The writer sees structured records only, so raw user text cannot reach SKILL.md.
  const records = train.map(({ id, date, session, project, kind, judged, options, pick, reason, polarity, has_image }) =>
    JSON.stringify({ id, date, session, project, kind, judged, options, pick, reason, polarity, has_image }));
  const prompt = `Write the SKILL.md from these ${records.length} verdicts.\n\n${records.join('\n')}`;
  console.log(`Writing the skill with ${a.skillModel}.`);
  const md = await callClaude(a.out, prompt, composeSystem(a.out, 'skill'), a.skillModel,
    (t) => { const m = t.trim().replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, ''); if (!m.startsWith('---')) throw new Error('reply did not start with front matter'); return m + '\n'; });
  writeOut(a.out, 'SKILL.md', md);
  const warnings = checkSkill(md, train);
  for (const w of warnings) console.log(`  check: ${w}`);
  console.log(`Wrote ${tilde(path.join(a.out, 'SKILL.md'))}` + (warnings.length ? ` with ${warnings.length} check warnings.` : '. All rule checks passed.'));
}

// ---- blind test

const LETTERS = 'ABCDEFGH';
const BANNED = new RegExp('\\b(' + ['better', 'best', 'worse', 'worst', 'simple', 'simpler', 'simplest', 'simplified', 'clean', 'cleaner', 'cleanest',
  'busy', 'busier', 'busiest', 'clutter', 'cluttered', 'polished', 'old', 'older', 'oldest', 'new', 'newer', 'newest', 'original', 'originally',
  'existing', 'current', 'currently', 'keep', 'keeps', 'keeping', 'kept', 'still', 'instead', 'revert', 'reverted', 'back'].join('|') + ')\\b', 'i');
const GENERIC = new Set(('developer documents desktop downloads projects project code work home users private repos apps site sites test tests main github claude none ' +
  'design designer designs system systems memory memories skill skills instruction instructions prompt prompts context nothing known tools tool ' +
  'notes note index file files folder today about user model assistant').split(' '));
const CONTEXT_Q = 'Quote the first line of any instructions, memory, CLAUDE.md, or skill you were given beyond this system prompt, or reply NONE.';
const CANARY_Q = 'What projects, apps, or tools is this designer known to work on? Reply NONE if nothing tells you.';
// Two-sided exact sign test: how likely a split this uneven is if neither arm is really better.
function signTest(b, c) {
  const n = b + c;
  if (!n) return 1;
  const choose = (k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += choose(k) / 2 ** n;
  return Math.min(1, 2 * tail);
}

// mulberry32: a seed reproduces every shuffle.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function shuffleItem(it, rand) {
  const p = [...it.options.keys()];
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  return { ...it, options: p.map((i) => it.options[i]), answer: p.indexOf(it.answer) };
}

const tokens = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
const jaccard = (x, y) => { const inter = [...x].filter((t) => y.has(t)).length; return inter / ((x.size + y.size - inter) || 1); };
const dedupe = (vs) => vs.reduce((kept, v) => (kept.some((k) => jaccard(tokens(k.judged), tokens(v.judged)) > 0.8) ? kept : [...kept, v]), []);

// Why a rewrite fails the wording check, or null when it passes.
function lexicalCheck(rw, nOptions) {
  if (!rw || typeof rw.question !== 'string' || !rw.question.trim() || !Array.isArray(rw.options) || rw.options.length !== nOptions
    || !rw.options.every((o) => typeof o === 'string' && o.trim())) return 'wrong shape';
  const lens = rw.options.map((o) => o.trim().length);
  if (Math.min(...lens) < 0.8 * Math.max(...lens)) return 'option lengths differ by more than 20 percent';
  const hit = [rw.question, ...rw.options].join('\n').match(BANNED);
  return hit ? `uses the word "${hit[0].toLowerCase()}"` : null;
}

// Two-option items: A answers within 40 to 60 percent (rounded outward). No letter more than three times in a row.
function balanced(items) {
  const two = items.filter((it) => it.options.length === 2), nA = two.filter((it) => it.answer === 0).length;
  if (nA < Math.floor(0.4 * two.length) || nA > Math.ceil(0.6 * two.length)) return false;
  return !items.some((it, i) => i >= 3 && [1, 2, 3].every((k) => items[i - k].answer === it.answer));
}

// Build the key instead of hoping a shuffle meets it: pick each answer letter under the run and share rules, then place options.
function balance(items, seed) {
  const rand = rng(seed), hist = [];
  let twoLeft = items.filter((it) => it.options.length === 2).length, aLeft = Math.round(twoLeft / 2);
  const out = items.map((it) => {
    const k = it.options.length, last = hist.slice(-3);
    let allowed = [...Array(k).keys()];
    if (last.length === 3 && last.every((x) => x === last[0])) allowed = allowed.filter((x) => x !== last[0]);
    let target;
    if (k === 2) {
      target = allowed.length === 1 ? allowed[0] : rand() < aLeft / twoLeft ? 0 : 1;
      if (target === 0) aLeft--; twoLeft--;
    } else target = allowed[Math.floor(rand() * allowed.length)];
    const others = [...it.options.keys()].filter((i) => i !== it.answer);
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const order = [...Array(k).keys()].map((j) => (j === target ? it.answer : others.shift()));
    hist.push(target);
    return { ...it, options: order.map((i) => it.options[i]), answer: target };
  });
  return { items: out, seed, balanced: balanced(out) };
}

// The rewriter sees the question and options only, in a seeded order. Never the pick, the reason, or the user.
async function neutralize(a, items, seed) {
  const system = composeSystem(a.out, 'neutralize');
  const rand = rng(seed ^ 0x5bd1e995);
  let todo = items.map((it) => ({ it: shuffleItem(it, rand), why: null }));
  const done = [];
  for (let attempt = 1; attempt <= 2 && todo.length; attempt++) {
    const failed = [], groups = [];
    for (let i = 0; i < todo.length; i += 20) groups.push(todo.slice(i, i + 20));
    await Promise.all(groups.map(async (g) => {
      const rows = g.map(({ it, why }, i) => ({ n: i + 1, question: it.judged, options: it.options, ...(why ? { last_try_failed: why } : {}) }));
      const prompt = (attempt > 1 ? 'Second attempt. Each item says why its first rewrite failed.\n' : '') +
        `Rewrite these ${rows.length} items. Reply with the JSON array only.\n\n${JSON.stringify(rows, null, 1)}`;
      // A reply in the wrong shape gets a second try. A failed call (usage limit, sign-in) stops the test.
      const reply = await callClaude(a.out, prompt, system, a.classifyModel, jsonArray).catch((e) => { if (e.message.startsWith('claude -p')) throw e; return []; });
      g.forEach(({ it }, i) => {
        const rw = reply.find((r) => r?.n === i + 1), why = lexicalCheck(rw, it.options.length);
        if (why) failed.push({ it, why });
        else done.push({ ...it, question: rw.question.trim(), options: rw.options.map((o) => o.trim()) });
      });
    }));
    todo = failed;
  }
  const order = items.map((it) => it.verdict);
  return { items: done.sort((x, y) => order.indexOf(x.verdict) - order.indexOf(y.verdict)), dropped: todo.length };
}

// Names only a leak could produce: possible names and project folders from the manifest, capitalized words atop MEMORY.md.
// They are used to test and redact the reply, and never written anywhere.
function canaryNames(a, manifest) {
  const words = [...(manifest.possible_names || []), ...Object.keys(manifest.projects || {})].flatMap((s) => s.split(/[^A-Za-z0-9]+/));
  for (const d of fs.existsSync(a.projectsDir) ? fs.readdirSync(a.projectsDir) : []) {
    const f = path.join(a.projectsDir, d, 'memory', 'MEMORY.md');
    if (fs.existsSync(f)) words.push(...(fs.readFileSync(f, 'utf8').split('\n').slice(0, 10).join('\n').match(/\b[A-Z][A-Za-z0-9]+/g) || []));
  }
  // The user's own name reaches the scorer through the account email, equally for both arms, so it is no leak.
  const own = new Set(loadDeny(a.deny).flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/)));
  return [...new Set(words.filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase()) && !NAME_STOP.has(w) && !own.has(w.toLowerCase())))];
}

async function cleanProof(a, system, manifest) {
  const ask = (q) => callClaude(a.out, q, system, a.predictModel, (t) => t.trim(), null);
  const [context, canary] = await Promise.all([ask(CONTEXT_Q), ask(CANARY_Q)]);
  // Words the scorer was handed in its own prompt can come back without any leak.
  const given = tokens([CONTEXT_Q, CANARY_Q, fs.readFileSync(system, 'utf8')].join(' '));
  const names = canaryNames(a, manifest).filter((w) => !given.has(w.toLowerCase()));
  const re = names.length ? new RegExp(`(?<![A-Za-z0-9])(?:${names.map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
  // After a NONE, only a capitalized match counts: a name, as opposed to the same word in ordinary use ("shared", "design").
  const saysNone = /^\W*NONE\b/i.test(canary);
  const hits = new Set(re ? (canary.match(re) || []).filter((h) => !saysNone || /^[A-Z]/.test(h)).map((h) => h.toLowerCase()) : []);
  const redact = makeRedactor([...loadDeny(a.deny), ...names]);
  // Claude Code attaches the account email to every call, so both arms see it. Name it, then require NONE for anything else.
  // NONE, alone or followed by chatter. A leak would come back quoted, so a quote mark after NONE still fails.
  const none = (t) => { const m = t.match(/^\W*NONE\b([^]*)$/i); return !!m && !/["“”'‘’`>]/.test(m[1].replace(/\b\w+['’]\w+\b/g, '')); };
  const emailOnly = !none(context) && /@|e-?mail|account/i.test(context) && none(await ask(CONTEXT_Q + ' Leave out a block that only states the account or its email address.'));
  if (hits.size) console.error(`The canary reply named: ${[...hits].join(', ')}. These words come from your history or memory files.`);
  const proof = { context_check: { pass: none(context) || emailOnly, email_block_seen: emailOnly, reply: redact(context) },
    canary: { pass: hits.size === 0, names_checked: names.length, names_matched: hits.size, reply: redact(canary) } };
  writeOut(a.out, 'test/canary.json', JSON.stringify(proof, null, 2) + '\n');
  return proof;
}

function parseAnswers(text, n) {
  const got = Array(n).fill(null);
  for (const line of text.split('\n')) {
    const m = line.match(/^\W*(\d+)\**\s*:\s*\**\s*\(?([A-H])\)?(?![A-Za-z])\**\s*[|.:)-]?\s*(.*)$/);
    if (m && m[1] >= 1 && m[1] <= n && !got[m[1] - 1]) got[m[1] - 1] = { pick: m[2], reason: m[3].trim().slice(0, 300) };
  }
  const answered = got.filter(Boolean).length;
  if (answered < n / 2) throw new Error(`reply answered ${answered} of ${n} items`);
  return got;
}

async function blindTest(a) {
  const vFile = path.join(a.out, 'verdicts.jsonl'), skillFile = path.join(a.out, 'SKILL.md'), manifest = readManifest(a.out);
  if (!fs.existsSync(vFile) || !fs.existsSync(skillFile)) die('Need verdicts.jsonl and SKILL.md in --out. Run mine and skill first.');
  const cutoff = a.cutoff || manifest.cutoff;
  if (!cutoff) die('No cutoff in manifest.json. Run skill first, or pass the --cutoff SKILL.md was written with.');
  if (manifest.cutoff && cutoff < manifest.cutoff) die(`SKILL.md was written with cutoff ${manifest.cutoff}. An earlier test cutoff would test it on its own training verdicts.`);
  const seed = manifest.seed || crypto.randomInt(1, 2 ** 31 - 1);
  updateManifest(a.out, { seed }); // before any call, so a rerun reuses the cached rewording

  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // menu: the agent offered two or more options. correction: shown versus what the designer asked for instead.
  const menus = new Set(lines(path.join(a.out, 'candidates.jsonl')).filter((c) => c.options?.length >= 2).map((c) => c.id));
  if (!menus.size) console.log('No offered options found in candidates.jsonl, so every item counts as a correction.');
  const pool = lines(vFile).filter((v) => testable(v) && v.date >= cutoff).map((v) => ({ ...v, source: menus.has(v.candidate) ? 'menu' : 'correction' }))
    .filter((v) => a.source === 'all' || v.source === a.source);
  // A question raised before the cutoff and again after it would let the skill carry its own answer. Those items go.
  const trainText = lines(vFile).filter((v) => v.date < cutoff).map((v) => tokens(`${v.judged} ${v.options.join(' ')}`));
  const fresh = pool.filter((v) => { const t = tokens(`${v.judged} ${v.options.join(' ')}`); return !trainText.some((x) => jaccard(t, x) > 0.8); });
  const echoes = pool.length - fresh.length;
  if (echoes) console.log(`${echoes} items repeat a question from before the cutoff and were dropped.`);
  const unique = dedupe(fresh);
  if (!unique.length) die(`No testable verdicts on or after ${cutoff}${a.source === 'all' ? '' : ` with source ${a.source}`}.`);
  console.log(`Blind test: ${unique.length} items on or after ${cutoff} (${fresh.length - unique.length} near duplicates merged).`);
  console.log(`Rewording options with ${a.classifyModel}. It never sees which option was picked.`);
  const neutral = await neutralize(a, unique.map((v) => ({ verdict: v.id, kind: v.kind, source: v.source, judged: v.judged, options: v.options, answer: v.pick })), seed);
  if (neutral.dropped) console.log(`${neutral.dropped} items failed the wording check twice and were dropped.`);
  if (!neutral.items.length) die('No items passed the wording check.');
  const bal = balance(neutral.items, seed);
  if (!bal.balanced) console.log('Warning: no shuffle in 50 tries met the key balance rules. Using the last one.');
  const items = bal.items.map((it, i) => ({ ...it, id: `t${String(i + 1).padStart(2, '0')}` })), n = items.length;
  writeOut(a.out, 'test/items.json', JSON.stringify(items.map(({ id, kind, question, options }) =>
    ({ id, kind, question, options: options.map((text, j) => ({ letter: LETTERS[j], text })) })), null, 2) + '\n');
  const keyText = JSON.stringify({ seed, shuffle_seed: bal.seed, balanced: bal.balanced,
    answers: items.map((it) => ({ id: it.id, verdict: it.verdict, source: it.source, answer: LETTERS[it.answer] })) }, null, 2) + '\n';
  writeOut(a.out, 'test/key.json', keyText);
  const hash = crypto.createHash('sha256').update(keyText).digest('hex');
  updateManifest(a.out, { key_sha256: hash });
  console.log(`Wrote test/items.json and test/key.json. Key sha256 ${hash}`);

  const predict = fs.readFileSync(path.join(PROMPTS, 'predict.md'), 'utf8');
  writeOut(a.out, 'test/predict-with-skill.md', `${fs.readFileSync(skillFile, 'utf8').trim()}\n\n${predict}`);
  writeOut(a.out, 'test/predict-no-history.md', `${predict.trim()}\n\nA designer made these choices. Predict which option they picked.\n`);
  const sys = { 'with-skill': path.join(a.out, 'test/predict-with-skill.md'), 'no-history': path.join(a.out, 'test/predict-no-history.md') };
  console.log('Checking that the scorer sees nothing beyond its system prompt.');
  const proof = await cleanProof(a, sys['no-history'], manifest);
  const clean = proof.context_check.pass && proof.canary.pass;
  const ctx = { a, n, cutoff, seed, bal, hash, items, proof, clean, dropped: neutral.dropped, duplicates: fresh.length - unique.length, echoes };
  if (!clean) {
    const bar = '!'.repeat(64), why = [!proof.context_check.pass && 'failed the context check', !proof.canary.pass && 'named something only your history holds'];
    console.error(`\n${bar}\nCONTAMINATED: the scorer ${why.filter(Boolean).join(' and ')}.\nNo predictions were run and the report has no score. See test/canary.json.\n${bar}\n`);
    writeReport(ctx); process.exitCode = 1; return;
  }

  console.log(`Predicting with ${a.predictModel}: two arms, ${a.repeats} runs each.`);
  const prompt = `Predict the designer's pick for each of these ${n} items.\n\n` +
    items.map((it, i) => `${i + 1}. ${it.question}\n` + it.options.map((o, j) => `${LETTERS[j]}) ${o}`).join('\n')).join('\n\n');
  const runs = { 'with-skill': [], 'no-history': [] };
  await Promise.all(Object.keys(runs).flatMap((arm) => Array.from({ length: a.repeats }, async (_, r) => {
    runs[arm][r] = await callClaude(a.out, prompt, sys[arm], a.predictModel, (t) => parseAnswers(t, n), `repeat ${r + 1}`);
  })));
  const score = (ans) => items.filter((it, i) => ans[i]?.pick === LETTERS[it.answer]).length;
  for (const arm of Object.keys(runs)) writeOut(a.out, `test/${arm}.json`, JSON.stringify(runs[arm].map((ans, r) =>
    ({ repeat: r + 1, correct: score(ans), answers: items.map((it, i) => ({ id: it.id, ...ans[i] })) })), null, 2) + '\n');
  writeReport({ ...ctx, runs, score });
}

function writeReport({ a, n, cutoff, seed, bal, hash, items, proof, clean, dropped, duplicates, echoes, runs, score }) {
  const r1 = (x) => Math.round(x * 10) / 10, mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length, pass = (ok) => (ok ? 'passed' : 'FAILED');
  const md = ['# Prefer blind test', ''];
  if (!clean) md.push('**CONTAMINATED.** The scorer saw something beyond its system prompt, so this run has no score. See test/canary.json.', '');
  md.push(`- Items: ${n} on or after the cutoff (${echoes} dropped for repeating a question from before it, ${duplicates} near duplicates merged, ${dropped} dropped by the wording check)`,
    `- Cutoff: ${cutoff}. Items from: ${a.source === 'all' ? 'menus and corrections' : `${a.source}s only`}`, `- Seed: ${seed} (final shuffle seed ${bal.seed}${bal.balanced ? '' : ', key balance rules not met'})`,
    `- Key sha256: ${hash}`, `- Predictor: ${a.predictModel}, ${a.repeats} runs per arm. Options reworded by ${a.classifyModel}.`,
    `- Clean proof: context check ${pass(proof.context_check.pass)}, canary ${pass(proof.canary.pass)} (${proof.canary.names_checked} names checked).`,
    '- Claude Code adds the account email to every call. It reaches both arms equally.',
    '- Known weakness: when the rewording model and the predictor share a family, wording can still lean.');
  if (n < 20) md.push('- n is under 20. The blind test wants 20 or more.');
  const json = { n, cutoff, seed, shuffle_seed: bal.seed, key_balanced: bal.balanced, key_sha256: hash, source: a.source, repeats_of_training_dropped: echoes, duplicates, dropped_by_wording_check: dropped,
    clean, context_check: proof.context_check.pass, canary: proof.canary.pass, predict_model: a.predictModel, repeats: a.repeats };
  if (clean) {
    const hit = (ans, i) => ans[i]?.pick === LETTERS[items[i].answer];
    const split = (idx) => Object.fromEntries(Object.entries(runs).map(([arm, rs]) => {
      const xs = rs.map((ans) => idx.filter((i) => hit(ans, i)).length);
      return [arm.replace('-', '_'), { mean: r1(mean(xs)), runs: xs }];
    }));
    const all = split(items.map((_, i) => i)), w = mean(all.with_skill.runs), h = mean(all.no_history.runs), gap = w - h;
    const maj = (arm, i) => { const c = {}; for (const ans of runs[arm]) { const l = ans[i]?.pick || '-'; c[l] = (c[l] || 0) + 1; } return Object.entries(c).sort((x, y) => y[1] - x[1])[0][0]; };
    const right = (arm, i) => maj(arm, i) === LETTERS[items[i].answer];
    const b = items.filter((_, i) => right('with-skill', i) && !right('no-history', i)).length;
    const c = items.filter((_, i) => !right('with-skill', i) && right('no-history', i)).length;
    const p = signTest(b, c), p2 = Math.round(p * 100) / 100;
    const verdict = `Item by item, using each arm's most common answer: the skill was right where no history was wrong on ${b} items, and the reverse on ${c}. ` +
      `Sign test p = ${p2}. ` + (p < 0.05 ? 'A split this uneven is unlikely to be chance.' : 'A split like this could easily be chance, so this run does not show the skill helps.');
    const blank = Object.fromEntries(Object.entries(runs).map(([arm, rs]) => [arm.replace('-', '_'), rs.reduce((s, ans) => s + ans.filter((x) => !x).length, 0)]));
    const row = (label, k, s) => `| ${label} | ${k} | ${s.with_skill.mean} (${s.with_skill.runs.join(', ')}) | ${s.no_history.mean} (${s.no_history.runs.join(', ')}) |`;
    md.push('', '## Score', '', `| Arm | Mean of ${n} | Runs |`, '|---|---|---|',
      ...[['With skill', all.with_skill], ['No history', all.no_history]].map(([l, x]) => `| ${l} | ${x.mean} (${r1((x.mean / n) * 100)}%) | ${x.runs.join(', ')} |`), '',
      `Gap: ${gap >= 0 ? '+' : ''}${r1(gap)} items, ${gap >= 0 ? '+' : ''}${r1((gap / n) * 100)} points.`, '', verdict, '',
      ...(blank.with_skill || blank.no_history ? [`Unanswered items, counted as wrong, across all runs: with skill ${blank.with_skill}, no history ${blank.no_history}.`, ''] : []),
      '## By source and kind', '', 'Menu items had options offered by the agent. Correction items set what was shown against what the designer asked for.', '',
      '| Group | n | With skill, mean (runs) | No history, mean (runs) |', '|---|---|---|---|');
    Object.assign(json, { with_skill: all.with_skill, no_history: all.no_history, gap_items: r1(gap), gap_points: r1((gap / n) * 100),
      skill_only_right: b, no_history_only_right: c, sign_test_p: Math.round(p * 1000) / 1000, unanswered: blank, by_source: {}, by_kind: {} });
    for (const [field, groups] of [['source', ['menu', 'correction']], ['kind', KINDS]]) for (const g of groups) {
      const idx = items.map((it, i) => (it[field] === g ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      json[`by_${field}`][g] = { n: idx.length, ...split(idx) };
      md.push(row(`${field}: ${g}`, idx.length, json[`by_${field}`][g]));
    }
    const show = (it, i) => [`### ${it.id}. ${it.question}`, ...it.options.map((o, j) => `- ${LETTERS[j]}) ${o}`),
      `- Key ${LETTERS[it.answer]}. With skill ${maj('with-skill', i)}, no history ${maj('no-history', i)} (most common answer across runs).`, ''];
    const differ = items.map((it, i) => i).filter((i) => maj('with-skill', i) !== maj('no-history', i));
    const missed = items.map((it, i) => i).filter((i) => ![maj('with-skill', i), maj('no-history', i)].includes(LETTERS[items[i].answer]));
    md.push('', `## Arms disagreed (${differ.length})`, '', ...differ.flatMap((i) => show(items[i], i)), `## Both missed (${missed.length})`, '', ...missed.flatMap((i) => show(items[i], i)));
    Object.assign(json, { disagreements: differ.length, both_missed: missed.length });
    console.log(`With skill ${r1(w)} of ${n}, no history ${r1(h)} of ${n}. Gap ${r1(gap)} items. ${verdict}`);
  } else md.push('', 'Predictions were not run.');
  writeOut(a.out, 'report.md', md.join('\n').trim() + '\n');
  writeOut(a.out, 'report.json', JSON.stringify(json, null, 2) + '\n');
  console.log(`Wrote ${tilde(path.join(a.out, 'report.md'))} and report.json`);
}

// With --out, installs the taste skill that run wrote. Without it, installs Prefer itself as a personal skill.
function install(a) {
  const own = !!a.out;
  const src = own ? path.join(a.out, 'SKILL.md') : path.join(__dirname, 'skills', 'prefer', 'SKILL.md');
  if (!fs.existsSync(src)) die(own ? `No SKILL.md in ${tilde(a.out)}. Run skill first.` : `Missing ${src}.`);
  const md = fs.readFileSync(src, 'utf8');
  const name = own ? ((md.match(/^name:\s*([^\n]+)/m) || [])[1] || 'my-taste').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-') : 'prefer';
  const dest = path.join(a.skillsDir, name);
  if (path.resolve(dest) === __dirname) die('This copy is already the installed one.');
  if (fs.existsSync(path.join(dest, 'SKILL.md')) && !a.yes) die(`${tilde(dest)} already holds a skill. Rerun with --yes to replace it.`);
  fs.mkdirSync(dest, { recursive: true });
  if (own) {
    fs.writeFileSync(path.join(dest, 'SKILL.md'), md);
    return console.log(`Installed your taste skill to ${tilde(dest)}. Claude Code loads it in new sessions as "${name}".`);
  }
  // The plugin's SKILL.md finds the script through ${CLAUDE_PLUGIN_ROOT}. A personal skill gets the real path.
  fs.writeFileSync(path.join(dest, 'SKILL.md'), md.split('${CLAUDE_PLUGIN_ROOT}').join(dest));
  fs.copyFileSync(__filename, path.join(dest, 'prefer.js'));
  fs.mkdirSync(path.join(dest, 'prompts'), { recursive: true });
  for (const f of fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md'))) fs.copyFileSync(path.join(PROMPTS, f), path.join(dest, 'prompts', f));
  console.log(`Installed to ${tilde(dest)}. In Claude Code, type /prefer.`);
}

// Before reading anything: the right platform and Node, a claude command, and one tiny clean call per model.
async function preflight(a) {
  if (process.platform === 'win32') die('Prefer runs on macOS and Linux. On Windows, run it inside WSL.');
  const major = parseInt(process.versions.node, 10);
  if (major < 18) die(`Prefer needs Node 18 or newer. This is Node ${process.versions.node}.`);
  let version;
  try { version = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { die(`Could not run "${CLAUDE} --version": ${failure(e, e.stdout, e.stderr)}`); }
  const models = { scan: [], mine: [a.classifyModel], skill: [a.skillModel], test: [a.classifyModel, a.predictModel],
    run: [a.classifyModel, a.skillModel, a.predictModel] }[a.cmd];
  writeOut(a.out, 'prompts/preflight.md', 'Reply with the single word OK.\n');
  for (const m of [...new Set(models)]) {
    try { await callClaude(a.out, 'Say OK.', path.join(a.out, 'prompts', 'preflight.md'), m, (t) => { if (!/\bOK\b/i.test(t)) throw new Error('expected OK'); return t; }, null); }
    catch (e) { die(`Claude Code check failed.\n${e.message}\nIf it names an unknown option, run: claude update`); }
  }
  console.log(`Node ${process.versions.node}, ${version}${models.length ? `, models ready: ${[...new Set(models)].join(', ')}` : ''}.\n`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd !== 'install') await preflight(a);
  if (a.cmd === 'scan') return scan(a, { writeCandidates: false });
  if (a.cmd === 'mine') return mine(a);
  if (a.cmd === 'skill') return skill(a);
  if (a.cmd === 'test') return blindTest(a);
  if (a.cmd === 'install') return install(a);
  for (const step of [mine, skill, blindTest]) { if (process.exitCode) return; await step(a); }
}

module.exports = { cleanEnv, signTest, makeRedactor, sampleByMonth, defaultCutoff, checkSkill, validVerdict, projectName, lexicalCheck, balance, balanced, dedupe, parseAnswers };
if (require.main === module) main().catch((e) => die(e.stack || String(e)));
