'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBatch } = require('./actions.cjs');

const policy = {
  organization: 'example', repositories: ['example/control', 'example/operator'],
  log: { repository: 'example/operator', issue: 7 },
  variables: { BOARD_DISPATCH: ['', 'apply'] },
  kinds: ['implement', 'triage'], pools: ['pool-a'],
};
const request = (action, fields = {}) => ({
  type: 'supervisor_action', action, repository: 'example/control', ...fields,
});
const validate = (...requests) => validateBatch(requests.map(r => JSON.stringify(r)).join('\n'), policy);

test('accepts the closed typed action list', () => {
  const cases = {
    rerun: { run: 1 }, cancel: { run: 2 },
    close: { item: 1, reason: 'Duplicate' }, reopen: { item: 1, reason: 'Retry' },
    add_label: { item: 1, label: 'needs-human' }, remove_label: { item: 1, label: 'needs-human' },
    enqueue: { item: 1 }, dequeue: { item: 1 },
    set_variable: { name: 'BOARD_DISPATCH', value: '' },
    reset_checkpoint: { comment: 2 }, dispatch: { item: 1, kind: 'triage', pool: 'pool-a' },
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
    request('delete_repository'), request('constructor'), request(['cancel'], { run: 1 }),
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
  assert.throws(() => validateBatch('{', policy));
  assert.throws(() => validateBatch(' '.repeat(32769), policy));
  assert.throws(() => validate(...Array.from({ length: 11 }, () => request('cancel', { run: 1 }))));
  assert.throws(() => validate(request('cancel', { run: 1 }), request('unknown')));
  for (const value of [null, [], { ...policy, organization: '' }, { ...policy, log: {} }]) {
    assert.throws(() => validateBatch('', value));
  }
});
