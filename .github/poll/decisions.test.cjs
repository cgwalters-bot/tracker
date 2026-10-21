'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { readDecisions, keyFrom, seal, open } = require('./decisions.cjs');

const settings = { decisions: { repository: 'sample/private', issue: 42 } };
const document = '### D1 Proceed?\n- [ ] A) Yes\n- [ ] B) Wait\nReply:\n\n## Done\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    AGENT_BOARD: '/trusted/agent-board', POLL_STATE: path.join(dir, 'poll.json'),
    DECISIONS_STATE_KEY: 'ab'.repeat(32), GITHUB_STEP_SUMMARY: 'public', GITHUB_OUTPUT: 'public',
  };
  return { env, saved: `${env.POLL_STATE}.decisions.enc`, key: keyFrom(env.DECISIONS_STATE_KEY) };
}

test('disabled by default without invoking a child', () => {
  assert.deepEqual(readDecisions({}, settings, () => assert.fail()), { status: 'disabled', changes: [] });
});

test('offline edited document exposes only ids and letters and preserves encrypted last-write baseline', t => {
  const { env, saved, key } = fixture(t);
  const baseline = Buffer.from('```json\n' + JSON.stringify({ target: settings.decisions, body: document, high_water: 1 }) + '\n```\n');
  fs.writeFileSync(saved, seal(baseline, key));
  let temporary;
  for (let pass = 0; pass < 2; pass++) {
    const result = readDecisions(env, settings, (binary, args, options) => {
      assert.equal(binary, env.AGENT_BOARD);
      assert.deepEqual(args.slice(0, 3), ['ask', 'read', '--config']);
      temporary = path.dirname(args[3]);
      assert.deepEqual(JSON.parse(fs.readFileSync(args[3])), settings);
      assert.deepEqual(fs.readFileSync(path.join(temporary, 'agent-board.decisions-state.md')), baseline);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      for (const name of ['DECISIONS_STATE_KEY', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) assert.equal(options.env[name], undefined);
      return { status: 0, stderr: 'PRIVATE diagnostic', stdout: JSON.stringify({ changes: [{
        id: 'D1', ticked: ['- [x] B) PRIVATE option'], reply: 'PRIVATE reply',
        before: document, after: document.replace('[ ] B)', '[x] B)') + 'PRIVATE reply',
      }], other_edits: false }) };
    });
    assert.deepEqual(result, { status: 'ok', changes: [{ id: 'D1', options: ['B'] }], other_edits: false });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Proceed|Wait/);
    assert.equal(fs.existsSync(temporary), false);
    assert.deepEqual(open(fs.readFileSync(saved), key), baseline);
    assert.equal(fs.readFileSync(saved).includes(Buffer.from(document)), false);
  }
});

test('failures and malformed private responses never escape or replace baseline', t => {
  const { env, saved, key } = fixture(t);
  const encrypted = seal(Buffer.from(document), key);
  fs.writeFileSync(saved, encrypted);
  for (const result of [
    { status: 1, stderr: 'PRIVATE' }, { status: null, error: new Error('PRIVATE') },
    { status: 0, stdout: 'PRIVATE' },
    { status: 0, stdout: JSON.stringify({ changes: [{ id: 'PRIVATE', ticked: [] }], other_edits: false }) },
    { status: 0, stdout: JSON.stringify({ changes: [{ id: ['D1'], ticked: [] }], other_edits: false }) },
    { status: 0, stdout: JSON.stringify({ changes: [{ id: 'D1', ticked: ['PRIVATE'] }], other_edits: false }) },
  ]) {
    assert.deepEqual(readDecisions(env, settings, () => result), { status: 'failed', changes: [] });
    assert.deepEqual(fs.readFileSync(saved), encrypted);
  }
  const damaged = Buffer.from(encrypted);
  damaged[15] ^= 1;
  fs.writeFileSync(saved, damaged);
  assert.deepEqual(readDecisions(env, settings, () => assert.fail()), { status: 'failed', changes: [] });
  assert.throws(() => keyFrom('bad'));
});

test('enabled executable adapter never publishes private output and reports a failed read without failing the pass', t => {
  const { env } = fixture(t);
  const dir = path.dirname(env.POLL_STATE);
  const binary = path.join(dir, 'agent-board');
  fs.writeFileSync(binary, `#!/usr/bin/env node
if (process.argv[2] === 'poll') console.log('next-due-seconds=600');
else {
  console.error('PRIVATE diagnostic');
  console.log(JSON.stringify({changes:[{id:'D1',ticked:['- [x] A) PRIVATE label'],reply:'PRIVATE reply',before:'PRIVATE',after:'PRIVATE'}],other_edits:false}));
  process.exitCode = Number(process.env.FAIL_READ);
}
`, { mode: 0o700 });
  for (const fail of [0, 1]) {
    const output = path.join(dir, `output-${fail}`);
    const summary = path.join(dir, `summary-${fail}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'poll.cjs')], {
      env: { ...process.env, ...env, AGENT_BOARD: binary, FAIL_READ: String(fail), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'in-flight=false\n');
    for (const text of [result.stdout, result.stderr, fs.readFileSync(summary, 'utf8')]) assert.doesNotMatch(text, /PRIVATE/);
    assert.match(result.stdout, fail ? /"status":"failed"/ : /"id":"D1","options":\["A"\]/);
  }
});

test('missing local baseline permits agent-board history recovery without advancing baseline', t => {
  const { env, saved } = fixture(t);
  assert.deepEqual(readDecisions(env, settings, () => ({ status: 0, stdout: '{"changes":[],"other_edits":true}' })),
    { status: 'ok', changes: [], other_edits: true });
  assert.equal(fs.existsSync(saved), false);
});
