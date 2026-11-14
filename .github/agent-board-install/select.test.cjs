const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(`${__dirname}/select.cjs`, 'utf8');
const sha = 'a'.repeat(40), newer = 'b'.repeat(40);
const run = { id: 42, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml' };
const artifact = { name: 'agent-board-main', expired: false };

function fixture({ runs = [run], artifacts = [artifact], fail = false } = {}) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: () => ({ execFileSync(command, args, options) {
    assert.equal(command, 'gh');
    assert.equal(options.timeout, 20000);
    calls.push(args[1]);
    if (fail) throw Error('API failure');
    return JSON.stringify(args[1].includes('/artifacts?') ? { artifacts } :
      args[1].includes('/commits?') ? [{ sha: newer }, { sha }] : { workflow_runs: runs });
  } }) });
  return { select: module.exports.select, calls };
}

test('exact revision, successful main push, and nonexpired named artifact only', () => {
  const f = fixture();
  assert.equal(JSON.stringify(f.select(sha)), JSON.stringify({ sha, run: 42 }));
  assert.ok(f.calls[0].includes(`head_sha=${sha}`));
  assert.equal(fixture().select(newer), null);
  for (const change of [{ head_branch: 'other' }, { event: 'pull_request' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { path: '.github/workflows/other.yml' }]) {
    assert.equal(fixture({ runs: [{ ...run, ...change }] }).select(sha), null);
  }
  for (const artifacts of [[], [{ ...artifact, expired: true }], [{ ...artifact, name: 'agent-board' }]]) {
    assert.equal(fixture({ artifacts }).select(sha), null);
  }
  assert.throws(() => fixture({ artifacts: [artifact, artifact] }).select(sha), /ambiguous/);
  assert.throws(() => fixture({ fail: true }).select(sha), /API failure/);
  assert.throws(() => fixture().select('main'), /pinned/);
});

test('newest commit order, not run date, skips missing publication; discovery is bounded', () => {
  assert.equal(fixture().select('latest').sha, sha, 'pending newer head does not stall the pin');
  assert.equal(fixture({ runs: [run, { ...run, id: 43, head_sha: newer }] }).select('latest').sha, newer);
  assert.throws(() => fixture({ runs: Array(31).fill(run), artifacts: [] }).select('latest'), /30 runs/);
});
