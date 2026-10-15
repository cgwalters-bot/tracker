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
// Without a plan it is skipped. Candidates are taken by
// their epic's `schedule.priorityField` on the board, then their own, P0
// first, then oldest first. No step starts once `schedule.wip` dispatch.yml
// runs are in flight, counting those already going. A dry run, the
// default, only reads: `--apply` is passed by the workflow only where the
// repository variable says so.
// Standard library and the agent-board binary; `decide` and its helpers are
// pure and are what schedule.test.cjs covers.
'use strict';

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
// job's timeout stops it partway down a long board.
async function decide(items, { inFlight, busy: running }, { wip, followed, statusIssue, statusRepository }, probe, pullFor,
  inspect = async () => null, act = async () => {}) {
  let free = wip - inFlight;
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
    const skip = reason => push({ item: name, action: 'skip', reason });
    const key = keyOf(item.repository, item.number);
    if (!isFollowed(key)) { await skip('not a followed repository'); continue; }
    if (item.content_kind !== 'issue') { await skip('not an issue'); continue; }
    if (statusRepository && key === keyOf(statusRepository, statusIssue)) { await skip('coordinator status issue'); continue; }
    if (item.status === 'Blocked') { await skip('blocked by coordinator plan (board Status: Blocked)'); continue; }
    let found;
    try {
      const holding = await held(key);
      if (holding) { await skip(holding); continue; }
      if (free <= 0) { await skip(`work-in-progress cap of ${wip} reached`); continue; }
      const ineligible = await inspect(key);
      if (ineligible) { await skip(ineligible); continue; }
      found = await probe(item);
      if (found.none) { await skip('no plan'); continue; }
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
          ? 'coordinator status issue' : await inspect(found.target, found.brief);
        if (targetIneligible) { await skip(`its plan's ${found.target}: ${targetIneligible}`); continue; }
      }
    } catch (err) {
      await skip(`could not be read: ${err.message.slice(0, 2500)}`);
      continue;
    }
    await push({ item: name, action: 'dispatch', reason: `plan ${found.plan}` });
    busy.set(found.target, 'started in this pass');
    busy.set(key, 'started in this pass');
    free--;
  }
  return steps;
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
  return { ...found, brief: JSON.parse(run.stdout).body.inputs.task,
    recorded: findRecord(comments, [config.operator, config.planner], found.commentId) };
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
        state merged url repository { owner { login } }
      } } } } pageInfo { hasNextPage }
    }
  } }
}`;

const shortRef = url => url.replace('https://github.com/', '').replace(/\/(?:pull|issues)\//, '#');

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

async function eligibility(post, key, brief = '', get, board = {}) {
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
  const pulls = [...refs.nodes, ...issue.timelineItems.nodes.map(e => e.source)
    .filter(p => p?.repository?.owner?.login?.toLowerCase() === owner.toLowerCase())];
  const open = pulls.find(p => p.state === 'OPEN');
  if (open) return `PR open: ${shortRef(open.url)}`;
  const merged = pulls.find(p => p.merged);
  if (merged) return `probably done by ${shortRef(merged.url)}; close it?`;
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

  const byName = new Map(items.map(i => [`${i.repository}#${i.number}`, i]));
  let errors = 0;
  // Each step is taken as it is decided, so a pass the job's timeout stops
  // has still started what it got to, the items ranked first.
  await decide(items, state, config, item => probePlan(bin, config, token, item), pullFor,
    (key, brief) => eligibility(body => request(token, 'POST', '/graphql', body), key, brief, get, config), async step => {
      const item = byName.get(step.item);
      // Each line names the epic its item was taken from.
      const name = `${step.item} (epic ${item.epic})`;
      if (step.action === 'skip' || !apply) {
        log(`${name} ${step.action}: ${step.reason}`);
        return;
      }
      try {
        // agent-board records the plan on the issue before it sends, and
        // refuses one recorded already, so a plan starts one run however
        // many passes see it.
        const { stdout } = agentBoard(bin, ['dispatch', item.url, '--apply', ...dispatchArgs(config)],
          { env: { GH_TOKEN: token, DISPATCH_TOKEN: dispatchToken }, timeoutMs: config.timeoutMs });
        log(`${name} dispatch: ${step.reason}; ${stdout.trim().split('\n').join(', ')}`);
      } catch (err) {
        const last = String(err.stderr ?? '').trim().split('\n').at(-1);
        if (RECORDED_RE.test(last)) { log(`${name} skip: ${last}`); return; }
        errors++;
        log(`${name} ${step.action} error: ${err.message}`);
      }
    });
  if (errors || unread || note) throw new Error(`${errors} step(s) failed, ${unread} epic(s) could not be read${note ? `, ${note}` : ''}`);
}

module.exports = { agentBoard, candidates, decide, eligibility, findRecord, loadConfig, main, openPullRefs, probePlan, rank, readDryRun, readRefusal, readRuns };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`schedule: ${err.message}`); process.exit(1); });
}
