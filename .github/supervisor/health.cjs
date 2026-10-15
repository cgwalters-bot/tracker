'use strict';

// No actor is called here. In particular, never use poll --apply to gather facts.
const fs = require('node:fs');
const settings = require('../poll/agent-board.json');
const config = require('./config.json');
const { census, loadEpicsConfig, readComments, operatorComments } = require('../poll/epics.cjs');
const { record } = require('../poll/coordinator.cjs');

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
};

function evaluate(snapshot, now = Date.now(), cfg = config) {
  const age = date => (now - Date.parse(date)) / 3600000;
  return Object.entries(actions).map(([id, action]) => {
    const data = snapshot[id];
    if (!data || data.error) return { id, status: 'warn', evidence: [], suggested_action: `Observation unavailable or incomplete; ${action}` };
    let bad = [];
    switch (id) {
      case 'poll': {
        const completed = data.items.filter(r => r.status === 'completed');
        const failures = completed.slice(0, cfg.pollFailures);
        bad = failures.length === cfg.pollFailures && failures.every(r => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) ? failures : [];
        break;
      }
      case 'runs': bad = data.items.filter(r => r.status !== 'completed' && age(r.run_started_at || r.created_at) * 60 > cfg.runTimeoutMinutes); break;
      case 'broker': bad = data.items.slice(0, 1).filter(r => r.conclusion !== 'success' || age(r.updated_at) * 60 > cfg.probeStaleMinutes); break;
      case 'epics': bad = data.items.filter(e => e.missing || e.failures >= cfg.epicFailures || (e.pending && age(e.pending.at) > cfg.epicStaleHours)); break;
      case 'dispatch': bad = data.items.filter(i => i.state === 'closed' || i.hasPR || i.umbrella); break;
      case 'queue': case 'dependabot': bad = data.items.filter(e => e.event === 'removed_from_merge_queue' && age(e.created_at) <= cfg.eventLookbackHours); break;
      case 'approved': bad = data.items.filter(p => p.approvedAt && age(p.approvedAt) > cfg.approvedWaitHours); break;
      case 'infrastructure': bad = data.items.filter(p => p.infrastructure); break;
      case 'decisions': bad = data.items.filter(i => age(i.created_at) > cfg.decisionWaitHours); break;
      case 'release': bad = data.items.filter(i => i.latest !== i.pin); break;
    }
    if (id === 'broker' && !data.items.length) return { id, status: 'warn', evidence: [], suggested_action: actions[id] };
    return { id, status: bad.length ? (id === 'infrastructure' || bad.every(i => i.missing) ? 'warn' : 'fail') : 'ok', evidence: [...new Set(bad.map(i => i.html_url).filter(Boolean))], suggested_action: bad.length ? action : 'None.' };
  });
}

async function collect(token, cfg = config, policy = settings, clock = Date.now) {
  let requests = 0;
  const deadline = clock() + cfg.collectionTimeoutSeconds * 1000;
  const api = async (method, path, body) => {
    // Oversized censuses and stalled API calls must not exhaust the runner.
    const remaining = deadline - clock();
    if (++requests > cfg.maxRequests || remaining <= 0) throw new Error('collection budget exhausted');
    const response = await fetch(`https://api.github.com${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.min(cfg.requestTimeoutSeconds * 1000, remaining)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const get = path => api('GET', path);
  const post = body => api('POST', '/graphql', body); // Queries only, via census helpers.
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
  const root = `/repos/${policy.dispatchRepo}`;
  await capture('poll', () => list(`${root}/actions/workflows/${cfg.pollWorkflow}/runs?branch=${encodeURIComponent(process.env.DEFAULT_BRANCH)}`, true));
  await capture('runs', async () => {
    const result = [];
    for (const status of ['in_progress', 'queued', 'waiting', 'pending']) result.push(...await list(`${root}/actions/runs?status=${status}`));
    return result;
  });
  await capture('broker', () => list(`${root}/actions/workflows/${cfg.probeWorkflow}/runs?branch=${encodeURIComponent(process.env.DEFAULT_BRANCH)}`, true));
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
  // Cache only reads, not errors shared by unrelated checks. Queue history is
  // bounded by time before fetching per-PR details, not just by a page of PRs.
  const cache = new Map();
  const cachedList = (path, sample = false) => {
    if (!cache.has(path)) cache.set(path, list(path, sample));
    return cache.get(path);
  };
  const readPulls = async (openOnly, detail) => {
    const result = [];
    for (const repo of policy.follow) {
      const pulls = await cachedList(`/repos/${repo}/pulls?state=${openOnly ? 'open' : 'all'}&sort=updated&direction=desc`, !openOnly);
      if (!openOnly && pulls.length === cfg.pageSize && Date.parse(pulls.at(-1).updated_at) > clock() - cfg.eventLookbackHours * 3600000) throw new Error('recent PRs truncated');
      for (const p of pulls) {
        if (!openOnly && Date.parse(p.updated_at) < clock() - cfg.eventLookbackHours * 3600000) continue;
        result.push(...await detail(p, repo));
      }
    }
    return result;
  };
  for (const id of ['queue', 'dependabot', 'approved', 'infrastructure', 'dispatch']) {
    await capture(id, async () => {
      if (id === 'approved') return readPulls(true, async (p, repo) => {
        const reviews = await cachedList(`/repos/${repo}/pulls/${p.number}/reviews`);
        // COMMENTED does not revoke approval. A newer request for changes does.
        const latest = new Map();
        for (const r of reviews) if ([policy.operator, policy.bot].includes(r.user?.login) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
        const approval = [...latest.values()].find(r => r.state === 'APPROVED' && r.commit_id === p.head.sha);
        return [{ ...p, approvedAt: approval?.submitted_at }];
      });
      if (id === 'infrastructure') {
        // Temporal correlation is evidence to inspect, not proof of causation.
        // Never classify an outage from issue or log prose someone can edit.
        if (snapshot.broker.error) throw new Error('probe unavailable');
        return readPulls(true, async (p, repo) => {
          if (!p.labels.some(l => l.name === 'needs-human')) return [];
          const events = await cachedList(`/repos/${repo}/issues/${p.number}/timeline`);
          return [{ html_url: p.html_url, infrastructure: events.some(e => e.event === 'labeled' && e.label?.name === 'needs-human' && snapshot.broker.items.some(r => r.conclusion === 'failure' && Date.parse(r.created_at) <= Date.parse(e.created_at) && Date.parse(r.updated_at) >= Date.parse(e.created_at))) }];
        });
      }
      if (id !== 'dispatch') return readPulls(false, async (p, repo) => {
        if (id === 'dependabot' && !policy.mergeAuthors.includes(p.user?.login)) return [];
        return (await cachedList(`/repos/${repo}/issues/${p.number}/timeline`)).map(e => ({ ...e, html_url: p.html_url }));
      });
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
  }
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
  return snapshot;
}

async function main() {
  const checks = evaluate(await collect(process.env.GH_TOKEN));
  fs.writeFileSync('health.json', JSON.stringify(checks, null, 2) + '\n');
  // Only fixed strings reach Markdown; remote titles and private decision text do not.
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, checks.map(c => `${c.id}: ${c.status} — ${c.suggested_action}\n`).join(''));
}

module.exports = { evaluate, collect };

if (require.main === module) main().catch(() => { console.error('supervisor: health collection failed'); process.exitCode = 1; });
