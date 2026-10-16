'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { compose, decide, recentAgent } = require('./trigger.cjs');

const policy = {
  organization: 'example', repositories: ['example/control'], log: { repository: 'example/operator', issue: 7 },
  requests: { repository: 'example/control', issue: 5 }, variables: { BOARD_DISPATCH: ['apply', 'off'] },
  kinds: ['research'], pools: ['claude'],
};
const checks = status => [{ id: 'poll', status: 'ok' }, { id: 'release', status }];

test('the agent runs on a failing check or the daily pass, and not during the cooldown', async () => {
  let asked = 0;
  const recent = value => () => { asked++; return value; };
  assert.equal((await decide(checks('ok'), { daily: false, policy, recent: recent(false) })).act, false);
  assert.equal((await decide(checks('warn'), { daily: false, policy, recent: recent(false) })).act, false);
  assert.equal(asked, 0);
  assert.deepEqual(await decide(checks('fail'), { daily: false, policy, recent: recent(false) }), { act: true, reason: 'release failing' });
  assert.equal((await decide(checks('fail'), { daily: false, policy, recent: recent(true) })).act, false);
  assert.equal((await decide(checks('ok'), { daily: true, policy, recent: hours => hours === 0 ? false : true })).act, true);
  assert.equal((await decide(checks('ok'), { daily: true, policy, recent: hours => hours === 0 })).act, false, 'an agent still running');
  assert.equal((await decide(checks('fail'), { daily: true, policy: null, recent: recent(false) })).act, false);
});

test('the cooldown counts earlier runs whose agent call ran, not this run or skipped calls', async () => {
  const jobs = { 1: [{ name: 'health' }, { name: 'agent', conclusion: 'skipped' }], 2: [{ name: 'agent / target', conclusion: null }], 3: [{ name: 'agent / agent' }] };
  const get = (runs, running = []) => async path => {
    if (path.endsWith('/workflows/supervisor.yml/runs?per_page=100&created=%3E%3D2026-10-16T08:00:00.000Z')) return { workflow_runs: runs.map(id => ({ id })) };
    if (path.endsWith('/workflows/supervisor.yml/runs?per_page=100&status=in_progress')) return { workflow_runs: running.map(id => ({ id })) };
    const id = /runs\/(\d+)\/jobs/.exec(path)[1];
    return { jobs: jobs[id] };
  };
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(await recentAgent(get([1]), 'example/control', 9, now, 4), false);
  assert.equal(await recentAgent(get([1, 2]), 'example/control', 9, now, 4), true);
  assert.equal(await recentAgent(get([3]), 'example/control', 3, now, 4), false);
  assert.equal(await recentAgent(get([1], [2]), 'example/control', 9, now, 4), true, 'an agent older than the cooldown still running');
});

test('the task is the playbook, the policy and the report, bounded', () => {
  const playbook = fs.readFileSync(`${__dirname}/playbook.md`, 'utf8');
  const task = compose(playbook, checks('fail'), policy, 'release failing');
  assert.ok(task.startsWith(playbook));
  assert.match(task, /Why you run: release failing\./);
  assert.match(task, /"BOARD_DISPATCH": \[/);
  assert.match(task, /"id": "release"/);
  assert.ok(!task.includes('"requests"'));
  assert.throws(() => compose('x'.repeat(49 * 1024), [], policy, 'r'));
});
