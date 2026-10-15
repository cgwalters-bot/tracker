'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { changedFingerprint, dailyDue, decision, health, loadConfig, pass, record, statusProse, brief, applyConfig } = require('./coordinator.cjs');

const now = Date.parse('2026-10-14T11:00:00Z');
const epic = { number: 7, live: true, title: 'Epic', body: 'Work', priority: 'P1',
  comments: [{ id: '1', body: 'Decision', updated_at: '2026-10-13T00:00:00Z' }],
  subs: [{ number: 8, repository: 'O/R', title: 'Task', body: 'Implement', state: 'open', status: 'In progress', priority: 'P1', onBoard: true }] };
const comment = (id, body, author = 'bot', editor = null) => ({ databaseId: id, body,
  author: { login: author }, editor: editor && { login: editor }, lastEditedAt: editor && '2026-10-14T11:00:00Z', updatedAt: '2026-10-14T11:00:00Z' });

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
  const plan = 'Coordinator request: request1\n```agent-board-epic-plan\n{}\n```';
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
    [{ pending: { ...pending, fingerprint: 'old' } }, [comment(1, plan)], 'stale'],
  ]) assert.equal(decision(epic, state, comments, 'bot', now).action, action);
  assert.equal(record([comment(1, '<!-- coordinator/v1: {"applied":"fake"} -->\n', 'visitor')], 'bot').id, null);
  assert.throws(() => statusProse({ body: '```coordinator-status\n\n```' }));
  assert.throws(() => statusProse({ body: `\`\`\`coordinator-status\n${'a'.repeat(4001)}\n\`\`\`` }));
  assert.equal(statusProse({ body: '```coordinator-status\nNeeds operator.\n```' }), 'Needs operator.');
});

test('a run that ends without its result fails after the grace period, and repeated failures stop planning', () => {
  const fingerprint = changedFingerprint(epic);
  const limits = { graceMs: 5 * 60000, runTimeoutMs: 60 * 60000, maxFailedRuns: 3 };
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint, run: 42 };
  const plan = comment(1, 'Coordinator request: request1\n```agent-board-epic-plan\n{}\n```');
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
// request line: sanitizeContentCore in actions/setup/js/sanitize_content_core.cjs
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

test('the request line survives the add_comment handler; the old marker did not', () => {
  const fingerprint = changedFingerprint(epic);
  const pending = { id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint };
  const plan = '```agent-board-epic-plan\n{}\n```';
  for (const [first, raw, sanitized] of [
    ['<!-- coordinator-request: request1 -->', 'wait', 'wait'],
    ['Coordinator request: request1', 'apply', 'apply'],
    ['Coordinator request: request1  \r', 'apply', 'apply'],
    ['\nCoordinator request: request1', 'apply', 'apply'],
    ['> [!CAUTION]\n> Threat detection warning.\n\nCoordinator request: request1', 'apply', 'apply'],
    ['Coordinator request: request1 <!-- old -->', 'wait', 'apply'],
    ['`Coordinator request: request1`', 'wait', 'wait'],
    ['Coordinator request: request10', 'wait', 'wait'],
    ['Coordinator request: obsolete', 'wait', 'wait'],
    ['Coordinator request: request1 (retry)', 'wait', 'wait'],
    ['coordinator request: request1', 'wait', 'wait'],
  ]) {
    for (const [body, action] of [[`${first}\n${plan}`, raw], [sanitize(`${first}\n${plan}`), sanitized]]) {
      assert.equal(decision(epic, { pending }, [comment(1, body)], 'bot', now).action, action, JSON.stringify(body));
    }
  }
  // The brief asks for exactly the line that is matched.
  assert.match(brief({ epicsRepository: 'o/r', followed: new Set(['o/r']), operator: 'op', epicDocs: 'docs' }, epic, 'request1'),
    /first line of your comment must be exactly Coordinator request: request1, as plain text/);
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
  assert.equal(loadConfig(JSON.stringify(source)).statusPool, 'mistral');
  delete source.coordinator.planPool;
  delete source.coordinator.statusPool;
  const defaults = loadConfig(JSON.stringify(source));
  assert.equal(defaults.planPool, 'claude');
  assert.equal(defaults.statusPool, 'mistral');
  for (const name of ['planPool', 'statusPool']) {
    for (const value of ['', 'unknown', 'toString', null, 1]) {
      assert.throws(() => loadConfig(JSON.stringify({ ...source,
        coordinator: { ...source.coordinator, [name]: value } })), new RegExp(`coordinator.${name}`));
    }
  }
});

test('planning and status dispatch use their own configured pools', async () => {
  const source = JSON.parse(fs.readFileSync(require.resolve('./agent-board.json'), 'utf8'));
  for (const overrides of [{}, { planPool: 'openai', statusPool: 'claude' }]) {
    delete source.coordinator.planPool;
    delete source.coordinator.statusPool;
    const config = loadConfig(JSON.stringify({ ...source, coordinator: { ...source.coordinator, ...overrides } }));
    const h = harness(true);
    Object.assign(h.options.config, { planPool: config.planPool, statusPool: config.statusPool });
    assert.equal((await pass(h.options)).errors, 0);
    assert.equal(h.dispatches.length, 2);
    assert.equal(h.dispatches[0].inputs.item, '99');
    assert.equal(h.dispatches[0].inputs.pool, overrides.statusPool ?? 'mistral');
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

test('coordinator workflow failures are isolated and retain the controller summary', () => {
  const workflow = fs.readFileSync(require.resolve('../workflows/poll.yml'), 'utf8');
  const step = workflow.split('      - name: Coordinator\n')[1].split('\n  # agent-board')[0];
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /run: just coordinator/);
});

test('apply config resolves only configured Priority options', async () => {
  const project = { id: 'project', field: { id: 'field', options: [{ name: 'P1', id: 'option' }] } };
  const post = async () => ({ data: { repositoryOwner: { projectV2: project } } });
  const config = { operator: 'op', planner: 'bot', followed: new Set(['o/r']), priorities: ['P1'], priorityField: 'Priority' };
  assert.deepEqual(await applyConfig(post, config), { operator: 'op', bot: 'bot', repositories: ['o/r'],
    project: 'project', priority_field: 'Priority', priority_field_id: 'field', priorities: { P1: 'option' }, default_priority: 'P1' });
  await assert.rejects(applyConfig(post, { ...config, priorities: ['P0'] }), /unavailable/);
});

function harness(apply = false, entries = [epic, { ...epic, number: 9 }], comments = []) {
  const writes = [], dispatches = [], commands = [], lines = [];
  const config = { epicsRepository: 'o/r', planner: 'bot', operator: 'op', caller: 'o/controller', workflow: 'dispatch.yml',
    followed: new Set(['o/r']), wip: 4, planPool: 'claude', statusPool: 'mistral', statusIssue: 99, statusHourUTC: 11, usage: { repo: 'o/usage', issue: 1, bot: 'bot' } };
  return { writes, dispatches, commands, lines, options: { config, entries, note: '', now, apply,
    get: async (method, p, body) => { if (method !== 'GET') { writes.push({ method, p, body }); return { id: writes.length }; }
      return p === '/repos/o/controller' ? { default_branch: 'trunk' } : []; },
    post: async ({ variables }) => ({ data: { repository: { issue: { comments: {
      nodes: variables.number === 99 ? comments : [], pageInfo: { hasNextPage: false } } } } } }),
    dispatch: async (method, p, body) => { if (method === 'GET') return { workflow_runs: [] }; dispatches.push(body); },
    board: args => commands.push(args), writeFile: name => `/tmp/${name}`, log: line => lines.push(line) } };
}

function resultBody(body, checkpoint) {
  const state = JSON.parse(/: (\{.*\}) -->/.exec(checkpoint.body)[1]);
  // As posted: through the add_comment sanitizer stub.
  return sanitize(`Coordinator request: ${state.pending.id}\n${body}`);
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

test('incomplete census never plans an epic, and dispatch failure retains its claim', async () => {
  const unread = harness(false, [{ number: 7, error: 'unread' }]);
  const counts = await pass(unread.options);
  assert.equal(counts.plan, 0);
  assert.equal(counts.errors, 1);
  const failed = harness(true);
  failed.options.dispatch = async method => { if (method === 'GET') return { workflow_runs: [] }; throw new Error('ambiguous write'); };
  assert.equal((await pass(failed.options)).errors, 2);
  assert.equal(failed.writes.length, 2);
  assert.match(failed.writes[0].body.body, /pending/);
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
  const prose = comment(11, resultBody('```coordinator-status\nNo operator action; no live epics.\n```', checkpoint));
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
  const block = resultBody('```coordinator-status\nOK\n```', checkpoint);
  for (const [prose, errors] of [[comment(11, block, 'visitor'), 0], [comment(11, block, 'bot', 'visitor'), 0],
    [comment(11, resultBody('```coordinator-status\n\n```', checkpoint)), 1],
    [comment(11, block.replace(/^Coordinator request: .*/, 'Coordinator request: obsolete')), 0]]) {
    const later = harness(true, [], [checkpoint, prose]);
    assert.equal((await pass(later.options)).errors, errors);
    assert.deepEqual(later.commands, []);
  }
  const changed = harness(true, [{ ...epic, subs: [{ ...epic.subs[0], status: 'Blocked' }] }], [checkpoint, comment(11, block)]);
  await pass(changed.options);
  assert.deepEqual(changed.commands, []);
  assert.match(changed.writes[0].body.body, /"pending":null/);
});

test('later epic apply never grants writes without a pinned-plan CLI boundary', async () => {
  const value = { ...epic, subs: [] };
  const checkpoint = comment(10, `<!-- coordinator/v1: ${JSON.stringify({ pending: {
    id: 'request1', at: '2026-10-14T10:00:00Z', fingerprint: changedFingerprint(value) } })} -->\ncheckpoint`);
  const plan = comment(11, 'Coordinator request: request1\n```agent-board-epic-plan\n{}\n```');
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
    assert.equal(counts.errors, apply ? 1 : 0);
    assert.equal(counts.apply, 1);
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].at(-1), '--dry-run');
    assert.equal(h.writes.length, 0);
    assert.equal(h.commands.some(args => args.includes('--apply')), false);
  }
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
    const ready = comment(11, 'Coordinator request: request1\n```agent-board-epic-plan\n{}\n```');
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
  h.options.post = async ({ variables }) => ({ data: { repository: { issue: { comments: {
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
  await pass(stale.options);
  assert.deepEqual(stale.lookups, []);
  assert.equal(checkpointState(stale.writes.find(w => w.p.endsWith('/comments/10'))).pending, null);
});
