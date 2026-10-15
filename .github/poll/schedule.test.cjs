// node --test .github/poll/schedule.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { agentBoard, candidates, decide, eligibility, findRecord, loadConfig, main, openPullRefs, probePlan, readDryRun, readRefusal, readRuns } = require('./schedule.cjs');
const { census } = require('./epics.cjs');

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
  subIssues: { totalCount: 0 }, closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } }, ...extra });
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
async function runMain(args, rest, { board = [], bin = path.join(stubDir, 'missing'), issues = {} } = {}) {
  const calls = [];
  const out = [];
  const saved = { fetch: globalThis.fetch, log: console.log, GH_TOKEN: process.env.GH_TOKEN, AGENT_BOARD: process.env.AGENT_BOARD };
  globalThis.fetch = async (u, init) => {
    const p = u.replace('https://api.github.com', '').replace(/[?&]per_page=100&page=1$/, '');
    calls.push(`${init?.method ?? 'GET'} ${p}`);
    let body;
    if (p === '/graphql') {
      const { query, variables } = JSON.parse(init.body);
      body = query.includes('projectV2')
        ? board === null ? { errors: [{ message: 'Could not resolve to a ProjectV2' }] } : { data: { repositoryOwner: { projectV2: { items: { nodes: board, pageInfo: { hasNextPage: false } } } } } }
        : query.includes('closedByPullRequestsReferences')
          ? { data: { repository: { issue: issues[variables.number] ?? metadata() } } }
          : { data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
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
  let error;
  try {
    await main(args);
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = saved.fetch;
    console.log = saved.log;
    for (const k of ['GH_TOKEN', 'AGENT_BOARD']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return { out, calls, error };
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
  assert.deepEqual(calls, [`GET ${LIST}`, `GET /repos/${EPICS}/issues/2/timeline`]);
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
  }, { bin: NO_PLAN_BIN, board: [{ status: { name: 'Todo' }, priority: { name: 'P1' }, content: { url: sub.html_url } }] });
  assert.equal(error, undefined);
  assert.equal(out.length, 2);
  assert.match(out[0], /^\[dry-run\] 1 open sub-issue\(s\) of 1 live epic\(s\), taken by their epic's Priority/);
  assert.equal(out[1], `[dry-run] ${EPICS}#40 (epic ${EPICS}#1) skip: no plan`);
});

test('with --apply, items with no plan or a merged closer start nothing', async () => {
  const NO_PLAN_BIN = stub('no-plan-apply', "process.stderr.write('error: no plan on this issue from an accepted writer\\n'); process.exit(1);");
  const merged = metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'merged-pr' }], pageInfo: { hasNextPage: false } } });
  const { out, calls, error } = await runMain(['--apply'], {
    [LIST]: [epicIssue(1)],
    [`/repos/${EPICS}/issues/1/timeline`]: labelled(REPO_CONFIG.operator),
    [`/repos/${EPICS}/issues/1/sub_issues`]: [epicIssue(40), epicIssue(41)],
    [`/repos/${REPO_CONFIG.dispatchRepo}/actions/workflows/dispatch.yml/runs?per_page=100`]: { workflow_runs: [] },
    [`/repos/${EPICS}/pulls?state=open`]: [],
  }, { bin: NO_PLAN_BIN, issues: { 41: merged } });
  assert.equal(error, undefined);
  assert.ok(out.some(line => /#40 .*skip: no plan$/.test(line)));
  assert.ok(out.some(line => /#41 .*skip: probably done; close it\? merged-pr$/.test(line)));
  assert.ok(calls.every(c => !c.startsWith('POST ') || c === 'POST /graphql'));
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
  ['done by a merged pull request', metadata({ closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'merged-pr' }], pageInfo: { hasNextPage: false } } }), /probably done; close it\? merged-pr/],
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
