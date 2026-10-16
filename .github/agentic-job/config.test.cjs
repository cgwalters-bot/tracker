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
const MARKER = "# The experiment's own tables; everything above is hosted.toml's.\n";

test('acp-experiment.toml is hosted.toml and a child agent, and hosted.toml has none', () => {
  const body = text => text.slice(text.indexOf('[sandbox]\n'));
  const [copy, own] = body(experiment).split(MARKER);
  assert.ok(own, 'the marker before the experiment\'s own tables');
  assert.equal(copy, `${body(hosted)}\n`, 'acp-experiment.toml must keep hosted.toml unchanged');
  assert.doesNotMatch(hosted, /^\[child-agent\]/m);
  assert.match(own, /^\[child-agent\]\nname = "vibe"\nmodel = "zai-glm-5-3"\n/m);
  assert.match(own, /^\[limits\]\nmax-requests = 400\n/m);
  // The child's model is the mistral pool's, the one dispatch can select.
  assert.equal(require('./pools.json').mistral.model, 'zai-glm-5-3');
});

test('dispatch passes the run only a configuration from its closed set', () => {
  assert.deepEqual(dispatch.match(/^ {6}config: .*$/gm), ['      config: ${{ steps.config.outputs.config }}', '      config: ${{ needs.profile.outputs.config }}']);
  assert.match(dispatch, /^ {8}type: choice\n {8}options: \[hosted, acp-experiment\]\n {8}default: hosted$/m);
  const step = /^ {6}- name: Resolve the runner configuration\n(?: {8}.*\n)*? {8}run: \|\n((?:(?: {10}.*)?\n)+)/m.exec(dispatch)?.[1];
  assert.ok(step);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
  const resolve = (config, n) => {
    const out = path.join(dir, String(n));
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-eo', 'pipefail', '-c', step.replace(/^ {10}/gm, '')], {
      cwd: path.join(__dirname, '../..'), stdio: 'pipe', env: { ...process.env, CONFIG: config, GITHUB_OUTPUT: out },
    });
    return r.status === 0 ? fs.readFileSync(out, 'utf8') : null;
  };
  // A normal dispatch leaves the wrapper its default, hosted.toml.
  assert.equal(resolve('hosted', 0), 'config=\n');
  assert.equal(resolve('acp-experiment', 1), 'config=.github/agentic-job/acp-experiment.toml\n');
  assert.ok(fs.existsSync(path.join(__dirname, 'acp-experiment.toml')));
  for (const [n, config] of ['', 'dispatch.toml', '.github/agentic-job/dispatch.toml', 'hosted acp-experiment'].entries()) {
    assert.equal(resolve(config, n + 2), null, config);
  }
});

// The check the wrapper's policy job makes, with the settings it adds for a
// real agent; where agentic-job is not installed (CI) it is skipped.
const agenticJob = spawnSync('agentic-job', ['--version'], { stdio: 'pipe' }).status === 0;
test('agentic-job config takes acp-experiment.toml, and refuses it without the cap', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const check = file => spawnSync('agentic-job', ['config', '--from', file, '--repo', 'o/r',
    '--string', 'agent.name=claude', '--string', 'agent.model=m',
    '--string', 'inference.url=http://127.0.0.1:18080', '--string', 'inference.register=github-oidc',
    '--string', 'inference.audience=a', '--integer', 'limits.timeout-minutes=75', '--integer', 'limits.budget=500'], { stdio: 'pipe' });
  const ok = check(path.join(__dirname, 'acp-experiment.toml'));
  assert.equal(ok.status, 0, String(ok.stderr));
  assert.match(String(ok.stdout), /^\[child-agent\]\nmodel = "zai-glm-5-3"\nname = "vibe"$/m);
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
test('dispatch.toml and fix.toml open complete work ready', () => {
  assert.match(outputs('dispatch.toml'), /^create_pull_request = \{ max = 1, ready_when_complete = true \}$/m);
  assert.match(outputs('fix.toml'), /^push_to_pull_request_branch = \{ max = 1, branches = \["dispatch\/\*\*"\], replacement_max_commits = 5, ready_when_complete = true \}$/m);
});

// The policy job's own reading of the bounds, so a spelling it ignores fails.
test('agentic-job policy keeps ready_when_complete from both bounds', { skip: !agenticJob && 'agentic-job is not installed' }, () => {
  const policy = (file, type, ...args) => JSON.parse(execFileSync('agentic-job', ['policy', '--allow', path.join(__dirname, file),
    '--repo', 'cgwalters-forge/tracker', '--clone-url', 'https://github.com/cgwalters-forge/tracker',
    '--kind', 'branch', '--outputs', `${type},noop`, '--max-outputs', '3', ...args], { encoding: 'utf8' }));
  assert.equal(policy('dispatch.toml', 'create_pull_request', '--base', 'main').safe_outputs.create_pull_request.ready_when_complete, true);
  assert.equal(policy('fix.toml', 'push_to_pull_request_branch', '--base', 'dispatch/x', '--pull-request', '1',
    '--head', '0'.repeat(40), '--output-repo', 'cgwalters-forge/tracker').safe_outputs.push_to_pull_request_branch.ready_when_complete, true);
});
