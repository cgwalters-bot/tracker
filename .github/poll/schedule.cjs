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
        repository: s.repository, number: s.number, content_kind: 'issue', url: s.url, priority: s.priority, body: s.body,
        created: s.created, status: s.status, epic: `${repository}#${epic.number}`, epicPriority: epic.priority,
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
// the config's `wip`, `followed` and status issue. `inspect(key)` says why an
// issue is not to be worked on, if it is not. `act(step)` is called with each
// step as it is decided, so that what a pass has decided is done even if the
// job's timeout stops it partway down a long board. `triaged(item)` is
// readTriage's answer for an item, asked only with `triage` on.
async function decide(items, { inFlight, busy: running }, { wip, followed, statusIssue, statusRepository, triage = 0 }, probe, pullFor,
  inspect = async () => null, act = async () => {}, triaged = async () => null) {
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
    const skip = (reason, quiet) => push({ item: name, action: 'skip', reason, ...(quiet ? { quiet } : {}) });
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
    let found, unbatched, cleared = false;
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
      found = await probe(item);
      if (found.none) {
        if (!triage) { await skip('no plan'); continue; }
        if (record === undefined) record = await triaged(item);
        if (!record) { await ask('no plan'); continue; }
        if (!await answered(record)) await skip(`no plan since triage answered ${record.verdict}, ${record.url}`, true);
        continue;
      }
      if (!found.plan) { await skip(`plan refused: ${found.refused}`); continue; }
      if (found.recorded) { await skip(`plan ${found.plan} was dispatched already, ${found.recorded}`); continue; }
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
      if (found.kind !== 'implement') { await skip(`plan ${found.plan} is for ${found.kind}, which is dispatched by hand`); continue; }
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
      for (const extra of found.extras ?? []) {
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
    await push(unbatched
      ? { item: name, action: 'dispatch', reason: `plan ${found.plan}; alone, as batched ${unbatched}`, batch: false }
      : { item: name, action: 'dispatch', reason: `plan ${found.plan}` });
    busy.set(found.target, 'started in this pass');
    busy.set(key, 'started in this pass');
    // A batched run holds its extras too; with --apply their records say so
    // as well, but a dry run writes none.
    if (!unbatched) for (const extra of found.extras ?? []) busy.set(extra, `batched with ${name} in this pass`);
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
// names and links left out.
function idleLine(steps, free) {
  if (free <= 0 || steps.some(s => s.action === 'dispatch' || s.action === 'triage')) return null;
  const counts = new Map();
  for (const s of steps.filter(s => s.action === 'skip')) {
    const why = s.reason.replace(/https:\/\/\S+/g, '').replace(/[\w.-]+\/[\w.-]+#\d+/g, '#N').split(/[,:;(]/)[0].replace(/\s+/g, ' ').trim();
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  const by = [...counts].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${why} ${n}`).join(', ');
  return `idle: ${free} slot(s) free and nothing started${by ? `; skipped: ${by}` : ''}`;
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
  return { ...found, brief,
    recorded: await findRecord(comments, [config.operator, config.planner], found.commentId, self, released) };
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
  const label = issue.labels.nodes.find(l => ['epic', 'question'].includes(l.name.toLowerCase()));
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
    + ` accepted implement plans only; items of ${config.followed.size} followed repositories only`);

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
  const byName = new Map(items.map(i => [`${i.repository}#${i.number}`, i]));
  let errors = 0;
  const issuePath = item => `/repos/${item.repository}/issues/${item.number}`;
  const triaged = async item => readTriage(await paged(token, `${issuePath(item)}/comments`), [config.operator, config.planner], item.body);
  // Each step is taken as it is decided, so a pass the job's timeout stops
  // has still started what it got to, the items ranked first.
  const steps = await decide(items, state, config, item => probePlan(bin, config, token, item), pullFor,
    (key, brief, cleared) => eligibility(body => request(token, 'POST', '/graphql', body), key, brief, get, config, cleared), async step => {
      const item = byName.get(step.item);
      // Each line names the epic its item was taken from.
      const name = `${step.item} (epic ${item.epic})`;
      if (step.quiet) return;
      if (step.action === 'skip' || !apply) {
        log(`${name} ${step.action}: ${step.reason}`);
        return;
      }
      if (step.action !== 'dispatch') {
        try {
          await triageStep(step, item);
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
    }, triaged);
  const idle = idleLine(steps, config.wip - state.inFlight);
  if (idle) log(idle);
  if (errors || unread || note) throw new Error(`${errors} step(s) failed, ${unread} epic(s) could not be read${note ? `, ${note}` : ''}`);
}

module.exports = { agentBoard, batchReleased, candidates, decide, eligibility, findRecord, idleLine, loadConfig, main, openPullRefs, probePlan, pullIssues, rank, readDryRun, readRefusal, readRuns, readTriage, triageRecord, triageTask };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`schedule: ${err.message}`); process.exit(1); });
}
