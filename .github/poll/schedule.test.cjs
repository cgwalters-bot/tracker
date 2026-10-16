// node --test .github/poll/schedule.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { FILL_QUERY, agentBoard, batchReleased, candidates, decide, eligibility, fillItems, findRecord, idleLine, loadConfig, main, openPullRefs, paceMode, planInterval, probePlan, pullIssues, readDryRun, readOutcome, readRefusal, readRuns, readTriage, triageRecord, triageTask } = require('./schedule.cjs');
const { census } = require('./epics.cjs');
const { render } = require('../usage/usage.cjs');

const BOT = 'cgwalters-bot';
const issue = (number, extra = {}) => ({ repository: 'o/r', number, content_kind: 'issue', url: `https://github.com/o/r/issues/${number}`, ...extra });
const none = () => ({ none: true });
const empty = { inFlight: 0, busy: new Map() };
const noPulls = () => undefined;
// The followed repositories, unless a test says.
const caps = (wip, extra = {}) => ({ wip, followed: new Set(['o/r', 'o/p', 'up/stream']), ...extra });
const plan = (target, extra = {}) => ({ plan: `https://github.com/o/r/issues/1#issuecomment-${target.length}`, target, kind: 'implement', ...extra });
// Each item's own plan, for its own issue.
const own = item => plan(`${item.repository}#${item.number}`.toLowerCase());
// What the eligibility query answers of an issue fit to be worked on.
const metadata = (extra = {}) => ({ state: 'OPEN', labels: { nodes: [], pageInfo: { hasNextPage: false } },
  projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
  subIssues: { totalCount: 0 }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  timelineItems: { nodes: [], pageInfo: { hasNextPage: false } }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } }, ...extra });
const post = data => async () => ({ data: { repository: { issue: data } } });

test('the repository config parses and names a board and a cap', () => {
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  // Candidates come from the epics, not from a board Status.
  assert.ok(!('ready' in config));
  assert.ok(Number.isSafeInteger(config.wip));
  assert.equal(config.workflow, 'dispatch.yml');
  assert.match(config.planDocs, /^https:\/\/github.com\/.+\/docs\/job-plans.md$/);
});

test('a config without a schedule, or with a bad cap, is refused', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  assert.throws(() => loadConfig(JSON.stringify(base)), /schedule.owner/);
  const schedule = { owner: 'o', project: 1, wip: 4, repositories: ['o/r'] };
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule })).wip, 4);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, wip: '4' } })), /wip/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base, bot: undefined, schedule })), /operator, bot/);
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule })).timeoutMs, 120000);
  assert.equal(loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, timeoutSeconds: 30 } })).timeoutMs, 30000);
  for (const timeoutSeconds of [0, 601, '30', 1.5]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, timeoutSeconds } })), /timeoutSeconds/);
  }
});

test('the scheduled repositories are listed, and priority comes from a named field', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const schedule = { owner: 'o', project: 1, wip: 4, repositories: ['O/R'] };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { ...schedule, ...extra } }));
  const config = parse({});
  assert.deepEqual([...config.followed], ['o/r']);
  assert.equal(config.priorityField, 'Priority');
  assert.equal(parse({ priorityField: 'Urgency' }).priorityField, 'Urgency');
  // No list is no default: every repository would be scheduled otherwise.
  assert.throws(() => parse({ repositories: undefined }), /repositories/);
  for (const repositories of ['o/r', ['o/*'], ['o'], [1]]) assert.throws(() => parse({ repositories }), /repositories/);
  for (const priorityField of ['', 'a"b', 3]) assert.throws(() => parse({ priorityField }), /priorityField/);
});

test("the repository's config schedules only its own forge's repositories", () => {
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.ok(config.followed.size > 0);
  // Each is one dispatch.yml may target.
  const bounds = fs.readFileSync(path.join(__dirname, '..', 'agentic-job', 'dispatch.toml'), 'utf8');
  const allowed = JSON.parse(/^repos = (\[.*\])$/m.exec(bounds.split(/^\[/m)[0])[1]).map(r => r.toLowerCase());
  for (const repo of config.followed) assert.ok(allowed.includes(repo), repo);
});

test('the repository config names its status issue, which is never scheduled', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  const config = loadConfig(JSON.stringify(raw));
  assert.equal(config.statusRepository, raw.epics.repository);
  assert.equal(config.statusIssue, raw.coordinator.statusIssue);
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

test('an item with a plan is dispatched, one without is skipped', async () => {
  const probe = item => (item.number === 1 ? plan('o/r#1') : { none: true });
  assert.deepEqual((await decide([issue(1), issue(2)], empty, caps(4), probe, noPulls)).map(s => [s.action, s.reason]),
    [['dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'], ['skip', 'no plan']]);
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
  const again = await decide([issue(1), issue(1)], empty, caps(4), own, noPulls);
  assert.deepEqual(again.map(s => s.action), ['dispatch', 'skip']);
});

test('an item that cannot be read is skipped and the others go on', async () => {
  const probe = item => { if (item.number === 1) throw new Error('HTTP 502'); return { none: true }; };
  const steps = await decide([issue(1), issue(2)], empty, caps(4), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [['skip', 'could not be read: HTTP 502'], ['skip', 'no plan']]);
  const pullFor = key => { if (key === 'o/r#1') throw new Error('HTTP 404'); };
  assert.deepEqual((await decide([issue(1), issue(2)], empty, caps(4), own, pullFor)).map(s => s.action), ['skip', 'dispatch']);
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
  const steps = await decide(items, { ...empty, inFlight: 2 }, caps(4), own, noPulls);
  assert.deepEqual(steps.map(s => s.action), ['dispatch', 'dispatch', 'skip', 'skip']);
  assert.match(steps[3].reason, /cap of 4/);
  // Over the cap already (fix runs are counted too): nothing starts, and no
  // comments are read.
  const probe = () => assert.fail('probed');
  assert.deepEqual((await decide(items, { ...empty, inFlight: 5 }, caps(4), probe, noPulls)).map(s => s.action),
    ['skip', 'skip', 'skip', 'skip']);
  assert.deepEqual((await decide(items, empty, caps(0), probe, noPulls)).map(s => s.action), ['skip', 'skip', 'skip', 'skip']);
});

// The bot posts every run's comments and is an accepted planner, so a plan
// of any other kind, which a run could write, would let runs start runs.
for (const kind of ['triage', 'research', 'review', 'fix']) {
  test(`a ${kind} plan is left to be dispatched by hand, and takes no slot`, async () => {
    const steps = await decide([issue(1), issue(2)], empty, caps(1),
      item => plan(`o/r#${item.number}`, { kind: item.number === 1 ? kind : 'implement' }), noPulls);
    assert.deepEqual(steps.map(s => s.action), ['skip', 'dispatch']);
    assert.match(steps[0].reason, new RegExp(`is for ${kind}, which is dispatched by hand`));
  });
}

test('slots go to the higher priority first, then to the oldest', async () => {
  const items = [issue(1), issue(2, { priority: 'P2' }), issue(3, { priority: 'P0', created: '2026-10-02T00:00:00Z' }),
    issue(4, { priority: 'P0', created: '2026-10-01T00:00:00Z' }), issue(5, { priority: 'High' }),
    issue(6, { priority: 'P0' }), issue(7, { priority: 'P10' })];
  const steps = await decide(items, empty, caps(1), own, noPulls);
  // Unset or unknown values go last, as do unknown ages among one priority.
  assert.deepEqual(steps.map(s => [s.item, s.action]), [['o/r#4', 'dispatch'], ['o/r#3', 'skip'], ['o/r#6', 'skip'],
    ['o/r#2', 'skip'], ['o/r#7', 'skip'], ['o/r#1', 'skip'], ['o/r#5', 'skip']]);
});

test("an item outside the followed repositories, or a plan that leads out of them, is skipped", async () => {
  const items = [{ ...issue(1), repository: 'Upstream/Big' }, issue(2), issue(3)];
  const probe = item => (item.number === 2 ? plan('elsewhere/x#9') : { none: true });
  const steps = await decide(items, empty, caps(4), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['Upstream/Big#1', 'skip', 'not a followed repository'],
    ['o/r#2', 'skip', "its plan's elsewhere/x#9: not a followed repository"],
    ['o/r#3', 'skip', 'no plan'],
  ]);
});

// The board as the first preview read it (tracker run 38590120618): 165
// Todo items, upstream ones among them, one run in flight and no plans.
// That pass would have triaged three tracker items in board order and gone
// on to an upstream one. Its 157 issues are taken here as the sub-issues of
// one live epic, as if the operator had put the backlog under one, each
// with a plan for itself.
test('the first preview, again: the slots go to the oldest P0 items of followed repositories', async () => {
  const nodes = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'board-preview.json'), 'utf8'));
  const config = loadConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  const subs = nodes.filter(n => n.content.__typename === 'Issue').map(({ content: c, priority }) => ({
    repository: c.repository.nameWithOwner, number: c.number, state: c.state.toLowerCase(), url: c.url, created: c.createdAt, priority: priority?.name ?? null,
  }));
  const { items } = candidates([{ number: 1, live: true, priority: 'P0', subs }], 'o/t');
  assert.equal(items.length, 157);
  const steps = await decide(items, { ...empty, inFlight: 1 }, config, own, noPulls);
  assert.equal(steps.length, 157);
  const started = steps.filter(s => s.action !== 'skip');
  const followed = item => config.followed.has(item.repository.toLowerCase());
  const first = items.filter(i => followed(i) && i.priority === 'P0')
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))[0];
  assert.equal(started.length, config.wip - 1);
  assert.deepEqual(started[0], { item: `${first.repository}#${first.number}`, action: 'dispatch', reason: `plan ${own(first).plan}` });
  for (const name of ['bootc-dev/bootc#2559', 'cgwalters-bot/cgwalters-bot#11']) {
    assert.equal(steps.find(s => s.item === name).reason, 'not a followed repository');
  }
  const outside = items.filter(i => !followed(i)).length;
  assert.ok(outside > 0);
  assert.equal(steps.filter(s => s.reason === 'not a followed repository').length, outside);
  // Once the slots are taken, the rest are not read.
  assert.equal(steps.filter(s => /^work-in-progress cap/.test(s.reason)).length,
    items.filter(followed).length - started.length);
});

test('items without a plan, however many, do not keep a later plan from its slot', async () => {
  const items = Array.from({ length: 30 }, (_, i) => issue(i + 1));
  let probed = 0;
  const steps = await decide(items, empty, caps(4), item => { probed++; return item.number === 30 ? plan('o/r#30') : { none: true }; }, noPulls);
  assert.equal(probed, 30);
  assert.ok(steps.slice(0, 29).every(s => s.action === 'skip' && s.reason === 'no plan'));
  assert.equal(steps[29].action, 'dispatch');
});

test('each step is acted on as it is decided, before the next item is read', async () => {
  const events = [];
  await decide([issue(1), issue(2), issue(3)], empty, caps(4), item => {
    events.push(`probe ${item.number}`);
    return item.number === 2 ? { none: true } : own(item);
  }, noPulls, async () => null, async step => { events.push(`${step.action} ${step.item}`); });
  assert.deepEqual(events, ['probe 1', 'dispatch o/r#1', 'probe 2', 'skip o/r#2', 'probe 3', 'dispatch o/r#3']);
});

test('a refused plan or no plan takes no slot', async () => {
  const steps = await decide([issue(1), issue(2), issue(3)], empty, caps(1),
    item => (item.number === 1 ? { refused: 'malformed' } : item.number === 2 ? { none: true } : plan('o/r#3')), noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [
    ['skip', 'plan refused: malformed'],
    ['skip', 'no plan'],
    ['dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'],
  ]);
});

// What agent-board prints (crates/agent-board/src/dispatch.rs, from_plan).
test("agent-board's dry run and refusals are read", () => {
  const stdout = JSON.stringify({ method: 'POST', url: 'u', body: { ref: 'main', inputs: { task: 't', repo: 'Up/Stream', item: '7', kind: 'implement', pool: null } } });
  assert.deepEqual(readDryRun(`${stdout}\n`, 'Dry run: request for the plan in https://github.com/o/r/issues/1#issuecomment-42 by cgwalters; nothing was sent.\n'),
    { plan: 'https://github.com/o/r/issues/1#issuecomment-42', commentId: '42', target: 'up/stream#7', kind: 'implement', extras: [] });
  assert.throws(() => readDryRun(stdout, ''), /named no plan comment/);
  assert.deepEqual(readRefusal('error: no plan on this issue from an accepted writer\n'), { none: true });
  assert.deepEqual(readRefusal('error: newest plan https://x was last edited by collaborator, who may not write plans\n'),
    { refused: 'error: newest plan https://x was last edited by collaborator, who may not write plans' });
  assert.deepEqual(readRefusal(''), { refused: 'unknown' });
});

test("only a writer's record of the same plan comment counts", async () => {
  const record = (login, id, rest = '') => ({ user: { login }, body: `<!-- agent-board-dispatch: ${id}@2026-10-14T10:00:00Z -->${rest}\nDispatched`, html_url: `rec-${login}-${id}` });
  const writers = ['cgwalters', BOT];
  assert.equal(await findRecord([record('visitor', 42), record('cgwalters', 41), record('cgwalters', 420)], writers, '42'), undefined);
  assert.equal(await findRecord([record('CGWalters-Bot', 42)], writers, '42'), 'rec-CGWalters-Bot-42');
  // Only as the first line, as agent-board reads it.
  assert.equal(await findRecord([{ user: { login: BOT }, body: 'quote\n<!-- agent-board-dispatch: 42@t -->' }], writers, '42'), undefined);
  assert.equal(await findRecord([record(BOT, 42, ' extra')], writers, '42'), undefined);
});

test('a plan edited after its record is a new plan', async () => {
  const writers = ['cgwalters', BOT];
  const planAt = updated => ({ id: 42, user: { login: 'cgwalters' }, body: 'plan', updated_at: updated });
  const rec = { user: { login: BOT }, body: '<!-- agent-board-dispatch: 42@2026-10-14T10:00:00Z -->', html_url: 'rec', created_at: '2026-10-14T10:00:05Z' };
  assert.equal(await findRecord([planAt('2026-10-14T10:00:00Z'), rec], writers, '42'), 'rec');
  assert.equal(await findRecord([planAt('2026-10-14T11:00:00Z'), rec], writers, '42'), undefined);
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
      assert.equal(err.status, 3);
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
  assert.deepEqual(steps[1], { item: 'o/r#8', action: 'skip', reason: 'no plan' });
});

// A census over the API as testdata/epics-schedule.json answers it: #1 and
// #3 labelled by the operator, the board ranking #3 first; #2 by the bot.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'epics-schedule.json'), 'utf8'));
const fixtureCensus = rest => census(
  async p => {
    const key = p.replace(/[?&]per_page=100&page=1$/, '');
    if (!(key in rest)) throw new Error(`GET ${key}: HTTP 404`);
    return rest[key];
  },
  async ({ query }) => (query.includes('projectV2')
    ? { data: { repositoryOwner: { projectV2: { items: { nodes: fixture.board, pageInfo: { hasNextPage: false } } } } } }
    : { data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
  { epicsRepository: fixture.repository, operator: 'op', owner: 'o', project: 1, priorityField: 'Priority', followed: new Set(fixture.followed) });

test("the candidates are the open sub-issues of the operator's epics, by epic priority, then their own, then age", async () => {
  const { entries } = await fixtureCensus(fixture.rest);
  const { items, live, unread } = candidates(entries, fixture.repository);
  assert.deepEqual([live, unread], [2, 0]);
  // The bot's epic gives nothing, its P0 sub-issue o/r#20 included; nor does
  // the closed o/r#11. o/r#12, in both live epics, is taken once, from #3.
  const steps = await decide(items, empty, caps(10, { followed: new Set(fixture.followed) }), none, noPulls);
  const epicOf = new Map(items.map(i => [`${i.repository}#${i.number}`, i.epic]));
  assert.deepEqual(steps.map(s => [s.item, epicOf.get(s.item), s.action, s.reason]), [
    // #3 is P0: its P2 items oldest first, then the one with no Priority.
    ['o/r#12', 'o/t#3', 'skip', 'no plan'],
    ['o/r#30', 'o/t#3', 'skip', 'no plan'],
    ['o/r#31', 'o/t#3', 'skip', 'no plan'],
    // #1 is P1: its P0 sub-issue comes after all of #3's.
    ['o/r#10', 'o/t#1', 'skip', 'no plan'],
    ['up/stream#5', 'o/t#1', 'skip', 'not a followed repository'],
  ]);
});

test('an epic that cannot be read gives no candidates, and is counted', async () => {
  const rest = { ...fixture.rest };
  delete rest['/repos/o/t/issues/3/sub_issues'];
  const { items, live, unread } = candidates((await fixtureCensus(rest)).entries, fixture.repository);
  assert.deepEqual([live, unread], [1, 1]);
  assert.deepEqual(items.map(i => i.number).sort(), [10, 12, 5]);
});

// main over a stubbed API: `rest` answers GETs by path, without the first
// page's paging; GraphQL gets `board` (null: not readable) and no comments. Returns the lines it
// logged, the requests it made and what it threw.
const REPO_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
const EPICS = REPO_CONFIG.epics.repository;
const epicIssue = n => ({ number: n, state: 'open', updated_at: 't', html_url: `https://github.com/${EPICS}/issues/${n}`, repository_url: `https://api.github.com/repos/${EPICS}` });
const labelled = login => [{ event: 'labeled', actor: { login }, label: { name: 'epic' } }];
// `schedule` is merged into the repository's own schedule config.
// `outage` is the open outage issues an applying pass reads first.
const OUTAGE = '/repos/configured/tracker/issues?state=open&labels=outage&per_page=100';
// `graphql(query, variables)` answers a GraphQL request first, if it returns one.
async function runMain(args, rest, { board = [], bin = path.join(stubDir, 'missing'), issues = {}, schedule, outage = [], graphql = () => undefined } = {}) {
  const calls = [];
  const sent = [];
  const out = [];
  const saved = { fetch: globalThis.fetch, log: console.log, GH_TOKEN: process.env.GH_TOKEN, AGENT_BOARD: process.env.AGENT_BOARD, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, read: fs.readFileSync };
  if (schedule) {
    const text = JSON.stringify({ ...REPO_CONFIG, schedule: { ...REPO_CONFIG.schedule, ...schedule } });
    fs.readFileSync = (file, ...rest) => (String(file).endsWith('agent-board.json') ? text : saved.read(file, ...rest));
  }
  globalThis.fetch = async (u, init) => {
    if (u === `https://api.github.com${OUTAGE}`) {
      calls.push(`GET ${OUTAGE}`);
      return new Response(JSON.stringify(outage), { status: 200 });
    }
    const p = u.replace('https://api.github.com', '').replace(/[?&]per_page=100&page=1$/, '');
    const call = `${init?.method ?? 'GET'} ${p}`;
    calls.push(call);
    if (init?.body && p !== '/graphql') sent.push([call, JSON.parse(init.body)]);
    let body;
    if (p === '/graphql') {
      const { query, variables } = JSON.parse(init.body);
      body = graphql(query, variables) ?? (query.includes('projectV2')
        ? board === null ? { errors: [{ message: 'Could not resolve to a ProjectV2' }] } : { data: { repositoryOwner: { projectV2: { items: { nodes: board, pageInfo: { hasNextPage: false } } } } } }
        : query.includes('closedByPullRequestsReferences')
          ? { data: { repository: { issue: issues[variables.number] ?? metadata() } } }
          : { data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    } else if (call in rest) {
      body = rest[call];
    } else if (p in rest) {
      body = rest[p];
    } else {
      return new Response('nope', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  console.log = line => out.push(line);
  process.env.GH_TOKEN = 'test-token';
  process.env.AGENT_BOARD = bin;
  process.env.GITHUB_REPOSITORY = 'configured/tracker';
  let error;
  try {
    await main(args);
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    fs.readFileSync = saved.read;
    for (const k of ['GH_TOKEN', 'AGENT_BOARD', 'GITHUB_REPOSITORY']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return { out, calls, sent, error };
}
const LIST = `/repos/${EPICS}/issues?state=open&labels=epic`;

test('with no live epics a pass says so and starts nothing', async () => {
  // Only the bot's epic, as on the board until the operator labels one.
  const { out, calls, error } = await runMain(['--apply'], {
    [LIST]: [epicIssue(2)],
    [`/repos/${EPICS}/issues/2/timeline`]: labelled(REPO_CONFIG.bot),
  });
  assert.equal(error, undefined);
  assert.deepEqual(out, ['no live epics; nothing started']);
  // Nothing past the census is read, and nothing is written.
  assert.deepEqual(calls, [`GET ${OUTAGE}`, `GET ${LIST}`, `GET /repos/${EPICS}/issues/2/timeline`]);
});

test('each line of a pass names the epic its item came from', async () => {
  const NO_PLAN_BIN = stub('no-plan', "process.stderr.write('error: no plan on this issue from an accepted writer\\n'); process.exit(1);");
  const sub = { ...epicIssue(40), created_at: '2026-10-01T00:00:00Z' };
  const { out, error } = await runMain([], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [sub],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
    [`/repos/${EPICS}/issues/40/comments`]: [],
  }, { bin: NO_PLAN_BIN, board: [{ status: { name: 'Todo' }, priority: { name: 'P1' }, content: { url: sub.html_url } }] });
  assert.equal(error, undefined);
  assert.equal(out.length, 3);
  assert.match(out[0], /^\[dry-run\] 1 open sub-issue\(s\) of 1 live epic\(s\), taken by their epic's Priority/);
  assert.equal(out[1], `[dry-run] ${EPICS}#40 (epic ${EPICS}#1) design: no plan; too little in its body to plan, recording needs design`);
  // Nothing started with slots free: the pass says so, and why.
  assert.equal(out[2], `[dry-run] idle: ${REPO_CONFIG.schedule.wip} slot(s) free and nothing started`);
});

test('with --apply, a probably done item gets a triage run, and a stub with no plan a needs-design record', async () => {
  const NO_PLAN_BIN = stub('no-plan-apply', "process.stderr.write('error: no plan on this issue from an accepted writer\\n'); process.exit(1);");
  const merged = metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'https://github.com/o/r/pull/9' }], pageInfo: { hasNextPage: false } } });
  const DISPATCHES = `/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/dispatches`;
  const { out, calls, sent, error } = await runMain(['--apply'], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(40), epicIssue(41)],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
    [`GET /repos/${EPICS}/issues/40/comments`]: [],
    [`GET /repos/${EPICS}/issues/41/comments`]: [],
    [`POST /repos/${EPICS}/issues/40/comments`]: { id: 400 },
    [`POST /repos/${EPICS}/issues/41/comments`]: { id: 410 },
    [`GET /repos/${REPO_CONFIG.dispatchRepo}`]: { default_branch: 'main' },
    [`POST ${DISPATCHES}`]: null,
  }, { bin: NO_PLAN_BIN, issues: { 41: merged } });
  assert.equal(error, undefined);
  assert.ok(out.some(line => /#40 .*design: no plan; too little in its body to plan/.test(line)));
  assert.ok(out.some(line => /#41 .*triage: probably done by o\/r#9; close it\?; asking a triage run$/.test(line)));
  // Each record is written before its run is asked for, and the run is a triage one on the item.
  const writes = sent.map(([c]) => c);
  assert.deepEqual(writes, [`POST /repos/${EPICS}/issues/40/comments`, `POST /repos/${EPICS}/issues/41/comments`, `POST ${DISPATCHES}`]);
  assert.match(sent[0][1].body, /"design":true/);
  const [, record] = sent[1];
  const request = JSON.parse(/^<!-- schedule-triage\/v1: (.*) -->$/m.exec(record.body)[1]).request;
  const { inputs } = sent[2][1];
  assert.deepEqual({ ...inputs, task: undefined }, { kind: 'triage', repo: EPICS, item: '41', pool: REPO_CONFIG.coordinator.planPool, task: undefined });
  assert.ok(inputs.task.includes(request) && inputs.task.includes('https://github.com/o/r/pull/9'));
  assert.ok(calls.every(c => !c.startsWith('PATCH ')));
});

test('with --apply during a broker outage, a pass previews and writes nothing', async () => {
  const NO_PLAN_BIN = stub('no-plan-held', "process.stderr.write('error: no plan on this issue from an accepted writer\\n'); process.exit(1);");
  const merged = metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'https://github.com/o/r/pull/9' }], pageInfo: { hasNextPage: false } } });
  const outage = [{ number: 9, html_url: 'https://github.com/configured/tracker/issues/9', user: { login: REPO_CONFIG.bot },
    body: '<!-- tracker-broker-outage -->\nBroker unreachable', updated_at: new Date().toISOString() }];
  const { out, calls, error } = await runMain(['--apply'], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(40), epicIssue(41)],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
    [`GET /repos/${EPICS}/issues/40/comments`]: [],
    [`GET /repos/${EPICS}/issues/41/comments`]: [],
  }, { bin: NO_PLAN_BIN, issues: { 41: merged }, outage });
  assert.equal(error, undefined);
  assert.equal(out[0], 'held: broker outage https://github.com/configured/tracker/issues/9');
  assert.ok(out.some(line => /^\[dry-run\] .*#41 .*triage: probably done/.test(line)), out.join('\n'));
  assert.deepEqual(calls.filter(c => !c.startsWith('GET ') && c !== 'POST /graphql'), []);
});

test('an epic the census cannot read fails the pass, and is not reported as no live epics', async () => {
  // The board not readable with the token: every live epic is unread.
  const rest = {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
  };
  const { out, error } = await runMain(['--apply'], rest, { board: null });
  assert.match(error?.message ?? '', /1 epic\(s\) could not be read/);
  assert.match(out[0], new RegExp(`^no live epics; 1 epic\\(s\\) not read \\(${EPICS}#1: board .* not readable`));
});

test('an epic with no board Priority ranks after those with one, its sub-issues by their own', async () => {
  const sub = (number, priority) => ({ repository: 'o/r', number, state: 'open', url: `u${number}`, created: null, priority });
  const { items } = candidates([
    { number: 1, live: true, priority: null, subs: [sub(1, 'P0')] },
    { number: 2, live: true, priority: 'P3', subs: [sub(2, null), sub(3, 'P1')] },
  ], 'o/t');
  const steps = await decide(items, empty, caps(4), none, noPulls);
  assert.deepEqual(steps.map(s => s.item), ['o/r#3', 'o/r#2', 'o/r#1']);
});

test('epics past the census bound fail a pass that found no live one', async () => {
  const many = Array.from({ length: 51 }, (_, i) => epicIssue(i + 1));
  const rest = { [LIST]: many };
  for (const e of many) rest[`/repos/${EPICS}/issues/${e.number}/timeline`] = labelled(REPO_CONFIG.bot);
  const { out, error } = await runMain(['--apply'], rest);
  assert.match(out[0], /^no live epics; 1 more epic\(s\) not read/);
  assert.match(error?.message ?? '', /0 epic\(s\) could not be read, 1 more epic\(s\) not read/);
});

// What the eligibility query says, here and through decide.
for (const [name, data, reason] of [
  ['an umbrella', metadata({ subIssues: { totalCount: 1 } }), /has sub-issues/],
  ...['epic', 'question'].map(label => [`labelled ${label}`, metadata({ labels: { nodes: [{ name: label.toUpperCase() }], pageInfo: { hasNextPage: false } } }), new RegExp(`labelled ${label}`)]),
  ['done by a merged pull request', metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'merged-pr' }], pageInfo: { hasNextPage: false } } }), /probably done by merged-pr; close it\?/],
  ['closed', metadata({ state: 'CLOSED' }), /not open/],
]) {
  test(`an issue ${name} is skipped before its plan is read, and takes no slot`, async () => {
    const steps = await decide([issue(1), issue(2)], empty, caps(1), item => {
      assert.equal(item.number, 2);
      return plan('o/r#2');
    }, noPulls, key => eligibility(post(key.endsWith('#1') ? data : metadata()), key));
    assert.equal(steps[0].action, 'skip');
    assert.match(steps[0].reason, reason);
    assert.equal(steps[1].action, 'dispatch');
  });
}

test('the status issue is skipped whatever the case of its name, and only in its repository', async () => {
  const steps = await decide([issue(90, { repository: 'O/R' }), issue(90, { repository: 'o/p' })], empty,
    caps(4, { statusRepository: 'o/r', statusIssue: 90 }), own, noPulls);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [['skip', 'coordinator status issue'], ['dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-6']]);
});

test("a plan's target gets the same checks, and one not followed is not read", async () => {
  const inspected = [];
  const inspect = key => { inspected.push(key); return key === 'o/p#2' ? 'probably done; close it? pr' : null; };
  for (const [target, reason] of [['o/r#90', /: coordinator status issue$/], ['o/p#2', /: probably done/], ['else/where#3', /: not a followed repository$/]]) {
    const [step] = await decide([issue(1)], empty, caps(4, { statusRepository: 'o/r', statusIssue: 90 }), () => plan(target), noPulls, inspect);
    assert.equal(step.action, 'skip');
    assert.match(step.reason, reason);
  }
  assert.deepEqual(inspected, ['o/r#1', 'o/r#1', 'o/p#2', 'o/r#1']);
});

test('open or unmerged closing references do not mark an issue done', async () => {
  const data = metadata({ closedByPullRequestsReferences: { nodes: [{ merged: false, url: 'open' }], pageInfo: { hasNextPage: false } } });
  assert.equal(await eligibility(post(data), 'o/r#1'), null);
});

for (const data of [null, {}, metadata({ labels: { nodes: [], pageInfo: { hasNextPage: true } } }),
  metadata({ closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: true } } })]) {
  test(`metadata not read in full fails closed: ${JSON.stringify(data)}`, async () => {
    await assert.rejects(eligibility(post(data), 'o/r#1'), /eligibility/);
  });
}

test('GraphQL errors fail closed, and the query names the repository and issue', async () => {
  await assert.rejects(eligibility(async ({ query, variables }) => {
    assert.deepEqual(variables, { owner: 'o', name: 'r', number: 1 });
    assert.match(query, /closedByPullRequestsReferences\(first: 100, includeClosedPrs: true\)/);
    return { data: { repository: { issue: metadata() } }, errors: [{ message: 'denied' }] };
  }, 'o/r#1'), /not readable/);
});

for (const [name, extra, brief, responses, expected] of [
  ['open closer', { closedByPullRequestsReferences: { nodes: [{ state: 'OPEN', url: 'https://github.com/o/r/pull/6' }], pageInfo: { hasNextPage: false } } }, '', [], 'PR open: o/r#6'],
  ...['OPEN', 'MERGED', 'CLOSED'].map(state => [
    `body cross-reference ${state}`, { timelineItems: { nodes: [{ source: { state, merged: state === 'MERGED', url: 'https://github.com/o/p/pull/6', repository: { owner: { login: 'O' } } } }], pageInfo: { hasNextPage: false } } }, '', [],
    // A merged one that only mentions the issue is no guess that it is done.
    state === 'OPEN' ? 'PR open: o/p#6' : null,
  ]),
  ...[['Refs o/r#1', 'probably done by o/p#6; close it?'], ['Implements: https://github.com/o/r/issues/1', 'probably done by o/p#6; close it?'],
    ['Follow-ups, left for later:\n- #1\n- o/r#1', null], ['Refs o/r#10', null], ['Refs #1', null], ['Fixes https://github.com/o/r/issues/1', 'probably done by o/p#6; close it?']].map(([body, expected]) => [
    `merged cross-reference saying ${JSON.stringify(body)}`,
    { timelineItems: { nodes: [{ source: { state: 'MERGED', merged: true, body, url: 'https://github.com/o/p/pull/6', repository: { nameWithOwner: 'o/p', owner: { login: 'o' } } } }], pageInfo: { hasNextPage: false } } }, '', [], expected,
  ]),
  ['foreign cross-reference', { timelineItems: { nodes: [{ source: { state: 'OPEN', repository: { owner: { login: 'other' } } } }], pageInfo: { hasNextPage: false } } }, '', [], null],
  ['native dependency', { blockedBy: { nodes: [{ state: 'OPEN', url: 'https://github.com/o/p/issues/9' }], pageInfo: { hasNextPage: false } } }, '', [], 'blocked by o/p#9'],
  ['body dependency', { body: 'Waiting on https://github.com/o/p/pull/9' }, '', [{ state: 'open' }], 'blocked by o/p#9'],
  ['plan dependency', {}, 'Blocked by o/p#9', [{ state: 'open' }], 'blocked by o/p#9'],
  ['closed dependency', { body: 'Depends on #9' }, '', [{ state: 'closed' }], null],
  ['mere mention', { body: 'See #9' }, '', [], null],
  ['branch PR', {}, 'Branch: dispatch/work', [[{ html_url: 'https://github.com/o/r/pull/6' }]], 'PR open: o/r#6'],
  ['existing branch', {}, 'Branch: dispatch/work', [[], [{ ref: 'refs/heads/dispatch/work' }]], 'PR open: o/r (branch dispatch/work)'],
  ['absent branch', {}, 'Branch: dispatch/work', [[], []], null],
]) {
  test(`duplicate-work eligibility: ${name}`, async () => {
    const pending = [...responses];
    assert.equal(await eligibility(post(metadata(extra)), 'o/r#1', brief, async () => {
      assert.ok(pending.length, 'unexpected read');
      return pending.shift();
    }), expected);
    assert.equal(pending.length, 0);
  });
}

for (const field of ['timelineItems', 'blockedBy']) {
  test(`incomplete ${field} fails closed`, async () => {
    await assert.rejects(eligibility(post(metadata({ [field]: { nodes: [], pageInfo: { hasNextPage: true } } })), 'o/r#1'), /eligibility/);
  });
}

test('coordinator Blocked status survives candidate selection and consumes no slot', async () => {
  const { items } = candidates([{ number: 10, live: true, subs: [
    { ...issue(1), state: 'open', status: 'Blocked' }, { ...issue(2), state: 'open' },
  ] }], 'o/t');
  const steps = await decide(items, empty, caps(1), item => {
    assert.equal(item.number, 2);
    return own(item);
  }, noPulls);
  assert.match(steps[0].reason, /^blocked by/);
  assert.equal(steps[1].action, 'dispatch');
});

test('plan dependencies check the followed target and leave the slot free', async () => {
  const calls = [];
  const steps = await decide([issue(1), issue(2)], empty, caps(1), item =>
    item.number === 1 ? plan('o/p#7', { brief: 'Blocked by #9' }) : own(item), noPulls,
  async (key, brief) => {
    calls.push([key, brief]);
    return eligibility(post(metadata()), key, brief, async p => {
      assert.equal(p, '/repos/o/p/issues/9');
      return { state: 'open' };
    });
  });
  assert.deepEqual(steps.map(s => s.action), ['skip', 'dispatch']);
  assert.equal(steps[0].reason, "its plan's o/p#7: blocked by o/p#9");
  assert.ok(calls.some(([key, brief]) => key === 'o/p#7' && brief === 'Blocked by #9'));
});

test('excessive dependencies and unreadable prerequisites fail closed', async () => {
  await assert.rejects(eligibility(post(metadata()), 'o/r#1',
    `Blocked by ${Array.from({ length: 11 }, (_, i) => `#${i + 1}`).join(', ')}`), /exceeds 10/);
  await assert.rejects(eligibility(post(metadata({ body: 'Waiting on #9' })), 'o/r#1', '', async () => ({})), /not readable/);
});

test('a pointer cannot dispatch a blocked candidate target', async () => {
  const steps = await decide([issue(1), issue(2, { status: 'Blocked' })], empty, caps(1),
    () => plan('o/r#2'), noPulls);
  assert.ok(steps.every(s => s.action === 'skip'));
  assert.match(steps[0].reason, /blocked by/);
});

for (const body of ['Implement #1; blocked by #9.', 'See o/p#4; waiting on #9.', 'Depends on #1 and #9.', 'Depends on #9; see #4 for background.']) {
  test(`only dependency clause references other than self count: ${body}`, async () => {
    const reads = [];
    assert.equal(await eligibility(post(metadata({ body })), 'o/r#1', '', async p => {
      reads.push(p);
      return { state: 'closed' };
    }), null);
    assert.deepEqual(reads, ['/repos/o/r/issues/9']);
  });
}

test('actual dry-run task reaches dependency eligibility through probePlan', async () => {
  const output = { body: { inputs: { repo: 'o/r', item: '7', kind: 'implement', task: 'Waiting on #9' } } };
  const binary = stub('dependency-plan', `process.stdout.write(${JSON.stringify(JSON.stringify(output))}); process.stderr.write('Dry run: request for the plan in https://github.com/o/r/issues/7#issuecomment-42 by op');`);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  try {
    const steps = await decide([ITEM], empty, caps(1), item => probePlan(binary, CONFIG, TOKEN, item), noPulls,
      (key, brief) => eligibility(post(metadata()), key, brief, async () => ({ state: 'open' })));
    assert.equal(steps[0].action, 'skip');
    assert.match(steps[0].reason, /blocked by o\/r#9/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('a pointer target outside the candidate list respects the configured board hold', async () => {
  const target = metadata({ projectItems: { nodes: [{ project: { number: 3, owner: { login: 'O' } }, status: { name: 'Blocked' } }], pageInfo: { hasNextPage: false } } });
  const [step] = await decide([issue(1)], empty, caps(1), () => plan('o/p#7'), noPulls,
    (key, brief) => eligibility(post(key === 'o/p#7' ? target : metadata()), key, brief, undefined, { owner: 'o', project: 3 }));
  assert.equal(step.action, 'skip');
  assert.match(step.reason, /blocked by/);
  assert.equal(await eligibility(post(target), 'o/p#7', '', undefined, { owner: 'other', project: 3 }), null);
  await assert.rejects(eligibility(post(metadata({ projectItems: { nodes: [], pageInfo: { hasNextPage: true } } })), 'o/r#1'), /board metadata/);
});

// Batching (#631): agent-board's `dispatch --batch N`, from `schedule.batch`.
test('schedule.batch is off unless set, and bounded by agent-board', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { owner: 'o', project: 1, wip: 4, repositories: ['o/r'], ...extra } }));
  assert.equal(parse({}).batch, 0);
  assert.equal(parse({ batch: 5 }).batch, 5);
  for (const batch of [-1, 6, '2', 1.5]) assert.throws(() => parse({ batch }), /schedule.batch/);
});

test('--batch is passed only when on', async () => {
  // GARBLED fails to parse, and the error names the command it ran.
  await assert.rejects(probePlan(GARBLED, { ...CONFIG, batch: 2 }, TOKEN, ITEM), /--planner cgwalters-bot --batch 2: output not understood/);
  await assert.rejects(probePlan(GARBLED, CONFIG, TOKEN, ITEM), /--planner cgwalters-bot: output not understood/);
});

test("a dry run's batched issues are held for the rest of the pass", async () => {
  const stdout = JSON.stringify({ body: { inputs: { repo: 'o/r', item: '1', kind: 'implement' } } });
  const stderr = 'Not batched: o/r#4: no plan\nBatched: o/r#2 from the plan in https://x\nBatched: O/R#3 from the plan in https://y\n'
    + 'Dry run: request for the plan in https://github.com/o/r/issues/1#issuecomment-42 by op; nothing was sent.\n';
  const found = readDryRun(stdout, stderr);
  assert.deepEqual(found.extras, ['o/r#2', 'o/r#3']);
  const steps = await decide([issue(1), issue(2), issue(3), issue(4)], empty, caps(4),
    item => (item.number === 1 ? found : own(item)), noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-42'],
    ['o/r#2', 'skip', 'a run is in flight, batched with o/r#1 in this pass'],
    ['o/r#3', 'skip', 'a run is in flight, batched with o/r#1 in this pass'],
    ['o/r#4', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'],
  ]);
});

test("a batched pull request names each issue it closes, once, in its own repository", () => {
  const pull = { html_url: 'https://github.com/o/r/pull/9', user: { login: BOT },
    body: 'Batch\n\nCloses #2\nfixes O/P#4\nCloses #2\nsee Closes #5 inline\nRefs o/r#1' };
  assert.deepEqual(pullIssues(pull), ['o/r#1', 'o/r#2', 'o/p#4']);
  assert.deepEqual([...openPullRefs([pull], BOT).keys()], ['o/r#1', 'o/r#2', 'o/p#4']);
  // The base repository, where the API gives it, over the URL.
  assert.deepEqual(pullIssues({ base: { repo: { full_name: 'o/q' } }, body: 'Closes #3' }), ['o/q#3']);
  // No repository to read a bare #N in: not guessed.
  assert.deepEqual(pullIssues({ body: 'Closes #3' }), []);
  // Bounded, whoever wrote it.
  assert.equal(pullIssues({ html_url: pull.html_url, body: Array.from({ length: 50 }, (_, i) => `Closes #${i + 1}`).join('\n') }).length, 10);
});

test("an extra's batch record is released as agent-board releases it", async () => {
  const writers = ['cgwalters', BOT];
  const rec = primary => ({ user: { login: BOT }, created_at: '2026-10-15T10:00:00Z', html_url: `rec-${primary}`,
    body: `<!-- agent-board-dispatch: 42@2026-10-15T10:00:00Z -->\n<!-- agent-board-batch: ${primary} -->\nDispatched` });
  const asked = [];
  const released = answer => async primary => { asked.push(primary); return answer; };
  assert.equal(await findRecord([rec('O/R#1')], writers, '42', 'o/r#2', released(true)), undefined);
  assert.deepEqual(asked, ['o/r#1']);
  assert.equal(await findRecord([rec('o/r#1')], writers, '42', 'o/r#2', released(false)), 'rec-o/r#1');
  // A record naming the issue itself, or a malformed batch line, holds without asking.
  asked.length = 0;
  assert.equal(await findRecord([rec('o/r#2')], writers, '42', 'o/r#2', released(true)), 'rec-o/r#2');
  assert.equal(await findRecord([rec('o/r#1 x')], writers, '42', 'o/r#2', released(true)), 'rec-o/r#1 x');
  assert.deepEqual(asked, []);
  // A released record does not hide another that holds.
  const plain = { ...rec('x'), body: '<!-- agent-board-dispatch: 42@t -->', html_url: 'plain' };
  assert.equal(await findRecord([rec('o/r#1'), plain], writers, '42', 'o/r#2', released(true)), 'plain');
  // Unreadable fails, so the item is skipped and the record holds.
  await assert.rejects(findRecord([rec('o/r#1')], writers, '42', 'o/r#2', async () => { throw new Error('boom'); }), /boom/);
});

test('a batch is over once its primary is closed and nothing open closes the extra', async () => {
  const get = state => async p => (p === '/repos/o/r/issues/1' ? { state } : undefined);
  const closers = (...states) => async () => ({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: states.map(state => ({ state })) } } } } });
  assert.equal(await batchReleased(get('open'), closers(), 'o/r#1', 'o/r#2'), false);
  assert.equal(await batchReleased(get('closed'), closers('MERGED'), 'o/r#1', 'o/r#2'), true);
  assert.equal(await batchReleased(get('closed'), closers('OPEN'), 'o/r#1', 'o/r#2'), false);
  await assert.rejects(batchReleased(get(undefined), closers(), 'o/r#1', 'o/r#2'), /not readable/);
  await assert.rejects(batchReleased(get('closed'), async () => ({ errors: [{}] }), 'o/r#1', 'o/r#2'), /not readable/);
});

test('an extra the tracker would not take sends its item alone, without --batch', async () => {
  const found = plan('o/r#1', { extras: ['o/r#2', 'o/r#3'] });
  const run = (items, inspect = async () => null, pullFor = noPulls, state = empty) =>
    decide(items, state, caps(4), item => (item.number === 1 ? found : none()), pullFor, inspect);
  const alone = async (...args) => { const [step] = await run(...args); assert.equal(step.batch, false); return step.reason; };
  assert.match(await alone([issue(1), issue(3, { status: 'Blocked' })]), /alone, as batched o\/r#3: blocked by coordinator plan/);
  assert.match(await alone([issue(1)], async () => null, async key => (key === 'o/r#2' ? 'pr9' : undefined)), /o\/r#2: a pull request is open, pr9/);
  assert.match(await alone([issue(1)], async key => (key === 'o/r#3' ? 'labelled question' : null)), /o\/r#3: labelled question/);
  // An extra that cannot be read leaves it out too, rather than the item.
  assert.match(await alone([issue(1)], async key => { if (key === 'o/r#2') throw new Error('exceeds 100'); return null; }),
    /o\/r#2: could not be read: exceeds 100/);
  assert.match(await alone([issue(1)], undefined, noPulls, { inFlight: 0, busy: new Map([['o/r#2', 'run7']]) }), /o\/r#2: a run is in flight, run7/);
  const [outside] = await decide([issue(1)], empty, caps(4), () => plan('o/r#1', { extras: ['x/y#2'] }), noPulls);
  assert.match(outside.reason, /x\/y#2: not a followed repository/);
  // An alone item does not hold the extras it left out.
  const steps = await run([issue(1), issue(2)], async key => (key === 'o/r#3' ? 'not open' : null));
  assert.equal(steps[1].reason, 'no plan');
  // All fit: batched, no flag.
  const [batched] = await run([issue(1)]);
  assert.equal(batched.batch, undefined);
});

test("only the item's own brief is read for its dependencies", async () => {
  const task = 'Fix it.\n\n---\n\nBatched run: this run also does the issues below.\n\n## o/r#2\n\nDepends on #9.';
  const output = { body: { inputs: { repo: 'o/r', item: '7', kind: 'implement', task } } };
  const binary = stub('batched-plan', `process.stdout.write(${JSON.stringify(JSON.stringify(output))}); process.stderr.write('Batched: o/r#2 from the plan in https://x\\nDry run: request for the plan in https://github.com/o/r/issues/7#issuecomment-42 by op');`);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  try {
    const found = await probePlan(binary, { ...CONFIG, batch: 2 }, TOKEN, ITEM);
    assert.equal(found.brief, 'Fix it.');
    assert.deepEqual(found.extras, ['o/r#2']);
    assert.equal(found.recorded, undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// Guesses asked of a triage run (#636), with `schedule.triage` on.
const LONG = 'Change the scheduler so that it does one concrete thing, and test it this way. '.repeat(4);
const guessed = key => (key === 'o/r#1' ? 'probably done by o/p#6; close it?' : null);

test('schedule.triage is off unless set, and bounded', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { owner: 'o', project: 1, wip: 4, repositories: ['o/r'], ...extra } }));
  assert.equal(parse({}).triage, 0);
  assert.equal(parse({ triage: 5 }).triage, 5);
  for (const triage of [-1, 6, '2', 1.5]) assert.throws(() => parse({ triage }), /schedule.triage/);
});

test('off, a guess is a skip as before', async () => {
  const steps = await decide([issue(1), issue(2)], empty, caps(4), none, noPulls, guessed, undefined, () => assert.fail('read'));
  assert.deepEqual(steps.map(s => s.reason), ['probably done by o/p#6; close it?', 'no plan']);
});

test('a probably done issue gets a triage run, which takes a slot and the budget', async () => {
  const run = (wip, triage) => decide([issue(1), issue(2, { body: LONG })], empty, caps(wip, { triage }), none, noPulls, guessed, undefined, async () => null);
  const steps = await run(4, 1);
  assert.deepEqual(steps.map(s => [s.action, s.reason]), [
    ['triage', 'probably done by o/p#6; close it?; asking a triage run'],
    // The budget is spent: the next guess is a skip as before.
    ['skip', 'no plan'],
  ]);
  assert.equal(steps[0].pull, 'o/p#6');
  assert.deepEqual((await run(1, 2)).map(s => [s.action, s.reason]), [
    ['triage', 'probably done by o/p#6; close it?; asking a triage run'],
    ['skip', 'work-in-progress cap of 1 reached'],
  ]);
  // A run started holds its item for the rest of the pass.
  assert.deepEqual((await decide([issue(1), issue(1)], empty, caps(4, { triage: 2 }), none, noPulls, guessed, undefined, async () => null))
    .map(s => s.action), ['triage', 'skip']);
});

test('a "no plan" issue with a concrete body is planned; a stub is recorded needs design, taking no slot', async () => {
  const steps = await decide([issue(2, { body: LONG }), issue(3, { body: 'tbd' }), issue(4, { body: LONG })], empty, caps(1, { triage: 3 }),
    none, noPulls, undefined, undefined, async () => null);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#2', 'triage', 'no plan; asking a triage run'],
    ['o/r#3', 'skip', 'work-in-progress cap of 1 reached'],
    ['o/r#4', 'skip', 'work-in-progress cap of 1 reached'],
  ]);
  const design = await decide([issue(3, { body: 'tbd' }), issue(2, { body: LONG })], empty, caps(1, { triage: 3 }),
    none, noPulls, undefined, undefined, async () => null);
  assert.deepEqual(design.map(s => s.action), ['design', 'triage']);
});

test('an answered question: done closes, not done lets the plan go on, unanswered or needs design is quiet', async () => {
  const answers = {
    1: { url: 'rec1', verdict: 'done', evidence: 'ev1' },
    2: { url: 'rec2', verdict: 'partly' },
    3: { url: 'rec3' },
    4: { url: 'rec4', verdict: 'needs-design' },
    5: { url: 'rec5', stale: true },
    6: { url: 'rec6', verdict: 'not-done' },
  };
  const items = [1, 2, 3, 4, 5, 6].map(n => issue(n));
  const steps = await decide(items, empty, caps(8, { triage: 1 }), item => (item.number === 2 ? own(item) : none()), noPulls,
    (key, brief, cleared) => (!cleared && /#[1-5]$/.test(key) ? 'probably done by o/p#6; close it?' : null), undefined, async item => answers[item.number]);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason, s.quiet ?? false]), [
    ['o/r#1', 'close', 'triage found it done, ev1', false],
    // The guess no longer holds it: its plan, which the run wrote, starts.
    ['o/r#2', 'dispatch', `plan ${own(issue(2)).plan}`, false],
    ['o/r#3', 'skip', 'triage asked, rec3', true],
    ['o/r#4', 'skip', 'needs design, rec4', true],
    // A question a day old with no answer is listed again, not asked again.
    ['o/r#5', 'skip', 'triage asked, no answer in a day, rec5', false],
    ['o/r#6', 'skip', 'no plan since triage answered not-done, rec6', true],
  ]);
  assert.equal(steps[0].evidence, 'ev1');
  const [reopened] = await decide([issue(7)], empty, caps(8, { triage: 1 }), own, noPulls, (key, brief, cleared) => (cleared ? null : 'probably done by o/p#6; close it?'),
    undefined, async () => ({ url: 'rec7', verdict: 'reopened' }));
  assert.equal(reopened.action, 'dispatch');
});

test('only a writer’s record and answer count, for the same request, after the record', () => {
  const writers = ['cgwalters', BOT];
  const at = m => `2026-10-16T10:${String(m).padStart(2, '0')}:00Z`;
  const comment = (login, body, m, url) => ({ user: { login }, body, created_at: at(m), html_url: url });
  const record = (login, m, extra = {}) => comment(login, `<!-- schedule-triage/v1: ${JSON.stringify({ request: 'r1', ...extra })} -->\nasked`, m, `rec-${login}`);
  const answer = (login, m, verdict, request = 'r1') => comment(login, `Done.\n\n\`\`\`schedule-triage\n${JSON.stringify({ request, verdict })}\n\`\`\`\n`, m, `ans-${login}-${m}`);
  assert.equal(readTriage([record('visitor', 1)], writers, ''), null);
  assert.deepEqual(readTriage([record(BOT, 1)], writers, '', Date.parse(at(2))), { url: `rec-${BOT}`, stale: false });
  assert.equal(readTriage([record(BOT, 1)], writers, '', Date.parse(at(1)) + 25 * 3600e3).stale, true);
  // A visitor's answer, one for another request and one older than the record do not count.
  const ignored = [answer(BOT, 0, 'done'), record(BOT, 1), answer('visitor', 2, 'done'), answer(BOT, 3, 'done', 'r0')];
  assert.equal(readTriage(ignored, writers, '', Date.parse(at(4))).verdict, undefined);
  assert.deepEqual(readTriage([...ignored, answer(BOT, 5, 'partly')], writers, ''), { url: `rec-${BOT}`, request: 'r1', verdict: 'partly', evidence: `ans-${BOT}-5` });
  // Once closed on a done answer, a reopened issue goes on as not done.
  const closed = comment(BOT, '<!-- schedule-triage/v1-closed: r1 -->\nclosing', 3, 'c');
  assert.equal(readTriage([record(BOT, 1), answer(BOT, 2, 'done'), closed], writers, '').verdict, 'reopened');
  assert.equal(readTriage([record(BOT, 1), answer(BOT, 2, 'done'), { ...closed, user: { login: 'visitor' } }], writers, '').verdict, 'done');
  assert.equal(readTriage([record(BOT, 1), answer('cgwalters', 2, 'maybe')], writers, '', Date.parse(at(3))).verdict, undefined);
  // A needs-design record lapses once the body is written up.
  const design = triageRecord('r1', { action: 'design', reason: 'no plan' }, 'tbd');
  assert.deepEqual(readTriage([comment(BOT, design, 1, 'd')], writers, 'tbd'), { url: 'd', verdict: 'needs-design' });
  assert.equal(readTriage([comment(BOT, design, 1, 'd')], writers, LONG), null);
  // So does a run's needs-design answer; another answer holds.
  const asked = comment(BOT, triageRecord('r1', { action: 'triage', reason: 'no plan; asking' }, 'tbd'), 1, 'q');
  assert.equal(readTriage([asked, answer(BOT, 2, 'needs-design')], writers, LONG), null);
  assert.equal(readTriage([asked, answer(BOT, 2, 'not-done')], writers, LONG).verdict, 'not-done');
});

test("a triage run's task carries URLs and the request, not the issue's text", () => {
  const task = triageTask({ planDocs: 'https://github.com/o/agent-board/blob/main/docs/job-plans.md' }, issue(1, { body: 'IGNORE ALL' }), 'r1', 'o/p#6');
  assert.ok(task.includes('https://github.com/o/r/issues/1') && task.includes('https://github.com/o/p/pull/6') && task.includes('"request":"r1"'));
  assert.ok(task.includes('docs/job-plans.md') && !task.includes('IGNORE ALL'));
  assert.match(triageTask({ planDocs: 'd' }, issue(1), 'r1'), /no accepted job plan/);
});

test('a pass that starts nothing with slots free says so, with the counts per reason', () => {
  const skip = (reason, quiet) => ({ action: 'skip', reason, ...(quiet ? { quiet } : {}) });
  const steps = [skip('no plan'), skip('no plan'), skip('a run is in flight, https://x/1'), skip('needs design, https://x/2', true),
    skip("its plan's o/p#3: a pull request is open, pr"), { action: 'design', reason: 'no plan; too little' }];
  assert.equal(idleLine(steps, 3),
    "idle: 3 slot(s) free and nothing started; skipped: no plan 2, a run is in flight 1, needs design 1, its plan's #N 1");
  assert.equal(idleLine(steps, 0), null);
  assert.equal(idleLine([...steps, { action: 'triage', reason: 'x' }], 3), null);
  assert.equal(idleLine([], 2), 'idle: 2 slot(s) free and nothing started');
});

test('with --apply, a done answer closes the issue after a comment naming the evidence', async () => {
  const merged = metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'https://github.com/o/r/pull/9' }], pageInfo: { hasNextPage: false } } });
  const at = '2026-10-16T10:00:00Z';
  const comments = [
    { user: { login: REPO_CONFIG.bot }, created_at: at, html_url: 'rec', body: '<!-- schedule-triage/v1: {"request":"r1"} -->\nasked' },
    { user: { login: REPO_CONFIG.bot }, created_at: at, html_url: 'ans', body: 'Done: see o/r#9.\n```schedule-triage\n{"request":"r1","verdict":"done"}\n```' },
  ];
  const { out, sent, error } = await runMain(['--apply'], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(41)],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
    [`GET /repos/${EPICS}/issues/41/comments`]: comments,
    [`POST /repos/${EPICS}/issues/41/comments`]: { id: 1 },
    [`PATCH /repos/${EPICS}/issues/41`]: {},
  }, { issues: { 41: merged } });
  assert.equal(error, undefined);
  assert.ok(out.some(line => /#41 .*close: triage found it done, ans$/.test(line)));
  // Closed before the comment that says so, which would otherwise read as reopened.
  assert.deepEqual(sent.map(([c]) => c), [`PATCH /repos/${EPICS}/issues/41`, `POST /repos/${EPICS}/issues/41/comments`]);
  assert.deepEqual(sent[0][1], { state: 'closed', state_reason: 'completed' });
  assert.match(sent[1][1].body, /^<!-- schedule-triage\/v1-closed: r1 -->\n.*ans/);
});

test("answered not done, the item's own plan with a brief starts, and the checks after the guess still hold", async () => {
  const merged = { timelineItems: { nodes: [{ source: { state: 'MERGED', merged: true, body: 'Refs o/r#2', url: 'https://github.com/o/p/pull/6', repository: { nameWithOwner: 'o/p', owner: { login: 'o' } } } }], pageInfo: { hasNextPage: false } } };
  const run = (extra, verdict = 'partly') => decide([issue(2)], empty, caps(4, { triage: 1 }), () => plan('o/r#2', { brief: 'Do the rest.' }), noPulls,
    (key, brief, cleared) => eligibility(post(metadata({ ...merged, ...extra })), key, brief, undefined, {}, cleared), undefined,
    async () => ({ url: 'rec', verdict }));
  for (const verdict of ['partly', 'not-done', 'reopened']) assert.equal((await run({}, verdict))[0].action, 'dispatch');
  const [blocked] = await run({ blockedBy: { nodes: [{ state: 'OPEN', url: 'https://github.com/o/r/issues/9' }], pageInfo: { hasNextPage: false } } });
  assert.deepEqual([blocked.action, blocked.reason], ['skip', 'blocked by o/r#9']);
  // Without the answer, the guess holds.
  assert.equal(await eligibility(post(metadata(merged)), 'o/r#2'), 'probably done by o/p#6; close it?');
});

// tracker#645: a recorded plan's run, read from its record and agentic-job's
// status comment on its target, decides instead of a skip as dispatched already.
const OUT_CONFIG = { caller: 'o/t', operator: 'op', planner: BOT, followed: new Set(['o/r', 'o/p']) };
const runUrl = id => `https://github.com/o/t/actions/runs/${id}`;
const RECORD = { id: 500, user: { login: BOT }, created_at: '2026-10-14T10:00:05Z', html_url: 'rec',
  body: `<!-- agent-board-dispatch: 42@2026-10-14T10:00:00Z -->\nDispatched the plan in https://github.com/o/r/issues/7#issuecomment-42: [run](${runUrl(77)}).` };
const statusOf = (text, login = BOT, id = 77) => ({ user: { login }, body: `${text}\n\n<!-- agentic-job-run: ${id} -->\n\n<!-- agentic-job-status -->` });
const foundWith = (comments, extra = {}) => ({ plan: 'p', commentId: '42', target: 'o/r#7', self: 'o/r#7', record: RECORD, comments: [RECORD, ...comments], ...extra });
const runOf = extra => ({ html_url: runUrl(77), display_title: 'implement o/r#7 (claude)', status: 'completed', conclusion: 'success', ...extra });
// Answers GETs by path; anything else read fails the test.
const reads = answers => async p => { if (p in answers) return answers[p]; assert.fail(`read ${p}`); };
const PR9 = 'https://github.com/o/r/pull/9';
const opened = `✅ [dispatch](${runUrl(77)}) ended well and opened pull request #9. Result: ${PR9}`;

test('schedule.retries is off unless set, and bounded', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { owner: 'o', project: 1, wip: 4, repositories: ['o/r'], ...extra } }));
  assert.equal(parse({}).retries, 0);
  assert.equal(parse({ retries: 2 }).retries, 2);
  for (const retries of [-1, 3, '1', 1.5]) assert.throws(() => parse({ retries }), /schedule.retries/);
});

test("a run's merged, open or closed pull request is read from its status comment, and only the planner's counts", async () => {
  const at = pull => readOutcome(reads({ '/repos/o/t/actions/runs/77': runOf(), '/repos/o/r/pulls/9': { user: { login: BOT }, html_url: PR9, ...pull } }),
    OUT_CONFIG, foundWith([statusOf(opened)]), [statusOf(opened)]);
  assert.deepEqual(await at({ merged_at: 't', state: 'closed', body: 'Done.\n\nCloses #7' }),
    { run: runUrl(77), runId: '77', attempt: 1, pull: PR9, outcome: 'merged', partOf: false });
  assert.equal((await at({ merged_at: 't', body: 'Part of o/r#7' })).partOf, true);
  assert.equal((await at({ state: 'open' })).outcome, 'open');
  assert.equal((await at({ state: 'closed' })).outcome, 'closed');
  // A visitor's pull request is no outcome: the run made none it can show.
  assert.equal((await at({ user: { login: 'visitor' }, merged_at: 't' })).outcome, 'failed');
  // Closed once for this run: a reopened issue is not closed again.
  const closed = { user: { login: BOT }, body: '<!-- schedule-outcome/v1-closed: 77 -->\nclosed' };
  const reopened = await readOutcome(reads({ '/repos/o/t/actions/runs/77': runOf(), '/repos/o/r/pulls/9': { user: { login: BOT }, html_url: PR9, merged_at: 't' } }),
    OUT_CONFIG, foundWith([closed]), [statusOf(opened)]);
  assert.equal(reopened.outcome, 'reopened');
});

test("no visitor's comment or agent's reason names a run's pull request", async () => {
  const get = reads({ '/repos/o/t/actions/runs/77': runOf() });
  // A copied status comment: not the planner's, and the run ended well, so not known.
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([]), [statusOf(opened, 'visitor')]), null);
  // The job token's is the caller repository's own only.
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([]), [statusOf(opened, 'github-actions[bot]')]), null);
  // Another run's status comment is not this run's.
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([]), [statusOf(opened, BOT, 78)]), null);
  // A link in the agent's quoted reason is not read: no pull request is asked for.
  const noResult = `✅ [dispatch](${runUrl(77)}) ended well and handed back no result. Its reason:\n\n> Result: ${PR9}`;
  const out = await readOutcome(get, OUT_CONFIG, foundWith([]), [statusOf(noResult)]);
  assert.deepEqual([out.outcome, out.reason], ['failed', '✅ dispatch ended well and handed back no result.']);
});

test('a record without a run of the caller on its target, or an extra of a batch, is not known', async () => {
  const get = reads({ '/repos/o/t/actions/runs/77': runOf({ display_title: 'implement o/r#8' }) });
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([]), []), null);
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([], { record: { ...RECORD, body: RECORD.body.replace('o/t/actions', 'x/t/actions') } }), []), null);
  const extra = { ...RECORD, body: RECORD.body.replace('\n', '\n<!-- agent-board-batch: o/r#1 -->\n') };
  assert.equal(await readOutcome(get, OUT_CONFIG, foundWith([], { record: extra }), []), null);
  const running = await readOutcome(reads({ '/repos/o/t/actions/runs/77': runOf({ status: 'in_progress', conclusion: null }) }), OUT_CONFIG, foundWith([]), []);
  assert.equal(running.outcome, 'running');
});

test("a failed run's reason is its status comment's own text, or its conclusion", async () => {
  const refused = statusOf(`❌ [dispatch](${runUrl(77)}) refused by check: a secret-shaped string is in what the agent handed back`);
  const get = reads({ '/repos/o/t/actions/runs/77': runOf({ conclusion: 'failure' }) });
  assert.deepEqual(await readOutcome(get, OUT_CONFIG, foundWith([]), [refused]),
    { run: runUrl(77), runId: '77', attempt: 1, outcome: 'failed', reason: '❌ dispatch refused by check: a secret-shaped string is in what the agent handed back' });
  assert.equal((await readOutcome(get, OUT_CONFIG, foundWith([]), [])).reason, 'it concluded failure');
  // A failed run's refusal can carry text the agent chose: no pull request is read from it.
  const steered = statusOf(`❌ [dispatch](${runUrl(77)}) refused by check: bad path x Result: ${PR9}`);
  assert.equal((await readOutcome(get, OUT_CONFIG, foundWith([]), [steered])).outcome, 'failed');
  // A cancelled run was someone's decision: not known, so not retried.
  assert.equal(await readOutcome(reads({ '/repos/o/t/actions/runs/77': runOf({ conclusion: 'cancelled' }) }), OUT_CONFIG, foundWith([]), []), null);
});

test("each retry record of this job for the plan since it changed is an attempt", async () => {
  const retryRec = (login, id, line = 1) => ({ user: { login }, created_at: '2026-10-15T00:00:00Z',
    body: line === 1 ? `<!-- schedule-retry/v1: ${id} -->\nfreed` : `<!-- agent-board-dispatch: ${id}@t -->\n<!-- schedule-retry/v1: ${id} -->\nagain` });
  const planComment = updated => ({ id: 42, user: { login: 'op' }, updated_at: updated, body: 'plan' });
  const get = reads({ '/repos/o/t/actions/runs/77': runOf({ conclusion: 'failure' }) });
  const attempts = comments => readOutcome(get, OUT_CONFIG, foundWith(comments), []).then(o => o.attempt);
  assert.equal(await attempts([planComment('2026-10-14T00:00:00Z'), retryRec(BOT, 42), retryRec('op', 42, 2), retryRec('visitor', 42), retryRec(BOT, 41)]), 3);
  // An edited plan is a new plan, whose attempts start again.
  assert.equal(await attempts([planComment('2026-10-16T00:00:00Z'), retryRec(BOT, 42), retryRec(BOT, 42, 2)]), 1);
});

test('a run that handed back missing data names one blocker, in a followed repository and not its own item', async () => {
  const missing = statusOf(`❌ [dispatch](${runUrl(77)}) handed back no result because required data was missing. Its reason:\n\n`
    + '> Needs o/r#7 and up/stream#1 done, then https://github.com/o/p/issues/3 merged; also o/r#4.');
  const get = reads({ '/repos/o/t/actions/runs/77': runOf({ conclusion: 'failure' }), '/repos/o/p/issues/3': { state: 'open', id: 333 } });
  const out = await readOutcome(get, OUT_CONFIG, foundWith([]), [missing]);
  assert.deepEqual(out.blocker, { key: 'o/p#3', open: true, pull: false, id: 333 });
  assert.equal(out.reason, '❌ dispatch handed back no result because required data was missing.');
  // Any other failure names none, whatever its text.
  const other = statusOf(`❌ [dispatch](${runUrl(77)}) failed (agent, check, apply: failure/skipped/skipped). Its reason:\n\n> see o/p#3`);
  assert.equal((await readOutcome(get, OUT_CONFIG, foundWith([]), [other])).blocker, undefined);
});

const RECORDED = plan('o/r#1', { recorded: 'rec' });
const decideOn = (out, extra = {}, items = [issue(1)]) => decide(items, empty, caps(extra.wip ?? 4, { retries: 2, ...extra }),
  item => (item.number === 1 ? RECORDED : own(item)), noPulls, undefined, undefined, async () => null, async () => out);
const failed = (attempt, extra = {}) => ({ run: 'run77', runId: '77', attempt, outcome: 'failed', reason: 'refused by check', ...extra });

test('off, a recorded plan is skipped as dispatched already, and its run is not read', async () => {
  const steps = await decide([issue(1)], empty, caps(4), () => RECORDED, noPulls, undefined, undefined, undefined, () => assert.fail('read'));
  assert.match(steps[0].reason, /dispatched already, rec$/);
});

test("a recorded plan whose run's pull request merged closes the issue; one part of it asks a triage run", async () => {
  const merged = { run: 'run77', runId: '77', attempt: 1, pull: PR9, outcome: 'merged', partOf: false };
  assert.deepEqual((await decideOn(merged)).map(s => [s.action, s.reason, s.pull, s.outcome]), [['done', "its run's PR o/r#9 merged", PR9, 'merged']]);
  const partOf = { ...merged, partOf: true };
  assert.deepEqual((await decideOn(partOf, { triage: 1 })).map(s => [s.action, s.reason, s.pull]),
    [['triage', "its run's PR o/r#9 merged as part of it; asking a triage run", 'o/r#9']]);
  assert.deepEqual((await decideOn(partOf)).map(s => [s.action, s.reason]), [['skip', "its run's PR o/r#9 merged as part of it"]]);
  assert.deepEqual((await decideOn({ ...merged, outcome: 'open' })).map(s => [s.action, s.reason]), [['skip', 'PR open: o/r#9']]);
});

test('a recorded plan whose run failed is dispatched again with the reason, taking a slot, until the attempts run out', async () => {
  const steps = await decideOn(failed(1), { wip: 1 }, [issue(1), issue(2)]);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'retry', `plan ${RECORDED.plan}; attempt 2 of 3, as its run run77 ended without a merged PR: refused by check`],
    ['o/r#2', 'skip', 'work-in-progress cap of 1 reached'],
  ]);
  assert.deepEqual(steps[0].retry, { attempt: 2, of: 3, run: 'run77', runId: '77', reason: 'refused by check' });
  assert.equal(steps[0].found, RECORDED);
  assert.equal((await decideOn(failed(2)))[0].action, 'retry');
  const [capped] = await decideOn(failed(3));
  assert.deepEqual([capped.action, capped.reason], ['needs-human', '3 run(s) ended without a merged PR, the last run77: refused by check']);
  assert.equal((await decideOn(failed(2), { retries: 1 }))[0].action, 'needs-human');
  // A retry gets the checks a dispatch gets.
  const held = await decide([issue(1)], { ...empty, busy: new Map([['o/r#1', 'run78']]) }, caps(4, { retries: 2 }), () => RECORDED, noPulls,
    undefined, undefined, undefined, async () => failed(1));
  assert.match(held[0].reason, /in flight, run78/);
});

test("a run's open blocker is linked as blocked by, and the plan runs again once it closes", async () => {
  const blocker = open => failed(1, { blocker: { key: 'o/p#3', open, pull: false, id: 333 } });
  const [block] = await decideOn(blocker(true));
  assert.deepEqual([block.action, block.reason, block.blocker.id], ['block', 'its run run77 needs o/p#3; linking it as blocked by', 333]);
  // Linked, eligibility holds the item while it is open.
  const linked = metadata({ blockedBy: { nodes: [{ state: 'OPEN', url: 'https://github.com/o/p/issues/3' }], pageInfo: { hasNextPage: false } } });
  assert.equal(await eligibility(post(linked), 'o/r#1'), 'blocked by o/p#3');
  const [again] = await decideOn(blocker(false));
  assert.equal(again.action, 'retry');
  assert.match(again.reason, /refused by check; o\/p#3, which it needed, is closed now$/);
  // An open pull request cannot be linked: it is waited on.
  const [waits] = await decideOn(failed(1, { blocker: { key: 'o/p#4', open: true, pull: true, id: 444 } }));
  assert.deepEqual([waits.action, waits.reason], ['skip', 'its run run77 needs o/p#4, which is open']);
});

test('an issue labelled needs-human is not taken', async () => {
  const labelledHuman = metadata({ labels: { nodes: [{ name: 'needs-human' }], pageInfo: { hasNextPage: false } } });
  assert.equal(await eligibility(post(labelledHuman), 'o/r#1'), 'labelled needs-human');
});

test('the idle line counts how the recorded plans’ runs ended', () => {
  const steps = [{ action: 'skip', reason: 'PR open: o/r#9', outcome: 'open' }, { action: 'done', reason: 'x', outcome: 'merged' },
    { action: 'needs-human', reason: 'y', outcome: 'failed' }, { action: 'skip', reason: 'no plan' }];
  assert.equal(idleLine(steps, 2), 'idle: 2 slot(s) free and nothing started; skipped: PR open 1, no plan 1; recorded runs: open 1, merged 1, failed 1');
  assert.equal(idleLine([...steps, { action: 'retry', reason: 'z', outcome: 'failed' }], 2), null);
});

// main over the stubbed API, with retries on: the repository's own target, so
// the caller's job token's status comment counts.
const recordedMain = async (status, rest = {}, earlier = []) => {
  const dry = { method: 'POST', url: 'u', body: { ref: 'main', inputs: { task: 'Do it.', repo: EPICS, item: '41', kind: 'implement', pool: 'claude' } } };
  const bin = stub(`recorded-${Object.keys(rest).length}-${status.body.length}`, `process.stdout.write(${JSON.stringify(JSON.stringify(dry))}); `
    + `process.stderr.write('Dry run: request for the plan in https://github.com/${EPICS}/issues/41#issuecomment-42 by ${REPO_CONFIG.operator}; nothing was sent.\\n');`);
  const caller = REPO_CONFIG.dispatchRepo;
  const record = { id: 500, user: { login: REPO_CONFIG.bot }, created_at: '2026-10-14T10:00:05Z', html_url: 'rec',
    body: `<!-- agent-board-dispatch: 42@2026-10-14T10:00:00Z -->\nDispatched: [run](https://github.com/${caller}/actions/runs/77).` };
  const plan42 = { id: 42, user: { login: REPO_CONFIG.operator }, updated_at: '2026-10-14T10:00:00Z', created_at: '2026-10-14T10:00:00Z', body: 'plan' };
  return runMain(['--apply'], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(41)],
    [`/repos/${caller}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
    [`GET /repos/${EPICS}/issues/41/comments`]: [plan42, record, ...earlier, status],
    [`GET /repos/${caller}/actions/runs/77`]: { html_url: `https://github.com/${caller}/actions/runs/77`, display_title: `implement ${EPICS}#41 (claude)`, status: 'completed', conclusion: 'failure' },
    ...rest,
  }, { bin, schedule: { retries: 2 } });
};

test('with --apply, a failed run is dispatched again: a new record first, the old one freed, the brief with the reason', async () => {
  const caller = REPO_CONFIG.dispatchRepo;
  const DISPATCHES = `/repos/${caller}/actions/workflows/dispatch.yml/dispatches`;
  const status = statusOf(`❌ [dispatch](https://github.com/${caller}/actions/runs/77) refused by check: a secret-shaped string`, 'github-actions[bot]');
  const { out, sent, error } = await recordedMain(status, {
    [`POST /repos/${EPICS}/issues/41/comments`]: { id: 600, html_url: 'rec2', body: 'new record' },
    [`PATCH /repos/${EPICS}/issues/comments/500`]: {},
    [`POST ${DISPATCHES}`]: { workflow_run_id: 88 },
    [`PATCH /repos/${EPICS}/issues/comments/600`]: {},
  });
  assert.equal(error, undefined);
  assert.ok(out.some(line => /#41 .*retry: plan .*attempt 2 of 3, .*refused by check: a secret-shaped string$/.test(line)), out.join('\n'));
  assert.deepEqual(sent.map(([c]) => c), [`POST /repos/${EPICS}/issues/41/comments`, `PATCH /repos/${EPICS}/issues/comments/500`,
    `POST ${DISPATCHES}`, `PATCH /repos/${EPICS}/issues/comments/600`]);
  // The same plan's marker, so it stays held, and this job's retry line, which counts the attempt.
  assert.match(sent[0][1].body, /^<!-- agent-board-dispatch: 42@2026-10-14T10:00:00Z -->\n<!-- schedule-retry\/v1: 42 -->\n.*attempt 2 of 3, as its last run, 77,/);
  assert.ok(!sent[0][1].body.includes('actions/runs/77'));
  assert.ok(!sent[1][1].body.includes('agent-board-dispatch'));
  const { ref, inputs, return_run_details: details } = sent[2][1];
  assert.deepEqual([ref, details, inputs.repo, inputs.item, inputs.kind, inputs.pool], ['main', true, EPICS, '41', 'implement', 'claude']);
  assert.match(inputs.task, /^Do it\.\n\nThis is attempt 2 of 3\. The last run, .*runs\/77, ended without a merged pull request; its status: ❌ dispatch refused by check: a secret-shaped string$/);
  assert.equal(sent[3][1].body, `new record [run](https://github.com/${caller}/actions/runs/88).`);
});

test('with --apply, a merged run closes the issue, linking its pull request', async () => {
  const caller = REPO_CONFIG.dispatchRepo;
  const pr = `https://github.com/${EPICS}/pull/9`;
  const status = statusOf(`✅ [dispatch](https://github.com/${caller}/actions/runs/77) ended well and opened pull request #9. Result: ${pr}`, REPO_CONFIG.bot);
  const merged = await recordedMain(status, {
    [`GET /repos/${caller}/actions/runs/77`]: { html_url: `https://github.com/${caller}/actions/runs/77`, display_title: `implement ${EPICS}#41`, status: 'completed', conclusion: 'success' },
    [`GET /repos/${EPICS}/pulls/9`]: { user: { login: REPO_CONFIG.bot }, html_url: pr, merged_at: 't', state: 'closed', body: 'Done.' },
    [`PATCH /repos/${EPICS}/issues/41`]: {},
    [`POST /repos/${EPICS}/issues/41/comments`]: { id: 1 },
  });
  assert.equal(merged.error, undefined);
  assert.deepEqual(merged.sent.map(([c]) => c), [`PATCH /repos/${EPICS}/issues/41`, `POST /repos/${EPICS}/issues/41/comments`]);
  assert.match(merged.sent[1][1].body, new RegExp(`^<!-- schedule-outcome/v1-closed: 77 -->\n.*merged: ${pr}\\.`));
});

test("with --apply, at the cap the issue is labelled needs-human, and nothing is dispatched", async () => {
  const caller = REPO_CONFIG.dispatchRepo;
  const status = statusOf(`❌ [dispatch](https://github.com/${caller}/actions/runs/77) failed (agent, check, apply: failure/skipped/skipped).`, REPO_CONFIG.bot);
  const freed = n => ({ user: { login: REPO_CONFIG.bot }, created_at: '2026-10-15T00:00:00Z', body: `<!-- schedule-retry/v1: 42 -->\nfreed ${n}` });
  const { out, sent, error } = await recordedMain(status, { [`POST /repos/${EPICS}/issues/41/labels`]: [] }, [freed(1), freed(2)]);
  assert.equal(error, undefined);
  assert.ok(out.some(line => /#41 .*needs-human: 3 run\(s\) ended without a merged PR/.test(line)), out.join('\n'));
  assert.deepEqual(sent, [[`POST /repos/${EPICS}/issues/41/labels`, { labels: ['needs-human'] }]]);
});

test('schedule.fill is off unless set, bounded, and needs triage', () => {
  const base = { operator: 'op', bot: BOT, dispatchRepo: 'o/t', source: 'https://github.com/o/agent-board', branch: 'main' };
  const parse = extra => loadConfig(JSON.stringify({ ...base, schedule: { owner: 'o', project: 1, wip: 4, repositories: ['o/r'], triage: 1, ...extra } }));
  assert.equal(parse({}).fill, 0);
  assert.equal(parse({ fill: 20 }).fill, 20);
  for (const fill of [-1, 21, '2', 1.5]) assert.throws(() => parse({ fill }), /schedule.fill must be/);
  assert.throws(() => parse({ fill: 2, triage: 0 }), /schedule.fill needs schedule.triage/);
});

const WEEK_MS = 7 * 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-16T21:45:00Z');
// A snapshot of the weekly window with `gone` of it elapsed at NOW.
const usageAt = (used, gone, extra = {}, updated = NOW) => ({ schema: 'bot-usage/v1', updated_at: new Date(updated).toISOString(),
  pools: { claude: { used_percent: used, window_minutes: WEEK_MS / 60000, resets_at: new Date(NOW + (1 - gone) * WEEK_MS).toISOString(), observed_at: new Date(NOW - 3600 * 1000).toISOString(), target_percent: 95, hold: false, ...extra } } });

test('fill mode is a pool used less than its pace allows, and nothing it does not know', () => {
  // With 56% of the week gone, a target of 95% allows 53.2%.
  assert.deepEqual(paceMode(usageAt(50, 0.56), 'claude', NOW), { fill: true, mode: 'fill (claude 50% used, pace allows 53%)' });
  // The poll of the issue, 54% used: under the window gone, but over the pace.
  assert.deepEqual(paceMode(usageAt(54, 0.56), 'claude', NOW), { fill: false, mode: 'normal (claude 54% used, pace allows 53%)' });
  assert.deepEqual(paceMode(usageAt(54, 0.56, { target_percent: 100 }), 'claude', NOW), { fill: true, mode: 'fill (claude 54% used, pace allows 56%)' });
  assert.equal(paceMode(usageAt(50, 0.56, { hold: true }), 'claude', NOW).mode, 'normal (claude 50% used, pace allows 53%, held)');
  // Not known: no snapshot, another pool, a stale snapshot, a window reset since.
  for (const [snap, pool, why] of [[null, 'claude', /no usage reading of the claude pool/], [usageAt(10, 0.5), 'mistral', /no usage reading of the mistral pool/],
    [usageAt(10, 0.5, {}, NOW - 4 * 3600 * 1000), 'claude', /the usage snapshot is from /], [usageAt(10, 1.01), 'claude', /no current window/],
    [usageAt(10, 0.5, { resets_at: 'soon' }), 'claude', /no current window/], [usageAt(10, 0.5, { target_percent: undefined }), 'claude', /no current window/],
    // A carried reading the broker has not renewed for over a day, or none.
    [usageAt(10, 0.5, { observed_at: new Date(NOW - 31 * 3600 * 1000).toISOString() }), 'claude', /no reading of the claude pool observed in the last day, the last at /],
    [usageAt(10, 0.5, { observed_at: undefined }), 'claude', /no reading of the claude pool observed in the last day\)$/]]) {
    const pace = paceMode(snap, pool, NOW);
    assert.equal(pace.fill, false);
    assert.match(pace.mode, why);
  }
});

test("in fill mode the coordinator's planning interval is an hour, if that is shorter", () => {
  assert.equal(planInterval(180 * 60000, { fill: true }), 60 * 60000);
  assert.equal(planInterval(30 * 60000, { fill: true }), 30 * 60000);
  assert.equal(planInterval(180 * 60000, { fill: false }), 180 * 60000);
  assert.equal(planInterval(180 * 60000, null), 180 * 60000);
});

// An issue as FILL_QUERY answers it, opened by `login`, on board 1 of o.
const openIssue = (number, login, extra = {}, board = {}) => ({ number, url: `https://github.com/o/r/issues/${number}`, body: 'b', createdAt: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z`,
  author: { login }, parent: null, labels: { nodes: [], pageInfo: { hasNextPage: false } },
  projectItems: { nodes: [{ project: { number: 1, owner: { login: 'o' } }, status: { name: board.status ?? 'Todo' }, priority: board.priority ? { name: board.priority } : null }] }, ...extra });
const FILL_CONFIG = { operator: 'op', planner: BOT, owner: 'o', project: 1, fill: 3 };

test("fill mode's candidates are the operator's and bot's unparented issues, by board priority, then age, at most schedule.fill", () => {
  const nodes = [
    openIssue(1, 'op'), openIssue(2, BOT, {}, { priority: 'P1' }), openIssue(3, 'op', {}, { priority: 'P0' }), openIssue(4, 'OP'),
    // A stranger's, a child's, one held for a person, one with labels past a page, one the epics gave.
    openIssue(5, 'visitor', {}, { priority: 'P0' }), openIssue(6, 'op', { parent: { number: 9 } }),
    openIssue(7, 'op', { labels: { nodes: [{ name: 'Needs-Design' }], pageInfo: { hasNextPage: false } } }),
    openIssue(8, 'op', { labels: { nodes: [{ name: 'needs-human' }], pageInfo: { hasNextPage: false } } }),
    openIssue(9, 'op', { labels: { nodes: [], pageInfo: { hasNextPage: true } } }), openIssue(10, 'op', {}, { priority: 'P0' }),
    // Only issues on this board: one on another board, or none, is a control issue or not tracked.
    openIssue(11, 'op', { projectItems: { nodes: [{ project: { number: 2, owner: { login: 'o' } }, priority: { name: 'P0' } }] } }),
    openIssue(12, BOT, { projectItems: { nodes: [] } }),
  ];
  const items = fillItems([{ repository: 'o/r', nodes }], { ...FILL_CONFIG, fill: 5 }, new Set(['o/r#10']));
  assert.deepEqual(items.map(i => [i.number, i.priority ?? null]), [[3, 'P0'], [2, 'P1'], [1, null], [4, null]]);
  assert.ok(items.every(i => i.fill && i.content_kind === 'issue' && i.repository === 'o/r'));
  assert.equal(fillItems([{ repository: 'o/r', nodes }], FILL_CONFIG, new Set()).length, 3);
});

test("epics, questions and the status issue take none of fill mode's places", () => {
  const label = name => ({ labels: { nodes: [{ name }], pageInfo: { hasNextPage: false } } });
  // Epics and the status issue are the operator's, on the board, unparented, and ranked ahead.
  const nodes = [openIssue(10, 'op', label('epic'), { priority: 'P1' }), openIssue(11, 'op', label('Epic'), { priority: 'P2' }),
    openIssue(12, 'op', label('question'), { priority: 'P0' }), openIssue(13, 'op', {}, { priority: 'P0' }), openIssue(14, BOT, {}, { priority: 'P0' }),
    openIssue(20, 'op'), openIssue(21, BOT)];
  // As main gives it: the census's epics (13) and the status issue (14).
  const items = fillItems([{ repository: 'o/r', nodes }], { ...FILL_CONFIG, fill: 2 }, new Set(['o/r#13', 'o/r#14']));
  assert.deepEqual(items.map(i => i.number), [20, 21]);
});

test("a plan under review, assigned to the operator and labelled needs-human, takes no fill place, nor once approved", () => {
  const labels = names => ({ labels: { nodes: names.map(name => ({ name })), pageInfo: { hasNextPage: false } }, assignees: { nodes: [{ login: 'op' }] } });
  const nodes = [openIssue(30, 'op', labels(['needs-human']), { priority: 'P0' }), openIssue(31, 'op', labels(['needs-human', 'epic']), { priority: 'P0' }), openIssue(32, 'op')];
  assert.deepEqual(fillItems([{ repository: 'o/r', nodes }], FILL_CONFIG, new Set()).map(i => i.number), [32]);
});

test('in fill mode an issue outside any epic is asked of a triage run first, and goes on once answered not done', async () => {
  const fresh = issue(1, { fill: true, body: 'x'.repeat(300) });
  const answered = issue(2, { fill: true });
  const done = issue(3, { fill: true });
  const verdicts = { 1: null, 2: { verdict: 'not-done', url: 'q2' }, 3: { verdict: 'done', url: 'q3', evidence: 'e3', request: 'r3' } };
  const steps = await decide([fresh, answered, done], empty, caps(4, { triage: 2, filling: true }), own, noPulls, async () => null, async () => {},
    async item => verdicts[item.number]);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.reason]), [
    ['o/r#1', 'triage', 'outside any epic; asking a triage run'],
    ['o/r#2', 'dispatch', 'plan https://github.com/o/r/issues/1#issuecomment-5'],
    ['o/r#3', 'close', 'triage found it done, e3'],
  ]);
  // An epic's sub-issue is taken before them, whatever their priority.
  const order = await decide([issue(4, { fill: true, priority: 'P0' }), issue(5, { priority: 'P3' })], empty, caps(4, { filling: true }), own, noPulls,
    async () => null, async () => {}, async () => ({ verdict: 'partly' }));
  assert.deepEqual(order.map(s => s.item), ['o/r#5', 'o/r#4']);
});

test('in fill mode a triage or research plan is dispatched, alone, out of the triage budget; otherwise by hand', async () => {
  const items = [issue(1), issue(2), issue(3), issue(4)];
  const kinds = { 1: 'triage', 2: 'research', 3: 'review', 4: 'triage' };
  const probe = item => own(item) && { ...own(item), kind: kinds[item.number], extras: ['o/r#9'] };
  const steps = await decide(items, empty, caps(8, { triage: 2, filling: true }), probe, noPulls);
  assert.deepEqual(steps.map(s => [s.item, s.action, s.batch]), [['o/r#1', 'dispatch', false], ['o/r#2', 'dispatch', false], ['o/r#3', 'skip', undefined], ['o/r#4', 'skip', undefined]]);
  assert.match(steps[0].reason, /, for triage$/);
  assert.match(steps[2].reason, /is for review, which is dispatched by hand$/);
  assert.match(steps[3].reason, /is for triage; the triage limit of 2 a pass is reached$/);
  // Not in fill mode, each is a person's, as before.
  const normal = await decide(items, empty, caps(8, { triage: 2 }), probe, noPulls);
  assert.ok(normal.every(s => s.action === 'skip' && /dispatched by hand$/.test(s.reason)));
});

test('with a mode, the idle line says it, and a pass that started something how many slots it filled', () => {
  const started = [{ item: 'o/r#1', action: 'dispatch', reason: 'plan' }, { item: 'o/r#2', action: 'triage', reason: 'x' }, { item: 'o/r#3', action: 'skip', reason: 'no plan' }];
  assert.equal(idleLine(started, 8, 'fill (claude 50% used, pace allows 53%)'), 'filled: 2 of 8 free slot(s); mode: fill (claude 50% used, pace allows 53%)');
  assert.equal(idleLine(started, 8), null);
  assert.equal(idleLine(started, 0, 'fill (x)'), null);
  assert.equal(idleLine([{ item: 'o/r#3', action: 'skip', reason: 'no plan' }], 3, 'normal (y)'), 'idle: 3 slot(s) free and nothing started; mode: normal (y); skipped: no plan 1');
});

// main in fill mode: the one live epic's work is exhausted (its sub-issue has
// the bot's pull request open), and two unparented issues of the operator's
// and the bot's are open, among others that are not taken. #50 is asked of a
// triage run; #51's run answered not done, so its plan is dispatched.
const usageConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'usage', 'config.json'), 'utf8'));
const snapIso = ms => new Date(ms).toISOString();
async function fillMain(used) {
  const now = Date.now();
  const snap = { schema: 'bot-usage/v1', updated_at: new Date(now).toISOString(), pools: { claude: {
    used_percent: used, window_minutes: WEEK_MS / 60000, resets_at: new Date(now + 0.44 * WEEK_MS).toISOString(), observed_at: snapIso(now), target_percent: 95, hold: false } } };
  const usageComment = { databaseId: 7, updatedAt: snap.updated_at, body: render(snap, 'test'), author: { login: usageConfig.bot } };
  const at = (number, login, extra = {}) => ({ ...openIssue(number, login, extra), url: `https://github.com/${EPICS}/issues/${number}` });
  const nodes = [
    at(50, REPO_CONFIG.operator, { body: 'Make the thing do the other thing. '.repeat(10), createdAt: '2026-09-01T00:00:00Z' }),
    at(51, REPO_CONFIG.bot, { createdAt: '2026-08-01T00:00:00Z' }),
    at(52, 'visitor'), at(53, REPO_CONFIG.operator, { parent: { number: 1 } }),
    at(54, REPO_CONFIG.operator, { labels: { nodes: [{ name: 'needs-design' }], pageInfo: { hasNextPage: false } } }),
  ];
  // All on the configured board; #50 is P1 there, #51 older with no Priority.
  const board = { project: { number: REPO_CONFIG.schedule.project, owner: { login: REPO_CONFIG.schedule.owner } }, status: { name: 'Todo' } };
  for (const n of nodes) n.projectItems.nodes = [board];
  nodes[0].projectItems.nodes = [{ ...board, priority: { name: 'P1' } }];
  // The live epic and the coordinator's status issue: the operator's, unlabelled, on the board ahead of both.
  for (const n of [1, REPO_CONFIG.coordinator.statusIssue]) nodes.push({ ...at(n, REPO_CONFIG.operator), projectItems: { nodes: [{ ...board, priority: { name: 'P0' } }] } });
  // The supervisor's requests issue, say: the operator's, on no board.
  nodes.push({ ...at(55, REPO_CONFIG.operator), projectItems: { nodes: [] } });
  const fillReads = [];
  const graphql = (query, variables) => {
    if (query === FILL_QUERY) {
      fillReads.push(`${variables.owner}/${variables.name}`);
      return { data: { repository: { issues: { nodes: `${variables.owner}/${variables.name}` === EPICS ? nodes : [] } } } };
    }
    if (query.includes('comments(') && `${variables.owner}/${variables.name}` === usageConfig.repo && variables.number === usageConfig.issue) {
      return { data: { repository: { issue: { comments: { nodes: [usageComment], pageInfo: { hasNextPage: false } } } } } };
    }
    return undefined;
  };
  // A dry run that finds an implement plan on whichever issue it is given.
  const bin = stub(`fill-plan-${used}`, `const n = /(\\d+)$/.exec(process.argv[3])[1];
process.stdout.write(JSON.stringify({ body: { ref: 'main', inputs: { repo: '${EPICS}', item: n, kind: 'implement', task: 'Do it.' } } }));
process.stderr.write('Dry run: request for the plan in https://github.com/${EPICS}/issues/' + n + '#issuecomment-' + n + '0 by ${REPO_CONFIG.operator}; nothing was sent.\\n');`);
  const question = { id: 1, user: { login: REPO_CONFIG.bot }, created_at: '2026-10-15T00:00:00Z', html_url: 'q51', body: '<!-- schedule-triage/v1: {"request":"r51"} -->\nasked' };
  const answer = { id: 2, user: { login: REPO_CONFIG.bot }, created_at: '2026-10-15T01:00:00Z', html_url: 'a51', body: 'Not done.\n```schedule-triage\n{"request":"r51","verdict":"not-done"}\n```' };
  const result = await runMain([], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(41)],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [{ user: { login: REPO_CONFIG.bot }, body: `Refs ${EPICS}#41`, html_url: `https://github.com/${EPICS}/pull/60`, base: { repo: { full_name: EPICS } } }],
    [`GET /repos/${EPICS}/issues/50/comments`]: [],
    [`GET /repos/${EPICS}/issues/51/comments`]: [question, answer],
  }, { bin, graphql, schedule: { fill: 3 } });
  return { ...result, fillReads };
}

test('fill mode: with the epics exhausted, the two unparented issues fill free slots, a triage run first', async () => {
  const { out, error, fillReads } = await fillMain(40);
  assert.equal(error, undefined, out.join('\n'));
  const mode = 'fill (claude 40% used, pace allows 53%)';
  assert.deepEqual(out.filter(l => !/ open sub-issue\(s\) of /.test(l)), [
    `[dry-run] mode: ${mode}; 2 issue(s) outside any epic, taken after the epics' by board Priority, then age`,
    `[dry-run] ${EPICS}#41 (epic ${EPICS}#1) skip: a pull request is open, https://github.com/${EPICS}/pull/60`,
    `[dry-run] ${EPICS}#50 (outside any epic) triage: outside any epic; asking a triage run`,
    `[dry-run] ${EPICS}#51 (outside any epic) dispatch: plan https://github.com/${EPICS}/issues/51#issuecomment-510`,
    `[dry-run] filled: 2 of ${REPO_CONFIG.schedule.wip} free slot(s); mode: ${mode}`,
  ]);
  // Every scheduled repository is read, once.
  assert.deepEqual(fillReads.sort(), [...REPO_CONFIG.schedule.repositories].map(r => r.toLowerCase()).sort());
});

test('over pace, no issue outside an epic is read, and the idle line says the mode', async () => {
  const { out, error, fillReads } = await fillMain(70);
  assert.equal(error, undefined, out.join('\n'));
  assert.deepEqual(fillReads, []);
  const mode = 'normal (claude 70% used, pace allows 53%)';
  assert.equal(out[0], `[dry-run] mode: ${mode}`);
  assert.equal(out.at(-1), `[dry-run] idle: ${REPO_CONFIG.schedule.wip} slot(s) free and nothing started; mode: ${mode}; skipped: a pull request is open 1`);
});

test("a fill-mode triage run's task says the issue is outside any epic", () => {
  const task = triageTask({ planDocs: 'https://x/docs' }, { url: 'https://github.com/o/r/issues/1', fill: true }, 'r1');
  assert.match(task, /outside any epic/);
  assert.ok(!task.includes('no accepted job plan'));
});
