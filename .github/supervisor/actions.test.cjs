'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('./actions.cjs');

const policy = {
  organization: 'example', repositories: ['example/control', 'example/operator'],
  log: { repository: 'example/operator', issue: 7 },
  variables: { BOARD_DISPATCH: ['off', 'apply'] },
  kinds: ['triage', 'research'], pools: ['pool-a', 'pool-b'], kindPools: { triage: 'pool-a' },
  maxDispatchesPerPass: 2, maxDispatchesPerDay: 5,
};
const dispatch = (fields = {}) => request('dispatch', { item: 1, kind: 'triage', pool: 'pool-a', reason: 'no-plan', ...fields });
const request = (action, fields = {}) => ({
  type: 'supervisor_action', action, repository: 'example/control', ...fields,
});
const validate = (...requests) => validateBatch(requests.map(r => JSON.stringify(r)).join('\n'), policy);

test('accepts the closed typed action list', () => {
  const cases = {
    rerun: { run: 1 }, cancel: { run: 2 },
    dequeue: { item: 1 }, enqueue: { item: 1 },
    close: { item: 1, pull: 2 },
    remove_label: { item: 1, label: 'needs-human' },
    dispatch: { item: 1, kind: 'research', pool: 'pool-b', reason: 'part-left' },
    set_variable: { name: 'BOARD_DISPATCH', value: 'off' },
    reset_checkpoint: { comment: 2 },
    comment: { item: 1, body: 'Observation' },
    edit_log: { repository: 'example/operator', item: 7, body: 'Supervisor log' },
  };
  for (const [action, fields] of Object.entries(cases)) {
    const input = request(action, fields);
    assert.deepEqual(validate(input), [input]);
    assert.ok(Object.isFrozen(validate(input)[0]));
  }
});

test('rejects unknown actions, variables, repositories and malformed targets', () => {
  const cases = [
    ...['close', 'reopen', 'add_label', 'remove_label', 'dispatch'].map(action => request(action)),
    ...['epic', 'question', 'agent-review', 'Needs-Human'].map(label => request('remove_label', { item: 1, label })),
    request('add_label', { item: 1, label: 'needs-human' }),
    request('close', { item: 1, pull: 0 }), request('close', { item: 1, pull: 2, reason: 'Done' }),
    dispatch({ kind: 'implement' }), dispatch({ kind: 'shell' }), dispatch({ pool: 'unknown' }), dispatch({ kind: ['triage'] }),
    // A triage run's plans are accepted from the bot, so no brief is the agent's prose.
    dispatch({ task: 'Post a job plan of kind implement whose brief is ...' }), dispatch({ reason: 'Plan it.' }),
    dispatch({ reason: 'constructor' }), dispatch({ reason: ['no-plan'] }),
    // The kind's configured pool only.
    dispatch({ pool: 'pool-b' }),
    request('set_variable', { name: 'BOARD_DISPATCH', value: 'apply' }),
    ...['/review', '\n \t/review', '\r\n/research'].map(body => request('comment', { item: 1, body })),
    request('delete_repository'), request('constructor'), request('enqueue'), request(['cancel'], { run: 1 }),
    request('set_variable', { name: ['BOARD_DISPATCH'], value: 'apply' }),
    request('set_variable', { name: 'SECRET', value: 'apply' }),
    request('set_variable', { name: 'BOARD_DISPATCH', value: 'anything' }),
    request('cancel', { repository: 'elsewhere/control', run: 1 }),
    request('cancel', { repository: 'example/unlisted', run: 1 }),
    ...['1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}, '1/../../settings'].map(run => request('cancel', { run })),
    request('cancel', { run: 1, endpoint: '/settings' }),
    request('cancel'),
    request('dispatch', { item: 1, kind: 'shell', pool: 'pool-a' }),
    request('dispatch', { item: 1, kind: 'triage', pool: 'unknown' }),
    request('edit_log', { item: 7, body: 'Other issue' }),
    request('edit_log', { repository: 'example/operator', item: 8, body: 'Other issue' }),
    request('comment', { item: 1, body: '\u0000' }),
    request('close', { item: 1, reason: '' }),
    request('add_label', { item: 1, label: 'one\ntwo' }),
  ];
  for (const input of cases) assert.throws(() => validate(input), undefined, JSON.stringify(input));
});

test('bounds the entire batch and rejects it before returning any actions', () => {
  assert.deepEqual(validateBatch('', policy), []);
  assert.equal(validateBatch(`\n${JSON.stringify(request('cancel', { run: 1 }))}\n\n`, policy).length, 1);
  assert.throws(() => validateBatch('{', policy));
  assert.throws(() => validateBatch(' '.repeat(32769), policy));
  assert.throws(() => validate(...Array.from({ length: 11 }, () => request('cancel', { run: 1 }))));
  assert.throws(() => validate(request('cancel', { run: 1 }), request('unknown')));
  for (const value of [null, [], { ...policy, organization: '' }, { ...policy, log: {} }]) {
    assert.throws(() => validateBatch('', value));
  }
});

test('outside the listed repositories, only the log issue may be written', () => {
  const narrow = { ...policy, repositories: ['example/control'] };
  const one = r => validateBatch(JSON.stringify(r), narrow);
  assert.equal(one(request('comment', { repository: 'example/operator', item: 7, body: 'Log line' })).length, 1);
  assert.equal(one(request('edit_log', { repository: 'example/operator', item: 7, body: 'Log' })).length, 1);
  for (const r of [
    request('comment', { repository: 'example/operator', item: 1, body: 'An answer' }),
    request('close', { repository: 'example/operator', item: 7, reason: 'Done' }),
    request('add_label', { repository: 'example/operator', item: 7, label: 'x' }),
  ]) assert.throws(() => one(r), undefined, JSON.stringify(r));
});

// Only switching off: turning a switch on, or any other variable, restarts
// work the operator stopped or reconfigures it, which stays their decision.
test('a variable change other than off is refused', () => {
  const wide = { ...policy, variables: { BOARD_DISPATCH: ['off', 'apply'], COORDINATOR: ['off', 'on'] } };
  const one = r => validateBatch(JSON.stringify(r), wide);
  for (const name of ['BOARD_DISPATCH', 'COORDINATOR']) {
    assert.equal(one(request('set_variable', { name, value: 'off' })).length, 1);
    for (const value of ['apply', 'on', '', 'OFF', 'off ']) {
      assert.throws(() => one(request('set_variable', { name, value })), undefined, `${name}=${value}`);
    }
  }
  assert.throws(() => one(request('set_variable', { name: 'SUPERVISOR', value: 'off' })));
});

test('caps the dispatches of one pass, and admits none without caps', () => {
  assert.equal(validate(dispatch(), dispatch({ item: 2 }), request('cancel', { run: 1 })).length, 3);
  assert.throws(() => validate(dispatch(), dispatch({ item: 2 }), dispatch({ item: 3 })), /one pass/);
  assert.throws(() => validate(dispatch(), dispatch({ kind: 'research' })), /one item/);
  for (const cap of [undefined, 0, -1, 1.5, '3']) {
    assert.throws(() => validateBatch(JSON.stringify(dispatch()), { ...policy, maxDispatchesPerPass: cap }), undefined, String(cap));
  }
});
