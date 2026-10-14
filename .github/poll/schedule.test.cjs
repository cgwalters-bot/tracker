// node --test .github/poll/schedule.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { decide, findRecord, loadConfig, openPullRefs, readDryRun, readRefusal, readRuns, triageTask } = require('./schedule.cjs');

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
