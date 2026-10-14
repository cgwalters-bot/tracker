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
// The followed repositories, and no cap on triage, unless a test says.
const caps = (wip, extra = {}) => ({ wip, triagePerPass: 10, followed: new Set(['o/r', 'o/p', 'up/stream']), ...extra });
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
  const schedule = { owner: 'o', project: 1, ready: ['Ready'], wip: 4, repositories: ['o/r'] };
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

test('the scheduled repositories are listed, priority comes from a named field, and triage is capped', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const schedule = { owner: 'o', project: 1, ready: ['Ready'], wip: 4, repositories: ['O/R'] };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, ...extra } }));
  const config = parse({});
  assert.deepEqual([...config.followed], ['o/r']);
  assert.equal(config.priorityField, 'Priority');
  assert.equal(config.triagePerPass, 1);
  assert.equal(parse({ priorityField: 'Urgency', triagePerPass: 0 }).priorityField, 'Urgency');
  // No list is no default: every repository would be scheduled otherwise.
  assert.throws(() => parse({ repositories: undefined }), /repositories/);
  for (const repositories of ['o/r', ['o/*'], ['o'], [1]]) assert.throws(() => parse({ repositories }), /repositories/);
  for (const triagePerPass of [-1, 11, '1', 0.5]) assert.throws(() => parse({ triagePerPass }), /triagePerPass/);
  for (const priorityField of ['', 'a"b', 3]) assert.throws(() => parse({ priorityField }), /priorityField/);
});

test("the repository's config schedules only its own forge's repositories", () => {
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.ok(config.followed.size > 0);
  // Each is one dispatch.yml may target.
  const bounds = fs.readFileSync(path.join(__dirname, '..', 'agentic-job', 'dispatch.toml'), 'utf8');
  const allowed = JSON.parse(/^repos = (\[.*\])$/m.exec(bounds.split(/^\[/m)[0])[1]).map(r => r.toLowerCase());
  for (const repo of config.followed) assert.ok(allowed.includes(repo), repo);
  assert.equal(config.triagePerPass, 1);
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
  assert.deepEqual((await decide([issue(1), issue(2)], empty, caps(4), probe, noPulls)).map(s => s.action), ['dispatch', 'triage']);
});

test('an item never gets a second run while one is in flight or a pull request is open', async () => {
  const probed = [];
  const pulls = new Map([['o/r#2', 'pr']]);
  const steps = await decide([issue(1), issue(2), issue(3, { content_kind: 'pull_request' })], {
    ...empty, inFlight: 1, busy: new Map([['o/r#1', 'run']]),
  }, caps(4), item => { probed.push(item.number); return plan('o/r#1'); }, key => pulls.get(key));
  assert.deepEqual(steps.map(s => s.action), ['skip', 'skip', 'skip']);
  assert.match(steps[0].reason, /in flight, run/);
  assert.match(steps[1].reason, /pull request is open, pr/);
  assert.deepEqual(probed, []);
});

test("a plan whose own target has a run or a pull request is not dispatched", async () => {
  const pulls = new Map([['up/stream#8', 'pr8']]);
  const probe = item => plan(item.number === 1 ? 'up/stream#7' : 'up/stream#8');
  const steps = await decide([issue(1), issue(2)], { ...empty, busy: new Map([['up/stream#7', 'run7']]) }, caps(4),
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
  const steps = await decide(items, empty, caps(4), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-11'],
    ['o/r#2', 'skip', "its plan's up/stream#7: a run is in flight, started in this pass"],
    ['up/stream#7', 'skip', 'a run is in flight, started in this pass'],
  ]);
  // The board item a step started for is held too.
  const again = await decide([issue(1), issue(1)], empty, caps(4), none, noPulls);
  assert.deepEqual(again.map(s => s.action), ['triage', 'skip']);
});

test('an item that cannot be read is skipped and the others go on', async () => {
  const probe = item => { if (item.number === 1) throw new Error('HTTP 502'); return { none: true }; };
  const steps = await decide([issue(1), issue(2)], empty, caps(4), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [['skip', 'could not be read: HTTP 502'], ['triage', 'no plan']]);
  const pullFor = key => { if (key === 'o/r#1') throw new Error('HTTP 404'); };
  assert.deepEqual((await decide([issue(1), issue(2)], empty, caps(4), none, pullFor)).map(s => s.action), ['skip', 'triage']);
});

test('names match whatever their case', async () => {
  assert.deepEqual([...readRuns([{ status: 'queued', display_title: 'implement O/R#1', html_url: 'run' }]).busy.keys()], ['o/r#1']);
  assert.deepEqual([...openPullRefs([{ user: { login: 'CGWalters-Bot' }, body: 'Refs O/R#5', html_url: 'pr' }], BOT).keys()], ['o/r#5']);
  const steps = await decide([{ ...issue(1), repository: 'O/R' }], { ...empty, busy: new Map([['o/r#1', 'run']]) }, caps(4), none, noPulls);
  assert.equal(steps[0].action, 'skip');
});

test('a plan recorded already, by this job or by hand, is not dispatched again', async () => {
  const steps = await decide([issue(1), issue(2)], empty, caps(1),
    item => (item.number === 1 ? plan('o/r#1', { recorded: 'rec' }) : plan('o/r#2')), noPulls);
  assert.deepEqual(steps.map(s => s.action), ['skip', 'dispatch']);
  assert.match(steps[0].reason, /dispatched already, rec$/);
});

test('the cap counts runs already going and those this pass starts', async () => {
  const items = [issue(1), issue(2), issue(3), issue(4)];
  const steps = await decide(items, { ...empty, inFlight: 2 }, caps(4), none, noPulls);
  assert.deepEqual(steps.map(s => s.action), ['triage', 'triage', 'skip', 'skip']);
  assert.match(steps[3].reason, /cap of 4/);
  // Over the cap already (fix runs are counted too): nothing starts, and no
  // comments are read.
  const probe = () => assert.fail('probed');
  assert.deepEqual((await decide(items, { ...empty, inFlight: 5 }, caps(4), probe, noPulls)).map(s => s.action),
    ['skip', 'skip', 'skip', 'skip']);
  assert.deepEqual((await decide(items, empty, caps(0), probe, noPulls)).map(s => s.action), ['skip', 'skip', 'skip', 'skip']);
});

test('only implement plans are dispatched by the scheduler', async () => {
  const steps = await decide([issue(1)], empty, caps(4), () => plan('o/r#1', { kind: 'triage' }), noPulls);
  assert.deepEqual(steps.map(s => s.action), ['skip']);
  assert.match(steps[0].reason, /is for triage, which is dispatched by hand/);
});

test('slots go to the higher priority first, then to the oldest', async () => {
  const items = [issue(1), issue(2, { priority: 'P2' }), issue(3, { priority: 'P0', created: '2026-10-02T00:00:00Z' }),
    issue(4, { priority: 'P0', created: '2026-10-01T00:00:00Z' }), issue(5, { priority: 'High' }),
    issue(6, { priority: 'P0' }), issue(7, { priority: 'P10' })];
  const steps = await decide(items, empty, caps(1), none, noPulls);
  // Unset or unknown values go last, as do unknown ages among one priority.
  assert.deepEqual(steps.map(s => [s.item, s.action]), [['o/r#4', 'triage'], ['o/r#3', 'skip'], ['o/r#6', 'skip'],
    ['o/r#2', 'skip'], ['o/r#7', 'skip'], ['o/r#1', 'skip'], ['o/r#5', 'skip']]);
});

test("an item outside the followed repositories, or a plan that leads out of them, is skipped", async () => {
  const items = [{ ...issue(1), repository: 'Upstream/Big' }, issue(2), issue(3)];
  const probe = item => (item.number === 2 ? plan('elsewhere/x#9') : { none: true });
  const steps = await decide(items, empty, caps(4), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['Upstream/Big#1', 'skip', 'not a followed repository'],
    ['o/r#2', 'skip', "its plan's elsewhere/x#9: not a followed repository"],
    ['o/r#3', 'triage', 'no plan'],
  ]);
});

test('triage runs are capped a pass, plans are not', async () => {
  const items = [issue(1), issue(2), issue(3), issue(4)];
  const probe = item => (item.number === 3 ? plan('o/r#3') : { none: true });
  const steps = await decide(items, empty, caps(4, { triagePerPass: 1 }), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'triage', 'no plan'],
    ['o/r#2', 'skip', 'triage cap of 1 a pass reached'],
    ['o/r#3', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'],
    ['o/r#4', 'skip', 'triage cap of 1 a pass reached'],
  ]);
  assert.deepEqual((await decide(items, empty, caps(4, { triagePerPass: 0 }), none, noPulls)).map(s => s.action),
    ['skip', 'skip', 'skip', 'skip']);
});

test('a pass reads a bounded number of items, the slots it leaves free notwithstanding', async () => {
  const items = Array.from({ length: 30 }, (_, i) => issue(i + 1));
  let probed = 0;
  const steps = await decide(items, empty, caps(4, { triagePerPass: 1 }), () => { probed++; return { none: true }; }, noPulls);
  assert.equal(probed, 11);
  assert.equal(steps.filter(s => s.reason === 'triage cap of 1 a pass reached').length, 10);
  assert.equal(steps.filter(s => s.reason === 'limit of 10 items read past the triage cap reached').length, 19);
  // Items stuck as triaged already, recorded or refused do not use the
  // limit up: a plan below them is still dispatched.
  const stuck = Array.from({ length: 12 }, (_, i) => issue(i + 1));
  const triaged = new Map(stuck.map(i => [`o/r#${i.number}`, 'run']));
  const below = await decide([...stuck, issue(40), issue(41)], { ...empty, triaged }, caps(4, { triagePerPass: 0 }),
    item => (item.number === 41 ? plan('o/r#41') : item.number % 3 ? { none: true } : { refused: 'no' }), noPulls);
  assert.deepEqual(below.slice(-2).map(s => s.action), ['skip', 'dispatch']);
  // An item triaged already and over the cap reads as triaged already.
  const again = await decide([issue(1), issue(2)], { ...empty, triaged: new Map([['o/r#2', 'run']]) }, caps(4, { triagePerPass: 1 }), none, noPulls);
  assert.deepEqual(again.map(s => s.reason), ['no plan', 'triaged already with no plan, run']);
});

// The board as the first preview read it (tracker run 38590120618): 165
// Todo items, upstream ones among them, one run in flight and no plans.
// That pass would have triaged three tracker items in board order and gone
// on to an upstream one. Todo is the backlog now, many of its items stale,
// and the repository's config starts none of them; the decisions are those
// of a config that still read Todo.
test('the first preview, again: one triage, of the oldest P0 item of a followed repository', async () => {
  const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'board-preview.json'), 'utf8'));
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.ok(!config.ready.includes('Todo'));
  assert.deepEqual(readItems(nodes, config.ready), []);
  const items = readItems(nodes, ['Todo']);
  assert.equal(items.length, 165);
  const steps = await decide(items, { ...empty, inFlight: 1 }, config, none, noPulls);
  assert.equal(steps.length, 165);
  const started = steps.filter(s => s.action !== 'skip');
  const followed = item => config.followed.has(item.repository.toLowerCase());
  const first = items.filter(i => followed(i) && i.content_kind === 'issue' && i.priority === 'P0')
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))[0];
  assert.deepEqual(started, [{ item: `${first.repository}#${first.number}`, action: 'triage', reason: 'no plan' }]);
  for (const name of ['bootc-dev/bootc#2559', 'composefs/composefs-rs#408', 'cgwalters-bot/cgwalters-bot#11']) {
    assert.equal(steps.find(s => s.item === name).reason, 'not a followed repository');
  }
  const outside = items.filter(i => !followed(i)).length;
  assert.ok(outside > 0);
  assert.equal(steps.filter(s => s.reason === 'not a followed repository').length, outside);
  // Ten more are read and wait for the triage cap; the rest are not read.
  assert.equal(steps.filter(s => s.reason === 'triage cap of 1 a pass reached').length, 10);
  assert.equal(steps.filter(s => s.reason === 'limit of 10 items read past the triage cap reached').length,
    items.filter(i => followed(i) && i.content_kind === 'issue').length - 11);
});

test('a refused plan or an earlier triage takes no slot', async () => {
  const steps = await decide([issue(1), issue(2), issue(3)], { ...empty, triaged: new Map([['o/r#2', 'run']]) }, caps(1),
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
  assert.match(task, /work is in another repository.*write no plan/);
});

test('the board read keeps open items with a ready Status', () => {
  const node = (number, status, extra = {}) => ({
    status: status && { name: status }, priority: { name: 'P1' },
    content: { __typename: 'Issue', number, url: `u${number}`, state: 'OPEN', createdAt: 't1', repository: { nameWithOwner: 'o/r' } },
    ...extra,
  });
  const items = readItems([
    node(1, 'Ready'),
    node(2, 'In Progress'),
    node(3, null),
    node(4, 'Ready', { content: { __typename: 'Issue', number: 4, url: 'u4', state: 'CLOSED', repository: { nameWithOwner: 'o/r' } } }),
    node(5, 'Next', { priority: null, content: { __typename: 'PullRequest', number: 5, url: 'u5', state: 'OPEN', repository: { nameWithOwner: 'o/p' } } }),
    { status: { name: 'Ready' }, content: null },
    // The backlog is not started from.
    node(6, 'Todo'),
  ], ['Ready', 'Next']);
  assert.deepEqual(items, [
    { repository: 'o/r', number: 1, content_kind: 'issue', url: 'u1', priority: 'P1', created: 't1' },
    { repository: 'o/p', number: 5, content_kind: 'pull_request', url: 'u5', priority: null, created: undefined },
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
  const steps = await decide([ITEM, issue(8)], empty, caps(4),
    item => item.number === 7 ? probePlan(HANGS, { ...CONFIG, timeoutMs: 1000 }, TOKEN, item) : none(), noPulls);
  assert.equal(steps[0].action, 'skip');
  assert.match(steps[0].reason, /^could not be read: agent-board dispatch \S+ --dry-run .*: timed out after 1 s; /);
  assert.deepEqual(steps[1], { item: 'o/r#8', action: 'triage', reason: 'no plan' });
});

const BOARD = { owner: 'o', project: 1, ready: ['Ready'], priorityField: 'Urgency' };
const page = (nodes, next, extra = {}) => ({
  data: { repositoryOwner: { projectV2: { items: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next ?? null } } } } },
  ...extra,
});
const ready = number => ({
  status: { name: 'Ready' },
  content: { __typename: 'Issue', number, url: `u${number}`, state: 'OPEN', repository: { nameWithOwner: 'o/r' } },
});

test('the board is read page by page, an unreadable item counted and left out', async () => {
  const asked = [];
  const pages = [page([ready(1)], 'c1'), page([ready(2), { status: { name: 'Ready' }, content: null }], null, { errors: [{ message: 'FORBIDDEN' }] })];
  const { items, unreadable, errors } = await readBoard(async body => { asked.push(body.variables); return pages.shift(); }, BOARD);
  assert.deepEqual(asked.map(v => v.cursor), [null, 'c1']);
  // The priority is read from the field the config names.
  assert.equal(asked[0].priority, 'Urgency');
  assert.deepEqual(items.map(i => i.number), [1, 2]);
  assert.equal(unreadable, 1);
  assert.deepEqual(errors, ['FORBIDDEN']);
});

test('a ready status the Status field has no option for is reported, not fatal', async () => {
  const withOptions = (names, next) => {
    const out = page(next ? [] : [ready(1)], next);
    out.data.repositoryOwner.projectV2.statusField = { options: names.map(name => ({ name })) };
    return out;
  };
  // The board before the operator adds the option: nothing found, one note.
  const before = await readBoard(async () => withOptions(['Todo', 'In Progress', 'Done']), { ...BOARD, ready: ['Ready', 'Next'] });
  assert.deepEqual(before.missing, ['Ready', 'Next']);
  const pages = [withOptions(['Todo', 'Ready'], 'c1'), withOptions(['Todo'])];
  const after = await readBoard(async () => pages.shift(), BOARD);
  // Read from the first page only.
  assert.deepEqual(after.missing, []);
  assert.deepEqual(after.items.map(i => i.number), [1]);
  // A field the token cannot read is unknown, not missing.
  assert.equal((await readBoard(async () => page([]), BOARD)).missing, null);
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
