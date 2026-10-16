'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { evaluate, collect, unzipEntry } = require('./health.cjs');
const snapshots = require('./snapshots.json');
const config = require('./config.json');
const now = Date.parse(snapshots.now);

for (const [id, items] of Object.entries(snapshots).filter(([id]) => id !== 'now')) {
  test(`${id}: recorded reduced snapshot, healthy and unavailable observations`, () => {
    const evidence = 'https://github.com/example/project/issues/1';
    const result = evaluate({ [id]: { items: items.map(i => ({ ...i, html_url: evidence })) } }, now).find(c => c.id === id);
    assert.equal(result.status, id === 'infrastructure' ? 'warn' : 'fail');
    assert.deepEqual(result.evidence, [evidence]);
    assert.equal(evaluate({ [id]: { error: true } }, now).find(c => c.id === id).status, 'warn');
    const healthy = id === 'broker' ? [{ conclusion: 'success', updated_at: snapshots.now }] : [];
    assert.equal(evaluate({ [id]: { items: healthy } }, now).find(c => c.id === id).status, 'ok');
  });
}

test('threshold boundaries and stale probe', () => {
  const status = (id, items) => evaluate({ [id]: { items } }, now).find(c => c.id === id).status;
  assert.equal(status('poll', snapshots.poll.slice(1)), 'ok');
  assert.equal(status('poll', [{ status: 'completed', conclusion: 'success' }, ...snapshots.poll]), 'ok');
  assert.equal(status('runs', [{ status: 'in_progress', run_started_at: new Date(now - config.runTimeoutMinutes * 60000).toISOString() }]), 'ok');
  assert.equal(status('broker', [{ conclusion: 'success', updated_at: '2026-10-12T00:00:00Z' }]), 'fail');
  assert.equal(status('broker', [{ conclusion: 'skipped', updated_at: snapshots.now }]), 'warn');
  assert.equal(status('broker', [{ conclusion: 'skipped', updated_at: snapshots.now }, ...snapshots.broker]), 'fail');
  assert.equal(status('queue', [{ event: 'removed_from_merge_queue', created_at: '2026-10-12T00:00:00Z' }]), 'ok');
  assert.equal(status('epics', [{ missing: true }]), 'warn');
  assert.equal(status('epics', [{ missing: true }, { failures: config.epicFailures }]), 'fail');
  assert.equal(status('epics', [{ at: '2026-01-01T00:00:00Z', applied: 'unchanged' }]), 'ok');
  assert.equal(status('epics', [{ pending: { at: '2026-01-01T00:00:00Z' } }]), 'fail');
});

test('new checks: their boundaries', () => {
  const status = (id, items) => evaluate({ [id]: { items } }, now).find(c => c.id === id).status;
  const hours = h => new Date(now - h * 3600000).toISOString();
  assert.equal(status('idle', [{ idle: true }, { idle: false }]), 'ok');
  assert.equal(status('idle', [{ idle: true }]), 'ok');
  assert.equal(status('stuck', [{ ended: true, pull: 'none' }]), 'fail');
  assert.equal(status('stuck', [{ ended: true, pull: 'open' }, { ended: true, pull: 'closed' }, { ended: false, pull: null }]), 'ok');
  // Two days of a week elapsed is 28.6%: 50% used is within 25 points, 54% not.
  const week = used => [{ used_percent: used, window_minutes: 10080, resets_at: '2026-10-20T12:00:00Z' }];
  assert.equal(status('pace', week(50)), 'ok');
  assert.equal(status('pace', week(54)), 'fail');
  assert.equal(status('pace', week(0)), 'fail');
  assert.equal(status('pace', [{ used_percent: 99, window_minutes: 10080, resets_at: hours(1) }]), 'ok');
  assert.equal(status('pace', [{ used_percent: 10, window_minutes: 60, resets_at: hours(-2) }]), 'ok');
  assert.equal(status('failures', [{ reason: null }]), 'ok');
  assert.equal(status('held', [{ labeledAt: hours(config.holdWaitHours - 1) }]), 'ok');
  assert.equal(status('held', [{}]), 'fail');
  assert.equal(status('unqueued', [{ approvedAt: hours(2), clean: true, queued: true }, { approvedAt: hours(2), clean: false, queued: false }]), 'ok');
  assert.equal(status('unqueued', [{ approvedAt: hours(0.5), clean: true, queued: false }]), 'ok');
  assert.equal(status('unclosed', [{ mergedAt: hours(2), issueState: 'closed' }, { mergedAt: hours(0.5), issueState: 'open' }]), 'ok');
  const evidence = evaluate({ unclosed: { items: [{ mergedAt: hours(2), issueState: 'open', html_url: 'https://github.com/o/r/pull/2', issue_url: 'https://github.com/o/r/issues/1' }] } }, now).find(c => c.id === 'unclosed').evidence;
  assert.deepEqual(evidence, ['https://github.com/o/r/pull/2', 'https://github.com/o/r/issues/1']);
  const many = Array.from({ length: 30 }, (_, i) => ({ reason: 'secret', html_url: `https://github.com/o/r/actions/runs/${i}` }));
  assert.equal(evaluate({ failures: { items: many } }, now).find(c => c.id === 'failures').evidence.length, config.maxEvidence);
});

test('an observation unavailable for an hour fails', () => {
  const at = minutes => new Date(now - minutes * 60000).toISOString();
  const check = (id, data, since) => evaluate({ [id]: data, previous: { items: since ? [{ id, unavailable_since: since }] : [] } }, now).find(c => c.id === id);
  const first = check('queue', { error: true });
  assert.equal(first.status, 'warn');
  assert.equal(first.unavailable_since, new Date(now).toISOString());
  assert.equal(check('queue', { error: true }, at(30)).status, 'warn');
  assert.equal(check('queue', { error: true }, at(30)).unavailable_since, at(30));
  assert.equal(check('queue', { error: true }, at(60)).status, 'fail');
  assert.equal(check('pace', undefined, at(90)).status, 'fail');
  // A switched-off probe is no observation either.
  assert.equal(check('broker', { items: [{ conclusion: 'skipped' }] }, at(61)).status, 'fail');
  // A time from the future, or none that parses, starts again.
  assert.equal(check('queue', { error: true }, '2027-01-01T00:00:00Z').status, 'warn');
  assert.equal(check('queue', { error: true }, 'soon').unavailable_since, new Date(now).toISOString());
  // Available again: the carried time is dropped.
  assert.equal(check('queue', { items: [] }, at(90)).status, 'ok');
  assert.equal(check('queue', { items: [] }, at(90)).unavailable_since, undefined);
  // An unreadable previous report starts the clock afresh.
  assert.equal(evaluate({ queue: { error: true }, previous: { error: true } }, now).find(c => c.id === 'queue').status, 'warn');
});

// A zip of one entry as upload-artifact writes it: sizes in a trailing
// descriptor, not the local header, which unzipEntry must not read.
function zip(name, content) {
  const data = zlib.deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, Buffer.from(name), data, Buffer.alloc(16)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, Buffer.from(name), end]);
}

test('unzipEntry reads the entry by the central directory, bounded', () => {
  const archive = zip('health.json', Buffer.from('[{"id":"queue"}]'));
  assert.equal(unzipEntry(archive, 'health.json', 1024).toString(), '[{"id":"queue"}]');
  assert.throws(() => unzipEntry(archive, 'other.json', 1024));
  assert.throws(() => unzipEntry(zip('health.json', Buffer.alloc(4096)), 'health.json', 1024));
  assert.throws(() => unzipEntry(Buffer.from('not a zip'), 'health.json', 1024));
});

test('collector reads the scheduler log, records, runs, annotations, pull requests and the previous report', async () => {
  const original = global.fetch;
  const env = { ...process.env };
  process.env.GITHUB_RUN_ID = '900';
  process.env.DEFAULT_BRANCH = 'main';
  const policy = { ...require('../poll/agent-board.json'), follow: ['example/project'] };
  const root = `/repos/${policy.dispatchRepo}`;
  const run = (id, title, extra = {}) => ({ id, display_title: title, status: 'completed', conclusion: 'success', html_url: `https://github.com/${policy.dispatchRepo}/actions/runs/${id}`, ...extra });
  const log = idle => [
    '2026-10-15T11:50:32.1Z example/project#5 (epic example/project#1) skip: plan https://github.com/example/project/issues/5#issuecomment-1 was dispatched already, https://github.com/example/project/issues/5#issuecomment-2',
    `2026-10-15T11:50:41.4Z \x1b[0m${idle ? 'idle: 7 slot(s) free and nothing started; skipped: plan was dispatched already 1' : '1 dispatched'}`,
    '2026-10-15T11:51:20.7Z example/project#1 idle: minimum planning interval has not elapsed',
  ].join('\n');
  const blobs = {
    'https://blob.example/log/31': log(true), 'https://blob.example/log/32': log(true),
    'https://blob.example/health': zip('health.json', Buffer.from(JSON.stringify([{ id: 'pace', unavailable_since: '2026-10-15T10:00:00Z' }]))),
  };
  const downloads = [];
  const respond = body => ({ ok: true, status: 200, json: async () => body });
  global.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.host === 'blob.example') {
      assert.equal(options.headers, undefined, 'the token stays with GitHub');
      return { ok: true, status: 200, body: [Buffer.from(blobs[url])] };
    }
    const path = u.pathname + u.search;
    const redirect = location => { downloads.push(path); assert.equal(options.redirect, 'manual'); return { ok: false, status: 302, headers: { get: () => location } }; };
    if (options.method === 'POST') {
      const { query, variables } = JSON.parse(options.body);
      assert.ok(!/^\s*mutation/.test(query));
      if (query.includes('states: OPEN')) return respond({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [
        { url: 'https://github.com/example/project/pull/7', isInMergeQueue: false, mergeStateStatus: 'CLEAN', author: { __typename: 'User', login: policy.bot },
          labels: { nodes: [{ name: 'needs-human' }] }, timelineItems: { nodes: [{ createdAt: '2026-10-14T00:00:00Z', label: { name: 'needs-human' } }] },
          comments: { nodes: [{ url: 'https://github.com/example/project/pull/7#issuecomment-70', author: { login: policy.bot } }, { url: 'https://github.com/example/project/pull/7#issuecomment-71', author: { login: 'someone' } }] } },
      ] } } } });
      if (query.includes('orderBy')) return respond({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [
        { url: 'https://github.com/example/project/pull/8', updatedAt: '2026-10-15T11:00:00Z', mergedAt: '2026-10-15T09:00:00Z', headRefName: `${config.implementBranchPrefix}41`, body: 'Does it.', author: { __typename: 'User', login: policy.bot },
          timelineItems: { nodes: [{ createdAt: '2026-10-15T08:00:00Z', reason: 'FAILED_CHECKS' }, { createdAt: '2026-10-15T09:00:00Z', reason: 'MERGED' }] } },
        { url: 'https://github.com/example/project/pull/9', updatedAt: '2026-10-15T11:00:00Z', mergedAt: '2026-10-15T09:00:00Z', headRefName: `${config.implementBranchPrefix}42`, body: 'Part of #3.', author: { __typename: 'User', login: policy.bot },
          timelineItems: { nodes: [{ createdAt: '2026-10-15T09:00:00Z', reason: 'MERGED' }] } },
      ] } } } });
      if (query.includes('issue(number: $i0)')) {
        assert.deepEqual(variables, { o0: 'example', n0: 'project', i0: 3 });
        return respond({ data: { r0: { issue: { state: 'OPEN', url: 'https://github.com/example/project/issues/3' } } } });
      }
      return respond({ data: { repository: null } });
    }
    if (path.startsWith(`${root}/actions/workflows/${config.supervisorWorkflow}/runs`)) return respond({ workflow_runs: [{ id: 900 }, { id: 899 }] });
    if (path.startsWith(`${root}/actions/runs/899/artifacts`)) return respond({ artifacts: [{ id: 77, name: 'supervisor-health', expired: false }] });
    if (path === `${root}/actions/artifacts/77/zip`) return redirect('https://blob.example/health');
    if (path.startsWith(`${root}/actions/workflows/${config.pollWorkflow}/runs`)) return respond({ workflow_runs: [
      run(30, 'poll', { conclusion: 'cancelled' }), run(31, 'poll'), run(32, 'poll'), run(33, 'poll'),
    ] });
    if (path.startsWith(`${root}/actions/runs/30/jobs`)) return respond({ jobs: [] });
    const jobs = /\/actions\/runs\/(3[123])\/jobs/.exec(path);
    if (jobs) return respond({ jobs: [{ id: Number(jobs[1]), name: config.schedulerJob, status: 'completed', conclusion: 'success' }] });
    const logs = /\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (logs) return redirect(`https://blob.example/log/${logs[1]}`);
    if (path === '/repos/example/project/issues/comments/2') return respond({ user: { login: policy.bot }, html_url: 'https://github.com/example/project/issues/5#issuecomment-2',
      body: `<!-- agent-board-dispatch: 1@2026-10-15T00:00:00Z -->\nDispatched: [run](https://github.com/${policy.dispatchRepo}/actions/runs/40).` });
    if (path === `${root}/actions/runs/40`) return respond(run(40, 'implement example/project#5'));
    if (path.startsWith('/repos/example/project/pulls?state=all&head=')) {
      assert.equal(decodeURIComponent(path.split('head=')[1]), `example:${config.implementBranchPrefix}40`);
      return respond([]);
    }
    if (path.startsWith(`${root}/actions/workflows/${policy.dispatchWorkflow}/runs?created=`)) return respond({ workflow_runs: [
      run(50, 'implement example/project#6 (claude)', { conclusion: 'failure' }),
      run(49, 'implement example/project#2'),
      run(48, 'implement example/project#2 (claude)', { conclusion: 'failure' }),
      run(41, 'implement example/project#3'),
      run(42, 'implement example/project#3'),
      run(51, 'research example/project#4 (claude)', { conclusion: 'failure' }),
      run(52, 'research example/project#4 (claude)', { conclusion: 'failure' }),
    ] });
    if (path.startsWith(`${root}/actions/runs/50/jobs`)) return respond({ jobs: [{ id: 501, conclusion: 'failure' }, { id: 502, conclusion: 'success' }] });
    if (path.startsWith(`${root}/check-runs/501/annotations`)) return respond([{ message: 'Process completed with exit code 1.' }, { message: '✗ Message 1 (add_comment) failed: E008: Comment contains 54 links, maximum is 50.' }]);
    if (path.startsWith(`${root}/actions/runs/51/jobs`)) return respond({ jobs: [{ id: 511, conclusion: 'failure' }] });
    if (path.startsWith(`${root}/check-runs/511/annotations`)) return respond([{ message: 'agentic-job run ended with exit state 2' }]);
    if (path.includes('/releases/latest')) return respond({ tag_name: 'v0.4.0' });
    if (path.includes('/contents/')) return respond({ content: Buffer.from(['policy', 'check', 'apply'].map(n => `uses: ${config.releaseRepository}/.github/workflows/${n}.yml@v0.4.0`).join('\n')).toString('base64') });
    if (path.includes('/actions/')) return respond({ workflow_runs: [] });
    return respond([]);
  };
  try {
    const snapshot = await collect('unused', config, policy, () => now);
    const checks = Object.fromEntries(evaluate(snapshot, now).map(c => [c.id, c]));
    assert.deepEqual(downloads.sort(), [`${root}/actions/artifacts/77/zip`, `${root}/actions/jobs/31/logs`, `${root}/actions/jobs/32/logs`]);
    assert.equal(checks.idle.status, 'fail');
    assert.deepEqual(checks.idle.evidence, [run(31).html_url, run(32).html_url]);
    assert.equal(checks.stuck.status, 'fail');
    assert.deepEqual(checks.stuck.evidence, ['https://github.com/example/project/issues/5#issuecomment-2', run(40).html_url]);
    // Only the newest failure of a target counts, and only a recurring reason.
    assert.deepEqual(snapshot.failures.items.map(f => f.reason), ['refused', null]);
    assert.deepEqual(checks.failures.evidence, [run(50).html_url]);
    assert.equal(checks.held.status, 'fail');
    assert.deepEqual(checks.held.evidence, ['https://github.com/example/project/pull/7', 'https://github.com/example/project/pull/7#issuecomment-70']);
    // A merge leaves the queue too; it is not a removal to inspect.
    assert.deepEqual(snapshot.queue.items.map(e => e.created_at), ['2026-10-15T08:00:00Z']);
    // The part-of pull request is left to the scheduler's triage.
    assert.deepEqual(checks.unclosed.evidence, ['https://github.com/example/project/pull/8', 'https://github.com/example/project/issues/3']);
    // The usage snapshot is not readable here: unavailable since the last report said.
    assert.equal(checks.pace.status, 'fail');
    assert.equal(checks.pace.unavailable_since, '2026-10-15T10:00:00.000Z');
  } finally { global.fetch = original; process.env = env; }
});

test('successful API snapshot skips old PR detail and preserves COMMENTED approval', async () => {
  const original = global.fetch;
  const paths = [];
  const policy = { ...require('../poll/agent-board.json'), follow: ['example/project'] };
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(path);
    if (options.method === 'POST') {
      assert.equal(path, '/graphql');
      assert.ok(!/^\s*mutation/.test(JSON.parse(options.body).query));
      return { ok: true, json: async () => ({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } } }) };
    }
    assert.equal(options.method, 'GET');
    let body = [];
    if (path.includes('/releases/latest')) body = { tag_name: 'v0.4.0', html_url: 'https://github.com/example/project/releases/tag/v0.4.0' };
    else if (path.includes('/contents/')) body = { content: Buffer.from(['policy', 'check', 'apply'].map(n => `uses: ${config.releaseRepository}/.github/workflows/${n}.yml@v0.4.0`).join('\n')).toString('base64') };
    else if (path.includes('/actions/')) body = { workflow_runs: [] };
    else if (path.includes('/pulls?state=all')) body = Array.from({ length: 100 }, (_, number) => ({ number, updated_at: '2020-01-01T00:00:00Z' }));
    else if (path.includes('/pulls?state=open')) body = [{ number: 101, state: 'open', labels: [], head: { sha: 'current' } }];
    else if (path.includes('/101/reviews')) body = [
      { user: { login: policy.operator }, state: 'APPROVED', commit_id: 'current', submitted_at: '2026-10-15T08:00:00Z' },
      { user: { login: policy.operator }, state: 'COMMENTED', commit_id: 'current', submitted_at: '2026-10-15T09:00:00Z' },
    ];
    return { ok: true, json: async () => body };
  };
  try {
    const snapshot = await collect('unused', config, policy, () => now);
    assert.ok(paths.length < 25, `request count ${paths.length}`);
    assert.ok(!paths.some(p => p.includes('/timeline')));
    assert.equal(evaluate(snapshot, now).find(c => c.id === 'approved').status, 'fail');
    assert.equal(evaluate(snapshot, now).find(c => c.id === 'release').status, 'ok');
    assert.equal(snapshot.dispatch.error, undefined);
    assert.equal(snapshot.decisions.error, undefined);
    for (const id of ['queue', 'dependabot', 'held', 'unqueued', 'unclosed', 'failures', 'idle']) assert.equal(snapshot[id].error, undefined, id);
  } finally { global.fetch = original; }
});

test('overall deadline leaves unavailable observations without further API requests', async () => {
  let time = now;
  const original = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    time += config.collectionTimeoutSeconds * 1000;
    return { ok: false, status: 503 };
  };
  try {
    const snapshot = await collect('unused', config, undefined, () => time);
    assert.equal(requests, 1);
    assert.ok(evaluate(snapshot, now).every(c => c.status === 'warn'));
  } finally { global.fetch = original; }
});

test('collector has a bounded request budget and issues no mutations', async () => {
  const original = global.fetch;
  const methods = [];
  global.fetch = async (url, options = {}) => {
    methods.push(options.method);
    assert.ok([undefined, 'GET'].includes(options.method));
    return { ok: false, status: 403 };
  };
  try {
    const snapshot = await collect('unused', { ...config, maxRequests: 2 });
    assert.equal(methods.length, 2);
    assert.ok(Object.values(snapshot).every(s => s.error));
    assert.ok(evaluate(snapshot, now).every(c => c.status === 'warn'));
  } finally { global.fetch = original; }
});
