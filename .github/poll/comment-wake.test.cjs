'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../workflows/comment-wake.yml'), 'utf8');
const conditions = [...workflow.matchAll(/if: \$\{\{ (.*) \}\}/g)].map(m => m[1]);

test('only enabled, new human operator comments on open issues wake poll', () => {
  assert.match(workflow, /issue_comment:\n    types: \[created\]/);
  assert.equal(conditions.length, 2);
  const admitted = (overrides = {}) => {
    const context = {
      vars: { COMMENT_WAKE: 'enabled' },
      github: { actor: 'someone-else', event: {
        issue: { state: 'open' },
        comment: { user: { login: 'configured-operator', type: 'User' }, body: 'anything' },
      } },
      needs: { config: { outputs: { operator: 'configured-operator' } } },
    };
    overrides.edit?.(context);
    return conditions.every(condition => vm.runInNewContext(condition, context));
  };
  assert.equal(admitted(), true);
  for (const edit of [
    c => { c.vars = {}; },
    c => { c.vars.COMMENT_WAKE = 'true'; },
    c => { c.github.event.issue.state = 'closed'; },
    c => { c.github.event.issue.pull_request = {}; },
    c => { c.github.event.comment.user.type = 'Bot'; },
    c => { c.github.event.comment.user.login = 'someone-else'; c.github.actor = 'configured-operator'; },
    c => { c.needs.config.outputs.operator = ''; },
  ]) assert.equal(admitted({ edit }), false);
});

test('operator output is read from owned configuration and cannot inject outputs', () => {
  const justfile = fs.readFileSync(path.join(__dirname, '../../Justfile'), 'utf8');
  const filter = /comment-wake-config:\n    jq -er '([^']+)' \.github\/poll\/agent-board.json/.exec(justfile)?.[1];
  assert.ok(filter);
  for (const operator of ['other-operator', '', 'name\n', 'name\nadmin=true', null, {}, 'a'.repeat(40)]) {
    const result = spawnSync('jq', ['-er', filter], { input: JSON.stringify({ operator }), encoding: 'utf8' });
    assert.equal(result.status, operator === 'other-operator' ? 0 : 4);
    assert.equal(result.stdout, operator === 'other-operator' ? 'operator=other-operator\n' : '');
  }
});

test('wake uses only a bounded default-branch dispatch into existing poll concurrency', () => {
  assert.match(workflow, /permissions: \{\}/);
  const [config, wake] = workflow.split('\n  wake:\n');
  assert.match(config, /permissions:\n      contents: read/);
  assert.match(config, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(config, /persist-credentials: false/);
  assert.match(config, /run: just comment-wake-config/);
  assert.match(wake, /permissions:\n      actions: write/);
  assert.doesNotMatch(wake, /uses: actions\/checkout|secrets\./);
  assert.match(wake, /gh workflow run poll.yml --repo "\$GITHUB_REPOSITORY" --ref "\$DEFAULT_BRANCH"/);
  assert.equal((workflow.match(/timeout-minutes: 2/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /github.event.comment.body|github.head_ref|github.event.issue.number|concurrency:/);
  const poll = fs.readFileSync(path.join(__dirname, '../workflows/poll.yml'), 'utf8');
  assert.match(poll, /group: poll\$\{\{ inputs.dry-run && '-dry-run' \|\| '' \}\}\n  cancel-in-progress: false/);
});
