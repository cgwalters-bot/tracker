const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/supervisor.yml'), 'utf8');

test('supervisor builds the shared actor and keeps write jobs gated', () => {
  // Both jobs build one pinned commit, never the branch's moving head.
  assert.match(workflow, /^env:\n  AGENT_BOARD_REV: [0-9a-f]{40}\n/m);
  assert.equal(workflow.match(/run: just build-agent-board/g)?.length, 2);
  assert.equal(workflow.match(/run: just build-agent-board "\$AGENT_BOARD_REV"\n/g)?.length, 2);
  for (const command of ['health', 'trigger', 'execute']) {
    assert.match(workflow, new RegExp(`agent-board" supervise ${command} \\\\`));
  }
  assert.equal(workflow.match(/--config .github\/poll\/agent-board.json --supervisor-config .github\/supervisor\/config.json/g)?.length, 3);
  assert.match(workflow, /--usage-config .github\/usage\/config.json --previous "\$RUNNER_TEMP\/previous-health\/health.json"/);
  assert.match(workflow, /--workflow supervisor.yml[\s\S]*--branch "\$DEFAULT_BRANCH" --status completed --limit 5/);
  assert.match(workflow, /--pools .github\/agentic-job\/pools.json \$\{DAILY:\+"\$DAILY"\} >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /vars.SUPERVISOR == 'apply' && needs.health.outputs.act == 'true'/);
  assert.match(workflow, /vars.SUPERVISOR == 'apply' && needs.agent.outputs.result-url != ''/);
  assert.match(workflow, /group: supervisor-execute\n +cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /supervisor\/.*\.cjs|just supervisor/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.github/supervisor')), ['config.json']);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
  assert.deepEqual(config.agent.requests, { repository: 'cgwalters-forge/tracker', issue: 656 });
  assert.deepEqual(config.agent.log, { repository: 'cgwalters-forge/operator', issue: 2 });
  // Omitted caps default to zero: this migration must not enable dispatches.
  assert.equal(config.agent.maxDispatchesPerPass ?? 0, 0);
  assert.equal(config.agent.maxDispatchesPerDay ?? 0, 0);
});

test('previous health uses completed runs even when an agent job failed', () => {
  const step = workflow.split('      - name: Previous health report\n')[1].split('      - name: Read-only health snapshot\n')[0];
  const script = step.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-previous-'));
  try {
    // Run 3 has no artifact. Run 2 has a good health artifact but a failed
    // executor; run 1's overall success must not make its report preferred.
    const mock = path.join(dir, 'gh');
    fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[1] === 'list') { process.stdout.write('3\\n2\\n1\\n'); process.exit(0); }
if (args[2] === '3') process.exit(1);
const dir = args[args.indexOf('--dir') + 1];
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/health.json', '[{"id":"broker","unavailable_since":"2026-10-16T00:00:00Z"}]');
`, { mode: 0o700 });
    const calls = path.join(dir, 'calls');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        CALLS: calls, RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'cgwalters-forge/tracker', DEFAULT_BRANCH: 'main' },
    });
    assert.equal(result.status, 0, result.stderr);
    const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands[0][commands[0].indexOf('--status') + 1], 'completed');
    assert.deepEqual(commands.slice(1).map(args => args[2]), ['3', '2']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'previous-health/health.json')))[0].unavailable_since,
      '2026-10-16T00:00:00Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared CLI accepts the shipped settings and emits workflow outputs without writes', {
  skip: !process.env.AGENT_BOARD && 'set AGENT_BOARD to the built binary',
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-wiring-'));
  try {
    const health = path.join(dir, 'health.json');
    fs.writeFileSync(health, '[]');
    const result = spawnSync(process.env.AGENT_BOARD, ['supervise', 'trigger',
      '--config', '.github/poll/agent-board.json', '--supervisor-config', '.github/supervisor/config.json',
      '--pools', '.github/agentic-job/pools.json', '--health', health], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'unused', GITHUB_REPOSITORY: 'cgwalters-forge/tracker', GITHUB_RUN_ID: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'act=false\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
