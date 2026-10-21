'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion, due, next, bumpCargo, workspaceVersion, older, repin, pass, Stall } = require('./train.cjs');
const config = require('./config.json');

const hour = 3600000;
const now = Date.parse('2026-10-16T12:00:00Z');
const prs = (n, labels = []) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `pr ${i + 1}`, labels }));

test('a release is due at the threshold once a day, or at once for a P0', () => {
  const dayAgo = new Date(now - 25 * hour).toISOString();
  const hourAgo = new Date(now - hour).toISOString();
  assert.equal(due([], dayAgo, now), null);
  assert.equal(due(prs(config.threshold - 1), dayAgo, now), null);
  assert.match(due(prs(config.threshold), dayAgo, now), /5 pull requests/);
  assert.equal(due(prs(config.threshold + 3), hourAgo, now), null, 'at most once a day');
  assert.match(due([...prs(1), { number: 9, title: 'fix', labels: ['P0'] }], hourAgo, now), /P0/);
  assert.equal(due(prs(2), dayAgo, now, { ...config, threshold: 3 }), null);
});

test('a breaking label makes a minor bump, anything else a patch', () => {
  assert.equal(nextVersion('0.5.2', false), '0.5.3');
  assert.equal(nextVersion('0.5.2', true), '0.6.0');
  assert.equal(nextVersion('1.9.9', true), '1.10.0');
  assert.throws(() => nextVersion('v0.5.2', false), Stall);
});

test('the chain runs bump, release, wrappers, then the callers, in that order', () => {
  const open = { state: 'open', merged: false };
  const merged = { state: 'closed', merged: true, merge_commit_sha: 'a'.repeat(40) };
  const callers = pr => [{ repository: 'o/tracker', pr }, { repository: 'o/board', pr }];
  const f = { bump: null, release: null, run: null, wrappers: null, callers: callers(null) };
  const steps = [];
  const see = facts => steps.push(next(facts).step);
  see(f);
  see({ ...f, bump: open });
  see({ ...f, bump: merged });
  see({ ...f, bump: merged, run: { status: 'in_progress' } });
  const released = { ...f, bump: merged, release: { html_url: 'r' } };
  see(released);
  see({ ...released, wrappers: open });
  see({ ...released, wrappers: merged });
  see({ ...released, wrappers: merged, callers: callers(open) });
  see({ ...released, wrappers: merged, callers: callers(merged) });
  assert.deepEqual(steps, ['bump', 'wait', 'release', 'wait', 'wrappers', 'wait', 'callers', 'wait', 'done']);
  assert.deepEqual(next({ ...released, wrappers: merged, callers: [{ repository: 'o/tracker', pr: open }, { repository: 'o/board', pr: null }] }),
    { step: 'callers', repositories: ['o/board'] });
  assert.equal(next({ ...f, release: { html_url: 'r' } }).step, 'wrappers', 'a release cut by hand needs no bump');
});

test('versions compare by number', () => {
  assert.ok(older('0.5.2', '0.5.3'));
  assert.ok(older('0.5.10', '0.6.0'));
  assert.ok(!older('0.5.10', '0.5.9'));
  assert.ok(!older('0.6.1', '0.6.1'));
  assert.throws(() => older('0.6', '0.6.1'), Stall);
});

test('a closed PR or a failed release halts the train rather than retrying', () => {
  const closed = { state: 'closed', merged: false };
  const merged = { state: 'closed', merged: true };
  assert.equal(next({ bump: closed, release: null }).step, 'stall');
  assert.equal(next({ bump: merged, release: null, run: { status: 'completed', conclusion: 'failure' } }).step, 'stall');
  assert.equal(next({ bump: merged, release: {}, wrappers: closed }).step, 'stall');
  assert.equal(next({ bump: merged, release: {}, wrappers: merged, callers: [{ repository: 'o/r', pr: closed }] }).step, 'stall');
});

const toml = '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "0.5.2"\nedition = "2024"\n\n[workspace.dependencies]\nfoo = { version = "0.5.2" }\n';
const lock = 'version = 4\n\n[[package]]\nname = "agentic-job"\nversion = "0.5.2"\ndependencies = [\n "foo",\n]\n\n[[package]]\nname = "foo"\nversion = "0.5.2"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';

test('the version bump raises the workspace and its path packages only', () => {
  assert.equal(workspaceVersion(toml), '0.5.2');
  const out = bumpCargo({ 'Cargo.toml': toml, 'Cargo.lock': lock }, '0.5.2', '0.5.3');
  assert.equal(out['Cargo.toml'], toml.replace('version = "0.5.2"\nedition', 'version = "0.5.3"\nedition'));
  assert.equal(out['Cargo.lock'], lock.replace('agentic-job"\nversion = "0.5.2"', 'agentic-job"\nversion = "0.5.3"'));
  assert.throws(() => bumpCargo({ 'Cargo.toml': toml, 'Cargo.lock': lock }, '0.5.1', '0.5.2'), Stall);
});

test('the wrappers move every release pin and the version named beside it', () => {
  const wrapper = [
    '# Composed from agentic-job v0.5.2\'s review.yml. Since v0.5.0 check.yml asks more.',
    '    uses: o/agentic-job/.github/workflows/policy.yml@v0.5.2',
    '    uses: o/agentic-job/.github/workflows/check.yml@v0.5.2',
    '    uses: o/other/.github/workflows/check.yml@v0.5.2',
    'It composes agentic-job **v0.5.2**.',
  ].join('\n');
  const { files, from } = repin({ a: wrapper }, 'o/agentic-job', 'agentic-job', { pin: 'v0.5.3', version: '0.5.3' });
  assert.deepEqual(from, { pin: 'v0.5.2', version: '0.5.2' });
  assert.equal(files.a, wrapper
    .replace('agentic-job v0.5.2', 'agentic-job v0.5.3')
    .replace('policy.yml@v0.5.2', 'policy.yml@v0.5.3')
    .replace('check.yml@v0.5.2', 'check.yml@v0.5.3')
    .replace('**v0.5.2**', '**v0.5.3**'));
  assert.match(files.a, /o\/other\/\.github\/workflows\/check\.yml@v0\.5\.2/, 'another repository\'s pin is left');
  assert.match(files.a, /Since v0\.5\.0/);
  assert.throws(() => repin({ a: wrapper.replace('check.yml@v0.5.2', 'check.yml@v0.5.1') }, 'o/agentic-job', 'agentic-job', { pin: 'v0.5.3', version: '0.5.3' }), Stall);
});

test('a caller moves its commit pin and the test that asserts it', () => {
  const old = '5'.repeat(40);
  const sha = 'b'.repeat(40);
  const workflow = `    uses: o/actions/.github/workflows/cgwalters-review.yml@${old} # main, agentic-job v0.5.1 (actions#46)\n`;
  const check = `test('uses the agentic-job v0.5.1 pin', () => {\n  assert.match(w, /review\\.yml@${old} # main, agentic-job v0\\.5\\.1 /);\n});\n`;
  const { files } = repin({ 'review.yml': workflow, 'test.cjs': check }, 'o/actions', 'agentic-job', { pin: sha, version: '0.5.10' });
  assert.equal(files['review.yml'], workflow.replace(old, sha).replace('v0.5.1', 'v0.5.10'));
  assert.equal(files['test.cjs'], check.replace(old, sha).replace('v0.5.1 pin', 'v0.5.10 pin').replace('v0\\.5\\.1', 'v0\\.5\\.10'));
  assert.throws(() => repin({ 'review.yml': workflow, 'other.cjs': 'nothing here' }, 'o/actions', 'agentic-job', { pin: sha, version: '0.5.2' }), Stall, 'a file without the pin');
  assert.throws(() => repin({ 'review.yml': workflow }, 'o/actions', 'agentic-job', { pin: old, version: '0.5.1' }), Stall, 'already pinned');
});

// A fake GitHub for whole passes: GETs answer from routes, writes are logged.
function fake(routes) {
  const writes = [];
  const api = async (method, path, body) => {
    if (method !== 'GET') {
      writes.push([method, path, body]);
      return { html_url: `https://example/${writes.length}`, number: 7, sha: 's', title: body?.title, labels: [] };
    }
    const key = path.split('?')[0];
    const route = routes[key];
    if (route === undefined) throw Object.assign(new Error(`unrouted ${key}`), { status: 404 });
    return typeof route === 'function' ? route(path) : route;
  };
  return { api, writes };
}

const b64 = s => ({ encoding: 'base64', content: Buffer.from(s).toString('base64') });
const R = config.release.repository;
const W = config.wrappers.repository;
const tagged = '9'.repeat(40);
function startRoutes(merged) {
  return {
    [`/repos/${config.tracking}/issues`]: [],
    [`/repos/${R}/releases/latest`]: { tag_name: 'v0.5.2', published_at: new Date(now - 30 * hour).toISOString() },
    [`/repos/${R}`]: { default_branch: 'main' },
    [`/repos/${R}/commits/main`]: { sha: 'c'.repeat(40), commit: { tree: { sha: 't' } } },
    [`/repos/${R}/commits/v0.5.3`]: { sha: tagged },
    [`/repos/${R}/compare/main...${tagged}`]: { status: 'behind' },
    [`/repos/${R}/contents/Cargo.toml`]: b64(toml),
    [`/repos/${R}/contents/Cargo.lock`]: b64(lock),
    '/search/issues': { total_count: merged.length, incomplete_results: false, items: merged.map(p => ({ ...p, labels: p.labels.map(name => ({ name })) })) },
    [`/repos/${config.release.fork}`]: { parent: { full_name: R } },
    [`/repos/${R}/pulls`]: [],
    [`/repos/${W}/pulls`]: [],
    [`/repos/${W}`]: { default_branch: 'main' },
    [`/repos/${W}/commits/main`]: { sha: 'd'.repeat(40), commit: { tree: { sha: 't' } } },
    [`/repos/${config.wrappers.fork}`]: { parent: { full_name: W } },
    ...Object.fromEntries(config.wrappers.files.map(path => [`/repos/${W}/contents/${path}`, b64(`agentic-job v0.5.2\n    uses: ${R}/.github/workflows/check.yml@v0.5.2\n`)])),
    ...Object.fromEntries(config.callers.map(c => [`/repos/${c.repository}/pulls`, []])),
  };
}

test('a dry run plans the bump and writes nothing', async () => {
  const { api, writes } = fake(startRoutes(prs(5, ['breaking'])));
  const lines = [];
  await pass({ api, now, log: l => lines.push(l), owner: 'bot' });
  assert.deepEqual(writes, []);
  assert.match(lines.join('\n'), /due: 5 pull requests merged since v0\.5\.2; next is v0\.6\.0/);
  assert.match(lines.join('\n'), /would: open a PR on .* changing Cargo\.toml, Cargo\.lock: release: Prepare 0\.6\.0/);
});

test('an applied pass opens the tracking issue and the bump from the bot\'s fork', async () => {
  const { api, writes } = fake(startRoutes(prs(1, ['P0'])));
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  const fork = config.release.fork;
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [
    `POST /repos/${config.tracking}/issues`,
    `POST /repos/${fork}/git/trees`,
    `POST /repos/${fork}/git/commits`,
    `POST /repos/${fork}/git/refs`,
    `POST /repos/${R}/pulls`,
    `POST /repos/${config.tracking}/issues/7/comments`,
  ]);
  assert.equal(writes[0][2].title, 'agentic-job v0.5.3 release train');
  assert.deepEqual(writes[4][2], { title: 'release: Prepare 0.5.3', body: writes[4][2].body, head: `${fork.split('/')[0]}:release-train/v0.5.3`, base: 'main' });
});

test('a pass follows only the bot\'s tracking issue, and a stalled one halts', async () => {
  const issue = (login, labels = []) => ({ number: 3, html_url: 'i', title: 'agentic-job v0.5.3 release train', user: { login }, labels });
  const routes = startRoutes([]);
  routes[`/repos/${config.tracking}/issues`] = [issue('someone')];
  let lines = [];
  await pass({ api: fake(routes).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /not due/);
  routes[`/repos/${config.tracking}/issues`] = [issue('bot', [{ name: 'needs-human' }])];
  lines = [];
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: l => lines.push(l), owner: 'bot' });
  assert.deepEqual(writes, []);
  assert.match(lines.join('\n'), /halted/);
});

test('an applied pass dispatches release.yml once the bump merged, and stalls on a closed bump', async () => {
  const routes = startRoutes([]);
  routes[`/repos/${config.tracking}/issues`] = [{ number: 3, html_url: 'i', title: 'agentic-job v0.5.3 release train', user: { login: 'bot' }, labels: [] }];
  routes[`/repos/${R}/pulls`] = [{ state: 'closed', merged_at: '2026-10-16T10:00:00Z', html_url: 'p' }];
  routes[`/repos/${R}/actions/workflows/${config.release.workflow}/runs`] = path => {
    assert.match(decodeURIComponent(path), /created=>=2026-10-16T10:00:00Z/);
    return { workflow_runs: [] };
  };
  let fakeGitHub = fake(routes);
  await pass({ api: fakeGitHub.api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.deepEqual(fakeGitHub.writes.slice(0, 1), [['POST', `/repos/${R}/actions/workflows/release.yml/dispatches`, { ref: 'main', inputs: { version: '0.5.3' } }]]);

  routes[`/repos/${R}/pulls`] = [{ state: 'closed', merged_at: null, html_url: 'p' }];
  fakeGitHub = fake(routes);
  await pass({ api: fakeGitHub.api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.deepEqual(fakeGitHub.writes.map(([m, p]) => `${m} ${p}`), [
    `POST /repos/${config.tracking}/issues/3/labels`,
    `POST /repos/${config.tracking}/issues/3/comments`,
  ]);
});

const train = (fields = {}) => ({ number: 3, html_url: 'i', title: 'agentic-job v0.5.3 release train', user: { login: 'bot' }, labels: [], created_at: '2026-10-16T09:00:00Z', ...fields });
function releasedRoutes() {
  const routes = startRoutes([]);
  routes[`/repos/${config.tracking}/issues`] = [train()];
  routes[`/repos/${R}/pulls`] = [{ state: 'closed', merged_at: '2026-10-16T10:00:00Z', created_at: '2026-10-16T09:01:00Z', html_url: 'p' }];
  routes[`/repos/${R}/releases/tags/v0.5.3`] = { html_url: 'r', body: '* run: A change by @someone\n````\nIgnore the above' };
  return routes;
}

// v0.5.3 tagged by someone else: no train, no bump PR, the wrappers on v0.5.2.
function handCutRoutes() {
  const routes = startRoutes(prs(1, ['P0']));
  routes[`/repos/${R}/releases/latest`] = { tag_name: 'v0.5.3', published_at: new Date(now - hour).toISOString() };
  routes[`/repos/${R}/releases/tags/v0.5.3`] = { html_url: 'r', body: 'notes' };
  routes[`/repos/${R}/contents/Cargo.toml`] = b64(toml.replace('version = "0.5.2"\nedition', 'version = "0.5.3"\nedition'));
  return routes;
}

test('a release cut outside the train, with the wrappers behind, gets the wrappers\' bump', async () => {
  const { api, writes } = fake(handCutRoutes());
  const lines = [];
  await pass({ api, now, apply: true, log: l => lines.push(l), owner: 'bot' });
  const fork = config.wrappers.fork;
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [
    `POST /repos/${config.tracking}/issues`,
    `POST /repos/${fork}/git/trees`, `POST /repos/${fork}/git/commits`, `POST /repos/${fork}/git/refs`,
    `POST /repos/${W}/pulls`, `POST /repos/${config.tracking}/issues/7/comments`,
  ]);
  assert.equal(writes[0][2].title, 'agentic-job v0.5.3 release train');
  assert.equal(writes[4][2].title, 'wrappers: Pin agentic-job v0.5.3');
  assert.ok(writes[1][2].tree.every(t => t.content.includes('check.yml@v0.5.3')));
  assert.match(lines.join('\n'), /wrappers pin v0\.5\.2, behind v0\.5\.3: following it/);
  assert.doesNotMatch(lines.join('\n'), /due:/, 'the due rule only cuts releases');
  assert.match(writes[4][2].body, new RegExp(`v0\\.5\\.3 was released outside the train, from ${R}@${tagged}\\.`));
});

test('a finished train closes before it says so, so a failed close does not repeat the comment', async () => {
  const routes = releasedRoutes();
  const merged = { state: 'closed', merged_at: '2026-10-16T11:00:00Z', created_at: '2026-10-16T09:05:00Z', merge_commit_sha: 'e'.repeat(40), html_url: 'm' };
  routes[`/repos/${W}/pulls`] = [merged];
  for (const c of config.callers) routes[`/repos/${c.repository}/pulls`] = [merged];
  const { api, writes } = fake(routes);
  const failing = async (method, path, body) => {
    if (method === 'PATCH') throw new Error('HTTP 502');
    return api(method, path, body);
  };
  await assert.rejects(pass({ api: failing, now, apply: true, log: () => {}, owner: 'bot' }), /HTTP 502/);
  assert.deepEqual(writes, []);
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [
    `PATCH /repos/${config.tracking}/issues/3`,
    `POST /repos/${config.tracking}/issues/3/comments`,
  ]);
});

test('a release tagged off the default branch is not followed, and cutting goes on', async () => {
  const routes = handCutRoutes();
  routes[`/repos/${R}/compare/main...${tagged}`] = { status: 'diverged' };
  const lines = [];
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), new RegExp(`not following v0\\.5\\.3: v0\\.5\\.3 is at ${tagged}, which is not on ${R}'s main`));
  assert.equal(writes[0][2].title, 'agentic-job v0.5.4 release train', 'the P0 is cut');
  // A tag moved off the default branch after the train began halts it.
  routes[`/repos/${config.tracking}/issues`] = [train()];
  const moved = fake(routes);
  await pass({ api: moved.api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.ok(!moved.writes.some(([, p]) => p.includes('/git/')));
  assert.match(moved.writes.at(-1)[2].body, /not on .*'s main/);
});

test('an API error reading the wrappers does not hold up cutting', async () => {
  const routes = handCutRoutes();
  delete routes[`/repos/${W}/contents/${config.wrappers.files[0]}`];
  const lines = [];
  await pass({ api: fake(routes).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /not following v0\.5\.3: unrouted/);
  assert.match(lines.join('\n'), /due: a P0 fix merged since v0\.5\.3/);
  const budget = fake(handCutRoutes());
  const api = (m, p, b) => p.startsWith(`/repos/${W}/contents/`) ? Promise.reject(new Error('request budget exhausted')) : budget.api(m, p, b);
  await assert.rejects(pass({ api, now, log: () => {}, owner: 'bot' }), /budget/);
});

test('a hand tag of the train\'s version while its bump is open halts the train', async () => {
  assert.equal(next({ bump: { state: 'open', merged: false }, release: {} }).step, 'stall');
  assert.equal(next({ bump: { state: 'closed', merged: false }, release: {}, wrappers: null }).step, 'wrappers');
});

test('a release tag without the v prefix is not followed', async () => {
  const routes = handCutRoutes();
  routes[`/repos/${R}/releases/latest`] = { tag_name: '0.5.3', published_at: new Date(now - hour).toISOString() };
  const lines = [];
  await pass({ api: fake(routes).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /not following 0\.5\.3: 0\.5\.3 is not a vX\.Y\.Z tag/);
});

test('the followed train moves the callers once the wrappers\' bump merged', async () => {
  const routes = handCutRoutes();
  routes[`/repos/${config.tracking}/issues`] = [train()];
  routes[`/repos/${W}/pulls`] = [{ state: 'closed', merged_at: '2026-10-16T11:00:00Z', created_at: '2026-10-16T09:05:00Z', merge_commit_sha: 'e'.repeat(40), html_url: 'w' }];
  for (const c of config.callers) {
    routes[`/repos/${c.fork}`] = { parent: { full_name: c.repository } };
    routes[`/repos/${c.repository}`] = { default_branch: 'main' };
    routes[`/repos/${c.repository}/commits/main`] = { sha: 'f'.repeat(40), commit: { tree: { sha: 't' } } };
    for (const path of c.files) routes[`/repos/${c.repository}/contents/${path}`] = b64(`uses: ${W}/.github/workflows/cgwalters-review.yml@${'5'.repeat(40)} # agentic-job v0.5.2\n`);
  }
  const lines = [];
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /v0\.5\.3: callers\n/);
  const trees = writes.filter(([, p]) => p.endsWith('/git/trees'));
  assert.equal(trees.length, config.callers.length);
  assert.ok(trees.every(([, , body]) => body.tree.every(t => t.content.includes(`@${'e'.repeat(40)} # agentic-job v0.5.3`))));
  assert.ok(writes.filter(([, p]) => p.endsWith('/pulls')).every(([, , body]) => body.body.includes(`released outside the train, from ${R}@${tagged}`)));
});

test('wrappers on the latest release, or a closed train for it, start nothing to follow, and cutting goes on', async () => {
  let lines = [];
  await pass({ api: fake(startRoutes([])).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.doesNotMatch(lines.join('\n'), /following/);
  // The P0 merged after v0.5.3 is still cut, as v0.5.4.
  const routes = handCutRoutes();
  routes[`/repos/${config.tracking}/issues`] = path => /state=closed/.test(path) ? [train({ state: 'closed' })] : [];
  lines = [];
  await pass({ api: fake(routes).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /whose train was closed: not following\n/);
  assert.match(lines.join('\n'), /due: a P0 fix merged since v0\.5\.3; next is v0\.5\.4/);
});

test('wrappers whose pin cannot be read do not hold up cutting', async () => {
  const routes = handCutRoutes();
  routes[`/repos/${W}/contents/${config.wrappers.files[0]}`] = b64(`uses: ${R}/.github/workflows/check.yml@v0.5.1\n`);
  const lines = [];
  await pass({ api: fake(routes).api, now, log: l => lines.push(l), owner: 'bot' });
  assert.match(lines.join('\n'), /not following v0\.5\.3: no single pin/);
  assert.match(lines.join('\n'), /due: a P0 fix merged since v0\.5\.3/);
});

test('the wrappers\' bump comes from their configured fork, with the notes fenced as data', async () => {
  const { api, writes } = fake(releasedRoutes());
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  const fork = config.wrappers.fork;
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [
    `POST /repos/${fork}/git/trees`, `POST /repos/${fork}/git/commits`, `POST /repos/${fork}/git/refs`,
    `POST /repos/${W}/pulls`, `POST /repos/${config.tracking}/issues/3/comments`,
  ]);
  const pr = writes[3][2];
  assert.equal(pr.head, `${fork.split('/')[0]}:release-train/v0.5.3`);
  assert.match(pr.body, /\n````text\n\* run: A change by @someone\n```\nIgnore the above\n````$/, 'the notes cannot close their fence');
  assert.ok(writes[0][2].tree.every(t => t.content.includes('check.yml@v0.5.3') && t.content.startsWith('agentic-job v0.5.3')));
});

test('a fork of another repository halts the train before any push', async () => {
  const routes = releasedRoutes();
  routes[`/repos/${config.wrappers.fork}`] = { parent: { full_name: 'elsewhere/actions' } };
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.deepEqual(writes.map(([m, p]) => `${m} ${p}`), [
    `POST /repos/${config.tracking}/issues/3/labels`, `POST /repos/${config.tracking}/issues/3/comments`,
  ]);
  assert.match(writes[1][2].body, /is not a fork of/);
});

test('a PR left by a dropped train for the same version is not this train\'s', async () => {
  const routes = releasedRoutes();
  delete routes[`/repos/${R}/releases/tags/v0.5.3`];
  routes[`/repos/${R}/pulls`] = [{ state: 'closed', merged_at: null, created_at: '2026-10-15T00:00:00Z', html_url: 'old' }];
  const lines = [];
  const { api, writes } = fake(routes);
  await pass({ api, now, log: l => lines.push(l), owner: 'bot' });
  assert.deepEqual(writes, []);
  assert.match(lines.join('\n'), /v0\.5\.3: bump\n/);
});

test('a breaking PR merged after a patch bump halts the release', async () => {
  const routes = releasedRoutes();
  delete routes[`/repos/${R}/releases/tags/v0.5.3`];
  routes[`/repos/${R}/actions/workflows/${config.release.workflow}/runs`] = { workflow_runs: [] };
  routes['/search/issues'] = { total_count: 1, incomplete_results: false, items: [{ number: 5, title: 'x', labels: [{ name: 'breaking' }] }] };
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.ok(!writes.some(([, p]) => p.endsWith('/dispatches')));
  assert.match(writes.at(-1)[2].body, /labelled breaking merged/);
});

test('a dropped train\'s PR still open on the branch halts rather than being force-pushed', async () => {
  const routes = releasedRoutes();
  delete routes[`/repos/${R}/releases/tags/v0.5.3`];
  routes[`/repos/${R}/pulls`] = path => /state=open/.test(path)
    ? [{ html_url: 'old-open' }]
    : [{ state: 'open', merged_at: null, created_at: '2026-10-15T00:00:00Z', html_url: 'old-open' }];
  const { api, writes } = fake(routes);
  await pass({ api, now, apply: true, log: () => {}, owner: 'bot' });
  assert.ok(!writes.some(([, p]) => p.includes('/git/')));
  assert.match(writes.at(-1)[2].body, /old-open from a dropped train is still open/);
});
