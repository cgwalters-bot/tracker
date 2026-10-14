// node --test .github/poll/schedule.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { agentBoard, decide, readBoard, findRecord, loadConfig, openPullRefs, probePlan, readDryRun, readItems, readRefusal, readRuns, triageTask } = require('./schedule.cjs');

const BOT = 'cgwalters-bot';
const issue = (number, extra = {}) => ({ repository: 'o/r', number, content_kind: 'issue', url: `https://github.com/o/r/issues/${number}`, ...extra });
const none = () => ({ none: true });
const empty = { inFlight: 0, busy: new Map(), triaged: new Map() };
const noPulls = () => undefined;
const plan = (target, extra = {}) => ({ plan: `https://github.com/o/r/issues/1#issuecomment-${target.length}`, target, kind: 'implement', ...extra });

test('the repository config parses and names a board, statuses and a cap', () => {
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.ok(config.ready.length > 0);
  assert.ok(Number.isSafeInteger(config.wip));
  assert.equal(config.workflow, 'dispatch.yml');
  assert.match(config.planDocs, /^https:\/\/github.com\/.+\/docs\/job-plans.md$/);
});

test('a config without a schedule, or with a bad cap, is refused', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  assert.throws(() => loadConfig(JSON.stringify(base)), /schedule.owner/);
  const schedule = { owner: 'o', project: 1, ready: ['Todo'], wip: 4 };
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule })).wip, 4);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, wip: '4' } })), /wip/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, ready: [] } })), /ready/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, bot: undefined, schedule })), /operator, bot/);
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule })).timeoutMs, 120000);
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, timeoutSeconds: 30 } })).timeoutMs, 30000);
  for (const timeoutSeconds of [0, 601, '30', 1.5]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, timeoutSeconds } })), /timeoutSeconds/);
  }
});

test('runs in flight hold a slot each, and their item', () => {
  const s = readRuns([
    { status: 'in_progress', display_title: 'implement o/r#1 (claude)', html_url: 'run1' },
    { status: 'queued', display_title: 'fix o/r#9', html_url: 'run2' },
    { status: 'completed', display_title: 'triage o/r#3 (mistral)', html_url: 'run3' },
    { status: 'completed', display_title: 'implement o/r#4', html_url: 'run4' },
    { status: 'waiting', display_title: 'something else', html_url: 'run5' },
  ]);
  assert.equal(s.inFlight, 3);
  assert.deepEqual([...s.busy.keys()], ['o/r#1', 'o/r#9']);
  assert.deepEqual([...s.triaged], [['o/r#3', 'run3']]);
  // A title that only starts like an item is not one.
  assert.equal(readRuns([{ status: 'queued', display_title: 'implement o/r#12x' }]).busy.size, 0);
});

test("only the bot's pull requests hold an item, by their Refs line", () => {
  const refs = openPullRefs([
    { user: { login: BOT }, body: 'change\n\nRefs o/r#5', html_url: 'pr1' },
    { user: { login: 'visitor' }, body: 'Refs o/r#6', html_url: 'pr2' },
    { user: { login: BOT }, body: 'see Refs o/r#7 inline', html_url: 'pr3' },
    { user: { login: BOT }, body: null, html_url: 'pr4' },
  ], BOT);
  assert.deepEqual([...refs], [['o/r#5', 'pr1']]);
});

test('an item with a plan is dispatched, one without is triaged', async () => {
  const probe = item => (item.number === 1 ? plan('o/r#1') : { none: true });
  assert.deepEqual((await decide([issue(1), issue(2)], empty, 4, probe, noPulls)).map(s => s.action), ['dispatch', 'triage']);
});

test('an item never gets a second run while one is in flight or a pull request is open', async () => {
  const probed = [];
  const pulls = new Map([['o/r#2', 'pr']]);
  const steps = await decide([issue(1), issue(2), issue(3, { content_kind: 'pull_request' })], {
    ...empty, inFlight: 1, busy: new Map([['o/r#1', 'run']]),
  }, 4, item => { probed.push(item.number); return plan('o/r#1'); }, key => pulls.get(key));
  assert.deepEqual(steps.map(s => s.action), ['skip', 'skip', 'skip']);
  assert.match(steps[0].reason, /in flight, run/);
  assert.match(steps[1].reason, /pull request is open, pr/);
  assert.deepEqual(probed, []);
});

test("a plan whose own target has a run or a pull request is not dispatched", async () => {
  const pulls = new Map([['up/stream#8', 'pr8']]);
  const probe = item => plan(item.number === 1 ? 'up/stream#7' : 'up/stream#8');
  const steps = await decide([issue(1), issue(2)], { ...empty, busy: new Map([['up/stream#7', 'run7']]) }, 4,
    probe, key => pulls.get(key));
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [
    ['skip', "its plan's up/stream#7: a run is in flight, run7"],
    ['skip', "its plan's up/stream#8: a pull request is open, pr8"],
  ]);
});

test('one pass starts one run for a target, however many items lead to it', async () => {
  // Two pointer issues with plans for one upstream issue, which is on the
  // board itself with no plan.
  const items = [issue(1), issue(2), { ...issue(7), repository: 'up/stream' }];
  const probe = item => (item.repository === 'o/r' ? plan('up/stream#7') : { none: true });
  const steps = await decide(items, empty, 4, probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-11'],
    ['o/r#2', 'skip', "its plan's up/stream#7: a run is in flight, started in this pass"],
    ['up/stream#7', 'skip', 'a run is in flight, started in this pass'],
  ]);
  // The board item a step started for is held too.
  const again = await decide([issue(1), issue(1)], empty, 4, none, noPulls);
  assert.deepEqual(again.map(s => s.action), ['triage', 'skip']);
});

test('an item that cannot be read is skipped and the others go on', async () => {
  const probe = item => { if (item.number === 1) throw new Error('HTTP 502'); return { none: true }; };
  const steps = await decide([issue(1), issue(2)], empty, 4, probe, noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [['skip', 'could not be read: HTTP 502'], ['triage', 'no plan']]);
  const pullFor = key => { if (key === 'o/r#1') throw new Error('HTTP 404'); };
  assert.deepEqual((await decide([issue(1), issue(2)], empty, 4, none, pullFor)).map(s => s.action), ['skip', 'triage']);
});

test('names match whatever their case', async () => {
  assert.deepEqual([...readRuns([{ status: 'queued', display_title: 'implement O/R#1', html_url: 'run' }]).busy.keys()], ['o/r#1']);
  assert.deepEqual([...openPullRefs([{ user: { login: 'CGWalters-Bot' }, body: 'Refs O/R#5', html_url: 'pr' }], BOT).keys()], ['o/r#5']);
  const steps = await decide([{ ...issue(1), repository: 'O/R' }], { ...empty, busy: new Map([['o/r#1', 'run']]) }, 4, none, noPulls);
  assert.equal(steps[0].action, 'skip');
});

test('a plan recorded already, by this job or by hand, is not dispatched again', async () => {
  const steps = await decide([issue(1), issue(2)], empty, 1,
    item => (item.number === 1 ? plan('o/r#1', { recorded: 'rec' }) : plan('o/r#2')), noPulls);
  assert.deepEqual(steps.map(s => s.action), ['skip', 'dispatch']);
  assert.match(steps[0].reason, /dispatched already, rec$/);
});

test('the cap counts runs already going and those this pass starts', async () => {
  const items = [issue(1), issue(2), issue(3), issue(4)];
  const steps = await decide(items, { ...empty, inFlight: 2 }, 4, none, noPulls);
  assert.deepEqual(steps.map(s => s.action), ['triage', 'triage', 'skip', 'skip']);
  assert.match(steps[3].reason, /cap of 4/);
  // Over the cap already (fix runs are counted too): nothing starts, and no
  // comments are read.
  const probe = () => assert.fail('probed');
  assert.deepEqual((await decide(items, { ...empty, inFlight: 5 }, 4, probe, noPulls)).map(s => s.action),
    ['skip', 'skip', 'skip', 'skip']);
  assert.deepEqual((await decide(items, empty, 0, probe, noPulls)).map(s => s.action), ['skip', 'skip', 'skip', 'skip']);
});

test('only implement plans are dispatched by the scheduler', async () => {
  const steps = await decide([issue(1)], empty, 4, () => plan('o/r#1', { kind: 'triage' }), noPulls);
  assert.deepEqual(steps.map(s => s.action), ['skip']);
  assert.match(steps[0].reason, /is for triage, which is dispatched by hand/);
});

test('slots go to the higher priority first', async () => {
  const items = [issue(1), issue(2, { priority: 'P2' }), issue(3, { priority: 'P0' })];
  const steps = await decide(items, empty, 1, none, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action]), [['o/r#3', 'triage'], ['o/r#2', 'skip'], ['o/r#1', 'skip']]);
});

test('a refused plan or an earlier triage takes no slot', async () => {
  const steps = await decide([issue(1), issue(2), issue(3)], { ...empty, triaged: new Map([['o/r#2', 'run']]) }, 1,
    item => (item.number === 1 ? { refused: 'malformed' } : item.number === 2 ? { none: true } : plan('o/r#3')), noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [
    ['skip', 'plan refused: malformed'],
    ['skip', 'triaged already with no plan, run'],
    ['dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'],
  ]);
});

// What agent-board prints (crates/agent-board/src/dispatch.rs, from_plan).
test("agent-board's dry run and refusals are read", () => {
  const stdout = JSON.stringify({ method: 'POST', url: 'u', body: { ref: 'main', inputs: { task: 't', repo: 'Up/Stream', item: '7', kind: 'implement', pool: null } } });
  assert.deepEqual(readDryRun(`${stdout}\n`, 'Dry run: request for the plan in https://github.com/o/r/issues/1#issuecomment-42 by cgwalters; nothing was sent.\n'),
    { plan: 'https://github.com/o/r/issues/1#issuecomment-42', commentId: '42', target: 'up/stream#7', kind: 'implement' });
  assert.throws(() => readDryRun(stdout, ''), /named no plan comment/);
  assert.deepEqual(readRefusal('error: no plan on this issue from an accepted writer\n'), { none: true });
  assert.deepEqual(readRefusal('error: newest plan https://x was last edited by collaborator, who may not write plans\n'),
    { refused: 'error: newest plan https://x was last edited by collaborator, who may not write plans' });
  assert.deepEqual(readRefusal(''), { refused: 'unknown' });
});

test("only a writer's record of the same plan comment counts", () => {
  const record = (login, id, rest = '') => ({ user: { login }, body: `<!-- agent-board-dispatch: ${id}@2026-10-14T10:00:00Z -->${rest}\nDispatched`, html_url: `rec-${login}-${id}` });
  const writers = ['cgwalters', BOT];
  assert.equal(findRecord([record('visitor', 42), record('cgwalters', 41), record('cgwalters', 420)], writers, '42'), undefined);
  assert.equal(findRecord([record('CGWalters-Bot', 42)], writers, '42'), 'rec-CGWalters-Bot-42');
  // Only as the first line, as agent-board reads it.
  assert.equal(findRecord([{ user: { login: BOT }, body: 'quote\n<!-- agent-board-dispatch: 42@t -->' }], writers, '42'), undefined);
  assert.equal(findRecord([record(BOT, 42, ' extra')], writers, '42'), undefined);
});

test('a plan edited after its record is a new plan', () => {
  const writers = ['cgwalters', BOT];
  const planAt = updated => ({ id: 42, user: { login: 'cgwalters' }, body: 'plan', updated_at: updated });
  const rec = { user: { login: BOT }, body: '<!-- agent-board-dispatch: 42@2026-10-14T10:00:00Z -->', html_url: 'rec', created_at: '2026-10-14T10:00:05Z' };
  assert.equal(findRecord([planAt('2026-10-14T10:00:00Z'), rec], writers, '42'), 'rec');
  assert.equal(findRecord([planAt('2026-10-14T11:00:00Z'), rec], writers, '42'), undefined);
});

test('the triage task asks for one implement plan in the job-plan format', () => {
  const task = triageTask('o/r#1', 'https://github.com/o/r/issues/1', 'https://github.com/o/agent-board/blob/main/docs/job-plans.md');
  assert.match(task, /o\/agent-board\/blob\/main\/docs\/job-plans.md/);
  assert.match(task, /agent-board-plan/);
  assert.match(task, /agent-board\/job-plan\/v1/);
  assert.match(task, /"implement"/);
});

test('the board read keeps open items with a ready Status', () => {
  const node = (number, status, extra = {}) => ({
    status: status && { name: status }, priority: { name: 'P1' },
    content: { __typename: 'Issue', number, url: `u${number}`, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
    ...extra,
  });
  const items = readItems([
    node(1, 'Todo'),
    node(2, 'In Progress'),
    node(3, null),
    node(4, 'Todo', { content: { __typename: 'Issue', number: 4, url: 'u4', state: 'CLOSED', repository: { nameWithOwner: 'o/r' } } }),
    node(5, 'Ready', { priority: null, content: { __typename: 'PullRequest', number: 5, url: 'u5', state: 'OPEN', repository: { nameWithOwner: 'o/p' } } }),
    { status: { name: 'Todo' }, content: null },
  ], ['Todo', 'Ready']);
  assert.deepEqual(items, [
    { repository: 'o/r', number: 1, content_kind: 'issue', url: 'u1', priority: 'P1' },
    { repository: 'o/p', number: 5, content_kind: 'pull_request', url: 'u5', priority: null },
  ]);
});

// Stub agent-board binaries, made where each test runs, not in the tree.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-stub-'));
after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
const stub = (name, body) => {
  const file = path.join(stubDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
};
const HANGS = stub('hangs', "process.stderr.write('reading the plan\\n'); setInterval(() => {}, 1000);");
const FAILS = stub('fails', "process.stderr.write(`warning: slow\\nerror: bad credentials for ${process.env.GH_TOKEN}\\n`); process.exit(3);");
// Waits for stdin to end, as a prompt would wait for an answer.
const READS_STDIN = stub('reads-stdin', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('done\\n'));");
const GARBLED = stub('garbled', "process.stdout.write('not json'); process.stderr.write('dry run\\n');");
const TOKEN = 'ghp_secretsecretsecret';
const CONFIG = { caller: 'o/t', workflow: 'dispatch.yml', operator: 'op', planner: BOT, timeoutMs: 10000 };
const ITEM = issue(7);

test('a hung agent-board is stopped, and the error names the command', () => {
  const started = Date.now();
  // What it wrote before it hung is kept, if it got that far before the kill.
  assert.throws(() => agentBoard(HANGS, ['dispatch', ITEM.url, '--dry-run'], { env: { GH_TOKEN: TOKEN }, timeoutMs: 1000 }),
    /^Error: agent-board dispatch https:\/\/github.com\/o\/r\/issues\/7 --dry-run: timed out after 1 s; (stderr: reading the plan|no stderr)$/);
  assert.ok(Date.now() - started < 10000);
});

test('a failing agent-board throws its command, exit status and stderr on one line, with the token masked', () => {
  assert.throws(() => agentBoard(FAILS, ['dispatch', ITEM.url, '--apply'], { env: { GH_TOKEN: TOKEN }, timeoutMs: 10000 }),
    err => {
      assert.equal(err.message, `agent-board dispatch ${ITEM.url} --apply: exited 3; stderr: warning: slow | error: bad credentials for ***`);
      assert.doesNotMatch(err.stderr, new RegExp(TOKEN));
      return true;
    });
  // A binary that is not there is named too.
  assert.throws(() => agentBoard(path.join(stubDir, 'missing'), ['item', 'list'], { timeoutMs: 10000 }),
    /^Error: agent-board item list: spawnSync .*ENOENT; no stderr$/);
});

test('agent-board gets no stdin to wait on', () => {
  assert.equal(agentBoard(READS_STDIN, [], { timeoutMs: 10000 }).stdout, 'done\n');
});

test("a dry run's refusal is an answer; a hang or output not understood skips the item with the command", async () => {
  // FAILS exits non-zero: agent-board's refusal, the last line of stderr.
  assert.deepEqual(await probePlan(FAILS, CONFIG, TOKEN, ITEM), { refused: 'error: bad credentials for ***' });
  await assert.rejects(probePlan(GARBLED, CONFIG, TOKEN, ITEM),
    /^Error: agent-board dispatch \S+ --dry-run --caller o\/t .*: output not understood: .*; stderr: dry run$/);
  const steps = await decide([ITEM, issue(8)], empty, 4,
    item => item.number === 7 ? probePlan(HANGS, { ...CONFIG, timeoutMs: 1000 }, TOKEN, item) : none(), noPulls);
  assert.equal(steps[0].action, 'skip');
  assert.match(steps[0].reason, /^could not be read: agent-board dispatch \S+ --dry-run .*: timed out after 1 s; /);
  assert.deepEqual(steps[1], { item: 'o/r#8', action: 'triage', reason: 'no plan' });
});

const BOARD = { owner: 'o', project: 1, ready: ['Todo'] };
const page = (nodes, next, extra = {}) => ({
  data: { repositoryOwner: { projectV2: { items: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next ?? null } } } } },
  ...extra,
});
const todo = number => ({
  status: { name: 'Todo' },
  content: { __typename: 'Issue', number, url: `u${number}`, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
});

test('the board is read page by page, an unreadable item counted and left out', async () => {
  const asked = [];
  const pages = [page([todo(1)], 'c1'), page([todo(2), { status: { name: 'Todo' }, content: null }], null, { errors: [{ message: 'FORBIDDEN' }] })];
  const { items, unreadable, errors } = await readBoard(async body => { asked.push(body.variables.cursor); return pages.shift(); }, BOARD);
  assert.deepEqual(asked, [null, 'c1']);
  assert.deepEqual(items.map(i => i.number), [1, 2]);
  assert.equal(unreadable, 1);
  assert.deepEqual(errors, ['FORBIDDEN']);
});

test('a board that cannot be found, or never ends, stops the pass', async () => {
  await assert.rejects(readBoard(async () => ({ data: { repositoryOwner: null }, errors: [{ message: 'no such owner' }] }), BOARD),
    /board o\/1 not found.*: no such owner/);
  // A page that failed partway, its connection null beside the error.
  await assert.rejects(readBoard(async () => ({ data: { repositoryOwner: { projectV2: { items: null } } }, errors: [{ message: 'timeout' }] }), BOARD),
    /not readable with GH_TOKEN: timeout/);
  let calls = 0;
  await assert.rejects(readBoard(async () => { calls++; return page([], `c${calls}`); }, BOARD), /more than 5000 items/);
  assert.equal(calls, 50);
});
