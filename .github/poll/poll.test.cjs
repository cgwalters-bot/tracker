'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { CONFIG, poll } = require('./poll.cjs');
const { MARKER } = require('./broker.cjs');

const env = { AGENT_BOARD: '/trusted/agent-board', POLL_STATE: '/trusted/state.json' };

test('usage refresh is independent of poll activity and survives build failures without writing in dry runs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/poll.yml'), 'utf8');
  const step = workflow.match(/      - name: Refresh usage\n([\s\S]*?)(?=      - name:)/);
  assert.ok(step, 'job-token polls need explicit dispatch, not only workflow_run');
  assert.match(step[1], /if: \$\{\{ !inputs\.dry-run \}\}/);
  assert.match(step[1], /continue-on-error: true/);
  assert.match(step[1], /timeout-minutes: 1/);
  assert.match(step[1], /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step[1], /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(step[1], /run: just refresh-usage/);
  assert.ok(step.index < workflow.indexOf('        id: build'));
  const recipes = fs.readFileSync(path.join(__dirname, '../../Justfile'), 'utf8');
  assert.match(recipes, /refresh-usage:\n    gh workflow run usage\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$DEFAULT_BRANCH"/);
});

test('every poll pass starts the supervisor, which paces it and keeps one pending start', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/poll.yml'), 'utf8');
  const step = workflow.match(/      - name: Start supervisor\n([\s\S]*?)(?=      - name:)/);
  assert.ok(step, 'job-token polls raise no workflow_run for supervisor.yml (#763)');
  assert.match(step[1], /if: \$\{\{ !inputs\.dry-run \}\}/);
  assert.match(step[1], /continue-on-error: true/);
  assert.match(step[1], /timeout-minutes: 1/);
  assert.match(step[1], /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step[1], /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(step[1], /run: just start-supervisor/);
  assert.ok(step.index < workflow.indexOf('        id: build'));
  const recipes = fs.readFileSync(path.join(__dirname, '../../Justfile'), 'utf8');
  // No prompt: supervisor.yml paces a prompt-less dispatch as the poll chain.
  assert.match(recipes, /start-supervisor:\n    gh workflow run supervisor\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$DEFAULT_BRANCH"\n/);
  const supervisor = fs.readFileSync(path.join(__dirname, '../workflows/supervisor.yml'), 'utf8');
  assert.match(supervisor, /github\.event_name == 'workflow_dispatch' && inputs\.prompt == ''\)\) && 'supervisor-health'/);
  assert.match(supervisor, /^concurrency:\n  group: .*\n  cancel-in-progress: false\n/m);
});

test('poll starts only the enabled default-branch release train before expensive work', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/poll.yml'), 'utf8');
  const step = workflow.match(/      - name: Start release train\n([\s\S]*?)(?=      - name:)/);
  assert.ok(step);
  assert.match(step[1], /if: \$\{\{ !inputs\.dry-run && \(vars\.RELEASE_TRAIN == 'dry-run' \|\| vars\.RELEASE_TRAIN == 'apply'\) \}\}/);
  assert.match(step[1], /continue-on-error: true/);
  assert.match(step[1], /timeout-minutes: 1/);
  assert.match(step[1], /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step[1], /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(step[1], /run: just start-release-train/);
  assert.ok(step.index < workflow.indexOf('        id: build'));
  // Both ends refuse other branches: the poll job that dispatches, and the train's pass.
  assert.match(workflow, /  poll:\n    if: \$\{\{ github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \}\}/);
  const recipes = fs.readFileSync(path.join(__dirname, '../../Justfile'), 'utf8');
  assert.match(recipes, /start-release-train:\n    gh workflow run release-train\.yml --repo "\$GITHUB_REPOSITORY" --ref "\$DEFAULT_BRANCH"/);
  const train = fs.readFileSync(path.join(__dirname, '../workflows/release-train.yml'), 'utf8');
  assert.match(train, /concurrency:\n  group: release-train\n  cancel-in-progress: false/);
  assert.match(train, /cron: '23 \* \* \* \*'/);
  assert.match(train, /  pass:\n    if: \$\{\{ \(vars\.RELEASE_TRAIN == 'dry-run' \|\| vars\.RELEASE_TRAIN == 'apply'\) && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) \}\}/);
});

// No outage issue is open.
const none = async () => [];
const api = issues => async (token, method, p) => {
  assert.equal(token, 'bot-token');
  assert.equal(method, 'GET');
  assert.equal(p, '/repos/configured/repo/issues?state=open&labels=outage&per_page=100');
  return issues;
};
const outage = (over = {}) => ({ number: 9, html_url: 'https://github.com/configured/repo/issues/9', user: { login: CONFIG.author },
  body: `${MARKER}\nBroker unreachable`, updated_at: new Date().toISOString(), ...over });
const applyEnv = { ...env, GH_TOKEN: 'bot-token', GITHUB_REPOSITORY: 'configured/repo' };

test('one actor, preview by default, with only repository-owned configuration', async () => {
  for (const [argv, mode] of [[[], '--dry-run'], [['--dry-run'], '--dry-run'], [['--apply'], '--apply']]) {
    let calls = 0;
    const result = await poll(argv, env, (binary, args, options) => {
      calls++;
      assert.equal(binary, env.AGENT_BOARD);
      assert.deepEqual(args, ['poll', mode, '--config', '.github/poll/agent-board.json', '--state', env.POLL_STATE]);
      assert.equal(options.env, env);
      assert.equal(options.timeout, 300_000);
      assert.equal(options.maxBuffer, 4 * 1024 * 1024);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      return { status: 0, stdout: 'next-due-seconds=300\n', stderr: '' };
    }, argv[0] === '--apply' ? none : () => assert.fail('a preview reads no outage'));
    assert.equal(calls, 1);
    assert.equal(result.status, 0);
    assert.equal(result.again, true);
  }
  for (const args of [['--other'], ['--apply', '--dry-run'], ['--apply', '--apply']]) {
    await assert.rejects(poll(args, env), /usage/);
  }
  await assert.rejects(poll([], {}), /required/);
});

test('an open, fresh outage issue makes an applying pass a preview on a copy of the state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-held-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, '{"saved":true}');
  const input = { ...applyEnv, POLL_STATE: state, RUNNER_TEMP: dir };
  let args;
  const result = await poll(['--apply'], input, (_binary, a) => {
    args = a;
    assert.equal(fs.readFileSync(a.at(-1), 'utf8'), '{"saved":true}');
    fs.writeFileSync(a.at(-1), '{"advanced":true}');
    return { status: 0, stdout: 'next-due-seconds=300\n' };
  }, api([outage()]));
  assert.equal(args[1], '--dry-run');
  assert.notEqual(args.at(-1), state);
  assert.equal(fs.readFileSync(state, 'utf8'), '{"saved":true}');
  assert.ok(result.stdout.startsWith('held: broker outage https://github.com/configured/repo/issues/9; this pass previews only\n'));
  assert.equal(result.status, 0);
  assert.equal(result.again, false);
});

test('an outage issue that is not the bot\'s, not marked or stale does not hold', async () => {
  const stale = new Date(Date.now() - 61 * 60_000).toISOString();
  for (const issue of [outage({ user: { login: 'visitor' } }), outage({ body: 'Broker unreachable' }), outage({ updated_at: stale })]) {
    let args;
    const result = await poll(['--apply'], applyEnv, (_binary, a) => { args = a; return { status: 0, stdout: 'next-due-seconds=600\n' }; }, api([issue]));
    assert.deepEqual(args.slice(1), ['--apply', '--config', '.github/poll/agent-board.json', '--state', env.POLL_STATE]);
    assert.doesNotMatch(result.stdout, /^held:/m);
  }
  const result = await poll(['--apply'], applyEnv, () => ({ status: 0, stdout: 'next-due-seconds=600\n' }), api([outage({ updated_at: stale })]));
  assert.match(result.stdout, /^outage issue #9 is stale; not holding$/m);
});

test('an outage issue that cannot be read fails the pass and starts nothing', async () => {
  const result = await poll(['--apply'], applyEnv, () => assert.fail('spawned'), async () => { throw new Error('GET: HTTP 502'); });
  assert.equal(result.status, 1);
  assert.equal(result.again, true);
  assert.match(result.stderr, /HTTP 502/);
});

test('failed, timed out, truncated or malformed passes fail and keep the chain alive', async () => {
  for (const result of [
    { status: 1 }, { status: null, error: new Error('timeout') },
    { status: 0, stdout: '' }, { status: 0, stdout: 'next-due-seconds=0\n' },
    { status: 0, stdout: 'next-due-seconds=21601\n' },
    { status: 1, stdout: 'next-due-seconds=600\n' },
  ]) {
    const output = await poll([], env, () => result);
    assert.equal(output.status, 1);
    assert.equal(output.again, true);
  }
  for (const due of [600, 21600]) {
    const output = await poll([], env, () => ({ status: 0, stdout: `next-due-seconds=300\nnext-due-seconds=${due}\n` }));
    assert.equal(output.status, 0);
    assert.equal(output.again, false);
  }
});

test('adapter emits escaped summary and only its own workflow output', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'agent-board');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("<script>&\\nin-flight=false\\nnext-due-seconds=300");\n', { mode: 0o700 });
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  execFileSync(process.execPath, [path.join(__dirname, 'poll.cjs')], {
    env: { ...process.env, AGENT_BOARD: fake, POLL_STATE: path.join(dir, 'state'), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(fs.readFileSync(output, 'utf8'), 'in-flight=true\n');
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(text, /<script>/);
});

test('real child buffer overflow fails and keeps the chain alive', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-overflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'agent-board');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(5 * 1024 * 1024));\n', { mode: 0o700 });
  const result = await poll([], { ...process.env, AGENT_BOARD: fake, POLL_STATE: path.join(dir, 'state') });
  assert.equal(result.status, 1);
  assert.equal(result.again, true);
});

test('configuration follows review-enabled schedule targets and preserves pool policy', () => {
  const c = require('./agent-board.json');
  // misctool's first workflow needs operator approval before poll follow-up.
  assert.ok(c.schedule.repositories.includes('cgwalters-forge/misctool'));
  assert.ok(!c.follow.includes('cgwalters-forge/misctool'));
  for (const repo of c.schedule.repositories) {
    if (repo !== 'cgwalters-forge/misctool') assert.ok(c.follow.includes(repo), repo);
  }
  const fix = fs.readFileSync(path.join(__dirname, '../agentic-job/fix.toml'), 'utf8');
  for (const repo of c.follow) assert.ok(fix.includes(`"${repo}"`), repo);
  assert.equal(c.dispatchWorkflow, 'dispatch.yml');
  assert.equal(c.reviewWorkflow, 'review.yml');
  // agent-board starts only fix, triage and research runs from these, within
  // the three a pass (its docs/design.md); comment.toml and fix.toml admit
  // exactly those in bootc-dev (D17, docs/operator-notes.md).
  assert.deepEqual(c.operatorComments, { repositories: ['bootc-dev/*'] });
  assert.match(c.operator, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
  // Conflicts share the first-round toil pool: do not spend a bounded fix
  // round on a pool whose conflict runs have returned without a new head.
  assert.equal(c.toilFixPool, 'openai');
  assert.equal(c.kindPools.triage, 'mistral');
  assert.equal(c.kindPools.research, 'mistral');
  // agent-board's refund reads the same issue as the hold: the probe's, here.
  assert.deepEqual(c.brokerOutage, { repository: c.dispatchRepo, author: c.bot, leadSeconds: 1800 });
  const pools = require('../agentic-job/pools.json');
  for (const pool of [...c.fixPools, c.toilFixPool, ...Object.values(c.kindPools)]) assert.ok(pools[pool], pool);
});

// apply cannot push to a repository the bot owns unless that repository opts
// in with accept-owner-branches (#517), so a run there fails after its work
// is done. homegit (#641) and praxis-credential-broker came off for this.
test('no repository the bot owns is a dispatch or fix target unless it opts in', () => {
  const { bot } = require('./agent-board.json');
  // Bot-owned repositories whose default branch has accept-owner-branches
  // naming them, in lowercase; add one only after checking that file is there.
  const optedIn = new Set([]);
  for (const name of ['dispatch.toml', 'fix.toml']) {
    const bounds = fs.readFileSync(path.join(__dirname, '../agentic-job', name), 'utf8');
    const repos = JSON.parse(/^repos = (\[.*\])$/m.exec(bounds.split(/^\[/m)[0])[1]);
    for (const repo of repos) {
      if (optedIn.has(repo.toLowerCase())) continue;
      assert.notEqual(repo.split('/')[0].toLowerCase(), bot.toLowerCase(),
        `${repo} in ${name} is owned by ${bot}: apply cannot push there without its accept-owner-branches; see docs/bring-up.md`);
    }
  }
});

test('blocked fixes can explain themselves without a push or extra write authority', () => {
  const bounds = fs.readFileSync(path.join(__dirname, '../agentic-job/fix.toml'), 'utf8');
  const outputs = bounds.split('[outputs]')[1].split('[unprotected_files]')[0];
  const entries = [...outputs.matchAll(/^([a-z_]+) = (.+)$/gm)];
  assert.deepEqual(entries.map(m => m[1]), [
    'push_to_pull_request_branch', 'add_comment', 'noop', 'missing_tool', 'missing_data',
  ]);
  assert.equal(entries.find(m => m[1] === 'add_comment')[2], '{ max = 1 }');
  assert.match(bounds, /^max_outputs = 3$/m);
  const profile = fs.readFileSync(path.join(__dirname, '../agentic-job/profiles/fix.md'), 'utf8');
  for (const rule of [
    'leave the working tree unchanged', 'one `add_comment` safe output with a `body`',
    'Do not request `push_to_pull_request_branch` or write a replacement series when there is no change to push',
    'Do not invent a patch',
  ]) assert.ok(profile.includes(rule), rule);
});

test('workflow has one acting pass, respects dry-run, and isolates trusted apply state', () => {
  const yml = fs.readFileSync(path.join(__dirname, '../workflows/poll.yml'), 'utf8');
  const job = yml.slice(yml.indexOf('\n  poll:\n'));
  assert.equal((yml.match(/run: just poll /g) ?? []).length, 1);
  assert.doesNotMatch(yml, /node \.github\/poll\/poll.cjs|\n  agent-board:/);
  assert.match(job, /MODE: \$\{\{ inputs.dry-run && '--dry-run' \|\| '--apply' \}\}/);
  assert.match(job, /GH_TOKEN: \$\{\{ secrets\./);
  assert.match(job, /DISPATCH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(job, /run: just build-agent-board/);
  assert.match(job, /POLL_STATE: \$\{\{ runner.temp \}\}\/poll-state.json/);
  assert.match(job, /\$\{\{ runner.temp \}\}\/poll-state.json\n/);
  const justfile = fs.readFileSync(path.join(__dirname, '../../Justfile'), 'utf8');
  assert.match(justfile, /poll \*args:\n +node \.github\/poll\/poll.cjs "\$@"/);
  assert.match(job, /runs-on: ubuntu-26.04/);
  assert.match(job, /if: \$\{\{ github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\) \}\}/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job.slice(0, job.indexOf('steps:')), /continue-on-error/);
  assert.match(job, /name: Restore the state of the last pass\n +if: \$\{\{ !inputs.dry-run \}\}/);
  assert.match(job, /if: \$\{\{ !inputs.dry-run && steps.pass.outcome == 'success' \}\}/);
  assert.equal((job.match(/agent-board-poll-apply-state-/g) ?? []).length, 2);
  assert.match(job, /\.path == "\.github\/workflows\/poll.yml" and .head_repository.id == .repository.id/);
  assert.match(job, /!inputs.dry-run && \(failure\(\) \|\| steps.pass.outputs.in-flight == 'true'\)/);
  const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)[1]);
  const boundedSteps = [...job.matchAll(/^ {8}timeout-minutes: (\d+)$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  const waitMinutes = Number(/WAIT_SECONDS: '(\d+)'/.exec(job)[1]) / 60;
  assert.ok(jobMinutes >= boundedSteps + waitMinutes + 5, 'successor wait plus checkout/setup overhead fit the job');
  for (const step of ['Epic census', 'Coordinator']) assert.ok(yml.includes(`- name: ${step}`));
  assert.ok(yml.includes('node .github/poll/schedule.cjs'));
});

test('pools.json has what dispatch.yml reads, and a well-formed allowance', () => {
  const pools = require('../agentic-job/pools.json');
  for (const [name, pool] of Object.entries(pools)) {
    for (const key of ['agent', 'model', 'budget']) assert.match(pool[key], /^\S+$/, `${name}.${key}`);
    assert.match(pool.budget, /^[1-9]\d*$/, `${name}.budget`);
    if (!('allowance' in pool)) continue;
    const { amount, currency, period, ...rest } = pool.allowance;
    assert.deepEqual(rest, {}, `${name}.allowance`);
    assert.ok(Number.isFinite(amount) && amount > 0, `${name}.allowance.amount`);
    assert.match(currency, /^[A-Z]{3}$/, `${name}.allowance.currency`);
    assert.equal(period, 'calendar-month');
  }
  assert.equal(pools.mistral.budget, '1000');
  assert.deepEqual(pools.mistral.allowance, { amount: 300, currency: 'USD', period: 'calendar-month' });
});

test('dispatch.yml turns on the skills for implement and fix only', () => {
  const dispatch = fs.readFileSync(path.join(__dirname, '../workflows/dispatch.yml'), 'utf8');
  assert.deepEqual(dispatch.match(/^ {6}skills: .*$/gm), ["      skills: ${{ needs.profile.outputs.skilled == 'true' && (inputs.kind == 'implement' || inputs.kind == 'fix') }}"]);
  const profile = kind => fs.readFileSync(path.join(__dirname, `../agentic-job/profiles/${kind}.md`), 'utf8');
  assert.match(profile('implement'), /^Use the implement skill\./);
  assert.doesNotMatch(profile('implement'), /AGENTS\.md|subagent|left undone/);
  assert.doesNotMatch(profile('implement-full'), /\bskill\b/);
  assert.match(profile('implement-full'), /^Implement this issue properly with tests/);
  for (const rule of profile('implement').trim().split(/(?<=\.) /).slice(1)) assert.ok(profile('implement-full').includes(rule), rule);
  assert.doesNotMatch(profile('fix'), /implement skill/);
  for (const kind of ['research', 'triage', 'review']) assert.doesNotMatch(profile(kind), /\bskill\b/);
});

test('dispatch.yml gives an agent without skills the full implement profile', () => {
  const dispatch = fs.readFileSync(path.join(__dirname, '../workflows/dispatch.yml'), 'utf8');
  const stepScript = name => {
    const re = new RegExp(`^ {6}- name: ${name}\\n(?: {8}.*\\n)*? {8}run: \\|\\n((?:(?: {10}.*)?\\n)+)`, 'm');
    const step = re.exec(dispatch)?.[1];
    assert.ok(step, name);
    return step.replace(/^ {10}/gm, '');
  };
  assert.ok(dispatch.indexOf('- name: Resolve the pool') < dispatch.indexOf('- name: Put the profile before the task'));
  const poolStep = stepScript('Resolve the pool');
  const composeStep = stepScript('Put the profile before the task');
  const pools = require('../agentic-job/pools.json');
  const profiles = path.join(__dirname, '../agentic-job/profiles');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const outputs = text => Object.fromEntries([...text.matchAll(/^([a-z]+)=(.*)$/gm)].map(m => [m[1], m[2]]));
  let n = 0;
  const bash = (script, env) => {
    const out = path.join(dir, String(n++));
    fs.writeFileSync(out, '');
    execFileSync('bash', ['-eo', 'pipefail', '-c', script], {
      cwd: path.join(__dirname, '../..'), stdio: 'pipe',
      env: { ...process.env, ...env, GITHUB_OUTPUT: out },
    });
    return fs.readFileSync(out, 'utf8');
  };
  const run = (pool, kind, agent = 'opencode') => {
    try {
      const resolved = outputs(bash(poolStep, { POOL: pool, KIND: kind, AGENT: agent }));
      const composed = bash(composeStep, { KIND: kind, TASK: 'the task', SKILLED: resolved.skilled });
      const task = /^task<<(task-[0-9a-f]{32})\n([\s\S]*)\n\1\n$/.exec(composed)?.[2];
      assert.ok(task, composed);
      return { ...resolved, task };
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      return null;
    }
  };
  const profile = name => fs.readFileSync(path.join(profiles, `${name}.md`), 'utf8');
  const expected = (kind, skilled) => `${profile(!skilled && fs.existsSync(path.join(profiles, `${kind}-full.md`)) ? `${kind}-full` : kind)}\nthe task`;
  for (const [name, pool] of Object.entries(pools)) {
    const skilled = ['claude', 'opencode'].includes(pool.agent);
    for (const kind of ['implement', 'fix', 'triage', 'research', 'review']) {
      const r = run(name, kind, skilled ? 'vibe' : 'claude');
      assert.ok(r, `${kind} on ${name}`);
      assert.equal(r.agent, pool.agent);
      assert.equal(r.skilled, String(skilled));
      assert.equal(r.task, expected(kind, skilled));
    }
  }
  assert.ok(Object.values(pools).some(p => !['claude', 'opencode'].includes(p.agent)));
  assert.ok(Object.values(pools).some(p => ['claude', 'opencode'].includes(p.agent)));
  for (const agent of ['claude', 'opencode', 'fake']) {
    assert.deepEqual(run('', 'implement', agent), { skilled: 'true', agent: '', model: '', budget: '', task: expected('implement', true) });
  }
  assert.deepEqual(run('', 'implement', 'vibe'), { skilled: 'false', agent: '', model: '', budget: '', task: expected('implement', false) });
  assert.equal(run('', 'fix', 'vibe').task, expected('fix', false));
  assert.notEqual(expected('implement', false), expected('implement', true));
  assert.equal(expected('fix', false), expected('fix', true));
  assert.equal(run('nonesuch', 'fix'), null);
  assert.equal(run('', 'implement-full', 'vibe'), null);
});

test('workflows follow our own repositories at main, review.yml excepted, and pin the rest', () => {
  const owner = CONFIG.dispatchRepo.split('/')[0];
  const dir = path.join(__dirname, '../workflows');
  let seen = 0;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.yml'))) {
    for (const [, ref] of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)) {
      seen++;
      // Except review.yml: its verdict is the only gate on .github/ here,
      // so the wrapper it calls moves only by a reviewed change to the pin.
      if (ref.startsWith(`${owner}/`)) assert.match(ref, file === 'review.yml' ? /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/ : /^[\w.-]+\/[\w.\/-]+@main$/, `${file}: ${ref}`);
      else assert.match(ref, /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
  assert.ok(seen > 0);
});

test('review wrapper uses the agentic-job v0.6.2 release pin', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../workflows/review.yml'), 'utf8');
  assert.match(workflow, /^\s+uses: \S+\/cgwalters-review\.yml@d8e22f71b2abbe5f41306a0c7ef1b6c3d2829cac # main, agentic-job v0\.6\.2 \(actions#67\)$/m);
});
