// node --test .github/sync/sync.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { MAX_CALLERS, decide, findPins, main, task, validateManifest } = require('./sync.cjs');

const SOURCE = 'cgwalters-forge/agentic-job';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BOT = 'bot';
const FILE = '.github/workflows/review.yml';
const caller = { repo: 'o/caller', issue: 7, files: [FILE] };
const uses = ref => `jobs:\n  review:\n    uses: ${SOURCE}/.github/workflows/review.yml@${ref}\n`;
const files = text => ({ [FILE]: { pins: findPins(text, SOURCE) } });
const run = (fields = {}) => decide({ caller, head: HEAD, files: files(uses(OLD)), pulls: [], runs: [], bot: BOT, ...fields });

test('findPins reads every reference to the source and nothing else', () => {
  const text = [
    `uses: ${SOURCE}/.github/workflows/policy.yml@${HEAD}`,
    `uses: ${SOURCE}/.github/workflows/apply.yml@${OLD} # v1`,
    `uses: ${SOURCE}@v2`,
    `uses: ${SOURCE}-fork/.github/workflows/x.yml@${OLD}`,
    `uses: other/${SOURCE}/x.yml@${OLD}`,
    `uses: actions/checkout@${OLD}`,
    `# was ${SOURCE}@v1.`,
    `run: echo ${SOURCE}@v1`,
    `  - uses: '${SOURCE}/a.yml@main'`,
  ].join('\n');
  assert.deepEqual(findPins(text, SOURCE), [HEAD, OLD, 'v2', 'main']);
  assert.deepEqual(findPins(`uses: ${SOURCE.toUpperCase()}@${OLD}`, SOURCE), [OLD]);
});

test('the pins of the actions wrapper are found', () => {
  // Three uses at one commit, as cgwalters-agentic-job.yml has them.
  const text = ['policy', 'check', 'apply'].map(w => `    uses: ${SOURCE}/.github/workflows/${w}.yml@${OLD}`).join('\n');
  assert.deepEqual(findPins(text, SOURCE), [OLD, OLD, OLD]);
});

test('a caller at the head is left alone', () => {
  assert.equal(run({ files: files(uses(HEAD)) }).action, 'none');
});

test('a caller behind is dispatched, its old pins named once', () => {
  const d = run({ files: files(uses(OLD) + uses(OLD) + uses(HEAD)) });
  assert.equal(d.action, 'dispatch');
  assert.deepEqual(d.behind, [{ file: FILE, pins: [OLD] }]);
});

test('a tag or branch pin is behind too', () => {
  assert.equal(run({ files: files(uses('main')) }).action, 'dispatch');
});

test('a missing file, or one without pins, is reported and not dispatched', () => {
  assert.match(run({ files: { [FILE]: null } }).reason, /missing/);
  assert.equal(run({ files: { [FILE]: null } }).action, 'skip');
  assert.match(run({ files: files('name: review\n') }).reason, /pins nothing/);
});

test('an open dispatch pull request of the bot on a pinned file holds the dispatch', () => {
  const pull = { number: 3, author: BOT, branch: 'dispatch/implement/agent-run-1', files: [FILE] };
  assert.equal(run({ pulls: [pull] }).action, 'skip');
  // Someone else's, another branch's, or one on other files does not.
  for (const other of [{ author: 'someone' }, { branch: 'topic' }, { files: ['README.md'] }]) {
    assert.equal(run({ pulls: [{ ...pull, ...other }] }).action, 'dispatch', JSON.stringify(other));
  }
});

test('a run for the same item that is not done holds the dispatch', () => {
  for (const title of ['implement o/caller#7', 'implement o/caller#7 (claude)']) {
    assert.equal(run({ runs: [{ id: 1, status: 'queued', title }] }).action, 'skip', title);
    assert.equal(run({ runs: [{ id: 1, status: 'completed', title }] }).action, 'dispatch', title);
  }
  for (const title of ['implement o/caller#70', 'fix o/caller#7', 'implement o/caller#7x']) {
    assert.equal(run({ runs: [{ id: 1, status: 'in_progress', title }] }).action, 'dispatch', title);
  }
});

test('a caller without an issue is reported, not dispatched', () => {
  const d = run({ caller: { ...caller, issue: undefined } });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /no issue/);
});

test('the task names the head, each old pin and the compare link', () => {
  const t = task({ caller, source: SOURCE, branch: 'main', head: HEAD, behind: run().behind, dispatchRepo: 'o/tracker' });
  assert.match(t, new RegExp(`commit ${HEAD}`));
  assert.ok(t.includes(`\`${FILE}\` pins \`${OLD}\``));
  assert.ok(t.includes(`https://github.com/${SOURCE}/compare/${OLD}...${HEAD}`));
});

test('validateManifest refuses what would make a pass go wrong', () => {
  const good = { source: SOURCE, branch: 'main', bot: BOT, callers: [caller] };
  assert.doesNotThrow(() => validateManifest(good));
  const bad = [
    { callers: [] },
    { callers: Array.from({ length: MAX_CALLERS + 1 }, (_, i) => ({ ...caller, repo: `o/c${i}` })) },
    { callers: [caller, caller] },
    { callers: [{ ...caller, repo: SOURCE }] },
    { callers: [{ ...caller, issue: 0 }] },
    { callers: [{ ...caller, issue: '7' }] },
    { callers: [{ ...caller, files: [] }] },
    { callers: [{ ...caller, files: ['../x.yml'] }] },
    { callers: [{ ...caller, files: ['/etc/passwd'] }] },
    { source: 'nope' },
    { bot: 'a b' },
  ];
  for (const change of bad) assert.throws(() => validateManifest({ ...good, ...change }), /manifest\.json/, JSON.stringify(change).slice(0, 80));
});

test('the manifest is valid and every caller is one dispatch.toml lets a run target and edit .github/ in', () => {
  const manifest = validateManifest(require('./manifest.json'));
  const toml = fs.readFileSync(path.join(__dirname, '../agentic-job/dispatch.toml'), 'utf8');
  const repos = JSON.parse(/^repos = (\[.*\])$/m.exec(toml)[1]);
  const unprotected = JSON.parse(/^repos = (\[.*\])$/m.exec(toml.split('\n[unprotected_files]\n')[1])[1]);
  for (const c of manifest.callers) {
    assert.ok(repos.includes(c.repo), c.repo);
    assert.ok(unprotected.includes(c.repo), c.repo);
  }
});

// In CI, where GITHUB_REPOSITORY names this repository (a fork is no
// caller), its own entry must point at files here that pin the source.
const self = require('./manifest.json').callers.find(c => c.repo === process.env.GITHUB_REPOSITORY);
test("this repository's own pinned files are where the manifest says", { skip: !self }, () => {
  const manifest = require('./manifest.json');
  for (const f of self.files) {
    const text = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
    assert.ok(findPins(text, manifest.source).length, f);
  }
});

// A pass against a stubbed API: one caller behind, one whose file is gone.
async function pass(argv) {
  const manifest = { source: SOURCE, branch: 'main', bot: BOT, callers: [caller, { repo: 'o/gone', issue: 1, files: [FILE] }] };
  const answers = {
    [`/repos/${SOURCE}/commits/main`]: { sha: HEAD },
    '/repos/o/tracker/actions/workflows/dispatch.yml/runs?per_page=100': { workflow_runs: [] },
    [`/repos/o/caller/contents/${FILE}`]: { content: Buffer.from(uses(OLD)).toString('base64') },
    '/repos/o/caller/pulls?state=open&per_page=100': [],
    '/repos/o/gone/pulls?state=open&per_page=100': [],
  };
  const calls = [];
  const saved = { fetch: globalThis.fetch, log: console.log, env: { ...process.env } };
  globalThis.fetch = async (url, { method, body }) => {
    const key = url.replace('https://api.github.com', '');
    calls.push({ method, key, body: body && JSON.parse(body) });
    const answer = method === 'POST' ? null : answers[key];
    return { ok: answer !== undefined, status: answer === undefined ? 404 : 200, text: async () => answer == null ? '' : JSON.stringify(answer) };
  };
  const lines = [];
  console.log = line => lines.push(line);
  Object.assign(process.env, { GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/tracker', DEFAULT_BRANCH: 'main' });
  try {
    await main(argv, { manifest });
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    process.env = saved.env;
  }
  return { calls, lines };
}

test('a dry run starts nothing; a missing file is reported, not an error', async () => {
  const { calls, lines } = await pass(['--dry-run']);
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), []);
  assert.ok(lines.some(l => /o\/caller dispatch: behind/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /o\/gone skip: missing/.test(l)), lines.join('\n'));
});

test('a pass dispatches the caller behind on its issue, from the default branch', async () => {
  const { calls } = await pass([]);
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].key, '/repos/o/tracker/actions/workflows/dispatch.yml/dispatches');
  assert.equal(posts[0].body.ref, 'main');
  assert.deepEqual({ ...posts[0].body.inputs, task: undefined }, { task: undefined, repo: 'o/caller', item: '7', kind: 'implement' });
  assert.ok(posts[0].body.inputs.task.includes(HEAD));
});
