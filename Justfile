# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-runner-profiles test-agent-board-install test-config test-supervisor-config test-pass-config test-supervisor-workflow test-poll-bounds test-poll-next test-pass-state test-maintain-shadow test-review-caller test-review-gate test-forge-sync test-review-corpus test-review-refresh test-retro test-needs-you-fit agent-board-pin

# Execute the workflow's actual resolver, without credentials or forge traffic.
test-runner-profiles:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/dispatch.yml', 'utf8');
    const gate = workflow.split('\n  runner-gate:\n')[1].split('\n  # Threat:')[0];
    const script = /          python3 - <<'PY'\n([^]*?)          PY/.exec(gate)[1].replace(/^          /gm, '');
    const mapPath = '.github/agentic-job/runner-profiles.json';
    const example = JSON.parse(fs.readFileSync(mapPath));
    assert.ok(Object.values(example).every(p => p.enabled === false));
    const name = Object.keys(example)[0];
    const temp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'runner-profile-'));
    const env = { RUNNER_PROFILE: name, KIND: 'implement', REPO: 'cgwalters-forge/bootc',
      POOL: '', EFFORT: '', CONFIG: 'hosted', DETECT_MODEL: 'deployment-model',
      CALLER_REF: 'refs/heads/main', DEFAULT_BRANCH: 'main' };
    const run = (map, extra = {}) => {
      if (map === undefined) fs.rmSync(`${temp}/${mapPath}`, { force: true });
      else fs.writeFileSync(`${temp}/${mapPath}`, typeof map === 'string' ? map : JSON.stringify(map));
      return spawnSync('python3', ['-c', script], { cwd: temp, encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
    };
    const refuse = (map, extra, reason) => {
      const result = run(map, extra);
      assert.notEqual(result.status, 0, reason);
      assert.ok(result.stderr.includes(reason), result.stderr);
      assert.equal(result.stdout, '', 'resolver releases no execution selectors');
    };
    const enabled = structuredClone(example);
    enabled[name].enabled = true;
    try {
      fs.mkdirSync(`${temp}/.github/agentic-job`, { recursive: true });
      fs.copyFileSync('.github/agentic-job/midstream.toml', `${temp}/.github/agentic-job/midstream.toml`);
      for (const map of [undefined, '{', { hosted: {} }]) assert.equal(run(map, { RUNNER_PROFILE: 'hosted' }).status, 0);
      refuse('{', {}, 'JSONDecodeError');
      refuse(undefined, {}, 'FileNotFoundError');
      refuse(example, { RUNNER_PROFILE: 'unknown' }, 'unknown runner');
      refuse(example, {}, 'disabled');
      refuse(enabled, {}, 'unimplemented');
      for (const kind of ['fix', 'review', 'research', 'triage']) refuse(enabled, { KIND: kind }, 'requires implement');
      for (const repo of ['cgwalters-forge/tracker', 'cgwalters-forge/ostree', 'bootc-dev/bootc']) refuse(enabled, { REPO: repo }, 'outside midstream');
      for (const [key, value, reason] of [['POOL', 'claude', 'pool/effort'], ['EFFORT', 'heavy', 'pool/effort'],
        ['CONFIG', 'acp-experiment', 'hosted config'], ['DETECT_MODEL', '', 'detection configuration'],
        ['DETECT_MODEL', '  ', 'detection configuration'], ['CALLER_REF', 'refs/heads/other', 'default branch']]) refuse(enabled, { [key]: value }, reason);
      for (const change of [p => { delete p.commit; }, p => { p.extra = true; }, p => { p.enabled = 'false'; },
        p => { p.kvm = 1; }, p => { p.libvirt = 'system'; }, p => { p.libvirt = null; },
        p => { p.repository = 'https://example/repo'; }, p => { p.workflow = '../agent.yml'; },
        p => { p.ref = 'main..other'; }, p => { p.inputs.cores = 64; }, p => { p.inputs.task = 'override'; },
        p => { p.inputs = []; }, p => { p.limits.extra = 1; }, p => { delete p.limits.vcpus; },
        p => { p.limits['lifetime-minutes'] = 331; }, p => { p.limits['lifetime-minutes'] = 240; }]) {
        const map = structuredClone(enabled); change(map[name]);
        refuse(map, { RUNNER_PROFILE: 'unknown' }, 'runner'); // Whole map is validated, not just selected entry.
        assert.ok(!run(map).stderr.includes('unimplemented'));
      }
      for (const pin of ['commit', 'agentic-job', 'actions']) for (const value of ['main', 'a'.repeat(39), 'A'.repeat(40)]) {
        const map = structuredClone(enabled); map[name][pin] = value; refuse(map, {}, 'immutable');
      }
      for (const key of Object.keys(enabled[name].limits)) for (const value of [0, -1, 1.5, true, '1', null]) {
        const map = structuredClone(enabled); map[name].limits[key] = value; refuse(map, {}, 'positive integers');
      }
      for (const badName of ['hosted', 'Bad', '../runner', 'x'.repeat(33)]) refuse({ [badName]: enabled[name] }, {}, 'profile name');
      for (const map of ['[]', 'null', '{"x":{},"x":{}}']) refuse(map, {}, map.includes('"x"') ? 'duplicate' : 'object');
      const ceiling = structuredClone(enabled); ceiling[name].limits['lifetime-minutes'] = 330;
      delete ceiling[name].libvirt;
      refuse(ceiling, { REPO: 'CGWALTERS-FORGE/BOOTC' }, 'unimplemented');
      assert.match(gate, /if: inputs.runner != 'hosted'/);
      assert.match(gate, /repository: \$\{\{ github.repository \}\}/);
      assert.match(gate, /ref: \$\{\{ github.sha \}\}/);
      assert.doesNotMatch(gate, /inputs.task|secrets\.|actions: write|workflow_dispatch|GITHUB_OUTPUT/);
      for (const job of ['profile', 'review-gate']) assert.match(workflow, new RegExp(`  ${job}:\\n    needs: runner-gate`));
      assert.match(workflow, /  run:\n    needs: profile/);
      assert.match(workflow, /  review:\n    needs: review-gate/);
      assert.match(workflow, /      runner:\n[^]*?default: hosted/);
      assert.doesNotMatch(workflow, /runner: \$\{\{ inputs.runner/);
      console.log('ok runner map validation, hosted bypass and workflow boundary (external execution remains unimplemented)');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }

# Offline admission and research-only publication contract.
test-retro:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/retro.yml', 'utf8');
    const brief = fs.readFileSync('.github/agentic-job/retro.md', 'utf8');
    assert.match(workflow, /cron: '23 8 \* \* \*'/);
    assert.match(workflow, /  workflow_dispatch:\n\npermissions: \{\}/);
    assert.match(workflow, /group: retro\n  cancel-in-progress: false/);
    const guard = /    if: \$\{\{ (.*) \}\}/.exec(workflow)[1];
    const admitted = new Function('vars', 'github', 'format', `return ${guard}`);
    const format = (template, branch) => template.replace('{0}', branch);
    for (const event_name of ['schedule', 'workflow_dispatch']) {
      for (const activation of [undefined, '', 'disabled', 'true', 'enabled']) {
        for (const ref of ['refs/heads/main', 'refs/heads/other', 'refs/tags/main']) {
          assert.equal(admitted({ RETRO: activation }, { event_name, ref,
            event: { repository: { default_branch: 'main' } } }, format),
            activation === 'enabled' && ref === 'refs/heads/main');
        }
      }
    }
    assert.doesNotMatch(workflow, /contents: write|pull-requests: write|actions: write/);
    assert.doesNotMatch(workflow.split('\n  apply:\n')[0], /secrets\./);
    assert.match(workflow.split('\n  apply:\n')[1], /SAFE_OUTPUTS_PAT: \$\{\{ secrets.CGWALTERS_BOT_PAT \}\}/);
    assert.match(workflow, /apply-environment: agent-apply/);
    const agent = workflow.split('\n  agent:\n')[1].split('\n  check:\n')[0];
    assert.doesNotMatch(agent, /issues: write/);
    assert.match(agent, /github-token: \$\{\{ github.token \}\}/);
    assert.equal((workflow.match(/issues: write/g) || []).length, 1, 'apply alone can write issues');
    assert.match(workflow, /kind: analysis/);
    assert.match(workflow, /outputs: create_issue,add_comment,noop,missing_tool,missing_data\n      max-outputs: '3'/);
    assert.match(workflow, /allow: .github\/agentic-job\/retro.toml/);
    assert.match(workflow, /comment-target: '\*'/);
    assert.match(workflow, /max-requests: '150'\n      timeout: '45'/);
    assert.match(workflow, /inference-url: \$\{\{ vars.INFERENCE_URL \}\}/);
    assert.match(workflow, /task: Read .github\/agentic-job\/retro.md/);
    assert.doesNotMatch(workflow, /apply-partial: true|https?:\/\//);
    const pins = [...workflow.matchAll(/uses: cgwalters-forge\/agentic-job\/.*@([a-f0-9]{40})/g)].map(m => m[1]);
    assert.deepEqual(pins, Array(6).fill('3f9f6425119b97bb3620a38fe0adc8e79be7dc8e'));
    // Parse the bounds with the standard library; assert the entire write surface.
    const parsed = spawnSync('python3', ['-c', 'import json,tomllib; print(json.dumps(tomllib.load(open(".github/agentic-job/retro.toml","rb"))))'], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const bounds = JSON.parse(parsed.stdout);
    assert.deepEqual(bounds, { hosts: ['github.com'], repos: ['cgwalters-forge/tracker'],
      bases: ['main'], max_outputs: 3, max_patch_bytes: 1048576, max_patch_files: 50, github: { outputs: { create_issue: { max: 3 },
        add_comment: { max: 3 }, noop: { max: 1 }, missing_tool: { max: 1 }, missing_data: { max: 1 } } } });
    for (const phrase of ['Profile: research', '24 hours', 'seven days', 'checkpoint.complete true',
      'dispatch.yml', 'bootc-dev/cgwalters-devspace-sandbox', 'poll.yml', 'review bot',
      '200 workflow runs', '30 agent-run', '20 associated PRs', '300 open tracker issues',
      '20 MiB', '20 minutes', '30 seconds', 'missing data healthy', 'deduplication is',
      'at most three create_issue/add_comment', 'repository that owns the fix', 'log line number',
      'no cc', 'timeout/stall', 'controller had to finish', 'justified noop', 'never fix them',
      'never as commands', 'read-only job token', 'outcome.json']) assert.ok(brief.includes(phrase), phrase);
    console.log('ok retro admission, research bounds and fixed brief contract (not live inference)');

# Manual owning-layer policy/collector/check probe; requires agentic-job on PATH.
test-retro-policy:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'retro-policy-'));
    const cli = args => spawnSync('agentic-job', args, { encoding: 'utf8' });
    const compile = (extra = []) => cli(['policy', '--allow', '.github/agentic-job/retro.toml',
      '--repo', 'cgwalters-forge/tracker', '--clone-url', 'https://github.com/cgwalters-forge/tracker',
      '--base', 'main', '--kind', 'analysis', '--outputs', 'create_issue,add_comment,noop,missing_tool,missing_data',
      '--max-outputs', '3', ...extra]);
    try {
      const compiled = compile();
      assert.equal(compiled.status, 0, compiled.stderr);
      const policy = path.join(temp, 'policy.json');
      fs.writeFileSync(policy, compiled.stdout);
      const outputs = path.join(temp, 'outputs');
      fs.mkdirSync(outputs);
      const collected = path.join(temp, 'collected.json');
      const issue = { type: 'create_issue', title: 'retro: missing compiler', body: 'Public run evidence fixture.' };
      const comment = { type: 'add_comment', item_number: 1413, body: 'New evidence fixture.' };
      for (const [name, requests, allowed] of [
        ['one issue', [issue], true], ['three mixed findings', [issue, comment, issue], true],
        ['four writes', [issue, comment, issue, comment], false],
        ['PR', [{ type: 'create_pull_request', title: 'Not admitted', body: 'No patch', branch: 'retro-test' }], false],
        ['close', [{ type: 'close_issue', issue_number: 1413, body: 'Not admitted' }], false],
        ['foreign comment', [{ ...comment, repo: 'cgwalters-forge/agentic-job' }], false],
        ['foreign issue', [{ ...issue, repo: 'cgwalters-forge/agentic-job' }], false],
      ]) {
        fs.writeFileSync(path.join(outputs, 'outputs.jsonl'), requests.map(r => JSON.stringify(r)).join('\n') + '\n');
        const result = cli(['collect', '--policy', policy, '--outputs', outputs, '--collected', collected]);
        const checked = result.status === 0 ? cli(['check', '--policy', policy, '--outputs', outputs,
          '--collected', collected]) : result;
        assert.equal(checked.status === 0, allowed, `${name}: ${checked.stdout}\n${checked.stderr}`);
        console.log(`ok retro policy: ${name} ${allowed ? 'accepted' : 'refused'}`);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }

# Offline trigger execution and prompt-contract checks, not model evaluations.
test-review-refresh:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/monthly-review-refresh.yml', 'utf8');
    assert.match(workflow, /cron: '0 8 1 \* \*'/);
    assert.match(workflow, /  workflow_dispatch:\n\npermissions: \{\}/, 'manual entry has no task override');
    assert.equal((workflow.match(/TASK: >-/g) || []).length, 1, 'both entries share one trusted task');
    assert.match(workflow, /timeout-minutes: 5\n    permissions:\n      actions: write\n    steps:/);
    assert.doesNotMatch(workflow, /secrets\.|contents: write|issues: write|pull-requests: write|uses:/);
    assert.match(workflow, /cancel-in-progress: false/);
    const guard = /    if: \$\{\{ (.*) \}\}/.exec(workflow)[1];
    const admitted = new Function('vars', 'github', 'format', `return ${guard}`);
    const format = (template, branch) => template.replace('{0}', branch);
    for (const event_name of ['schedule', 'workflow_dispatch']) {
      for (const activation of [undefined, '', 'disabled', 'true', 'enabled']) {
        for (const ref of ['refs/heads/main', 'refs/heads/unreviewed', 'refs/tags/main']) {
          assert.equal(admitted({ REVIEW_REFRESH: activation }, { event_name, ref,
            event: { repository: { default_branch: 'main' } } }, format),
            activation === 'enabled' && ref === 'refs/heads/main');
        }
      }
    }
    const task = /          TASK: >-\n((?:            .*\n)+)/.exec(workflow)[1]
      .trim().replace(/\n            /g, ' ');
    // These assert instructions sent to the implement runner, not enforcement
    // by an LLM. Missing prerequisites must never turn into a fallback score.
    for (const [scenario, required] of [
      ['partial corpus', /If corpus\/status assets are missing, partial, stopped early or fail verification, stop unfinished\/no-update/],
      ['unavailable checklist/protocol', /If a checklist, reviewed pin or protocol is unavailable, stop unfinished\/no-update/],
      ['unused samples', /If no unused samples exist, isolation cannot be established, or the protocol is unavailable, stop unfinished\/no-update/],
      ['no-update', /If too little evidence or no supported change remains, return no-update[^]*no version bump, fabricated scores or guessed rules/],
      ['audit gaps', /Missing runs, audits or insufficient scorable evidence mean unfinished\/no-update/],
      ['publication prerequisite', /If the home differs or draft-only publication is unavailable, stop unfinished\/no-update/],
    ]) assert.match(task, required, scenario);
    const policy = fs.readFileSync('.github/agentic-job/dispatch.toml', 'utf8');
    assert.match(policy, /ready_when_complete = true/);
    assert.match(task, /current dispatch.toml ready_when_complete route does not/,
      'current route must report no-update, not claim it can force a draft');
    for (const phrase of ['code checklist', 'architecture pattern library', 'prose checklist',
      'complete to be boolean true', 'SHA256SUMS', '2026-06-01', 'Never move or reuse frozen holdouts',
      'never feedback, labels, later fixes', 'no tuning/reruns', 'generated cleanup and bot suggestions distinct',
      'caught/missed/unmatched/scorable', 'noise-audit audited/total', 'false-positive and meaning-change',
      'model/provider/version', 'one draft PR', 'one commit', 'Reviewed release-train pin rollout is a separate change']) {
      assert.ok(task.includes(phrase), phrase);
    }
    const script = /        run: \|\n([^]*)/.exec(workflow)[1].replace(/^          /gm, '');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-refresh-'));
    try {
      // Stub only the transport; capture actual shell argument boundaries.
      fs.writeFileSync(path.join(temp, 'gh'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAIL || 0));\n`, { mode: 0o755 });
      const capture = path.join(temp, 'args.json');
      const env = { PATH: `${temp}:${process.env.PATH}`, CAPTURE: capture, GH_TOKEN: '',
        GITHUB_REPOSITORY: 'cgwalters-forge/tracker', DEFAULT_BRANCH: 'main',
        ITEM_REPO: 'cgwalters-forge/tracker', ITEM: '1343', TASK: task };
      for (const failure of [0, 1]) {
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { env: { ...env, FAIL: String(failure) }, encoding: 'utf8' });
        assert.equal(result.status, failure, result.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(capture)), ['workflow', 'run', 'dispatch.yml',
          '--repo', env.GITHUB_REPOSITORY, '--ref', 'main', '-f', 'kind=implement',
          '-f', 'repo=cgwalters-forge/tracker', '-f', 'item=1343', '-f', `task=${task}`]);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('ok refresh admission, trusted task prerequisites/no-update contract and offline dispatch');

# Manual: board is a read-only checkout at the workflows' exact AGENT_BOARD_REV.
# Builds outside this tree; no tokens, broker or forge requests in the probes.
test-heavy-consumers board:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const board = path.resolve(process.argv[2]);
    const revision = execFileSync('git', ['-C', board, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(revision, execFileSync('{{ just_executable() }}', ['agent-board-pin'], { encoding: 'utf8' }).trim());
    const cargo = ['--locked', '--manifest-path', `${board}/Cargo.toml`, '-p', 'board-forge'];
    execFileSync('cargo', ['build', ...cargo, '--target-dir', `${board}/target`], { stdio: 'inherit' });
    const libs = fs.readdirSync(`${board}/target/debug/deps`).filter(name => /^libserde_json-.*\.rlib$/.test(name));
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'heavy-consumers-'));
    try {
      const source = `${temp}/probe.rs`;
      fs.writeFileSync(source, `
    // Manual offline compatibility probe against the exact pinned board-forge.
    // Uses its public parsers, not replicas of their validation/accounting.
    use board_forge::poll::pace::tiers;
    use board_forge::supervise::{Settings, agent::Policy, profile::session};
    use serde_json::{Value, json};

    fn read(path: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn main() {
        let normal = read(".github/agentic-job/pools.json");
        let mut heavy = normal.clone();
        heavy["openai"]["heavy"] = json!({"model": "praxis/gpt-6-astra"});
        let settings = Settings::from_json(
            &read(".github/poll/agent-board.json"),
            &read(".github/supervisor/config.json"),
            None,
        )
        .unwrap();
        let before = Policy::new(&settings, &normal).unwrap().unwrap();
        let after = Policy::new(&settings, &heavy).unwrap().unwrap();
        assert_eq!(before.pools, after.pools);
        assert_eq!(before.tiers, after.tiers);
        assert_eq!(
            tiers(Some(&normal), &[("fixPools", "tier-1")]).unwrap(),
            tiers(Some(&heavy), &[("fixPools", "tier-1")]).unwrap()
        );
        let config =
            json!({"enabled": true, "repository": "example/tracker", "issue": 1, "idleMinutes": 10});
        let state = board_forge::supervise::IssueRef {
            repository: "example/tracker".into(),
            issue: 2,
        };
        let outputs = |pools| {
            session(
                &config,
                pools,
                "rules",
                Some(&state),
                &state,
                "profile",
                "openai",
                "",
                "offline fixture",
            )
            .unwrap()
        };
        assert_eq!(outputs(&normal), outputs(&heavy));
        let outputs = outputs(&heavy);
        assert!(outputs.contains(&("model", normal["openai"]["model"].as_str().unwrap().into())));
        println!(
            "ok pinned board tier, supervisor trigger/executor policy and session parsers accept heavy without selecting it"
        );
    }
    `);
      execFileSync('rustc', ['--edition=2024', source, '-L', `dependency=${board}/target/debug/deps`,
        '--extern', `board_forge=${board}/target/debug/libboard_forge.rlib`,
        '--extern', `serde_json=${board}/target/debug/deps/${libs[0]}`, '-o', `${temp}/probe`], { stdio: 'inherit' });
      execFileSync(`${temp}/probe`, [], { stdio: 'inherit' });
      for (const test of ['actual_summary_model_sets_price_not_requested_effort',
        'heavy_plan_cannot_bypass_the_weekly_budget', 'accepted_triage_plans_start_once']) {
        execFileSync('cargo', ['test', ...cargo, test], { stdio: 'inherit' });
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }

# Manual: node >=22.18, read-only review source checkout; no dependencies needed.
test-heavy-review review:
    #!/usr/bin/env node
    // Read-only probe of the review UI's actual pools parser, not a copy.
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { execFileSync } = require('node:child_process');
    async function main() {
      const source = process.argv[2];
      const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const { parseBudget } = await import(pathToFileURL(path.resolve(source, 'src/github/usage.ts')));
      const pools = JSON.parse(fs.readFileSync('.github/agentic-job/pools.json', 'utf8'));
      const now = Date.parse('2026-11-05T00:00:00Z');
      const before = parseBudget(JSON.stringify(pools), now);
      assert.equal(before.limitUsd, 300);
      pools.openai.heavy = { model: 'praxis/gpt-6-astra' };
      assert.deepEqual(parseBudget(JSON.stringify(pools), now), before);
      console.log(`ok review UI parseBudget at ${revision} accepts heavy; deployed UI revision remains unverified`);
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });

# Offline status generation and the documented newest-complete selector.
test-review-corpus:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { execFileSync, spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/review-corpus.yml', 'utf8');
    const docs = fs.readFileSync('docs/review-corpus.md', 'utf8');
    const pack = /- name: Pack\n([\s\S]*?)(?=      - uses:)/.exec(workflow)[1];
    assert.match(pack, /COLLECTED: \$\{\{ steps\.collect\.outcome \}\}/);
    const script = /run: \|\n([\s\S]*)/.exec(pack)[1].replace(/^          /gm, '');
    const statusScript = script.split('cgwalters-forge-misctool review-corpus stats')[0];
    const checksumScript = script.trim().split('\n').at(-1);
    const selector = /```sh\n(tags=[\s\S]*?)```/.exec(docs)[1];
    const temp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'review-corpus-'));
    const env = { ...process.env, MISCTOOL_VERSION: 'v0.1.0', LOGIN: 'cgwalters', SINCE: '2020-11-01',
      RUN: 'https://github.com/example/tracker/actions/runs/42' };
    const shell = (source, extra = {}) => execFileSync('bash', ['-euo', 'pipefail', '-c', source],
      { cwd: temp, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      for (const [outcome, quota] of [['success', ''], ['success', 'stopped'], ['failure', 'unknown'], ['failure', ''],
        ['cancelled', ''], ['skipped', ''], ['', '']]) {
        shell(statusScript, { COLLECTED: outcome, QUOTA: quota });
        assert.deepEqual(JSON.parse(fs.readFileSync(`${temp}/dist/status.json`, 'utf8')), {
          complete: outcome === 'success' && !quota, stopped_for_quota: quota === 'stopped',
          collector_version: env.MISCTOOL_VERSION, login: env.LOGIN,
          window: { since: env.SINCE, until: null }, run_url: env.RUN,
        });
        for (const name of ['review-corpus.jsonl.zst', 'review-corpus-state.json']) fs.writeFileSync(`${temp}/dist/${name}`, 'fixture');
        shell(checksumScript);
        shell('cd dist && sha256sum --check SHA256SUMS');
        assert.match(fs.readFileSync(`${temp}/dist/SHA256SUMS`, 'utf8'), /  status\.json\n/);
        fs.appendFileSync(`${temp}/dist/status.json`, 'corruption');
        assert.throws(() => shell('cd dist && sha256sum --check SHA256SUMS'), /Command failed/);
        fs.rmSync(`${temp}/dist`, { recursive: true });
      }
      // Stub quota reads: FIRST before collector startup, LEFT thereafter.
      const collect = /- name: Collect\n[\s\S]*?run: \|\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1].replace(/^          /gm, '');
      const stubs = fs.mkdtempSync(`${temp}/stubs-`);
      // Exercise real timeout/kill behavior with shorter fixture-only deadlines.
      fs.writeFileSync(`${stubs}/timeout`, `#!/bin/sh\n[ "$1 $2" = '--kill-after=5s 10s' ] || exit 2\nshift 2\nexec /usr/bin/timeout --kill-after=0.1s 0.5s "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(`${stubs}/cgwalters-forge-misctool`, `#!${process.execPath}
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.appendFileSync('signals', 'SIGTERM\\n'); if (!process.env.STUBBORN) process.exit(0); });
    fs.writeFileSync('ready', '');
    if (process.env.EXIT) setTimeout(() => process.exit(+process.env.EXIT), 200); else setInterval(() => {}, 1000);
    `, { mode: 0o755 });
      fs.writeFileSync(`${stubs}/gh`, `#!/bin/sh
    case "$*" in *limit) LEFT=\${LIMIT-5000};;
    *) if [ -f asked ]; then until [ -f ready ]; do /bin/sleep 0.01; done; else : > asked; LEFT=\${FIRST-$LEFT}; fi;; esac
    case "$LEFT" in hung) trap '' TERM; exec /bin/sleep 60;; api-error) exit 1;; esac
    [ -n "$LEFT" ] && echo "$LEFT"
    `, { mode: 0o755 });
      fs.writeFileSync(`${stubs}/sleep`, '#!/bin/sh\nexec /bin/sleep 0.05\n', { mode: 0o755 });
      const runCollect = extra => {
        for (const f of ['signals', 'output', 'ready', 'asked']) fs.rmSync(`${temp}/${f}`, { force: true });
        fs.writeFileSync(`${temp}/output`, '');
        const got = spawnSync('bash', ['-eo', 'pipefail', '-c', collect], { cwd: temp, encoding: 'utf8', env: { ...env,
          PATH: `${stubs}:${process.env.PATH}`, GITHUB_OUTPUT: `${temp}/output`, RATE_LIMIT_RESERVE: '1500', ...extra }, timeout: 10000 });
        assert.equal(got.error, undefined, 'collector must stop within the test bound');
        const read = f => fs.existsSync(`${temp}/${f}`) ? fs.readFileSync(`${temp}/${f}`, 'utf8') : '';
        return { status: got.status, output: read('output'), signals: read('signals') };
      };
      for (const STUBBORN of ['', '1']) assert.deepEqual(runCollect({ FIRST: '5000', LEFT: '1499', STUBBORN }),
        { status: 0, output: 'quota=stopped\n', signals: 'SIGTERM\n' });
      assert.deepEqual(runCollect({ LEFT: '1499' }), { status: 0, output: 'quota=stopped\n', signals: '' });
      assert(!fs.existsSync(`${temp}/ready`), 'below the reserve must not start collection');
      const check = /- name: Check the quota reserve\n[\s\S]*?run: \|\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1].replace(/^          /gm, '');
      const checkReserve = (limit, reserve = '1500') => spawnSync('bash', ['-eo', 'pipefail', '-c', check], { cwd: temp, timeout: 10000,
        env: { ...env, PATH: `${stubs}:${process.env.PATH}`, RATE_LIMIT_RESERVE: reserve, LIMIT: limit } }).status;
      for (const [limit, status] of [['5000', 0], ['1500', 1], ['1000', 1], ['', 1], ['hung', 128 + 9 /* SIGKILL */]]) assert.equal(checkReserve(limit), status, `limit ${limit}`);
      const reserve = /^  RATE_LIMIT_RESERVE: (\d+)$/m.exec(workflow)[1];
      assert.equal(checkReserve('1000', reserve), 0, 'configured reserve fits the job token');
      assert(+reserve > 0);
      for (const left of ['', 'null', 'api-error', 'hung', '-1', '1.5', '1500\n1500', '18446744073709556616']) {
        assert.deepEqual(runCollect({ LEFT: left }), { status: 1, output: 'quota=unknown\n', signals: '' });
        assert(!fs.existsSync(`${temp}/ready`), 'unknown quota must not start collection');
        for (const stubborn of ['', '1']) assert.deepEqual(runCollect({ FIRST: '5000', LEFT: left, STUBBORN: stubborn }),
          { status: 1, output: 'quota=unknown\n', signals: 'SIGTERM\n' });
      }
      for (const extra of [{ LEFT: '1500' }, { LEFT: '01500' }, { LEFT: '0', RATE_LIMIT_RESERVE: '0' }])
        assert.deepEqual(runCollect({ ...extra, EXIT: '0' }), { status: 0, output: '', signals: '' });
      assert(!fs.existsSync(`${temp}/asked`), 'disabled reserve must not query GitHub');
      assert.deepEqual(runCollect({ LEFT: '1500', EXIT: '3' }), { status: 3, output: '', signals: '' });
      const publish = /- name: Publish\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1];
      assert.match(publish, /draft:true[^]*status\.json[^]*gh api "\$api\/\$id" --method PATCH -F draft=false/);
      // Stub only gh's transport; run the documentation's real jq filters and loop.
      fs.writeFileSync(`${temp}/gh`, `#!${process.execPath}
    const { execFileSync } = require('node:child_process');
    const args = process.argv.slice(2);
    const rows = JSON.parse(process.env.RELEASES);
    if (process.env.FAIL === args[1]) process.exit(1);
    const row = rows.find(r => r.tagName === args[2]);
    const value = args[1] === 'list' ? rows.filter(r => !r.draft) : row;
    if (args[1] === 'download') process.stdout.write(process.env.RAW_STATUS ?? JSON.stringify(row.status));
    else process.stdout.write(execFileSync('jq', ['-r', args[args.indexOf('--jq') + 1]], { input: JSON.stringify(value) }));
    `, { mode: 0o755 });
      const fixtures = JSON.parse(fs.readFileSync('.github/review-corpus-selector-cases.json', 'utf8'));
      const tag = n => n === 0 ? 'review-corpus' : `review-corpus-20261105-00000${n}`;
      const release = (n, status, draft = false) => ({ tagName: tag(n), draft,
        status: status === undefined ? undefined : { ...fixtures.metadata, ...status },
        assets: status === undefined ? [] : [{ name: 'status.json' }] });
      // A broken newer marker must not silently select the valid older release.
      const cases = [...fixtures.cases,
        ...fixtures.invalid_statuses.map(status => ({ releases: [[3, status], [2, { complete: true }]], invalid: true }))];
      for (const scenario of cases) {
        const { releases = fixtures.cases[0].releases, raw, fail, selected, invalid } = scenario;
        const got = spawnSync('bash', ['-euo', 'pipefail', '-c', selector], { cwd: temp, encoding: 'utf8',
          env: { ...env, PATH: `${temp}:${process.env.PATH}`, RELEASES: JSON.stringify(releases.map(r => release(...r))),
            RAW_STATUS: raw, FAIL: fail } });
        assert.equal(got.status, invalid || fail ? 1 : 0, JSON.stringify(scenario));
        assert.equal(got.stdout, selected === undefined ? '' : `${tag(selected)}\n`, JSON.stringify(scenario));
        if (invalid && raw !== '{') assert.match(got.stderr, /invalid review corpus status/, JSON.stringify(scenario));
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('ok review-corpus quota reserve, status, checksums, draft publication and newest-complete sample selection');

# Manual structural checks of the offline architecture-review prototype.
test-architecture-review mode="test" id="B2588":
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');
    const test = require('node:test');
    const { execFileSync } = require('node:child_process');
    const { mkdirSync, writeFileSync, lstatSync, readdirSync, mkdtempSync, rmSync, renameSync } = require('node:fs');

    const read = name => readFileSync(`docs/architecture-review/${name}`, 'utf8');
    const json = name => JSON.parse(read(name));
    const references = json('references.json');
    const version = references.version;
    const sample = json('sample.json');
    const results = json('results.json');

    const sha256 = text => createHash('sha256').update(text).digest('hex');

    // Manual only: no network in the default check or fixtures. Bound network
    // requests so missing history cannot turn a packet audit into a crawl.
    const api = (endpoint, accept = 'application/vnd.github+json') => execFileSync(
      'gh', ['api', endpoint, '-H', `Accept: ${accept}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    const text = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const apiJSON = endpoint => JSON.parse(text(api(endpoint)));
    const save = (name, value) => writeFileSync(`docs/architecture-review/${name}`, JSON.stringify(value, null, 2) + '\n');

    function annotate(diff) {
      let next = null;
      return diff.split('\n').map(line => {
        if (line.startsWith('diff --git ')) next = null;
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { next = Number(hunk[1]); return line; }
        if (next !== null && /^[ +\-]/.test(line)) {
          const number = line[0] === '-' ? '' : String(next++);
          return number.padStart(4) + ' ' + line;
        }
        return line;
      }).join('\n');
    }

    function select(diff, sources, limits) {
      const files = [{ name: 'diff.patch', data: Buffer.from(annotate(text(diff)), 'utf8') }];
      let total = files[0].data.length;
      assert.ok(limits.max_files >= 1 && total <= limits.max_bytes, 'complete annotated diff must fit');
      const omitted = [];
      const names = new Set(['diff.patch']);
      // UTF-8 byte ordering is independent of the host locale.
      sources.sort((a, b) => a.data.length - b.data.length || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      for (const source of sources) {
        text(source.data); // No lossy decoding, BOM stripping or newline normalization.
        const name = 'head/' + source.path.replaceAll('/', '__');
        assert.ok(!names.has(name), `filename collision: ${source.path}`);
        names.add(name);
        if (files.length >= limits.max_files || total + source.data.length > limits.max_bytes) {
          omitted.push({ path: source.path, revision: source.revision, bytes: source.data.length,
            reason: 'packet byte/file limit; changed hunks remain in diff.patch' });
        } else {
          files.push({ name, path: source.path, data: source.data });
          total += source.data.length;
        }
      }
      return { files, omitted, total_bytes: total };
    }

    function comparePacket(packet, manifest) {
      const files = manifest.files.map(expected => {
        const actual = packet.files.find(f => f.name === expected.name);
        return { name: expected.name, expected_bytes: expected.bytes, actual_bytes: actual?.data.length ?? null,
          expected_sha256: expected.sha256, actual_sha256: actual ? sha256(actual.data) : null,
          match: !!actual && actual.data.length === expected.bytes && sha256(actual.data) === expected.sha256 };
      });
      return { files, expected_total_bytes: manifest.total_bytes, actual_total_bytes: packet.total_bytes,
        expected_file_order: manifest.files.map(f => f.name), actual_file_order: packet.files.map(f => f.name),
        expected_omitted: manifest.omitted, actual_omitted: packet.omitted,
        total_match: packet.total_bytes === manifest.total_bytes,
        ordering_match: JSON.stringify(packet.files.map(f => f.name)) === JSON.stringify(manifest.files.map(f => f.name)),
        omissions_match: JSON.stringify(packet.omitted) === JSON.stringify(manifest.omitted),
        all_match: files.every(f => f.match) && packet.total_bytes === manifest.total_bytes &&
          JSON.stringify(packet.files.map(f => f.name)) === JSON.stringify(manifest.files.map(f => f.name)) &&
          JSON.stringify(packet.omitted) === JSON.stringify(manifest.omitted) };
    }

    function validateHistory(comparison, s, manifest) {
      const base = s.reconstructed_base ?? s.candidate_base;
      assert.equal(comparison.status, 'ahead');
      assert.equal(comparison.merge_base_commit.sha, base);
      assert.equal(comparison.total_commits, comparison.commits.length, 'truncated commits');
      assert.ok(comparison.files.length < 300, 'possibly truncated changed files');
      assert.equal(manifest.first_feedback_at, s.feedback_at);
      assert.ok(comparison.commits.every(c => c.commit.committer.date <= s.feedback_at), 'post-feedback commit');
      assert.deepEqual(comparison.commits.map(c => ({ sha: c.sha, committed: c.commit.committer.date })), manifest.commits);
    }

    // Hashes alone miss extra context (especially feedback) beside reviewed files.
    // The only allowed directories are the root and head, if the manifest uses it.
    function readPacket(directory, manifest) {
      const names = manifest.files.map(f => f.name);
      assert.equal(new Set(names).size, names.length, 'duplicate packet filename');
      assert.ok(names.includes('diff.patch'), 'missing diff.patch');
      for (const name of names) assert.match(name, /^(?:diff\.patch|head\/[^/]+)$/);
      for (const name of names) assert.ok(!['head/.', 'head/..'].includes(name), 'unsafe packet filename');
      const directories = names.some(n => n.startsWith('head/')) ? ['', 'head'] : [''];
      for (const dir of directories) {
        const path = dir ? `${directory}/${dir}` : directory;
        assert.ok(lstatSync(path).isDirectory(), `not a real directory: ${path}`);
        const expected = dir ? names.filter(n => n.startsWith('head/')).map(n => n.slice(5)) :
          ['diff.patch', ...(directories.includes('head') ? ['head'] : [])];
        assert.deepEqual([...readdirSync(path)].sort(), expected.sort(), `unexpected packet entries: ${path}`);
      }
      return names.map(name => {
        const path = `${directory}/${name}`;
        assert.ok(lstatSync(path).isFile(), `not a regular packet file: ${path}`);
        return { name, data: readFileSync(path) };
      });
    }

    if (process.argv[2] === 'verify') {
      const id = process.argv[3];
      assert.ok(sample.samples.some(s => s.id === id && s.status === 'evaluated'), 'unknown evaluated sample');
      const manifest = json(`runs/${id}.manifest.json`);
      const files = readPacket(`/tmp/opencode/architecture-review-${id}`, manifest);
      const report = comparePacket({ files, omitted: manifest.omitted,
        total_bytes: files.reduce((sum, f) => sum + f.data.length, 0) }, manifest);
      // Exact directory integrity and bytes, not independently reconstructed selection/omissions.
      console.log(`${id}: exact packet verification ${report.all_match ? 'matches' : 'MISMATCH'}`);
      if (!report.all_match) console.log(JSON.stringify(report, null, 2));
      process.exit(report.all_match ? 0 : 1);
    }

    if (process.argv[2] === 'rebuild') {
      const id = process.argv[3];
      const s = sample.samples.find(s => s.id === id && s.status === 'evaluated');
      assert.ok(s, 'unknown evaluated sample');
      const manifest = json(`runs/${id}.manifest.json`);
      const base = s.reconstructed_base ?? s.candidate_base;
      const endpoint = `repos/${s.repository}/compare/${base}...${s.head}`;
      const comparison = apiJSON(endpoint);
      validateHistory(comparison, s, manifest);
      const diff = api(endpoint, 'application/vnd.github.diff');
      const sources = comparison.files.filter(f => f.status !== 'removed').map(f => {
        const path = f.filename.split('/').map(encodeURIComponent).join('/');
        const content = apiJSON(`repos/${s.repository}/contents/${path}?ref=${s.head}`);
        assert.equal(content.type, 'file');
        assert.equal(content.encoding, 'base64');
        const data = Buffer.from(content.content, 'base64');
        assert.equal(data.length, content.size, 'missing or truncated contents');
        return { path: f.filename, revision: s.head, data };
      });
      const packet = select(diff, sources, manifest.limits);
      const directory = `/tmp/opencode/architecture-review-${id}`;
      const report = { schema: 'architecture-review.rebuild.v1', id, builder: 'Justfile test-architecture-review rebuild',
        historical_identity: 'Only matching bytes are reconstructed evidence; no new historical review ran.',
        manifest_sha256: sha256(read(`runs/${id}.manifest.json`)),
        ancestry: { status: comparison.status, merge_base: comparison.merge_base_commit.sha, commits_match: true, pre_feedback: true },
        ...comparePacket(packet, manifest) };
      assert.ok(report.all_match, `reconstructed packet MISMATCH: ${JSON.stringify(report)}`);
      const staging = mkdtempSync(`${directory}.staging-`);
      try {
        if (packet.files.some(f => f.name.startsWith('head/'))) mkdirSync(`${staging}/head`);
        for (const file of packet.files) writeFileSync(`${staging}/${file.name}`, file.data);
        const files = readPacket(staging, manifest);
        assert.ok(comparePacket({ ...packet, files }, manifest).all_match, 'staged packet MISMATCH');
        // Replace the entire old tree: no stale source or scoring material survives.
        // Publication is after comparison; a failed retrieval never publishes new bytes.
        rmSync(directory, { recursive: true, force: true });
        renameSync(staging, directory);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      save(`runs/${id}.rebuild.json`, report);
      console.log(`${id}: exact packet matches; details in runs/${id}.rebuild.json`);
      process.exit(0);
    }

    if (process.argv[2] === 'feedback') {
      const inventory = { schema: 'architecture-review.feedback.v1', author: 'cgwalters', retrieved_at: new Date().toISOString(),
        purpose: 'Scoring only; never historical reviewer input.', samples: [] };
      for (const s of sample.samples.filter(s => s.status === 'evaluated')) {
        const entry = { id: s.id, channels: [], units: [] };
        for (const [channel, endpoint] of [
          ['inline', `repos/${s.repository}/pulls/${s.pr}/comments`],
          ['review', `repos/${s.repository}/pulls/${s.pr}/reviews`],
          ['pr', `repos/${s.repository}/issues/${s.pr}/comments`],
        ]) {
          let complete = false;
          const pages = [];
          for (let page = 1; page <= 10; page++) {
            const rows = apiJSON(`${endpoint}?per_page=100&page=${page}`);
            pages.push(rows.length);
            for (const r of rows.filter(r => r.user.login === 'cgwalters')) {
              entry.units.push({ channel, id: r.id, url: r.html_url, body: r.body ?? '',
                created_at: r.created_at ?? r.submitted_at, updated_at: r.updated_at ?? null,
                commit_id: r.commit_id ?? null, in_reply_to_id: r.in_reply_to_id ?? null,
                path: r.path ?? null, original_line: r.original_line ?? null, diff_hunk: r.diff_hunk ?? null });
            }
            if (rows.length < 100) { complete = true; break; }
          }
          assert.ok(complete, `pagination cap: ${endpoint}`);
          entry.channels.push({ channel, endpoint, per_page: 100, page_sizes: pages, complete });
        }
        inventory.samples.push(entry);
      }
      save('feedback.json', inventory);
      console.log('Archived paginated cgwalters feedback for three samples; classification is separate.');
      process.exit(0);
    }

    assert.ok(['test', 'fixtures', 'e2e'].includes(process.argv[2]), 'expected test, fixtures, e2e, rebuild, verify or feedback');
    if (process.argv[2] === 'e2e') test('offline canned-API rebuild/verify dispatch', () => {
      const fs = require('node:fs');
      const vm = require('node:vm');
      const sandbox = fs.mkdtempSync('/tmp/opencode/architecture-review-test-');
      const source = /^test-architecture-review .*:\n((?:    .*\n|\n)+)/m.exec(fs.readFileSync('Justfile', 'utf8'))[1]
        .replace(/^    /gm, '');
      const id = 'B2588';
      const s = sample.samples.find(s => s.id === id);
      const base = s.reconstructed_base ?? s.candidate_base;
      const endpoint = `repos/${s.repository}/compare/${base}...${s.head}`;
      const diff = '@@ -1 +1 @@\n-old\n+new\n';
      const data = Buffer.from('new\n');
      const packet = select(Buffer.from(diff), [{ path: 'x', revision: s.head, data }], { max_files: 30, max_bytes: 100000 });
      const manifest = { files: packet.files.map(f => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
        total_bytes: packet.total_bytes, omitted: [], limits: { max_files: 30, max_bytes: 100000 },
        first_feedback_at: s.feedback_at, commits: [{ sha: s.head, committed: s.feedback_at }] };
      const history = { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 1,
        commits: [{ sha: s.head, commit: { committer: { date: s.feedback_at } } }], files: [{ filename: 'x', status: 'modified' }] };
      const directory = `${sandbox}/packet`;
      const map = path => typeof path === 'string' && path.startsWith(`/tmp/opencode/architecture-review-${id}`) ?
        path.replace(`/tmp/opencode/architecture-review-${id}`, directory) : path;
      const exit = {};
      let failure = null;
      let calls = 0;
      const wrappedFS = { ...fs };
      for (const method of ['readFileSync', 'lstatSync', 'readdirSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'writeFileSync']) {
        wrappedFS[method] = (path, ...args) => {
          if (path === `docs/architecture-review/runs/${id}.manifest.json` && method === 'readFileSync') return JSON.stringify(manifest);
          if (path === `docs/architecture-review/runs/${id}.rebuild.json` && method === 'writeFileSync') path = `${sandbox}/report.json`;
          if (failure === 'staging' && method === 'writeFileSync' && path.includes('.staging-') && path.endsWith('/head/x')) args[0] = 'damaged staging';
          return fs[method](map(path), ...args);
        };
      }
      wrappedFS.renameSync = (from, to) => fs.renameSync(map(from), map(to));
      const dispatch = mode => {
        let status = null;
        try {
          vm.runInNewContext(source, { Buffer, TextDecoder, console: { log() {} },
            process: { argv: ['node', 'recipe', mode, id], exit(code) { status = code; throw exit; } },
            require(name) {
              if (name === 'node:fs') return wrappedFS;
              if (name === 'node:child_process') return { execFileSync(command, args, options) {
                calls++;
                assert.equal(command, 'gh');
                assert.equal(args[0], 'api');
                assert.equal(options.timeout, 20000);
                assert.equal(options.maxBuffer, 8 * 1024 * 1024);
                if (failure === 'retrieval') throw new Error('canned retrieval failure');
                if (args[1] === endpoint) return Buffer.from(args.includes('Accept: application/vnd.github.diff') ?
                  (failure === 'comparison' ? diff + 'bad' : diff) : JSON.stringify(history));
                assert.equal(args[1], `repos/${s.repository}/contents/x?ref=${s.head}`);
                return Buffer.from(JSON.stringify({ type: 'file', encoding: 'base64', content: data.toString('base64'), size: data.length }));
              } };
              return require(name);
            } });
        } catch (error) {
          if (error !== exit) return { status: 1, error };
        }
        return { status };
      };
      const succeeds = mode => { const result = dispatch(mode); assert.equal(result.status, 0, `${mode}: ${result.error?.stack ?? ''}`); };
      const fails = mode => assert.equal(dispatch(mode).status, 1, mode);
      try {
        succeeds('rebuild');
        succeeds('verify');
        const before = calls;
        for (const [name, kind] of [['head/obsolete.txt', 'file'], ['feedback.json', 'file'],
          ['feedback', 'directory'], ['head/extra', 'directory'], ['head/link', 'symlink']]) {
          const path = `${directory}/${name}`;
          if (kind === 'directory') fs.mkdirSync(path);
          else if (kind === 'symlink') fs.symlinkSync(`${directory}/diff.patch`, path);
          else fs.writeFileSync(path, 'stale feedback');
          fails('verify');
          succeeds('rebuild');
          assert.equal(fs.existsSync(path), false, name);
          succeeds('verify');
        }
        assert.ok(calls > before);
        succeeds('rebuild'); // Repeated reconstruction has the same exact packet.
        for (const name of ['diff.patch', 'head/x']) {
          fs.rmSync(`${directory}/${name}`);
          fs.symlinkSync(`${sandbox}/report.json`, `${directory}/${name}`);
          fails('verify');
          succeeds('rebuild');
        }
        fs.renameSync(`${directory}/head`, `${sandbox}/old-head`);
        fs.symlinkSync(`${sandbox}/old-head`, `${directory}/head`);
        fails('verify');
        succeeds('rebuild');
        fs.renameSync(directory, `${sandbox}/old-packet`);
        fs.symlinkSync(`${sandbox}/old-packet`, directory);
        fails('verify');
        succeeds('rebuild');
        fs.writeFileSync(`${directory}/head/x`, 'bad\n');
        fails('verify');
        for (const reason of ['retrieval', 'comparison', 'staging']) {
          failure = reason;
          const oldReport = fs.readFileSync(`${sandbox}/report.json`, 'utf8');
          fails('rebuild');
          assert.equal(fs.readFileSync(`${directory}/head/x`, 'utf8'), 'bad\n', 'failed rebuild does not publish');
          assert.equal(fs.readFileSync(`${sandbox}/report.json`, 'utf8'), oldReport);
          fails('verify');
          fs.rmSync(directory, { recursive: true });
          fails('rebuild');
          assert.equal(fs.existsSync(directory), false, 'failed rebuild does not create a packet');
          failure = null;
          succeeds('rebuild');
          fs.writeFileSync(`${directory}/head/x`, 'bad\n');
        }
        fs.rmSync(`${directory}/head/x`);
        fails('verify');
        failure = null;
        succeeds('rebuild');
        succeeds('verify');
        assert.deepEqual(fs.readdirSync(sandbox).filter(n => n.includes('.staging-')), []);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
    test('offline packet annotation and selection fixtures', () => {
      const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n\\ No newline at end of file\n';
      assert.equal(annotate(diff), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n     -old\n   1 +new\n   2  same\n\\ No newline at end of file\n');
      assert.equal(annotate('@@ -0,0 +1 @@\n+é\r\n'), '@@ -0,0 +1 @@\n   1 +é\r\n');
      assert.equal(annotate('@@ -1 +0,0 @@\n-x'), '@@ -1 +0,0 @@\n     -x');
      const sources = ['z', 'a', 'large'].map(path => ({ path, data: Buffer.from(path === 'large' ? 'xxx' : 'é') }));
      const packet = select(Buffer.from(''), sources, { max_files: 2, max_bytes: 2 });
      assert.deepEqual(packet.files.map(f => f.name), ['diff.patch', 'head/a']);
      assert.equal(packet.total_bytes, 2);
      assert.equal(packet.omitted.length, 2);
      assert.equal(select(Buffer.from(''), sources, { max_files: 30, max_bytes: 4 }).files.length, 3);
      assert.equal(select(Buffer.from(''), sources, { max_files: 1, max_bytes: 100 }).files.length, 1);
      assert.equal(select(Buffer.from(''), sources, { max_files: 30, max_bytes: 1 }).files.length, 1);
      assert.throws(() => select(Buffer.from('abc'), [], { max_files: 30, max_bytes: 2 }));
      assert.throws(() => select(Buffer.from(''), [{ path: 'a/b', data: Buffer.from('') }, { path: 'a__b', data: Buffer.from('') }], { max_files: 30, max_bytes: 10 }));
      assert.throws(() => text(Buffer.from([255])));
      const manifest = { files: packet.files.map(f => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })), total_bytes: 2, omitted: packet.omitted };
      assert.equal(comparePacket(packet, manifest).all_match, true);
      assert.equal(comparePacket({ ...packet, files: packet.files.map(f => ({ ...f, data: Buffer.from('bad') })) }, manifest).all_match, false);
      assert.equal(comparePacket(packet, { ...manifest, total_bytes: 3 }).all_match, false);
      assert.equal(comparePacket(packet, { ...manifest, omitted: [] }).all_match, false);
      assert.equal(comparePacket(packet, { ...manifest, files: manifest.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) }).all_match, false);
      assert.equal(comparePacket({ ...packet, files: [...packet.files].reverse() }, manifest).all_match, false);
      const s = { candidate_base: 'base', feedback_at: '2026-01-02T00:00:00Z' };
      const commits = [{ sha: 'head', commit: { committer: { date: '2026-01-01T00:00:00Z' } } }];
      const history = { status: 'ahead', merge_base_commit: { sha: 'base' }, total_commits: 1, commits, files: [] };
      const frozen = { first_feedback_at: s.feedback_at, commits: [{ sha: 'head', committed: '2026-01-01T00:00:00Z' }] };
      validateHistory(history, s, frozen);
      assert.throws(() => validateHistory({ ...history, status: 'diverged' }, s, frozen));
      assert.throws(() => validateHistory({ ...history, merge_base_commit: { sha: 'wrong' } }, s, frozen));
      assert.throws(() => validateHistory({ ...history, total_commits: 2 }, s, frozen));
      assert.throws(() => validateHistory({ ...history, files: Array(300).fill({}) }, s, frozen));
      assert.throws(() => validateHistory(history, { ...s, feedback_at: '2025-01-01T00:00:00Z' }, { ...frozen, first_feedback_at: '2025-01-01T00:00:00Z' }));
      assert.throws(() => validateHistory(history, s, { ...frozen, commits: [] }));
    });

    function validateCounts(r) {
      const evaluated = sample.samples.filter(s => s.status === 'evaluated');
      assert.equal(r.selected_prs, sample.samples.length);
      assert.equal(r.evaluated_prs, evaluated.length);
      assert.equal(r.evaluated_prs + r.rejected_prs, r.selected_prs);
      assert.equal(r.architecture_concerns + r.excluded_nits + r.excluded_acknowledgements + r.excluded_empty_reviews,
        r.classification_units);
      assert.equal(r.classification_units, r.audited_feedback_records + r.split_extra_units);
      assert.equal(r.audited_feedback_records, r.audited_inline_comments + r.audited_review_bodies + r.audited_pr_comments);
      assert.equal(r.architecture_concerns, r.concerns.length);
      assert.equal(r.executed_reviews, r.runs.length);
      assert.deepEqual(r.runs.map(run => run.id), evaluated.map(s => s.id));
      assert.ok(r.compared_prs <= r.executed_reviews);
      assert.equal(r.status, 'development_pilot');
      assert.equal(r.held_out_claim, false);
      for (const c of r.concerns) {
        assert.ok(['concern', 'question'].includes(c.stratum), c.id);
        assert.ok(r.runs.some(run => c.id.startsWith(`${run.id}-`)), c.id);
        if (c.matched_by) assert.ok(c.scorable && c.matched_by.startsWith(c.id.split('-')[0]), c.id);
        if (!c.scorable) assert.ok(c.unscorable_reason, c.id);
      }
      for (const f of Object.values(r.findings)) assert.equal(f.matched + f.unmatched, f.total);
      for (const [key, stratum] of [['concerns', 'concern'], ['questions', 'question']]) {
        const units = r.concerns.filter(c => c.stratum === stratum);
        const counts = r.strata[key];
        assert.equal(counts.total, units.length);
        assert.equal(counts.scorable, units.filter(c => c.scorable).length);
        assert.equal(counts.matched, units.filter(c => c.matched_by).length);
        assert.equal(counts.missed, counts.scorable - counts.matched);
        assert.equal(counts.unscorable, counts.total - counts.scorable);
      }
      const a = r.unmatched_audit;
      assert.equal(a.supported + a.unsupported + a.unresolved, a.audited);
      assert.ok(a.audited <= r.findings.defects.unmatched + r.findings.questions.unmatched);
    }

    test('explicit version and pinned, publicly linked source files', () => {
      assert.equal(version, '0.1.0');
      assert.equal(results.version, version);
      assert.equal(references.references.length, 9);
      for (const [file, digest] of Object.entries(results.artifact_sha256)) {
        assert.equal(sha256(read(file)), digest, file);
      }
      const ids = new Set();
      for (const r of references.references) {
        assert.match(r.revision, /^[a-f0-9]{40}$/);
        assert.ok(r.sections.length > 0);
        assert.ok(!ids.has(r.id));
        ids.add(r.id);
        assert.ok(read('README.md').includes(
          `https://github.com/${r.repository}/blob/${r.revision}/${r.path}`));
      }
    });

    test('six scoped architecture patterns with explicitly illustrative examples', () => {
      const library = read('patterns.md');
      const sections = library.split(/^## /m).slice(1);
      assert.equal(sections.length, 6);
      sections.forEach((s, i) => {
        assert.ok(s.startsWith(`AR-0${i + 1}:`));
        for (const label of ['Principle', 'Scope/exceptions', 'Source',
          'Good (illustrative)', 'Bad (illustrative)']) assert.ok(s.includes(`**${label}:**`));
        assert.ok(references.references.some(r => s.includes(r.id)));
      });
    });

    test('prompt covers design dimensions, evidence, uncertainty and read-only boundary', () => {
      const prompt = read('prompt.md');
      assert.ok(prompt.includes(`prompt ${version}`));
      for (const dimension of ['Invariants', 'State ownership', 'Failure and rollback',
        'Compatibility and interfaces', 'Dependency ordering', 'Privilege boundaries', 'Testing']) {
        assert.ok(prompt.includes(`**${dimension}:**`));
      }
      for (const phrase of ['untrusted **data**', 'Do not execute', 'Do not edit files',
        'concrete PR evidence', 'Uncertainty/questions', 'nit-checklist',
        '100,000', 'contaminated', 'Archive this output unchanged', 'references.json'
      ]) assert.ok(prompt.includes(phrase));
    });

    test('sample pins are separate from derivation and not leaked into prompt/library', () => {
      const ids = new Set(sample.samples.map(s => s.id));
      assert.equal(ids.size, sample.samples.length);
      for (const s of sample.samples) {
        assert.ok(['evaluated', 'rejected'].includes(s.status), s.id);
        if (s.status === 'rejected') assert.ok(s.rejection, s.id);
        // A later replacement must name what it replaces, never substitute silently.
        if (!s.frozen_before_prompt_authoring) {
          assert.equal(sample.samples.find(r => r.id === s.replaces)?.status, 'rejected', s.id);
        }
        for (const sha of [s.head, s.candidate_base, ...(s.reconstructed_base ? [s.reconstructed_base] : [])]) {
          assert.match(sha, /^[a-f0-9]{40}$/);
          assert.ok(!references.references.some(r => r.revision === sha));
          for (const file of ['patterns.md', 'prompt.md']) assert.ok(!read(file).includes(sha));
        }
        for (const file of ['patterns.md', 'prompt.md']) {
          assert.ok(!read(file).includes(`/${s.repository}/pull/${s.pr}`));
        }
        assert.ok(s.review.startsWith(`https://github.com/${s.repository}/pull/${s.pr}#`));
      }
    });

    test('archived runs match their pinned packets and recorded hashes', () => {
      for (const run of results.runs) {
        const s = sample.samples.find(x => x.id === run.id);
        const manifest = json(run.manifest);
        assert.equal(manifest.head, s.head, run.id);
        assert.equal(manifest.base, s.reconstructed_base ?? s.candidate_base, run.id);
        assert.equal(manifest.ancestry.compare_status, 'ahead', run.id);
        assert.ok(manifest.commits.every(c => c.committed <= s.feedback_at), run.id);
        assert.ok(manifest.files.length <= manifest.limits.max_files, run.id);
        assert.ok(manifest.total_bytes <= manifest.limits.max_bytes, run.id);
        assert.equal(sha256(read(run.manifest)), run.manifest_sha256, run.id);
        const output = read(run.output);
        assert.equal(sha256(output), run.output_sha256, run.id);
        assert.ok(output.startsWith('Architecture review'), run.id);
        assert.ok(output.includes(s.head), run.id);
      }
    });

    function validateReportIDs(reports) {
      const ids = reports.map(r => r.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate rebuild report ID');
      assert.deepEqual([...ids].sort(), sample.samples.filter(s => s.status === 'evaluated').map(s => s.id).sort(),
        'rebuild report IDs must exactly cover evaluated runs');
    }

    test('rebuild reports compare every recorded size/digest and selection with frozen manifests', () => {
      const reports = results.packet_rebuilds.map(json);
      validateReportIDs(reports);
      assert.throws(() => validateReportIDs([reports[0], reports[0], reports[0]]), /duplicate/);
      assert.throws(() => validateReportIDs(reports.slice(1)), /exactly cover/);
      assert.throws(() => validateReportIDs(reports.map((r, i) => i ? r : { ...r, id: 'unknown' })), /exactly cover/);
      for (const report of reports) {
        const run = results.runs.find(r => r.id === report.id);
        const manifest = json(run.manifest);
        assert.equal(report.manifest_sha256, sha256(read(run.manifest)));
        assert.equal(report.expected_total_bytes, manifest.total_bytes);
        assert.equal(report.actual_total_bytes, manifest.total_bytes);
        assert.deepEqual(report.expected_file_order, manifest.files.map(f => f.name));
        assert.deepEqual(report.actual_file_order, report.expected_file_order);
        assert.deepEqual(report.expected_omitted, manifest.omitted);
        assert.deepEqual(report.actual_omitted, manifest.omitted);
        assert.equal(report.files.length, manifest.files.length);
        report.files.forEach((file, i) => {
          const expected = manifest.files[i];
          assert.equal(file.name, expected.name);
          assert.equal(file.expected_bytes, expected.bytes);
          assert.equal(file.actual_bytes, expected.bytes);
          assert.equal(file.expected_sha256, expected.sha256);
          assert.equal(file.actual_sha256, expected.sha256);
          assert.equal(file.match, true);
        });
        for (const flag of ['all_match', 'ordering_match', 'total_match', 'omissions_match']) assert.equal(report[flag], true);
        assert.equal(report.ancestry.status, 'ahead');
        assert.equal(report.ancestry.merge_base, manifest.base);
        assert.equal(report.ancestry.pre_feedback, true);
        assert.equal(report.ancestry.commits_match, true);
      }
    });

    test('all paginated feedback records have explicit root-deduplicated dispositions', () => {
      const inventory = json(results.feedback_inventory);
      const scoring = json(results.independent_scoring);
      assert.equal(scoring.provenance.feedback_sha256, sha256(read(results.feedback_inventory)));
      assert.equal(inventory.author, 'cgwalters');
      assert.deepEqual(inventory.samples.map(s => s.id), results.runs.map(r => r.id));
      const records = inventory.samples.flatMap(s => s.units);
      assert.equal(records.length, results.audited_feedback_records);
      assert.equal(new Set(records.map(r => r.id)).size, records.length);
      assert.equal(scoring.units.length, records.length);
      for (const [channel, count] of [['inline', results.audited_inline_comments], ['review', results.audited_review_bodies], ['pr', results.audited_pr_comments]]) {
        assert.equal(records.filter(r => r.channel === channel).length, count);
      }
      for (const entry of inventory.samples) {
        assert.deepEqual(entry.channels.map(c => c.channel), ['inline', 'review', 'pr']);
        for (const channel of entry.channels) {
          assert.equal(channel.complete, true);
          assert.equal(channel.per_page, 100);
          assert.ok(channel.page_sizes.length > 0 && channel.page_sizes.length <= 10);
          assert.ok(channel.page_sizes.at(-1) < 100);
          assert.ok(channel.page_sizes.slice(0, -1).every(n => n === 100));
        }
        const frozen = sample.samples.find(s => s.id === entry.id);
        assert.equal(entry.units.map(u => u.created_at).sort()[0], frozen.feedback_at);
        for (const record of entry.units) {
          const units = scoring.units.filter(u => u.record_id === record.id);
          assert.equal(units.length, 1);
          const unit = units[0];
          assert.equal(unit.sample, entry.id);
          assert.equal(unit.url, record.url);
          assert.ok(unit.reason);
          assert.ok(['concern', 'question', 'nit', 'empty'].includes(unit.classification));
          if (unit.classification === 'empty') assert.equal(record.body, '');
          for (const root of unit.roots) {
            const concern = results.concerns.find(c => c.id === root);
            assert.ok(concern, root);
            assert.equal(concern.stratum, unit.classification);
            assert.equal(concern.scorable, unit.scorable);
            assert.equal(concern.matched_by, unit.matched_by);
          }
        }
      }
      const roots = scoring.units.flatMap(u => u.roots);
      assert.equal(new Set(roots).size, roots.length);
      assert.deepEqual([...roots].sort(), results.concerns.map(c => c.id).sort());
      assert.equal(scoring.units.filter(u => u.classification === 'nit').length, results.excluded_nits);
      assert.equal(scoring.units.filter(u => u.classification === 'empty').length, results.excluded_empty_reviews);
      assert.equal(results.scoring_passes, 2);
      assert.match(results.human_adjudication, /not obtained/);
      const totals = scoring.independent_totals;
      for (const [key, value] of Object.entries({ feedback_records: records.length, roots: roots.length,
        scorable_concerns: results.strata.concerns.scorable, matched_concerns: results.strata.concerns.matched,
        scorable_questions: results.strata.questions.scorable, matched_questions: results.strata.questions.matched,
        unscorable_concerns: results.strata.concerns.unscorable, excluded_nits: results.excluded_nits,
        excluded_empty_reviews: results.excluded_empty_reviews })) assert.equal(totals[key], value);
      assert.equal(scoring.finding_dispositions.length, results.findings.defects.total + results.findings.questions.total);
      assert.equal(scoring.finding_dispositions.filter(f => f.matched_by_feedback).length, results.findings.questions.matched);
      for (const key of ['supported', 'unsupported', 'unresolved']) {
        assert.equal(scoring.finding_dispositions.filter(f => f.audit === key).length, results.unmatched_audit[key]);
      }
    });

    test('evaluation counts are consistent and make no held-out claim', () => {
      validateCounts(results);
      assert.throws(() => validateCounts({ ...results, architecture_concerns: 4 }));
      assert.throws(() => validateCounts({ ...results, executed_reviews: 2 }));
      assert.throws(() => validateCounts({ ...results, held_out_claim: true }));
      assert.throws(() => validateCounts({
        ...results, concerns: results.concerns.map(c => ({ ...c, scorable: true, unscorable_reason: undefined, matched_by: c.matched_by ?? 'X1' })),
      }));
      assert.throws(() => validateCounts({
        ...results, unmatched_audit: { ...results.unmatched_audit, supported: 3 },
      }));
    });

# Offline caller contracts; wrapper policy/submission is tested upstream.
test-review-caller:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { runInNewContext } = require('node:vm');
    const { execFileSync, spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/review.yml', 'utf8');
    const dispatch = fs.readFileSync('.github/workflows/dispatch.yml', 'utf8');
    const pass = JSON.parse(fs.readFileSync('.github/pass.json', 'utf8'));
    assert.ok(!Object.hasOwn(pass.pr, 'reviewPools'), 'reviewPools is global across follow');
    assert.ok(!Object.hasOwn(pass.pr, 'reviewDispatchRepositories'), 'ordinary scheduling stays off');
    const expression = value => '$' + '{' + `{ ${value} }}`;
    const job = name => new RegExp(`^  ${name}:\\n([^]*?)(?=^  [a-z][a-z-]*:|$(?![^]))`, 'm').exec(dispatch)?.[1];
    for (const name of ['review-gate', 'review']) assert.ok(job(name).includes(`if: ${expression("inputs.kind == 'review'")}`));
    for (const name of ['profile', 'run']) assert.ok(job(name).includes(`if: ${expression("inputs.kind != 'review'")}`));
    assert.match(job('review'), /^    needs: review-gate$/m);
    assert.match(job('run'), /^    needs: profile$/m);
    const review = job('review');
    assert.match(review, /^    uses: cgwalters-forge\/actions\/\.github\/workflows\/cgwalters-agentic-job.yml@ba6c56925e63551fd4373fbeb23456a2f4a316da$/m);
    const withBlock = review.split('    with:\n')[1].split('    #')[0];
    assert.deepEqual(withBlock.trim().split('\n').map(line => line.trim().split(':')[0]), ['kind', 'repo', 'item', 'head', 'pool', 'task']);
    for (const key of ['repo', 'item', 'head', 'pool']) assert.ok(withBlock.includes(`${key}: ${expression(`inputs.${key}`)}`));
    assert.doesNotMatch(review.replace(/^ *#.*$/gm, ''), /secrets:|inherit|SAFE_OUTPUTS_PAT|INFERENCE_API_KEY|AGENT_MODEL|pools\.json|needs\.profile/);
    assert.match(job('run'), /cgwalters-agentic-job.yml@428fc617f985f8c5c4aabaf22afdbf2dfc744010/);
    assert.match(job('run'), /SAFE_OUTPUTS_PAT: \$\{\{ secrets.CGWALTERS_BOT_PAT \}\}/);
    assert.match(dispatch, /      head:\n[^]*?        type: string\n        default: ''/);
    const gateJob = job('review-gate');
    assert.match(gateJob, /timeout-minutes: 1/);
    assert.ok(gateJob.includes(`ACTIVATION: ${expression('vars.REVIEW_DISPATCH')}`));
    for (const key of ['head', 'effort', 'config', 'issue_repo']) assert.ok(gateJob.includes(`${key.toUpperCase()}: ${expression(`inputs.${key}`)}`));
    const gateScript = /run: \|\n([^]*)/.exec(gateJob)[1].replace(/^          /gm, '');
    const head = 'a'.repeat(40);
    const checkGate = extra => spawnSync('bash', ['-euo', 'pipefail', '-c', gateScript], { encoding: 'utf8',
      env: { PATH: process.env.PATH, ACTIVATION: 'enabled', HEAD: head, CONFIG: 'hosted', EFFORT: '', ...extra } });
    for (const activation of ['', 'true', 'disabled', 'Enabled']) {
      const got = checkGate({ ACTIVATION: activation, HEAD: '' });
      assert.equal(got.status, 1);
      assert.match(got.stderr, /ordinary reviews are disabled/, 'disabled rejected before other work');
    }
    for (const bad of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), `${head}\n`, ` ${head}`]) {
      assert.equal(checkGate({ HEAD: bad }).status, 1, bad);
    }
    assert.equal(checkGate({}).status, 0);
    for (const extra of [{ EFFORT: 'heavy' }, { CONFIG: 'acp-experiment' }, { ISSUE_REPO: 'cgwalters-forge/agent-board' }]) assert.equal(checkGate(extra).status, 1, JSON.stringify(extra));
    // Evaluate actual Actions expressions: exact producer title and exclusive routes.
    const evaluate = (source, inputs) => runInNewContext(source, { inputs, format: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n]) });
    const title = inputs => /^run-name: (.*)$/m.exec(dispatch)[1].replace(/\$\{\{ (.*?) \}\}/g, (_, source) => evaluate(source, inputs));
    const inputs = { kind: 'review', repo: 'cgwalters-forge/tracker', item: '42', head, pool: 'openai', config: 'hosted' };
    assert.equal(title(inputs), `review cgwalters-forge/tracker#42 ${head} (openai)`);
    assert.equal(title({ ...inputs, config: 'acp-experiment' }), title(inputs), 'review title never gains config suffix');
    const kinds = ['implement', 'triage', 'research', 'session', 'review', 'fix'];
    assert.match(dispatch, new RegExp(`^        options: \\[${kinds.join(', ')}\\]$`, 'm'));
    // The profile job's steps, run as they are: the bounds each kind gets
    // and the pool a dispatch without one resolves.
    const step = name => job('profile').split(`      - name: ${name}\n`)[1].split('\n      - ')[0];
    const boundsScript = /run: \|\n([^]*)/.exec(step('Resolve the bounds'))[1].replace(/^          /gm, '');
    const poolSource = /POOL: \$\{\{ (.*?) \}\}/.exec(step('Resolve the pool'))[1];
    const output = `${fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bounds-'))}/output`;
    for (const kind of kinds) {
      const settings = { ...inputs, kind };
      for (const name of ['review-gate', 'review', 'profile', 'run']) {
        const condition = /if: \$\{\{ (.*?) \}\}/.exec(job(name))[1];
        assert.equal(evaluate(condition, settings), (name === 'review' || name === 'review-gate') === (kind === 'review'));
      }
      if (kind !== 'review') {
        assert.equal(title(settings), `${kind} cgwalters-forge/tracker#42 (openai)`);
        assert.equal(title({ ...settings, pool: '', config: 'acp-experiment' }), `${kind} cgwalters-forge/tracker#42 [acp-experiment]`);
        assert.ok(fs.statSync(`.github/agentic-job/profiles/${kind}.md`).size > 0, `${kind} has a profile`);
        fs.rmSync(output, { force: true });
        execFileSync('bash', ['-euo', 'pipefail', '-c', boundsScript],
          { env: { PATH: process.env.PATH, KIND: kind, REPO: 'cgwalters-forge/agent-board', GITHUB_OUTPUT: output } });
        const bounds = { triage: 'comment', research: 'comment', session: 'session' }[kind] ?? 'dispatch';
        assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`^allow=\\.github/agentic-job/${bounds}\\.toml$`, 'm'), kind);
        assert.equal(evaluate(poolSource, settings), 'openai', `${kind} keeps a given pool`);
        assert.equal(evaluate(poolSource, { ...settings, pool: '' }), kind === 'session' ? 'claude' : '', `${kind} without a pool`);
      }
    }
    // agent-board#680's draft buckets: the only shape the coordinated change
    // may take (README, "Draft-review buckets"), and off until it lands.
    // Rollback is removing the draft opt-in, which must read as off.
    const DRAFT_REVIEW = ['cgwalters-forge/bootc', 'cgwalters-forge/composefs-rs',
      'cgwalters-forge/bcvk', 'cgwalters-forge/rpm-ostree'];
    const draftReviews = config => {
      const pr = config.pr;
      if (!(pr.draftReviewRepositories ?? []).length) return false;
      assert.deepEqual(pr.draftReviewRepositories, DRAFT_REVIEW, 'exactly the four midstream callers');
      for (const [key, list] of [['follow', config.follow], ['pr.noMerge', pr.noMerge],
        ['pr.reviewDispatchRepositories', pr.reviewDispatchRepositories ?? []]]) {
        for (const repo of DRAFT_REVIEW) assert.ok(list.includes(repo), `${repo} must be in ${key}`);
      }
      assert.deepEqual(pr.reviewPools, ['openai', 'claude'], 'draft reviews need pr.reviewPools');
      assert.equal(pr.reviewWorkflow, 'review.yml');
      return true;
    };
    assert.equal(draftReviews(pass), false,
      'draft reviews wait for the callers\' result writer, a draft-accepting wrapper and the review app');
    for (const repo of DRAFT_REVIEW) {
      assert.ok(!(pass.pr.reviewDispatchRepositories ?? []).includes(repo), `${repo}: dispatch it only with the draft opt-in`);
    }
    const enabled = structuredClone(pass);
    Object.assign(enabled.pr, { draftReviewRepositories: [...DRAFT_REVIEW],
      reviewDispatchRepositories: [...DRAFT_REVIEW], reviewPools: ['openai', 'claude'] });
    assert.equal(draftReviews(enabled), true);
    for (const [what, edit] of [
      ['one repository short', pr => pr.draftReviewRepositories.pop()],
      ['an extra repository', pr => pr.draftReviewRepositories.push('cgwalters-forge/tracker')],
      ['merging allowed', pr => pr.noMerge.splice(pr.noMerge.indexOf('cgwalters-forge/bcvk'), 1)],
      ['no ordinary dispatch', pr => delete pr.reviewDispatchRepositories],
      ['no pools', pr => delete pr.reviewPools],
    ]) {
      const broken = structuredClone(enabled);
      edit(broken.pr);
      assert.throws(() => draftReviews(broken), undefined, what);
    }
    const rolledBack = structuredClone(enabled);
    delete rolledBack.pr.draftReviewRepositories;
    assert.equal(draftReviews(rolledBack), false, 'rollback removes the draft opt-in');
    assert.doesNotMatch(workflow, /^  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /\$\{\{[^\n]*(?:inputs\.|vars\.REVIEW_(?:RECORD_ONLY|POOLS))/);
    assert.doesNotMatch(workflow, /^    with:/m, 'do not guess inputs for the old wrapper');
    const gate = /^    if: >-\n((?: {6}.*\n)+)/m.exec(workflow)?.[1].trim();
    assert.ok(gate);
    for (const [event_name, pull, body, want] of [
      ['pull_request_target', false, '', true],
      ['issue_comment', true, '/review', true],
      ['issue_comment', true, '/review again', true],
      ['issue_comment', true, 'not /review', false],
      ['issue_comment', false, '/review', false],
      ['workflow_dispatch', false, '', false],
    ]) for (const vars of [{}, { REVIEW_DISPATCH: 'true' }, { REVIEW_DISPATCH: 'Enabled' }, { REVIEW_DISPATCH: 'enabled' }]) {
      const github = { event_name, event: { issue: { pull_request: pull }, comment: { body } } };
      assert.equal(runInNewContext(gate, { github, vars, startsWith: (s, prefix) => s.startsWith(prefix) }),
        want, `${event_name}: ${body}: REVIEW_DISPATCH=${vars.REVIEW_DISPATCH}`);
    }
    assert.match(workflow, /^    types: \[opened, synchronize, reopened, ready_for_review\]$/m);
    assert.match(workflow, /^    types: \[created\]$/m);
    // Parse the actual trigger tables: commented-out or misplaced fields
    // must not stand in for command authorization or fork admission.
    const files = ['workflow/review.toml', 'workflow/review-command.toml'];
    const bounds = JSON.parse(execFileSync('python3', ['-c',
      'import json, sys, tomllib; print(json.dumps([tomllib.load(open(p, "rb")) for p in sys.argv[1:]]))', ...files], { encoding: 'utf8' }));
    const triggers = [
      { events: ['pull_request_target', 'pull_request'], roles: ['all'], bots: ['dependabot[bot]'], forks: true },
      { events: ['issue_comment'], roles: ['admin', 'maintain', 'write'], bots: [], forks: true, commands: ['/review'] },
    ];
    for (const [i, bound] of bounds.entries()) {
      assert.deepEqual(bound.github?.trigger, triggers[i], files[i]);
      assert.deepEqual(bound.hosts, ['github.com'], files[i]);
      assert.deepEqual(bound.repos, ['cgwalters-forge/tracker'], files[i]);
      assert.deepEqual(bound.bases, ['main'], files[i]);
    }
    console.log('ok dormant ordinary review gate, exclusive routes, expected-head forwarding, exact identity and unchanged legacy admission');

# Manual offline owning-layer tests from a read-only checkout of the review pin.
test-review-wrapper actions:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const cwd = require('node:path').resolve(process.argv[2]);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), 'ba6c56925e63551fd4373fbeb23456a2f4a316da');
    execFileSync('node', ['--test', '.github/workflows/cgwalters-agentic-job.test.mjs'], { cwd, stdio: 'inherit' });

# poll must pass both of the fix bounds files dispatch selects per target.
test-poll-bounds:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const poll = require('node:fs').readFileSync('.github/workflows/poll.yml', 'utf8');
    const command = /"\$AGENT_BOARD" pass .*\\\n(?: {12}.*\\\n)* {12}.*\n/.exec(poll)?.[0];
    assert.ok(command, 'the agent-board pass command');
    assert.deepEqual([...command.matchAll(/--fix-bounds (\S+)/g)].map(m => m[1]),
      ['.github/agentic-job/fix.toml', '.github/agentic-job/midstream-fix.toml']);
    console.log('ok poll passes both fix bounds files to agent-board pass');

# poll's `next` step script, run with a stub agent-board that prints its
# arguments: the supervisor and release-train wakes are added only under
# their variables' gates. Every flag it passes is checked against the
# pinned CLI's help (AGENT_BOARD), which reads no token. Best-effort recovery
# uses runner tools and makes just one dispatch attempt. Fixtures are not
# live proof of GitHub's missing-job behavior or schedule delivery.
test-poll-next:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const poll = fs.readFileSync('.github/workflows/poll.yml', 'utf8');
    const step = /^ {6}- name: Start the next pass .*\n((?: {8}.*\n)+)/m.exec(poll)?.[1];
    assert.ok(step, 'the next pass step');
    assert.match(step, /^ {10}RELEASE_TRAIN: \$\{\{ vars\.RELEASE_TRAIN \}\}$/m);
    const script = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(step)[1].replace(/^ {10}/gm, '');
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll-next-'));
    const stub = path.join(temp, 'agent-board/bin/agent-board');
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const run = (env) => execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: temp, DEFAULT_BRANCH: 'main', GITHUB_RUN_ID: '42', SUPERVISOR: '', RELEASE_TRAIN: '', ...env },
    }).toString().trimEnd().split('\n');
    const base = ['pass', 'next', '--workflow', 'poll.yml', '--branch', 'main', '--input', 'apply=true',
      '--input', 'previous_run_id=42', '--apply-title', 'pass (apply)', '--wait-minutes', '10'];
    const supervisor = ['--supervisor-workflow', 'supervisor.yml', '--supervisor-stale-minutes', '30',
      '--supervisor-input', 'prompt=', '--supervisor-input', 'session=false'];
    const train = ['--train-workflow', 'release-train.yml', '--train-stale-minutes', '60'];
    for (const value of ['', 'enabled', 'Apply', ' apply', 'dry-run ', 'preview']) {
      assert.deepEqual(run({ RELEASE_TRAIN: value }), base, `RELEASE_TRAIN=${JSON.stringify(value)}`);
    }
    for (const value of ['dry-run', 'apply']) {
      assert.deepEqual(run({ RELEASE_TRAIN: value }), [...base, ...train], `RELEASE_TRAIN=${value}`);
    }
    for (const [value, enabled] of [['off', false], ['preview', true], ['apply', true]]) {
      assert.deepEqual(run({ SUPERVISOR: value }), enabled ? [...base, ...supervisor] : base, `SUPERVISOR=${value}`);
    }
    const all = run({ SUPERVISOR: 'preview', RELEASE_TRAIN: 'apply' });
    assert.deepEqual(all, [...base, ...supervisor, ...train]);
    fs.rmSync(temp, { recursive: true });
    console.log('ok poll next wakes the supervisor and release train only under their gates');
    if (process.env.AGENT_BOARD) {
      const help = execFileSync(process.env.AGENT_BOARD, ['pass', 'next', '--help']).toString();
      for (const flag of new Set(all.filter(arg => arg.startsWith('--')))) {
        assert.match(help, new RegExp(`${flag}(?![\\w-])`), `${flag} in agent-board pass next --help`);
      }
      console.log('ok the pinned agent-board pass next takes every flag poll next passes');
    } else {
      console.log('skipped: set AGENT_BOARD to check the flags against the pinned CLI');
    }
    const fallback = /^ {2}next-fallback:\n([\s\S]+)$/m.exec(poll)?.[1];
    assert.ok(fallback, 'the final fallback job');
    assert.match(fallback, /^ {4}needs: \[pass, next\]$/m);
    const gate = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(fallback)[1].trim().replace(/^\$\{\{ | \}\}$/g, '');
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const pass of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const cancelled of [false, true]) {
        for (const apply of ['', 'enabled', 'disabled']) {
          for (const event of ['schedule', 'workflow_dispatch', 'push']) {
          for (const applying of [false, true]) {
          for (const ref of ['refs/heads/main', 'refs/heads/other', 'refs/tags/main']) {
          const got = require('node:vm').runInNewContext(gate, {
            cancelled: () => cancelled, needs: { pass: { result: pass }, next: { result } }, vars: { PASS_APPLY: apply },
            github: { ref, event_name: event, event: { repository: { default_branch: 'main' } } },
            inputs: { apply: applying }, format: (template, branch) => template.replace('{0}', branch),
          });
          assert.equal(got, ['failure', 'skipped', ''].includes(result) && pass !== 'cancelled' && !cancelled &&
            apply === 'enabled' && ref === 'refs/heads/main' && (event === 'schedule' || (event === 'workflow_dispatch' && applying)));
          }
          }
          }
        }
      }
      }
    }
    assert.match(fallback, /^ {4}timeout-minutes: 12$/m);
    assert.match(fallback, /^ {4}permissions:\n {6}actions: write\n {4}steps:/m);
    assert.doesNotMatch(fallback, /uses:|continue-on-error:|^ {2}\S/m);
    assert.equal((fallback.match(/^ {6}- /gm) ?? []).length, 1, 'one step without setup');
    assert.match(fallback, /^ {10}GH_TOKEN: \$\{\{ github.token \}\}$/m);
    assert.match(fallback, /^ {10}DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}$/m);
    for (const job of ['PASS', 'NEXT']) assert.ok(fallback.includes(`${job}_RESULT: \u0024{` + `{ needs.${job.toLowerCase()}.result }}`));
    const recovery = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(fallback)[1].replace(/^ {10}/gm, '');
    const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll-fallback-'));
    try {
      fs.writeFileSync(path.join(sandbox, 'gh'), `#!${process.execPath}
    const args = process.argv.slice(2);
    require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
    if (args[0] === 'api') {
      const listing = args.includes('--method');
      if (process.env.API_FAIL === (listing ? 'list' : 'start')) { console.error('fixture API failure'); process.exit(1); }
      process.stdout.write(listing ? (process.env[args.includes('page=2') ? 'PAGE2' : 'RUNS']) : (process.env.START || '2026-11-02T17:51:00Z'));
    } else { console.log(args.join(' ')); process.exit(Number(process.env.DISPATCH_EXIT || 0)); }
    `, { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'date'), '#!/bin/bash\nif [[ $1 == -d ]]; then printf "1000\\n"; else printf "%s\\n" "$NOW"; fi\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'sleep'), '#!/bin/bash\nprintf "sleep %s\\n" "$*"\n', { mode: 0o755 });
      const dispatch = 'workflow run poll.yml --repo owner/repo --ref main -f apply=true -f previous_run_id=42';
      const me = { id: 42, created_at: '2026-11-02T17:51:00Z', head_branch: 'main', event: 'workflow_dispatch', display_title: 'pass (apply)', status: 'in_progress' };
      const rows = runs => JSON.stringify({ workflow_runs: runs });
      const log = 'Recovery dependencies: pass=<> next=<skipped>';
      const callsPath = path.join(sandbox, 'calls');
      const recover = (env = {}) => {
        fs.writeFileSync(callsPath, '');
        return require('node:child_process').spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', recovery], {
          env: { PATH: `${sandbox}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', DEFAULT_BRANCH: 'main',
            PASS_RESULT: '', NEXT_RESULT: 'skipped', CALLS: callsPath, NOW: '1900', RUNS: rows([me]), ...env }, encoding: 'utf8',
        });
      };
      const calls = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(JSON.parse);
      for (const [now, delay] of [['1120', '480'], ['1600', null], ['1900', null], ['900', '600']]) {
        const got = recover({ NOW: now });
        assert.equal(got.status, 0, got.stderr);
        assert.deepEqual(got.stdout.trimEnd().split('\n'), [log, ...(delay ? [`sleep ${delay}`] : []), dispatch]);
        assert.deepEqual(calls().at(-1), dispatch.split(' '));
        assert.equal(calls().length, 3);
      }
      const failed = recover({ NOW: '1900', DISPATCH_EXIT: '1' });
      assert.equal(failed.status, 1, 'dispatch failure stays visible');
      assert.deepEqual(failed.stdout.trimEnd().split('\n'), [log, dispatch], 'no retry on failure');
      assert.equal(calls().filter(args => args[0] === 'workflow').length, 1);
      for (const env of [{ API_FAIL: 'start' }, { API_FAIL: 'list' }, { START: 'null' }, { RUNS: '{}' }, { RUNS: '{' },
        { RUNS: rows([]) }, { RUNS: rows([{ ...me, status: null }]) }, { RUNS: rows([{ ...me, created_at: 'invalid' }]) }]) {
        const unreadable = recover(env);
        assert.notEqual(unreadable.status, 0, JSON.stringify(env));
        assert.ok(unreadable.stderr, 'failure stays visible');
        assert.equal(unreadable.stdout.trimEnd(), log, 'API failure stops recovery');
        assert.ok(calls().every(args => args[0] === 'api'));
      }
      const newer = { ...me, id: 43 };
      for (const status of ['queued', 'waiting', 'pending', 'requested', 'in_progress']) {
        for (const event of ['schedule', 'workflow_dispatch']) {
          const got = recover({ RUNS: rows([{ ...newer, status, event }, me]) });
          assert.equal(got.status, 0, got.stderr);
          assert.match(got.stdout, /run 43 continues the chain/);
          assert.equal(calls().length, 2, 'no dispatch for newer active applying run');
        }
      }
      for (const other of [{ ...newer, status: 'completed' }, { ...newer, head_branch: 'other' },
        { ...newer, display_title: 'pass' }, { ...newer, event: 'push' }, { ...me, id: 41 },
        { ...newer, created_at: '2026-11-02T17:50:59Z' }]) {
        const got = recover({ RUNS: rows([other, me]) });
        assert.equal(got.status, 0, got.stderr);
        assert.match(got.stdout, /workflow run poll.yml/);
      }
      const full = Array.from({ length: 100 }, (_, i) => ({ ...newer, id: 100 + i, status: 'completed' }));
      assert.equal(recover({ RUNS: rows(full), PAGE2: rows([me]) }).status, 0);
      assert.equal(calls().length, 4, 'second page reaches current run before dispatch');
      assert.notEqual(recover({ RUNS: rows(full), PAGE2: rows(full) }).status, 0);
      assert.equal(calls().length, 3, 'bounded at two pages; no blind dispatch');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    console.log('ok offline fallback guards, dependency fixtures, bounded wait/listing, newer-run ownership and visible API failures; not live GitHub proof');

# Offline state provenance, public-only export and workflow plumbing.
test-pass-state:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const source = /^pass-state mode:\n((?:    .*\n|\n)+)/m.exec(fs.readFileSync('Justfile', 'utf8'))[1].replace(/^    /gm, '');
    const functions = {};
    new Function('require', 'process', 'exports', source.replace(/^#!.*\n/, ''))(require, { argv: ['node', 'recipe', 'test'] }, functions);
    const { validate, publicState } = functions;
    const env = { PREVIOUS_RUN_ID: '41', GITHUB_RUN_ID: '42', GITHUB_REPOSITORY: 'owner/tracker', DEFAULT_BRANCH: 'main' };
    const run = { id: 41, workflow_id: 123, path: '.github/workflows/poll.yml',
      repository: { full_name: env.GITHUB_REPOSITORY }, head_repository: { full_name: env.GITHUB_REPOSITORY },
      head_branch: 'main', event: 'workflow_dispatch', display_title: 'pass (apply)' };
    const jobs = { total_count: 2, jobs: [{ name: 'pass', status: 'completed', conclusion: 'success' },
      { name: 'next', status: 'in_progress' }] };
    function predecessor(change = {}, jobChange = {}, extra = {}) {
      const calls = [];
      const id = validate({ ...env, ...extra }, endpoint => {
        calls.push(endpoint);
        assert.ok(calls.length <= 3);
        if (endpoint.endsWith('/workflows/poll.yml')) return { id: 123 };
        if (endpoint.endsWith('/jobs?filter=latest&per_page=100')) return { ...jobs, ...jobChange };
        assert.equal(endpoint, 'repos/owner/tracker/actions/runs/41');
        return { ...run, ...change };
      });
      return { id, calls };
    }
    assert.equal(predecessor().id, '41');
    assert.equal(predecessor({ event: 'schedule', display_title: 'pass' }).id, '41');
    assert.equal(predecessor({}, { jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }], total_count: 1 }).id, '41');
    for (const change of [{ workflow_id: 124 }, { id: 40 }, { path: '.github/workflows/other.yml' },
      { repository: { full_name: 'other/tracker' } }, { head_repository: { full_name: 'fork/tracker' } },
      { head_branch: 'feature' }, { event: 'pull_request' }, { event: 'push' }, { display_title: 'pass' }]) {
      assert.equal(predecessor(change).id, '', JSON.stringify(change));
    }
    for (const change of [{ total_count: 101 }, { jobs: [] }, { jobs: null },
      { jobs: [jobs.jobs[0], jobs.jobs[0]] },
      ...['in_progress', 'queued'].map(status => ({ total_count: 1, jobs: [{ ...jobs.jobs[0], status }] })),
      ...['cancelled', 'skipped', null].map(conclusion => ({ total_count: 1, jobs: [{ ...jobs.jobs[0], conclusion }] }))]) {
      assert.equal(predecessor({}, change).id, '', JSON.stringify(change));
    }
    for (const id of ['', undefined, '42', '0', '-1', '../41', '41;exit', '1'.repeat(21)]) {
      assert.deepEqual(predecessor({}, {}, { PREVIOUS_RUN_ID: id }), { id: '', calls: [] });
    }
    const url = path => `https://api.github.com/${path}`;
    const publicUrl = url('repos/owner/public/issues/1/comments');
    const allowed = ['issues', 'issues?state=all&per_page=100&page=2', 'issues/1',
      'pulls', 'pulls?state=open&per_page=100', 'pulls/1', 'issues/1/comments?per_page=100&page=2',
      'issues/comments/2', 'labels', 'issues/1/labels']
      .map(path => url(`repos/owner/public/${path}`));
    const pendingUrl = url('repos/owner/public/pulls/1/reviews?per_page=100');
    const unsafe = ['pulls/1/reviews/2', 'pulls/1/comments', 'pulls/comments/2', 'actions/runs',
      'events', 'contents/file', 'issues/1/parent', 'issues/1/sub_issues', 'issues/1/reactions',
      'issues/1/comments/2', 'issues/1/timeline/extra', 'issues/1/../reviews', 'issues%2f1',
      'issues/1#fragment', 'issues/1/']
      .map(path => url(`repos/owner/public/${path}`));
    const entries = Object.fromEntries([publicUrl, url('repos/owner/private/issues/1/comments'),
      url('repos/owner/unknown/issues'), url('repos/owner/mismatch/issues'), url('repos/owner/hidden/issues'),
      ...allowed, ...unsafe, url('user/notifications'), 'https://other.example/repos/owner/public/issues']
      .map(key => [key, { etag: 'fixture-validator', body: 'fixture response' }]));
    entries[pendingUrl] = { etag: 'pending-validator', body: [{ state: 'PENDING', body: 'unpublished review', submitted_at: null }] };
    const timelineUrl = url('repos/owner/public/issues/1/timeline?per_page=100');
    entries[timelineUrl] = { etag: 'private-cross-reference', body: [{ event: 'cross-referenced',
      source: { issue: { repository: { private: true }, body: 'private source issue' } } }] };
    const calls = [];
    const result = publicState({ schema: 'agent-board/poll-state/v1', interval_seconds: 300,
      share_cursor: 'owner/private#1', authored_cursor: 'owner/private',
      intake_waiting: { 'owner/private#2': '2026-11-11T00:00:00Z' },
      intake_refused: ['owner/private#3/4'], lock_refused: { 'owner/private#5': '2026-11-11T00:00:00Z' },
      maintain: { fixture: 'private metadata' }, future_field: 'private metadata',
      responses: structuredClone(entries), pass_responses: structuredClone(entries) }, endpoint => {
      calls.push(endpoint);
      if (endpoint === 'repos/owner/unknown') throw new Error('unreadable');
      return { full_name: endpoint === 'repos/owner/mismatch' ? 'other/repo' : endpoint.slice(6),
        private: endpoint === 'repos/owner/private', visibility: endpoint === 'repos/owner/hidden' ? 'private' : 'public' };
    });
    assert.deepEqual(result.responses, Object.fromEntries([publicUrl, ...allowed].map(key => [key, entries[key]])));
    assert.deepEqual(result.pass_responses, result.responses);
    assert.ok(!Object.hasOwn(result.responses, pendingUrl), 'discard the whole pending review entry, including its validator');
    assert.doesNotMatch(JSON.stringify(result), /unpublished review|pending-validator|private source issue|private-cross-reference|owner\/private|private metadata/);
    assert.deepEqual(Object.keys(result).sort(), ['interval_seconds', 'pass_responses', 'responses', 'schema']);
    assert.equal(result.interval_seconds, 300);
    assert.equal(calls.length, 5, 'each repository checked once across both caches');
    assert.throws(() => publicState({ responses: Object.fromEntries(Array.from({ length: 101 }, (_, n) =>
      [url(`repos/owner/repo${n}/issues`), {}])) }, () => assert.fail('must check bound before requests')));
    const poll = fs.readFileSync('.github/workflows/poll.yml', 'utf8');
    const config = JSON.parse(fs.readFileSync('.github/pass.json', 'utf8'));
    assert.equal(config.topDown, true);
    assert.equal(config.state, '.state/pass.json');
    assert.match(poll, /previous_run_id:\n[^]*?type: string\n        required: false\n        default: ''/);
    const restore = poll.split('      - name: Restore pass state\n')[1].split('      - name: One pass\n')[0];
    assert.match(restore, /if: steps.predecessor.outputs.run-id != ''/);
    assert.match(restore, /run-id: \$\{\{ steps.predecessor.outputs.run-id \}\}/);
    assert.match(restore, /name: pass-state\n          path: .state/);
    assert.match(restore, /continue-on-error: true/);
    assert.match(restore, /if: steps.restore.outcome == 'failure'\n        run: rm -rf .state/);
    const mkdir = /      - name: Prepare state directory\n        run: (.*)\n/.exec(restore)[1];
    const { execFileSync } = require('node:child_process');
    const temp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pass-state-'));
    try {
      for (const brokenRestore of [false, true]) {
        fs.rmSync(`${temp}/.state`, { recursive: true, force: true });
        if (brokenRestore) {
          fs.mkdirSync(`${temp}/.state`);
          fs.writeFileSync(`${temp}/.state/partial`, 'unreadable artifact');
          execFileSync('bash', ['-ec', 'rm -rf .state'], { cwd: temp });
        }
        execFileSync('bash', ['-ec', mkdir], { cwd: temp });
        // The pinned CLI uses fs::write: it does not create parent directories.
        const state = { schema: 'agent-board/poll-state/v1', interval_seconds: 300, responses: {}, pass_responses: {} };
        fs.writeFileSync(`${temp}/.state/pass.json`, JSON.stringify(state));
        const output = execFileSync(process.execPath, ['-e', source.replace(/^#!.*\n/, ''), 'recipe', 'export'],
          { cwd: temp, encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(output.trim(), 'Prepared public response cache for the next pass');
        assert.deepEqual(JSON.parse(fs.readFileSync(`${temp}/.state/pass.json`, 'utf8')), state);
        assert.equal(fs.existsSync(`${temp}/.state/partial`), false);
        // Malformed state must not be published, and no body reaches stdout.
        fs.writeFileSync(`${temp}/.state/pass.json`, '{private fixture');
        const cold = execFileSync(process.execPath, ['-e', source.replace(/^#!.*\n/, ''), 'recipe', 'export'],
          { cwd: temp, encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(fs.existsSync(`${temp}/.state/pass.json`), false);
        assert.doesNotMatch(cold, /private fixture/);
      }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    const publish = poll.split('      - name: Prepare public pass state\n')[1].split('      # GitHub drops')[0];
    assert.match(publish, /github.event_name == 'schedule' && vars.PASS_APPLY == 'enabled'/);
    assert.match(publish, /github.event_name == 'workflow_dispatch' && inputs.apply/);
    assert.match(publish, /run: just pass-state export/);
    assert.match(publish, /steps.state.outcome == 'success'/);
    assert.match(publish, /name: pass-state\n          path: .state\/pass.json\n          include-hidden-files: true\n          retention-days: 1\n          if-no-files-found: ignore/);
    assert.doesNotMatch(poll, /actions\/cache@/);
    for (const action of ['download', 'upload']) assert.match(poll, new RegExp(`uses: actions/${action}-artifact@[0-9a-f]{40} # v`));
    console.log('ok exact predecessor provenance, public-only response export and applying workflow handoff');

# Disposable poll cache handoff. Never print response bodies or API diagnostics.
pass-state mode:
    #!/usr/bin/env node
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const STATE = '.state/pass.json';
    const MAX_BYTES = 32 * 1024 * 1024; // The pinned pass's state-file limit.
    const MAX_REPOSITORIES = 100;
    function api(endpoint, timeout = 20000) {
      return JSON.parse(execFileSync('gh', ['api', endpoint], {
        timeout, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    }
    function validate(env = process.env, get = api) {
      const id = env.PREVIOUS_RUN_ID;
      if (!id) return '';
      // Input is data, never a URL/path or shell fragment. No latest-run search.
      if (!/^[1-9][0-9]{0,19}$/.test(id) || id === env.GITHUB_RUN_ID) return '';
      const root = `repos/${env.GITHUB_REPOSITORY}/actions`;
      const run = get(`${root}/runs/${id}`);
      const workflow = get(`${root}/workflows/poll.yml`);
      if (String(run.id) !== id || run.workflow_id !== workflow.id ||
          run.path !== '.github/workflows/poll.yml' ||
          run.repository?.full_name !== env.GITHUB_REPOSITORY ||
          run.head_repository?.full_name !== env.GITHUB_REPOSITORY ||
          run.head_branch !== env.DEFAULT_BRANCH ||
          !(run.event === 'schedule' ||
            (run.event === 'workflow_dispatch' && run.display_title === 'pass (apply)'))) return '';
      // The next job may still be running. Require the state-writing job, not
      // the whole workflow, to have finished. Refuse truncated job listings.
      const jobs = get(`${root}/runs/${id}/jobs?filter=latest&per_page=100`);
      if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length ||
          jobs.jobs.length > 100) return '';
      const passes = jobs.jobs.filter(job => job.name === 'pass');
      return passes.length === 1 && passes[0].status === 'completed' &&
        ['success', 'failure'].includes(passes[0].conclusion) ? id : '';
    }
    function publicState(state, get = api) {
      // Both caches contain PAT-authenticated bodies. A public repository alone
      // is not enough: reviews can include the viewer's unpublished PENDING body.
      // Allow only public issue/PR lists/details, issue comments and label lists.
      // Timelines can embed private cross-references. Every other endpoint stays
      // cold. Match the entire raw
      // path, without URL normalization accepting extra/dot/encoded segments.
      const repository = url => /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues(?:\/[1-9][0-9]*(?:\/(?:comments|labels))?|\/comments\/[1-9][0-9]*)?|pulls(?:\/[1-9][0-9]*)?|labels)(?:\?[^#\s]*)?$(?![\s\S])/
        .exec(url)?.[1].toLowerCase();
      const caches = ['responses', 'pass_responses'];
      const repositories = new Set(caches.flatMap(key => Object.keys(state[key] || {}).map(repository).filter(Boolean)));
      if (repositories.size > MAX_REPOSITORIES) throw new Error('too many repositories');
      const publicRepos = new Set();
      const deadline = Date.now() + 90000;
      for (const repo of repositories) {
        if (Date.now() >= deadline) break;
        try {
          const metadata = get(`repos/${repo}`, Math.min(10000, deadline - Date.now()));
          if (metadata.full_name?.toLowerCase() === repo && metadata.private === false && metadata.visibility === 'public') {
            publicRepos.add(repo);
          }
        } catch { /* Unreadable is not public. */ }
      }
      // Cursors/intake/maintenance metadata can also name private repositories.
      // Publish only the response-cache envelope, not arbitrary state fields.
      const exported = { schema: 'agent-board/poll-state/v1',
        interval_seconds: Number.isSafeInteger(state.interval_seconds) ? state.interval_seconds : 300 };
      for (const key of caches) {
        // Drop entries whole: changing a body would invalidate its cached ETag.
        exported[key] = Object.fromEntries(Object.entries(state[key] || {}).filter(([url]) => publicRepos.has(repository(url))));
      }
      return exported;
    }
    if (process.argv[2] === 'validate') {
      let id = '';
      try { id = validate(); } catch { /* Missing provenance starts cold. */ }
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${id}\n`);
      console.log(id ? `Validated predecessor ${id}` : 'No trusted predecessor; starting cold');
    } else if (process.argv[2] === 'export') {
      if (fs.existsSync(STATE)) {
        try {
          if (fs.statSync(STATE).size > MAX_BYTES) throw new Error('oversized state');
          const state = publicState(JSON.parse(fs.readFileSync(STATE, 'utf8')));
          fs.writeFileSync(STATE, JSON.stringify(state) + '\n');
          console.log('Prepared public response cache for the next pass');
        } catch {
          fs.rmSync(STATE, { force: true });
          console.log('Could not prepare public state; next pass starts cold');
        }
      }
    } else if (process.argv[2] === 'test') {
      Object.assign(exports, { validate, publicState });
    } else {
      throw new Error('expected validate or export');
    }

# supervisor.yml's folded concurrency group and health `if`, evaluated as
# JavaScript on events: a run the gate skips gets a group of its own
# (#803), and a session dispatch, prompt or not, is an agent run.
test-supervisor-workflow:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const workflow = fs.readFileSync('.github/workflows/supervisor.yml', 'utf8');
    const folded = (key, indent) => new RegExp(`^${' '.repeat(indent)}${key}: >-\\n((?:${' '.repeat(indent + 2)}.*\\n)+)`, 'm')
      .exec(workflow)[1].split('\n').map(line => line.trim()).filter(Boolean).join(' ');
    const group = /^\$\{\{ (.*) \}\}$/.exec(folded('group', 2))[1];
    const gate = folded('if', 4);
    assert.ok(group.startsWith(`(!(${gate}) && format('supervisor-ignored-{0}', github.run_id))`));
    const { operator } = JSON.parse(fs.readFileSync('.github/poll/agent-board.json', 'utf8'));
    const { issue } = JSON.parse(fs.readFileSync('.github/supervisor/config.json', 'utf8')).agent.requests;
    const comment = { user: { login: operator } };
    const requests = { number: issue, locked: true };
    const dispatch = (inputs, ref) => ({ event_name: 'workflow_dispatch', inputs: { prompt: '', session: false, ...inputs }, ref });
    for (const [event, expected] of [
      [{ event_name: 'issue_comment', event: { comment, issue: requests } }, 'supervisor-agent'],
      [{ event_name: 'issue_comment', event: { comment, issue: { ...requests, locked: false } } }, 'supervisor-ignored-42'],
      [{ event_name: 'issue_comment', event: { comment, issue: { ...requests, pull_request: { url: 'x' } } } }, 'supervisor-ignored-42'],
      [{ event_name: 'issue_comment', event: { comment: { user: { login: 'outsider' } }, issue: requests } }, 'supervisor-ignored-42'],
      [dispatch({ prompt: 'do it' }), 'supervisor-agent'],
      [dispatch({ prompt: 'do it' }, 'refs/heads/other'), 'supervisor-ignored-42'],
      [dispatch({}), 'supervisor-health'],
      [dispatch({}, 'refs/heads/other'), 'supervisor-ignored-42'],
      [dispatch({ session: true }), 'supervisor-agent'],
      [dispatch({ session: true, prompt: 'look at #1' }), 'supervisor-agent'],
      [dispatch({ session: true }, 'refs/heads/other'), 'supervisor-ignored-42'],
      [{ event_name: 'schedule', event: { schedule: '*/15 * * * *' } }, 'supervisor-health'],
      [{ event_name: 'schedule', event: { schedule: '7 */2 * * *' } }, 'supervisor-agent'],
    ]) {
      const context = {
        format: (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[i]),
        fromJSON: JSON.parse,
        vars: {},
        inputs: event.inputs ?? {},
        github: {
          event_name: event.event_name, run_id: 42, ref: event.ref ?? 'refs/heads/main',
          event: { repository: { default_branch: 'main' }, ...event.event },
        },
      };
      const got = vm.runInNewContext(group, context);
      assert.equal(got, expected, JSON.stringify(event));
      assert.equal(vm.runInNewContext(gate, context), !got.startsWith('supervisor-ignored-'), JSON.stringify(event));
    }
    // A session is an explicit request to `due`, and reaches the wrapper
    // with session.json's idle timeout.
    assert.match(workflow, /^ {10}PROMPT: \$\{\{ inputs\.prompt \|\| \(inputs\.session && 'session' \|\| ''\) \}\}$/m);
    assert.match(workflow, /^ {6}session: \$\{\{ needs\.health\.outputs\.session == 'true' \}\}\n {6}idle-minutes: \$\{\{ needs\.health\.outputs\.idle \}\}$/m);
    assert.match(workflow, /"idle=\\\(\.idleMinutes\)"' \.github\/agentic-job\/session\.json/);
    console.log('ok supervisor concurrency groups and health gate, sessions included');

# The needs-you publication the pin's approval-preserving fit (agent-board#722)
# serves keeps its settings: the private holds issue with `holds.needsYou`,
# the operator-path rule, and Act now and Today enabled with pass view and
# approval evidence as prerequisites (tracker#1424). Manual, with read-only
# checkouts and no token or forge request: BOARD at the pin,
# whose serialized 174-decision fixture must keep every approval's card at
# its full head with a descriptor offering `review-at-head` there, and REVIEW
# (node >=22.18), whose own parser and inbox cards must read it complete,
# one row a decision, each approval actionable. Review's `parseHolds` would
# refuse the fixture's synthetic holds, which have no `url` as a pass's do.
test-needs-you-fit board="" review="":
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { execFileSync } = require('node:child_process');
    const [board, review] = process.argv.slice(2);
    const pass = JSON.parse(fs.readFileSync('.github/pass.json', 'utf8'));
    assert.deepEqual([pass.holds.repository, pass.holds.needsYou], ['cgwalters-forge/bot-ops', true]);
    assert.deepEqual([pass.holds.actNow, pass.holds.today, pass.holds.passView, pass.holds.approvalEvidence],
      [true, true, true, true], 'Act now and Today stay enabled with their publication prerequisites');
    // Gated by key, less its feature switches (agent-board#746).
    assert.ok(pass.pr.operatorPaths.some(p => p.split('#')[0] === '.github/pass.json'), 'the fixture approval is for an operator path');
    if (!board) {
      assert.ok(!review, 'REVIEW reads BOARD\'s fixture');
      console.log('ok needs-you settings; fixture probes skipped: pass BOARD and REVIEW checkouts');
      process.exit(0);
    }
    async function main() {
      const root = path.resolve(board);
      const pin = execFileSync('{{ just_executable() }}', ['agent-board-pin'], { encoding: 'utf8' }).trim();
      assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pin);
      const raw = JSON.parse(fs.readFileSync(`${root}/fixtures/needs-you-approval-fit-174.json`, 'utf8')).needs_you;
      assert.deepEqual(raw.counts, { decisions: 174, groups: 2, members: 202 });
      assert.equal(raw.count, raw.identities.length, 'an identity a member');
      const detail = i => i.detail_key ?? i.key ?? i.item.toLowerCase();
      assert.equal(new Set(raw.identities.map(detail)).size, raw.counts.decisions, 'a row a decision');
      const cards = new Map(raw.items.map(a => [a.key, a]));
      assert.equal(raw.details_omitted, raw.identities.filter(i => !cards.has(detail(i))).length);
      const approvals = raw.identities.filter(i => i.kind === 'review-approve').map(detail);
      assert.equal(approvals.at(-1), 'o/zeta#174');
      assert.equal(detail(raw.identities.at(-1)), 'o/zeta#174', 'the operator-path approval ranks last');
      for (const key of approvals) {
        const head = cards.get(key)?.head;
        assert.match(head ?? '', /^[0-9a-f]{40}$/, `${key} keeps its card at its full head`);
        assert.ok(raw.requests.some(r => r.key === key && r.target.head === head
          && r.actions.some(a => a.kind === 'review-at-head' && a.supported)), `${key} offers review-at-head at ${head}`);
        assert.ok(raw.request_sources.some(s => s.key === key), `${key} keeps its source record`);
      }
      const cargo = ['--locked', '--manifest-path', `${root}/Cargo.toml`, '-p', 'board-forge'];
      execFileSync('cargo', ['test', ...cargo, 'approvals_'], { stdio: 'inherit' });
      if (!review) return console.log(`ok needs-you settings and the fixture at ${pin}; review's reading skipped`);
      const load = file => import(pathToFileURL(path.resolve(review, file)).href);
      const { parseNeedsYou } = await load('src/github/holds.ts');
      const { inboxCards, refusal } = await load('src/github/inbox.ts');
      const list = parseNeedsYou(raw);
      assert.equal(typeof list, 'object', list);
      assert.deepEqual([list.complete, list.refused, list.counts], [true, 0, raw.counts]);
      const rows = inboxCards({ published: { asks: list.items, list } });
      assert.equal(rows.length, raw.counts.decisions);
      for (const key of approvals) {
        const row = rows.find(c => c.key === key);
        assert.deepEqual([row.kind, row.ask.detailMissing, row.ask.action.head], ['approve', undefined, cards.get(key).head], key);
        assert.equal(refusal(row.ask, 'review-at-head'), undefined, key);
      }
      const revision = execFileSync('git', ['-C', review, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      console.log(`ok needs-you settings, the fixture at ${pin} and review ${revision}'s reading of it`);
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });

# The one agent-board commit every workflow pins as `  AGENT_BOARD_REV:`,
# printed; fails when the workflows pin different revisions, or none, so a
# move by hand cannot miss a workflow.
agent-board-pin:
    #!/usr/bin/env bash
    set -euo pipefail
    pins=$(sed -n 's/^  AGENT_BOARD_REV: //p' .github/workflows/*.yml | sort -u)
    if ! [[ $pins =~ ^[0-9a-f]{40}$ ]]; then
      echo "::error::.github/workflows pin more than one agent-board revision, or none:" >&2
      grep -H '^  AGENT_BOARD_REV:' .github/workflows/*.yml >&2 || true
      exit 1
    fi
    echo "$pins"

# Opens or updates the one pull request, from the bot's fork, that moves
# every AGENT_BOARD_REV to the head of agent-board's configured branch
# (.github/poll/agent-board.json), once all that commit's check runs have
# passed and it is ahead of the pin (agent-board-pin.yml). It commits in this
# checkout, and needs GITHUB_REPOSITORY and GH_TOKEN to push and open the PR.
bump-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    pin=$({{ just_executable() }} agent-board-pin)
    source=$(jq -er .source .github/poll/agent-board.json)
    branch=$(jq -er .branch .github/poll/agent-board.json)
    bot=$(jq -er .bot .github/poll/agent-board.json)
    upstream=${source#https://github.com/}
    head=$(gh api "repos/$upstream/commits/$branch" --jq .sha)
    [[ $head =~ ^[0-9a-f]{40}$ ]]
    if [[ $head == "$pin" ]]; then echo "the pin is $branch's head $head"; exit 0; fi
    runs=$(gh api --paginate "repos/$upstream/commits/$head/check-runs" --jq '.check_runs[] | {name, status, conclusion}' | jq -cs .)
    if ! jq -e 'length > 0 and all(.[]; .status == "completed" and (.conclusion | IN("success", "neutral", "skipped")))' <<< "$runs" > /dev/null; then
      echo "$head: CI is not green yet: $runs"; exit 0
    fi
    # Publication follows CI: green source alone is not an installable pin.
    if ! published=$(gh release view "build-$head" --repo "$upstream" --json isDraft --jq '.isDraft') || [[ $published != false ]]; then
      echo "$head: no published binary release yet"; exit 0
    fi
    (export RUNNER_TEMP=$(mktemp -d); trap 'rm -rf "$RUNNER_TEMP"' EXIT
      GITHUB_OUTPUT=/dev/null {{ just_executable() }} build-agent-board "$head")
    # Never backwards or onto rewritten history; compare lists at most 250 commits.
    compare=$(gh api "repos/$upstream/compare/$pin...$head")
    status=$(jq -r .status <<< "$compare")
    [[ $status == ahead ]] || { echo "::error::$head is $status of the pin $pin, not ahead"; exit 1; }
    title="workflows: Move agent-board to ${head:0:7}"
    pr_branch=agent-board-pin
    open=$(gh pr list --repo "$GITHUB_REPOSITORY" --author "$bot" --head "$pr_branch" --state open --json number,title --jq '.[0] // empty')
    if [[ $(jq -r '.title // ""' <<< "$open") == "$title" ]]; then echo "already proposed: $title"; exit 0; fi
    fork=$(gh api --paginate "repos/$GITHUB_REPOSITORY/forks" --jq ".[] | select(.owner.login == \"$bot\") | .full_name" | head -n1)
    [[ -n $fork ]] || { echo "::error::$bot has no fork of $GITHUB_REPOSITORY"; exit 1; }
    body=$(
      echo "Every \`AGENT_BOARD_REV\` in \`.github/workflows/\` moves from $pin to $head, $branch's head, whose check runs all passed. Review [what changes]($source/compare/$pin...$head) in the program given the bot's token. The agent-board commits in between:"
      echo
      # Subjects in code spans, so their #N and @login do not reference here.
      jq -r --arg s "$source" '.commits[] | "- [\(.sha[0:7])](\($s)/commit/\(.sha)) `\(.commit.message | split("\n")[0] | gsub("`"; "'\''"))`"' <<< "$compare"
      jq -r 'if .total_commits > (.commits | length) then "\n\(.total_commits - (.commits | length)) more commits are not listed." else empty end' <<< "$compare"
    )
    sed -i "s/^  AGENT_BOARD_REV: $pin\$/  AGENT_BOARD_REV: $head/" .github/workflows/*.yml
    [[ $({{ just_executable() }} agent-board-pin) == "$head" ]]
    email=$(gh api "users/$bot" --jq '"\(.id)+\(.login)@users.noreply.github.com"')
    git -c user.name="$bot" -c user.email="$email" commit -q -a -m "$title" -m "$body"
    gh auth setup-git
    git push -q --force "https://github.com/$fork" "HEAD:refs/heads/$pr_branch"
    if [[ -n $open ]]; then
      gh pr edit "$(jq -r .number <<< "$open")" --repo "$GITHUB_REPOSITORY" --title "$title" --body "$body"
    else
      gh pr create --repo "$GITHUB_REPOSITORY" --head "${fork%%/*}:$pr_branch" --base "$(gh repo view "$GITHUB_REPOSITORY" --json defaultBranchRef --jq .defaultBranchRef.name)" --title "$title" --body "$body"
    fi

# Whether the effective rules of a branch, GitHub's
# `repos/OWNER/REPO/rules/branches/BRANCH` response on stdin, hold what the
# `[unprotected_files]` bounds rest on: one pull_request
# rule requiring an approval and dismissing stale approvals on push. Any one
# rule is enough, as rulesets add up (review's own requires none; the org's
# does), but both must be on the same rule. Anything but an array fails.
review-gate:
    @jq -e 'type == "array" and any(.[]; .type == "pull_request" and .parameters.required_approving_review_count >= 1 and .parameters.dismiss_stale_reviews_on_push == true)' > /dev/null

# review-gate on each fixture under .github/ruleset-check, which must
# pass if its name starts with pass- and fail otherwise.
test-review-gate:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in .github/ruleset-check/*.json; do
      want=fail; [[ $(basename "$f") == pass-* ]] && want=pass
      got=fail; {{ just_executable() }} review-gate < "$f" 2>/dev/null && got=pass
      [[ $got == "$want" ]] || { echo "$f: want $want, got $got" >&2; exit 1; }
      echo "ok $f ($want)"
    done

# review-gate on the default branch of every repository in
# unprotected_files.repos (ruleset-check.yml). A repository that fails it,
# or whose rules cannot be read, gets a ::error with the pull_request rules
# found and is listed in the step output `failed`; then the recipe fails.
check-review-gate:
    #!/usr/bin/env bash
    set -euo pipefail
    repos=$({{ just_executable() }} review-gate-repos)
    failed=()
    for repo in $repos; do
      rules=
      if branch=$(gh api "repos/$repo" --jq .default_branch) &&
        rules=$(gh api --paginate "repos/$repo/rules/branches/$branch" | jq -cs add); then
        if {{ just_executable() }} review-gate <<< "$rules"; then echo "ok $repo"; continue; fi
        found=$(jq -c '[.[]? | select(.type == "pull_request") | {ruleset_id, ruleset_source} + (.parameters | {required_approving_review_count, dismiss_stale_reviews_on_push})]' <<< "$rules")
        echo "::error::$repo: no pull_request rule on $branch requires an approval and dismisses stale approvals on push; found $found"
      else
        echo "::error::$repo: could not read the rules of its default branch"
      fi
      failed+=("$repo")
    done
    echo "failed=${failed[*]}" >> "${GITHUB_OUTPUT:-/dev/null}"
    [[ ${#failed[@]} -eq 0 ]]

# Union of ordinary and midstream implement/fix exceptions; never targets
# without an exception. Keep discovery shared by the live and fixture checks.
review-gate-repos:
    @python3 -c 'import sys, tomllib; print(*sorted({r for p in sys.argv[1:] for r in tomllib.load(open(p, "rb")).get("unprotected_files", {}).get("repos", [])}))' .github/agentic-job/dispatch.toml .github/agentic-job/fix.toml .github/agentic-job/midstream.toml .github/agentic-job/midstream-fix.toml

# A repository's drift from the manifest (.github/forge-sync/repos.json,
# #544), one line each, from its fetched files on stdin:
# {"repo": ..., "review": <review.yml or null>, "dependabot": <dependabot.yml
# or null>, "justfile": <bool>, "renovate": <renovate.json or null>}. Fails
# on any drift, a repository the manifest does not list, or an exemption that
# is unknown or gives no reason. The YAML is parsed with yq (its first
# document), so only a job's `uses` counts as a call of the reviewer, and
# every such call must be at the pin. Only a manifest that sets
# renovate_preset requires the Renovate config to list it in `extends`, so
# that no repository's runner label goes stale unnoticed (#1054).
forge-sync-drift manifest:
    #!/usr/bin/env bash
    set -euo pipefail
    input=$(cat)
    yaml() { jq -r --arg k "$1" '.[$k] // empty' <<< "$input" | yq -p=yaml -o=json -I=0 'select(document_index == 0)'; }
    review=$(yaml review)
    dependabot=$(yaml dependabot)
    drift=$(jq -r --slurpfile m "$1" --argjson rv "$review" --argjson dp "$dependabot" '
      $m[0] as $m | .repo as $r | (first($m.repos[] | select(.repo == $r)) // null) as $e
      | if $e == null then "\($r) \($path): expected an entry, found none" else ($e.exempt // {}) as $x
      | ($x | to_entries[] | select((.key | IN("review", "dependabot", "justfile", "renovate") | not) or (.value | type != "string" or length == 0))
        | "\($r) \($path): expected exempt.\(.key) to be review, dependabot, justfile or renovate with a reason, found \(.value | tojson)"),
        ("cgwalters-forge/actions/.github/workflows/cgwalters-review.yml@" as $call | "\($call)\($m.review_pin)" as $want
        | [$rv | objects | .jobs | objects | .[] | objects | .uses | strings] as $uses
        | [$uses[] | select(startswith($call))] as $calls
        | select($x.review == null and ($calls == [] or any($calls[]; . != $want)))
        | "\($r) .github/workflows/review.yml: expected uses \($want), found \(if .review == null then "no file" else if $calls == [] then $uses else $calls end | join(", ") | if . == "" then "no uses" else . end end)"),
        ([$dp | objects | .updates | arrays | .[] | objects | select(."package-ecosystem" == "github-actions")
          | (.schedule | objects | .interval) // "no interval" | tostring] as $i
        | select($x.dependabot == null and ($i == [] or any($i[]; . != "daily")))
        | "\($r) .github/dependabot.yml: expected a github-actions update with interval daily, found \(if .dependabot == null then "no file" elif $i == [] then "no github-actions update" else $i | join(", ") end)"),
        (select($x.justfile == null and .justfile != true) | "\($r) Justfile: expected a root Justfile, found none"),
        ($m.renovate_preset as $p | select($p != null and $x.renovate == null)
        | if $p | type != "string" or length == 0 then "\($r) \($path): expected renovate_preset to be a preset name, found \($p | tojson)"
          else .renovate as $text | (if $text == null then null else try ($text | fromjson) catch null end) as $rc
          | select([$rc | objects | .extends | arrays | .[] | select(. == $p)] == [])
          | "\($r) renovate.json: expected extends to list \($p), found \(if $text == null then "no file" elif $rc | type != "object" then "no JSON object" else $rc.extends // [] | tojson end)" end)
      end' --arg path "$1" <<< "$input")
    [[ -z $drift ]] || { echo "$drift"; exit 1; }

# forge-sync-drift on each fixture under .github/forge-sync/testdata, and
# under its renovate/ whose manifest sets renovate_preset, against the
# manifest.json beside it, passing for pass-* and reporting drift for the
# fixture's repository otherwise; then on this
# repository's own files against the real manifest, so moving the pin in
# review.yml fails here until review_pin moves with it, and dropping
# .github/renovate.json or renovate_preset fails too.
test-forge-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    top=.github/forge-sync/testdata
    for dir in "$top" "$top/renovate"; do
      for f in "$dir"/pass-*.json "$dir"/fail-*.json; do
        want=fail; [[ $(basename "$f") == pass-* ]] && want=pass
        got=pass; out=$({{ just_executable() }} forge-sync-drift "$dir/manifest.json" < "$f" 2> /dev/null) || got=fail
        [[ $got == pass || $out == "$(jq -r .repo "$f") "* ]] || got="an error: $out"
        [[ $got == "$want" ]] || { echo "$f: want $want, got $got" >&2; exit 1; }
        echo "ok $f ($want)"
      done
    done
    bad=$(mktemp)
    # Without renovate_preset no Renovate config is required; with one that
    # is not a preset name every repository drifts.
    {{ just_executable() }} forge-sync-drift "$top/manifest.json" < "$top/renovate/fail-no-renovate.json"
    echo "ok no renovate_preset requires no Renovate config"
    jq '.renovate_preset = 1' "$top/renovate/manifest.json" > "$bad"
    if {{ just_executable() }} forge-sync-drift "$bad" < "$top/renovate/pass-extends-preset.json" > /dev/null 2>&1; then
      echo "forge-sync-drift with renovate_preset 1: want fail, got pass" >&2; exit 1
    fi
    echo "ok forge-sync-drift refuses renovate_preset 1"
    for manifest in '{}' '{"repos": []}' '{"repos": [{}]}' '[' ''; do
      if [[ -n $manifest ]]; then echo "$manifest" > "$bad"; else rm -f "$bad"; fi
      if {{ just_executable() }} forge-sync "$bad" > /dev/null 2>&1; then
        echo "forge-sync with manifest '$manifest': want fail, got pass" >&2; exit 1
      fi
      echo "ok forge-sync refuses manifest '${manifest:-<missing>}'"
    done
    self=$(jq -n --rawfile review .github/workflows/review.yml --rawfile dependabot .github/dependabot.yml \
      --rawfile renovate .github/renovate.json '{repo: "cgwalters-forge/tracker", $review, $dependabot, justfile: true, $renovate}')
    {{ just_executable() }} forge-sync-drift .github/forge-sync/repos.json <<< "$self"
    echo "ok this repository against .github/forge-sync/repos.json"
    # The real manifest must keep requiring the preset of this repository.
    if {{ just_executable() }} forge-sync-drift .github/forge-sync/repos.json <<< "$(jq '.renovate = null' <<< "$self")" > /dev/null 2>&1; then
      echo "this repository without .github/renovate.json: want drift, got none" >&2; exit 1
    fi
    echo "ok this repository without .github/renovate.json drifts"

# forge-sync-drift on the default branch of every repository in the
# manifest, read through the contents API (a 404 is a missing file); fails
# if any repository drifted or could not be read. The step output `failed`
# lists those repositories and `drift`, a JSON string, their drift lines
# (forge-sync.yml).
forge-sync manifest=".github/forge-sync/repos.json":
    #!/usr/bin/env bash
    set -euo pipefail
    err=$(mktemp)
    trap 'rm -f "$err"' EXIT
    fetch() {
      local body
      if body=$(gh api "repos/$1/contents/$2" -H 'Accept: application/vnd.github.raw' 2> "$err"); then jq -Rs . <<< "$body"
      elif grep -q 'HTTP 404' "$err"; then echo null
      else echo "::error::$1: could not read $2: $(cat "$err")" >&2; return 1; fi
    }
    repos=$(jq -er '.repos | select(length > 0 and all(.[]; .repo | type == "string")) | .[].repo' "$1") || { echo "::error::$1: expected a manifest listing repos" >&2; exit 1; }
    # The Renovate config is read only when the manifest asks for a preset,
    # from the two JSON places Renovate looks for it that the forge uses.
    preset=$(jq -r '.renovate_preset // empty' "$1")
    failed=() drift=
    for repo in $repos; do
      out= renovate=null
      if j=$(fetch "$repo" Justfile) && if [[ $j == null ]]; then j=$(fetch "$repo" justfile); fi &&
        if [[ -n $preset ]]; then
          renovate=$(fetch "$repo" renovate.json) && if [[ $renovate == null ]]; then renovate=$(fetch "$repo" .github/renovate.json); fi
        fi &&
        input=$(jq -n --arg repo "$repo" --argjson review "$(fetch "$repo" .github/workflows/review.yml)" \
          --argjson dependabot "$(fetch "$repo" .github/dependabot.yml)" --argjson j "$j" --argjson renovate "$renovate" \
          '{$repo, $review, $dependabot, justfile: ($j != null), $renovate}') &&
        out=$({{ just_executable() }} forge-sync-drift "$1" <<< "$input"); then
        echo "ok $repo"; continue
      fi
      out=${out:-"$repo: could not be read or checked"}
      echo "$out"; drift+=$out$'\n'; failed+=("$repo")
    done
    # The lines quote the repositories' files, so the output is capped.
    drift=${drift%$'\n'}
    printf 'failed=%s\ndrift=%s\n' "${failed[*]}" "$(jq -nc --arg d "${drift:0:50000}" '$d')" >> "${GITHUB_OUTPUT:-/dev/null}"
    [[ ${#failed[@]} -eq 0 ]]

# The runner configuration's checks; those that run `agentic-job` skip where
# it is not installed. The build goes outside the source tree.
test-config:
    cargo test --locked --manifest-path .github/agentic-job/config-test/Cargo.toml --target-dir "{{ env('CARGO_TARGET_DIR', cache_directory() / 'tracker-config-test') }}"

# The shipped supervisor settings through the binary supervisor.yml pins
# (AGENT_BOARD, from build-supervisor-agent-board): a cap the executor
# refuses would otherwise fail every pass after the merge. Empty checks and
# no --daily return before any API request. The executor takes its `follow`
# from agent-board.json and refuses a whole batch over one item outside it.
test-supervisor-config:
    #!/usr/bin/env bash
    set -euo pipefail
    jq -e '.capacityMarginPercent == 10 and
      .agent.passConfig == ".github/pass.json"' .github/supervisor/config.json > /dev/null
    jq -nr --slurpfile board .github/poll/agent-board.json --slurpfile sup .github/supervisor/config.json \
      '$sup[0].agent.releaseList // [] | map(.item | sub("#[0-9]+$"; "")) - $board[0].follow
      | if . == [] then empty else "releaseList outside follow: \(unique | join(", "))\n" | halt_error end'
    if [[ -z ${AGENT_BOARD:-} ]]; then echo 'skipped: set AGENT_BOARD to the built binary'; exit 0; fi
    health=$(mktemp)
    echo '[]' > "$health"
    out=$(GH_TOKEN=unused GITHUB_RUN_ID=1 \
      GITHUB_REPOSITORY=$(jq -er .agent.requests.repository .github/supervisor/config.json) \
      "$AGENT_BOARD" supervise trigger --config .github/poll/agent-board.json \
      --supervisor-config .github/supervisor/config.json --pools .github/agentic-job/pools.json --health "$health")
    [[ $out == act=false ]]

# pass.json and the fix bounds poll.yml passes, through the pinned binary's
# offline `pass --check-config` (agent-board#756), which reads no token: a
# setting the pass refuses would otherwise fail every pass after the merge
# (#1403). It runs on every pull request, so a pin move that tightens the
# checks is caught too. The pin is the poll's: agent-board-pin keeps one.
test-pass-config:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -z ${AGENT_BOARD:-} ]]; then echo 'skipped: set AGENT_BOARD to the built binary'; exit 0; fi
    "$AGENT_BOARD" pass --check-config --config .github/pass.json \
      --fix-bounds .github/agentic-job/fix.toml --fix-bounds .github/agentic-job/midstream-fix.toml

# Validate against the actor that will consume the config, not a moving head.
build-supervisor-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$(sed -n 's/^  AGENT_BOARD_REV: \([0-9a-f]\{40\}\)$/\1/p' .github/workflows/supervisor.yml)
    [[ $rev =~ ^[0-9a-f]{40}$ ]] || { echo 'expected one supervisor pin' >&2; exit 1; }
    {{ just_executable() }} build-agent-board "$rev"

# The agent-board.json of maintain-shadow.yml's poll: pass.json's operator,
# bot and dispatch settings and its whole `pr` policy, following only FOLLOW.
# The pinned poll takes every `pr` key of the pinned pass at its top level
# under the same name (agent-board docs/poll.md, Configuration), so each is
# copied with its value, except the two lists that may name only followed
# repositories, which keep their FOLLOW entry alone. A key in neither list
# fails the run: a key the pass gains must be placed here, never dropped
# unseen, or the preview would compare a different policy (#1362).
maintain-shadow-config pass follow:
    #!/usr/bin/env bash
    set -euo pipefail
    jq -e --arg follow "$2" '
      ["reviewWorkflow", "fixPools", "toilFixPool", "conflictFixPool", "mergeAuthors", "rebaseRounds", "mergeQueue",
        "checkReruns", "unstall", "ownerBranches", "ownSpaceOnly", "foldRounds", "reviewPools",
        "headOwners", "noMerge", "operatorPaths", "staleDays", "actionFirst"] as $copied
      | ["reviewDispatchRepositories", "draftReviewRepositories"] as $scoped
      | (.pr // {}) as $pr
      | ($pr | keys - $copied - $scoped) as $unknown
      | if $unknown != [] then
          "maintain-shadow-config: pr key(s) \($unknown | join(", ")) not in its lists; add each the pinned poll reads to the Justfile recipe\n" | halt_error
        else . end
      | ({operator, bot, dispatchRepo, dispatchWorkflow} | with_entries(select(.value != null))) + {follow: [$follow]}
      + ($pr | with_entries(select(.key | IN($copied[]))))
      + ($pr | with_entries(select(.key | IN($scoped[]))
          | .value |= map(select(ascii_downcase == ($follow | ascii_downcase)))))' "$1"

# maintain-shadow.yml previews with the job token only, and its poll gets
# pass.json's settings. With AGENT_BOARD, the pinned CLI must take its flags.
test-maintain-shadow:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { execFileSync, spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const workflow = fs.readFileSync('.github/workflows/maintain-shadow.yml', 'utf8');
    assert.doesNotMatch(workflow, /secrets\.|: write|--apply/);
    assert.match(workflow, /^ {6}group: maintain-shadow\n {6}cancel-in-progress: false$/m);
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(workflow, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}steps:/m);
    const poll = fs.readFileSync('.github/workflows/poll.yml', 'utf8');
    const next = poll.split('\n  next:\n')[1].split('\n  next-fallback:')[0];
    assert.match(next, /^ {4}permissions:\n {6}actions: write\n {4}steps:/m);
    const step = /      - name: Start the shadow poll if stale\n([^]*?)(?=      - name:)/.exec(next)[1];
    const gate = /        if: \$\{\{ (.*) \}\}/.exec(step)[1];
    for (const value of [undefined, '', 'disabled', 'true', 'Enabled', 'enabled']) {
      const admitted = new Function('vars', `return ${gate}`)({ MAINTAIN_SHADOW: value });
      assert.equal(admitted, value === 'enabled');
    }
    assert.match(step, /GH_TOKEN: \$\{\{ github.token \}\}/);
    assert.match(step, /DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}/);
    assert.match(step, /timeout-minutes: 2/);
    assert.doesNotMatch(step, /secrets\./);
    const script = /        run: \|\n([^]*)/.exec(step)[1].replace(/^          /gm, '');
    assert.ok(script.trimEnd().split('\n').length <= 10);
    const temp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'shadow-next-'));
    try {
      fs.writeFileSync(`${temp}/gh`, `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.CAPTURE, JSON.stringify(args) + '\\n');
    if (args[0] === 'run') { process.stdout.write(process.env.LATEST); process.exit(Number(process.env.LIST_EXIT)); }
    process.exit(Number(process.env.DISPATCH_EXIT));
    `, { mode: 0o755 });
      fs.writeFileSync(`${temp}/date`, '#!/bin/sh\nif [ "$1" = +%s ]; then printf "2000000000\\n"; else exec /usr/bin/date "$@"; fi\n', { mode: 0o755 });
      for (const [age, listExit, dispatchExit, dispatches] of [
        [null, 0, 0, true], [1800, 0, 0, true], [1801, 0, 0, true],
        [1799, 0, 0, false], [0, 0, 0, false], [-60, 0, 0, false],
        [null, 1, 0, false], [1800, 0, 1, true],
      ]) {
        fs.writeFileSync(`${temp}/calls`, '');
        const got = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
          encoding: 'utf8', env: { PATH: `${temp}:${process.env.PATH}`, GH_TOKEN: '', DEFAULT_BRANCH: 'custom-default',
            CAPTURE: `${temp}/calls`, LATEST: age === null ? '' : new Date((2000000000 - age) * 1000).toISOString(),
            LIST_EXIT: String(listExit), DISPATCH_EXIT: String(dispatchExit) },
        });
        assert.equal(got.status, 0, got.stderr);
        const calls = fs.readFileSync(`${temp}/calls`, 'utf8').trimEnd().split('\n').map(JSON.parse);
        assert.deepEqual(calls, [
          ['run', 'list', '--workflow', 'maintain-shadow.yml', '--branch', 'custom-default', '--limit', '1', '--json', 'createdAt', '--jq', '.[0].createdAt // empty'],
          ...(dispatches ? [['workflow', 'run', 'maintain-shadow.yml', '--ref', 'custom-default']] : []),
        ]);
        assert.equal(got.stdout.includes('::warning::'), Boolean(listExit || dispatchExit));
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('ok poll next wakes the shadow only when enabled and stale; failures warn without breaking the chain');
    // Each fixture's own `pr` keys set what its config must hold, not the
    // generator's lists: every key is copied with its value, or, for the two
    // lists the pinned poll lets name only followed repositories, cut to the
    // follow entry as the poll compares it, and a key the generator does not
    // know fails naming it (#1362). The pinned pass has no `pr` key the pinned
    // poll refuses, so nothing is left out on purpose.
    const follow = 'cgwalters-forge/agentic-job';
    const scoped = ['reviewDispatchRepositories', 'draftReviewRepositories'];
    const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'shadow-config-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    const generate = (pass) => {
      fs.writeFileSync(`${dir}/pass.json`, JSON.stringify(pass));
      return spawnSync('{{ just_executable() }}', ['maintain-shadow-config', `${dir}/pass.json`, follow], { encoding: 'utf8' });
    };
    const today = JSON.parse(fs.readFileSync('.github/pass.json', 'utf8'));
    const base = { operator: 'op', bot: 'bot', dispatchRepo: 'o/tracker', dispatchWorkflow: 'dispatch.yml', follow: ['o/x'] };
    const reviews = { reviewWorkflow: 'review.yml', reviewPools: ['claude'],
      reviewDispatchRepositories: ['cgwalters-forge/agent-board', follow.toUpperCase(), 'cgwalters-forge/tracker'],
      draftReviewRepositories: ['cgwalters-forge/agent-board', follow], noMerge: [follow] };
    const fixtures = {
      today,
      foldRounds: { ...base, pr: { foldRounds: true } },
      reviewPools: { ...base, pr: { reviewWorkflow: 'review.yml', reviewPools: ['claude', 'openai'] } },
      scoped: { ...base, pr: reviews },
      pools: { ...base, pr: { fixPools: ['claude'], toilFixPool: 'openai', conflictFixPool: 'claude' } },
      off: { ...base, pr: { checkReruns: false, unstall: false, ownerBranches: false, ownSpaceOnly: false, foldRounds: false,
        staleDays: 0, rebaseRounds: 0, fixPools: [], mergeAuthors: [], headOwners: [], noMerge: [], operatorPaths: [],
        reviewPools: [], reviewDispatchRepositories: [], draftReviewRepositories: [], mergeQueue: {} } },
      full: { ...today, pr: { ...today.pr, foldRounds: true, toilFixPool: 'openai', conflictFixPool: 'claude', ...reviews } },
      unfollowed: { ...base, pr: { reviewWorkflow: 'review.yml', reviewPools: ['claude'], reviewDispatchRepositories: ['cgwalters-forge/agent-board'] } },
      noPr: base,
    };
    const configs = {};
    for (const [name, pass] of Object.entries(fixtures)) {
      const got = generate(pass);
      assert.equal(got.status, 0, `${name}: ${got.stderr}`);
      const expected = { operator: pass.operator, bot: pass.bot, dispatchRepo: pass.dispatchRepo,
        dispatchWorkflow: pass.dispatchWorkflow, follow: [follow] };
      for (const [key, value] of Object.entries(pass.pr ?? {})) {
        expected[key] = scoped.includes(key) ? value.filter((r) => r.toLowerCase() === follow.toLowerCase()) : value;
      }
      assert.deepEqual(configs[name] = JSON.parse(got.stdout), expected, name);
    }
    assert.deepEqual(configs.scoped.reviewDispatchRepositories, [follow.toUpperCase()]);
    assert.deepEqual(configs.scoped.draftReviewRepositories, [follow]);
    assert.deepEqual(configs.unfollowed.reviewDispatchRepositories, []);
    const unknown = generate({ ...base, pr: { ...today.pr, futureKey: true, otherKey: [] } });
    assert.notEqual(unknown.status, 0);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /pr key\(s\) futureKey, otherKey not in its lists/);
    console.log('ok maintain-shadow previews read-only; each fixture\'s pr keys reach its config, cut to its follow, or fail it');
    if (process.env.AGENT_BOARD) {
      const help = execFileSync(process.env.AGENT_BOARD, ['poll', '--help']).toString();
      const command = /"\$AGENT_BOARD" poll [\s\S]*?\| tee/.exec(workflow)[0];
      for (const flag of new Set(command.match(/--[\w-]+/g))) {
        assert.match(help, new RegExp(`${flag}(?![\\w-])`), `${flag} in agent-board poll --help`);
      }
      console.log('ok the pinned agent-board poll takes every flag maintain-shadow passes');
      // The pinned poll decodes its config before it needs a token, so with
      // none each generated config either fails decoding, naming the key, or
      // gets as far as asking for one.
      const { GH_TOKEN, GITHUB_TOKEN, ...env } = process.env;
      for (const [name, config] of Object.entries(configs)) {
        fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(config));
        const got = spawnSync(process.env.AGENT_BOARD, ['poll', '--dry-run', '--config', `${dir}/${name}.json`, '--follow', follow],
          { encoding: 'utf8', env });
        assert.match(got.stderr, /authentication required/, `${name}: ${got.stderr}`);
      }
      console.log('ok the pinned agent-board poll decodes every generated config');
    } else {
      console.log('skipped: set AGENT_BOARD to check the flags and the generated configs against the pinned CLI');
    }

# No moving refs or source fallback: substituted assets must not run with the
# bot's write token. The attested manifest binds both digests to reviewed CI.
build-agent-board rev=env("AGENT_BOARD_REV", ""):
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$1
    [[ $rev =~ ^[0-9a-f]{40}$ ]] || { echo 'expected a pinned 40-character AGENT_BOARD_REV' >&2; exit 1; }
    [[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || { echo 'agent-board binaries support only Linux x86_64' >&2; exit 1; }
    repo=cgwalters-forge/agent-board target=x86_64-unknown-linux-musl
    tag=build-$rev
    dest=$RUNNER_TEMP/agent-board/bin
    mkdir -p "$dest"
    rm -f "$dest/agent-board"
    stage=$(mktemp -d "$RUNNER_TEMP/agent-board-download.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    timeout 180 gh release download "$tag" --repo "$repo" --dir "$stage" \
      --pattern "*-$target" --pattern SHA256SUMS --pattern release.json --pattern provenance.jsonl
    GH_TOKEN='' GITHUB_TOKEN='' timeout 180 gh attestation verify "$stage/release.json" \
      --bundle "$stage/provenance.jsonl" --repo "$repo" \
      --cert-identity "https://github.com/$repo/.github/workflows/ci.yml@refs/heads/main" \
      --source-ref refs/heads/main --source-digest "$rev" --deny-self-hosted-runners
    jq -e --arg repo "$repo" --arg tag "$tag" --arg commit "$rev" --arg target "$target" \
      '.schema == "agent-board.release.v1" and .repository == $repo and .tag == $tag and .commit == $commit and .target == $target' "$stage/release.json" > /dev/null
    # Accept only the two fixed filenames, never paths supplied by a manifest.
    node -e 'const fs = require("node:fs"); const d = process.argv[1]; const s = JSON.parse(fs.readFileSync(d + "/release.json")).sha256sums; if (typeof s !== "string" || !/^[0-9a-f]{64}  agent-board-x86_64-unknown-linux-musl\n[0-9a-f]{64}  gh-agent-board-x86_64-unknown-linux-musl\n$/.test(s)) throw Error("invalid release checksums"); fs.writeFileSync(d + "/attested-SHA256SUMS", s);' "$stage"
    cmp "$stage/SHA256SUMS" "$stage/attested-SHA256SUMS"
    (cd "$stage" && sha256sum --check attested-SHA256SUMS)
    install -m 755 "$stage/agent-board-$target" "$dest/agent-board"
    echo "rev=$rev" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "Installed agent-board $rev ($target)"

# Offline transport fixtures exercise the real installer; no network or token.
# The real-* cases also run gh's own attestation verifier on a published
# release, so gh must be on PATH.
test-agent-board-install:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-install-'));
    const rev = 'a'.repeat(40);
    const target = 'x86_64-unknown-linux-musl';
    const stub = `#!/usr/bin/env node
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2), mode = process.env.CASE;
    const identity = 'https://github.com/cgwalters-forge/agent-board/.github/workflows/ci.yml@refs/heads/main';
    if (process.env.BUMP) {
      if (args[0] === 'api' && args.some(a => a.endsWith('/commits/main'))) { console.log('${rev}'); process.exit(0); }
      if (args[0] === 'api' && args.some(a => a.endsWith('/check-runs'))) { console.log(JSON.stringify({name: 'ci', status: 'completed', conclusion: 'success'})); process.exit(0); }
      if (args[0] === 'release' && args[1] === 'view') { console.log(mode === 'draft' ? 'true' : 'false'); process.exit(mode === 'missing-release' ? 1 : 0); }
      if (args[0] === 'api' && args.some(a => a.includes('/compare/'))) { fs.writeFileSync(process.env.MARKER, 'selected'); console.log(JSON.stringify({status: 'ahead'})); process.exit(0); }
      if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify({title: 'workflows: Move agent-board to aaaaaaa'})); process.exit(0); }
    }
    if (args[0] === 'attestation') {
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(9);
      for (const s of ['--source-digest', process.env.REV, '--deny-self-hosted-runners', identity]) if (!args.includes(s)) process.exit(8);
      if (!mode.startsWith('real-')) process.exit(mode === 'attestation' ? 1 : 0);
      // The real verifier on the real bundle, offline: a dead proxy and the
      // committed trusted root. The signer case asks for another identity.
      const real = args.map(a => mode === 'real-signer' && a === identity ? identity.replace('/ci.yml@', '/release.yml@') : a);
      const dead = 'http://127.0.0.1:9';
      const r = spawnSync(process.env.REAL_GH, [...real, '--custom-trusted-root', path.join(process.env.FIXTURES, 'trusted_root.json')], {stdio: 'inherit', env: {...process.env, HTTPS_PROXY: dead, HTTP_PROXY: dead, NO_PROXY: ''}});
      fs.writeFileSync(process.env.VERIFIED, String(r.status));
      process.exit(r.status ?? 1);
    }
    if (['missing-release', 'download'].includes(mode)) process.exit(1);
    const d = args[args.indexOf('--dir') + 1];
    if (mode.startsWith('real-')) {
      // The published release.json and its bundle; the binaries are
      // stand-ins, so even an accepted attestation ends at the checksums.
      // real-subject changes one byte and keeps the JSON valid, so only the
      // attested subject digest can catch it.
      const release = fs.readFileSync(path.join(process.env.FIXTURES, 'release.json'), 'utf8');
      fs.writeFileSync(path.join(d, 'release.json'), mode === 'real-subject' ? release.replace('"schema"', '"schema" ') : release);
      fs.copyFileSync(path.join(process.env.FIXTURES, 'provenance.json'), path.join(d, 'provenance.jsonl'));
      fs.writeFileSync(path.join(d, 'SHA256SUMS'), JSON.parse(release).sha256sums);
      for (const n of ['agent-board', 'gh-agent-board']) fs.writeFileSync(path.join(d, n + '-${target}'), 'stand-in');
      process.exit(0);
    }
    let sums = '';
    for (const n of ['agent-board', 'gh-agent-board']) {
      const name = n + '-${target}', data = '#!/bin/sh\\nexit 0\\n';
      fs.writeFileSync(path.join(d, name), data);
      sums += crypto.createHash('sha256').update(data).digest('hex') + '  ' + name + '\\n';
    }
    fs.writeFileSync(path.join(d, 'SHA256SUMS'), mode === 'sums' ? 'bad' : sums);
    fs.writeFileSync(path.join(d, 'release.json'), JSON.stringify({schema: 'agent-board.release.v1', repository: 'cgwalters-forge/agent-board', tag: 'build-${rev}', commit: mode === 'commit' ? 'b'.repeat(40) : '${rev}', target: '${target}', sha256sums: sums}));
    fs.writeFileSync(path.join(d, 'provenance.jsonl'), 'fixture');
    if (mode === 'integrity') fs.appendFileSync(path.join(d, 'agent-board-${target}'), 'tampered');
    if (mode === 'missing-asset') fs.unlinkSync(path.join(d, 'agent-board-${target}'));
    `;
    // The published release.json, its bundle and Sigstore's trusted root
    // (`gh attestation trusted-root`), from agent-board's build-<commit>
    // release, for the real verifier.
    const fixtures = path.resolve('.github/agent-board-install');
    const published = JSON.parse(fs.readFileSync(path.join(fixtures, 'release.json'), 'utf8')).commit;
    const realGh = spawnSync('sh', ['-c', 'command -v gh'], {encoding: 'utf8'}).stdout.trim();
    assert.ok(realGh, 'gh on PATH, for the real attestation verifier');
    // Nonempty, so the verifier sees no token only if the installer clears them.
    const tokens = {GH_TOKEN: 'sentinel-not-a-token', GITHUB_TOKEN: 'sentinel-not-a-token'};
    const install = (mode, r, temp) => spawnSync('{{ just_executable() }}', ['build-agent-board', r], {encoding: 'utf8', env: {...process.env, ...tokens, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_OUTPUT: path.join(temp, 'output'), CASE: mode, REV: r, FIXTURES: fixtures, REAL_GH: realGh, VERIFIED: path.join(temp, 'verified'), GH_CONFIG_DIR: temp}});
    try {
      fs.writeFileSync(path.join(dir, 'gh'), stub, {mode: 0o755});
      fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\nif [ "$CASE" = platform ]; then printf Darwin; else /usr/bin/uname "$@"; fi\n', {mode: 0o755});
      for (const mode of ['ok', 'missing-release', 'missing-asset', 'platform', 'download', 'attestation', 'commit', 'sums', 'integrity', 'revision']) {
        const temp = fs.mkdtempSync(path.join(dir, 'run-'));
        const output = path.join(temp, 'output');
        const result = install(mode, mode === 'revision' ? '' : rev, temp);
        assert.equal(result.status === 0, mode === 'ok', `${mode}: ${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(path.join(temp, 'agent-board/bin/agent-board')), mode === 'ok', mode);
        if (mode === 'ok') assert.equal(fs.readFileSync(output, 'utf8'), `rev=${rev}\n`);
        else assert.equal(fs.existsSync(output), false, mode);
        console.log(`ok agent-board installer: ${mode}`);
      }
      // Only the right commit verifies, and then the stand-in binaries fail
      // their checksums; the wrong commit, a changed subject or another
      // signer is rejected by the verifier itself.
      for (const mode of ['real-ok', 'real-revision', 'real-subject', 'real-signer']) {
        const temp = fs.mkdtempSync(path.join(dir, 'run-'));
        const result = install(mode, mode === 'real-revision' ? rev : published, temp);
        const log = `${mode}: ${result.stdout}\n${result.stderr}`;
        assert.notEqual(result.status, 0, log);
        assert.equal(fs.readFileSync(path.join(temp, 'verified'), 'utf8') === '0', mode === 'real-ok', log);
        if (mode === 'real-ok') assert.match(result.stdout, /agent-board-x86_64-unknown-linux-musl: FAILED/, log);
        assert.equal(fs.existsSync(path.join(temp, 'agent-board/bin/agent-board')), false, mode);
        console.log(`ok agent-board installer: ${mode}`);
      }
      for (const mode of ['ok', 'missing-release', 'draft', 'missing-asset', 'attestation', 'integrity']) {
        const marker = path.join(dir, 'selected');
        fs.rmSync(marker, {force: true});
        const result = spawnSync('{{ just_executable() }}', ['bump-agent-board'], {encoding: 'utf8', env: {...process.env, ...tokens, PATH: `${dir}:${process.env.PATH}`, CASE: mode, REV: rev, BUMP: '1', MARKER: marker, GITHUB_REPOSITORY: 'cgwalters-forge/tracker'}});
        assert.equal(result.status === 0, ['ok', 'missing-release', 'draft'].includes(mode), `${mode}: ${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(marker), mode === 'ok', `bump must verify before selecting: ${mode}`);
        console.log(`ok agent-board bump: ${mode}`);
      }
      const pins = fs.mkdtempSync(path.join(dir, 'pins-'));
      fs.mkdirSync(path.join(pins, '.github/workflows'), {recursive: true});
      fs.copyFileSync('Justfile', path.join(pins, 'Justfile'));
      const checkPin = () => spawnSync('{{ just_executable() }}', ['agent-board-pin'], {cwd: pins, encoding: 'utf8'});
      fs.writeFileSync(path.join(pins, '.github/workflows/a.yml'), `env:\n  AGENT_BOARD_REV: ${rev}\n`);
      assert.equal(checkPin().stdout.trim(), rev);
      fs.writeFileSync(path.join(pins, '.github/workflows/b.yml'), `env:\n  AGENT_BOARD_REV: ${'b'.repeat(40)}\n`);
      assert.notEqual(checkPin().status, 0);
      console.log('ok agent-board pin agreement and mismatch');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }

# The shared workflow check that ci.yml's lint job calls, run locally from
# a checkout of the forge's actions repository (its lint/README.md), the
# path relative to this repository's root; CONTAINER=podman without docker:
#   just lint ../actions
lint actions:
    {{ just_executable() }} --justfile "{{ actions }}/lint/Justfile" --working-directory . check
