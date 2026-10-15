'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, collect } = require('./health.cjs');
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
  assert.equal(status('queue', [{ event: 'removed_from_merge_queue', created_at: '2026-10-12T00:00:00Z' }]), 'ok');
  assert.equal(status('epics', [{ missing: true }]), 'warn');
  assert.equal(status('epics', [{ missing: true }, { failures: config.epicFailures }]), 'fail');
  assert.equal(status('epics', [{ at: '2026-01-01T00:00:00Z', applied: 'unchanged' }]), 'ok');
  assert.equal(status('epics', [{ pending: { at: '2026-01-01T00:00:00Z' } }]), 'fail');
});

test('successful API snapshot skips old PR detail and preserves COMMENTED approval', async () => {
  const original = global.fetch;
  const paths = [];
  const policy = { ...require('../poll/agent-board.json'), follow: ['example/project'] };
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'GET');
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(path);
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
  global.fetch = async (url, options) => {
    methods.push(options.method);
    assert.equal(options.method, 'GET');
    return { ok: false, status: 403 };
  };
  try {
    const snapshot = await collect('unused', { ...config, maxRequests: 2 });
    assert.equal(methods.length, 2);
    assert.ok(Object.values(snapshot).every(s => s.error));
    assert.ok(evaluate(snapshot, now).every(c => c.status === 'warn'));
  } finally { global.fetch = original; }
});
