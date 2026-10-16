'use strict';

// No actor is called here. In particular, never use poll --apply to gather facts.
const fs = require('node:fs');
const zlib = require('node:zlib');
const settings = require('../poll/agent-board.json');
const usage = require('../usage/config.json');
const config = require('./config.json');
const { census, loadEpicsConfig, readComments, operatorComments } = require('../poll/epics.cjs');
const { record } = require('../poll/coordinator.cjs');
const { RUN_TITLE_RE, STATUS_END, STATUS_REASON } = require('../poll/schedule.cjs');
const { findComment, previousSnapshot } = require('../usage/usage.cjs');

const actions = {
  poll: 'Inspect consecutive failed poll runs.',
  runs: 'Inspect the timeout and cancel only after checking the run.',
  broker: 'Inspect the broker probe and connectivity.',
  epics: 'Inspect coordinator checkpoints before retrying planning.',
  dispatch: 'Inspect the dispatch target before cancelling duplicate work.',
  queue: 'Inspect queue removal events and failed checks.',
  approved: 'Inspect merge requirements for the approved head.',
  infrastructure: 'Confirm an infrastructure outage before clearing needs-human.',
  dependabot: 'Inspect dependency queue failures.',
  decisions: 'Read and answer the outstanding decisions.',
  release: 'Review the release before updating the wrapper pin.',
  idle: 'Read the scheduler passes for why nothing starts with slots free.',
  stuck: 'Inspect plans skipped as dispatched already whose run has ended.',
  pace: 'Compare the pool\'s usage with the pace of its window.',
  failures: 'Inspect agent runs that failed for a reason that recurs.',
  held: 'Read the reason for the needs-human hold on the bot\'s pull request.',
  unqueued: 'Inspect approved, clean pull requests that are not in the merge queue.',
  unclosed: 'Inspect issues left open after their implement pull request merged.',
};

// A probe that is switched off (BROKER_OUTAGE unset) leaves skipped runs:
// no observation, which fails once it has lasted, like any other.
const probes = data => data.items.filter(r => r.conclusion !== 'skipped');

// An observation missing for an hour is a blind spot, not a transient: it
// fails, so the agent runs and asks for the access it lacks. Since when is
// carried in health.json from the previous pass (`previous`, from collect).
function unavailable(id, previous, now, cfg) {
  const carried = (Array.isArray(previous) ? previous : []).find(c => c?.id === id)?.unavailable_since;
  const at = Date.parse(carried);
  const since = at <= now ? new Date(at).toISOString() : new Date(now).toISOString();
  const status = now - Date.parse(since) >= cfg.unavailableFailHours * 3600000 ? 'fail' : 'warn';
  return { id, status, evidence: [], unavailable_since: since, suggested_action: `Observation unavailable or incomplete; ${actions[id]}` };
}

function evaluate(snapshot, now = Date.now(), cfg = config) {
  const age = date => (now - Date.parse(date)) / 3600000;
  return Object.entries(actions).map(([id, action]) => {
    const data = snapshot[id];
    if (!data || data.error || (id === 'broker' && !probes(data).length)) return unavailable(id, snapshot.previous?.items, now, cfg);
    let bad = [];
    switch (id) {
      case 'poll': {
        const completed = data.items.filter(r => r.status === 'completed');
        const failures = completed.slice(0, cfg.pollFailures);
        bad = failures.length === cfg.pollFailures && failures.every(r => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) ? failures : [];
        break;
      }
      case 'runs': bad = data.items.filter(r => r.status !== 'completed' && age(r.run_started_at || r.created_at) * 60 > cfg.runTimeoutMinutes); break;
      case 'broker': bad = probes(data).slice(0, 1).filter(r => r.conclusion !== 'success' || age(r.updated_at) * 60 > cfg.probeStaleMinutes); break;
      case 'epics': bad = data.items.filter(e => e.missing || e.failures >= cfg.epicFailures || (e.pending && age(e.pending.at) > cfg.epicStaleHours)); break;
      case 'dispatch': bad = data.items.filter(i => i.state === 'closed' || i.hasPR || i.umbrella); break;
      case 'queue': case 'dependabot': bad = data.items.filter(e => e.event === 'removed_from_merge_queue' && age(e.created_at) <= cfg.eventLookbackHours); break;
      case 'approved': bad = data.items.filter(p => p.approvedAt && age(p.approvedAt) > cfg.approvedWaitHours); break;
      case 'infrastructure': bad = data.items.filter(p => p.infrastructure); break;
      case 'decisions': bad = data.items.filter(i => age(i.created_at) > cfg.decisionWaitHours); break;
      case 'release': bad = data.items.filter(i => i.latest !== i.pin); break;
      // The newest scheduler passes, each idle or not: all of them idle.
      case 'idle': bad = data.items.length >= cfg.idlePasses && data.items.slice(0, cfg.idlePasses).every(p => p.idle) ? data.items.slice(0, cfg.idlePasses) : []; break;
      // The scheduler skips a recorded plan for ever (retries off): once its
      // run ended with its PR merged, or with none, nothing will start it.
      case 'stuck': bad = data.items.filter(s => s.ended && ['merged', 'none'].includes(s.pull)); break;
      // Used share of the window against the share of it elapsed, in points.
      case 'pace': bad = data.items.filter(p => {
        const window = p.window_minutes * 60000, left = Date.parse(p.resets_at) - now;
        return window > 0 && left > 0 && Math.abs(p.used_percent - 100 * Math.min(1, Math.max(0, 1 - left / window))) > cfg.paceMarginPercent;
      }); break;
      case 'failures': bad = data.items.filter(r => r.reason); break;
      // A hold whose time is not known has lasted at least as long as we can see.
      case 'held': bad = data.items.filter(p => !p.labeledAt || age(p.labeledAt) > cfg.holdWaitHours); break;
      case 'unqueued': bad = data.items.filter(p => p.approvedAt && p.clean && !p.queued && age(p.approvedAt) > cfg.unqueuedWaitHours); break;
      case 'unclosed': bad = data.items.filter(p => p.issueState === 'open' && age(p.mergedAt) > cfg.unclosedWaitHours); break;
    }
    // Bounded, so the agent's task stays inside the wrapper's limit.
    const evidence = [...new Set(bad.flatMap(i => [i.html_url, i.reason_url, i.issue_url, i.run_url]).filter(Boolean))].slice(0, cfg.maxEvidence);
    return { id, status: bad.length ? (id === 'infrastructure' || bad.every(i => i.missing) ? 'warn' : 'fail') : 'ok', evidence, suggested_action: bad.length ? action : 'None.' };
  });
}

// The one entry of an upload-artifact archive. Its local header leaves the
// sizes to a trailing descriptor, so they are read from the central directory.
function unzipEntry(zip, name, limit) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip archive');
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), n = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    if (zip.toString('utf8', at + 46, at + 46 + n) === name) {
      if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error('bad zip entry');
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0 && size <= limit) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: limit });
      throw new Error('unsupported zip entry');
    }
    at += 46 + n + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  throw new Error(`${name} not in the archive`);
}

// The scheduler's lines in a pass's log, after the runner's timestamp.
const LOG_LINE = /^\S+Z (?:\[dry-run\] )?(.*)$/;
const IDLE_RE = /^idle: \d+ slot\(s\) free and nothing started/;
const SKIP_RE = /^([\w.-]+\/[\w.-]+)#(\d+) \(epic [^)]*\) skip: plan https:\/\/\S+ was dispatched already, https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+#issuecomment-(\d+)$/;
const RECORD_START = '<!-- agent-board-dispatch: ';

const OPEN_PULLS = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  pullRequests(states: OPEN, first: 100) { pageInfo { hasNextPage } nodes {
    url isInMergeQueue mergeStateStatus author { __typename login }
    labels(first: 30) { nodes { name } }
    timelineItems(itemTypes: [LABELED_EVENT], last: 50) { nodes { ... on LabeledEvent { createdAt label { name } } } }
    comments(last: 10) { nodes { url author { login } } }
  } }
} }`;
const RECENT_PULLS = `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
  pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) { pageInfo { hasNextPage endCursor } nodes {
    url updatedAt mergedAt headRefName body author { __typename login }
    timelineItems(itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT], last: 10) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }
  } }
} }`;
// REST names an app `name[bot]`, GraphQL `name`.
const login = author => (author?.__typename === 'Bot' ? `${author.login}[bot]` : author?.login);

async function collect(token, cfg = config, policy = settings, clock = Date.now) {
  let requests = 0;
  const deadline = clock() + cfg.collectionTimeoutSeconds * 1000;
  // Oversized censuses and stalled API calls must not exhaust the runner.
  const budget = () => {
    const remaining = deadline - clock();
    if (++requests > cfg.maxRequests || remaining <= 0) throw new Error('collection budget exhausted');
    return AbortSignal.timeout(Math.min(cfg.requestTimeoutSeconds * 1000, remaining));
  };
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const api = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: budget() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  // Logs and artifacts redirect to a signed storage URL, followed by hand so
  // the token goes only to GitHub; a log of any size must not fill memory.
  const download = async path => {
    let response = await fetch(`https://api.github.com${path}`, { headers, redirect: 'manual', signal: budget() });
    if (response.status >= 300 && response.status < 400) response = await fetch(response.headers.get('location'), { signal: budget() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      if ((size += chunk.length) > cfg.maxDownloadBytes) throw new Error('download too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const get = path => api('GET', path);
  const post = body => api('POST', '/graphql', body); // Queries only, via census helpers.
  const query = async (text, variables) => {
    const result = await post({ query: text, variables });
    if (result.errors?.length || !result.data) throw new Error('GraphQL error');
    return result.data;
  };
  const list = async (path, sample = false) => {
    const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=${cfg.pageSize}`);
    const items = Array.isArray(data) ? data : data.workflow_runs;
    if (!items || (!sample && items.length >= cfg.pageSize)) throw new Error('snapshot truncated');
    return items;
  };
  const snapshot = {};
  const capture = async (id, fn) => {
    try { snapshot[id] = { items: await fn() }; } catch { snapshot[id] = { error: true }; }
  };
  // Cache only reads, not errors shared by unrelated checks.
  const cache = new Map();
  const once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const cachedList = (path, sample = false) => once(path, () => list(path, sample));
  const cachedGet = path => once(`get ${path}`, () => get(path));
  const root = `/repos/${policy.dispatchRepo}`;
  const branch = encodeURIComponent(process.env.DEFAULT_BRANCH);
  const lookback = () => clock() - cfg.eventLookbackHours * 3600000;

  // The previous pass's report, for how long an observation has been
  // missing: only this workflow's runs on the default branch upload it.
  await capture('previous', async () => {
    const { workflow_runs: runs } = await get(`${root}/actions/workflows/${cfg.supervisorWorkflow}/runs?branch=${branch}&per_page=5`);
    for (const run of runs.filter(r => r.id !== Number(process.env.GITHUB_RUN_ID)).slice(0, 3)) {
      const { artifacts } = await get(`${root}/actions/runs/${run.id}/artifacts?name=supervisor-health`);
      const artifact = artifacts.find(a => a.name === 'supervisor-health' && !a.expired);
      if (artifact) return JSON.parse(unzipEntry(await download(`${root}/actions/artifacts/${artifact.id}/zip`), 'health.json', cfg.maxDownloadBytes));
    }
    return [];
  });
  await capture('poll', () => list(`${root}/actions/workflows/${cfg.pollWorkflow}/runs?branch=${branch}`, true));
  await capture('runs', async () => {
    const result = [];
    for (const status of ['in_progress', 'queued', 'waiting', 'pending']) result.push(...await list(`${root}/actions/runs?status=${status}`));
    return result;
  });
  await capture('broker', () => list(`${root}/actions/workflows/${cfg.probeWorkflow}/runs?branch=${branch}`, true));
  await capture('epics', async () => {
    const c = await census(get, post, loadEpicsConfig(JSON.stringify(policy)));
    if (c.note || c.entries.some(e => e.error)) throw new Error('incomplete census');
    const result = [];
    for (const e of c.entries.filter(e => e.live)) {
      const comments = await readComments(post, policy.epics.repository, e.number);
      const checkpoint = record(comments, policy.bot);
      result.push({ ...checkpoint.state, missing: checkpoint.id === null, html_url: `https://github.com/${policy.epics.repository}/issues/${e.number}` });
    }
    return result;
  });
  const readPulls = async detail => {
    const result = [];
    for (const repo of policy.follow) {
      for (const p of await cachedList(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc`)) result.push(...await detail(p, repo));
    }
    return result;
  };
  // One query a repository for its open pull requests' queue, merge state,
  // labels and latest comments, instead of a request per pull request.
  const openPulls = () => once('open pulls', async () => {
    const result = [];
    for (const repo of policy.follow) {
      const [owner, name] = repo.split('/');
      const { pullRequests } = (await query(OPEN_PULLS, { owner, name })).repository;
      if (pullRequests.pageInfo.hasNextPage) throw new Error('open PRs truncated');
      result.push(...pullRequests.nodes);
    }
    return result;
  });
  // Pull requests updated within the lookback, newest first, read in pages
  // until one reaches past it. More than maxPages of them is incomplete.
  const recentPulls = () => once('recent pulls', async () => {
    const result = [];
    for (const repo of policy.follow) {
      const [owner, name] = repo.split('/');
      let after = null;
      for (let page = 0; ; page++) {
        if (page === cfg.maxPages) throw new Error('recent PRs truncated');
        const { pullRequests } = (await query(RECENT_PULLS, { owner, name, after })).repository;
        const recent = pullRequests.nodes.filter(p => Date.parse(p.updatedAt) >= lookback());
        result.push(...recent);
        if (!pullRequests.pageInfo.hasNextPage || recent.length < pullRequests.nodes.length) break;
        after = pullRequests.pageInfo.endCursor;
      }
    }
    return result;
  });
  // A pull request the queue merged is removed from it too, for that reason.
  const removals = pulls => pulls.flatMap(p => p.timelineItems.nodes.filter(e => !/^merged$/i.test(e.reason ?? ''))
    .map(e => ({ event: 'removed_from_merge_queue', created_at: e.createdAt, html_url: p.url })));
  await capture('queue', async () => removals(await recentPulls()));
  await capture('dependabot', async () => removals((await recentPulls()).filter(p => policy.mergeAuthors.includes(login(p.author)))));
  await capture('approved', () => readPulls(async (p, repo) => {
    const reviews = await cachedList(`/repos/${repo}/pulls/${p.number}/reviews`);
    // COMMENTED does not revoke approval. A newer request for changes does.
    const latest = new Map();
    for (const r of reviews) if ([policy.operator, policy.bot].includes(r.user?.login) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
    const approval = [...latest.values()].find(r => r.state === 'APPROVED' && r.commit_id === p.head.sha);
    return [{ ...p, approvedAt: approval?.submitted_at }];
  }));
  await capture('infrastructure', async () => {
    // Temporal correlation is evidence to inspect, not proof of causation.
    // Never classify an outage from issue or log prose someone can edit.
    if (snapshot.broker.error) throw new Error('probe unavailable');
    return readPulls(async (p, repo) => {
      if (!p.labels.some(l => l.name === 'needs-human')) return [];
      const events = await cachedList(`/repos/${repo}/issues/${p.number}/timeline`);
      return [{ html_url: p.html_url, infrastructure: events.some(e => e.event === 'labeled' && e.label?.name === 'needs-human' && snapshot.broker.items.some(r => r.conclusion === 'failure' && Date.parse(r.created_at) <= Date.parse(e.created_at) && Date.parse(r.updated_at) >= Date.parse(e.created_at))) }];
    });
  });
  await capture('dispatch', async () => {
    const runs = await list(`${root}/actions/workflows/${policy.dispatchWorkflow}/runs?status=in_progress`);
    const result = [];
    for (const run of runs) {
      const match = /^implement ([\w.-]+\/[\w.-]+)#(\d+)(?: |$)/.exec(run.display_title);
      if (!match || !policy.schedule.repositories.includes(match[1])) continue;
      const issue = await get(`/repos/${match[1]}/issues/${match[2]}`);
      const subs = await list(`/repos/${match[1]}/issues/${match[2]}/sub_issues`);
      const timeline = await list(`/repos/${match[1]}/issues/${match[2]}/timeline`);
      result.push({ state: issue.state, umbrella: subs.length > 0 || issue.labels.some(l => ['epic', 'question'].includes(l.name)), hasPR: timeline.some(e => e.source?.issue?.pull_request && e.source.issue.state === 'open'), html_url: run.html_url });
    }
    return result;
  });
  await capture('decisions', async () => {
    const issues = await list(`/repos/${policy.epics.repository}/issues?state=open&labels=question&assignee=${encodeURIComponent(policy.operator)}`);
    const unanswered = [];
    for (const i of issues.filter(i => !i.pull_request)) {
      if (!operatorComments(await readComments(post, policy.epics.repository, i.number), policy.operator).length) unanswered.push(i);
    }
    return unanswered;
  });
  await capture('release', async () => {
    const latest = await get(`/repos/${cfg.releaseRepository}/releases/latest`);
    const file = await get(`/repos/${cfg.wrapperRepository}/contents/${cfg.wrapperPath}`);
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    const pins = [...text.matchAll(new RegExp(`uses: ${cfg.releaseRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/workflows/(?:policy|check|apply)\\.yml@(v\\d+\\.\\d+\\.\\d+)`, 'g'))].map(m => m[1]);
    const pin = pins[0];
    if (pins.length !== 3 || pins.some(p => p !== pin)) throw new Error('unrecognized wrapper pin');
    return [{ pin, latest: latest.tag_name, html_url: latest.html_url }];
  });

  // The scheduler's newest passes: the job's log of each completed poll run
  // that ran it, the runner's colour codes taken out. A run cancelled while
  // waiting for the previous pass ran no scheduler and is passed over.
  const passes = () => once('passes', async () => {
    if (snapshot.poll.error) throw new Error('poll runs unavailable');
    const result = [];
    for (const run of snapshot.poll.items.filter(r => r.status === 'completed').slice(0, cfg.idlePasses + 3)) {
      const { jobs } = await get(`${root}/actions/runs/${run.id}/jobs?per_page=100`);
      const job = jobs.find(j => j.name === cfg.schedulerJob && j.status === 'completed' && ['success', 'failure'].includes(j.conclusion));
      if (!job) continue;
      const text = (await download(`${root}/actions/jobs/${job.id}/logs`)).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
      result.push({ html_url: run.html_url, lines: text.split('\n').map(l => LOG_LINE.exec(l.trimEnd())?.[1]).filter(Boolean) });
      if (result.length === cfg.idlePasses) break;
    }
    return result;
  });
  await capture('idle', async () => (await passes()).map(p => ({ idle: p.lines.some(l => IDLE_RE.test(l)), html_url: p.html_url })));
  // A recorded plan's run, as readOutcome finds it: the run the bot's record
  // links last; its pull request is the branch agentic-job names after it.
  const runOf = id => cachedGet(`${root}/actions/runs/${id}`);
  const pullOf = async (repo, id) => {
    const pulls = await get(`/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${cfg.implementBranchPrefix}${id}`)}`);
    return !pulls.length ? 'none' : pulls[0].merged_at ? 'merged' : pulls[0].state;
  };
  await capture('stuck', async () => {
    const [pass] = await passes();
    if (!pass) throw new Error('no scheduler pass');
    const skips = pass.lines.map(l => SKIP_RE.exec(l)).filter(Boolean);
    if (skips.length > cfg.maxItems) throw new Error('too many skips');
    const result = [];
    for (const [, , , repo, commentId] of skips) {
      const comment = await get(`/repos/${repo}/issues/comments/${commentId}`);
      if (comment.user?.login !== policy.bot || !comment.body?.startsWith(RECORD_START)) continue;
      const id = [...comment.body.matchAll(new RegExp(`https://github\\.com/${policy.dispatchRepo.replace(/\./g, '\\.')}/actions/runs/(\\d+)`, 'g'))].at(-1)?.[1];
      if (!id) continue;
      const run = await runOf(id);
      const title = RUN_TITLE_RE.exec(run.display_title ?? '');
      if (title?.[1] !== 'implement') continue;
      const ended = run.status === 'completed';
      result.push({ ended, pull: ended ? await pullOf(title[2], id) : null, html_url: comment.html_url, run_url: run.html_url });
    }
    return result;
  });
  // The usage snapshot usage.yml publishes, from the private repository its
  // config names. Only links reach health.json, never the numbers.
  await capture('pace', async () => {
    const comment = findComment(await list(`/repos/${usage.repo}/issues/${usage.issue}/comments`, true), usage.bot);
    const snap = previousSnapshot(comment?.body);
    if (!snap || !(Date.parse(snap.updated_at) >= clock() - cfg.usageStaleMinutes * 60000)) throw new Error('no fresh usage snapshot');
    return Object.values(snap.pools ?? {}).filter(Boolean).map(p => ({ used_percent: p.used_percent, window_minutes: p.window_minutes, resets_at: p.resets_at, html_url: comment.html_url }));
  });
  // dispatch.yml's runs started within the lookback, newest first: a
  // hundred a day or more, so read in pages, at most maxPages of them.
  const dispatchRuns = () => once('dispatch runs', async () => {
    const since = encodeURIComponent(`>=${new Date(lookback()).toISOString()}`);
    const result = [];
    for (let page = 1; ; page++) {
      if (page > cfg.maxPages) throw new Error('dispatch runs truncated');
      const runs = await list(`${root}/actions/workflows/${policy.dispatchWorkflow}/runs?created=${since}&page=${page}`, true);
      result.push(...runs);
      if (runs.length < cfg.pageSize) return result;
    }
  });
  // The newest run of each kind and target that failed, when its failed
  // jobs' annotations say why in a way that recurs on a run started again
  // unchanged. A newer run of the same kind and target supersedes it.
  await capture('failures', async () => {
    const runs = await dispatchRuns();
    const latest = new Map();
    for (const run of runs) {
      const title = RUN_TITLE_RE.exec(run.display_title ?? '');
      // By kind and target: the run name has a pool suffix only when one was given.
      const key = title && `${title[1]} ${title[2]}#${title[3]}`;
      if (title && !latest.has(key)) latest.set(key, { run, repo: title[2], number: title[3] });
    }
    const failed = [...latest.values()].filter(l => l.run.conclusion === 'failure');
    if (failed.length > cfg.maxItems) throw new Error('too many failed runs');
    const result = [];
    for (const { run, repo, number } of failed) {
      const { jobs } = await get(`${root}/actions/runs/${run.id}/jobs?per_page=100`);
      const messages = [];
      for (const job of jobs.filter(j => j.conclusion === 'failure')) {
        messages.push(...(await list(`${root}/check-runs/${job.id}/annotations`)).map(a => String(a.message)));
      }
      const text = messages.join('\n');
      let reason = /secret-shaped/i.test(text) ? 'secret' : /\bE\d{3}\b/.test(text) ? 'refused' : null;
      if (!reason && text.includes('required data was missing') && await closedBlocker(run, repo, number)) reason = 'blocker';
      result.push({ reason, html_url: run.html_url });
    }
    return result;
  });
  // Whether the reason of a run that handed back missing data names an
  // issue or pull request in a followed repository that is closed now: the
  // agentic-job status comment for the run, by who could have written it.
  async function closedBlocker(run, repo, number) {
    const authors = [policy.bot, 'github-actions[bot]'];
    const comments = await list(`/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(run.created_at)}`);
    const status = comments.find(c => authors.includes(c.user?.login) && String(c.body ?? '').endsWith(STATUS_END(run.id)));
    const cut = status?.body.indexOf(STATUS_REASON) ?? -1;
    if (cut < 0) return false;
    const named = [...status.body.slice(cut).matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g)]
      .filter(m => policy.follow.includes(m[1]) && !(m[1] === repo && m[2] === number)).slice(0, 3);
    for (const [, r, n] of named) if ((await cachedGet(`/repos/${r}/issues/${n}`)).state === 'closed') return true;
    return false;
  }
  await capture('held', async () => (await openPulls())
    .filter(p => login(p.author) === policy.bot && p.labels.nodes.some(l => l.name === 'needs-human'))
    .map(p => ({
      labeledAt: p.timelineItems.nodes.filter(e => e.label?.name === 'needs-human').at(-1)?.createdAt,
      html_url: p.url,
      reason_url: (p.comments.nodes.filter(c => c.author?.login === policy.bot).at(-1) ?? p.comments.nodes.at(-1))?.url,
    })));
  await capture('unqueued', async () => {
    if (snapshot.approved.error) throw new Error('approvals unavailable');
    const open = new Map((await openPulls()).map(p => [p.url, p]));
    return snapshot.approved.items.filter(p => p.approvedAt && open.has(p.html_url)).map(p => ({
      approvedAt: p.approvedAt, clean: open.get(p.html_url).mergeStateStatus === 'CLEAN', queued: open.get(p.html_url).isInMergeQueue, html_url: p.html_url,
    }));
  });
  // The bot's implement pull requests merged within the lookback, by the
  // branch agentic-job names after the run, whose run names the issue. One
  // that says it is part of the issue may leave it open; the scheduler asks
  // a triage run about those.
  await capture('unclosed', async () => {
    const pattern = new RegExp(`^${cfg.implementBranchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
    const merged = (await recentPulls()).filter(p => login(p.author) === policy.bot && p.mergedAt && pattern.test(p.headRefName) && !/^\s*part of\b/im.test(p.body ?? ''));
    const runs = new Map((await dispatchRuns()).map(r => [String(r.id), r]));
    const found = [];
    for (const p of merged) {
      // A run started before the lookback is read by itself.
      const id = pattern.exec(p.headRefName)[1];
      const title = RUN_TITLE_RE.exec((runs.get(id) ?? await runOf(id)).display_title ?? '');
      if (title?.[1] === 'implement') found.push({ p, repo: title[2], number: Number(title[3]) });
    }
    // The issues' states, fifty to a query rather than a request each.
    const result = [];
    for (let i = 0; i < found.length; i += 50) {
      const chunk = found.slice(i, i + 50);
      const text = `query(${chunk.map((_, k) => `$o${k}: String!, $n${k}: String!, $i${k}: Int!`).join(', ')}) {${
        chunk.map((_, k) => ` r${k}: repository(owner: $o${k}, name: $n${k}) { issue(number: $i${k}) { state url } }`).join('')} }`;
      const variables = Object.assign({}, ...chunk.map((f, k) => ({ [`o${k}`]: f.repo.split('/')[0], [`n${k}`]: f.repo.split('/')[1], [`i${k}`]: f.number })));
      const data = await query(text, variables);
      chunk.forEach(({ p }, k) => {
        const issue = data[`r${k}`]?.issue;
        if (issue) result.push({ mergedAt: p.mergedAt, issueState: issue.state.toLowerCase(), html_url: p.url, issue_url: issue.url });
      });
    }
    return result;
  });
  return snapshot;
}

async function main() {
  const checks = evaluate(await collect(process.env.GH_TOKEN));
  fs.writeFileSync('health.json', JSON.stringify(checks, null, 2) + '\n');
  // Only fixed strings reach Markdown; remote titles and private decision text do not.
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, checks.map(c => `${c.id}: ${c.status} — ${c.suggested_action}\n`).join(''));
}

module.exports = { evaluate, collect, unzipEntry };

if (require.main === module) main().catch(() => { console.error('supervisor: health collection failed'); process.exitCode = 1; });
