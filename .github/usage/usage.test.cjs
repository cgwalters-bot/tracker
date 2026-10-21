// node --test .github/usage/usage.test.cjs
// testdata/broker-usage.json is a praxis-broker-usage/v1 answer in the shape
// of the broker's usage.rs, its window headers those of its own fixtures.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { MARKER, carryPools, checkConfig, findComment, mistralAllowance, mistralUsage, needsPublish, poolPace, previousSnapshot, publish, readBroker, render, request, snapshot } = require('./usage.cjs');

// The live config's shape, with pacing fixed so the tests don't move when the
// operator retunes it.
const CONFIG = { ...require('./config.json'), pacing: { claude: { target: 0.95, burst: 3 }, openai: { target: 0.95, burst: 3 } } };
const POOLS = require('../agentic-job/pools.json');
const load = () => structuredClone(require('./testdata/broker-usage.json'));
const NOW = Date.parse('2026-10-08T10:00:00Z');
const PACING = { target: 0.95, burst: 3 };
// pools.json's mistral entry, as the meter's tests need it whatever that file holds.
const MISTRAL = { model: 'mistral-medium', allowance: { amount: 300, currency: 'USD', period: 'calendar-month' } };
const PRICES = { 'mistral-medium': { input: 0.4, output: 2 } };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('freshness skips only when every configured pool observation is under ten minutes old', async () => {
  const fresh = () => ({ schema: 'bot-usage/v1', pools: Object.fromEntries(
    Object.keys(CONFIG.pacing).map(name => [name, { observed_at: new Date(NOW - 9 * 60e3).toISOString() }]),
  ) });
  const first = Object.keys(CONFIG.pacing)[0];
  for (const [label, mutate, expected] of [
    ['fresh', () => {}, false],
    ['boundary', s => { s.pools[first].observed_at = new Date(NOW - 10 * 60e3).toISOString(); }, true],
    ['stale', s => { s.pools[first].observed_at = new Date(NOW - 46 * 60e3).toISOString(); s.updated_at = new Date(NOW).toISOString(); }, true],
    ['missing pool', s => { delete s.pools[first]; }, true],
    ['null pool', s => { s.pools[first] = null; }, true],
    ['invalid date', s => { s.pools[first].observed_at = 'invalid'; }, true],
    ['future', s => { s.pools[first].observed_at = new Date(NOW + 1).toISOString(); }, true],
    ['wrong schema', s => { s.schema = 'unknown'; }, true],
  ]) {
    const snap = fresh();
    mutate(snap);
    const body = `${MARKER}\n\n\`\`\`json\n${JSON.stringify(snap)}\n\`\`\``;
    const request = async (method, url) => {
      assert.equal(method, 'GET');
      assert.equal(url, `/repos/${CONFIG.repo}/issues/${CONFIG.issue}/comments?per_page=100`);
      return [{ user: { login: CONFIG.bot }, body }];
    };
    assert.equal(await needsPublish({ config: CONFIG, request, now: NOW }), expected, label);
  }
  for (const comments of [[], [{ user: { login: CONFIG.bot }, body: `${MARKER}\ninvalid` }],
    [{ user: { login: 'another-user' }, body: render(fresh(), 'test') }]]) {
    assert.equal(await needsPublish({ config: CONFIG, request: async () => comments, now: NOW }), true);
  }
  await assert.rejects(needsPublish({ config: CONFIG, request: async () => { throw new Error('unavailable'); }, now: NOW }), /unavailable/);
});

test('workflow checks freshness before joining and uses only default-branch code', () => {
  const workflow = require('node:fs').readFileSync(require('node:path').join(__dirname, '../workflows/usage.yml'), 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*workflows: \[poll\]\n\s+types: \[completed\]/);
  assert.match(workflow, /github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
  assert.match(workflow, /group: usage\n\s+cancel-in-progress: false/);
  assert.ok(workflow.indexOf('just publish-usage --check-freshness') < workflow.indexOf('name: Join the tailnet'));
  for (const step of ['Join the tailnet', 'Publish']) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: steps.freshness.outputs.publish == 'true'`));
  }
  assert.doesNotMatch(workflow, /github.event.workflow_run\.|download-artifact/);
});

test('the repository config and the Mistral allowance in pools.json are usable', () => {
  checkConfig(CONFIG);
  assert.ok(mistralAllowance(POOLS.mistral, load(), NOW), 'pools.json mistral.allowance is one usage.cjs can publish');
  for (const bad of [{ ...CONFIG, repo: 'bot-ops' }, { ...CONFIG, issue: 0 }, { ...CONFIG, pacing: { claude: PACING } }]) {
    assert.throws(() => checkConfig(bad));
  }
});

test('the broker answer becomes the pools and Mistral counters of bot-usage/v1', () => {
  const snap = snapshot(load(), CONFIG, MISTRAL, NOW);
  assert.equal(snap.schema, 'bot-usage/v1');
  assert.equal(snap.updated_at, '2026-10-08T10:00:00.000Z');
  assert.equal(snap.windows.length, 4);
  assert.deepEqual(snap.windows[0], { name: 'claude', used_percent: 42, window_minutes: 300, resets_at: '2026-10-08T12:00:00.000Z' });
  assert.deepEqual(snap.workers, []);
  // Claude's week: 81% used, 4 days 10 hours into it, so the pace allows
  // 95% of 106/168 and the pool holds.
  const { claude, openai } = snap.pools;
  close(claude.used_percent, 81);
  close(claude.allowed_percent, (95 * 106) / 168);
  assert.equal(claude.resets_at, '2026-10-11T00:00:00.000Z');
  assert.equal(claude.observed_at, '2026-10-08T09:00:00.000Z');
  assert.equal(claude.window_minutes, 7 * 24 * 60);
  assert.deepEqual([claude.hold, claude.reason], [true, 'pace']);
  // OpenAI's week (the secondary window) is behind its pace.
  close(openai.used_percent, 20);
  assert.equal(openai.resets_at, '2026-10-12T09:16:40.000Z');
  assert.deepEqual([openai.hold, openai.reason, openai.next_dispatch_at], [false, null, null]);
  assert.deepEqual(snap.mistral, {
    requests: 8,
    tokens: 3900,
    observed_at: new Date(NOW).toISOString(),
    since: '2026-10-05T00:00:00.000Z',
    allowance: { limit_usd: 300, resets_at: '2026-11-01T00:00:00.000Z' },
  });
});

test('the comment is what the review app parses: the marker, then the JSON', () => {
  const snap = snapshot(load(), CONFIG, MISTRAL, NOW);
  const body = render(snap, '`usage`');
  assert.ok(body.startsWith(`${MARKER}\n`));
  // review's src/github/usage.ts: JSON_FENCE_RE and parsePool's fields.
  const m = /^```json\n([\s\S]*?)\n```$/m.exec(body);
  assert.deepEqual(JSON.parse(m[1]), snap);
  for (const p of Object.values(snap.pools)) {
    for (const k of ['used_percent', 'allowed_percent']) assert.ok(Number.isFinite(p[k]) && p[k] >= 0, k);
    for (const k of ['resets_at', 'observed_at']) assert.match(p[k], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof p.hold, 'boolean');
  }
  assert.match(body, /^- mistral: 8 requests, 3900 tokens since 2026-10-05T00:00:00.000Z \(unpaced\); allowance \$300, resets 2026-11-01T00:00:00.000Z$/m);
});

test('a pool is unpaced without a week that has yet to reset, and held by a spent shorter window', () => {
  const broker = load();
  delete broker.anthropic.unified_7d;
  assert.equal(snapshot(broker, CONFIG, null, NOW).pools.claude, null, 'five hours alone are not paced');
  assert.equal(snapshot(load(), CONFIG, null, Date.parse('2026-10-11T00:00:01Z')).pools.claude, null, 'the week has reset');
  const empty = load();
  empty.anthropic = { counts: empty.anthropic.counts, unified_5h: null, unified_7d: null };
  assert.equal(snapshot(empty, CONFIG, null, NOW).pools.claude, null);
  const spent = load();
  spent.anthropic.unified_7d.utilization = 0.1;
  spent.anthropic.unified_5h.utilization = 1;
  const claude = snapshot(spent, CONFIG, null, NOW).pools.claude;
  assert.deepEqual([claude.hold, claude.reason, claude.next_dispatch_at], [true, 'window', '2026-10-08T12:00:00.000Z']);
  // A window the broker saw only part of (no utilization) is no reading.
  const partial = load();
  partial.anthropic.unified_7d.utilization = null;
  assert.equal(snapshot(partial, CONFIG, null, NOW).pools.claude, null);
  assert.equal(poolPace(null, PACING, NOW), null);
});

test('Mistral: absent without counters, and the allowance only one the meter can read', () => {
  const broker = load();
  delete broker.mistral;
  assert.equal('mistral' in snapshot(broker, CONFIG, MISTRAL, NOW), false);
  for (const allowance of [{ ...MISTRAL.allowance, period: 'week' }, { ...MISTRAL.allowance, currency: 'EUR' }, { ...MISTRAL.allowance, amount: 0 }, undefined]) {
    assert.equal('allowance' in mistralUsage(load(), { ...MISTRAL, allowance }, NOW), false, JSON.stringify(allowance));
  }
  assert.equal(mistralAllowance(MISTRAL, load(), Date.parse('2026-12-31T23:59:59Z')).resets_at, '2027-01-01T00:00:00.000Z');
});

test('Mistral: with prices, this month of tokens goes out for an estimate, as review parseAllowance reads it', () => {
  const pool = { ...MISTRAL, allowance: { ...MISTRAL.allowance, prices: PRICES } };
  // Cache reads are charged as input: the broker counts them apart.
  assert.deepEqual(mistralAllowance(pool, load(), NOW), {
    limit_usd: 300,
    resets_at: '2026-11-01T00:00:00.000Z',
    models: [{ model: 'mistral-medium', input_tokens: 3500, output_tokens: 400 }],
    prices: PRICES,
  });
  // A broker up since last month counts more than this month: no estimate.
  const old = load();
  old.started_at = Date.parse('2026-09-30T23:59:59Z') / 1e3;
  assert.deepEqual(mistralAllowance(pool, old, NOW), { limit_usd: 300, resets_at: '2026-11-01T00:00:00.000Z' });
});

test('an answer that is not the broker usage is refused', () => {
  for (const bad of [null, [], {}, { ...load(), schema: 'praxis-broker-usage/v2' }]) {
    assert.throws(() => snapshot(bad, CONFIG, null, NOW), /not praxis-broker-usage\/v1/);
  }
});

test('only the bot comment with the marker is the one to edit', () => {
  const body = `${MARKER}\nx`;
  const comments = [
    { id: 1, user: { login: 'someone' }, body },
    { id: 2, user: { login: CONFIG.bot }, body: 'other' },
    { id: 3, user: { login: CONFIG.bot }, body },
  ];
  assert.equal(findComment(comments, CONFIG.bot).id, 3);
  assert.equal(findComment(comments.slice(0, 2), CONFIG.bot), null);
});

test('a pace hold says when the pace catches up, and a pool past its target waits for the reset', () => {
  // A week from 2026-10-04 to 2026-10-11, at 2026-10-08T10:00Z.
  const reading = used => ({ source: 'praxis', observed_at: NOW, windows: [{ used_percent: used, window_ms: 7 * 24 * HOUR, resets_at: Date.parse('2026-10-11T00:00:00Z') }] });
  const p = poolPace(reading(81), PACING, NOW);
  assert.equal(p.next_dispatch_at, new Date(Date.parse('2026-10-04T00:00:00Z') + ((81 - 3) / 95) * 7 * 24 * HOUR).toISOString());
  assert.equal(poolPace(reading(96), PACING, NOW).next_dispatch_at, '2026-10-11T00:00:00.000Z');
  // Codex's five hours used up hold a pool whose week is behind its pace.
  const broker = load();
  Object.assign(broker.codex.primary, { used_percent: 100, reset_after_seconds: 7200 });
  const openai = snapshot(broker, CONFIG, null, NOW).pools.openai;
  assert.deepEqual([openai.hold, openai.reason, openai.next_dispatch_at], [true, 'window', '2026-10-08T11:16:40.000Z']);
});

const HOUR = 3600e3;

test('session ceilings add holds without changing weekly pacing', () => {
  for (const [label, used, reset, weekly, missing, held] of [
    ['under', 84, NOW + HOUR, 10, false, false],
    ['at', 85, NOW + HOUR, 10, false, true],
    ['spent', 100, NOW + HOUR, 10, false, true],
    ['reset', 92, NOW, 10, false, false],
    ['missing', 92, NOW + HOUR, 10, true, false],
    ['weekly and session', 92, NOW + HOUR, 81, false, true],
  ]) {
    const broker = load();
    Object.assign(broker.anthropic.unified_5h, { utilization: used / 100, reset: reset / 1000 });
    broker.anthropic.unified_7d.utilization = weekly / 100;
    if (missing) delete broker.anthropic.unified_5h;
    const config = structuredClone(CONFIG);
    config.pacing.claude.session_hold = 85;
    const snap = snapshot(broker, config, null, NOW);
    const before = snapshot(broker, CONFIG, null, NOW).pools.claude;
    const p = snap.pools.claude;
    assert.equal(p.hold, held || before.hold, label);
    assert.equal(p.reason, held ? 'session' : before.reason, label);
    assert.equal(p.allowed_percent, before.allowed_percent, label);
    if (held) assert.equal(Date.parse(p.next_dispatch_at), Math.max(reset, Date.parse(before.next_dispatch_at) || 0), label);
    if (!missing) assert.match(render(snap, 'test'), new RegExp(`claude: 5-hour session ${used}% used, resets`));
  }
  for (const value of [0, -1, 101, '85', null]) {
    const config = structuredClone(CONFIG);
    config.pacing.claude.session_hold = value;
    assert.throws(() => checkConfig(config), /session_hold/);
  }
  checkConfig(require('./config.json'));
  for (const weekly of [null, { utilization: 0.1, reset: NOW / 1000, observed_at: NOW / 1000 }]) {
    const broker = load();
    broker.anthropic.unified_7d = weekly;
    broker.anthropic.unified_5h.utilization = 0.92;
    const config = structuredClone(CONFIG);
    config.pacing.claude.session_hold = 85;
    assert.equal(snapshot(broker, config, null, NOW).pools.claude.reason, 'session');
  }
  const broker = load();
  broker.codex.primary.used_percent = 92;
  broker.codex.primary.reset_after_seconds = 7200;
  assert.equal(snapshot(broker, CONFIG, null, NOW).pools.openai.hold, false);
  const config = structuredClone(CONFIG);
  config.pacing.openai.session_hold = 85;
  assert.equal(snapshot(broker, config, null, NOW).pools.openai.reason, 'session');
});
// A broker just restarted: no window seen yet, the counters from zero.
function restarted() {
  const b = load();
  b.anthropic.unified_5h = b.anthropic.unified_7d = null;
  b.codex.primary = b.codex.secondary = null;
  return b;
}

test('a pool the broker has no reading of keeps the last one until its window resets', () => {
  const previous = snapshot(load(), CONFIG, null, NOW);
  const later = NOW + HOUR;
  const snap = carryPools(snapshot(restarted(), CONFIG, null, later), previous, CONFIG, later);
  close(snap.pools.claude.used_percent, 81);
  assert.equal(snap.pools.claude.observed_at, previous.pools.claude.observed_at, 'the reading keeps its age');
  close(snap.pools.claude.allowed_percent, (95 * 107) / 168);
  assert.equal(snap.pools.openai.resets_at, previous.pools.openai.resets_at);
  // A fresh reading wins, and a carried one ends with its window.
  assert.deepEqual(carryPools(snapshot(load(), CONFIG, null, later), { pools: { claude: { ...previous.pools.claude, used_percent: 1 } } }, CONFIG, later).pools.claude.used_percent, previous.pools.claude.used_percent);
  const afterReset = Date.parse('2026-10-11T00:00:01Z');
  assert.equal(carryPools(snapshot(restarted(), CONFIG, null, afterReset), previous, CONFIG, afterReset).pools.claude, null);
  // One pool seen again since the restart, the other carried.
  const partial = restarted();
  partial.codex = load().codex;
  const mixed = carryPools(snapshot(partial, CONFIG, null, later), previous, CONFIG, later);
  assert.equal(mixed.pools.openai.computed_at, new Date(later).toISOString());
  assert.equal(mixed.pools.claude.observed_at, previous.pools.claude.observed_at);
  assert.equal(previousSnapshot(render(previous, 'x')).updated_at, previous.updated_at);
});

test('unexpired session lower bounds survive missing broker headers', () => {
  const config = structuredClone(CONFIG);
  config.pacing.claude.session_hold = 85;
  const broker = load();
  broker.anthropic.unified_7d.utilization = 0.1;
  broker.anthropic.unified_5h.utilization = 0.92;
  const previous = snapshot(broker, config, null, NOW);
  for (const [label, partial, later, held] of [
    ['restart', false, NOW + 60e3, true],
    ['partial', true, NOW + 60e3, true],
    ['reset', false, NOW + 2 * HOUR, false],
  ]) {
    const current = partial ? structuredClone(broker) : restarted();
    if (partial) delete current.anthropic.unified_5h;
    const carried = carryPools(snapshot(current, config, null, later), previous, config, later);
    assert.equal(carried.pools.claude.hold, held, label);
    assert.equal(carried.pools.claude.reason, held ? 'session' : null, label);
    assert.equal(carried.windows.some(w => w.name === 'claude' && w.window_minutes === 300), held, label);
  }
  const fresh = structuredClone(broker);
  fresh.anthropic.unified_5h.utilization = 0.1;
  assert.equal(carryPools(snapshot(fresh, config, null, NOW), previous, config, NOW).pools.claude.hold, false);
  broker.anthropic.unified_7d = null;
  fresh.anthropic.unified_7d = null;
  const sessionOnly = snapshot(broker, config, null, NOW);
  const replaced = carryPools(snapshot(fresh, config, null, NOW), sessionOnly, config, NOW);
  assert.equal(replaced.pools.claude, null);
});

test('each weekly number keeps its own observation time, not the newer short window', () => {
  const broker = load();
  broker.anthropic.unified_5h.observed_at = NOW / 1000;
  broker.codex.primary.observed_at = NOW / 1000;
  const before = snapshot(load(), CONFIG, null, NOW);
  const after = snapshot(broker, CONFIG, null, NOW + HOUR);
  for (const name of ['claude', 'openai']) {
    assert.equal(after.pools[name].observed_at, before.pools[name].observed_at);
    assert.equal(after.pools[name].computed_at, new Date(NOW + HOUR).toISOString());
    assert.ok(after.pools[name].allowed_percent > before.pools[name].allowed_percent);
  }
  for (const body of [undefined, '', `${MARKER}\n\`\`\`json\n{nope\n\`\`\``]) assert.equal(previousSnapshot(body), null);
});

test('both providers discard a pre-reset hold and pace a new week from its reset', () => {
  const week = 7 * 24 * HOUR;
  for (const name of ['claude', 'openai']) {
    const broker = load();
    const reset = NOW + HOUR;
    if (name === 'claude') Object.assign(broker.anthropic.unified_7d, { utilization: 1, reset: reset / 1000 });
    else Object.assign(broker.codex.secondary, { used_percent: 100, reset_after_seconds: reset / 1000 - broker.codex.secondary.observed_at });
    assert.equal(snapshot(broker, CONFIG, null, reset - 1).pools[name].hold, true);
    for (const now of [reset, reset + 1]) assert.equal(snapshot(broker, CONFIG, null, now).pools[name], null);
    if (name === 'claude') Object.assign(broker.anthropic.unified_7d, { utilization: 0, reset: (reset + week) / 1000, observed_at: reset / 1000 });
    else Object.assign(broker.codex.secondary, { used_percent: 0, reset_after_seconds: week / 1000, observed_at: reset / 1000 });
    const fresh = snapshot(broker, CONFIG, null, reset).pools[name];
    assert.equal(fresh.allowed_percent, 0);
    assert.equal(fresh.used_percent, 0);
    assert.equal(fresh.hold, false);
    assert.equal(fresh.next_dispatch_at, null);
    close(snapshot(broker, CONFIG, null, reset + HOUR).pools[name].allowed_percent, 95 / 168);
  }
});

// A fake GitHub: the repository, the issue's comments, the token's
// login; the requests it was sent.
function github({ private: priv = true, comments = [], login = CONFIG.bot } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `/repos/${CONFIG.repo}`) return { private: priv };
    if (path === '/user') return { login };
    if (method === 'GET' && path.includes('/comments')) return comments;
    if (method === 'POST') return { html_url: 'created' };
    return {};
  };
  return { calls, request, writes: () => calls.filter(c => c.method !== 'GET') };
}
const publishWith = (gh, snap = snapshot(load(), CONFIG, null, NOW)) =>
  publish({ config: CONFIG, snap, render: s => render(s, 'x'), request: gh.request, log: () => {} });

test('publish edits the bot comment, creates one only as the bot, and never writes to a public repository', async () => {
  const mine = { id: 9, html_url: 'u', user: { login: CONFIG.bot }, body: `${MARKER}\nold` };
  let gh = github({ comments: [{ id: 1, user: { login: 'someone' }, body: MARKER }, mine] });
  await publishWith(gh);
  assert.deepEqual(gh.writes().map(c => [c.method, c.path]), [['PATCH', `/repos/${CONFIG.repo}/issues/comments/9`]]);
  assert.ok(gh.writes()[0].body.body.startsWith(MARKER));

  gh = github();
  await publishWith(gh);
  assert.deepEqual(gh.writes().map(c => [c.method, c.path]), [['POST', `/repos/${CONFIG.repo}/issues/${CONFIG.issue}/comments`]]);

  gh = github({ login: 'someone-else' });
  await assert.rejects(publishWith(gh), /not creating a comment/);
  assert.deepEqual(gh.writes(), []);

  gh = github({ private: false, comments: [mine] });
  await assert.rejects(publishWith(gh), /is not private/);
  assert.deepEqual(gh.writes(), []);
});

test('publish looks only where the review app reads, and does not add a comment it would not see', async () => {
  const other = { id: 1, user: { login: 'someone' }, body: 'hi' };
  const gh = github({ comments: Array(100).fill(other) });
  await assert.rejects(publishWith(gh), /among the first 100/);
  assert.deepEqual(gh.writes(), []);
  assert.deepEqual(gh.calls.filter(c => c.method === 'GET').map(c => c.path), [`/repos/${CONFIG.repo}`, `/repos/${CONFIG.repo}/issues/${CONFIG.issue}/comments?per_page=100`]);
});

test('publish carries pools until their windows reset, then clears the holds and still publishes Mistral', async () => {
  const gh = github();
  await publishWith(gh, snapshot(restarted(), CONFIG, null, NOW));
  assert.equal(gh.writes().length, 1);
  const previous = { id: 9, html_url: 'u', user: { login: CONFIG.bot }, body: render(snapshot(load(), CONFIG, null, NOW), 'x') };
  const again = github({ comments: [previous] });
  await publishWith(again, snapshot(restarted(), CONFIG, null, NOW + HOUR));
  close(previousSnapshot(again.writes()[0].body.body).pools.claude.used_percent, 81);
  const afterReset = Date.parse('2026-10-20T00:00:00Z');
  const reset = github({ comments: [previous] });
  await publishWith(reset, snapshot(restarted(), CONFIG, null, afterReset));
  const published = previousSnapshot(reset.writes()[0].body.body);
  assert.deepEqual(published.pools, { claude: null, openai: null });
  assert.equal(published.mistral.observed_at, new Date(afterReset).toISOString());
});

test('readBroker reads /usage at the root of the broker, bounded', async t => {
  let answer = '';
  const server = http.createServer((req, res) => {
    if (req.url !== '/usage') { res.statusCode = 404; return res.end(); }
    res.end(answer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  answer = JSON.stringify(load());
  assert.equal((await readBroker(base)).schema, 'praxis-broker-usage/v1');
  answer = 'x'.repeat(300 * 1024);
  await assert.rejects(readBroker(base), /answer over/);
  answer = '<html>';
  await assert.rejects(readBroker(base), /\/usage: not JSON/);
});

test('a GitHub request that stalls fails the call with its method and path', { timeout: 10e3 }, async t => {
  // Accepts and never answers, or sends the headers and stalls in the body.
  const server = http.createServer((req, res) => {
    if (req.url === '/body') { res.writeHead(200); res.write('{'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => realFetch(url.replace('https://api.github.com', base), init));
  await assert.rejects(request('token', 'GET', '/silent', undefined, 200), { message: /^GET \/silent: .*timeout/ });
  await assert.rejects(request('token', 'PATCH', '/body', {}, 200), { message: /^PATCH \/body: .*timeout/ });
});
