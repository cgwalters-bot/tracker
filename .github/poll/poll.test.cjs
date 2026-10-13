// node --test .github/poll/poll.test.cjs
// The fixtures in testdata/ are recorded API answers: pull-470 is a dispatch
// run's pull request from the bot's fork, approved and green; pull-143 is a
// draft on a branch of the repository itself whose `ci` failed.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CONFIG, classifyChecks, decide, findMarker, fixTask, inFlight, markerBody, poolForRound, reviewText, writeOutput } = require('./poll.cjs');

const load = name => structuredClone(require(`./testdata/${name}.json`));
const required = load('rules-agentic-job').flatMap(r => r.parameters.required_status_checks.map(c => c.context));
const BOT = CONFIG.author;
const NOW = Date.parse('2026-10-12T02:00:00Z');

// A recorded pull request with some of its head's contexts replaced.
// Mergeable unless a case says otherwise: pull-470 was recorded while GitHub
// had no answer yet, and both before the query asked for the base.
function pull(name, { contexts = {}, ...fields } = {}) {
  const p = Object.assign(load(name), { mergeable: 'MERGEABLE', baseRefName: 'main' }, fields);
  const nodes = p.commits.nodes[0].commit.statusCheckRollup.contexts.nodes;
  for (const [key, change] of Object.entries(contexts)) {
    const index = nodes.findIndex(n => (n.name ?? n.context) === key);
    assert.notEqual(index, -1, `fixture has no context ${key}`);
    if (change === null) nodes.splice(index, 1);
    else Object.assign(nodes[index], change);
  }
  return p;
}

const HEAD = load('pull-470').headRefOid;
const ciFailed = { ci: { conclusion: 'FAILURE' } };
const changes = { review: { state: 'FAILURE' } };
const conflict = { mergeable: 'CONFLICTING' };
const label = { labels: { nodes: [{ name: CONFIG.label }] } };

const cases = [
  ['approved and green merges', 'pull-470', {}, {}, 'merge'],
  ['approved with auto-merge on is left alone', 'pull-470', { autoMergeRequest: { enabledAt: 'x' } }, {}, 'skip'],
  ['approved and queued is left alone', 'pull-470', { mergeQueueEntry: { state: 'QUEUED' } }, {}, 'skip'],
  ['approved but conflicting gets a fix', 'pull-470', conflict, {}, 'fix', 1],
  ['conflicting with no verdict yet gets a fix', 'pull-470', { ...conflict, contexts: { review: null } }, {}, 'fix', 1],
  ['a conflict with a fix running for this head waits', 'pull-470', conflict,
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'in_progress', updated_at: '2026-10-12T01:00:00Z' } }, 'wait'],
  ['a conflict with the rounds exhausted goes to a human', 'pull-470', conflict,
    { marker: { rounds: 2, sha: 'older' } }, 'needs-human'],
  ['another fork\'s conflicting branch gets no fix', 'pull-470',
    { ...conflict, headRepositoryOwner: { login: 'someone' } }, {}, 'skip'],
  ['approved with mergeability unknown waits', 'pull-470', { mergeable: 'UNKNOWN' }, {}, 'wait'],
  ['approved with ci running waits', 'pull-470', { contexts: { ci: { status: 'IN_PROGRESS', conclusion: null } } }, {}, 'wait'],
  ['approved with ci not reported waits', 'pull-470', { contexts: { ci: null } }, {}, 'wait'],
  ['no review status waits', 'pull-470', { contexts: { review: null } }, {}, 'wait'],
  ['pending review waits', 'pull-470', { contexts: { review: { state: 'PENDING' } } }, {}, 'wait'],
  ['a draft with ci running is marked ready', 'pull-470',
    { isDraft: true, contexts: { review: null, ci: { status: 'QUEUED', conclusion: null } } }, {}, 'ready'],
  ['a draft with failed ci gets a fix, not ready', 'pull-470', { isDraft: true, contexts: ciFailed }, {}, 'fix', 1],
  ['changes requested starts round 1', 'pull-470', { contexts: changes }, {}, 'fix', 1],
  ['failed required check starts round 2 on a new head', 'pull-470', { contexts: ciFailed },
    { marker: { rounds: 1, sha: 'older' } }, 'fix', 2],
  ['a failed check that is not required is ignored', 'pull-470', { contexts: { rust: { conclusion: 'FAILURE' } } }, {}, 'merge'],
  ['a fix already started for this head waits', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'in_progress', updated_at: '2026-10-12T01:00:00Z' } }, 'wait'],
  ['a fix that just finished gets time to show its push', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'completed', updated_at: '2026-10-12T01:58:00Z' } }, 'wait'],
  ['a fix that ended without a push goes to a human', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'completed', updated_at: '2026-10-12T01:00:00Z' } }, 'needs-human'],
  ['a fix with no run id times out to a human', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, at: '2026-10-11T12:00:00Z' } }, 'needs-human'],
  ['rounds exhausted goes to a human', 'pull-470', { contexts: changes }, { marker: { rounds: 2, sha: 'older' } }, 'needs-human'],
  ['needs-human is never touched again', 'pull-470', { ...label, contexts: changes }, {}, 'skip'],
  ['a failing draft on our own branch is its author\'s', 'pull-143', {}, {}, 'skip'],
  ['a green draft on our own branch is its author\'s', 'pull-143', { contexts: { ci: { conclusion: 'SUCCESS' } } }, {}, 'skip'],
  ['another fork\'s dispatch/ branch gets no fix', 'pull-470',
    { headRepositoryOwner: { login: 'someone' }, contexts: changes }, {}, 'skip'],
];

for (const [name, fixture, change, { marker = { rounds: 0 }, fixRun = null }, action, round] of cases) {
  test(name, () => {
    const p = pull(fixture, change);
    const got = decide({ pull: p, checks: classifyChecks(p, required), marker, fixRun, now: NOW });
    assert.equal(got.action, action, got.reason);
    assert.equal(got.round, round);
  });
}

// Which pull requests keep the passes coming: [name, fixture, change, the
// pass's action, in flight].
const flights = [
  ['a dispatch pull request that waits', 'pull-470', {}, 'wait', true],
  ['one a fix was just started for', 'pull-470', { contexts: changes }, 'fix', true],
  ['one with auto-merge on, until it has merged', 'pull-470', { autoMergeRequest: { enabledAt: 'x' } }, 'skip', true],
  ['one this pass handed to a human', 'pull-470', { contexts: changes }, 'needs-human', false],
  ['one labelled needs-human', 'pull-470', label, 'skip', false],
  ['another fork\'s dispatch/ branch', 'pull-470', { headRepositoryOwner: { login: 'someone' } }, 'skip', false],
  ['a branch of the repository itself', 'pull-143', {}, 'skip', false],
  ['the bot\'s own pull request being merged', 'pull-143', { isDraft: false }, 'merge', false],
];

for (const [name, fixture, change, action, expected] of flights) {
  test(`in flight: ${name}`, () => assert.equal(inFlight(pull(fixture, change), action), expected));
}

test('the in-flight output asks for another pass while anything is followed or unread', t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poll-test-')), 'output');
  const saved = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  t.after(() => {
    if (saved === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved;
    fs.rmSync(path.dirname(file), { recursive: true });
  });
  for (const [counts, expected] of [
    [{ errors: 0, inFlight: 0 }, false],
    [{ errors: 0, inFlight: 2 }, true],
    [{ errors: 1, inFlight: 0 }, true],
  ]) {
    fs.writeFileSync(file, '');
    assert.equal(writeOutput(counts), expected);
    assert.equal(fs.readFileSync(file, 'utf8'), `in-flight=${expected}\n`);
  }
});

test('the fix task names the series bound fix.toml sets', () => {
  const toml = fs.readFileSync(path.join(__dirname, '../agentic-job/fix.toml'), 'utf8');
  const bound = /^push_to_pull_request_branch = .*\breplacement_max_commits = (\d+)/m.exec(toml);
  assert.equal(Number(bound?.[1]), CONFIG.fixSeriesMaxCommits);
});

test('required checks come from the rules as well as isRequired', () => {
  // Recorded: GitHub reports isRequired false for `ci` on this draft.
  const p = pull('pull-143');
  assert.deepEqual(classifyChecks(p, required).failed.map(c => c.name), ['ci']);
  // With no rule and no flag, every check counts.
  assert.ok(classifyChecks(p, []).failed.length > 1);
  assert.equal(classifyChecks(p, required).review, null);
});

test('the marker round-trips and only the bot\'s counts', () => {
  const state = { rounds: 1, sha: HEAD, run: 42 };
  const mine = { id: 2, user: { login: BOT }, body: markerBody(state, 'Fix round 1 of 2.') };
  const forged = { id: 1, user: { login: 'visitor' }, body: markerBody({ rounds: 0 }, 'reset') };
  assert.deepEqual(findMarker([forged, mine], BOT), { id: 2, state });
  assert.deepEqual(findMarker([forged], BOT), { id: null, state: { rounds: 0 } });
  assert.deepEqual(findMarker(load('comments-470'), BOT), { id: null, state: { rounds: 0 } });
  assert.match(mine.body, /\nGenerated-by: https:\/\/github\.com\/cgwalters\/#llms$/);
});

test('the fix task carries the newest review and the failed job', () => {
  const comments = load('comments-470');
  // The recorded thread ends in an approval; the review before it asked for changes.
  const earlier = comments.filter(c => !c.body.startsWith('VERDICT: APPROVE'));
  const review = reviewText(earlier, BOT);
  assert.match(review, /^VERDICT: CHANGES/);
  assert.match(reviewText(comments, BOT), /^VERDICT: APPROVE/);
  assert.equal(reviewText([{ user: { login: 'visitor' }, body: 'VERDICT: APPROVE' }], BOT), null);

  const p = pull('pull-470', { contexts: { ...changes, ...ciFailed } });
  const task = fixTask({ repo: 'cgwalters-forge/agentic-job', pull: p, checks: classifyChecks(p, required), review, round: 2 });
  assert.match(task, /cgwalters-forge\/agentic-job#470 at head 488f45e/);
  assert.match(task, /fix round 2 of 2/);
  assert.match(task, /Fold the change into the commit it corrects/);
  assert.ok(task.includes(`at most ${CONFIG.fixSeriesMaxCommits} commits`));
  assert.match(task, /- ci: https:\/\/github\.com\/cgwalters-forge\/agentic-job\/actions\/runs\/\d+\/job\/\d+/);
  assert.ok(task.includes(review));
  assert.doesNotMatch(task, /Rebase/);

  // A conflict alone asks for the rebased series and nothing folded or added.
  const c = pull('pull-470', conflict);
  const rebase = fixTask({ repo: 'cgwalters-forge/agentic-job', pull: c, checks: classifyChecks(c, required), review: null, round: 1 });
  for (const want of [/fix round 1 of 2/, /Rebase its commits onto current main/, /keeping the intent of both sides/,
    /rerun the tests the change touches/, /replaces the branch/, /Add no commit on top/]) assert.match(rebase, want);
  assert.ok(rebase.includes(`at most ${CONFIG.fixSeriesMaxCommits} commits`));
  assert.doesNotMatch(rebase, /Fold the change/);

  const long = reviewText([{ user: { login: BOT }, body: `VERDICT: CHANGES\n${'x'.repeat(3 * CONFIG.reviewTextLimit)}` }], BOT);
  assert.ok(long.length < CONFIG.reviewTextLimit + 20 && long.endsWith('[cut]'));
});

test('fix rounds alternate over the pools dispatch.yml and pools.json name', () => {
  for (const [round, pool] of [[1, 'claude'], [2, 'openai'], [3, 'claude']]) {
    assert.equal(poolForRound(round), pool, `round ${round}`);
  }
  const pools = JSON.parse(fs.readFileSync(path.join(__dirname, '../agentic-job/pools.json'), 'utf8'));
  const dispatch = fs.readFileSync(path.join(__dirname, '../workflows/dispatch.yml'), 'utf8');
  const description = /^ {6}pool:\n(?:.*\n)*? {8}description: "([^"]*)"/m.exec(dispatch)?.[1];
  for (const name of Object.keys(pools)) assert.match(description, new RegExp(`\\b${name}\\b`));
  for (let round = 1; round <= CONFIG.maxFixRounds; round++) assert.ok(poolForRound(round) in pools);
});
