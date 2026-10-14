#!/usr/bin/env node
// One pass of the pin sync (cgwalters-forge/tracker#544): for each caller in
// manifest.json whose files pin the source (agentic-job) anywhere but the
// head of its branch, start one implement run of this repository's
// dispatch.yml asking that caller to move its pins, so the run gets
// dispatch.toml's bounds and its own review. Nothing here pushes or edits a
// caller; the run's pull request does. Standard library only; the pure
// functions are what sync.test.cjs covers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = path.join(__dirname, 'manifest.json');
const DISPATCH_WORKFLOW = 'dispatch.yml';
const BRANCH_PREFIX = 'dispatch/';
// A bound on what one pass may start: one run per caller, at most this many.
const MAX_CALLERS = 10;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const FILE_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// The manifest as the default branch has it, checked whole: a pass over a
// half-valid manifest would dispatch for some callers and not others.
function validateManifest(m) {
  const errors = [];
  if (!REPO_RE.test(m?.source ?? '')) errors.push('source must be OWNER/NAME');
  if (!/^[\w./-]+$/.test(m?.branch ?? '')) errors.push('branch must be a branch name');
  if (!/^[\w-]+$/.test(m?.bot ?? '')) errors.push('bot must be a login');
  const callers = Array.isArray(m?.callers) ? m.callers : [];
  if (!callers.length) errors.push('callers must be a non-empty list');
  if (callers.length > MAX_CALLERS) errors.push(`at most ${MAX_CALLERS} callers`);
  const seen = new Set();
  for (const [i, c] of callers.entries()) {
    const at = `callers[${i}]`;
    if (!REPO_RE.test(c?.repo ?? '')) errors.push(`${at}.repo must be OWNER/NAME`);
    else if (seen.has(c.repo)) errors.push(`${at}.repo ${c.repo} is listed twice`);
    else seen.add(c.repo);
    if (c?.repo === m?.source) errors.push(`${at} is the source itself`);
    if (c?.issue !== undefined && !(Number.isSafeInteger(c.issue) && c.issue > 0)) errors.push(`${at}.issue must be a positive integer`);
    if (!Array.isArray(c?.files) || !c.files.length || !c.files.every(f => typeof f === 'string' && FILE_RE.test(f))) {
      errors.push(`${at}.files must be a non-empty list of relative paths`);
    }
  }
  if (errors.length) throw new Error(`manifest.json: ${errors.join('; ')}`);
  return m;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every ref a `uses:` line pins the source at, `SOURCE/path@REF` or
// `SOURCE@REF`, the name matched as GitHub does, whatever its case. Only
// `uses:`, so a comment naming an old commit is no drift. The ref is kept to
// the characters a sha, tag or branch has, since it goes into the task text.
function findPins(text, source) {
  const re = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*['"]?${escapeRe(source)}(?:/[\\w./-]*)?@([\\w./-]*\\w)`, 'gim');
  return [...text.matchAll(re)].map(m => m[1]);
}

// What one pass does for a caller. `files` maps each manifest path to its
// text on the caller's default branch, or null where it is missing; `pulls`
// are the caller's open pull requests with the paths they change; `runs`
// are dispatch.yml's recent runs here.
function decide({ caller, head, files, pulls, runs, bot }) {
  const missing = caller.files.filter(f => files[f] == null);
  if (missing.length) return { action: 'skip', reason: `missing on its default branch: ${missing.join(', ')}` };
  const behind = [];
  for (const f of caller.files) {
    const pins = files[f].pins;
    if (!pins.length) return { action: 'skip', reason: `${f} pins nothing; the manifest is out of date` };
    const old = [...new Set(pins.filter(p => p !== head))];
    if (old.length) behind.push({ file: f, pins: old });
  }
  if (!behind.length) return { action: 'none', reason: `pinned at ${head.slice(0, 12)}` };
  const what = behind.map(b => `${b.file} at ${b.pins.map(p => p.slice(0, 12)).join(', ')}`).join('; ');
  // Any open dispatch pull request of the bot changing a pinned file counts:
  // a second one would conflict with it, whatever it was opened for.
  const open = pulls.find(p => p.author === bot && p.branch.startsWith(BRANCH_PREFIX) && p.files.some(f => caller.files.includes(f)));
  if (open) return { action: 'skip', reason: `behind (${what}); ${caller.repo}#${open.number} is open`, behind };
  if (!caller.issue) return { action: 'skip', reason: `behind (${what}); the manifest names no issue to dispatch on`, behind };
  // dispatch.yml's run-name, with or without its pool.
  const title = `implement ${caller.repo}#${caller.issue}`;
  const running = runs.find(r => r.status !== 'completed' && (r.title === title || r.title.startsWith(`${title} (`)));
  if (running) return { action: 'skip', reason: `behind (${what}); run ${running.id} is not done yet`, behind };
  return { action: 'dispatch', reason: `behind (${what})`, behind };
}

function task({ caller, source, branch, head, behind, dispatchRepo }) {
  const lines = [
    `Move ${caller.repo}'s pins of ${source} to the head of its ${branch}, commit ${head}, and adapt to what changed. This run was started by the pin sync, .github/sync/manifest.json in ${dispatchRepo}.`,
    '',
    'Behind now:',
    ...behind.flatMap(b => b.pins.map(p => `- \`${b.file}\` pins \`${p}\`; changes since: https://github.com/${source}/compare/${p}...${head}`)),
    '',
    `Pin every reference to ${source} in those files at the full commit ${head}. Read what changed between each old pin and it, and adapt the calls to changed, added or removed inputs, secrets, outputs and permissions, and the comments that describe them. Change nothing else. If ${head} cannot be taken as it is, say why in the pull request description.`,
  ];
  return lines.join('\n');
}

// ---- GitHub I/O ----

const API = 'https://api.github.com';

async function request(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tracker-sync',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

async function readFiles(token, caller, source) {
  const files = {};
  for (const f of caller.files) {
    const got = await request(token, 'GET', `/repos/${caller.repo}/contents/${encodePath(f)}`);
    files[f] = got && { pins: findPins(Buffer.from(got.content, 'base64').toString('utf8'), source) };
  }
  return files;
}

// The first hundred open pull requests are enough for these repositories;
// only the bot's dispatch ones have their files read.
async function readPulls(token, caller, bot) {
  const open = await request(token, 'GET', `/repos/${caller.repo}/pulls?state=open&per_page=100`) ?? [];
  const pulls = [];
  for (const p of open.filter(p => p.user?.login === bot && p.head?.ref?.startsWith(BRANCH_PREFIX))) {
    const files = await request(token, 'GET', `/repos/${caller.repo}/pulls/${p.number}/files?per_page=100`) ?? [];
    pulls.push({ number: p.number, author: p.user.login, branch: p.head.ref, files: files.map(f => f.filename) });
  }
  return pulls;
}

async function main(argv, { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } = {}) {
  const unknown = argv.filter(a => a !== '--dry-run');
  if (unknown.length) throw new Error(`usage: sync.cjs [--dry-run] (unknown: ${unknown.join(' ')})`);
  const dryRun = argv.includes('--dry-run');
  const token = process.env.GH_TOKEN;
  const dispatchRepo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.DEFAULT_BRANCH;
  if (!token || !REPO_RE.test(dispatchRepo ?? '') || !ref) throw new Error('GH_TOKEN, GITHUB_REPOSITORY and DEFAULT_BRANCH must be set');
  const m = validateManifest(manifest);
  const log = line => console.log(dryRun ? `[dry-run] ${line}` : line);

  const head = (await request(token, 'GET', `/repos/${m.source}/commits/${encodeURIComponent(m.branch)}`))?.sha;
  if (!SHA_RE.test(head ?? '')) throw new Error(`no head for ${m.source} ${m.branch}`);
  log(`${m.source} ${m.branch} is at ${head}`);
  const workflow = `/repos/${dispatchRepo}/actions/workflows/${DISPATCH_WORKFLOW}`;
  const runs = ((await request(token, 'GET', `${workflow}/runs?per_page=100`))?.workflow_runs ?? [])
    .map(r => ({ id: r.id, status: r.status, title: r.display_title ?? '' }));

  let errors = 0;
  for (const caller of m.callers) {
    try {
      const [files, pulls] = [await readFiles(token, caller, m.source), await readPulls(token, caller, m.bot)];
      const { action, reason, behind } = decide({ caller, head, files, pulls, runs, bot: m.bot });
      let done = '';
      if (action === 'dispatch' && !dryRun) {
        const inputs = { task: task({ caller, source: m.source, branch: m.branch, head, behind, dispatchRepo }), repo: caller.repo, item: String(caller.issue), kind: 'implement' };
        await request(token, 'POST', `${workflow}/dispatches`, { ref, inputs });
        done = ' -> run started';
      }
      log(`${caller.repo} ${action}: ${reason}${done}`);
    } catch (err) {
      errors++;
      log(`${caller.repo} error: ${err.message}`);
    }
  }
  if (errors) throw new Error(`${errors} caller(s) could not be handled`);
}

module.exports = { MAX_CALLERS, decide, findPins, main, task, validateManifest };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`sync: ${err.message}`); process.exit(1); });
}
