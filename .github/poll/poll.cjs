// The single actor is agent-board. This adapter selects its mode and keeps the
// workflow's summary and successor output; shared GitHub helpers remain here
// for the scheduler, census and coordinator.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const settings = require('./agent-board.json');
const { readDecisions } = require('./decisions.cjs');
const { heldBy } = require('./broker.cjs');

const CONFIG = Object.freeze({
  author: settings.bot,
  repos: settings.follow,
  dispatchRepo: settings.dispatchRepo,
  dispatchWorkflow: settings.dispatchWorkflow,
  kindPools: settings.kindPools ?? {},
});

const poolForKind = kind => Object.hasOwn(CONFIG.kindPools, kind) ? CONFIG.kindPools[kind] : '';

// fetch never times out by itself: a connection GitHub accepts and never
// answers would hold the pass until the step's timeout-minutes kills it, past
// every caller's handling of a failed request (#819). GitHub answers these
// calls in well under this; the signal covers reading the body too.
const REQUEST_TIMEOUT_MS = 30e3;

async function request(token, method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  let res, text;
  try {
    res = await fetch('https://api.github.com' + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tracker-poll',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`${method} ${path}: ${err.cause?.message || err.message}`);
  }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function paged(token, path) {
  const all = [];
  for (let page = 1; ; page++) {
    const items = await request(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

async function poll(argv, env = process.env, run = spawnSync, api = request) {
  if (argv.some(a => a !== '--apply' && a !== '--dry-run') || argv.length > 1) {
    throw new Error('usage: poll.cjs [--dry-run | --apply]');
  }
  let mode = argv[0] ?? '--dry-run';
  if (!env.AGENT_BOARD || !env.POLL_STATE) throw new Error('AGENT_BOARD and POLL_STATE are required');
  let state = env.POLL_STATE;
  let notes = '';
  let held = null;
  if (mode === '--apply') {
    // While the broker is out every fix run it starts fails and spends a
    // round (#603), so a held pass only previews, merges included. Its
    // preview runs on a copy, so the saved apply state is not advanced.
    try {
      held = await heldBy({ token: env.GH_TOKEN, repo: env.GITHUB_REPOSITORY, login: CONFIG.author, api,
        log: line => { notes += `${line}\n`; } });
    } catch (err) {
      return { stdout: notes, stderr: `poll: outage issue not readable: ${err.message}\n`, again: true, status: 1 };
    }
    if (held) {
      notes += `held: broker outage ${held.url}; this pass previews only\n`;
      mode = '--dry-run';
      state = path.join(fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'poll-held-')), 'poll-state.json');
      if (fs.existsSync(env.POLL_STATE)) fs.copyFileSync(env.POLL_STATE, state);
    }
  }
  // A hung child or oversized PR-derived output must not exhaust the runner
  // or prevent it from scheduling the next pass.
  const result = run(env.AGENT_BOARD, [
    'poll', mode, '--config', '.github/poll/agent-board.json', '--state', state,
  ], { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = notes + (result.stdout ?? '');
  const stderr = result.stderr ?? '';
  const due = [...stdout.matchAll(/^next-due-seconds=(\d+)$/gm)].at(-1)?.[1];
  // Titles and bodies are untrusted. Only the final, bounded numeric interval
  // is consumed, never an arbitrary output line or a command from the child.
  const valid = due !== undefined && Number(due) >= 300 && Number(due) <= 21600;
  const failed = Boolean(result.error || result.status !== 0 || !valid);
  // A held pass does not restart the chain: the schedule brings the next.
  const again = !held && (failed || Number(due) === 300);
  return { stdout, stderr, again, status: failed ? 1 : 0 };
}

async function main(argv) {
  const result = await poll(argv);
  const decisions = readDecisions(process.env, settings);
  const decisionLine = `decisions/v1 ${JSON.stringify(decisions)}\n`;
  result.stdout += decisionLine;
  if (decisions.status === 'failed') { result.status = 1; result.again = true; }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status) console.error('poll: agent-board failed or did not return a valid interval');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `in-flight=${result.again}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### agent-board poll\n<pre>${escape(result.stdout + result.stderr)}</pre>\n`);
  }
  process.exitCode = result.status;
}

module.exports = { CONFIG, paged, poolForKind, request, poll };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`poll: ${err.message}`); process.exitCode = 1; });
}
