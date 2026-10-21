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
  assert.match(workflow, /--workflow supervisor.yml[\s\S]*--branch "\$DEFAULT_BRANCH" --status completed --limit 50\b/);
  assert.match(workflow, /--pools .github\/agentic-job\/pools.json \$\{DAILY:\+"\$DAILY"\} >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /\(vars.SUPERVISOR == 'preview' \|\| vars.SUPERVISOR == 'apply'\) && needs.health.outputs.act == 'true'/);
  assert.match(workflow, /\(vars.SUPERVISOR == 'preview' \|\| vars.SUPERVISOR == 'apply'\) && needs.agent.outputs.result-url != ''/);
  assert.match(workflow, /^concurrency:\n[\s\S]*?\n +cancel-in-progress: false/m);
  assert.doesNotMatch(workflow, /supervisor\/.*\.cjs|just supervisor/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.github/supervisor')), ['config.json']);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
  const board = JSON.parse(fs.readFileSync(path.join(root, '.github/poll/agent-board.json')));
  assert.deepEqual(config.agent.requests, { repository: 'cgwalters-forge/tracker', issue: 656 });
  assert.deepEqual(config.agent.log, { repository: 'cgwalters-forge/operator', issue: 2 });
  // The executor enforces these caps whatever the agent asks for. Small at the
  // 17 Oct cutover; raised on 20 Oct when the pools sat far below pace.
  assert.equal(config.agent.maxDispatchesPerPass, 4);
  assert.equal(config.agent.maxDispatchesPerDay, 40);
  assert.deepEqual(config.agent.dailyCaps, {
    comment: 20, create_issue: 15, close: 10, remove_needs_human: 12, replace_state: 48, status_update: 1,
  });
  // The README is where the operator states what the supervisor may do: every
  // cap it names as `name: N` must be the config's, and it must name them all.
  const caps = {
    maxDispatchesPerPass: config.agent.maxDispatchesPerPass,
    maxDispatchesPerDay: config.agent.maxDispatchesPerDay,
    ...config.agent.dailyCaps,
  };
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const stated = {};
  for (const [, name, value] of readme.matchAll(/`(\w+): (\d+)`/g)) {
    if (Object.hasOwn(caps, name)) {
      assert.ok(!Object.hasOwn(stated, name), `README states ${name} twice`);
      stated[name] = Number(value);
    }
  }
  assert.deepEqual(stated, caps);
  assert.deepEqual(config.agent.state, { repository: 'cgwalters-forge/tracker', issue: 718 });
  for (const other of [config.agent.requests, config.agent.log]) {
    assert.ok(other.repository.toLowerCase() !== config.agent.state.repository.toLowerCase()
      || other.issue !== config.agent.state.issue);
  }
  assert.ok(board.follow.includes(config.agent.state.repository));
  assert.equal(config.agent.tracker, 'cgwalters-forge/tracker');
  assert.match(config.agent.project, /^PVT_/);
});

test('supervisor requests and sweeps share one agent group and keep preview read-only', () => {
  const board = JSON.parse(fs.readFileSync(path.join(root, '.github/poll/agent-board.json')));
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
  assert.ok(workflow.includes(`github.event.comment.user.login == '${board.operator}'`));
  assert.ok(workflow.includes(`github.event.issue.number == ${config.agent.requests.issue}`));
  assert.match(workflow, /github.event.issue.locked == true &&\n +!github.event.issue.pull_request/);
  assert.match(workflow, /issue_comment:\n +types: \[created\]/);
  assert.match(workflow, /prompt:\n +description:.*\n +type: string/);
  assert.match(workflow, /cron: '7 \*\/2 \* \* \*'/);
  // The poll's prompt-less dispatches are health passes; in supervisor-agent
  // every poll pass would evict a pending prompt (#763).
  assert.ok(workflow.includes("(github.event_name == 'issue_comment' && github.event.comment.user.login != 'cgwalters' && format('supervisor-ignored-{0}', github.run_id)) || ((github.event.schedule == '*/15 * * * *' || github.event_name == 'workflow_run' || (github.event_name == 'workflow_dispatch' && inputs.prompt == '')) && 'supervisor-health') || 'supervisor-agent'"));
  // Serialize whole runs, not just agent: trigger treats a workflow finishing
  // execute as active too, which otherwise discards manual prompts. The
  // fifteen-minute passes stay out of that group so they cannot evict a
  // pending prompt; the executor keeps its own group across both.
  assert.ok(workflow.indexOf('concurrency:') < workflow.indexOf('\njobs:'));
  assert.equal(workflow.match(/concurrency:/g)?.length, 2);
  assert.match(workflow.split('  execute:\n')[1], /concurrency:\n +group: supervisor-execute\n +cancel-in-progress: false/);
  assert.match(workflow, /if: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.prompt != '' && steps.trigger.outputs.act != 'true' && [^\n]*\n +run: \|\n.*::error::.*\n +exit 1/);
  assert.match(workflow, /config: .github\/agentic-job\/supervisor.toml/);
  for (const name of ['Build agent-board at the pinned revision', 'Perform the validated requests']) {
    const execute = workflow.split('  execute:\n')[1];
    assert.ok(execute.includes(`- name: ${name}\n        if: \${{ vars.SUPERVISOR == 'apply' }}`));
  }
  const preview = workflow.split('      - name: Preview requests without applying\n')[1]
    .split('      - name: Perform the validated requests\n')[0];
  assert.match(preview, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.doesNotMatch(preview, /CGWALTERS_BOT_PAT|supervise execute/);
  const runner = fs.readFileSync(path.join(root, '.github/agentic-job/supervisor.toml'), 'utf8');
  assert.match(runner, /\[session\]\nwatch-item = true/);
  assert.doesNotMatch(runner, /listen = true/);
});

test('supervisor tasks accept only operator comments and remain bounded', () => {
  const { compose, commentEndpoint } = require('./supervisor-profile.cjs');
  const config = { operator: 'owner', requests: { repository: 'o/r', issue: 1 } };
  const event = { comment: { user: { login: 'owner' }, body: 'public request' }, issue: { number: 1, locked: true } };
  for (const changed of [
    { ...event, comment: { ...event.comment, user: { login: 'outsider' } } },
    { ...event, issue: { number: 2, locked: true } },
    { ...event, issue: { number: 1, locked: false } },
    { ...event, issue: { ...event.issue, pull_request: {} } },
  ]) assert.throws(() => compose('policy', '', changed, 'profile', config), /Not an operator/);
  const task = compose('policy', '', event, 'profile', config);
  for (const expected of ['public request', 'profile', 'policy', 'docs/operator-notes.md', 'health.json', 'agent.state']) {
    assert.ok(task.includes(expected));
  }
  assert.ok(compose('policy', 'manual request', {}, 'profile', config).includes('manual request'));
  assert.throws(() => compose('policy', 'x'.repeat(48 * 1024), {}, 'profile', config), /exceeds/);
  assert.equal(commentEndpoint('https://github.com/o/r/issues/1#issuecomment-2', config.requests), 'repos/o/r/issues/comments/2');
  for (const url of ['https://github.com/o/r/issues/2#issuecomment-2', 'https://evil.invalid/o/r/issues/1#issuecomment-2', 'https://github.com/o/r/issues/1#issuecomment-2/more']) {
    assert.throws(() => commentEndpoint(url, config.requests), /not on the requests issue/);
  }
});

test('the poll chain starts supervisor passes, paced from the previous health artifact', () => {
  assert.match(workflow, /\n  workflow_run: # zizmor: ignore\[dangerous-triggers\]\n +workflows: \[poll\]\n +types: \[completed\]\n/);
  // The crons stay as a fallback.
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  const health = workflow.split('\n  health:\n')[1].split('\n  agent:\n')[0];
  const order = ['- name: Previous health report', '- name: Whether a pass is due', '- name: Build agent-board',
    '- name: Read-only health snapshot', '- uses: actions/upload-artifact', '- name: Whether the agent runs'];
  assert.deepEqual(order.map(step => health.indexOf(step)), order.map(step => health.indexOf(step)).sort((a, b) => a - b));
  assert.match(health, /id: due\n[\s\S]*?EVENT: \$\{\{ github.event_name \}\}\n +PROMPT: \$\{\{ inputs.prompt \}\}\n +run: node .github\/poll\/supervisor-due.cjs\n/);
  for (const step of order.slice(2)) {
    assert.match(health.split(step)[1], /^.*\n( +id: \w+\n| +#.*\n)* +if: \$\{\{ (!cancelled\(\) && )?steps.due.outputs.health == 'true'( && hashFiles\('health.json'\) != '')? \}\}\n/);
  }
  // A failed pass uploads no times.json that would hide the last report.
  assert.ok(health.includes("if: ${{ !cancelled() && steps.due.outputs.health == 'true' && hashFiles('health.json') != '' }}"));
  assert.match(health, /path: \|\n +health.json\n +times.json\n/);
  // The sweep is decided by the pacing step, not by which cron fired.
  assert.match(health, /DAILY: \$\{\{ steps.due.outputs.daily == 'true' && '--daily' \|\| '' \}\}/);
  assert.doesNotMatch(workflow, /github.event.schedule == '7/);
});

test('a poll-started pass within fifteen minutes skips, and a sweep is due after two hours', () => {
  const { due } = require('./supervisor-due.cjs');
  const now = Date.parse('2026-10-17T20:20:00Z');
  const ago = minutes => new Date(now - minutes * 60000).toISOString();
  const recent = { health: ago(14), sweep: ago(60) };
  assert.deepEqual(due('workflow_run', recent, now), { health: false, daily: false, times: recent });
  assert.deepEqual(due('workflow_run', { health: ago(15), sweep: ago(60) }, now),
    { health: true, daily: false, times: { health: ago(0), sweep: ago(60) } });
  assert.deepEqual(due('workflow_run', { health: ago(30), sweep: ago(120) }, now),
    { health: true, daily: true, times: { health: ago(0), sweep: ago(0) } });
  // Not limited: the fallback crons and explicit requests; the latter always
  // bypass the cooldown, and the sweep cron only when a sweep is due.
  for (const event of ['schedule', 'issue_comment']) assert.equal(due(event, recent, now).health, true);
  assert.equal(due('workflow_dispatch', recent, now, 'a request').health, true);
  assert.equal(due('schedule', recent, now).daily, false);
  assert.equal(due('workflow_dispatch', recent, now, 'a request').daily, true);
  assert.equal(due('issue_comment', recent, now).daily, true);
  // The poll's prompt-less dispatch every pass (#763) is paced as the chain.
  for (const previous of [recent, { health: ago(15), sweep: ago(60) }, { health: ago(30), sweep: ago(120) }]) {
    assert.deepEqual(due('workflow_dispatch', previous, now, ''), due('workflow_run', previous, now));
  }
  assert.deepEqual(due('workflow_dispatch', recent, now), due('workflow_run', recent, now));
  // No previous artifact, an old one without times, or a time in the future.
  for (const previous of [{}, { health: 'garbage' }, { health: ago(-60), sweep: ago(-60) }]) {
    assert.deepEqual(due('workflow_run', previous, now), { health: true, daily: true, times: { health: ago(0), sweep: ago(0) } });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-due-'));
  try {
    const run = previous => {
      fs.rmSync(path.join(dir, 'previous-health'), { recursive: true, force: true });
      if (previous !== undefined) {
        fs.mkdirSync(path.join(dir, 'previous-health'));
        fs.writeFileSync(path.join(dir, 'previous-health/times.json'), previous);
      }
      fs.writeFileSync(path.join(dir, 'output'), '');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'supervisor-due.cjs')], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, EVENT: 'workflow_run', RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output') },
      });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(path.join(dir, 'output'), 'utf8');
    };
    assert.equal(run(JSON.stringify({ health: new Date().toISOString(), sweep: new Date().toISOString() })), 'health=false\ndaily=false\n');
    for (const previous of [undefined, 'not json', 'null']) assert.equal(run(previous), 'health=true\ndaily=true\n');
    const times = JSON.parse(fs.readFileSync(path.join(dir, 'times.json'), 'utf8'));
    assert.ok(Date.now() - Date.parse(times.health) < 60000 && times.sweep === times.health);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('previous health uses completed runs even when an agent job failed', () => {
  const step = workflow.split('      - name: Previous health report\n')[1].split('      # Before the build')[0];
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
    assert.equal(commands[0][commands[0].indexOf('--limit') + 1], '50');
    assert.equal(commands[0][commands[0].indexOf('--json') + 1], 'databaseId,conclusion');
    const filtered = spawnSync('jq', ['-r', commands[0][commands[0].indexOf('--jq') + 1]], {
      encoding: 'utf8',
      input: JSON.stringify([
        ...Array.from({ length: 8 }, (_, i) => ({ databaseId: 11 - i, conclusion: 'skipped' })),
        { databaseId: 3, conclusion: 'success' },
        { databaseId: 2, conclusion: 'failure' },
        { databaseId: 1, conclusion: 'success' },
      ]),
    });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.equal(filtered.stdout, '3\n2\n1\n');
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
    const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
    // Empty checks and no --daily return before any API request. Still load the
    // same settings and Policy as execute, so invalid caps fail in review.
    const run = supervisor => spawnSync(process.env.AGENT_BOARD, ['supervise', 'trigger',
      '--config', '.github/poll/agent-board.json', '--supervisor-config', supervisor,
      '--pools', '.github/agentic-job/pools.json', '--health', health], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GH_TOKEN: 'test-key-not-secret',
        GITHUB_REPOSITORY: config.agent.requests.repository, GITHUB_RUN_ID: '1' },
    });
    const result = run('.github/supervisor/config.json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'act=false\n');
    // These proposed caps must remain valid; this check must not freeze policy.
    Object.assign(config.agent, { maxDispatchesPerPass: 4, maxDispatchesPerDay: 40 });
    Object.assign(config.agent.dailyCaps, { create_issue: 15, remove_needs_human: 12 });
    const changed = path.join(dir, 'config.json');
    fs.writeFileSync(changed, JSON.stringify(config));
    const proposed = run(changed);
    assert.equal(proposed.status, 0, proposed.stderr);
    config.agent.dailyCaps.status_update = 4;
    fs.writeFileSync(changed, JSON.stringify(config));
    const refused = run(changed);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /status updates are capped at one per day/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI builds the supervisor pin and enables the shared CLI test', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = ci.split('\n  test:\n')[1].split('\n  lint:\n')[0];
  assert.ok(job.indexOf('run: just build-supervisor-agent-board') < job.indexOf('run: just test'));
  assert.match(job, /AGENT_BOARD: \$\{\{ runner.temp \}\}\/agent-board\/bin\/agent-board/);
});
