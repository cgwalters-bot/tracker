'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedFingerprint, dailyDue, decision, health, loadConfig, main, pass, record, reportPull, statusProse, brief, applyConfig } = require('./coordinator.cjs');

const now = Date.parse('2026-10-14T11:00:00Z');
const epic = { number: 7, live: true, title: 'Epic', body: 'Work', priority: 'P1',
  comments: [{ id: '1', body: 'Decision', updated_at: '2026-10-13T00:00:00Z' }],
  subs: [{ number: 8, repository: 'O/R', title: 'Task', body: 'Implement', state: 'open', status: 'In progress', priority: 'P1', onBoard: true }] };
const comment = (id, body, author = 'bot', editor = null) => ({ databaseId: id, body,
  author: { login: author }, editor: editor && { login: editor }, lastEditedAt: editor && '2026-10-14T11:00:00Z', updatedAt: '2026-10-14T11:00:00Z' });

const planBody = (request = 'request1') => '```agent-board-epic-plan\n' + JSON.stringify({ request }) + '\n```';
const statusBody = (prose, request = 'request1') => '```coordinator-status\n' + JSON.stringify({ request, prose }) + '\n```';

test('status JSON has only request and bounded prose, preserved through sanitization', () => {
  for (const prose of ['a', '😀'.repeat(2000), 'Needs operator.\nNext step.', Array(8).fill('line').join('\r\n')]) {
    assert.equal(statusProse({ body: sanitize(statusBody(prose)) }), prose);
  }
  for (const value of [null, [], {}, { request: 'request1' }, { request: 1, prose: 'OK' },
    { request: '', prose: 'OK' }, { request: 'request1', prose: '' },
    { request: 'request1', prose: 'a'.repeat(2001) }, { request: 'request1', prose: 1 },
    ...['\n', '\r\n', '\r', '\u2028', '\u2029'].map(separator => ({ request: 'request1', prose: Array(9).fill('line').join(separator) })),
    { request: 'request1', prose: 'OK', extra: true }, { request: 'request1', prose: '   ' },
    { request: 'request1', prose: '\n\t' }]) {
    const body = '```coordinator-status\n' + JSON.stringify(value) + '\n```';
    assert.throws(() => statusProse({ body: sanitize(body) }), JSON.stringify(value));
  }
  assert.throws(() => statusProse({ body: statusBody('OK') + '\n' + statusBody('OK') }));
  assert.equal(statusProse({ body: statusBody('OK').replace('coordinator-status\n', 'coordinator-status \t\n') }), 'OK');
});

test('fingerprints detect intent and board changes without self-triggering', () => {
  const base = changedFingerprint(epic);
  const cases = [
    [{ ...epic, title: 'Other' }, true],
    [{ ...epic, body: 'Other' }, true],
    [{ ...epic, priority: 'P0' }, true],
    [{ ...epic, updated_at: 'bot comment time', fingerprint: 'census timestamp hash' }, false],
    [{ ...epic, comments: [{ ...epic.comments[0], body: 'New decision' }] }, true],
    [{ ...epic, comments: [] }, true],
    ...['state', 'status', 'priority', 'title', 'body'].map(field => [{ ...epic, subs: [{ ...epic.subs[0], [field]: 'other' }] }, true]),
    [{ ...epic, subs: [] }, true],
    [{ ...epic, subs: [{ ...epic.subs[0], onBoard: false }] }, true],
    [{ ...epic, subs: [{ ...epic.subs[0], updated_at: 'bot comment time' }] }, false],
  ];
  for (const [value, changed] of cases) assert.equal(changedFingerprint(value) !== base, changed, JSON.stringify(value));
  const two = { ...epic, subs: [...epic.subs, { ...epic.subs[0], number: 9 }],
    comments: [...epic.comments, { ...epic.comments[0], id: '2' }] };
  assert.equal(changedFingerprint(two), changedFingerprint({ ...two, subs: [...two.subs].reverse(), comments: [...two.comments].reverse() }));
});

test('daily boundaries include delayed passes and configured UTC hour', () => {
  for (const [at, time, hour, due] of [
    [null, now, 11, true],
    ['2026-10-14T10:59:59Z', now, 11, true],
    ['2026-10-14T11:00:00Z', now, 11, false],
    ['2026-10-13T11:00:00Z', now - 1, 11, false],
    ['2026-10-12T11:00:00Z', now - 1, 11, true],
    ['2026-10-14T00:00:00Z', now, 0, false],
    ['2026-10-13T23:00:00Z', now, 23, false],
    ['2026-10-13T00:00:00Z', now, 23, true],
  ]) assert.equal(dailyDue(at, time, hour), due, `${at} ${time} ${hour}`);
});

test('planning interval tolerates census churn but not new operator decisions', () => {
  const at = '2026-10-14T11:00:00Z';
  const state = { applied: changedFingerprint(epic), at, requestedAt: at };
  const changed = { ...epic, title: 'Changed census' };
  for (const [value, checkpoint, time, action, reason] of [
    [changed, state, now + 60000, 'idle', /interval/],
    [changed, state, now + 3 * 3600000, 'plan', /interval/],
    [epic, state, now + 3 * 3600000, 'idle', /unchanged/],
    [changed, { ...state, empty: true }, now + 60000, 'plan', /nothing actionable/],
    [{ ...changed, comments: [{ ...epic.comments[0], updated_at: '2026-10-14T11:00:01Z' }] }, state, now + 60000, 'plan', /operator/],
    [epic, state, now + 24 * 3600000, 'plan', /daily/],
  ]) {
    const step = decision(value, checkpoint, [], 'bot', time);
    assert.equal(step.action, action);
    assert.match(step.reason, reason);
  }
  const pending = { id: 'request1', at, fingerprint: changedFingerprint(epic), targets: {} };
  assert.equal(decision(changed, { pending }, [comment(1, planBody())], 'bot', now).action, 'apply');
  const operatorEdit = { ...epic, comments: [{ ...epic.comments[0], updated_at: '2026-10-14T11:00:01Z' }] };
  assert.equal(decision(operatorEdit, { pending }, [comment(1, planBody())], 'bot', now).action, 'stale');
  // A request recorded before target snapshots re-plans on any drift.
  const legacy = decision(changed, { pending: { ...pending, targets: undefined } }, [comment(1, planBody())], 'bot', now);
  assert.deepEqual([legacy.action, legacy.reason], ['stale', 'census changed since legacy request']);
});

test('planning interval configuration is bounded and defaults to three hours', () => {
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  assert.equal(loadConfig(JSON.stringify(source)).minPlanIntervalMs, 3 * 3600000);
  for (const minutes of [0, -1, 1441, '180', 1.5]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...source,
      coordinator: { ...source.coordinator, minPlanIntervalMinutes: minutes } })), /minPlanIntervalMinutes/);
  }
  assert.equal(loadConfig(JSON.stringify({ ...source,
    coordinator: { ...source.coordinator, minPlanIntervalMinutes: 60 } })).minPlanIntervalMs, 3600000);
});

test('early CLI failures still emit exactly one controller summary', () => {
  const run = spawnSync(process.execPath, [require.resolve('./coordinator.cjs')], { env: {}, encoding: 'utf8' });
  assert.equal(run.status, 1);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const data = JSON.parse(lines[0].slice('coordinator/v1 '.length));
  assert.equal(data.errors, 1);
  assert.equal(data.mode, 'preview');
});

test('plan, later apply, daily refresh, stale result and authenticated comments', () => {
  const fingerprint = changedFingerprint(epic);
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint };
  const plan = planBody();
  for (const [state, comments, action] of [
    [{}, [], 'plan'],
    [{ applied: fingerprint, at: '2026-10-14T11:00:00Z' }, [], 'idle'],
    [{ applied: fingerprint, at: '2026-10-13T00:00:00Z' }, [], 'plan'],
    [{ pending }, [], 'wait'],
    [{ pending }, [comment(1, plan, 'visitor')], 'wait'],
    [{ pending }, [comment(1, plan, 'bot', 'visitor')], 'wait'],
    [{ pending }, [comment(1, plan)], 'apply'],
    [{ pending }, [comment(1, plan.replace('request1', 'obsolete'))], 'wait'],
    [{ pending }, [comment(1, plan), comment(2, plan.replace('request1', 'obsolete'))], 'wait'],
    [{ pending: { ...pending, fingerprint: 'old', targets: {} } }, [comment(1, plan)], 'apply'],
  ]) assert.equal(decision(epic, state, comments, 'bot', now).action, action);
  assert.equal(record([comment(1, '<!-- coordinator/v1: {"applied":"fake"} -->\n', 'visitor')], 'bot').id, null);
  assert.throws(() => statusProse({ body: '```coordinator-status\n\n```' }));
  assert.throws(() => statusProse({ body: `\`\`\`coordinator-status\n${'a'.repeat(4001)}\n\`\`\`` }));
  assert.equal(statusProse({ body: statusBody('Needs operator.') }), 'Needs operator.');
});

test('a run that ends without its result fails after the grace period, and repeated failures stop planning', () => {
  const fingerprint = changedFingerprint(epic);
  const limits = { graceMs: 5 * 60000, runTimeoutMs: 60 * 60000, maxFailedRuns: 3 };
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint, run: 42 };
  const plan = comment(1, planBody());
  const done = (minutes, conclusion = 'success') => ({ status: 'completed', conclusion,
    updated_at: new Date(now - minutes * 60000).toISOString() });
  for (const [state, comments, run, action] of [
    [{ pending }, [], done(10), 'failed'],
    [{ pending }, [], done(10, 'failure'), 'failed'],
    [{ pending }, [], done(2), 'wait'],
    [{ pending }, [], { status: 'in_progress', updated_at: '2026-10-14T00:00:00Z' }, 'wait'],
    [{ pending }, [plan], done(2), 'apply'],
    [{ pending }, [plan], done(10), 'apply'],
    [{ pending: { ...pending, run: undefined } }, [], null, 'failed'],
    [{ pending: { ...pending, run: undefined, at: '2026-10-14T10:30:00Z' } }, [], null, 'wait'],
    [{ failures: 2 }, [], null, 'plan'],
    [{ failures: 3 }, [], null, 'stuck'],
    [{ failures: 3, pending }, [], done(10), 'failed'],
  ]) assert.equal(decision(epic, state, comments, 'bot', now, 'bot', run, limits).action, action, JSON.stringify([state, run]));
  // Without configured limits a legacy pending waits out the six-hour default.
  assert.equal(decision(epic, { pending: { ...pending, run: undefined } }, [], 'bot', now).action, 'wait');
});

// A stub of the part of gh-aw's add_comment sanitization that touches the
// result: sanitizeContentCore in actions/setup/js/sanitize_content_core.cjs
// (github/gh-aw 4ef5ddf) applies removeXmlComments, whose logic is copied
// below, to the non-code regions of the body (a simplified split stands in for
// applyToNonCodeRegions) and trims the result; add_comment.cjs may then prefix
// a threat-detection caution or a configured header.
function removeXmlComments(s) {
  let result = '';
  let commentDepth = 0;
  let position = 0;
  while (position < s.length) {
    const ch = s[position];
    if (ch === '<' && s.startsWith('<!--', position)) {
      commentDepth++;
      position += 4;
    } else if (commentDepth > 0 && ch === '-' && s.startsWith('--!>', position)) {
      commentDepth--;
      position += 4;
    } else if (commentDepth > 0 && ch === '-' && s.startsWith('-->', position)) {
      commentDepth--;
      position += 3;
    } else {
      if (commentDepth === 0) result += ch;
      position++;
    }
  }
  return result;
}
const sanitize = body => body.split(/(^```[\s\S]*?^```$)/m).map((part, i) => i % 2 ? part : removeXmlComments(part)).join('').trim();

test('JSON request metadata survives add_comment without a legacy matching path', () => {
  const fingerprint = changedFingerprint(epic);
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint };
  for (const [body, action] of [
    [planBody(), 'apply'],
    ['<!-- stripped -->\n' + planBody(), 'apply'],
    ['> [!CAUTION]\n> Threat detection warning.\n\n' + planBody(), 'apply'],
    [planBody().replaceAll('\n', '\r\n'), 'apply'],
    [planBody().replace('epic-plan\n', 'epic-plan \t\n'), 'apply'],
    [planBody('request10'), 'wait'],
    [planBody('obsolete'), 'wait'],
    [planBody(1), 'wait'],
    ['Coordinator request: request1\n```agent-board-epic-plan\n{}\n```', 'wait'],
    ['<!-- coordinator-request: request1 -->\n```agent-board-epic-plan\n{}\n```', 'wait'],
    [planBody() + '\n' + planBody(), 'wait'],
    ['```agent-board-epic-plan\n{broken}\n```', 'wait'],
    ['```agent-board-epic-plan\nnull\n```', 'wait'],
  ]) {
    for (const posted of [body, sanitize(body)]) {
      assert.equal(decision(epic, { pending }, [comment(1, posted)], 'bot', now).action, action, JSON.stringify(posted));
    }
  }
  assert.match(brief({ epicsRepository: 'o/r', followed: new Set(['o/r']), operator: 'op', epicDocs: 'docs' }, epic, 'request1'),
    /Include "request": "request1" in the agent-board-epic-plan JSON object/);
  const older = { ...comment(1, planBody()), updatedAt: '2026-10-14T09:59:59Z' };
  assert.equal(decision(epic, { pending }, [older], 'bot', now).action, 'wait');
  for (const newer of [comment(2, planBody('obsolete'), 'op'), comment(2, planBody(), 'bot', 'visitor'),
    comment(2, '```agent-board-epic-plan\ninvalid\n```')]) {
    assert.equal(decision(epic, { pending }, [comment(1, planBody()), newer], 'bot', now, 'op').action, 'wait');
  }
});

test('configuration and brief keep authority in owned config', () => {
  const text = fs.readFileSync(require.resolve('./agent-board.json'), 'utf8');
  const config = loadConfig(text);
  assert.equal(config.statusHourUTC, 11);
  for (const hour of [-1, 24, '11']) assert.throws(() => loadConfig(JSON.stringify({ ...JSON.parse(text), coordinator: { ...JSON.parse(text).coordinator, statusHourUTC: hour } })));
  const task = brief({ ...config, operator: 'operator', epicsRepository: 'other/repo', epicDocs: 'https://example.test/docs' }, epic);
  assert.match(task, /other\/repo#7/);
  assert.match(task, /There is no Ready step/);
  assert.match(task, /authenticated comments/);
});

test('health reports blocked, absent and unread board facts', () => {
  assert.equal(health([epic]), 'on-track');
  assert.equal(health([{ ...epic, subs: [{ ...epic.subs[0], status: 'Blocked' }] }]), 'at-risk');
  assert.equal(health([{ ...epic, subs: [{ ...epic.subs[0], onBoard: false }] }]), 'at-risk');
  assert.equal(health([{ error: 'unread' }]), 'off-track');
});

test('coordinator pools default independently and reject unknown pool names', () => {
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  assert.equal(loadConfig(JSON.stringify(source)).planPool, 'claude');
  assert.equal(loadConfig(JSON.stringify(source)).statusPool, 'openai');
  delete source.coordinator.planPool;
  delete source.coordinator.statusPool;
  const defaults = loadConfig(JSON.stringify(source));
  assert.equal(defaults.planPool, 'claude');
  assert.equal(defaults.statusPool, 'mistral');
  // A tier is its automatic pools, the first until a pass chooses by pace.
  const tiered = loadConfig(JSON.stringify({ ...source, coordinator: { ...source.coordinator, planPool: 'tier-1' } }));
  assert.deepEqual([tiered.planPools, tiered.planPool], [['claude', 'openai'], 'claude']);
  for (const name of ['planPool', 'statusPool']) {
    for (const value of ['', 'unknown', 'toString', null, 1, 'tier-3']) {
      assert.throws(() => loadConfig(JSON.stringify({ ...source,
        coordinator: { ...source.coordinator, [name]: value } })), new RegExp(`coordinator.${name}`));
    }
  }
});

test('planning and status dispatch use their own configured pools', async () => {
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  for (const overrides of [{}, { planPool: 'openai', statusPool: 'claude' }]) {
    const config = loadConfig(JSON.stringify({ ...source, coordinator: { ...source.coordinator, ...overrides } }));
    const h = harness(true);
    Object.assign(h.options.config, { planPool: config.planPool, statusPool: config.statusPool });
    assert.equal((await pass(h.options)).errors, 0);
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[0].inputs.item, '99');
    assert.equal(h.dispatches[0].inputs.pool, overrides.statusPool ?? 'openai');
    assert.equal(h.dispatches[1].inputs.item, '7');
    assert.equal(h.dispatches[1].inputs.pool, overrides.planPool ?? 'claude');
  }
});

test('long comment history packs newest decisions first within the UTF-8 dispatch limit', () => {
  const config = { epicsRepository: 'o/r', operator: 'op', followed: new Set(['o/r']), epicDocs: 'https://example.test/docs' };
  for (const body of ['x'.repeat(10000), '😀'.repeat(4000), '\"\\\n'.repeat(4000)]) {
    const comments = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1),
      updated_at: new Date(now + i * 1000).toISOString(), body: `${i === 99 ? 'NEWEST' : 'OLDER'} ${body}` }));
    const value = { ...epic, comments, subs: [{ ...epic.subs[0], body: 'CHILD BODY'.repeat(10000), linkedPR: 'https://example.test/pull/1' }] };
    const task = brief(config, value, 'request');
    assert.ok(Buffer.byteLength(JSON.stringify(value)) > 60000);
    assert.ok(Buffer.byteLength(task) <= 60000);
    assert.match(task, /NEWEST/);
    assert.doesNotMatch(task, /CHILD BODY/);
    const lines = task.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const packed = lines.filter(line => line.id);
    assert.equal(packed[0].id, '100');
    assert.ok(packed.length > 0 && packed.length < 100);
    assert.deepEqual(packed.map(c => c.id), [...comments].reverse().slice(0, packed.length).map(c => c.id));
    for (const c of packed) {
      assert.ok(Buffer.byteLength(c.body) <= 4000);
      assert.doesNotMatch(c.body, /\ufffd/);
      assert.match(c.body, /truncated/);
    }
    assert.match(task, new RegExp(`${100 - packed.length} older operator comment\\(s\\) left out; read https://github.com/o/r/issues/7`));
    assert.equal(lines.find(line => line.issue).linkedPR, 'https://example.test/pull/1');
    assert.equal(lines[0].body, epic.body);
  }
  assert.match(brief(config, { ...epic, comments: [] }, 'request'), /0 older operator comment/);
  const tied = brief(config, { ...epic, comments: ['9', '11', '10'].map(id => ({ id, updated_at: epic.comments[0].updated_at, body: id })) }, 'request');
  assert.deepEqual(tied.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).filter(c => c.id).map(c => c.id), ['11', '10', '9']);
  assert.throws(() => brief(config, { ...epic, body: 'x'.repeat(60000) }, 'request'), /after packing/);
});

// The project's Priority field as the API returns it: P0 to P2, no P3.
const project = (names = ['P0', 'P1', 'P2']) => ({ data: { repositoryOwner: { projectV2: { id: 'project',
  field: { id: 'field', options: names.map(name => ({ name, id: `option-${name}` })) } } } } });

test('apply config takes the Priority options the project has, not a configured list', async () => {
  const config = { operator: 'op', planner: 'bot', followed: new Set(['o/r']), priorityField: 'Priority' };
  const reply = value => async () => value;
  assert.deepEqual(await applyConfig(reply(project()), config), { operator: 'op', bot: 'bot', repositories: ['o/r'],
    project: 'project', priority_field: 'Priority', priority_field_id: 'field',
    priorities: { P0: 'option-P0', P1: 'option-P1', P2: 'option-P2' }, default_priority: 'P2' });
  for (const bad of [project([]), project(['P1', ' ']), { errors: [{ message: 'x' }] },
    { data: { repositoryOwner: { projectV2: { id: 'project', field: {} } } } }, { data: { repositoryOwner: null } }]) {
    await assert.rejects(applyConfig(reply(bad), config), /Priority/, JSON.stringify(bad));
  }
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  assert.equal(Object.hasOwn(source.coordinator, 'priorities'), false);
  assert.equal(Object.hasOwn(loadConfig(JSON.stringify(source)), 'priorities'), false);
});

function harness(apply = false, entries = [epic, { ...epic, number: 9 }], comments = []) {
  const writes = [], dispatches = [], commands = [], lines = [];
  const config = { epicsRepository: 'o/r', planner: 'bot', operator: 'op', caller: 'o/controller', owner: 'o', project: 1, priorityField: 'Priority', workflow: 'dispatch.yml',
    followed: new Set(['o/r']), wip: 4, planPool: 'claude', statusPool: 'mistral', statusIssue: 99, statusHourUTC: 11, usage: { repo: 'o/usage', issue: 1, bot: 'bot' } };
  return { writes, dispatches, commands, lines, options: { config, entries, note: '', now, apply,
    refresh: async () => ({ entries, note: '' }),
    get: async (method, p, body) => { if (method !== 'GET') { writes.push({ method, p, body }); return { id: writes.length }; }
      return p === '/repos/o/controller' ? { default_branch: 'trunk' } : []; },
    post: async ({ variables }) => variables.field ? project() : ({ data: { repository: { issue: { comments: {
      nodes: variables.number === 99 ? comments : [], pageInfo: { hasNextPage: false } } } } } }),
    dispatch: async (method, p, body) => { if (method === 'GET') return { workflow_runs: [] }; dispatches.push(body); },
    board: args => commands.push(args), writeFile: name => `/tmp/${name}`, log: line => lines.push(line) } };
}

function resultBody(body, checkpoint) {
  const state = JSON.parse(/: (\{.*\}) -->/.exec(checkpoint.body)[1]);
  // As posted: through the add_comment sanitizer stub.
  return sanitize(statusBody(body, state.pending.id));
}

test('preview performs no writes; apply checkpoints before dispatch and plans at most one epic', async () => {
  const preview = harness();
  assert.equal((await pass(preview.options)).plan, 1);
  assert.deepEqual(preview.writes, []);
  assert.deepEqual(preview.dispatches, []);
  assert.match(preview.lines.at(-1), /^coordinator\/v1 \{"mode":"preview"/);
  const live = harness(true);
  const counts = await pass(live.options);
  assert.equal(counts.errors, 0);
  assert.equal(counts.plan, 1);
  assert.equal(live.dispatches.length, 2); // One prose run and one epic run.
  assert.equal(live.writes.length, 2);
  assert.equal(live.dispatches[1].ref, 'trunk');
  assert.equal(live.dispatches[1].inputs.kind, 'triage');
  assert.equal(live.dispatches[1].inputs.item, '7');
});

test('an approved plan loses needs-human as it is planned, before its claim; a preview only says so', async () => {
  const approved = { ...epic, approved: true };
  const preview = harness(false, [approved]);
  assert.equal((await pass(preview.options)).plan, 1);
  assert.deepEqual(preview.writes, []);
  assert.ok(preview.lines.includes('o/r#7 approved: would remove needs-human'));
  const live = harness(true, [approved]);
  assert.equal((await pass(live.options)).errors, 0);
  const epicWrites = live.writes.filter(w => !w.p.includes('/99/'));
  assert.deepEqual(epicWrites.map(w => [w.method, w.p]), [['DELETE', '/repos/o/r/issues/7/labels/needs-human'], ['POST', '/repos/o/r/issues/7/comments']]);
  assert.equal(live.dispatches.at(-1).inputs.item, '7');
  assert.match(live.dispatches.at(-1).inputs.task, /first sub-issue delivers that contract/);
  assert.doesNotMatch(brief({ epicsRepository: 'o/r', followed: new Set(), operator: 'op' }, epic, 'id', { priorities: ['P1'] }), /contract/);
  // Already removed (404) still plans; any other failure stops before the claim.
  for (const [status, planned] of [[404, true], [403, false]]) {
    const h = harness(true, [approved]);
    const get = h.options.get;
    h.options.get = async (method, p, body) => {
      if (method === 'DELETE') throw new Error(`DELETE ${p}: HTTP ${status} no`);
      return get(method, p, body);
    };
    const counts = await pass(h.options);
    assert.equal(counts.errors, planned ? 0 : 1);
    assert.equal(h.writes.some(w => w.p === '/repos/o/r/issues/7/comments'), planned);
  }
  // Not approved (or not live: the census leaves a plan under review out): no label is touched.
  const plain = harness(true, [epic, { number: 4, live: false, why: 'unlabelled by op' }]);
  await pass(plain.options);
  assert.ok(!plain.writes.some(w => w.method === 'DELETE'));
  // A waiting epic is not planned this pass, so it keeps the label until it is.
  const full = harness(true, [approved]);
  full.options.config.wip = 0;
  await pass(full.options);
  assert.ok(!full.writes.some(w => w.method === 'DELETE'));
});

test('status brief points to Decisions without sampled asks and supplies linked activity and stale usage', async () => {
  for (const age of [0, 3 * 3600000, 3 * 3600000 + 1, null]) {
    const h = harness(true, [{ ...epic, subs: [{ ...epic.subs[0], status: 'Blocked' }] }, { ...epic, live: false, number: 10 }]);
    h.options.config.reviewUrl = 'https://review.example.test/#';
    const get = h.options.get;
    h.options.get = async (method, p, body) => {
      assert.equal(p.startsWith('/search/'), false, 'no decision count');
      assert.equal(p.includes('labels='), false, 'no sampled operator asks');
      if (p.includes('/pulls?state=all')) return [{ number: 2, html_url: 'https://github.com/o/r/pull/2',
        body: 'Refs O/R#8', merged_at: '2026-10-14T10:30:00Z', state: 'closed' }];
      return get(method, p, body);
    };
    const post = h.options.post;
    h.options.post = async args => !args.variables.field && args.variables.number === 1 ? { data: { repository: { issue: { comments: {
      nodes: age === null ? [] : [comment(12, '<!-- bot-usage v1 -->\n```json\n' + JSON.stringify({ schema: 'bot-usage/v1', updated_at: new Date(now - age).toISOString() }) + '\n```')],
      pageInfo: { hasNextPage: false } } } } } } : post(args);
    assert.equal((await pass(h.options)).errors, 0, h.lines.join('\n'));
    const task = h.dispatches[0].inputs.task;
    assert.match(task, /Write only from these facts; do not read the repository\./);
    assert.match(task, /at most 8 lines/);
    assert.match(task, /"\[Decisions\]\(URL\)" using decisions.url, with no count/);
    assert.match(task, /at least two related failed runs/);
    const facts = JSON.parse(task.split('\n\n')[1]);
    assert.deepEqual(facts.decisions, { url: 'https://review.example.test/#' });
    assert.equal(facts.epics.length, 1);
    assert.deepEqual(facts.epics[0].blocked, ['https://github.com/O/R/issues/8']);
    assert.equal(facts.pulls[0].pulls[0].url, 'https://github.com/o/r/pull/2');
    assert.deepEqual(facts.pulls[0].pulls[0].epics, [7, 10]);
    assert.equal(facts.usage.stale, age === null || age > 3 * 3600000);
    assert.equal(facts.usage.url, 'https://github.com/o/usage/issues/1');
    assert.equal(Object.hasOwn(facts, 'operatorAsks'), false);
  }
});

test('large and partial censuses retain epic coverage within a recorded line budget', async () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({ ...epic, number: i + 1 }));
  entries.push({ number: 20, error: 'timeline unavailable' });
  const h = harness(true, entries);
  await pass(h.options);
  const task = h.dispatches[0].inputs.task;
  assert.match(task, /at most 11 lines/);
  assert.match(task, /explicitly say unavailable for unread epics/);
  const facts = JSON.parse(task.split('\n\n')[1]);
  assert.equal(facts.epics.length, 8);
  assert.equal(facts.epics.at(-1).unread, true);
  const state = checkpointState(h.writes[0]);
  assert.equal(state.pending.maxLines, 11);
  const prose = Array(11).fill('line').join('\n');
  assert.equal(statusProse({ body: statusBody(prose) }, state.pending.maxLines), prose);
  assert.throws(() => statusProse({ body: statusBody(prose) }));
  assert.throws(() => statusProse({ body: statusBody('\n'.repeat(20) + 'OK') }));
  // A pending run recorded before line budgets keeps its 4000-character brief.
  assert.equal(statusProse({ body: statusBody('a\n'.repeat(1999) + 'b') }, null), 'a\n'.repeat(1999) + 'b');
  assert.throws(() => statusProse({ body: statusBody('a'.repeat(4001)) }, null));
});

test('maximum census status matches and publishes with expanded prose bounds', async () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ ...epic, number: i + 1 }));
  const first = harness(true, entries);
  assert.equal((await pass(first.options)).errors, 0);
  assert.match(first.dispatches[0].inputs.task, /1 to 15500 characters and at most 53 lines/);
  const checkpoint = comment(10, first.writes[0].body.body);
  const prose = ['[Decisions](https://review.example.test/)',
    ...entries.map(e => `[Epic ${e.number}](https://github.com/o/r/issues/${e.number}) on-track; merged none observed; blocked none observed.`),
    '[Pool usage](https://github.com/o/usage/issues/1): unavailable, stale.'].join('\n');
  assert.ok(prose.length > 2000);
  assert.throws(() => statusProse({ body: statusBody(prose) }));
  const later = harness(true, entries, [checkpoint, comment(11, resultBody(prose, checkpoint))]);
  let published;
  later.options.writeFile = (name, body) => { published = body; return '/tmp/status.md'; };
  assert.equal((await pass(later.options)).status, 1);
  assert.equal(published, prose);
  assert.equal(later.commands.length, 1);
});

test('incomplete census never plans an epic, and dispatch failure retains its claim', async () => {
  const unread = harness(false, [{ number: 7, error: 'unread' }]);
  const counts = await pass(unread.options);
  assert.equal(counts.plan, 0);
  assert.equal(counts.errors, 1);
  const failed = harness(true);
  failed.options.dispatch = async method => { if (method === 'GET') return { workflow_runs: [] }; throw new Error('ambiguous write'); };
  assert.equal((await pass(failed.options)).errors, 3);
  assert.equal(failed.writes.length, 3);
  assert.match(failed.writes[0].body.body, /pending/);
});

test('a dispatch GitHub refused takes its claim back, so the next pass plans again', async () => {
  const state = body => JSON.parse(/: (\{.*\}) -->/.exec(body)[1]);
  const refused = harness(true);
  refused.options.dispatch = async (method, p) => {
    if (method === 'GET') return { workflow_runs: [] };
    throw new Error(`POST ${p}: HTTP 403 {"message":"You have exceeded a secondary rate limit"}`);
  };
  assert.equal((await pass(refused.options)).errors, 3);
  // Status issue, then epics 7 and 9: each claim, then its take-back.
  assert.equal(refused.writes.length, 6);
  for (const [i, number] of [99, 7, 9].entries()) {
    const [claim, back] = refused.writes.slice(2 * i, 2 * i + 2);
    assert.equal(claim.p, `/repos/o/r/issues/${number}/comments`);
    assert.ok(state(claim.body.body).pending);
    assert.equal(back.method, 'PATCH');
    assert.equal(back.p, `/repos/o/r/issues/comments/${2 * i + 1}`);
    assert.deepEqual(state(back.body.body), { pending: null });
  }
  // The restored checkpoint is the one before the claim: no failure counted,
  // no request time that would hold the next plan back.
  assert.equal(decision(epic, state(refused.writes[3].body.body), [], 'bot', now + 3600000).action, 'plan');

  // A rejected `return_run_details` is retried without it; a refusal of the
  // retry takes the claim back as well.
  const retried = harness(true, [epic]);
  retried.options.dispatch = async (method, p, body) => {
    if (method === 'GET') return { workflow_runs: [] };
    throw new Error(`POST ${p}: HTTP ${body.return_run_details ? 422 : 403} refused`);
  };
  await pass(retried.options);
  assert.equal(retried.writes.filter(w => w.method === 'PATCH').length, 2);

  // A server error is ambiguous: the run may have started, so the claim stays.
  const ambiguous = harness(true, [epic]);
  ambiguous.options.dispatch = async (method, p) => {
    if (method === 'GET') return { workflow_runs: [] };
    throw new Error(`POST ${p}: HTTP 502 bad gateway`);
  };
  await pass(ambiguous.options);
  assert.equal(ambiguous.writes.filter(w => w.method === 'PATCH').length, 0);
});

test('large epic dispatch succeeds and includes only configured bot-linked open PR facts', async () => {
  const value = { ...epic, comments: Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1),
    updated_at: new Date(now + i * 1000).toISOString(), body: `${i === 99 ? 'NEWEST' : 'OLDER'} ${'x'.repeat(10000)}` })) };
  const h = harness(true, [value]);
  h.options.config.followed = new Set(['o/r']);
  const get = h.options.get;
  h.options.get = async (method, p, body) => p.includes('/pulls?') ? [
    { user: { login: 'bot' }, body: 'Refs O/R#8', html_url: 'https://example.test/pull/1' },
    { user: { login: 'visitor' }, body: 'Refs O/R#8', html_url: 'https://example.test/pull/2' },
  ] : get(method, p, body);
  const counts = await pass(h.options);
  assert.equal(counts.errors, 0);
  const task = h.dispatches.at(-1).inputs.task;
  assert.ok(Buffer.byteLength(task) <= 60000);
  assert.match(task, /NEWEST/);
  assert.match(task, /https:\/\/example.test\/pull\/1/);
  assert.doesNotMatch(task, /https:\/\/example.test\/pull\/2/);
});

test('unavailable PR facts fail before the epic pending checkpoint is written', async () => {
  const h = harness(true);
  h.options.config.followed = new Set(['o/r']);
  const get = h.options.get;
  h.options.get = async (method, p, body) => {
    if (p.includes('/pulls?')) throw new Error('PR snapshot unavailable');
    return get(method, p, body);
  };
  assert.ok((await pass(h.options)).errors > 0);
  assert.equal(h.writes.some(w => w.p.endsWith('/7/comments')), false);
  assert.equal(h.dispatches.some(d => d.inputs.item === '7'), false);
});

test('a later prose result publishes once, claims first, and a preview never publishes', async () => {
  const first = harness(true, []);
  await pass(first.options);
  assert.equal(first.dispatches.length, 1);
  const checkpoint = comment(10, first.writes[0].body.body);
  const prose = comment(11, resultBody('No operator action; no live epics.', checkpoint));
  for (const apply of [false, true]) {
    const later = harness(apply, [], [checkpoint, prose]);
    later.options.board = args => {
      assert.equal(later.writes.length, 1, 'claim is written before publication');
      later.commands.push(args);
    };
    const counts = await pass(later.options);
    assert.equal(counts.errors, 0);
    assert.equal(counts.status, 1);
    assert.equal(later.commands.length, apply ? 1 : 0);
    assert.equal(later.dispatches.length, 0);
    if (apply) {
      assert.deepEqual(later.commands[0].slice(0, 2), ['project', 'status-update']);
      const again = harness(true, [], [comment(10, later.writes[0].body.body), prose]);
      assert.equal((await pass(again.options)).status, 0);
      assert.deepEqual(again.commands, []);
      assert.deepEqual(again.dispatches, []);
    }
  }
});

test('foreign/invalid prose is never published, and changed health invalidates queued prose', async () => {
  const first = harness(true, []);
  await pass(first.options);
  const checkpoint = comment(10, first.writes[0].body.body);
  const block = resultBody('OK', checkpoint);
  for (const [prose, errors] of [[comment(11, block, 'visitor'), 0], [comment(11, block, 'bot', 'visitor'), 0],
    [comment(11, resultBody('', checkpoint)), 0],
    [comment(11, block.replace(/"request":"[^"]*"/, '"request":"obsolete"')), 0],
    [{ ...comment(11, block), updatedAt: '2026-10-14T10:59:59Z' }, 0],
    [comment(11, 'Coordinator request: request1\n```coordinator-status\nOK\n```'), 0]]) {
    const later = harness(true, [], [checkpoint, prose]);
    assert.equal((await pass(later.options)).errors, errors);
    assert.deepEqual(later.commands, []);
  }
  const invalid = harness(true, [], [checkpoint, comment(11, resultBody('', checkpoint))]);
  invalid.options.now = now + 7 * 60 * 60000;
  assert.equal((await pass(invalid.options)).failed, 1);
  assert.equal(checkpointState(invalid.writes[0]).pending, null);
  assert.equal(checkpointState(invalid.writes[0]).failures, 1);
  const changed = harness(true, [{ ...epic, subs: [{ ...epic.subs[0], status: 'Blocked' }] }], [checkpoint, comment(11, block)]);
  await pass(changed.options);
  assert.deepEqual(changed.commands, []);
  assert.match(changed.writes[0].body.body, /"pending":null/);
});

test('later epic apply pins the matched plan in preview and apply', async () => {
  const value = { ...epic, subs: [] };
  const checkpoint = comment(10, `<!-- coordinator/v1: ${JSON.stringify({ pending: {
    id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(value) } })} -->\ncheckpoint`);
  const plan = comment(11, planBody());
  for (const apply of [false, true]) {
    const h = harness(apply, [value]);
    Object.assign(h.options.config, { wip: 0, owner: 'o', project: 1, priorityField: 'Priority', priorities: ['P1'] });
    h.options.post = async ({ variables }) => {
      if (variables.field) return { data: { repositoryOwner: { projectV2: { id: 'project',
        field: { id: 'field', options: [{ name: 'P1', id: 'p1' }] } } } } };
      return { data: { repository: { issue: { comments: { nodes: variables.number === 7 ? [checkpoint, plan] : [],
        pageInfo: { hasNextPage: false } } } } } };
    };
    const counts = await pass(h.options);
    assert.equal(counts.errors, 0);
    assert.equal(counts.apply, 1);
    assert.equal(h.commands.length, apply ? 2 : 1);
    assert.equal(h.commands[0].at(-1), '--dry-run');
    for (const args of h.commands) assert.deepEqual(args.slice(5, -1), [
      '--expect-request', 'request1', '--expect-comment', '11', '--expect-updated-at', plan.updatedAt]);
    assert.equal(h.writes.length, apply ? 2 : 0);
    if (apply) {
      assert.equal(h.commands[1].at(-1), '--apply');
      assert.deepEqual(checkpointState(h.writes.at(-1)), { applied: changedFingerprint(value), at: new Date(now).toISOString(),
        requestedAt: '2026-10-14T10:00:00Z', pending: null, empty: true });
    }
  }
});

test('post-apply census records own effects and target changes remain guarded', async () => {
  const h = refusalHarness(true, null);
  const updated = { ...epic, title: 'Post apply', subs: [{ ...epic.subs[0], priority: 'P2' }] };
  let refreshes = 0;
  h.options.refresh = async () => { refreshes++; return { entries: [updated], note: '' }; };
  assert.equal((await pass(h.options)).apply, 1);
  assert.equal(refreshes, 1);
  const saved = checkpointState(h.writes.at(-1));
  assert.equal(saved.applied, changedFingerprint(updated));
  assert.equal(decision(updated, saved, [], 'bot', now + 60000).action, 'idle');
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(epic), targets: { 'o/r#8': 'old' } };
  const body = '```agent-board-epic-plan\n' + JSON.stringify({ request: 'request1', actions: [
    { type: 'rescope_sub_issue', issue: 'O/R#8', body: 'New', reason: 'Change' }] }) + '\n```';
  for (const state of ['open', 'closed']) {
    assert.equal(decision({ ...epic, subs: [{ ...epic.subs[0], state }] }, { pending }, [comment(1, body)], 'bot', now).action, 'blocked');
  }
});

test('an epic left with no open children is planned again once, not on every pass', async () => {
  const value = { ...epic, subs: [] };
  const first = refusalHarness(true, null);
  await pass(first.options);
  const empty = checkpointState(first.writes.at(-1));
  assert.equal(empty.empty, true);
  assert.equal(decision(value, empty, [], 'bot', now + 60000).action, 'plan');
  // The retry request records that it is one.
  const retry = harness(true, [value]);
  retry.options.post = async ({ variables }) => variables.field ? project() : { data: { repository: { issue: { comments: {
    nodes: variables.number === 7 ? [comment(10, first.writes.at(-1).body.body)] : [], pageInfo: { hasNextPage: false } } } } } };
  await pass(retry.options);
  assert.equal(checkpointState(retry.writes.at(-1)).emptyRetry, true);
  // Its apply, empty again, leaves the epic to the interval and daily pass.
  const second = refusalHarness(true, null, { emptyRetry: true });
  await pass(second.options);
  const settled = checkpointState(second.writes.at(-1));
  assert.equal(settled.empty, false);
  assert.equal(decision(value, settled, [], 'bot', now + 60000).action, 'idle');
});

test('confirmed apply reconciles after a transient census failure without reapplying', async () => {
  const h = refusalHarness(true, null);
  h.options.refresh = async () => { throw new Error('temporary census failure'); };
  assert.equal((await pass(h.options)).errors, 1);
  const savedWrite = h.writes.find(w => w.p.endsWith('/comments/10'));
  const saved = checkpointState(savedWrite);
  assert.equal(saved.reconcile, true);
  assert.equal(saved.pending, null);
  const retry = harness(true, [epic]);
  retry.options.config.wip = 0;
  retry.options.post = async ({ variables }) => ({ data: { repository: { issue: { comments: {
    nodes: variables.number === 7 ? [comment(10, savedWrite.body.body)] : [], pageInfo: { hasNextPage: false }
  } } } } });
  assert.equal((await pass(retry.options)).errors, 0);
  assert.equal(retry.commands.length, 0);
  assert.equal(checkpointState(retry.writes.at(-1)).applied, changedFingerprint(epic));
});

test('epic intent changes block create-only plans even without existing targets', async () => {
  const h = harness(true, [epic]);
  assert.equal((await pass(h.options)).errors, 0);
  const state = checkpointState(h.writes.find(w => w.p.endsWith('/7/comments')));
  const body = '```agent-board-epic-plan\n' + JSON.stringify({ schema: 'agent-board/epic-plan/v1',
    request: state.pending.id, epic: 'O/R#7', actions: [{ type: 'create_sub_issue', repo: 'O/R', title: 'Old requirements', body: 'Work' }] }) + '\n```';
  const plan = comment(20, body);
  for (const field of ['title', 'body']) {
    assert.equal(decision({ ...epic, [field]: 'Withdrawn' }, state, [plan], 'bot', now).action, 'blocked');
  }
});

// A pass in which epic 7 has a matching plan pending apply and epic 9 is
// due a plan; agent-board's preview fails with `failure`, as agentBoard
// (schedule.cjs) reports it, or succeeds when `failure` is null.
function refusalHarness(apply, failure, state = {}) {
  const value = { ...epic, subs: [] };
  const checkpoint = comment(10, `<!-- coordinator/v1: ${JSON.stringify({ ...state, pending: {
    id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(value) } })} -->\ncheckpoint`);
  const h = harness(apply, [value, { ...epic, number: 9 }]);
  h.options.post = async ({ variables }) => variables.field ? project() : { data: { repository: { issue: { comments: {
    nodes: variables.number === 7 ? [checkpoint, comment(11, planBody())] : [], pageInfo: { hasNextPage: false } } } } } };
  h.options.board = args => {
    h.commands.push(args);
    if (failure !== null && args[0] === 'epic') throw Object.assign(new Error(`agent-board ${args.join(' ')}: exited 1`), { stderr: failure });
  };
  return h;
}

test('the planning brief offers only the Priority options the project has', async () => {
  const h = harness(true, [{ ...epic, priority: 'P3', subs: [{ ...epic.subs[0], priority: 'P3' }] }]);
  await pass(h.options);
  const task = h.dispatches.find(d => d.inputs.item === '7').inputs.task;
  assert.match(task, /Every set_priority value must be one of the project's Priority options: \["P0","P1","P2"\]\./);
  assert.doesNotMatch(task, /refused/);
  const other = harness(true, [epic]);
  const post = other.options.post;
  other.options.post = async args => args.variables.field ? project(['Now', 'Later']) : post(args);
  await pass(other.options);
  assert.match(other.dispatches.find(d => d.inputs.item === '7').inputs.task, /options: \["Now","Later"\]/);
});

const plan = 'https://github.com/o/r/issues/7#issuecomment-11';
test('a plan agent-board refuses fails that epic only, counts, and is quoted in the next brief', async () => {
  for (const [stderr, refusal] of [
    [`error: newest epic plan ${plan}: epic plan refused:\n  action 2 (set_priority): Priority P3 is not a configured option\n`,
      `newest epic plan ${plan}: epic plan refused:\n  action 2 (set_priority): Priority P3 is not a configured option`],
    [`warning: x\nerror: newest epic plan ${plan}: expected value at line 1 column 1\n`, `newest epic plan ${plan}: expected value at line 1 column 1`],
    [`error: newest epic plan ${plan}: unknown epic plan field "x-->"`, `newest epic plan ${plan}: unknown epic plan field "x-->"`],
  ]) {
    for (const apply of [false, true]) {
      const h = refusalHarness(apply, stderr, { failures: 1 });
      const counts = await pass(h.options);
      assert.deepEqual([counts.failed, counts.apply, counts.errors, counts.plan], [1, 0, 0, 1], stderr);
      // The pass carried on: epic 9 was planned after 7's refusal.
      assert.equal(h.dispatches.filter(d => d.inputs.item === '9').length, apply ? 1 : 0);
      assert.ok(h.lines.some(l => l.startsWith('o/r#7 failed: agent-board refused the plan: newest epic plan')));
      const saved = h.writes.findLast(w => w.p === '/repos/o/r/issues/comments/10');
      if (!apply) { assert.equal(saved, undefined); continue; }
      assert.doesNotMatch(saved.body.body.split('\n')[0].slice(4, -4), /-->|<!--/);
      const { state } = record([comment(10, saved.body.body)], 'bot');
      assert.deepEqual([state.pending, state.failures, state.refusal], [null, 2, refusal]);

      const next = retryHarness(state, { at: new Date(now).toISOString(), healthHash: 'unchanged', claimed: true });
      assert.equal((await pass(next.options)).plan, 1);
      const task = next.dispatches.find(d => d.inputs.item === '7').inputs.task;
      assert.ok(task.includes(`agent-board refused this epic's previous plan for this reason (JSON data); the new plan must avoid it: ${JSON.stringify(refusal)}`));
      // Briefed once: the new claim no longer carries it into later briefs.
      const claimed = checkpointState(next.writes.find(w => w.p === '/repos/o/r/issues/comments/10'));
      assert.deepEqual([claimed.refusal, claimed.failures, Boolean(claimed.pending)], [undefined, 2, true]);
    }
  }
  // Refused plans count toward maxFailedRuns like runs that posted none.
  const last = refusalHarness(true, `error: newest epic plan ${plan}: epic plan has no actions`, { failures: 2 });
  await pass(last.options);
  const { state } = record([comment(10, last.writes.find(w => w.p === '/repos/o/r/issues/comments/10').body.body)], 'bot');
  const stuck = retryHarness(state, { at: new Date(now).toISOString(), healthHash: 'unchanged', claimed: true });
  assert.equal((await pass(stuck.options)).stuck, 1);
  assert.equal(stuck.dispatches.some(d => d.inputs.item === '7'), false);
  // A long refusal is capped before it reaches a checkpoint or a brief.
  const long = refusalHarness(true, `error: newest epic plan ${plan}: ${'😀'.repeat(5000)}`);
  await pass(long.options);
  const capped = record([comment(10, long.writes.find(w => w.p === '/repos/o/r/issues/comments/10').body.body)], 'bot').state.refusal;
  assert.equal([...capped].length, 2000);
});

test('agent-board failures that are not a refused plan leave it pending and uncounted', async () => {
  for (const stderr of ['', 'error: GitHub API GET /repos/o/r/issues/7/comments: HTTP 502 Bad Gateway\n',
    'error: read epic config: No such file or directory\n', `error: post claim on ${plan}: HTTP 403\n`,
    `warning: newest epic plan ${plan}: retrying\nerror: timed out\n`,
    // A plan posted after ours was read, which agent-board selected instead.
    'error: newest epic plan https://github.com/o/r/issues/7#issuecomment-12: epic plan has no actions\n',
    `error: newest epic plan ${plan}0: epic plan has no actions\n`, `error: x\nnewest epic plan ${plan}: not at line start`]) {
    for (const apply of [false, true]) {
      const h = refusalHarness(apply, stderr, { failures: 1 });
      const counts = await pass(h.options);
      assert.deepEqual([counts.failed, counts.errors], [0, 1], JSON.stringify(stderr));
      assert.equal(h.writes.some(w => w.p === '/repos/o/r/issues/comments/10'), false);
       assert.equal(h.dispatches.some(d => d.inputs.item === '9'), apply);
    }
  }
  // A valid plan previews and applies successfully.
  for (const apply of [false, true]) {
    const counts = await pass(refusalHarness(apply, null).options);
    assert.deepEqual([counts.apply, counts.failed, counts.errors], [1, 0, 0]);
  }
});

test('plan changes, refusals and transient failures at either CLI boundary', async () => {
  for (const boundary of ['--dry-run', '--apply']) {
    for (const [status, stderr, expected] of [
      [3, `error: newest epic plan ${plan}: changed`, [0, 0, 0, 1]],
      [1, `error: newest epic plan ${plan}: invalid action`, [0, 1, 0, 0]],
      [1, 'error: HTTP 502', [0, 0, 1, 0]],
      [0, '', [1, 0, 0, 0]],
    ]) {
      const h = refusalHarness(true, null, { failures: 1 });
      h.options.entries = h.options.entries.slice(0, 1);
      h.options.board = args => {
        h.commands.push(args);
        if (status && args.includes(boundary)) throw Object.assign(new Error('CLI failed'), { status, stderr });
      };
      const counts = await pass(h.options);
      assert.deepEqual([counts.apply, counts.failed, counts.errors, counts.wait], expected, `${boundary}: ${status}: ${stderr}`);
      const saved = h.writes.findLast(w => w.p === '/repos/o/r/issues/comments/10');
      if (status === 3 || counts.errors) assert.equal(saved, undefined, 'pending and failures unchanged');
      else if (counts.failed) assert.deepEqual([checkpointState(saved).pending, checkpointState(saved).failures], [null, 2]);
      else assert.equal(checkpointState(saved).applied, changedFingerprint(h.options.entries[0]));
    }
  }
});

test('a retained claim after ambiguous apply does not checkpoint success on retry', async () => {
  const h = refusalHarness(true, null, { failures: 1 });
  h.options.entries = h.options.entries.slice(0, 1);
  let claimed = false;
  h.options.board = args => {
    if (!args.includes('--apply')) return { stdout: '' };
    if (claimed) return { stdout: 'Request: request1\nAlready claimed; nothing changed.\n' };
    claimed = true;
    throw Object.assign(new Error('HTTP 502 after claim'), { status: 1, stderr: 'error: HTTP 502' });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const counts = await pass(h.options);
    assert.deepEqual([counts.apply, counts.failed, counts.errors], [0, 0, 1]);
    assert.equal(h.writes.some(w => w.p === '/repos/o/r/issues/comments/10'), false);
  }
  assert.ok(h.lines.some(l => l.includes('inspect agent-board claim')));
});

test('claimed plans recover only when all effects are present; partial failures let the next epic plan', async () => {
  const actions = [
    { type: 'create_sub_issue', repo: 'O/R', title: 'Created', body: 'Work' },
    { type: 'set_priority', new: 1, value: 'P1' },
    { type: 'close_sub_issue', issue: 'o/r#8', reason: 'Done' },
    { type: 'rescope_sub_issue', issue: 'o/r#10', body: 'Revised', reason: 'Change' },
  ];
  const complete = [{ ...epic.subs[0], number: 12, title: 'Created', body: 'Work' },
    { ...epic.subs[0], state: 'closed' }, { ...epic.subs[0], number: 10, body: 'Revised' }];
  for (const [subs, missing] of [
    [complete, null], [complete.slice(1), /action 1.*action 2/],
    [[{ ...complete[0], body: 'Wrong' }, ...complete.slice(1)], /action 1/],
    [[{ ...complete[0], priority: 'P2' }, ...complete.slice(1)], /action 1.*action 2/],
    [[{ ...complete[0], onBoard: false }, ...complete.slice(1)], /action 1.*action 2/],
    [[complete[0], { ...complete[1], state: 'open' }, complete[2]], /action 3/],
    [[complete[0], complete[1], { ...complete[2], body: 'Old' }], /action 4/],
    [[...complete, { ...complete[0], number: 13 }], /action 1/],
  ]) {
    const h = refusalHarness(true, null);
    const post = h.options.post;
    h.options.post = async args => {
      const out = await post(args);
      if (args.variables.number === 7) out.data.repository.issue.comments.nodes[1] = comment(11,
        '```agent-board-epic-plan\n' + JSON.stringify({ request: 'request1', actions }) + '\n```');
      return out;
    };
    h.options.refresh = async () => ({ entries: [{ ...epic, subs }], note: '' });
    h.options.board = args => args.includes('--apply') ? { stdout: 'Already claimed; nothing changed.\n' } : { stdout: '' };
    const counts = await pass(h.options);
    assert.equal(counts.errors, missing ? 1 : 0, h.lines.join('\n'));
    const saved = h.writes.filter(w => w.p.endsWith('/comments/10'));
    if (missing) {
      assert.equal(saved.length, 0);
      assert.match(h.lines.join('\n'), missing);
      assert.ok(h.dispatches.some(d => d.inputs.item === '9'));
    } else {
      assert.equal(counts.apply, 1);
      assert.deepEqual([checkpointState(saved[0]).pending, checkpointState(saved[0]).reconcile], [null, true]);
      assert.match(h.lines.join('\n'), /recovered: claimed plan effects confirmed/);
    }
  }
});

test('ambiguous epic dispatches and lost receipt checkpoints reserve their WIP slot', async () => {
  for (const receipt of [false, true]) {
    const h = harness(true, [epic, { ...epic, number: 9 }]);
    h.options.config.wip = 1;
    const post = h.options.post;
    h.options.post = async args => args.variables.number === 99 ? { data: { repository: { issue: { comments: {
      nodes: [comment(1, '<!-- coordinator-status/v1: {"failures":3} -->\ncheckpoint')], pageInfo: { hasNextPage: false } } } } } } : post(args);
    h.options.dispatch = async (method, p, body) => {
      if (method === 'GET') return { workflow_runs: [] };
      h.dispatches.push(body);
      if (receipt) return { workflow_run_id: 42 };
      throw new Error('lost receipt');
    };
    const get = h.options.get;
    h.options.get = async (method, p, body) => {
      if (method === 'PATCH') throw new Error('lost checkpoint');
      return get(method, p, body);
    };
    const counts = await pass(h.options);
    assert.equal(counts.errors, 1);
    assert.equal(h.dispatches.length, 1);
    assert.ok(h.lines.some(l => l.includes('#9 skipped: planning capacity full')));
  }
});

test("the scheduler's runs of this job count against the cap, once, before the runs list shows them", async () => {
  const full = harness(true);
  full.options.config.wip = 2;
  full.options.dispatched = ['o/x#1', 'o/x#2'];
  await pass(full.options);
  assert.deepEqual(full.dispatches, []);
  assert.ok(full.lines.some(l => l.includes('planning capacity full')), full.lines.join('\n'));

  // One the list shows already is not counted twice: a slot is left.
  const listed = harness(true);
  listed.options.config.wip = 2;
  listed.options.dispatched = ['o/x#1'];
  listed.options.dispatch = async (method, p, body) => {
    if (method === 'GET') return { workflow_runs: [{ status: 'in_progress', display_title: 'implement o/x#1 (claude)', html_url: 'https://example.test/run' }] };
    listed.dispatches.push(body);
  };
  await pass(listed.options);
  assert.equal(listed.dispatches.length, 1);
});

test('ordinary reporting volume is bounded and reporting failures do not block epic planning', async () => {
  const h = harness(true);
  h.options.config.followed = new Set(Array.from({ length: 6 }, (_, n) => `o/r${n}`));
  const original = h.options.get;
  h.options.get = async (method, p, body) => p.includes('/pulls?') ? Array.from({ length: 100 }, (_, n) => ({
    number: n + 1, body: 'Refs o/r#8', state: 'closed', created_at: '2026-10-13T11:00:00Z',
    updated_at: '2026-10-14T11:00:00Z', merged_at: '2026-10-14T10:00:00Z' })) : original(method, p, body);
  const dispatch = h.options.dispatch;
  h.options.dispatch = async (method, p, body) => method === 'GET' ? { workflow_runs: [{ id: 1,
    display_title: 'implement o/r#8 pool', status: 'completed', conclusion: 'success' }] } : dispatch(method, p, body);
  const counts = await pass(h.options);
  assert.equal(counts.errors, 0);
  assert.equal(counts.plan, 1);
  assert.ok(Buffer.byteLength(h.dispatches[0].inputs.task) < 60000);
  assert.match(h.dispatches[0].inputs.task, /5 most recently updated/);
  const facts = JSON.parse(h.dispatches[0].inputs.task.split('\n\n')[1]);
  assert.deepEqual(facts.runs[0], { id: 1, status: 'completed', conclusion: 'success', kind: 'implement', repository: 'o/r', item: 8 });
  assert.deepEqual(facts.pulls[0].pulls[0].epics, [7, 9]);

  const failed = harness(true);
  const post = failed.options.post;
  failed.options.post = async args => { if (args.variables.owner === 'o' && args.variables.name === 'usage') throw new Error('usage unavailable'); return post(args); };
  const result = await pass(failed.options);
  assert.equal(result.errors, 1);
  assert.equal(result.plan, 1);
  assert.equal(failed.dispatches.length, 1);
  assert.match(failed.dispatches[0].inputs.task, /Plan the live epic/);
});

test('obsolete runs finish before replacement, and higher Priority epics are selected first', async () => {
  for (const fingerprint of ['old intent', changedFingerprint(epic)]) {
    const busy = harness(true, [epic]);
    const pending = comment(10, `<!-- coordinator/v1: ${JSON.stringify({ pending: {
      id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint } })} -->\ncheckpoint`);
    const ready = comment(11, planBody());
    const post = busy.options.post;
    busy.options.post = async args => args.variables.number === 7 ? { data: { repository: { issue: { comments: {
      nodes: [pending, ready], pageInfo: { hasNextPage: false } } } } } } : post(args);
    busy.options.config.wip = 1;
    busy.options.dispatch = async () => ({ workflow_runs: [{ status: 'in_progress', display_title: 'triage o/r#7 pool', html_url: 'https://example.test/run' }] });
    const result = await pass(busy.options);
    assert.equal(result.plan, 0);
    assert.equal(result.apply, 0);
    assert.deepEqual(busy.writes, []);
    assert.deepEqual(busy.commands, []);
  }

  const sorted = harness(true, [{ ...epic, priority: 'P3' }, { ...epic, number: 9, priority: 'P0' }]);
  sorted.options.config.priorities = ['P0', 'P1', 'P2', 'P3'];
  await pass(sorted.options);
  assert.equal(sorted.dispatches.at(-1).inputs.item, '9');
});

test('retry limits default from owned config and are bounded', () => {
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  const config = loadConfig(JSON.stringify(source));
  assert.deepEqual([config.graceMs, config.runTimeoutMs, config.maxFailedRuns], [5 * 60000, 360 * 60000, 3]);
  for (const [name, value] of [['resultGraceMinutes', 0], ['resultGraceMinutes', 61], ['runTimeoutMinutes', 1441],
    ['maxFailedRuns', 0], ['maxFailedRuns', 21], ['maxFailedRuns', '3']]) {
    assert.throws(() => loadConfig(JSON.stringify({ ...source, coordinator: { ...source.coordinator, [name]: value } })),
      new RegExp(`coordinator.${name}`));
  }
});

// A pass whose epic 7 and status issue 99 carry the given checkpoints.
function retryHarness(epicState, statusState, run) {
  const h = harness(true, [epic]);
  Object.assign(h.options.config, { graceMs: 5 * 60000, runTimeoutMs: 60 * 60000, maxFailedRuns: 3 });
  const checkpoints = { 7: epicState && comment(10, `<!-- coordinator/v1: ${JSON.stringify(epicState)} -->\ncheckpoint`),
    99: statusState && comment(20, `<!-- coordinator-status/v1: ${JSON.stringify(statusState)} -->\ncheckpoint`) };
  h.options.post = async ({ variables }) => variables.field ? project() : ({ data: { repository: { issue: { comments: {
    nodes: checkpoints[variables.number] ? [checkpoints[variables.number]] : [], pageInfo: { hasNextPage: false } } } } } });
  h.lookups = [];
  h.options.dispatch = async (method, p, body) => {
    if (method === 'POST') { h.dispatches.push(body); return { workflow_run_id: 500 + h.dispatches.length }; }
    if (p.includes('/actions/runs/')) { h.lookups.push(p); return run; }
    return { workflow_runs: [] };
  };
  return h;
}
const checkpointState = write => JSON.parse(/: (\{.*\}) -->/.exec(write.body.body)[1]);
const summary = h => JSON.parse(h.lines.at(-1).slice('coordinator/v1 '.length));
const finished = { status: 'completed', conclusion: 'success', updated_at: '2026-10-14T10:30:00Z' };

test('dispatches record their run id in the claim written before them', async () => {
  const h = retryHarness(null, null);
  assert.equal((await pass(h.options)).errors, 0);
  assert.equal(h.dispatches.length, 2);
  assert.ok(h.dispatches.every(d => d.return_run_details === true));
  // Claim, then the run id in the same comment, for status then the epic.
  assert.deepEqual(h.writes.map(w => w.method), ['POST', 'PATCH', 'POST', 'PATCH']);
  assert.deepEqual([h.writes[1].p, h.writes[3].p], ['/repos/o/r/issues/comments/1', '/repos/o/r/issues/comments/3']);
  assert.equal(checkpointState(h.writes[1]).pending.run, 501);
  assert.equal(checkpointState(h.writes[3]).pending.run, 502);
  assert.equal(checkpointState(h.writes[3]).pending.id, checkpointState(h.writes[2]).pending.id);
});

test('a finished planning run without a plan is cleared, counted and re-planned, until the operator is needed', async () => {
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(epic), run: 42 };
  const status = { at: new Date(now).toISOString(), healthHash: 'unchanged', claimed: true };
  const failed = retryHarness({ pending, failures: 1 }, status, finished);
  assert.equal((await pass(failed.options)).failed, 1);
  assert.deepEqual(failed.lookups, ['/repos/o/controller/actions/runs/42']);
  assert.equal(summary(failed).failed, 1);
  const saved = checkpointState(failed.writes.find(w => w.p.endsWith('/comments/10')));
  assert.deepEqual([saved.pending, saved.failures], [null, 2]);
  assert.equal(failed.dispatches.some(d => d.inputs.item === '7'), false);

  const again = retryHarness(saved, status);
  assert.equal((await pass(again.options)).plan, 1);
  assert.equal(again.dispatches.at(-1).inputs.item, '7');
  assert.equal(checkpointState(again.writes.find(w => w.p.endsWith('/comments/10'))).failures, 2);

  const stuck = retryHarness({ pending: null, failures: 3 }, status);
  const counts = await pass(stuck.options);
  assert.deepEqual([counts.stuck, counts.plan, counts.errors], [1, 0, 0]);
  assert.equal(stuck.dispatches.some(d => d.inputs.item === '7'), false);
  assert.equal(stuck.writes.some(w => w.p.endsWith('/comments/10')), false);
  assert.ok(stuck.lines.includes('o/r#7 needs operator: 3 planning runs posted no plan'));

  // A preview reports the failure but writes nothing.
  const preview = retryHarness({ pending }, status, finished);
  preview.options.apply = false;
  assert.equal((await pass(preview.options)).failed, 1);
  assert.deepEqual(preview.writes, []);
});

test('a running or just-finished planning run keeps its pending checkpoint', async () => {
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(epic), run: 42 };
  const status = { at: new Date(now).toISOString(), healthHash: 'unchanged', claimed: true };
  for (const run of [{ status: 'in_progress', updated_at: '2026-10-14T10:00:00Z' },
    { status: 'completed', conclusion: 'success', updated_at: '2026-10-14T10:58:00Z' }]) {
    const h = retryHarness({ pending }, status, run);
    const counts = await pass(h.options);
    assert.deepEqual([counts.wait, counts.failed], [1, 0]);
    assert.equal(h.writes.some(w => w.p.endsWith('/comments/10')), false);
  }
  // A checkpoint from before run ids waits out the run timeout, then fails.
  for (const [at, failed] of [['2026-10-14T10:30:00Z', 0], ['2026-10-14T09:00:00Z', 1]]) {
    const h = retryHarness({ pending: { ...pending, run: undefined, at } }, status);
    assert.equal((await pass(h.options)).failed, failed);
    assert.deepEqual(h.lookups, []);
  }
});

test('a finished status run without prose is cleared and counted, and stops after repeated failures', async () => {
  const first = harness(true, []);
  await pass(first.options);
  const healthHash = checkpointState(first.writes[0]).pending.healthHash;
  const pending = { id: 'status1', at: '2026-10-14T10:00:00Z', healthHash, run: 7 };
  const h = retryHarness(null, { at: '2026-10-13T11:00:00Z', healthHash, pending, failures: 2 }, finished);
  h.options.entries = [];
  const counts = await pass(h.options);
  assert.deepEqual([counts.failed, counts.status], [1, 0]);
  const saved = checkpointState(h.writes[0]);
  assert.deepEqual([saved.pending, saved.failures], [null, 3]);
  const stuck = retryHarness(null, saved);
  stuck.options.entries = [];
  assert.equal((await pass(stuck.options)).stuck, 1);
  assert.deepEqual(stuck.dispatches, []);
});

test('a deleted run counts as finished, and a settled checkpoint is not looked up', async () => {
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(epic), run: 42 };
  const status = { at: new Date(now).toISOString(), healthHash: 'unchanged', claimed: true };
  for (const [error, failed, errors] of [['HTTP 404 Not Found', 1, 0], ['HTTP 502 Bad Gateway', 0, 1]]) {
    const h = retryHarness({ pending }, status);
    const dispatch = h.options.dispatch;
    h.options.dispatch = async (method, p, body) => {
      if (p.includes('/actions/runs/')) throw new Error(`GET ${p}: ${error}`);
      return dispatch(method, p, body);
    };
    const counts = await pass(h.options);
    assert.deepEqual([counts.failed, counts.errors], [failed, errors]);
  }
  const stale = retryHarness({ pending: { ...pending, fingerprint: 'old intent' } }, status, finished);
  stale.options.entries = [{ ...epic, comments: [{ ...epic.comments[0], updated_at: new Date(now).toISOString() }] }];
  await pass(stale.options);
  assert.deepEqual(stale.lookups, []);
  assert.equal(checkpointState(stale.writes.find(w => w.p.endsWith('/comments/10'))).pending, null);
});

test("a batched pull request is reported once, with its issues; others' issues are not listed", () => {
  const entries = [{ number: 7, subs: [{ repository: 'O/R', number: 9 }] }];
  const body = 'Refs o/r#8\n\nCloses #8\nCloses #9';
  const pull = { number: 3, html_url: 'https://github.com/o/r/pull/3', user: { login: 'Bot' }, body };
  const report = reportPull(pull, entries, 'bot');
  assert.deepEqual(report.issues, ['https://github.com/o/r/issues/8', 'https://github.com/o/r/issues/9']);
  assert.deepEqual(report.epics, [7]);
  const visitor = reportPull({ ...pull, user: { login: 'visitor' } }, entries, 'bot');
  assert.deepEqual(visitor.issues, []);
  assert.deepEqual(visitor.epics, [7]);
});

test('an applying pass during a broker outage previews: no record, no dispatch', async () => {
  const run = async outage => {
    const calls = [];
    const lines = [];
    const saved = { fetch: globalThis.fetch, log: console.log, env: { ...process.env } };
    globalThis.fetch = async (u, init) => {
      const p = u.replace('https://api.github.com', '');
      calls.push(`${init?.method ?? 'GET'} ${p}`);
      const reply = body => new Response(JSON.stringify(body), { status: 200 });
      if (p === '/repos/configured/tracker/issues?state=open&labels=outage&per_page=100') return reply(outage);
      if (p.includes('/runs?')) return reply({ workflow_runs: [] });
      if (p === '/graphql') return reply({ data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
      if (init?.method === 'POST') return reply({ id: 1, body: '', html_url: 'https://github.com/c' });
      return reply([]);
    };
    console.log = line => lines.push(line);
    Object.assign(process.env, { GH_TOKEN: 'test-token', AGENT_BOARD: '/nonexistent', RUNNER_TEMP: os.tmpdir(), GITHUB_REPOSITORY: 'configured/tracker' });
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      await main(['--apply']);
    } finally {
      globalThis.fetch = saved.fetch;
      console.log = saved.log;
      for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
      Object.assign(process.env, saved.env);
    }
    return { writes: calls.filter(c => !c.startsWith('GET ') && c !== 'POST /graphql'), lines };
  };
  // Unheld, the daily status is due: a record, then its run.
  const { bot } = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.ok((await run([])).writes.some(c => c.endsWith('/dispatches')));
  const held = await run([{ number: 9, html_url: 'https://github.com/configured/tracker/issues/9', user: { login: bot },
    body: '<!-- tracker-broker-outage -->\nBroker unreachable', updated_at: new Date().toISOString() }]);
  assert.deepEqual(held.writes, []);
  assert.equal(held.lines.filter(l => l.startsWith('held:')).join('\n'), 'held: broker outage https://github.com/configured/tracker/issues/9');
  assert.match(held.lines.at(-1), /^coordinator\/v1 \{"mode":"preview",/);
});
