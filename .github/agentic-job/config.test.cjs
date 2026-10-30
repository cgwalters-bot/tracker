const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const hosted = read('hosted.toml');
const experiment = read('acp-experiment.toml');
const dispatch = read('../workflows/dispatch.yml');
const pools = require('./pools.json');
const profile = name => read(`profiles/${name}.md`);
const MARKER = "# The experiment's own tables; everything above is hosted.toml's.\n";

// A run step of dispatch.yml, and what bash running it writes to GITHUB_OUTPUT.
const stepScript = name => {
  const step = new RegExp(`^ {6}- name: ${name}\\n(?: {8}.*\\n)*? {8}run: \\|\\n((?:(?: {10}.*)?\\n)+)`, 'm').exec(dispatch)?.[1];
  assert.ok(step, name);
  return step.replace(/^ {10}/gm, '');
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
let runs = 0;
const runStep = (script, env) => {
  const out = path.join(tmp, String(runs++));
  fs.writeFileSync(out, '');
  execFileSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: path.join(__dirname, '../..'), stdio: 'pipe', env: { ...process.env, ...env, GITHUB_OUTPUT: out } });
  return fs.readFileSync(out, 'utf8');
};

test('acp-experiment.toml is hosted.toml and a child agent, and hosted.toml has none', () => {
  const body = text => text.slice(text.indexOf('[sandbox]\n'));
  const [copy, own] = body(experiment).split(MARKER);
  assert.ok(own, 'the marker before the experiment\'s own tables');
  assert.equal(copy, `${body(hosted)}\n`, 'acp-experiment.toml must keep hosted.toml unchanged');
  assert.doesNotMatch(hosted, /^\[child-agent\]/m);
  assert.match(own, /^\[child-agent\]\nname = "vibe"\nmodel = "zai-glm-5-3"\n/m);
  assert.match(own, /^\[limits\]\nmax-requests = 400\n/m);
  // Every run on the mistral pool, main agent or child, gets GLM a window
  // well over Vibe's 32k default (#651); the copy above holds both files to it.
  assert.match(hosted, /^\[agent\.context-windows\]\n"zai-glm-5-3" = 131072\n/m);
  // The child's model is the mistral pool's, the one dispatch can select.
  assert.equal(pools.mistral.model, 'zai-glm-5-3');
});

// Pool settings may name a tier for its automatic pools (tracker#837), so
// every pool has one; fable's allowance is apart, so only a person spends it.
test('every pool has a tier, and tier-1 and tier-2 each an automatic pool', () => {
  for (const [name, pool] of Object.entries(pools)) {
    assert.ok([1, 2].includes(pool.tier), `${name}.tier`);
    assert.ok(pool.auto === undefined || typeof pool.auto === 'boolean', `${name}.auto`);
  }
  const tier = n => Object.keys(pools).filter(p => pools[p].tier === n && pools[p].auto !== false);
  assert.deepEqual(tier(1), ['claude', 'openai']);
  assert.deepEqual(tier(2), ['mistral']);
  assert.deepEqual([pools.fable.tier, pools.fable.auto], [1, false]);
});

test('dispatch passes the run only a configuration from its closed set', () => {
  assert.deepEqual(dispatch.match(/^ {6}config: .*$/gm), ['      config: ${{ steps.config.outputs.config }}', '      config: ${{ needs.profile.outputs.config }}']);
  assert.match(dispatch, /^ {8}type: choice\n {8}options: \[hosted, acp-experiment\]\n {8}default: hosted$/m);
  const step = stepScript('Resolve the runner configuration');
  const resolve = config => { try { return runStep(step, { CONFIG: config }); } catch { return null; } };
  // A normal dispatch leaves the wrapper its default, hosted.toml.
  assert.equal(resolve('hosted'), 'config=\n');
  assert.equal(resolve('acp-experiment'), 'config=.github/agentic-job/acp-experiment.toml\n');
  for (const config of ['', 'dispatch.toml', '.github/agentic-job/dispatch.toml', 'hosted acp-experiment']) assert.equal(resolve(config), null, config);
});

// The check the wrapper's policy job makes, with the settings it adds for a
// real agent; where agentic-job is not installed (CI) it is skipped.
const agenticJob = spawnSync('agentic-job', ['--version'], { stdio: 'pipe' }).status === 0;

// A session dispatch of supervisor.yml lets in session.yml's operators and origins.
test('supervisor config preserves hosted sandbox and session, without a listener', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const check = file => execFileSync('agentic-job', ['config', '--from', path.join(__dirname, file), '--host'], { encoding: 'utf8' });
  const supervisor = check('supervisor.toml');
  const base = check('hosted.toml');
  for (const table of ['sandbox', 'sandbox.check', 'setup', 'session']) {
    const section = text => text.split(`[${table}]\n`)[1].split('\n[')[0];
    assert.equal(section(supervisor), section(base));
  }
  assert.doesNotMatch(supervisor, /listen = true/);
});

test('agentic-job config takes acp-experiment.toml, and refuses it without the cap', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const check = file => spawnSync('agentic-job', ['config', '--from', file, '--repo', 'o/r',
    '--string', 'agent.name=claude', '--string', 'agent.model=m',
    '--string', 'inference.url=http://127.0.0.1:18080', '--string', 'inference.register=github-oidc',
    '--string', 'inference.audience=a', '--integer', 'limits.timeout-minutes=75', '--integer', 'limits.budget=500'], { stdio: 'pipe' });
  const ok = check(path.join(__dirname, 'acp-experiment.toml'));
  assert.equal(ok.status, 0, String(ok.stderr));
  assert.match(String(ok.stdout), /^\[child-agent\]\nmodel = "zai-glm-5-3"\nname = "vibe"$/m);
  assert.match(String(ok.stdout), /^\[agent\.context-windows\]\nzai-glm-5-3 = 131072$/m);
  // `config` allows up to GLM-5.3's documented 1M (1,048,576) and no more.
  const wide = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-')), 'wide.toml');
  fs.writeFileSync(wide, experiment.replace(/^"zai-glm-5-3" = 131072$/m, '"zai-glm-5-3" = 1048577'));
  const refused = check(wide);
  assert.notEqual(refused.status, 0);
  assert.match(String(refused.stderr), /agent\.context-windows: "zai-glm-5-3" = 1048577, not a number from 1 to 1048576/);
  const uncapped = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-')), 'uncapped.toml');
  fs.writeFileSync(uncapped, experiment.replace(/^max-requests = 400\n/m, ''));
  assert.match(String(check(uncapped).stderr), /child-agent needs limits\.max-requests/);
  assert.equal(execFileSync('agentic-job', ['config', '--from', path.join(__dirname, 'hosted.toml'), '--repo', 'o/r',
    '--string', 'agent.name=fake', '--integer', 'limits.timeout-minutes=75', '--boolean', 'limits.uncapped=true']).includes('child-agent'), false);
});

// Without `ready_when_complete` apply opens every pull request as a draft,
// and the poll stops on each as "a draft with no checkpoint" (#646). The
// other fields of each entry stay as they were.
const outputs = name => read(name).split('[outputs]\n')[1].split(/^\[/m)[0];
// Each `repos` list of a bounds file: its targets, then its unprotected files'.
const lists = name => [...read(name).matchAll(/^repos = (\[.*\])$/gm)].map(m => JSON.parse(m[1]));

test('misctool is a dispatch and fix target with matching workflow-edit bounds', () => {
  const dispatchLists = lists('dispatch.toml');
  const fixLists = lists('fix.toml');
  for (const [name, bounds] of [['dispatch', dispatchLists], ['fix', fixLists]]) {
    assert.equal(bounds.length, 2, name);
    for (const repos of bounds) assert.ok(repos.includes('cgwalters-forge/misctool'), name);
  }
  // Less the upstreams bootc-dev/* (D17, below) and composefs/composefs-rs, which fix has and dispatch has not.
  for (let i = 0; i < 2; i++) assert.deepEqual([...dispatchLists[i]].sort(), fixLists[i].filter(r => !['bootc-dev/*', 'composefs/composefs-rs'].includes(r)).sort());
});

// forge-infra (#812) is followed and a target, but no run may edit its
// `.github/` or protected files until a per-repository ruleset is on its
// main; for now the organization's ruleset is its only gate.
test('forge-infra is a followed target without unprotected files', () => {
  const repo = 'cgwalters-forge/forge-infra';
  for (const name of ['dispatch.toml', 'fix.toml', 'comment.toml']) assert.ok(repos(name).includes(repo), name);
  for (const name of ['dispatch.toml', 'fix.toml']) {
    assert.ok(!lists(name)[1].includes(repo), name);
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '../poll/agent-board.json'), 'utf8')).follow.includes(repo));
});

test('dispatch.toml and fix.toml open complete work ready', () => {
  assert.match(outputs('dispatch.toml'), /^create_pull_request = \{ max = 1, ready_when_complete = true \}$/m);
  assert.match(outputs('fix.toml'), /^push_to_pull_request_branch = \{ max = 1, branches = \["dispatch\/\*\*", "bot\/\*\*", "release-train\/\*\*"\], replacement_max_commits = 5, ready_when_complete = true \}$/m);
});

// D17 (docs/operator-notes.md, 2026-10-17): bootc-dev is open to
// comment-only kinds and to fix, and to nothing else; comment.toml is
// dispatch.toml's targets with no pull request.
const repos = name => JSON.parse(/^repos = (\[.*\])$/m.exec(read(name).split(/^\[/m)[0])[1]);
test('only triage, research and fix may target bootc-dev', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../../docs/operator-notes.md'), 'utf8'),
    /^D17 \(which bootc-dev runs .*\*\*B\*\*\. .*Fix rounds run on the bot's own bootc-dev pull requests.*Triage and research answers may also be posted/m);
  assert.deepEqual([...repos('comment.toml')].sort(), [...repos('dispatch.toml'), ...repos('midstream.toml'), 'bootc-dev/*'].sort());
  assert.deepEqual(repos('fix.toml').filter(r => r.startsWith('bootc-dev')), ['bootc-dev/*']);
  assert.ok(!repos('dispatch.toml').some(r => r.startsWith('bootc-dev')));
  assert.deepEqual([...outputs('comment.toml').matchAll(/^([a-z_]+) = /gm)].map(m => m[1]),
    ['add_comment', 'noop', 'missing_tool', 'missing_data']);
  assert.doesNotMatch(read('comment.toml'), /^\[unprotected_files\]/m);
  for (const name of ['dispatch.toml', 'fix.toml']) assert.doesNotMatch(read(name).split(/^\[unprotected_files\]$/m)[1], /bootc-dev/);
});

// Midstream forks (the `bot-midstream` topic) take dispatch.toml's and
// fix.toml's bounds without `ready_when_complete`, so their pull requests
// stay drafts (#336), and without unprotected files; dispatch.yml picks them
// by kind and by the midstream lists.
test('the midstream bounds are the others without ready_when_complete, and dispatch.yml picks them', () => {
  const head = name => read(name).split(/^\[/m)[0].replace(/^#.*\n|^repos = .*\n/gm, '');
  const entries = name => outputs(name).replace(/^#.*\n|^\n/gm, '').replace(/, ready_when_complete = true \}$/gm, ' }');
  assert.deepEqual(repos('midstream.toml'), ['cgwalters-forge/composefs-rs', 'cgwalters-forge/bootc']);
  for (const [midstream, base] of [['midstream.toml', 'dispatch.toml'], ['midstream-fix.toml', 'fix.toml']]) {
    assert.doesNotMatch(read(midstream).replace(/^#.*\n/gm, ''), /ready_when_complete|^\[unprotected_files\]/m, midstream);
    assert.deepEqual([head(midstream), entries(midstream), repos(midstream)], [head(base), entries(base), repos('midstream.toml')], midstream);
    // Disjoint, or dispatch.yml's choice would decide which bounds hold.
    for (const repo of repos(midstream)) assert.ok(!read(base).includes(`"${repo}"`), `${repo} in ${base}`);
  }
  assert.deepEqual(dispatch.match(/^ {6}(?:fix-)?allow: .*$/gm), ['allow: ${{ steps.bounds.outputs.allow }}', 'fix-allow: ${{ steps.bounds.outputs.fix-allow }}',
    'allow: ${{ needs.profile.outputs.allow }}', 'fix-allow: ${{ needs.profile.outputs.fix-allow }}'].map(line => `      ${line}`));
  const step = stepScript('Resolve the bounds');
  // bootc-dev/bootc is upstream, no midstream; neither is a name that only contains one.
  for (const [repos, allow, fix] of [[['cgwalters-forge/composefs-rs', 'cgwalters-forge/bootc', 'cgwalters-forge/BootC'], 'midstream.toml', 'midstream-fix.toml'],
    [['cgwalters-forge/tracker', 'bootc-dev/bootc', 'cgwalters-forge/bootc-x', 'cgwalters-forge'], 'dispatch.toml', 'fix.toml']]) {
    for (const repo of repos) for (const kind of ['implement', 'fix', 'review', 'triage', 'research']) assert.equal(runStep(step, { KIND: kind, REPO: repo }),
      `allow=.github/agentic-job/${['triage', 'research'].includes(kind) ? 'comment.toml' : allow}\nfix-allow=.github/agentic-job/${fix}\n`, `${kind} ${repo}`);
  }
});

test('agentic-job policy admits bootc-dev only for comments and fixes', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const policy = (file, kind, outputs, ...args) => spawnSync('agentic-job', ['policy', '--allow', path.join(__dirname, file),
    '--repo', 'bootc-dev/bootc', '--clone-url', 'https://github.com/bootc-dev/bootc',
    '--kind', kind, '--outputs', outputs, '--max-outputs', '3', ...args], { stdio: 'pipe' }).status;
  assert.equal(policy('comment.toml', 'analysis', 'add_comment,noop', '--base', 'main'), 0);
  assert.notEqual(policy('comment.toml', 'branch', 'create_pull_request,noop', '--base', 'main'), 0);
  assert.notEqual(policy('dispatch.toml', 'analysis', 'add_comment,noop', '--base', 'main'), 0);
  assert.notEqual(policy('dispatch.toml', 'branch', 'create_pull_request,noop', '--base', 'main'), 0);
  const fix = (repo, branch) => spawnSync('agentic-job', ['policy', '--allow', path.join(__dirname, repo.startsWith('cgwalters-forge/') ? 'midstream-fix.toml' : 'fix.toml'),
    '--repo', repo, '--clone-url', `https://github.com/${repo}`, '--kind', 'branch',
    '--outputs', 'push_to_pull_request_branch,noop', '--max-outputs', '3', '--base', branch, '--pull-request', '1',
    '--head', '0'.repeat(40), '--output-repo', repo], { stdio: 'pipe' }).status;
  // The bot's dispatch branches, and the homegit era's bot/** ones (#710),
  // in bootc-dev and in the midstream forks; no other branch pattern.
  for (const repo of ['bootc-dev/bootc', 'cgwalters-forge/bootc', 'cgwalters-forge/composefs-rs']) {
    for (const branch of ['dispatch/x', 'bot/install-output', 'bot/a/b']) assert.equal(fix(repo, branch), 0, `${repo} ${branch}`);
    for (const branch of ['main', 'feature/x', 'BOT/x', 'bots/x', 'x/bot/y']) assert.notEqual(fix(repo, branch), 0, `${repo} ${branch}`);
  }
  // Another owner's bootc or composefs-rs is no target, even on bot/**.
  // This is the target, not a pull request's head repository: the policy is
  // never told the head, which apply bounds instead (fix.toml's comment on
  // `bot/**`), so no test here can refuse a head owner.
  for (const repo of ['someone/bootc', 'cgwalters-bot/bootc', 'containers/composefs-rs']) assert.notEqual(fix(repo, 'bot/x'), 0, repo);
});

// The policy job's own reading of the bounds, so a spelling it ignores fails.
test('agentic-job policy keeps ready_when_complete from both bounds, and the midstream ones leave drafts', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const ready = (repo, file, type, ...args) => JSON.parse(execFileSync('agentic-job', ['policy', '--allow', path.join(__dirname, file), '--repo', repo,
    '--clone-url', `https://github.com/${repo}`, '--kind', 'branch', '--outputs', `${type},noop`, '--max-outputs', '3', ...args], { encoding: 'utf8' })).safe_outputs[type].ready_when_complete === true;
  for (const [repo, allow, fix, expected] of [['cgwalters-forge/tracker', 'dispatch.toml', 'fix.toml', true], ['cgwalters-forge/composefs-rs', 'midstream.toml', 'midstream-fix.toml', false]]) {
    assert.equal(ready(repo, allow, 'create_pull_request', '--base', 'main'), expected, allow);
    assert.equal(ready(repo, fix, 'push_to_pull_request_branch', '--base', 'dispatch/x', '--pull-request', '1', '--head', '0'.repeat(40), '--output-repo', repo), expected, fix);
  }
});

test('no repository the bot owns is a dispatch or fix target unless it opts in', () => {
  const { bot } = require('../poll/agent-board.json');
  // Bot-owned repositories whose default branch has accept-owner-branches
  // naming them, in lowercase; add one only after checking that file is there.
  const optedIn = new Set(['cgwalters-bot/praxis-credential-broker']);
  for (const name of ['dispatch.toml', 'fix.toml']) {
    for (const repo of repos(name)) {
      if (optedIn.has(repo.toLowerCase())) continue;
      assert.notEqual(repo.split('/')[0].toLowerCase(), bot.toLowerCase(),
        `${repo} in ${name} is owned by ${bot}: apply cannot push there without its accept-owner-branches; see docs/bring-up.md`);
    }
  }
});

test('blocked fixes can explain themselves without a push or extra write authority', () => {
  const entries = [...outputs('fix.toml').matchAll(/^([a-z_]+) = (.+)$/gm)];
  assert.deepEqual(entries.map(m => m[1]), [
    'push_to_pull_request_branch', 'add_comment', 'noop', 'missing_tool', 'missing_data',
  ]);
  assert.equal(entries.find(m => m[1] === 'add_comment')[2], '{ max = 1 }');
  assert.match(read('fix.toml'), /^max_outputs = 3$/m);
  for (const rule of [
    'leave the working tree unchanged', 'one `add_comment` safe output with a `body`',
    'Do not request `push_to_pull_request_branch` or write a replacement series when there is no change to push',
    'Do not invent a patch',
  ]) assert.ok(profile('fix').includes(rule), rule);
});

test('pools.json has what dispatch.yml reads, and a well-formed allowance', () => {
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
  assert.deepEqual(dispatch.match(/^ {6}skills: .*$/gm), ["      skills: ${{ needs.profile.outputs.skilled == 'true' && (inputs.kind == 'implement' || inputs.kind == 'fix') }}"]);
  for (const rule of [/^Use the implement skill\./, /named caller/, /end the PR body with a `Caller settings` section/]) assert.match(profile('implement'), rule);
  assert.doesNotMatch(profile('implement'), /AGENTS\.md|subagent|left undone|file an issue/);
  assert.doesNotMatch(profile('implement-full'), /\bskill\b/);
  assert.match(profile('implement-full'), /^Implement this issue properly with tests/);
  for (const rule of profile('implement').trim().split(/(?<=\.) /).slice(1).filter(rule => !/commit-messages skill/.test(rule))) assert.ok(profile('implement-full').includes(rule), rule);
  assert.doesNotMatch(profile('fix'), /implement skill/);
  for (const kind of ['research', 'triage', 'review']) assert.doesNotMatch(profile(kind), /\bskill\b/);
});

test('dispatch.yml gives an agent without skills the full implement profile', () => {
  assert.ok(dispatch.indexOf('- name: Resolve the pool') < dispatch.indexOf('- name: Put the profile before the task'));
  const poolStep = stepScript('Resolve the pool');
  const composeStep = stepScript('Put the profile before the task');
  const outputs = text => Object.fromEntries([...text.matchAll(/^([a-z]+)=(.*)$/gm)].map(m => [m[1], m[2]]));
  const run = (pool, kind, agent = 'opencode') => {
    try {
      const resolved = outputs(runStep(poolStep, { POOL: pool, KIND: kind, AGENT: agent }));
      const composed = runStep(composeStep, { KIND: kind, TASK: 'the task', SKILLED: resolved.skilled });
      const task = /^task<<(task-[0-9a-f]{32})\n([\s\S]*)\n\1\n$/.exec(composed)?.[2];
      assert.ok(task, composed);
      return { ...resolved, task };
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      return null;
    }
  };
  const expected = (kind, skilled) => `${profile(!skilled && fs.existsSync(path.join(__dirname, `profiles/${kind}-full.md`)) ? `${kind}-full` : kind)}\nthe task`;
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
  const owner = require('../poll/agent-board.json').dispatchRepo.split('/')[0];
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

test('the pass starts work only where dispatch.yml and fix runs may act, on known pools', () => {
  const pass = require('../pass.json');
  const either = (...names) => ({includes: repo => names.flatMap(repos).some(r => r === repo || (r.endsWith('/*') && repo.startsWith(r.slice(0, -1))))});
  for (const repo of pass.workRepositories) assert.ok(either('dispatch.toml', 'midstream.toml').includes(repo), `${repo} is scheduled but not in dispatch.toml or midstream.toml`);
  for (const repo of pass.follow) assert.ok(either('fix.toml', 'midstream-fix.toml').includes(repo), `${repo} is followed but not in fix.toml or midstream-fix.toml`);
  for (const pool of [...Object.keys(pass.pools), ...pass.planPools, ...pass.triagePools, ...pass.pr.fixPools, ...[pass.pr.toilFixPool, pass.pr.conflictFixPool].filter(Boolean)]) {
    assert.ok(pools[pool], pool);
  }
  assert.equal(pass.dispatchWorkflow, 'dispatch.yml');
  assert.equal(pass.pr.reviewWorkflow, 'review.yml');
});
