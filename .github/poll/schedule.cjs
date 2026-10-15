#!/usr/bin/env node
// One pass of the board scheduler (cgwalters-forge/tracker#401): start new
// work on the operator's epics, which until now only the chat session did by
// hand. The candidates are the open sub-issues of the live epics, as the
// epic census (epics.cjs) finds them: an epic is live only if the operator
// applied its `epic` label, so no epic the bot or a visitor labels starts a
// run. Who added a sub-issue to a live epic is not checked: anyone who may
// edit the epic's sub-issues can make an item a candidate, as anyone who
// could move a board item's Status could before. Each candidate in one of
// `schedule.repositories` of agent-board.json gets at most one step: the
// job its newest accepted plan comment proposes (`agent-board dispatch
// --apply`, agent-board's docs/job-plans.md), or, with no plan, one triage run asked to write one. Candidates are taken by
// their epic's `schedule.priorityField` on the board, then their own, P0
// first, then oldest first. No step starts once `schedule.wip` dispatch.yml
// runs are in flight, counting those already going, and no more than
// `schedule.triagePerPass` triage runs start in one pass. A dry run, the
// default, only reads: `--apply` is passed by the workflow only where the
// repository variable says so.
// Standard library and the agent-board binary; `decide` and its helpers are
// pure and are what schedule.test.cjs covers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG: POLL, paged, poolForKind, request } = require('./poll.cjs');

const CONFIG_FILE = path.join(__dirname, 'agent-board.json');
// How many of dispatch.yml's newest runs are read: enough to hold every run
// in flight, and the window in which an item is triaged at most once.
const HISTORY_RUNS = 100;
// One agent-board call, unless `schedule.timeoutSeconds` says otherwise, so
// that a hung one fails its item, not the job. A dry run reads one issue's
// comments; nothing it does should take minutes.
const AGENT_BOARD_TIMEOUT_S = 120;
// Items read in one pass after the triage cap is reached that turn out to
// have no plan. A slot is only taken by a run started, so past the cap
// every item without a plan would otherwise be read in turn, only to be
// skipped, each an agent-board call of up to `timeoutSeconds` and a read of
// its comments: a board of a hundred such items would outlast the job and
// the token's budget. Reads that end otherwise (triaged already, recorded,
// refused) are not counted, so items stuck in those states cannot use the
// limit up; each pass triages the first fresh item, so the next pass reads
// one further down.
const PAST_CAP_READS = 10;
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
    owner: s.owner, project: s.project, wip: s.wip,
    priorityField: s.priorityField ?? 'Priority', triagePerPass: s.triagePerPass ?? 1,
    operator: all.operator, planner: all.bot, caller: all.dispatchRepo, workflow: POLL.dispatchWorkflow,
    planDocs: `${all.source}/blob/${all.branch}/docs/job-plans.md`,
  };
  const login = /^[A-Za-z0-9-]+$/;
  if (!login.test(config.owner ?? '') || !Number.isSafeInteger(config.project) || config.project < 1) {
    throw new Error('agent-board.json: schedule.owner and schedule.project must name the board');
  }
  if (!Number.isSafeInteger(config.wip) || config.wip < 0) throw new Error('agent-board.json: schedule.wip must be a count');
  // The repositories whose items are scheduled, by exact name. There is no
  // default and no wildcard: an upstream project's issue on the board is
  // there to be tracked, and work on it is the operator's to start, on a
  // devspace, not this job's. A repository missing here is only not
  // scheduled; one listed here still has to be in dispatch.toml's bounds.
  const repos = s.repositories;
  if (!Array.isArray(repos) || !repos.every(r => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r))) {
    throw new Error('agent-board.json: schedule.repositories must list OWNER/REPO names');
  }
  config.followed = new Set(repos.map(r => r.toLowerCase()));
  if (typeof config.priorityField !== 'string' || !/^[\w .-]{1,100}$/.test(config.priorityField)) {
    throw new Error('agent-board.json: schedule.priorityField must name a board field');
  }
  // Every item the scheduler has not seen before is without a plan, so the
  // first pass with --apply would otherwise triage up to `wip` of them at
  // once, and as many again each pass as slots free up.
  if (!Number.isSafeInteger(config.triagePerPass) || config.triagePerPass < 0 || config.triagePerPass > 10) {
    throw new Error('agent-board.json: schedule.triagePerPass must be 0 to 10');
  }
  // A bound on one call; the job's timeout-minutes is the pass's.
  const t = s.timeoutSeconds ?? AGENT_BOARD_TIMEOUT_S;
  if (!Number.isSafeInteger(t) || t < 1 || t > 600) throw new Error('agent-board.json: schedule.timeoutSeconds must be 1 to 600');
  config.timeoutMs = t * 1000;
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

// The order items are taken in, for the summary.
const order = field => `by their epic's ${field}, then their own (P0 first, unset last), then oldest first`;
// P0, P1, ... by the number; any other value, or none, after them all.
const rank = p => { const m = /^P(\d{1,3})$/.exec(p ?? ''); return m ? Number(m[1]) : Infinity; };
const age = item => Date.parse(item.created ?? '') || Infinity; // Two unknowns tie: Infinity - Infinity is NaN, hence `|| 0` below.
const ahead = (a, b) => (rank(a.epicPriority) - rank(b.epicPriority) || 0) || (rank(a.priority) - rank(b.priority) || 0) || (age(a) - age(b) || 0);
const byPriority = items => [...items].sort(ahead);

// The candidates of a census (epics.cjs's `census`): the open sub-issues of
// the live epics read in full, each once, from the epic that ranks it first,
// whose name it carries for the summary. `live` counts those epics; an epic
// that could not be read gives none, and is said on its census line.
function candidates(entries, repository) {
  // An entry is live once its label is read, and may fail after.
  const live = entries.filter(e => e.live && !e.error);
  const byKey = new Map();
  for (const epic of live) {
    for (const s of epic.subs) {
      if (s.state !== 'open') continue;
      const item = {
        repository: s.repository, number: s.number, content_kind: 'issue', url: s.url, priority: s.priority,
        created: s.created, epic: `${repository}#${epic.number}`, epicPriority: epic.priority,
      };
      const key = keyOf(s.repository, s.number);
      if (!byKey.has(key) || ahead(item, byKey.get(key)) < 0) byKey.set(key, item);
    }
  }
  return { items: [...byKey.values()], live: live.length, unread: entries.filter(e => e.error).length };
}

// One step for each item. `probe(item)` says what agent-board would do with
// it: { plan, target, recorded? }, { none: true } or { refused: reason }.
// `pullFor(key)` names the bot's open pull request for an item, if any. A
// probe is made only while a slot is free, so a full pass reads no issue's
// comments; only a step that starts a run takes a slot. One item failing to
// be read is skipped with the reason, and the others go on. `limits` is
// the config's `wip`, `triagePerPass` and `followed`.
async function decide(items, { inFlight, busy: running, triaged }, { wip, triagePerPass, followed }, probe, pullFor) {
  let free = wip - inFlight;
  let pastCap = 0;
  let triages = triagePerPass;
  const isFollowed = key => followed.has(key.split('#')[0]);
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
    if (!isFollowed(key)) { skip('not a followed repository'); continue; }
    if (item.content_kind !== 'issue') { skip('not an issue'); continue; }
    let holding;
    let found;
    try {
      holding = await held(key);
      if (holding) { skip(holding); continue; }
      if (free <= 0) { skip(`work-in-progress cap of ${wip} reached`); continue; }
      if (triages <= 0 && pastCap >= PAST_CAP_READS) { skip(`limit of ${PAST_CAP_READS} items read past the triage cap reached`); continue; }
      found = await probe(item);
      if (found.plan && !found.recorded) holding = await held(found.target);
    } catch (err) {
      skip(`could not be read: ${err.message.slice(0, 2500)}`);
      continue;
    }
    if (found.plan) {
      if (found.recorded) { skip(`plan ${found.plan} was dispatched already, ${found.recorded}`); continue; }
      if (holding) { skip(`its plan's ${found.target}: ${holding}`); continue; }
      // A tracker issue's plan may point at another repository: the same
      // list bounds where a run goes, not only which items are read.
      if (!isFollowed(found.target)) { skip(`its plan's ${found.target}: not a followed repository`); continue; }
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
      if (triages <= 0) { pastCap++; skip(`triage cap of ${triagePerPass} a pass reached`); continue; }
      triages--;
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
    `If it is ready to implement, end your comment with a job plan for the one implement run that would resolve it, in the format of ${planDocs}: a fenced block, info string \`agent-board-plan\`, holding one JSON object with exactly the fields schema ("agent-board/job-plan/v1"), repo, item, kind ("implement"), runner ("hosted"), an optional pool, and brief (the task for that run, at most 16,000 characters). Its repo and item are this issue's. If the work is in another repository, as for an issue that points to an upstream one, write no plan: that is the operator's to start. Write one plan at most, and none if the issue is not ready; then say what it needs instead.`,
  ].join('\n\n');
}

// One agent-board call. Its stdin is closed, so nothing it might ask waits
// for an answer, and it is stopped after `timeoutMs`. One that cannot start,
// times out, is killed or, with `check`, exits non-zero throws `failure`.
// What it prints is logged to the run's summary, so the tokens given to it
// are masked in its output, here and in its failure.
function agentBoard(bin, args, { env = {}, timeoutMs, check = true } = {}) {
  const run = spawnSync(bin, args, {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  });
  const mask = masker(env);
  const out = { status: run.status, stdout: mask(run.stdout), stderr: mask(run.stderr) };
  if (!run.error && !run.signal && (run.status === 0 || !check)) return out;
  const why = run.error?.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000} s`
    : run.error ? run.error.message
      : run.signal ? `killed by ${run.signal}` : `exited ${run.status}`;
  throw failure(args, why, out.stderr, env);
}

// The tokens it is given, and those it inherits.
const masker = env => {
  const secrets = [...Object.values(env), process.env.GH_TOKEN, process.env.DISPATCH_TOKEN].filter(v => typeof v === 'string' && v.length >= 8);
  return text => secrets.reduce((t, s) => t.split(s).join('***'), String(text ?? ''));
};

// An error naming the agent-board command and carrying the end of its
// stderr, where agent-board says what went wrong, on one line, as the
// summary has one line an item.
function failure(args, why, stderr, env) {
  const mask = masker(env);
  const tail = mask(stderr).trim().split('\n').filter(Boolean).slice(-20).join(' | ').slice(-2000);
  const err = new Error(`${mask(['agent-board', ...args].join(' '))}: ${why}; ${tail ? `stderr: ${tail}` : 'no stderr'}`);
  err.stderr = mask(stderr);
  return err;
}

function dispatchArgs(config) {
  return ['--caller', config.caller, '--workflow', config.workflow,
    '--operator', config.operator, '--planner', config.planner];
}

// agent-board's dry run reads the plan and prints the request it would
// send; the line naming the plan's comment is on stderr.
// A non-zero exit is its refusal, which is an answer; a timeout is not.
async function probePlan(bin, config, token, item) {
  const args = ['dispatch', item.url, '--dry-run', ...dispatchArgs(config)];
  const env = { GH_TOKEN: token };
  const run = agentBoard(bin, args, { env, timeoutMs: config.timeoutMs, check: false });
  if (run.status !== 0) return readRefusal(run.stderr);
  let found;
  try {
    found = readDryRun(run.stdout, run.stderr);
  } catch (err) {
    throw failure(args, `output not understood: ${err.message}`, run.stderr, env);
  }
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
  // Required here, not above: epics.cjs takes loadConfig from this module.
  const { census, loadEpicsConfig } = require('./epics.cjs');
  const config = loadEpicsConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const log = line => console.log(apply ? line : `[dry-run] ${line}`);

  const get = p => request(token, 'GET', p);
  const { entries, note } = await census(get, body => request(token, 'POST', '/graphql', body), config);
  const { items, live, unread } = candidates(entries, config.epicsRepository);
  // An epic not read may be live, and a board the token lost would leave
  // every epic so: that fails the pass, after what could be read is done,
  // rather than pass as an idle one. So do epics past the census's bound,
  // which anyone who may label an older issue `epic` could push the
  // operator's out of.
  const failed = entries.filter(e => e.error).map(e => `${config.epicsRepository}#${e.number}: ${e.error}`);
  const unreadNote = (unread ? `; ${unread} epic(s) not read (${failed.slice(0, 3).join(' | ').slice(0, 1000)})` : '')
    + (note ? `; ${note}` : '');
  if (!live) {
    log(`no live epics${unreadNote}; nothing started`);
    if (unread || note) throw new Error(`${unread} epic(s) could not be read${note ? `, ${note}` : ''}`);
    return;
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
  log(`${items.length} open sub-issue(s) of ${live} live epic(s)${unreadNote}, taken ${order(config.priorityField)};`
    + ` ${state.inFlight} of ${config.wip} run(s) in flight;`
    + ` at most ${config.triagePerPass} triage run(s) a pass; items of ${config.followed.size} followed repositories only`);

  const byName = new Map(items.map(i => [`${i.repository}#${i.number}`, i]));
  let errors = 0;
  const steps = await decide(items, state, config, item => probePlan(bin, config, token, item), pullFor);
  for (const step of steps) {
    const item = byName.get(step.item);
    // Each line names the epic its item was taken from.
    const name = `${step.item} (epic ${item.epic})`;
    if (step.action === 'skip' || !apply) {
      log(`${name} ${step.action}: ${step.reason}`);
      continue;
    }
    try {
      if (step.action === 'dispatch') {
        // agent-board records the plan on the issue before it sends, and
        // refuses one recorded already, so a plan starts one run however
        // many passes see it.
        const { stdout } = agentBoard(bin, ['dispatch', item.url, '--apply', ...dispatchArgs(config)],
          { env: { GH_TOKEN: token, DISPATCH_TOKEN: dispatchToken }, timeoutMs: config.timeoutMs });
        log(`${name} dispatch: ${step.reason}; ${stdout.trim().split('\n').join(', ')}`);
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
        log(`${name} triage: started ${run?.html_url ?? ''}`.trimEnd());
      }
    } catch (err) {
      const last = String(err.stderr ?? '').trim().split('\n').at(-1);
      if (RECORDED_RE.test(last)) { log(`${name} skip: ${last}`); continue; }
      errors++;
      log(`${name} ${step.action} error: ${err.message}`);
    }
  }
  if (errors || unread || note) throw new Error(`${errors} step(s) failed, ${unread} epic(s) could not be read${note ? `, ${note}` : ''}`);
}

module.exports = { agentBoard, candidates, decide, findRecord, loadConfig, main, openPullRefs, probePlan, rank, readDryRun, readRefusal, readRuns, triageTask };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`schedule: ${err.message}`); process.exit(1); });
}
