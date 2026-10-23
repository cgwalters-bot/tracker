const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/supervisor.yml'), 'utf8');
// The folded (>-) workflow concurrency group and health `if`, as JavaScript.
const folded = (key, indent) => new RegExp(`^${' '.repeat(indent)}${key}: >-\\n((?:${' '.repeat(indent + 2)}.*\\n)+)`, 'm')
  .exec(workflow)[1].split('\n').map(line => line.trim()).filter(Boolean).join(' ');
const groupExpression = /^\$\{\{ (.*) \}\}$/.exec(folded('group', 2))[1];
const healthCondition = folded('if', 4);

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
  assert.match(workflow, /actions\/artifacts\?name=supervisor-health&per_page=10"/);
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
  // Unset variables fall back to this deployment's config.
  assert.equal(workflow.match(new RegExp(`github\\.event\\.comment\\.user\\.login == \\(vars\\.OPERATOR \\|\\| '${board.operator}'\\)`, 'g'))?.length, 2);
  assert.equal(workflow.split(`github.event.issue.number == fromJSON(vars.SUPERVISOR_REQUESTS_ISSUE || '${config.agent.requests.issue}')`).length, 3);
  assert.match(workflow, /github.event.issue.locked == true &&\n +!github.event.issue.pull_request/);
  assert.match(workflow, /issue_comment: # zizmor: ignore\[dangerous-triggers\]\n +types: \[created\]/);
  assert.match(workflow, /prompt:\n +description:.*\n +type: string/);
  assert.match(workflow, /cron: '7 \*\/2 \* \* \*'/);
  // The poll's prompt-less dispatches are health passes; in supervisor-agent
  // every poll pass would evict a pending prompt (#763).
  // A run health skips gets its own group, so it cannot evict a pending run
  // (#803); the others go to supervisor-health or supervisor-agent.
  assert.ok(groupExpression.startsWith(`(!(${healthCondition}) && format('supervisor-ignored-{0}', github.run_id))`));
  const operator = { user: { login: board.operator } };
  const requests = { number: config.agent.requests.issue, locked: true };
  const ref = 'refs/heads/main';
  for (const [event, expected] of [
    [{ event_name: 'issue_comment', event: { comment: operator, issue: requests } }, 'supervisor-agent'],
    [{ event_name: 'issue_comment', event: { comment: operator, issue: { number: 800, locked: false } } }, 'supervisor-ignored-42'],
    [{ event_name: 'issue_comment', event: { comment: operator, issue: { ...requests, locked: false } } }, 'supervisor-ignored-42'],
    [{ event_name: 'issue_comment', event: { comment: operator, issue: { ...requests, pull_request: { url: 'x' } } } }, 'supervisor-ignored-42'],
    [{ event_name: 'issue_comment', event: { comment: { user: { login: 'outsider' } }, issue: requests } }, 'supervisor-ignored-42'],
    [{ event_name: 'workflow_dispatch', inputs: { prompt: 'do it' } }, 'supervisor-agent'],
    [{ event_name: 'workflow_dispatch', inputs: { prompt: 'do it' }, ref: 'refs/heads/other' }, 'supervisor-ignored-42'],
    [{ event_name: 'workflow_dispatch', inputs: { prompt: '' } }, 'supervisor-health'],
    [{ event_name: 'workflow_dispatch', inputs: { prompt: '' }, ref: 'refs/heads/other' }, 'supervisor-ignored-42'],
    [{ event_name: 'workflow_run' }, 'supervisor-health'],
    [{ event_name: 'schedule', event: { schedule: '*/15 * * * *' } }, 'supervisor-health'],
    [{ event_name: 'schedule', event: { schedule: '7 */2 * * *' } }, 'supervisor-agent'],
  ]) {
    const context = {
      format: (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[i]),
      fromJSON: JSON.parse,
      vars: {},
      inputs: event.inputs ?? {},
      github: {
        event_name: event.event_name, run_id: 42, ref: event.ref ?? ref,
        event: { repository: { default_branch: 'main' }, ...event.event },
      },
    };
    const group = vm.runInNewContext(groupExpression, context);
    assert.equal(group, expected, JSON.stringify(event));
    assert.equal(vm.runInNewContext(healthCondition, context), !group.startsWith('supervisor-ignored-'), JSON.stringify(event));
  }
  // Another deployment's variables replace the defaults rather than add to them.
  const vars = { OPERATOR: 'other-operator', SUPERVISOR_REQUESTS_ISSUE: '9' };
  for (const [login, number, expected] of [
    ['other-operator', 9, 'supervisor-agent'],
    [board.operator, 9, 'supervisor-ignored-42'],
    ['other-operator', config.agent.requests.issue, 'supervisor-ignored-42'],
  ]) {
    const context = {
      format: (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[i]), fromJSON: JSON.parse, vars, inputs: {},
      github: { event_name: 'issue_comment', run_id: 42, ref, event: { repository: { default_branch: 'main' },
        comment: { user: { login } }, issue: { number, locked: true } } },
    };
    assert.equal(vm.runInNewContext(groupExpression, context), expected, login);
    assert.equal(vm.runInNewContext(healthCondition, context), expected === 'supervisor-agent', login);
  }
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

test('the supervisor profile comes from the configured repository at a full commit', () => {
  const { sources } = require('./supervisor-profile.cjs');
  const ref = 'b'.repeat(40);
  assert.deepEqual(sources({ repository: 'owner/home', ref }), {
    profile: `repos/owner/home/contents/.github/agentic-job/profiles/supervisor.md?ref=${ref}`,
    skill: `repos/owner/home/contents/skills/supervisor/SKILL.md?ref=${ref}`,
  });
  for (const profile of [undefined, {}, { repository: 'owner/home', ref: 'main' }, { repository: 'owner/home', ref: ref.slice(1) },
    { repository: 'owner/home/../x', ref }, { repository: 'owner/home?x=1', ref }, { repository: 'owner', ref },
    { repository: 'owner/..', ref }, { repository: '../home', ref }]) {
    assert.throws(() => sources(profile), /agent.profile/, JSON.stringify(profile));
  }
  // This deployment's agenthome, at the commit the profile was reviewed at.
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
  assert.deepEqual(config.agent.profile, { repository: 'cgwalters-forge/agenthome', ref: '7ba2e215d770074f9c49bfc387bb57259ec013a3' });
  assert.doesNotThrow(() => sources(config.agent.profile));
});

test('the crons start supervisor passes, paced from the previous health artifact', () => {
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /cron: '\*\/15 \* \* \* \*'/);
  const health = workflow.split('\n  health:\n')[1].split('\n  agent:\n')[0];
  const order = ['- name: Previous health report', '- name: Whether a pass is due', '- name: Build agent-board',
    '- name: Read-only health snapshot', '- uses: actions/upload-artifact', '- name: Whether a check newly fails',
    '- name: Whether the agent runs'];
  assert.deepEqual(order.map(step => health.indexOf(step)), order.map(step => health.indexOf(step)).sort((a, b) => a - b));
  assert.ok(order.every(step => health.includes(step)));
  assert.match(health, /id: due\n[\s\S]*?EVENT: \$\{\{ github.event_name \}\}\n +PROMPT: \$\{\{ inputs.prompt \}\}\n +READ: \$\{\{ steps.previous.outputs.read \}\}\n +run: node .github\/poll\/supervisor-due.cjs\n/);
  for (const step of order.slice(2)) {
    assert.match(health.split(step)[1], /^.*\n( +id: \w+\n| +#.*\n)* +if: \$\{\{ (!cancelled\(\) && )?steps.due.outputs.health == 'true'( && hashFiles\('health.json'\) != '')?( && steps.repeat.outputs.skip != 'true')? \}\}\n/);
  }
  // Only the trigger is gated on the repeat check, which sees the same --daily.
  assert.equal(health.match(/steps.repeat.outputs.skip/g)?.length, 1);
  assert.match(health, /id: trigger\n +if: .* && steps.repeat.outputs.skip != 'true' \}\}\n/);
  assert.match(health, /id: repeat\n[^-]*continue-on-error: true\n[\s\S]*?DAILY: \$\{\{ steps.due.outputs.daily == 'true' && '--daily' \|\| '' \}\}\n +run: node .github\/poll\/supervisor-repeat.cjs\n/);
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
  // A previous report that could not be looked up is not an absent one: the
  // chain waits rather than sweeping every pass (#814); only an explicit
  // request bypasses the cooldown.
  for (const event of ['workflow_run', 'workflow_dispatch']) {
    assert.deepEqual(due(event, {}, now, '', false), { health: false, daily: false, times: { health: null, sweep: null } });
  }
  assert.deepEqual(due('schedule', {}, now, '', false), { health: true, daily: false, times: { health: ago(0), sweep: null } });
  assert.equal(due('workflow_dispatch', {}, now, 'a request', false).daily, true);
  assert.equal(due('issue_comment', {}, now, '', false).daily, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-due-'));
  try {
    const run = (previous, read = 'true') => {
      fs.rmSync(path.join(dir, 'previous-health'), { recursive: true, force: true });
      if (previous !== undefined) {
        fs.mkdirSync(path.join(dir, 'previous-health'));
        fs.writeFileSync(path.join(dir, 'previous-health/times.json'), previous);
      }
      fs.writeFileSync(path.join(dir, 'output'), '');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'supervisor-due.cjs')], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, EVENT: 'workflow_run', READ: read, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output') },
      });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(path.join(dir, 'output'), 'utf8');
    };
    assert.equal(run(JSON.stringify({ health: new Date().toISOString(), sweep: new Date().toISOString() })), 'health=false\ndaily=false\n');
    for (const previous of [undefined, 'not json', 'null']) assert.equal(run(previous), 'health=true\ndaily=true\n');
    const times = JSON.parse(fs.readFileSync(path.join(dir, 'times.json'), 'utf8'));
    assert.ok(Date.now() - Date.parse(times.health) < 60000 && times.sweep === times.health);
    // The read step failed and set no output.
    assert.equal(run(undefined, ''), 'health=false\ndaily=false\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('standing failures leave the agent to the sweep only when enabled (#804)', () => {
  const { repeat } = require('./supervisor-repeat.cjs');
  let pass = 0;
  const report = (...failing) => ['broker', 'release', 'held', 'idle'].map(id => ({
    id, status: failing.includes(id) ? 'fail' : 'warn', evidence: [`https://example.invalid/${id}/${pass++}`],
  }));
  const standing = report('broker', 'release');
  // Same failing set, new evidence: skipped. Off, a sweep or a request: not.
  assert.deepEqual(repeat(true, false, standing, report('broker', 'release')), { skip: true, fresh: [] });
  assert.equal(repeat(undefined, false, standing, standing).skip, false);
  assert.equal(repeat(false, false, standing, standing).skip, false);
  assert.equal(repeat(true, true, standing, standing).skip, false);
  // A newly failing check goes to the trigger, even if another stopped.
  assert.deepEqual(repeat(true, false, report('broker', 'held'), standing), { skip: false, fresh: ['held'] });
  assert.equal(repeat(true, false, report('broker'), standing).skip, true);
  // No readable previous report: every failure is new.
  assert.deepEqual(repeat(true, false, standing, undefined), { skip: false, fresh: ['broker', 'release'] });
  assert.equal(repeat(true, false, standing, { not: 'a list' }).skip, false);
  // Nor a current report it cannot read, whatever the previous one says.
  for (const current of [undefined, { checks: standing }]) assert.equal(repeat(true, false, current, standing).skip, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-repeat-'));
  try {
    const run = (enabled, previous, daily = '') => {
      fs.mkdirSync(path.join(dir, '.github/supervisor'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.github/supervisor/config.json'),
        JSON.stringify({ agent: enabled === undefined ? {} : { skipUnchangedFailures: enabled } }));
      fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify(standing));
      fs.rmSync(path.join(dir, 'previous-health'), { recursive: true, force: true });
      if (previous !== undefined) {
        fs.mkdirSync(path.join(dir, 'previous-health'));
        fs.writeFileSync(path.join(dir, 'previous-health/health.json'), previous);
      }
      fs.writeFileSync(path.join(dir, 'output'), '');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'supervisor-repeat.cjs')], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, DAILY: daily, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output') },
      });
      assert.equal(result.status, 0, result.stderr);
      return fs.readFileSync(path.join(dir, 'output'), 'utf8');
    };
    const same = JSON.stringify(report('broker', 'release'));
    assert.equal(run(true, same), 'skip=true\n');
    assert.equal(run(true, same, '--daily'), 'skip=false\n');
    assert.equal(run(undefined, same), 'skip=false\n');
    for (const previous of [undefined, 'not json']) assert.equal(run(true, previous), 'skip=false\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The shipped switch is off.
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/supervisor/config.json')));
  assert.equal(config.agent.skipUnchangedFailures, false);
});

test('previous health reads the newest report of this workflow and says whether it could (#814)', () => {
  const step = workflow.split('      - name: Previous health report\n')[1].split('      # Before the build')[0];
  assert.match(step, /^ +id: previous\n +continue-on-error: true\n/);
  const script = step.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-previous-'));
  try {
    // The mock answers each gh api call from the fixture through the step's
    // own --jq filter, so the filters are what is tested.
    const mock = path.join(dir, 'gh');
    fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const body = args[1].includes('/actions/artifacts?') ? fixture.artifacts : fixture.runs[args[1].split('/').pop()];
  if (body === undefined) process.exit(1);
  const jq = spawnSync('jq', ['-r', args[args.indexOf('--jq') + 1]], { input: JSON.stringify(body), stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(jq.status);
}
const dir = args[args.indexOf('--dir') + 1];
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/health.json', JSON.stringify([{ id: 'broker', run: args[2] }]));
if (fixture.downloadFails) process.exit(1);
`, { mode: 0o700 });
    const calls = path.join(dir, 'calls');
    const run = fixture => {
      for (const file of ['calls', 'output', 'previous-health', 'previous-download']) fs.rmSync(path.join(dir, file), { recursive: true, force: true });
      fs.writeFileSync(path.join(dir, 'output'), '');
      fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture));
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: path.join(dir, 'fixture.json'),
          CALLS: calls, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'output'), GITHUB_REPOSITORY: 'o/r', DEFAULT_BRANCH: 'main' },
      });
      let report;
      try { report = JSON.parse(fs.readFileSync(path.join(dir, 'previous-health/health.json')))[0].run; } catch {}
      const commands = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [];
      return { status: result.status, output: fs.readFileSync(path.join(dir, 'output'), 'utf8'), report, commands };
    };
    const artifact = (id, created, expired = false) => ({ expired, created_at: created, workflow_run: { id } });
    const ours = id => ({
      id, path: '.github/workflows/supervisor.yml', event: 'workflow_run', head_branch: 'main',
      repository: { id: 1 }, head_repository: { id: 1 },
    });
    const fixture = {
      artifacts: { artifacts: [
        artifact(5, '2026-10-21T10:00:00Z'),
        artifact(9, '2026-10-21T10:09:00Z'),
        artifact(8, '2026-10-21T10:08:00Z'),
        artifact(7, '2026-10-21T10:07:00Z', true),
        artifact(6, '2026-10-21T10:06:00Z'),
        artifact(4, '2026-10-21T10:05:00Z'),
      ] },
      runs: {
        9: { ...ours(9), head_repository: { id: 2 } },
        8: { ...ours(8), head_branch: 'other' },
        6: { ...ours(6), event: 'pull_request' },
        4: { ...ours(4), path: '.github/workflows/dispatch.yml' },
        5: ours(5),
      },
    };
    // Newest first; an expired one, a fork's, another branch's, a pull
    // request's and another workflow's are passed over.
    let result = run(fixture);
    assert.equal(result.status, 0);
    assert.equal(result.output, 'read=true\n');
    assert.equal(result.report, '5');
    assert.match(result.commands[0][1], /^repos\/o\/r\/actions\/artifacts\?name=supervisor-health&per_page=10$/);
    assert.deepEqual(result.commands.slice(1).map(args => args.slice(0, 3)), [
      ...[9, 8, 6, 4, 5].map(run => ['api', `repos/o/r/actions/runs/${run}`, '--jq']), ['run', 'download', '5'],
    ]);
    // None at all is read: a first pass, or none for two days.
    for (const artifacts of [[], [artifact(7, '2026-10-21T10:07:00Z', true)]]) {
      result = run({ artifacts: { artifacts }, runs: {} });
      assert.deepEqual([result.status, result.output, result.report], [0, 'read=true\n', undefined]);
    }
    // A failed listing, run lookup or download is not, nor a page others'
    // artifacts fill; a failed download leaves no partial report.
    const others = { ...fixture, artifacts: { artifacts: fixture.artifacts.artifacts.filter(a => a.workflow_run.id !== 5) } };
    for (const failing of [{ runs: {} }, { ...fixture, runs: {} }, { ...fixture, downloadFails: true }, others]) {
      result = run(failing);
      assert.notEqual(result.status, 0);
      assert.equal(result.output, '');
      assert.equal(result.report, undefined);
    }
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
