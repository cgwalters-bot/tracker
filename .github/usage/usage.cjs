#!/usr/bin/env node
// Publish the usage snapshot (bot-usage/v1) that the review app's pool meters
// read, from the inference broker's /usage, to the one comment by the bot on
// the issue config.json names (cgwalters-forge/tracker#558). It replaces
// homegit's `bin/bot-heartbeat publish`, whose pools and mistral it keeps in
// the same shape; the per-machine parts of that snapshot (the status line's
// windows, transcript tokens, workers) have no source here and are empty.
// Standard library only; everything but main is pure and is what
// usage.test.cjs covers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = path.join(__dirname, 'config.json');
// The pools dispatch.yml runs on; Mistral's model and allowance are there.
const POOLS_FILE = path.join(__dirname, '..', 'agentic-job', 'pools.json');

const MARKER = '<!-- bot-usage v1 -->';
const SCHEMA = 'bot-usage/v1';
const BROKER_SCHEMA = 'praxis-broker-usage/v1';
const MINUTE_MS = 60e3;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The broker's Anthropic windows, by its names for them.
const CLAUDE_WINDOWS = { unified_5h: 5 * HOUR_MS, unified_7d: 7 * DAY_MS };
const CODEX_WINDOWS = ['primary', 'secondary'];
// Only a window this long is paced evenly; a shorter one (five hours) is
// spent in bursts and holds work only once used up (homegit's lib/pools.js).
const MIN_PACED_WINDOW_MS = DAY_MS;
// Bounds on what is read and written: the broker answers in well under a
// kilobyte, and GitHub takes comments of up to 65536 characters.
const BROKER_TIMEOUT_MS = 10e3;
const MAX_BROKER_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 32 * 1024;
// The review app reads the first page of the issue's comments, this long.
const COMMENT_PAGE = 100;
const FRESH_MS = 10 * MINUTE_MS;

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const iso = ms => new Date(ms).toISOString();

// checkConfig(c): c, or an error naming what is wrong with it.
function checkConfig(c) {
  const bad = what => { throw new Error(`${path.basename(CONFIG_FILE)}: ${what}`); };
  if (!isObject(c)) bad('not an object');
  if (typeof c.repo !== 'string' || !REPO_RE.test(c.repo)) bad('repo must be OWNER/NAME');
  if (!Number.isSafeInteger(c.issue) || c.issue < 1) bad('issue must be a positive integer');
  if (typeof c.bot !== 'string' || !LOGIN_RE.test(c.bot)) bad('bot must be a GitHub login');
  for (const name of ['claude', 'openai']) {
    const p = c.pacing?.[name];
    if (!isObject(p) || !finite(p.target) || p.target <= 0 || p.target > 1 || !finite(p.burst) || p.burst < 0) {
      bad(`pacing.${name} must be {target in (0, 1], burst >= 0}`);
    }
  }
  return c;
}

// ---- Readings: the broker's answer as pool readings ----

// claudeReading(broker): the Anthropic windows the broker last saw in a
// response's headers (utilization a fraction, times in epoch seconds), as a
// reading for poolPace, or null.
function claudeReading(broker) {
  const a = isObject(broker?.anthropic) ? broker.anthropic : {};
  const windows = Object.entries(CLAUDE_WINDOWS).flatMap(([name, ms]) => {
    const w = a[name];
    if (!isObject(w) || ![w.utilization, w.reset, w.observed_at].every(finite)) return [];
    return [{ used_percent: w.utilization * 100, window_ms: ms, resets_at: w.reset * 1e3, observed_at: w.observed_at * 1e3 }];
  });
  return windows.length ? { source: 'praxis', observed_at: Math.max(...windows.map(w => w.observed_at)), windows } : null;
}

// openaiReading(broker): the Codex windows, as bot-capacity reads them.
function openaiReading(broker) {
  const c = isObject(broker?.codex) ? broker.codex : {};
  const windows = CODEX_WINDOWS.flatMap(name => {
    const w = c[name];
    if (!isObject(w) || ![w.used_percent, w.window_minutes, w.reset_after_seconds, w.observed_at].every(finite) || w.window_minutes <= 0) return [];
    return [{ used_percent: w.used_percent, window_ms: w.window_minutes * MINUTE_MS, resets_at: (w.observed_at + w.reset_after_seconds) * 1e3, observed_at: w.observed_at * 1e3 }];
  });
  return windows.length ? { source: 'praxis', observed_at: Math.max(...windows.map(w => w.observed_at)), windows } : null;
}

// poolPace(reading, {target, burst}, now): homegit's poolPace, so the
// published pools keep their shape: the longest window's usage against an
// even pace toward target of it at the reset, plus burst points; a hold when
// above that or the target, or while a shorter window is used up. Null
// without a reading of a window of a day or more that has yet to reset.
function poolPace(reading, { target, burst }, now) {
  const windows = (reading?.windows || []).filter(w => w.window_ms > 0 && finite(w.resets_at) && finite(w.used_percent));
  if (!windows.length) return null;
  const paced = windows.reduce((a, b) => (b.window_ms > a.window_ms ? b : a));
  if (paced.window_ms < MIN_PACED_WINDOW_MS || !(paced.resets_at > now)) return null;
  const start = paced.resets_at - paced.window_ms;
  const elapsed = Math.min(Math.max(now - start, 0), paced.window_ms);
  const goal = target * 100;
  const allowed = (goal * elapsed) / paced.window_ms;
  let hold = paced.used_percent > Math.min(allowed + burst, goal);
  let reason = hold ? 'pace' : null;
  let next = hold ? (paced.used_percent > goal ? paced.resets_at : start + ((paced.used_percent - burst) / goal) * paced.window_ms) : null;
  const spent = windows.filter(w => w !== paced && w.resets_at > now && w.used_percent >= 100);
  if (spent.length) {
    hold = true;
    reason = reason || 'window';
    next = Math.max(next || 0, ...spent.map(w => w.resets_at));
  }
  return {
    // A recent short-window header must not make the weekly number look fresh.
    source: reading.source, observed_at: iso(finite(paced.observed_at) ? paced.observed_at : reading.observed_at),
    computed_at: iso(now),
    used_percent: paced.used_percent, window_minutes: paced.window_ms / MINUTE_MS, resets_at: iso(paced.resets_at),
    target_percent: goal, burst, allowed_percent: allowed, ahead: paced.used_percent - allowed,
    hold, reason, next_dispatch_at: next === null ? null : iso(next),
  };
}

// mistralAllowance(pool, broker, now): the meter of review's parseAllowance
// (cgwalters-forge/review#57, #58) from pools.json's mistral entry: the
// allowance in US dollars and when it resets, and, where a spend can be
// estimated, this month's tokens by model with the configured prices (USD
// per million tokens, allowance.prices, {MODEL: {input, output}}). Mistral
// has no spend figure for us (its Admin API is Enterprise-only). The broker
// counts from its start, by provider only, so the tokens are this month's
// only when it started this month (since its start, if that was after the
// first, so the estimate is low by what went before), and are all the
// pool's one model's;
// otherwise no models go out and the review app shows the counters. Mistral
// resets the allowance on the first of each calendar month, in a time zone
// it does not name: UTC is assumed. Null without a usable allowance.
function mistralAllowance(pool, broker, now) {
  const a = pool?.allowance;
  if (!isObject(a) || !finite(a.amount) || a.amount <= 0 || a.currency !== 'USD' || a.period !== 'calendar-month') return null;
  const d = new Date(now);
  const out = { limit_usd: a.amount, resets_at: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
  const t = broker?.mistral?.counts?.tokens;
  const thisMonth = finite(broker?.started_at) && broker.started_at * 1e3 >= Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (isObject(a.prices) && typeof pool.model === 'string' && thisMonth && isObject(t) && [t.input, t.cache_read, t.output].every(finite)) {
    // input is the uncached part and cache reads are counted apart; both
    // are charged here at the input price, so the estimate errs high.
    out.models = [{ model: pool.model, input_tokens: t.input + t.cache_read, output_tokens: t.output }];
    out.prices = a.prices;
  }
  return out;
}

// mistralUsage(broker, pool, now): the broker's Mistral counters, which have
// no window and so no pace, as homegit published them, with since when they
// count and the allowance (mistralAllowance). Null when the broker serves no
// Mistral.
function mistralUsage(broker, pool, now) {
  const counts = broker?.mistral?.counts;
  if (!isObject(counts) || !isObject(counts.tokens)) return null;
  // Every successful response, as homegit counted them: unmetered ones (no
  // usage in the answer) have no tokens in tokens.
  const requests = (counts.requests || 0) + (counts.unmetered || 0);
  if (![requests, counts.tokens.total].every(finite)) return null;
  const out = { requests, tokens: counts.tokens.total, observed_at: iso(now) };
  if (finite(broker.started_at)) out.since = iso(broker.started_at * 1e3);
  const allowance = mistralAllowance(pool, broker, now);
  if (allowance) out.allowance = allowance;
  return out;
}

// snapshot(broker, config, mistralPool, now): the bot-usage/v1 object. windows
// and workers are homegit's per-machine parts, kept (empty) for readers that
// require them; the review app shows the pools when there are no windows.
function snapshot(broker, config, mistralPool, now) {
  if (!isObject(broker) || broker.schema !== BROKER_SCHEMA) throw new Error(`the broker's answer is not ${BROKER_SCHEMA}`);
  const mistral = mistralUsage(broker, mistralPool, now);
  return {
    schema: SCHEMA,
    updated_at: iso(now),
    windows: [],
    workers: [],
    pools: {
      claude: poolPace(claudeReading(broker), config.pacing.claude, now),
      openai: poolPace(openaiReading(broker), config.pacing.openai, now),
    },
    ...(mistral ? { mistral } : {}),
  };
}

// ---- The comment ----

const pct = n => `${Math.round(n)}%`;

function describe(name, p) {
  if (!p) return `${name}: no reading (unpaced)`;
  const hold = p.hold ? `; holds new work until ${p.next_dispatch_at} (${p.reason})` : '';
  return `${name}: ${pct(p.used_percent)} used, pace allows ${pct(p.allowed_percent)}, resets ${p.resets_at}, read ${p.observed_at}${hold}`;
}

// render(snap, workflow): the comment's body: the marker, a line per pool,
// then the JSON the review app reads.
function render(snap, workflow) {
  const lines = [MARKER, `Usage as of ${snap.updated_at}, from the inference broker's \`/usage\`. Written by ${workflow}; the review app's ops view reads the JSON below.`, ''];
  for (const [name, p] of Object.entries(snap.pools)) lines.push(`- ${describe(name, p)}`);
  const m = snap.mistral;
  if (m) {
    const a = m.allowance ? `; allowance $${m.allowance.limit_usd}, resets ${m.allowance.resets_at}${m.allowance.prices ? ', spend estimated from prices' : ''}` : '';
    lines.push(`- mistral: ${m.requests} requests, ${m.tokens} tokens since ${m.since ?? 'the broker started'} (unpaced)${a}`);
  }
  lines.push('', '```json', JSON.stringify(snap, null, 2), '```', '');
  const body = lines.join('\n');
  if (body.length > MAX_BODY_CHARS) throw new Error(`the comment would be ${body.length} characters; at most ${MAX_BODY_CHARS}`);
  return body;
}

// findComment(comments, bot): the bot's usage comment, if any. Only the
// bot's: anyone who can comment on the issue could post the marker.
function findComment(comments, bot) {
  return comments.find(c => c.user?.login === bot && typeof c.body === 'string' && c.body.startsWith(MARKER)) || null;
}

// previousSnapshot(body): the JSON of the comment last written, or null.
function previousSnapshot(body) {
  const m = /^```json\n([\s\S]*?)\n```$/m.exec(body || '');
  try {
    const snap = m && JSON.parse(m[1]);
    return isObject(snap) && snap.schema === SCHEMA ? snap : null;
  } catch {
    return null;
  }
}

// Only skip a join when every configured paced pool has a recent observation.
// A newer envelope (or short-window header) cannot freshen a weekly reading.
async function needsPublish({ config, request, now }) {
  const comments = await request('GET', `/repos/${config.repo}/issues/${config.issue}/comments?per_page=${COMMENT_PAGE}`);
  const previous = previousSnapshot(findComment(comments, config.bot)?.body);
  return !Object.keys(config.pacing).every(name => {
    const observed = previous?.pools?.[name]?.observed_at;
    const age = now - (typeof observed === 'string' ? Date.parse(observed) : NaN);
    return Number.isFinite(age) && age >= 0 && age < FRESH_MS;
  });
}

// carryPools(snap, previous, config, now): snap, with each pool it has no
// reading of taken from the previous snapshot, paced again, while that
// one's window has yet to reset. The broker keeps its readings in memory
// and has none after a restart until a run goes through it; a reading from
// before is still a lower bound of the window's usage, and its observed_at
// says how old it is. Only the paced window is carried, so a hold for a
// spent shorter window is not.
function carryPools(snap, previous, config, now) {
  const pools = { ...snap.pools };
  for (const name of Object.keys(pools)) {
    const p = previous?.pools?.[name];
    if (pools[name] || !isObject(p) || ![p.used_percent, p.window_minutes].every(finite)) continue;
    const reading = {
      source: p.source,
      observed_at: Date.parse(p.observed_at),
      windows: [{ used_percent: p.used_percent, window_ms: p.window_minutes * MINUTE_MS, resets_at: Date.parse(p.resets_at) }],
    };
    pools[name] = poolPace(reading, config.pacing[name], now);
  }
  return { ...snap, pools };
}

// publish({config, snap, render, request, log}): write the snapshot to the
// bot's comment on config's issue. request(method, path, body) is the
// GitHub API with the bot's token; render(snap) the comment's body.
async function publish({ config, snap, render, request, log }) {
  const where = `${config.repo}#${config.issue}`;
  // The snapshot is private (what the subscriptions are used for, and when):
  // a config pointing at a public repository must not publish it.
  if ((await request('GET', `/repos/${config.repo}`)).private !== true) throw new Error(`${config.repo} is not private; not writing the usage snapshot there`);
  // The first page only, as the review app reads it: a comment past it would
  // be written and never shown. The issue is locked, so the bot's comes
  // early; with a full page and none of the bot's, no second one is added.
  const comments = await request('GET', `/repos/${config.repo}/issues/${config.issue}/comments?per_page=${COMMENT_PAGE}`);
  const existing = findComment(comments, config.bot);
  if (!existing && comments.length >= COMMENT_PAGE) throw new Error(`no usage comment of ${config.bot} among the first ${COMMENT_PAGE} on ${where}, where the review app reads it`);
  // Written even with neither pool: a pool is only null here once the last
  // published window has reset, and leaving the comment would keep that
  // window's hold and hide fresh Mistral counters.
  const carried = carryPools(snap, previousSnapshot(existing?.body), config, Date.parse(snap.updated_at));
  const body = render(carried);
  if (existing) {
    await request('PATCH', `/repos/${config.repo}/issues/comments/${existing.id}`, { body });
    log(`updated ${existing.html_url}`);
    return;
  }
  // The lookup finds only the bot's comment: under another login, every run
  // would add one more.
  const login = (await request('GET', '/user')).login;
  if (login !== config.bot) throw new Error(`the token is ${login}'s, not ${config.bot}'s; not creating a comment on ${where} it would never find again`);
  log(`created ${(await request('POST', `/repos/${config.repo}/issues/${config.issue}/comments`, { body })).html_url}`);
}

// ---- I/O ----

const API = 'https://api.github.com';

async function request(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'tracker-usage',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// readBroker(base): the answer of /usage at the root of the broker whose
// API is at base (INFERENCE_URL, whose own path is /v1 or none).
async function readBroker(base) {
  const url = new URL('/usage', base);
  const res = await fetch(url, { signal: AbortSignal.timeout(BROKER_TIMEOUT_MS) })
    .catch(err => { throw new Error(`GET ${url}: ${err.cause?.message || err.message}`); });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BROKER_BYTES) throw new Error(`GET ${url}: answer over ${MAX_BROKER_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw new Error(`GET ${url}: not JSON: ${err.message}`);
  }
}

async function main(argv) {
  const unknown = argv.filter(a => !['--dry-run', '--check-freshness'].includes(a));
  if (unknown.length) throw new Error(`usage: usage.cjs [--dry-run | --check-freshness] (unknown: ${unknown.join(' ')})`);
  const dryRun = argv.includes('--dry-run');
  if (dryRun && argv.includes('--check-freshness')) throw new Error('--dry-run and --check-freshness are mutually exclusive');
  const config = checkConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  if (argv.includes('--check-freshness')) {
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error(`GH_TOKEN must hold ${config.bot}'s token`);
    const publish = await needsPublish({ config, request: (...args) => request(token, ...args), now: Date.now() });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
    return;
  }
  const mistralPool = JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8')).mistral;
  const base = process.env.INFERENCE_URL;
  if (!base) throw new Error('INFERENCE_URL must name the inference broker');
  // An unreadable broker fails the run and leaves the last snapshot in place,
  // whose updated_at then says how old it is.
  const snap = snapshot(await readBroker(base), config, mistralPool, Date.now());
  const workflow = process.env.GITHUB_REPOSITORY ? `\`${process.env.GITHUB_WORKFLOW || 'usage'}\` in ${process.env.GITHUB_REPOSITORY}` : '`usage.cjs`';
  // A dry run reads nothing from GitHub, so it carries no pool over.
  if (dryRun) {
    process.stdout.write(render(snap, workflow));
    return;
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error(`GH_TOKEN must hold ${config.bot}'s token`);
  await publish({ config, snap, render: s => render(s, workflow), request: (...args) => request(token, ...args), log: console.log });
}

module.exports = { MARKER, carryPools, checkConfig, claudeReading, findComment, mistralAllowance, mistralUsage, needsPublish, openaiReading, poolPace, previousSnapshot, publish, readBroker, render, snapshot };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`usage: ${err.message}`); process.exit(1); });
}
