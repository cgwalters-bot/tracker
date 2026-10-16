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
// --apply`, agent-board's docs/job-plans.md), if it is an implement one.
// Without a plan it is skipped, unless `schedule.triage` is on (see
// readTriage). Candidates are taken by
// their epic's `schedule.priorityField` on the board, then their own, P0
// first, then oldest first. No step starts once `schedule.wip` dispatch.yml
// runs are in flight, counting those already going. A dry run, the
// default, only reads: `--apply` is passed by the workflow only where the
// repository variable says so.
// Standard library and the agent-board binary; `decide` and its helpers are
// pure and are what schedule.test.cjs covers.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG: POLL, paged, request } = require('./poll.cjs');
const { heldBy } = require('./broker.cjs');

const CONFIG_FILE = path.join(__dirname, 'agent-board.json');
// How many of dispatch.yml's newest runs are read: enough to hold every run
// in flight.
const HISTORY_RUNS = 100;
// One agent-board call, unless `schedule.timeoutSeconds` says otherwise, so
// that a hung one fails its item, not the job. A dry run reads one issue's
// comments; nothing it does should take minutes.
const AGENT_BOARD_TIMEOUT_S = 120;
// A run that has not completed holds its slot and its item.
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
// dispatch.yml's run-name: "KIND OWNER/REPO#ITEM", then the pool.
const RUN_TITLE_RE = /^(implement|triage|research|review|fix) ([\w.-]+\/[\w.-]+)#(\d+)(?: |$)/;
// The line agentic-job's apply ends a run's pull request with.
const REFS_RE = /^Refs ([\w.-]+\/[\w.-]+#\d+)\s*$/gm;
// The lines a batched run's pull request closes each issue it did with
// (agent-board's docs/job-plans.md#batching asks for `Closes #N`), as
// GitHub reads closing keywords, one to a line.
const CLOSES_RE = /^(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) (?:([\w.-]+\/[\w.-]+))?#(\d+)\s*$/gim;
// Issues read from one pull request's body, at most: a batch is agent-board's
// BATCH_LIMIT of 5 extras and its primary, and a body listing hundreds could
// otherwise fill the coordinator's status brief past its byte limit.
const PULL_ISSUES = 10;
// agent-board's `dispatch --batch` bound (BATCH_LIMIT in its batch.rs).
const BATCH_LIMIT = 5;
// The hidden second line of an extra's record in a batch, naming the batch's
// primary issue: `<!-- agent-board-batch: OWNER/REPO#N -->`.
const BATCH_RE = /^<!-- agent-board-batch: ([\w.-]+\/[\w.-]+)#(\d+) -->$/;
// agent-board's dry run names each issue it would add to the run.
const BATCHED_RE = /^Batched: ([\w.-]+\/[\w.-]+#\d+) from the plan in /gm;
// What agent-board says, on the last line of stderr, of an issue without a
// writer's plan, and, on stderr of a dry run, of the plan it read.
const NO_PLAN = 'no plan on this issue';
const PLAN_FROM_RE = /request for the plan in (https:\/\/github\.com\/\S+#issuecomment-(\d+)) by /;
// The hidden first line of agent-board's record of a dispatch:
// `<!-- agent-board-dispatch: COMMENT-ID@TIME -->`.
const RECORD_RE = /^<!-- agent-board-dispatch: (\d+)@\S+ -->$/;
// agent-board's refusal of a plan it has a record of, which takes no step.
const RECORDED_RE = /has a dispatch record already/;
// eligibility's guess that a merged pull request did an issue.
const PROBABLY_DONE = 'probably done by ';
// The bound on `schedule.triage`, triage runs and needs-design records a pass.
const TRIAGE_LIMIT = 5;
// Fewer non-space characters than this in an issue's body is too little to
// plan from, so no run is spent on it. A crude bar: the triage run is what
// judges a longer body, and may answer needs-design too.
const CONCRETE_CHARS = 200;
// The hidden first line of this job's record of a triage question, and the
// fenced block the run answers it with (readTriage).
const TRIAGE_RE = /^<!-- schedule-triage\/v1: (\{[^\n]*\}) -->$/;
const VERDICT_RE = /^```schedule-triage[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const VERDICTS = new Set(['done', 'partly', 'not-done', 'needs-design']);
// The first line of this job's comment closing an issue on a done answer.
const closedLine = request => `<!-- schedule-triage/v1-closed: ${request} -->`;
// A question unanswered this long is listed again, as its run likely failed.
const ANSWER_MS = 24 * 3600 * 1000;
// The bound on `schedule.retries`, the runs a plan may get after its first.
const RETRY_LIMIT = 2;
// The bound on `schedule.fill`, the issues outside any epic a pass in fill
// mode reads (fillItems); each costs an eligibility query and a comments read.
const FILL_LIMIT = 20;
// A usage snapshot older than this says nothing of the pace: its publisher
// (usage.yml, every fifteen minutes) has stopped, so fill mode is off.
const PACE_FRESH_MS = 3 * 3600 * 1000;
// A pool's reading older than this is not known (paceMode).
// A day, and slack for the daily planning run that renews it to start.
const OBSERVED_FRESH_MS = 30 * 3600 * 1000;
// The coordinator's minimum planning interval in fill mode, if shorter.
const FILL_PLAN_INTERVAL_MS = 3600 * 1000;
// Labels that keep an issue out of fill mode's candidates: a person's, and
// those eligibility refuses (an epic, a question), which would otherwise
// take places before the cap and leave none for issues that can run.
const FILL_HELD_LABELS = new Set(['needs-human', 'needs-design', 'epic', 'question']);
// The hidden line this job's record of a retry carries after agent-board's
// marker, naming the plan's comment; each one is an attempt (readOutcome).
const RETRY_RE = /^<!-- schedule-retry\/v1: (\d+) -->$/;
// The first line of this job's comment closing an issue whose run's pull
// request merged, naming the run, so a reopened issue is not closed again.
const doneLine = run => `<!-- schedule-outcome/v1-closed: ${run} -->`;
// agentic-job's status comment on a run's item (its workflow/status.cjs):
// its own text, then the agent's quoted reason after ` Its reason:`, then
// these two hidden lines, last.
const STATUS_END = run => `\n\n<!-- agentic-job-run: ${run} -->\n\n<!-- agentic-job-status -->`;
const STATUS_REASON = ' Its reason:';

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
    priorityField: s.priorityField ?? 'Priority',
    operator: all.operator, planner: all.bot, caller: all.dispatchRepo, workflow: POLL.dispatchWorkflow,
    planDocs: `${all.source}/blob/${all.branch}/docs/job-plans.md`,
    statusIssue: all.coordinator?.statusIssue,
    statusRepository: all.epics?.repository,
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
  // A bound on one call; the job's timeout-minutes is the pass's.
  const t = s.timeoutSeconds ?? AGENT_BOARD_TIMEOUT_S;
  if (!Number.isSafeInteger(t) || t < 1 || t > 600) throw new Error('agent-board.json: schedule.timeoutSeconds must be 1 to 600');
  config.timeoutMs = t * 1000;
  // Triage runs, and needs-design records, a pass may start (readTriage);
  // 0, the default, is off. They write implement plans, as the coordinator's
  // planning runs do, so they use its pool.
  config.triage = s.triage ?? 0;
  if (!Number.isSafeInteger(config.triage) || config.triage < 0 || config.triage > TRIAGE_LIMIT) {
    throw new Error(`agent-board.json: schedule.triage must be 0 to ${TRIAGE_LIMIT}`);
  }
  config.triagePool = all.coordinator?.planPool ?? 'claude';
  // Extra small sibling issues one implement run may also do (agent-board's
  // `dispatch --batch`); 0, the default, is off.
  config.batch = s.batch ?? 0;
  if (!Number.isSafeInteger(config.batch) || config.batch < 0 || config.batch > BATCH_LIMIT) {
    throw new Error(`agent-board.json: schedule.batch must be 0 to ${BATCH_LIMIT}`);
  }
  // Runs a recorded plan may get after its first ended without a merged pull
  // request (readOutcome); 0, the default, is off: a recorded plan is then
  // only skipped, as dispatched already, whatever its run did.
  config.retries = s.retries ?? 0;
  if (!Number.isSafeInteger(config.retries) || config.retries < 0 || config.retries > RETRY_LIMIT) {
    throw new Error(`agent-board.json: schedule.retries must be 0 to ${RETRY_LIMIT}`);
  }
  // Issues outside any epic a pass may take while the plan pool is under
  // its pace (paceMode, fillItems); 0, the default, is off. Each is asked of
  // a triage run first, so it needs `triage` on.
  config.fill = s.fill ?? 0;
  if (!Number.isSafeInteger(config.fill) || config.fill < 0 || config.fill > FILL_LIMIT) {
    throw new Error(`agent-board.json: schedule.fill must be 0 to ${FILL_LIMIT}`);
  }
  if (config.fill && !config.triage) throw new Error('agent-board.json: schedule.fill needs schedule.triage');
  if (!login.test(config.operator ?? '') || !login.test(config.planner ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(config.caller ?? '')) {
    throw new Error('agent-board.json: operator, bot and dispatchRepo are required');
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(all.source ?? '') || !/^[\w.\/-]+$/.test(all.branch ?? '')) {
    throw new Error('agent-board.json: source and branch must name agent-board');
  }
  return config;
}

// What dispatch.yml's recent runs say: how many hold a slot, which items
// have one in flight. Fix and review runs name a pull request, not an issue,
// but count against the cap all the same.
function readRuns(runs) {
  const busy = new Map();
  let inFlight = 0;
  for (const run of runs) {
    const running = RUNNING.has(run.status);
    if (running) inFlight++;
    const m = RUN_TITLE_RE.exec(run.display_title ?? '');
    if (!m) continue;
    const key = keyOf(m[2], m[3]);
    if (running && !busy.has(key)) busy.set(key, run.html_url);
  }
  return { inFlight, busy };
}

// The issues a pull request was made for: its `Refs` line, then those it
// closes, a bare `#N` being in its own repository. A batched run's pull
// request has one `Refs` and a closing line for each issue it did, so it is
// one pull request with several issues. At most PULL_ISSUES, keys lowercase.
function pullIssues(pull) {
  const body = pull.body ?? '';
  const own = pull.base?.repo?.full_name ?? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(pull.html_url ?? '')?.[1];
  const keys = new Set([...body.matchAll(REFS_RE)].map(m => m[1].toLowerCase()));
  for (const m of body.matchAll(CLOSES_RE)) {
    const repo = m[1] ?? own;
    if (repo) keys.add(keyOf(repo, m[2]));
  }
  return [...keys].slice(0, PULL_ISSUES);
}

// The items the bot's open pull requests were made for. Only the bot's: a
// visitor's pull request must not be able to hold an item back.
function openPullRefs(pulls, bot) {
  const refs = new Map();
  for (const pull of pulls) {
    if (pull.user?.login?.toLowerCase() !== bot.toLowerCase()) continue;
    for (const key of pullIssues(pull)) {
      if (!refs.has(key)) refs.set(key, pull.html_url);
    }
  }
  return refs;
}

// The plan a successful dry run read: the comment it is in and the item its
// run would work on, which need not be the board item (a tracker issue's
// plan may target the upstream repository it points to), and the issues it
// would batch with it.
function readDryRun(stdout, stderr) {
  const inputs = JSON.parse(stdout).body.inputs;
  const from = PLAN_FROM_RE.exec(stderr);
  if (!from || !inputs?.repo || !inputs?.item) throw new Error('agent-board dry run named no plan comment or target');
  const extras = [...String(stderr).matchAll(BATCHED_RE)].map(m => m[1].toLowerCase()).slice(0, BATCH_LIMIT);
  return { plan: from[1], commentId: from[2], target: keyOf(inputs.repo, inputs.item), kind: inputs.kind, extras };
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
//
// agent-board's release rule (batch.rs `held`): an extra's record, whose
// second line names another issue as its batch's primary, stops holding the
// plan once `released(primaryKey)` says so, which is when the primary is
// closed and no open pull request closes this issue: the batch is over and
// did not finish it. Without this, an extra left undone would never be
// scheduled again. A record naming this issue `self` holds, as one without
// that line does.
async function findRecord(comments, writers, commentId, self, released = async () => false) {
  const trusted = new Set(writers.map(w => w.toLowerCase()));
  const plan = comments.find(c => String(c.id) === commentId);
  const changed = Date.parse(plan?.updated_at ?? '') || 0;
  for (const c of comments) {
    if (!trusted.has(c.user?.login?.toLowerCase())) continue;
    const lines = (c.body ?? '').split('\n');
    const m = RECORD_RE.exec(lines[0].trimEnd());
    if (m?.[1] !== commentId || Date.parse(c.created_at) < changed) continue;
    const batch = BATCH_RE.exec((lines[1] ?? '').trimEnd());
    const primary = batch && keyOf(batch[1], batch[2]);
    if (primary && primary !== self && await released(primary)) continue;
    return c.html_url;
  }
  return undefined;
}

// Whether an extra's record is released (see findRecord). An answer that
// cannot be read throws, which skips the item, so the record holds.
const OPEN_CLOSERS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { state } }
  } }
}`;
async function batchReleased(get, post, primary, key) {
  const [repo, number] = primary.split('#');
  const state = (await get(`/repos/${repo}/issues/${number}`))?.state;
  if (!['open', 'closed'].includes(state)) throw new Error(`batch primary ${primary} not readable`);
  if (state === 'open') return false;
  const [owner, name] = key.split('#')[0].split('/');
  const out = await post({ query: OPEN_CLOSERS_QUERY, variables: { owner, name, number: Number(key.split('#')[1]) } });
  const nodes = out.data?.repository?.issue?.closedByPullRequestsReferences?.nodes;
  if (out.errors?.length || !Array.isArray(nodes)) throw new Error(`closing pull requests of ${key} not readable`);
  return !nodes.some(p => p.state === 'OPEN');
}

// What became of a recorded plan's run (tracker#645), for decide: the run
// agent-board's record links, and its pull request or why it had none, from
// agentic-job's status comment for that run on the run's target. `found` is
// probePlan's, `targetComments` the target's comments. Each part is taken
// only from who could have written it, so that no visitor's comment and no
// agent's text closes an issue or names its run:
// - the record is a writer's (findRecord), and only an implement run of the
//   caller on the plan's target counts;
// - the status comment is the planner's (the run's SAFE_OUTPUTS_PAT, on a
//   target in another repository) or the caller's job token's, ending with
//   that run's marker; only its own text, before the agent's quoted reason,
//   may name the pull request, and that must be the planner's;
// - a blocker comes from the agent's reason, which only a run that handed
//   back missing data has: at most one, in a followed repository. The worst
//   a steered one does is hold the item until that issue closes.
// An attempt is the record, and each retry record this job wrote for the plan
// since it last changed (agent-board's rule for a record's plan). null is not
// known, which keeps the skip as dispatched already: a batched extra's record,
// one without a run link, or a run whose status comment a later run on the
// same item has replaced.
async function readOutcome(get, config, found, targetComments) {
  const lines = (found.record?.body ?? '').split('\n');
  if (BATCH_RE.test((lines[1] ?? '').trimEnd())) return null;
  const caller = config.caller.replace(/\./g, '\\.');
  const id = [...String(found.record?.body ?? '').matchAll(new RegExp(`https://github\\.com/${caller}/actions/runs/(\\d+)`, 'gi'))].at(-1)?.[1];
  if (!id) return null;
  const run = await get(`/repos/${config.caller}/actions/runs/${id}`);
  const title = RUN_TITLE_RE.exec(run?.display_title ?? '');
  if (title?.[1] !== 'implement' || keyOf(title[2], title[3]) !== found.target) return null;
  const writers = new Set([config.operator, config.planner].map(w => w.toLowerCase()));
  const mine = found.comments.filter(c => writers.has(c.user?.login?.toLowerCase()));
  const changed = Date.parse(found.comments.find(c => String(c.id) === found.commentId)?.updated_at ?? '') || 0;
  const attempt = 1 + mine.filter(c => (Date.parse(c.created_at) || 0) >= changed
    && (c.body ?? '').split('\n').slice(0, 2).some(l => RETRY_RE.exec(l.trimEnd())?.[1] === found.commentId)).length;
  const base = { run: run.html_url, runId: id, attempt };
  if (run.status !== 'completed') return { ...base, outcome: 'running' };
  const authors = new Set([config.planner.toLowerCase()]);
  if (found.target.split('#')[0] === config.caller.toLowerCase()) authors.add('github-actions[bot]');
  const status = targetComments.find(c => authors.has(c.user?.login?.toLowerCase()) && String(c.body ?? '').endsWith(STATUS_END(id)));
  const text = status ? status.body.slice(0, -STATUS_END(id).length) : '';
  const cut = text.indexOf(STATUS_REASON);
  const own = cut < 0 ? text : text.slice(0, cut);
  // A run cancelled was stopped by a person or a newer run: not retried.
  if (run.conclusion === 'cancelled') return null;
  // Only a run that ended well has a result: a failed one's text carries the
  // check's refusal, whose file names and errors the agent can choose, and
  // could name some merged pull request of the planner's.
  const result = run.conclusion === 'success' && own.startsWith('✅ ')
    && [...own.matchAll(/ Result: (https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))/g)].at(-1);
  if (result) {
    const pull = await get(`/repos/${result[2]}/pulls/${result[3]}`);
    if (pull?.user?.login?.toLowerCase() === config.planner.toLowerCase()) {
      const at = { ...base, pull: pull.html_url };
      if (pull.merged_at) {
        const closed = mine.some(c => (c.body ?? '').split('\n')[0].trimEnd() === doneLine(id));
        return { ...at, outcome: closed ? 'reopened' : 'merged', partOf: /^\s*part of\b/im.test(pull.body ?? '') };
      }
      return { ...at, outcome: pull.state === 'open' ? 'open' : 'closed' };
    }
  }
  // A run that ended well with no status comment left is not known to have
  // made nothing.
  if (!status && run.conclusion === 'success') return null;
  const reason = (own.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim() || `it concluded ${run.conclusion}`).slice(0, 500);
  let blocker;
  if (cut >= 0 && own.includes('required data was missing')) {
    for (const m of text.slice(cut).matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|\b([\w.-]+\/[\w.-]+)#(\d+)/g)) {
      const key = keyOf(m[1] ?? m[3], m[2] ?? m[4]);
      if (key === found.target || key === found.self || !config.followed.has(key.split('#')[0])) continue;
      const [repo, n] = key.split('#');
      const issue = await get(`/repos/${repo}/issues/${n}`);
      if (!['open', 'closed'].includes(issue?.state)) throw new Error(`blocker ${key} not readable`);
      blocker = { key, open: issue.state === 'open', pull: Boolean(issue.pull_request), id: issue.id };
      break;
    }
  }
  return { ...base, outcome: 'failed', reason, ...(blocker ? { blocker } : {}) };
}

// The order items are taken in, for the summary.
const order = field => `by their epic's ${field}, then their own (P0 first, unset last), then oldest first`;
// P0, P1, ... by the number; any other value, or none, after them all.
const rank = p => { const m = /^P(\d{1,3})$/.exec(p ?? ''); return m ? Number(m[1]) : Infinity; };
const age = item => Date.parse(item.created ?? '') || Infinity; // Two unknowns tie: Infinity - Infinity is NaN, hence `|| 0` below.
// An epic's sub-issues come before fill mode's issues outside any epic.
const ahead = (a, b) => (Number(Boolean(a.fill)) - Number(Boolean(b.fill))) || (rank(a.epicPriority) - rank(b.epicPriority) || 0) || (rank(a.priority) - rank(b.priority) || 0) || (age(a) - age(b) || 0);
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
        repository: s.repository, number: s.number, content_kind: 'issue', url: s.url, priority: s.priority, body: s.body,
        created: s.created, status: s.status, epic: `${repository}#${epic.number}`, epicPriority: epic.priority,
      };
      const key = keyOf(s.repository, s.number);
      if (!byKey.has(key) || ahead(item, byKey.get(key)) < 0) byKey.set(key, item);
    }
  }
  return { items: [...byKey.values()], live: live.length, unread: entries.filter(e => e.error).length };
}

// Whether a pool is under its pace (tracker#672), from the usage snapshot
// (usage.cjs's bot-usage/v1): its paced window's used share below the pace
// the usage job holds it to, its target of the share of that window gone.
// That is fill mode; anything not known, a snapshot
// gone stale or a pool held included, is not. A reading the snapshot carried
// over a broker restart is a lower bound, which use outside the broker
// could leave far behind, so one observed over a day ago is not known
// either; a daily planning pass of the coordinator runs on the pool and
// renews it, but with no epic due one fill mode stays off until a run does. { fill, mode } with the figures.
function paceMode(snapshot, pool, now) {
  const p = snapshot?.pools?.[pool];
  const updated = Date.parse(snapshot?.updated_at ?? '');
  const off = why => ({ fill: false, mode: `normal (${why})` });
  if (!p || !Number.isFinite(updated)) return off(`no usage reading of the ${pool} pool`);
  if (now - updated > PACE_FRESH_MS) return off(`the usage snapshot is from ${snapshot.updated_at}`);
  const window = p.window_minutes * 60000;
  const reset = Date.parse(p.resets_at ?? '');
  const observed = Date.parse(p.observed_at ?? '');
  if (!(now - observed <= OBSERVED_FRESH_MS)) return off(`no reading of the ${pool} pool observed in the last day${p.observed_at ? `, the last at ${p.observed_at}` : ''}`);
  if (![p.used_percent, p.target_percent, window, reset].every(Number.isFinite) || window <= 0 || reset <= now) return off(`no current window of the ${pool} pool`);
  const gone = 100 * Math.min(1, Math.max(0, (now - (reset - window)) / window));
  const allowed = (p.target_percent * gone) / 100;
  const figures = `${pool} ${Math.round(p.used_percent)}% used, pace allows ${Math.round(allowed)}%`;
  if (p.hold) return off(`${figures}, held`);
  return p.used_percent < allowed ? { fill: true, mode: `fill (${figures})` } : off(figures);
}

// The pace as the bot's usage comment says it, read as the coordinator reads
// it: only the bot's own comment, unedited by anyone else, counts.
async function readPace(post, pool, now) {
  const { operatorComments, readComments } = require('./epics.cjs');
  const { MARKER, previousSnapshot } = require('../usage/usage.cjs');
  const usage = require('../usage/config.json');
  const comment = operatorComments(await readComments(post, usage.repo, usage.issue), usage.bot).filter(c => c.body.startsWith(MARKER)).at(-1);
  return paceMode(previousSnapshot(comment?.body), pool, now);
}

// The coordinator's minimum planning interval: shorter in fill mode, so an
// epic whose work ran out is planned again sooner.
const planInterval = (ms, pace) => (pace?.fill ? Math.min(ms, FILL_PLAN_INTERVAL_MS) : ms);

// One followed repository's oldest open issues, with their board fields.
const FILL_QUERY = `query($owner: String!, $name: String!, $field: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number url body createdAt author { login } parent { number }
        labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
        projectItems(first: 20) { nodes {
          project { number owner { ... on Organization { login } ... on User { login } } }
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority: fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        } }
      }
    }
  }
}`;

// Fill mode's candidates (tracker#672): open issues of the followed
// repositories outside any epic, `config.fill` of them at most, by board
// priority, then age. `answers` are FILL_QUERY's, one a repository, `taken`
// the keys the epics gave already, the epics and the status issue included.
// Only issues the operator or the bot
// opened: in a public repository anyone can open one, and a stranger's
// would otherwise spend the pool and have a run write a pull request from
// its text. An issue with a parent is its parent's, epic or umbrella; one
// labelled needs-human or needs-design waits on a person, and one labelled
// epic or question is never run (FILL_HELD_LABELS). One with a plan
// dispatched already, or an open pull request, is skipped by decide, as an
// epic's sub-issue is. Only issues on the board: the
// repositories' control issues (the supervisor's requests, a session's, a
// broker outage) are the operator's or the bot's too, and a triage run's
// done answer would close them. Each is given a triage run first (decide).
function fillItems(answers, config, taken) {
  const writers = new Set([config.operator, config.planner].map(w => w.toLowerCase()));
  const items = [];
  for (const { repository, nodes } of answers) {
    for (const n of nodes ?? []) {
      const key = keyOf(repository, n.number);
      if (taken.has(key) || n.parent || !writers.has(n.author?.login?.toLowerCase())) continue;
      // More labels than one page may hide a held one.
      if (n.labels?.pageInfo?.hasNextPage !== false || n.labels.nodes.some(l => FILL_HELD_LABELS.has(l.name.toLowerCase()))) continue;
      const on = (n.projectItems?.nodes ?? []).find(i => i.project?.number === config.project
        && i.project?.owner?.login?.toLowerCase() === config.owner.toLowerCase());
      if (!on) continue;
      items.push({ repository, number: n.number, content_kind: 'issue', url: n.url, body: n.body, created: n.createdAt,
        status: on.status?.name, priority: on.priority?.name, fill: true });
    }
  }
  return byPriority(items).slice(0, config.fill);
}

// One step for each item. `probe(item)` says what agent-board would do with
// it: { plan, target, recorded? }, { none: true } or { refused: reason }.
// `pullFor(key)` names the bot's open pull request for an item, if any. A
// probe is made only while a slot is free, so a full pass reads no issue's
// comments; only a step that starts a run takes a slot. One item failing to
// be read is skipped with the reason, and the others go on. `limits` is
// the config's `wip`, `followed` and status issue. `inspect(key)` says why an
// issue is not to be worked on, if it is not. `act(step)` is called with each
// step as it is decided, so that what a pass has decided is done even if the
// job's timeout stops it partway down a long board. `triaged(item)` is
// readTriage's answer for an item, asked only with `triage` on. `ended(found)`
// is readOutcome's answer for a recorded plan, asked only with `retries` on.
// `filling` is fill mode (paceMode), in which an item with `fill` set, from
// outside any epic, is asked of a triage run before its plan is dispatched,
// and a triage or research plan is dispatched too.
async function decide(items, { inFlight, busy: running }, { wip, followed, statusIssue, statusRepository, triage = 0, retries = 0, filling = false }, probe, pullFor,
  inspect = async () => null, act = async () => {}, triaged = async () => null, ended = async () => null) {
  let free = wip - inFlight;
  let questions = triage;
  const isFollowed = key => followed.has(key.split('#')[0]);
  const steps = [];
  const push = async step => { steps.push(step); await act(step); };
  // What this pass starts holds its items as a run in flight would, so two
  // plans with one target, or a plan's target that is a board item too,
  // get one run.
  const busy = new Map(running);
  const blockedTargets = new Set(items.filter(i => i.status === 'Blocked').map(i => keyOf(i.repository, i.number)));
  const held = async key => {
    if (busy.has(key)) return `a run is in flight, ${busy.get(key)}`;
    const pull = await pullFor(key);
    return pull ? `a pull request is open, ${pull}` : null;
  };
  for (const item of byPriority(items)) {
    const name = `${item.repository}#${item.number}`;
    // A quiet skip is counted in the idle line but not listed on every pass.
    const skip = (reason, quiet, extra = {}) => push({ item: name, action: 'skip', reason, ...(quiet ? { quiet } : {}), ...extra });
    const key = keyOf(item.repository, item.number);
    // A guess, probably done or no plan, is asked once of a triage run rather
    // than held as a skip on every pass. The answer: done closes the issue;
    // otherwise its plan, if the run wrote one, goes on as any plan does.
    // That is a run starting a run, which the kind check below otherwise
    // keeps to a person: it is one implement plan per question, a question
    // asked once per issue and at most `triage` a pass. The run reads the
    // issue's text, anyone's, which may steer that plan as it may any plan
    // a run writes from an issue; the implement run's pull request still
    // needs its review to merge.
    const ask = async (guess, pull) => {
      if (questions <= 0) return skip(guess);
      questions--;
      if (!pull && !concrete(item.body)) return push({ item: name, action: 'design', reason: `${guess}; too little in its body to plan, recording needs design` });
      busy.set(key, 'started in this pass');
      free--;
      return push({ item: name, action: 'triage', reason: `${guess}; asking a triage run`, ...(pull ? { pull } : {}) });
    };
    // What a recorded question says of the item: true once a step is taken,
    // false when it answered not (or not all) done, so the item goes on.
    const answered = async record => {
      if (record.verdict === 'done') await push({ item: name, action: 'close', reason: `triage found it done, ${record.evidence}`, evidence: record.evidence, request: record.request });
      else if (!record.verdict) await skip(`triage asked, ${record.stale ? 'no answer in a day, ' : ''}${record.url}`, !record.stale);
      else if (record.verdict === 'needs-design') await skip(`needs design, ${record.url}`, true);
      else return false;
      return true;
    };
    let record;
    if (!isFollowed(key)) { await skip('not a followed repository'); continue; }
    if (item.content_kind !== 'issue') { await skip('not an issue'); continue; }
    if (statusRepository && key === keyOf(statusRepository, statusIssue)) { await skip('coordinator status issue'); continue; }
    if (item.status === 'Blocked') { await skip('blocked by coordinator plan (board Status: Blocked)'); continue; }
    let found, unbatched, retry, cleared = false;
    try {
      const holding = await held(key);
      if (holding) { await skip(holding); continue; }
      if (free <= 0) { await skip(`work-in-progress cap of ${wip} reached`); continue; }
      let ineligible = await inspect(key);
      // Answered not done, the guess is set aside, and the checks after it
      // in eligibility are made, here and for the item's own plan below.
      if (ineligible?.startsWith(PROBABLY_DONE) && triage) {
        record = await triaged(item);
        if (!record) { await ask(ineligible, ineligible.slice(PROBABLY_DONE.length).split(';')[0]); continue; }
        if (await answered(record)) continue;
        cleared = true;
        ineligible = await inspect(key, '', true);
      }
      if (ineligible) { await skip(ineligible); continue; }
      // An issue outside any epic may be stale or overtaken (agentic-job#970):
      // a triage run closes it, or writes or confirms its plan, first.
      if (item.fill) {
        if (record === undefined) record = await triaged(item);
        if (!record) { await ask('outside any epic'); continue; }
        if (await answered(record)) continue;
      }
      found = await probe(item);
      if (found.none) {
        if (!triage) { await skip('no plan'); continue; }
        if (record === undefined) record = await triaged(item);
        if (!record) { await ask('no plan'); continue; }
        if (!await answered(record)) await skip(`no plan since triage answered ${record.verdict}, ${record.url}`, true);
        continue;
      }
      if (!found.plan) { await skip(`plan refused: ${found.refused}`); continue; }
      if (found.recorded) {
        // With `retries` on, the recorded plan's run decides (tracker#645):
        // skipped as dispatched already for ever, a done issue stayed open
        // and a failed one was never started again.
        const out = retries ? await ended(found) : null;
        if (!out) { await skip(`plan ${found.plan} was dispatched already, ${found.recorded}`); continue; }
        const as = { outcome: out.outcome };
        const pull = out.pull && shortRef(out.pull);
        if (out.outcome === 'running') { await skip(`a run is in flight, ${out.run}`, false, as); continue; }
        if (out.outcome === 'open') { await skip(`PR open: ${pull}`, false, as); continue; }
        if (out.outcome === 'closed') { await skip(`its run's PR ${pull} was closed unmerged; edit or replace the plan to dispatch it again`, false, as); continue; }
        if (out.outcome === 'reopened') { await skip(`reopened after its run's PR ${pull} merged`, true, as); continue; }
        if (out.outcome === 'merged') {
          const guess = `its run's PR ${pull} merged as part of it`;
          // A pull request that says it is part of the issue may not have
          // done all of it: that is a triage run's question, not a close.
          if (!out.partOf) await push({ item: name, action: 'done', reason: `its run's PR ${pull} merged`, pull: out.pull, run: out.run, runId: out.runId, ...as });
          else if (!triage) await skip(guess, false, as);
          else {
            if (record === undefined) record = await triaged(item);
            if (!record) await ask(guess, pull);
            else if (!await answered(record)) await skip(`${guess}; triage answered ${record.verdict}, ${record.url}`, true, as);
          }
          continue;
        }
        // Failed, or ended without a pull request. A blocker the run named
        // is waited on, not retried against: linked when it is an issue, so
        // eligibility holds the item until it closes and the plan's next
        // attempt starts then.
        if (out.blocker?.open) {
          if (out.blocker.pull) await skip(`its run ${out.run} needs ${out.blocker.key}, which is open`, false, as);
          else await push({ item: name, action: 'block', reason: `its run ${out.run} needs ${out.blocker.key}; linking it as blocked by`, blocker: out.blocker, ...as });
          continue;
        }
        const reason = out.blocker ? `${out.reason}; ${out.blocker.key}, which it needed, is closed now` : out.reason;
        if (out.attempt > retries) {
          await push({ item: name, action: 'needs-human', reason: `${out.attempt} run(s) ended without a merged PR, the last ${out.run}: ${reason}`, ...as });
          continue;
        }
        retry = { attempt: out.attempt + 1, of: retries + 1, run: out.run, runId: out.runId, reason };
      }
      const targetHeld = await held(found.target);
      if (targetHeld) { await skip(`its plan's ${found.target}: ${targetHeld}`); continue; }
      // A tracker issue's plan may point at another repository: the same
      // list bounds where a run goes, not only which items are read. Checked
      // before the target is read, so nothing is asked of one not followed.
      if (!isFollowed(found.target)) { await skip(`its plan's ${found.target}: not a followed repository`); continue; }
      if (blockedTargets.has(found.target)) { await skip(`its plan's ${found.target}: blocked by coordinator plan (board Status: Blocked)`); continue; }
      // A triage or research plan, which a triage run could write, would start
      // a run that writes another plan, and the bot that posts a run's
      // comments is an accepted planner: such chains are a person's to start.
      // Review and fix runs are the pull request events' and the poll's.
      // In fill mode a triage or research plan is dispatched, as the pool has
      // runs to spare, but out of the same per-pass budget as triage
      // questions: that bounds such a chain to `triage` runs a pass, each
      // plan once (its record), and each run takes a slot.
      if (found.kind !== 'implement') {
        if (!filling || !['triage', 'research'].includes(found.kind)) { await skip(`plan ${found.plan} is for ${found.kind}, which is dispatched by hand`); continue; }
        if (questions <= 0) { await skip(`plan ${found.plan} is for ${found.kind}; the triage limit of ${triage} a pass is reached`); continue; }
      }
      if (found.target !== key || found.brief) {
        const targetIneligible = statusRepository && found.target === keyOf(statusRepository, statusIssue)
          ? 'coordinator status issue' : await inspect(found.target, found.brief, cleared && found.target === key);
        if (targetIneligible) { await skip(`its plan's ${found.target}: ${targetIneligible}`); continue; }
      }
      // agent-board picks a batch's extras by their labels, dependencies and
      // closing pull requests only, so an extra the coordinator holds
      // (Status: Blocked), one with a run or bot pull request, or one this
      // job would not take on its own would be done anyway. Each gets the
      // checks the item had; if one fails the item runs alone, without
      // --batch, rather than wait on an extra agent-board keeps choosing.
      // A retry runs alone: its extras were the first run's to do.
      for (const extra of retry || found.kind !== 'implement' ? [] : found.extras ?? []) {
        unbatched = !isFollowed(extra) ? 'not a followed repository'
          : blockedTargets.has(extra) ? 'blocked by coordinator plan (board Status: Blocked)'
            : statusRepository && extra === keyOf(statusRepository, statusIssue) ? 'coordinator status issue'
              : await held(extra) ?? await inspect(extra).catch(err => `could not be read: ${err.message.slice(0, 300)}`);
        if (unbatched) { unbatched = `${extra}: ${unbatched}`; break; }
      }
    } catch (err) {
      await skip(`could not be read: ${err.message.slice(0, 2500)}`);
      continue;
    }
    if (found.kind !== 'implement') questions--;
    await push(found.kind !== 'implement'
      ? { item: name, action: 'dispatch', reason: `plan ${found.plan}, for ${found.kind}`, batch: false }
      : retry
        ? { item: name, action: 'retry', reason: `plan ${found.plan}; attempt ${retry.attempt} of ${retry.of}, as its run ${retry.run} ended without a merged PR: ${retry.reason}`,
          outcome: 'failed', retry, found }
        : unbatched
          ? { item: name, action: 'dispatch', reason: `plan ${found.plan}; alone, as batched ${unbatched}`, batch: false }
          : { item: name, action: 'dispatch', reason: `plan ${found.plan}` });
    busy.set(found.target, 'started in this pass');
    busy.set(key, 'started in this pass');
    // A batched run holds its extras too; with --apply their records say so
    // as well, but a dry run writes none.
    if (!unbatched && !retry && found.kind === 'implement') for (const extra of found.extras ?? []) busy.set(extra, `batched with ${name} in this pass`);
    free--;
  }
  return steps;
}

const concrete = body => String(body ?? '').replace(/\s+/g, '').length >= CONCRETE_CHARS;
const bodyHash = body => crypto.createHash('sha256').update(String(body ?? '')).digest('hex').slice(0, 16);

// The triage question this job recorded on an item, and its answer
// (tracker#636). The record is a writer's comment whose first line is
// `<!-- schedule-triage/v1: {"request": ID, ...} -->`, written before the run
// is dispatched, so an item is asked once however many passes see it; to ask
// again, delete it. A needs-design record, which no run answers, lapses when
// the body changes, as does a needs-design answer. The answer is a writer's
// comment made after the record, with one `schedule-triage` fenced block of
// `{"request": ID, "verdict": ...}`; only the run's bot or the operator can
// post that, so no visitor's comment closes an issue, and the request ID
// keeps an older answer from being taken for this question. The run's own
// judgement can still be steered by the issue's text: the worst it does is
// close an open issue, with a comment linking its evidence, which reopening
// undoes: a done answer this job closed on once reads as `reopened`, which
// lets the item go on as not done. `comments` are REST issue comments, oldest first.
function readTriage(comments, writers, body, now = Date.now()) {
  const trusted = new Set(writers.map(w => w.toLowerCase()));
  const mine = comments.filter(c => trusted.has(c.user?.login?.toLowerCase()));
  let record;
  for (const c of mine) {
    const m = TRIAGE_RE.exec((c.body ?? '').split('\n')[0].trimEnd());
    if (!m) continue;
    try {
      const state = JSON.parse(m[1]);
      if (typeof state.request === 'string' && state.request) record = { ...state, url: c.html_url, at: Date.parse(c.created_at) || 0 };
    } catch { /* not a record */ }
  }
  if (!record) return null;
  const lapsed = () => record.body !== undefined && record.body !== bodyHash(body);
  if (record.design) return lapsed() ? null : { url: record.url, verdict: 'needs-design' };
  for (const c of mine.toReversed()) {
    if ((Date.parse(c.created_at) || 0) < record.at) continue;
    if ((c.body ?? '').split('\n')[0].trimEnd() === closedLine(record.request)) return { url: record.url, verdict: 'reopened' };
    const blocks = [...(c.body ?? '').matchAll(VERDICT_RE)];
    if (blocks.length !== 1) continue;
    let answer;
    try { answer = JSON.parse(blocks[0][1]); } catch { continue; }
    if (answer?.request !== record.request || !VERDICTS.has(answer.verdict)) continue;
    if (answer.verdict === 'needs-design' && lapsed()) return null;
    return { url: record.url, request: record.request, verdict: answer.verdict, evidence: c.html_url };
  }
  return { url: record.url, stale: now - record.at > ANSWER_MS };
}

// The record's comment, its first line readTriage's. A needs-design one
// keeps the body's hash, to lapse when the body is written up.
function triageRecord(request, step, body) {
  const state = step.action === 'design' ? { request, design: true, body: bodyHash(body) } : { request, body: bodyHash(body) };
  const text = step.action === 'design'
    ? 'Board scheduler: this issue has no job plan, and its body is too short to write one from. It needs design: say what to change and how to check it, and the next pass asks a triage run to plan it.'
    : `Board scheduler: ${step.reason.split(';')[0]}. A triage run is asked whether this is done; it answers here. Delete this comment to ask again.`;
  return `<!-- schedule-triage/v1: ${JSON.stringify(state)} -->\n${text}`;
}

// The triage run's task. Only URLs and fixed text: the issue and the pull
// requests are the run's to read, as data.
function triageTask(config, item, request, pull) {
  const fence = '```';
  // eligibility names the pull request OWNER/REPO#N; the run gets its URL.
  if (pull) pull = pull.replace(/^([\w.-]+\/[\w.-]+)#(\d+)$/, 'https://github.com/$1/pull/$2');
  return [
    `The board scheduler asks whether ${item.url} is done.`,
    pull ? `It guessed so from the merged pull request ${pull}, which closes it or says it implements it.`
      : item.fill ? 'It is an open issue outside any epic, taken while the pool has runs to spare; it may be stale or overtaken by other work, and any plan on it is dispatched only after your answer.'
        : 'It has no accepted job plan, so nothing would start on it.',
    `Compare what the issue asks for with ${pull ? 'that pull request and ' : ''}the pull requests merged since the issue was opened.`,
    'Post one comment on the issue that leads with the conclusion and ends with this block, the verdict one of the four:',
    '', `${fence}schedule-triage`, JSON.stringify({ request, verdict: 'done | partly | not-done | needs-design' }), fence, '',
    '- done: link the evidence for each part the issue asks for; the scheduler then closes the issue.',
    `- partly or not-done: say exactly what is left and, in the same comment, an accepted implement job plan for it as ${config.planDocs} describes, so the scheduler can start it.`,
    '- needs-design: say what is missing before it can be planned.',
  ].join('\n');
}

// The line a pass that started nothing with slots free ends with, so a
// stall shows: how many items were skipped for each reason, the reason's
// names and links left out, and how the recorded plans' runs ended. With
// `mode` (paceMode's, where `schedule.fill` is on) it is said, and a pass
// that started something with slots free says how many it filled.
function idleLine(steps, free, mode) {
  const started = steps.filter(s => ['dispatch', 'triage', 'retry'].includes(s.action)).length;
  if (free <= 0) return null;
  if (started) return mode ? `filled: ${started} of ${free} free slot(s); mode: ${mode}` : null;
  const tally = list => [...list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  const by = tally(steps.filter(s => s.action === 'skip').map(s =>
    s.reason.replace(/https:\/\/\S+/g, '').replace(/[\w.-]+\/[\w.-]+#\d+/g, '#N').split(/[,:;(]/)[0].replace(/\s+/g, ' ').trim()));
  const ended = tally(steps.filter(s => s.outcome).map(s => s.outcome));
  return `idle: ${free} slot(s) free and nothing started${mode ? `; mode: ${mode}` : ''}${by ? `; skipped: ${by}` : ''}${ended ? `; recorded runs: ${ended}` : ''}`;
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
  throw Object.assign(failure(args, why, out.stderr, env), { status: run.status });
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

// The same for a dry run and --apply, so a preview shows the batch a run
// would take. --batch only when on, so an agent-board without it still runs,
// and not for a step decide() sends alone.
function dispatchArgs(config, batch = true) {
  return ['--caller', config.caller, '--workflow', config.workflow,
    '--operator', config.operator, '--planner', config.planner,
    ...(config.batch && batch ? ['--batch', String(config.batch)] : [])];
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
  const self = keyOf(item.repository, item.number);
  const released = primary => batchReleased(p => request(token, 'GET', p), body => request(token, 'POST', '/graphql', body), primary, self);
  // Only the item's own brief is checked for its dependencies and branches: a
  // batched task appends each extra's after this line (batch.rs `brief`),
  // and an extra's are its own, nothing the item waits on.
  const brief = String(JSON.parse(run.stdout).body.inputs.task ?? '').split('\n\n---\n\nBatched run: ')[0];
  const recorded = await findRecord(comments, [config.operator, config.planner], found.commentId, self, released);
  // The record and the issue's comments are readOutcome's, with `retries` on,
  // and the request a retry sends is the dry run's, with its own brief.
  return { ...found, brief, recorded, self, comments, record: recorded && comments.find(c => c.html_url === recorded),
    dispatchBody: JSON.parse(run.stdout).body };
}

// A child relationship is not permission to implement an umbrella or a
// completed task. Read GitHub's closing references and cross-references. One
// bounded query per issue; incomplete data fails closed rather than hiding
// a merged closer beyond the first page.
const ELIGIBILITY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    state body
    projectItems(first: 100) {
      nodes {
        project { number owner { ... on Organization { login } ... on User { login } } }
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      } pageInfo { hasNextPage }
    }
    labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    subIssues(first: 1) { totalCount }
    closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
      nodes { merged state url } pageInfo { hasNextPage }
    }
    blockedBy(first: 100) {
      nodes { state url } pageInfo { hasNextPage }
    }
    timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
      nodes { ... on CrossReferencedEvent { source { ... on PullRequest {
        state merged url body repository { nameWithOwner owner { login } }
      } } } } pageInfo { hasNextPage }
    }
  } }
}`;

const shortRef = url => url.replace('https://github.com/', '').replace(/\/(?:pull|issues)\//, '#');

// Whether a pull request's body says it was made for issue `key`: a line
// starting `Refs` (as agentic-job ends a run's pull request), `Implements`
// or a closing keyword that names it. A merged pull request that only mentions an
// issue, such as one whose run filed it as a follow-up, did not do it
// (tracker#636); one that closes it is GitHub's closing reference instead.
function madeFor(body, key, repository) {
  for (const line of String(body ?? '').split('\n')) {
    const m = /^\s*(?:refs|implements?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]+(.*)$/i.exec(line);
    if (!m) continue;
    for (const r of m[1].matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|\b([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)/g)) {
      if (keyOf(r[1] ?? r[3] ?? repository ?? '', r[2] ?? r[4] ?? r[5]) === key) return true;
    }
  }
  return false;
}

// Only explicit dependency clauses count; arbitrary mentions are not blockers.
function dependencies(text, repository) {
  const refs = new Set();
  for (const line of (text ?? '').split('\n')) {
    const clause = /\b(?:blocked by|depends on|waiting (?:on|for)|waits (?:on|for))\b(.*)/i.exec(line);
    if (!clause) continue;
    for (const m of clause[1].split(';')[0].matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|\b([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)/g)) {
      refs.add(keyOf(m[1] ?? m[3] ?? repository, m[2] ?? m[4] ?? m[5]));
    }
  }
  if (refs.size > 10) throw new Error('issue eligibility exceeds 10 dependencies');
  return [...refs];
}

// `cleared`: a triage run answered that the merged pull request did not do
// it all (readTriage), so that is no reason to skip it.
async function eligibility(post, key, brief = '', get, board = {}, cleared = false) {
  const [repository, number] = key.split('#');
  const [owner, name] = repository.split('/');
  const out = await post({ query: ELIGIBILITY_QUERY, variables: { owner, name, number: Number(number) } });
  const issue = out.data?.repository?.issue;
  if (out.errors?.length || !issue || !issue.labels?.nodes || !issue.subIssues
      || !issue.closedByPullRequestsReferences?.nodes || !issue.timelineItems?.nodes || !issue.blockedBy?.nodes) throw new Error('issue eligibility not readable');
  const refs = issue.closedByPullRequestsReferences;
  if (!issue.projectItems?.nodes || issue.projectItems.pageInfo?.hasNextPage !== false) {
    throw new Error('issue eligibility board metadata not readable in full');
  }
  if (issue.projectItems.nodes.some(i => i.project?.number === board.project
      && i.project?.owner?.login?.toLowerCase() === board.owner?.toLowerCase() && i.status?.name === 'Blocked')) {
    return 'blocked by coordinator plan (board Status: Blocked)';
  }
  if (issue.labels.pageInfo?.hasNextPage !== false || refs.pageInfo?.hasNextPage !== false
      || issue.timelineItems.pageInfo?.hasNextPage !== false || issue.blockedBy.pageInfo?.hasNextPage !== false) {
    throw new Error('issue eligibility exceeds 100 labels, closing references, cross-references or blockers');
  }
  if (issue.state !== 'OPEN') return 'not open';
  if (issue.subIssues.totalCount > 0) return 'umbrella: has sub-issues';
  // needs-human: a person's, as readOutcome's attempts ran out.
  const label = issue.labels.nodes.find(l => ['epic', 'question', 'needs-human'].includes(l.name.toLowerCase()));
  if (label) return `labelled ${label.name.toLowerCase()}`;
  const crossed = issue.timelineItems.nodes.map(e => e.source)
    .filter(p => p?.repository?.owner?.login?.toLowerCase() === owner.toLowerCase());
  const open = [...refs.nodes, ...crossed].find(p => p.state === 'OPEN');
  if (open) return `PR open: ${shortRef(open.url)}`;
  const merged = [...refs.nodes, ...crossed.filter(p => madeFor(p.body, key, p.repository?.nameWithOwner))].find(p => p.merged);
  if (merged && !cleared) return `${PROBABLY_DONE}${shortRef(merged.url)}; close it?`;
  const blocked = issue.blockedBy.nodes.find(i => i.state === 'OPEN');
  if (blocked) return `blocked by ${shortRef(blocked.url)}`;
  for (const ref of dependencies(`${issue.body ?? ''}\n${brief}`, repository)) {
    if (ref === key) continue;
    if (!get) throw new Error('issue eligibility dependency reader missing');
    const [repo, n] = ref.split('#');
    const dependency = await get(`/repos/${repo}/issues/${n}`);
    if (!['open', 'closed'].includes(dependency?.state)) throw new Error('issue eligibility dependency not readable');
    if (dependency.state === 'open') return `blocked by ${ref}`;
  }
  // Plans have no branch input today. A planner can name its intended branch
  // explicitly in the brief; match only that exact head, never a fuzzy title.
  const branches = [...brief.matchAll(/\bbranch\s*[:=]\s*`?([\w./-]+)/gi)];
  if (branches.length > 10) throw new Error('issue eligibility exceeds 10 branches');
  for (const [, branch] of branches) {
    if (!get) throw new Error('issue eligibility branch reader missing');
    const pulls = await get(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
    if (!Array.isArray(pulls)) throw new Error('issue eligibility branch not readable');
    if (pulls.length) return `PR open: ${shortRef(pulls[0].html_url)}`;
    const ref = await get(`/repos/${repository}/git/matching-refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}?per_page=100`);
    if (!Array.isArray(ref)) throw new Error('issue eligibility branch not readable');
    if (ref.length >= 100) throw new Error('issue eligibility exceeds 100 matching branches');
    if (ref.some(r => r.ref === `refs/heads/${branch}`)) return `PR open: ${repository} (branch ${branch})`;
  }
  return null;
}

async function main(argv) {
  const unknown = argv.filter(a => a !== '--apply');
  if (unknown.length) throw new Error(`usage: schedule.cjs [--apply] (unknown: ${unknown.join(' ')})`);
  let apply = argv.includes('--apply');
  const token = process.env.GH_TOKEN;
  const bin = process.env.AGENT_BOARD;
  if (!token || !bin) throw new Error('GH_TOKEN (the planner\'s token) and AGENT_BOARD (the binary) are required');
  // A run started while the broker is out fails at once (#603); preview.
  if (apply) {
    const held = await heldBy({ token, repo: process.env.GITHUB_REPOSITORY, login: POLL.author, api: request, log: console.log });
    if (held) { console.log(`held: broker outage ${held.url}`); apply = false; }
  }
  const dispatchToken = process.env.DISPATCH_TOKEN || token;
  // Required here, not above: epics.cjs takes loadConfig from this module.
  const { census, loadEpicsConfig } = require('./epics.cjs');
  const config = loadEpicsConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const log = line => console.log(apply ? line : `[dry-run] ${line}`);

  const get = p => request(token, 'GET', p);
  const { entries, note } = await census(get, body => request(token, 'POST', '/graphql', body), config);
  const { items: epicItems, live, unread } = candidates(entries, config.epicsRepository);
  // An epic not read may be live, and a board the token lost would leave
  // every epic so: that fails the pass, after what could be read is done,
  // rather than pass as an idle one. So do epics past the census's bound,
  // which anyone who may label an older issue `epic` could push the
  // operator's out of.
  const failed = entries.filter(e => e.error).map(e => `${config.epicsRepository}#${e.number}: ${e.error}`);
  const unreadNote = (unread ? `; ${unread} epic(s) not read (${failed.slice(0, 3).join(' | ').slice(0, 1000)})` : '')
    + (note ? `; ${note}` : '');
  // Fill mode (tracker#672): with `schedule.fill` on and the plan pool
  // under its pace, issues outside any epic are candidates too. Neither an
  // unreadable pace nor a repository not read fails the pass: fill mode is
  // only what is left over, and the line says why it is off.
  let pace = null;
  let fill = [];
  if (config.fill) {
    const gql = body => request(token, 'POST', '/graphql', body);
    pace = await readPace(gql, config.triagePool, Date.now())
      .catch(err => ({ fill: false, mode: `normal (usage not read: ${err.message.slice(0, 300)})` }));
    const answers = [];
    for (const repository of pace.fill ? config.followed : []) {
      const [owner, name] = repository.split('/');
      try {
        const out = await gql({ query: FILL_QUERY, variables: { owner, name, field: config.priorityField } });
        const nodes = out.data?.repository?.issues?.nodes;
        if (out.errors?.length || !Array.isArray(nodes)) throw new Error('open issues not readable');
        answers.push({ repository, nodes });
      } catch (err) {
        log(`fill: ${repository} not read: ${err.message.slice(0, 300)}`);
      }
    }
    const taken = new Set([...epicItems.map(i => keyOf(i.repository, i.number)), ...entries.map(e => keyOf(config.epicsRepository, e.number))]);
    if (config.statusRepository) taken.add(keyOf(config.statusRepository, config.statusIssue));
    fill = fillItems(answers, config, taken);
    log(`mode: ${pace.mode}${pace.fill ? `; ${fill.length} issue(s) outside any epic, taken after the epics' by board ${config.priorityField}, then age` : ''}`);
  }
  const items = [...epicItems, ...fill];
  if (!live && !fill.length) {
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
  log(`${epicItems.length} open sub-issue(s) of ${live} live epic(s)${unreadNote}, taken ${order(config.priorityField)};`
    + ` ${state.inFlight} of ${config.wip} run(s) in flight;`
    + ` accepted implement plans only${pace?.fill ? ', and triage and research ones' : ''}; items of ${config.followed.size} followed repositories only`);

  // The record is written before the run is dispatched, so a pass cut off
  // between the two does not ask twice; a dispatch that fails takes it back.
  const triageStep = async (step, item) => {
    if (step.action === 'close') {
      // Closed first: a comment saying so on an issue left open would read
      // as reopened. If the comment fails, the answer on the issue is the evidence.
      await request(token, 'PATCH', issuePath(item), { state: 'closed', state_reason: 'completed' });
      await request(token, 'POST', `${issuePath(item)}/comments`,
        { body: `${closedLine(step.request)}\nBoard scheduler: closed, as a triage run found this done: ${step.evidence}. Reopen it if that is wrong.` });
      return;
    }
    const id = crypto.randomUUID();
    const rec = await request(token, 'POST', `${issuePath(item)}/comments`, { body: triageRecord(id, step, item.body) });
    if (step.action === 'design') return;
    try {
      const { default_branch: ref } = await request(dispatchToken, 'GET', `/repos/${config.caller}`);
      await request(dispatchToken, 'POST', `/repos/${config.caller}/actions/workflows/${config.workflow}/dispatches`, { ref, inputs: {
        kind: 'triage', repo: item.repository, item: String(item.number), pool: config.triagePool, task: triageTask(config, item, id, step.pull) } });
    } catch (err) {
      await request(token, 'DELETE', `/repos/${item.repository}/issues/comments/${rec.id}`).catch(() => {});
      throw err;
    }
  };
  // What decide makes of a recorded plan's run (readOutcome).
  const outcomeStep = async (step, item) => {
    const at = issuePath(item);
    if (step.action === 'done') {
      // Closed first, as on a done answer; the comment's first line keeps a
      // reopened issue from being closed again for the same run.
      await request(token, 'PATCH', at, { state: 'closed', state_reason: 'completed' });
      await request(token, 'POST', `${at}/comments`,
        { body: `${doneLine(step.runId)}\nBoard scheduler: closed, as the pull request of [its run](${step.run}) merged: ${step.pull}. Reopen it if that is wrong.` });
      return;
    }
    if (step.action === 'needs-human') {
      await request(token, 'POST', `${at}/labels`, { labels: ['needs-human'] });
      return;
    }
    if (step.action === 'block') {
      await request(token, 'POST', `${at}/dependencies/blocked_by`, { issue_id: step.blocker.id });
      return;
    }
    // A retry: a record of the same plan, as agent-board writes one, with
    // this job's retry line, so the plan stays held whatever happens next;
    // then the old record loses its marker, as agent-board frees one; then
    // the run, with the brief and why it is run again.
    const { found, retry } = step;
    const lines = found.record.body.split('\n');
    const rec = await request(token, 'POST', `${at}/comments`, { body: `${lines[0].trimEnd()}\n<!-- schedule-retry/v1: ${found.commentId} -->\n`
      // The last run by its number, not its link, which names this record's run.
      + `Board scheduler: dispatching the plan in ${found.plan} again, attempt ${retry.attempt} of ${retry.of}, as its last run, ${retry.runId}, ended without a merged pull request.` });
    const edit = text => request(token, 'PATCH', `/repos/${item.repository}/issues/comments/${rec.id}`, { body: `${rec.body} ${text}` });
    await request(token, 'PATCH', `/repos/${item.repository}/issues/comments/${found.record.id}`,
      { body: `${lines.slice(1).join('\n')}\n\nBoard scheduler: superseded by ${rec.html_url}.` });
    const task = `${found.brief}\n\nThis is attempt ${retry.attempt} of ${retry.of}. The last run, ${retry.run}, ended without a merged pull request; its status: ${retry.reason}`;
    const body = { ref: found.dispatchBody.ref, inputs: { ...found.dispatchBody.inputs, task } };
    const url = `/repos/${config.caller}/actions/workflows/${config.workflow}/dispatches`;
    let started;
    try {
      // The run's id comes back only where the API knows return_run_details,
      // as agent-board asks for it; without it the next pass knows no run.
      started = await request(dispatchToken, 'POST', url, { ...body, return_run_details: true })
        .catch(err => (/HTTP 422/.test(err.message) ? request(dispatchToken, 'POST', url, body) : Promise.reject(err)));
    } catch (err) {
      // Held as agent-board holds an ambiguous dispatch: not tried again.
      await edit(`It was not dispatched, or not knowingly (${err.message.slice(0, 300)}); edit or replace the plan to dispatch it.`).catch(() => {});
      throw err;
    }
    const id = started?.workflow_run_id;
    await edit(Number.isSafeInteger(id) ? `[run](https://github.com/${config.caller}/actions/runs/${id}).` : 'GitHub named no run.');
  };
  const ended = async found => {
    const [repo, n] = found.target.split('#');
    return readOutcome(get, config, found, found.target === found.self ? found.comments : await paged(token, `/repos/${repo}/issues/${n}/comments`));
  };
  const byName = new Map(items.map(i => [`${i.repository}#${i.number}`, i]));
  let errors = 0;
  const issuePath = item => `/repos/${item.repository}/issues/${item.number}`;
  const triaged = async item => readTriage(await paged(token, `${issuePath(item)}/comments`), [config.operator, config.planner], item.body);
  // Each step is taken as it is decided, so a pass the job's timeout stops
  // has still started what it got to, the items ranked first.
  const steps = await decide(items, state, { ...config, filling: Boolean(pace?.fill) }, item => probePlan(bin, config, token, item), pullFor,
    (key, brief, cleared) => eligibility(body => request(token, 'POST', '/graphql', body), key, brief, get, config, cleared), async step => {
      const item = byName.get(step.item);
      // Each line names the epic its item was taken from.
      const name = `${step.item} (${item.fill ? 'outside any epic' : `epic ${item.epic}`})`;
      if (step.quiet) return;
      if (step.action === 'skip' || !apply) {
        log(`${name} ${step.action}: ${step.reason}`);
        return;
      }
      if (step.action !== 'dispatch') {
        try {
          await (['done', 'needs-human', 'block', 'retry'].includes(step.action) ? outcomeStep : triageStep)(step, item);
          log(`${name} ${step.action}: ${step.reason}`);
        } catch (err) {
          errors++;
          log(`${name} ${step.action} error: ${err.message.slice(0, 2500)}`);
        }
        return;
      }
      try {
        // agent-board records the plan on the issue before it sends, and
        // refuses one recorded already, so a plan starts one run however
        // many passes see it.
        const { stdout } = agentBoard(bin, ['dispatch', item.url, '--apply', ...dispatchArgs(config, step.batch !== false)],
          { env: { GH_TOKEN: token, DISPATCH_TOKEN: dispatchToken }, timeoutMs: config.timeoutMs });
        log(`${name} dispatch: ${step.reason}; ${stdout.trim().split('\n').join(', ')}`);
      } catch (err) {
        const last = String(err.stderr ?? '').trim().split('\n').at(-1);
        if (RECORDED_RE.test(last)) { log(`${name} skip: ${last}`); return; }
        errors++;
        log(`${name} ${step.action} error: ${err.message}`);
      }
    }, triaged, ended);
  const idle = idleLine(steps, config.wip - state.inFlight, pace?.mode);
  if (idle) log(idle);
  if (errors || unread || note) throw new Error(`${errors} step(s) failed, ${unread} epic(s) could not be read${note ? `, ${note}` : ''}`);
}

module.exports = { FILL_QUERY, RUN_TITLE_RE, STATUS_END, STATUS_REASON, agentBoard, batchReleased, candidates, decide, eligibility, fillItems, findRecord, idleLine, loadConfig, main, openPullRefs, paceMode, planInterval, probePlan, pullIssues, rank, readDryRun, readOutcome, readPace, readRefusal, readRuns, readTriage, triageRecord, triageTask };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`schedule: ${err.message}`); process.exit(1); });
}
