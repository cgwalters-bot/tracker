#!/usr/bin/env node
// One pass of the board scheduler (cgwalters-forge/tracker#401): start new
// work from the board, which until now only the chat session did by hand.
// Each open issue whose Status is one of `schedule.ready` in agent-board.json
// gets at most one step: the job its newest accepted plan comment proposes
// (`agent-board dispatch --apply`, agent-board's docs/job-plans.md), or,
// with no plan, one triage run asked to write one. No step starts once
// `schedule.wip` dispatch.yml runs are in flight, counting those already
// going. A dry run, the default, only reads: `--apply` is passed by the
// workflow only where the repository variable says so.
// Standard library and the agent-board binary; `decide` and its helpers are
// pure and are what schedule.test.cjs covers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { CONFIG: POLL, paged, poolForKind, request } = require('./poll.cjs');

const CONFIG_FILE = path.join(__dirname, 'agent-board.json');
// How many of dispatch.yml's newest runs are read: enough to hold every run
// in flight, and the window in which an item is triaged at most once.
const HISTORY_RUNS = 100;
// One agent-board call, so that a hung one fails its item, not the job.
const AGENT_BOARD_TIMEOUT_MS = 2 * 60 * 1000;
// A run that has not completed holds its slot and its item.
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
// dispatch.yml's run-name: "KIND OWNER/REPO#ITEM", then the pool.
const RUN_TITLE_RE = /^(implement|triage|research|review|fix) ([\w.-]+\/[\w.-]+)#(\d+)(?: |$)/;
// The line agentic-job's apply ends a run's pull request with.
const REFS_RE = /^Refs ([\w.-]+\/[\w.-]+#\d+)\s*$/gm;
// What agent-board says, on the last line of stderr, of an issue without a
// writer's plan, and, on stderr of a dry run, of the plan it read.
const NO_PLAN = 'no plan on this issue';
const PLAN_FROM_RE = /request for the plan in (https:\/\/github\.com\/\S+#issuecomment-(\d+)) by /;
// The hidden first line of agent-board's record of a dispatch:
// `<!-- agent-board-dispatch: COMMENT-ID@TIME -->`.
const RECORD_RE = /^<!-- agent-board-dispatch: (\d+)@\S+ -->$/;
// agent-board's refusal of a plan it has a record of, which takes no step.
const RECORDED_RE = /has a dispatch record already/;
const PRIORITY = { P0: 0, P1: 1, P2: 2 };

// GitHub names are case-insensitive; the board, a plan and a run name may
// spell one differently.
const keyOf = (repo, number) => `${repo}#${number}`.toLowerCase();

// The `schedule` part of agent-board.json, with the logins and the caller
// the agent-board job already reads. Everything that names an account or a
// board is there, on the default branch, not here.
function loadConfig(text) {
  const all = JSON.parse(text);
  const s = all.schedule ?? {};
  const config = {
    owner: s.owner, project: s.project, ready: s.ready, wip: s.wip,
    operator: all.operator, planner: all.bot, caller: all.dispatchRepo, workflow: POLL.dispatchWorkflow,
    planDocs: `${all.source}/blob/${all.branch}/docs/job-plans.md`,
  };
  const login = /^[A-Za-z0-9-]+$/;
  if (!login.test(config.owner ?? '') || !Number.isSafeInteger(config.project) || config.project < 1) {
    throw new Error('agent-board.json: schedule.owner and schedule.project must name the board');
  }
  if (!Array.isArray(config.ready) || !config.ready.length || !config.ready.every(r => typeof r === 'string' && r)) {
    throw new Error('agent-board.json: schedule.ready must list at least one status');
  }
  if (!Number.isSafeInteger(config.wip) || config.wip < 0) throw new Error('agent-board.json: schedule.wip must be a count');
  if (!login.test(config.operator ?? '') || !login.test(config.planner ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(config.caller ?? '')) {
    throw new Error('agent-board.json: operator, bot and dispatchRepo are required');
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(all.source ?? '') || !/^[\w.\/-]+$/.test(all.branch ?? '')) {
    throw new Error('agent-board.json: source and branch must name agent-board');
  }
  return config;
}

// What dispatch.yml's recent runs say: how many hold a slot, which items
// have one in flight, and which have been triaged (whatever the triage
// run's outcome). Fix and review runs name a pull request, not an issue,
// but count against the cap all the same.
function readRuns(runs) {
  const busy = new Map();
  const triaged = new Map();
  let inFlight = 0;
  for (const run of runs) {
    const running = RUNNING.has(run.status);
    if (running) inFlight++;
    const m = RUN_TITLE_RE.exec(run.display_title ?? '');
    if (!m) continue;
    const key = keyOf(m[2], m[3]);
    if (running && !busy.has(key)) busy.set(key, run.html_url);
    if (m[1] === 'triage' && !triaged.has(key)) triaged.set(key, run.html_url);
  }
  return { inFlight, busy, triaged };
}

// The items the bot's open pull requests were made for, from the `Refs`
// line. Only the bot's: a visitor's pull request saying `Refs` must not be
// able to hold an item back.
function openPullRefs(pulls, bot) {
  const refs = new Map();
  for (const pull of pulls) {
    if (pull.user?.login?.toLowerCase() !== bot.toLowerCase()) continue;
    for (const m of (pull.body ?? '').matchAll(REFS_RE)) {
      const key = m[1].toLowerCase();
      if (!refs.has(key)) refs.set(key, pull.html_url);
    }
  }
  return refs;
}

// The plan a successful dry run read: the comment it is in and the item its
// run would work on, which need not be the board item (a tracker issue's
// plan may target the upstream repository it points to).
function readDryRun(stdout, stderr) {
  const inputs = JSON.parse(stdout).body.inputs;
  const from = PLAN_FROM_RE.exec(stderr);
  if (!from || !inputs?.repo || !inputs?.item) throw new Error('agent-board dry run named no plan comment or target');
  return { plan: from[1], commentId: from[2], target: keyOf(inputs.repo, inputs.item), kind: inputs.kind };
}

// agent-board's refusal: an issue with no plan, or why it will not
// dispatch the plan it has.
function readRefusal(stderr) {
  const reason = String(stderr).trim().split('\n').at(-1) || 'unknown';
  return reason.includes(NO_PLAN) ? { none: true } : { refused: reason.slice(0, 300) };
}

// A writer's record of the plan in comment `commentId`, as agent-board
// looks for one before it dispatches. agent-board's dry run does not look,
// so this is what keeps a plan dispatched already, by this job or by hand,
// out of the preview and its slot out of the count. agent-board names a
// plan by its comment and the time that was last written, which REST does
// not give; a record made before the comment last changed is of an earlier
// version, which a writer has edited to dispatch again. Should this ever
// disagree, `--apply` still refuses a recorded plan, which is then skipped.
function findRecord(comments, writers, commentId) {
  const trusted = new Set(writers.map(w => w.toLowerCase()));
  const plan = comments.find(c => String(c.id) === commentId);
  const changed = Date.parse(plan?.updated_at ?? '') || 0;
  for (const c of comments) {
    if (!trusted.has(c.user?.login?.toLowerCase())) continue;
    const m = RECORD_RE.exec((c.body ?? '').split('\n')[0].trimEnd());
    if (m?.[1] === commentId && !(Date.parse(c.created_at) < changed)) return c.html_url;
  }
  return undefined;
}

// Higher priority first, then as the board lists them.
const byPriority = items => [...items].sort((a, b) => (PRIORITY[a.priority] ?? 3) - (PRIORITY[b.priority] ?? 3));

// One step for each item. `probe(item)` says what agent-board would do with
// it: { plan, target, recorded? }, { none: true } or { refused: reason }.
// `pullFor(key)` names the bot's open pull request for an item, if any. A
// probe is made only while a slot is free, so a full pass reads no issue's
// comments; only a step that starts a run takes a slot. One item failing to
// be read is skipped with the reason, and the others go on.
async function decide(items, { inFlight, busy: running, triaged }, wip, probe, pullFor) {
  let free = wip - inFlight;
  const steps = [];
  // What this pass starts holds its items as a run in flight would, so two
  // plans with one target, or a plan's target that is a board item too,
  // get one run.
  const busy = new Map(running);
  const held = async key => {
    if (busy.has(key)) return `a run is in flight, ${busy.get(key)}`;
    const pull = await pullFor(key);
    return pull ? `a pull request is open, ${pull}` : null;
  };
  for (const item of byPriority(items)) {
    const name = `${item.repository}#${item.number}`;
    const skip = reason => steps.push({ item: name, action: 'skip', reason });
    const key = keyOf(item.repository, item.number);
    if (item.content_kind !== 'issue') { skip('not an issue'); continue; }
    let holding;
    let found;
    try {
      holding = await held(key);
      if (holding) { skip(holding); continue; }
      if (free <= 0) { skip(`work-in-progress cap of ${wip} reached`); continue; }
      found = await probe(item);
      if (found.plan && !found.recorded) holding = await held(found.target);
    } catch (err) {
      skip(`could not be read: ${err.message.slice(0, 300)}`);
      continue;
    }
    if (found.plan) {
      if (found.recorded) { skip(`plan ${found.plan} was dispatched already, ${found.recorded}`); continue; }
      if (holding) { skip(`its plan's ${found.target}: ${holding}`); continue; }
      // A triage or research plan, which a triage run could write, would start
      // a run that writes another plan: such chains are a person's to start.
      if (found.kind !== 'implement') { skip(`plan ${found.plan} is for ${found.kind}, which is dispatched by hand`); continue; }
      steps.push({ item: name, action: 'dispatch', reason: `plan ${found.plan}` });
      busy.set(found.target, 'started in this pass');
    } else if (found.none) {
      // Once per item in the window: a triage run that wrote no plan, or one
      // agent-board refuses, is for a person to look at, not to repeat on
      // every pass.
      const before = triaged.get(key);
      if (before) { skip(`triaged already with no plan, ${before}`); continue; }
      steps.push({ item: name, action: 'triage', reason: 'no plan' });
    } else {
      skip(`plan refused: ${found.refused}`);
      continue;
    }
    busy.set(key, 'started in this pass');
    free--;
  }
  return steps;
}

// What the triage run is asked for after profiles/triage.md: its comment is
// posted as the bot, which agent-board counts as the planner, so the plan
// in it is what the next pass dispatches, within dispatch.toml's bounds.
function triageTask(key, url, planDocs) {
  return [
    `Triage ${url} (${key}) so that it can be scheduled.`,
    `If it is ready to implement, end your comment with a job plan for the one implement run that would resolve it, in the format of ${planDocs}: a fenced block, info string \`agent-board-plan\`, holding one JSON object with exactly the fields schema ("agent-board/job-plan/v1"), repo, item, kind ("implement"), runner ("hosted"), an optional pool, and brief (the task for that run, at most 16,000 characters). Its repo and item are this issue's, or those of the upstream issue it is a pointer to. Write one plan at most, and none if the issue is not ready; then say what it needs instead.`,
  ].join('\n\n');
}

// ---- I/O ----

function agentBoard(bin, args, env) {
  return execFileSync(bin, args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: AGENT_BOARD_TIMEOUT_MS });
}

function dispatchArgs(config) {
  return ['--caller', config.caller, '--workflow', config.workflow,
    '--operator', config.operator, '--planner', config.planner];
}

// agent-board's dry run reads the plan and prints the request it would
// send; the line naming the plan's comment is on stderr.
async function probePlan(bin, config, token, item) {
  const run = spawnSync(bin, ['dispatch', item.url, '--dry-run', ...dispatchArgs(config)],
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, timeout: AGENT_BOARD_TIMEOUT_MS });
  if (run.error) throw run.error;
  if (run.status !== 0) return readRefusal(run.stderr);
  const found = readDryRun(run.stdout, run.stderr);
  const comments = await paged(token, `/repos/${item.repository}/issues/${item.number}/comments`);
  return { ...found, recorded: findRecord(comments, [config.operator, config.planner], found.commentId) };
}

async function main(argv) {
  const unknown = argv.filter(a => a !== '--apply');
  if (unknown.length) throw new Error(`usage: schedule.cjs [--apply] (unknown: ${unknown.join(' ')})`);
  const apply = argv.includes('--apply');
  const token = process.env.GH_TOKEN;
  const bin = process.env.AGENT_BOARD;
  if (!token || !bin) throw new Error('GH_TOKEN (the planner\'s token) and AGENT_BOARD (the binary) are required');
  const dispatchToken = process.env.DISPATCH_TOKEN || token;
  const config = loadConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const log = line => console.log(apply ? line : `[dry-run] ${line}`);

  const items = [];
  for (const status of config.ready) {
    const out = agentBoard(bin, ['--owner', config.owner, '--project', String(config.project), 'item', 'list',
      '--status', status, '--state', 'open', '-L', '1000', '--json', 'repository,number,content_kind,url,priority']);
    items.push(...JSON.parse(out));
  }
  const runs = (await request(dispatchToken, 'GET',
    `/repos/${config.caller}/actions/workflows/${config.workflow}/runs?per_page=${HISTORY_RUNS}`)).workflow_runs;
  const state = readRuns(runs);
  // The bot's open pull requests, listed once per repository asked about.
  const listed = new Map();
  const pullFor = async key => {
    const repo = key.split('#')[0];
    if (!listed.has(repo)) listed.set(repo, openPullRefs(await paged(token, `/repos/${repo}/pulls?state=open`), config.planner));
    return listed.get(repo).get(key);
  };
  log(`${items.length} ready item(s); ${state.inFlight} of ${config.wip} run(s) in flight`);

  const byName = new Map(items.map(i => [`${i.repository}#${i.number}`, i]));
  let errors = 0;
  const steps = await decide(items, state, config.wip, item => probePlan(bin, config, token, item), pullFor);
  for (const step of steps) {
    const item = byName.get(step.item);
    if (step.action === 'skip' || !apply) {
      log(`${step.item} ${step.action}: ${step.reason}`);
      continue;
    }
    try {
      if (step.action === 'dispatch') {
        // agent-board records the plan on the issue before it sends, and
        // refuses one recorded already, so a plan starts one run however
        // many passes see it.
        const out = agentBoard(bin, ['dispatch', item.url, '--apply', ...dispatchArgs(config)],
          { GH_TOKEN: token, DISPATCH_TOKEN: dispatchToken });
        log(`${step.item} dispatch: ${step.reason}; ${out.trim().split('\n').join(', ')}`);
      } else {
        // The run's details, as poll.cjs asks for them, so that the run is
        // named here; where the API does not know them, asked again without.
        const path = `/repos/${config.caller}/actions/workflows/${config.workflow}/dispatches`;
        const body = {
          ref: 'main',
          inputs: { kind: 'triage', repo: item.repository, item: String(item.number),
            task: triageTask(step.item, item.url, config.planDocs), pool: poolForKind('triage') },
        };
        const run = await request(dispatchToken, 'POST', path, { ...body, return_run_details: true })
          .catch(err => {
            if (!/HTTP 422/.test(err.message)) throw err;
            return request(dispatchToken, 'POST', path, body);
          });
        log(`${step.item} triage: started ${run?.html_url ?? ''}`.trimEnd());
      }
    } catch (err) {
      const reason = String(err.stderr || err.message).trim().split('\n').at(-1);
      if (RECORDED_RE.test(reason)) { log(`${step.item} skip: ${reason}`); continue; }
      errors++;
      log(`${step.item} ${step.action} error: ${reason}`);
    }
  }
  if (errors) throw new Error(`${errors} step(s) failed`);
}

module.exports = { decide, findRecord, loadConfig, openPullRefs, readDryRun, readRefusal, readRuns, triageTask };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`schedule: ${err.message}`); process.exit(1); });
}
