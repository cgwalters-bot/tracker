// node --test .github/poll/poll.test.cjs
// The fixtures in testdata/ are recorded API answers: pull-470 is a dispatch
// run's pull request from the bot's fork, approved and green; pull-143 is a
// draft on a branch of the repository itself whose `ci` failed; pull-511 is
// one of a run cut off before it wrote a message, approved and green under
// the harness's placeholder title and commit subject (it was merged so).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CONFIG, classifyChecks, decide, findMarker, fixTask, inFlight, markerBody, poolForFix, poolForKind, poolForRound, reviewText, toilOnly, writeOutput } = require('./poll.cjs');

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
const failedRun = { status: 'completed', conclusion: 'failure', updated_at: '2026-10-12T01:59:30Z' };
// pull-511 once a fix has given its commit a message: the title is as it was.
const reworded = { series: { nodes: [{ commit: { oid: 'f'.repeat(40), messageHeadline: 'check: Say why' } }] } };
const partialTitle = { title: '[partial: stopped at a limit] Wrote the first half' };
const partialBody = { body: '**Partial work.** The run was stopped at its timeout before the task was done; this is what it handed back.\n\nrest' };
const ciFailed = { ci: { conclusion: 'FAILURE' } };
const changes = { review: { state: 'FAILURE' } };
const conflict = { mergeable: 'CONFLICTING' };
const label = { labels: { nodes: [{ name: CONFIG.label }] } };
const stopped = { stopped: true };

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
  ['a fix that just succeeded gets time to show its push', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'completed', conclusion: 'success', updated_at: '2026-10-12T01:58:00Z' } }, 'wait'],
  ['a fix that succeeded without a push goes to a human', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'completed', conclusion: 'success', updated_at: '2026-10-12T01:00:00Z' } }, 'needs-human'],
  ['a fix run that just failed is blocked at once, with a round left', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: failedRun }, 'needs-human'],
  ['a cancelled fix run for a conflict is blocked at once', 'pull-470', conflict,
    { marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: { ...failedRun, conclusion: 'cancelled' } }, 'needs-human'],
  ['a failed fix run whose push shows is the next head\'s business', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: 'older', run: 7 }, fixRun: failedRun }, 'fix', 2],
  ['a fix with no run id times out to a human', 'pull-470', { contexts: changes },
    { marker: { rounds: 1, sha: HEAD, at: '2026-10-11T12:00:00Z' } }, 'needs-human'],
  ['rounds exhausted goes to a human', 'pull-470', { contexts: changes }, { marker: { rounds: 2, sha: 'older' } }, 'needs-human'],
  ['needs-human is never touched again', 'pull-470', { ...label, contexts: changes }, {}, 'skip'],
  // The markers needsHuman leaves, once the label is gone again (#511).
  ['removing needs-human starts again on the head the fix did not change', 'pull-470', { contexts: changes },
    { marker: { ...stopped, rounds: 1, sha: HEAD, run: 7 }, fixRun: { status: 'completed', updated_at: '2026-10-12T01:00:00Z' } }, 'fix', 1],
  ['removing needs-human gives used-up rounds back', 'pull-470', { contexts: changes },
    { marker: { ...stopped, rounds: 2, sha: 'older' } }, 'fix', 1],
  ['removing needs-human retries a fix run that could not be started', 'pull-470', { contexts: changes },
    { marker: { ...stopped, rounds: 1, sha: HEAD, at: '2026-10-12T01:59:00Z' } }, 'fix', 1],
  ['removing needs-human on a conflicting head rebases it', 'pull-470', conflict,
    { marker: { ...stopped, rounds: 2, sha: HEAD, run: 7 }, fixRun: { status: 'completed', updated_at: '2026-10-12T01:00:00Z' } }, 'fix', 1],
  ['a stopped pull request still labelled stays stopped', 'pull-470', { ...label, contexts: changes },
    { marker: { ...stopped, rounds: 2, sha: HEAD } }, 'skip'],
  ['a stopped pull request that is approved and green merges', 'pull-470', {}, { marker: { ...stopped, rounds: 2, sha: HEAD } }, 'merge'],
  ['a failing draft on our own branch is its author\'s', 'pull-143', {}, {}, 'skip'],
  ['a green draft on our own branch is its author\'s', 'pull-143', { contexts: { ci: { conclusion: 'SUCCESS' } } }, {}, 'skip'],
  ['another fork\'s dispatch/ branch gets no fix', 'pull-470',
    { headRepositoryOwner: { login: 'someone' }, contexts: changes }, {}, 'skip'],
  ['an approved and green placeholder gets a fix for its messages, not a merge', 'pull-511', {}, {}, 'fix', 1],
  ['a placeholder draft gets a fix, not ready', 'pull-511', { isDraft: true, contexts: { review: null } }, {}, 'fix', 1],
  ['a placeholder with a fix running waits', 'pull-511', {},
    { marker: { rounds: 1, sha: load('pull-511').headRefOid, run: 7 }, fixRun: { status: 'in_progress', updated_at: '2026-10-12T01:00:00Z' } }, 'wait'],
  ['a placeholder with the rounds used up goes to a human', 'pull-511', {}, { marker: { rounds: 2, sha: 'older' } }, 'needs-human'],
  ['a placeholder title over reworded commits goes to a human', 'pull-511', reworded, { marker: { rounds: 1, sha: 'older' } }, 'needs-human'],
  ['a placeholder title on a draft is not marked ready', 'pull-511', { ...reworded, isDraft: true }, {}, 'needs-human'],
  ['a title the author wrote over reworded commits merges', 'pull-511', { ...reworded, title: 'check: Say why' }, {}, 'merge'],
  ['a title that only mentions an agent run merges', 'pull-470', { title: 'docs: Explain what Agent run 12 printed' }, {}, 'merge'],
  ['a partial title is not merged', 'pull-470', partialTitle, {}, 'needs-human'],
  ['a partial description is not merged', 'pull-470', partialBody, {}, 'needs-human'],
  ['a partial draft is not marked ready', 'pull-470', { ...partialTitle, ...partialBody, isDraft: true, contexts: { review: null } }, {}, 'needs-human'],
  ['a partial pull request with failed ci gets its fix first', 'pull-470', { ...partialTitle, contexts: ciFailed }, {}, 'fix', 1],
  ['another fork\'s placeholder is left alone', 'pull-511', { headRepositoryOwner: { login: 'someone' } }, {}, 'skip'],
  ['our own branch marked partial is its author\'s', 'pull-143', { ...partialTitle, isDraft: false, contexts: { ci: { conclusion: 'SUCCESS' } } }, {}, 'skip'],
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

test('a blocked fix run is named in the reason the stop comment carries', () => {
  const p = pull('pull-470', { contexts: changes });
  const { action, reason } = decide({ pull: p, checks: classifyChecks(p, required),
    marker: { rounds: 1, sha: HEAD, run: 7 }, fixRun: failedRun, now: NOW });
  assert.equal(action, 'needs-human');
  assert.match(reason, /^fix round 1 is blocked: /);
  assert.ok(reason.includes(`https://github.com/${CONFIG.dispatchRepo}/actions/runs/7 ended (failure)`), reason);
});

test('the fix task for a placeholder asks for commit messages only', () => {
  const p = pull('pull-511');
  const task = fixTask({ repo: 'cgwalters-forge/agentic-job', pull: p, checks: classifyChecks(p, required), review: null, round: 1 });
  for (const want of [/placeholder \("Agent run" and a number\) is the subject of: 4b0f8188b7da\./, /a body that says why/,
    /Change no file for this alone/, /You cannot edit the pull request's title and description/]) assert.match(task, want);
  assert.ok(task.includes(`at most ${CONFIG.fixSeriesMaxCommits} commits`));
  for (const not of [/Fold the change/, /Failed checks/, /Rebase/]) assert.doesNotMatch(task, not);
  // Nothing of it in the task for a pull request with real messages.
  const q = pull('pull-470', { contexts: changes });
  assert.doesNotMatch(fixTask({ repo: 'cgwalters-forge/agentic-job', pull: q, checks: classifyChecks(q, required), review: null, round: 1 }), /placeholder/);
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

test('triage goes to the mistral pool, and no other kind is given one', () => {
  const pools = JSON.parse(fs.readFileSync(path.join(__dirname, '../agentic-job/pools.json'), 'utf8'));
  for (const [kind, pool] of [['triage', 'mistral'], ['fix', ''], ['implement', ''], ['review', ''], ['toString', ''], [undefined, '']]) {
    assert.equal(poolForKind(kind), pool, `kind ${kind}`);
  }
  assert.ok(poolForKind('triage') in pools);
});

test('a first fix round that is only toil goes to the toil pool', () => {
  const pools = JSON.parse(fs.readFileSync(path.join(__dirname, '../agentic-job/pools.json'), 'utf8'));
  assert.ok(CONFIG.toilFixPool in pools);
  const review = findings => `VERDICT: CHANGES\n\nReviewed head: ${HEAD}.\n\n${findings.join('\n')}\n\n> Generated by [review](https://example.invalid) for #470`;
  const toil = review([
    '- **[P2] The commit message does not say why.** Its body restates the diff.',
    '- **[P3] Formatting is off in the new module.** rustfmt would reflow it.',
    '- **The subject line is over 72 characters.**',
    '1. Pull request description is stale: it names a flag that is gone.',
  ]);
  const code = review([
    '- **[P2] The commit message does not say why.**',
    '- **[P1] `src/x.rs:9`: the bound is off by one.** Rewording the commit message will not fix it.',
  ]);
  const p = pull('pull-470', { contexts: changes });
  const checks = classifyChecks(p, required);
  const pool = (checks, review, round = 1, p = pull('pull-470', { contexts: changes })) => poolForFix({ pull: p, checks, review, round });
  assert.equal(pool(checks, toil), CONFIG.toilFixPool);
  // Only round 1: a toil fix the toil pool could not make goes to fixPools.
  assert.equal(pool(checks, toil, 2), poolForRound(2));
  // A finding about the code, even next to toil, keeps today's pools.
  assert.equal(pool(checks, code), poolForRound(1));
  // No list to judge, no comment, or one cut short: today's pools.
  assert.equal(pool(checks, 'VERDICT: CHANGES — the commit message and formatting need work.'), poolForRound(1));
  assert.equal(pool(checks, null), poolForRound(1));
  assert.equal(pool(checks, `${toil}\n[cut]`), poolForRound(1));
  // A review of an earlier head, its comment still the newest: today's pools.
  assert.equal(pool(checks, toil.replace(HEAD, 'e'.repeat(40))), poolForRound(1));
  // The recorded review, its findings swapped for toil: the footer is no finding.
  const recorded = reviewText(load('comments-470').filter(c => !c.body.startsWith('VERDICT: APPROVE')), BOT);
  const head = /Reviewed head: ([0-9a-f]{40})/.exec(recorded)[1];
  // Its Verification paragraph stays; its verdict line's reason is judged too.
  const swapped = recorded.replace(/\n- \*\*\[P2\][^\n]*/, '\n- **[P3] The commit message does not say why.**');
  const at = pull('pull-470', { contexts: changes, headRefOid: head });
  assert.equal(pool(checks, swapped, 1, at), poolForRound(1));
  const reworded = swapped.replace(/^VERDICT: CHANGES[^\n]*/, 'VERDICT: CHANGES — the commit message needs a why.');
  assert.match(reworded, /\nVerification: /);
  assert.equal(pool(checks, reworded, 1, at), CONFIG.toilFixPool);
  assert.equal(pool(checks, swapped.replace(/^VERDICT: CHANGES[^\n]*/, 'VERDICT: CHANGES'), 1, at), CONFIG.toilFixPool);
  assert.equal(pool(checks, recorded, 1, at), poolForRound(1));
  // Toil is a finding whose heading opens with a toil label, tagged or not.
  for (const finding of ['- [P2] The commit message does not say why.',
    '- The pull request description names a flag that is gone.',
    '- **Rebase onto main.**',
    '- **Merge conflict with main in the README.**',
    '- [P3] Trailing whitespace on the added lines.',
    '- nit: the commit message does not say why.',
    '- **[nit] The pull request description is stale.**']) {
    assert.equal(pool(checks, review([finding])), CONFIG.toilFixPool, finding);
  }
  // Anything else is not: a label further in, a code reference, a severe
  // tag, or a word that says the finding is about behaviour.
  for (const finding of ['- [P2] Removing the PR title check lets anyone merge without review.',
    '- **[P2] `poll.cjs:40` commit message parser drops trailers so the gate passes unsigned commits.**',
    '- **The commit message parser drops trailers so the gate passes unsigned commits.**',
    '- The loop is off by one.',
    '- **The loop in `a.c` is wrong.** Then rebase onto main.',
    '- **`src/date.rs:12`: the date format is parsed as UTC.**',
    '- **src/x.rs:4: not formatted.**',
    '- **[P1] The commit message claims a check the code does not make.**',
    '- **The commit message is fine.** [P0] The loop never ends.',
    '- **[blocker] The commit message claims a check the code does not make.**',
    '- blocker: the description is stale.',
    '- **important: Rebase onto main.**',
    '- **nit** The commit message does not say why.',
    '- **The description hides a security regression.**',
    '- **The description is stale.** It leaves out the race in the poll.',
    '- **Rebase onto main.** The credential is then read twice.',
    '- **Formatting of the output loses correctness.**',
    '- **`src/fmt.rs:3`: number formatting rounds wrong.**',
    '- **Whitespace in usernames is not trimmed before the auth check.**']) {
    assert.equal(pool(checks, review([finding])), poolForRound(1), finding);
  }
  // The verdict line's reason is judged as a finding is.
  assert.equal(pool(checks, toil.replace('VERDICT: CHANGES', 'VERDICT: CHANGES: the classifier sends security findings to the toil pool')), poolForRound(1));
  // Prose before the first finding may say anything, as prose after it may.
  assert.equal(pool(checks, review(['The poll now deletes every marker comment on each pass.', '', '- [P3] The commit message does not say why.'])), poolForRound(1));
  // The line naming the head may name the merge-base too, and nothing else.
  for (const [line, want] of [[`Reviewed head: \`${HEAD}\` (diff against merge-base \`672f539\` on main).`, CONFIG.toilFixPool],
    [`Reviewed admitted head ${HEAD} (merge-base 672f539, main).`, CONFIG.toilFixPool],
    [`Reviewed head: ${HEAD} (the loop in a.c never ends).`, poolForRound(1)]]) {
    assert.equal(pool(checks, toil.replace(`Reviewed head: ${HEAD}.`, line)), want, line);
  }
  // Nothing after the first finding but findings: a nested item or prose may say anything.
  assert.equal(pool(checks, review(['- **Rebase onto main.**', '  - the loop in `a.c` is wrong'])), poolForRound(1));
  assert.equal(pool(checks, review(['- **Rebase onto main.**', '', '`auth.rs:40` skips the token check.'])), poolForRound(1));
  assert.equal(pool(checks, review(['- **Rebase onto main.**', '', '- **[P3] Fix the indentation.**', ''])), CONFIG.toilFixPool);
  // The round after a toil round goes to fixPools' first, not past it.
  assert.equal(poolForFix({ pull: p, checks, review: code, round: 2, previous: CONFIG.toilFixPool }), CONFIG.fixPools[0]);
  assert.equal(poolForFix({ pull: p, checks, review: code, round: 2, previous: poolForRound(1) }), poolForRound(2));

  // A failed check is not toil, whatever the review says.
  const f = pull('pull-470', { contexts: { ...changes, ...ciFailed } });
  assert.equal(pool(classifyChecks(f, required), toil), poolForRound(1));
  // A conflict alone, or a placeholder subject alone, is.
  const c = pull('pull-470', conflict);
  assert.equal(decide({ pull: c, checks: classifyChecks(c, required), marker: { rounds: 0 }, now: NOW }).action, 'fix');
  assert.equal(pool(classifyChecks(c, required), null, 1, c), CONFIG.toilFixPool);
  // A conflict under a failed review is not, even one whose findings are toil.
  const cr = pull('pull-470', { ...conflict, contexts: changes });
  assert.equal(pool(classifyChecks(cr, required), toil, 1, cr), poolForRound(1));
  const u = pull('pull-511');
  assert.ok(toilOnly({ pull: u, checks: classifyChecks(u, required), review: null }));
});

test('pools.json has what dispatch.yml reads, and a well-formed allowance', () => {
  const pools = JSON.parse(fs.readFileSync(path.join(__dirname, '../agentic-job/pools.json'), 'utf8'));
  for (const [name, pool] of Object.entries(pools)) {
    for (const key of ['agent', 'model', 'budget']) assert.match(pool[key], /^\S+$/, `${name}.${key}`);
    assert.match(pool.budget, /^[1-9]\d*$/, `${name}.budget`);
    if (!('allowance' in pool)) continue;
    const { amount, currency, period, ...rest } = pool.allowance;
    assert.deepEqual(rest, {}, `${name}.allowance`);
    assert.ok(Number.isFinite(amount) && amount > 0, `${name}.allowance.amount`);
    assert.match(currency, /^[A-Z]{3}$/, `${name}.allowance.currency`);
    assert.ok(['calendar-month'].includes(period), `${name}.allowance.period`);
  }
  assert.equal(pools.mistral.budget, '1000');
  assert.deepEqual(pools.mistral.allowance, { amount: 300, currency: 'USD', period: 'calendar-month' });
});
