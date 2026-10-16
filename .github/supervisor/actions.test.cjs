'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('./actions.cjs');

const policy = {
  organization: 'example', repositories: ['example/control', 'example/operator'],
  log: { repository: 'example/operator', issue: 7 },
  variables: { BOARD_DISPATCH: ['off', 'apply'] },
  kinds: ['implement', 'triage'], pools: ['pool-a'],
};
const request = (action, fields = {}) => ({
  type: 'supervisor_action', action, repository: 'example/control', ...fields,
});
const validate = (...requests) => validateBatch(requests.map(r => JSON.stringify(r)).join('\n'), policy);

test('accepts the closed typed action list', () => {
  const cases = {
    rerun: { run: 1 }, cancel: { run: 2 },
    dequeue: { item: 1 },
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
    request('set_variable', { name: 'BOARD_DISPATCH', value: 'apply' }),
    ...['/review', '\n \t/review', '\r\n/research'].map(body => request('comment', { item: 1, body })),
    request('delete_repository'), request('constructor'), request('enqueue', { item: 1 }), request(['cancel'], { run: 1 }),
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
