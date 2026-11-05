# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-agent-board-install test-config test-dispatch-pool test-supervisor-config test-supervisor-workflow test-poll-bounds test-poll-next test-maintain-shadow test-review-caller test-review-gate test-forge-sync test-review-corpus test-review-refresh agent-board-pin

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

# Offline resolver and real workflow step, with a temporary heavy configuration.
test-dispatch-pool:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/dispatch.yml', 'utf8');
    const script = /- name: Resolve the pool[^]*?        run: \|\n((?:          .*\n)+)/.exec(workflow)[1].replace(/^          /gm, '');
    // Exercise the same function as the real step, without running its CLI body.
    const source = script.split('\ntry {')[0].split('\n').slice(1).join('\n');
    const resolve = new Function(`${source}; return resolve;`)();
    // Representative deployment configuration, never installed in production.
    const pools = JSON.parse(fs.readFileSync('.github/agentic-job/pools.json', 'utf8'));
    const original = structuredClone(pools);
    pools.openai.heavy = { model: 'praxis/gpt-6-astra' };
    const snapshot = structuredClone(pools);
    const normal = resolve(pools, { pool: 'openai' });
    assert.deepEqual(normal, { skilled: 'true', agent: 'opencode', model: pools.openai.model, budget: '500' });
    assert.deepEqual(resolve(pools, {}), { skilled: 'true', agent: '', model: '', budget: '' });
    assert.deepEqual(resolve(pools, { agent: 'vibe', model: 'anything' }),
      { skilled: 'false', agent: '', model: '', budget: '' });
    const heavy = { ...normal, model: pools.openai.heavy.model };
    assert.deepEqual(resolve(pools, { pool: 'openai', effort: 'heavy' }), heavy);
    assert.deepEqual(resolve(pools, { effort: 'heavy', agent: 'opencode', model: pools.openai.model }),
      { ...resolve(pools, {}), model: heavy.model });
    const inheritedClaude = structuredClone(pools);
    inheritedClaude.claude.heavy = { model: 'claude-heavy-fixture' };
    assert.deepEqual(resolve(inheritedClaude, { pool: 'claude', effort: 'heavy' }),
      { ...resolve(pools, { pool: 'claude' }), model: 'claude-heavy-fixture' }, 'explicit pool keeps its 3000 AIC budget');
    assert.deepEqual(resolve(inheritedClaude, { effort: 'heavy', agent: 'claude', model: pools.claude.model }),
      { ...resolve(pools, { agent: 'claude' }), model: 'claude-heavy-fixture' }, 'inherited budget remains the wrapper default, not 3000');
    assert.deepEqual(resolve(pools, { pool: 'openai', effort: 'heavy', agent: 'claude', model: 'ignored' }), heavy);
    assert.deepEqual(pools, snapshot, 'pool identity, tier, allowance and configuration are not mutated');
    for (const effort of ['Heavy', ' heavy', 'heavy\n', 'low', 'default', 'praxis/gpt-6-astra']) {
      assert.throws(() => resolve(pools, { pool: 'openai', effort }), /effort must/);
    }
    for (const effort of ['', 'heavy']) assert.throws(() => resolve(pools, { pool: 'unknown', effort }), /unknown pool/);
    for (const settings of [{}, { model: 'unknown' }, { model: pools.openai.model, agent: 'claude' }]) {
      assert.throws(() => resolve(pools, { ...settings, effort: 'heavy' }), /explicit pool or a unique/);
    }
    assert.throws(() => resolve({ ...pools, duplicate: pools.openai },
      { effort: 'heavy', model: pools.openai.model }), /unique/);
    for (const variant of [undefined, null, [], 'model', {}, { model: '' }, { model: null },
      { model: 42 }, { model: 'bad model' }, { model: 'x\n' }, { model: 'x\r' },
      { model: 'x\nbudget=9999' }, { model: 'x'.repeat(201) }]) {
      const broken = structuredClone(pools);
      broken.openai.heavy = variant;
      for (const settings of [{ pool: 'openai' }, { agent: 'opencode', model: pools.openai.model }]) {
        assert.throws(() => resolve(broken, { ...settings, effort: 'heavy' }), /heavy.model/);
      }
      assert.deepEqual(resolve(broken, { pool: 'openai' }), normal, 'omission never reads heavy');
    }
    assert.throws(() => resolve(original, { pool: 'openai', effort: 'heavy' }), /heavy.model/);
    assert.throws(() => resolve(pools, { pool: 'openai', effort: 'heavy', kind: 'review' }), /not supported for reviews/);
    assert.match(workflow, /      effort:\n[^]*?        type: string\n        default: ''/);
    const expression = value => '$' + '{' + `{ ${value} }}`;
    for (const line of [`EFFORT: ${expression('inputs.effort')}`, `POOL: ${expression('inputs.pool')}`,
      `AGENT_MODEL: ${expression('vars.AGENT_MODEL')}`, `AGENT: ${expression("vars.AGENT || 'opencode'")}`,
      `model: ${expression('needs.profile.outputs.model')}`, `budget: ${expression("needs.profile.outputs.budget || '500'")}`,
      'cancel-in-progress: false']) assert.ok(workflow.includes(line), line);
    assert.match(workflow, /run-name: .*inputs.pool.*\n/);
    assert.doesNotMatch(workflow.split('\non:')[0], /inputs.effort/, 'run identity stays pool-based');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-pool-'));
    try {
      fs.mkdirSync(path.join(temp, '.github/agentic-job'), { recursive: true });
      fs.writeFileSync(path.join(temp, '.github/agentic-job/pools.json'), JSON.stringify(pools));
      const output = path.join(temp, 'output');
      for (const [pool, effort, model, succeeds] of [
        ['openai', '', '', true], ['', '', '', true], ['openai', 'heavy', '', true],
        ['', 'heavy', pools.openai.model, true], ['openai', 'invalid', '', false],
        ['unknown', 'heavy', '', false], ['claude', 'heavy', '', false], ['', 'heavy', '', false],
      ]) {
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: temp, encoding: 'utf8',
          env: { PATH: process.env.PATH, POOL: pool, EFFORT: effort, AGENT: 'opencode', AGENT_MODEL: model,
            KIND: 'implement', GITHUB_OUTPUT: output } });
        assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
        const text = fs.readFileSync(output, 'utf8');
        assert.equal(text, succeeds ? Object.entries(resolve(pools, { pool, effort, model })).map(([k, v]) => `${k}=${v}\n`).join('') : '',
          'failure writes no usable outputs before inference');
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log('ok dispatch omission, explicit/inherited heavy, fail-closed resolution and workflow plumbing');

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
      for (const [outcome, quota] of [['success', ''], ['success', 'stopped'], ['failure', ''],
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
      // The quota reserve: the Collect step's script with a stub collector
      // that runs until signalled or exits on its own, gh reporting the quota
      // left (FIRST, if set, before the collector starts) and sleep made
      // instant.
      const collect = /- name: Collect\n[\s\S]*?run: \|\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1].replace(/^          /gm, '');
      const stubs = `${temp}/stubs`;
      fs.mkdirSync(stubs);
      fs.writeFileSync(`${stubs}/cgwalters-forge-misctool`, `#!${process.execPath}
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.appendFileSync('signals', 'SIGTERM\\n'); if (!process.env.STUBBORN) process.exit(0); });
    fs.writeFileSync('ready', '');
    if (process.env.EXIT) setTimeout(() => process.exit(+process.env.EXIT), 200); else setInterval(() => {}, 1000);
    `, { mode: 0o755 });
      fs.writeFileSync(`${stubs}/gh`, `#!/bin/sh
    case "$*" in *limit) echo "\${LIMIT-5000}"; exit;; esac
    if [ -f asked ]; then until [ -f ready ]; do /bin/sleep 0.01; done; else : > asked; LEFT=\${FIRST-$LEFT}; fi
    [ -n "$LEFT" ] && echo "$LEFT"
    `, { mode: 0o755 });
      fs.writeFileSync(`${stubs}/sleep`, '#!/bin/sh\nexec /bin/sleep 0.05\n', { mode: 0o755 });
      const runCollect = extra => {
        for (const f of ['signals', 'output', 'ready', 'asked']) fs.rmSync(`${temp}/${f}`, { force: true });
        fs.writeFileSync(`${temp}/output`, '');
        const got = spawnSync('bash', ['-eo', 'pipefail', '-c', collect], { cwd: temp, encoding: 'utf8', env: { ...env,
          PATH: `${stubs}:${process.env.PATH}`, GITHUB_OUTPUT: `${temp}/output`, RATE_LIMIT_RESERVE: '1500', ...extra } });
        const read = f => fs.existsSync(`${temp}/${f}`) ? fs.readFileSync(`${temp}/${f}`, 'utf8') : '';
        return { status: got.status, output: read('output'), signals: read('signals') };
      };
      const stopped = { status: 0, output: 'quota=stopped\n', signals: 'SIGTERM\n' };
      assert.deepEqual(runCollect({ FIRST: '5000', LEFT: '1499' }), stopped);
      assert.deepEqual(runCollect({ FIRST: '5000', LEFT: '1499', STUBBORN: '1' }), stopped);
      // Already below the reserve: the collector never starts.
      assert.deepEqual(runCollect({ LEFT: '1499' }), { status: 0, output: 'quota=stopped\n', signals: '' });
      assert(!fs.existsSync(`${temp}/ready`));
      const check = /- name: Check the quota reserve\n[\s\S]*?run: \|\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1].replace(/^          /gm, '');
      for (const [limit, status] of [['5000', 0], ['1500', 1], ['1000', 1], ['', 1]]) {
        const got = spawnSync('bash', ['-eo', 'pipefail', '-c', check], { cwd: temp, encoding: 'utf8',
          env: { ...env, PATH: `${stubs}:${process.env.PATH}`, RATE_LIMIT_RESERVE: '1500', LIMIT: limit } });
        assert.equal(got.status, status, `limit ${limit}`);
      }
      // The configured reserve passes against the job token's documented 1000.
      const reserve = /^  RATE_LIMIT_RESERVE: (\d+)$/m.exec(workflow)[1];
      assert.equal(spawnSync('bash', ['-eo', 'pipefail', '-c', check], { cwd: temp,
        env: { ...env, PATH: `${stubs}:${process.env.PATH}`, RATE_LIMIT_RESERVE: reserve, LIMIT: '1000' } }).status, 0);
      assert(+reserve > 0);
      assert.deepEqual(runCollect({ LEFT: '1500', EXIT: '0' }), { status: 0, output: '', signals: '' });
      for (const left of ['', 'null']) assert.deepEqual(runCollect({ LEFT: left, EXIT: '0' }), { status: 0, output: '', signals: '' });
      assert.deepEqual(runCollect({ LEFT: '0', RATE_LIMIT_RESERVE: '0', EXIT: '0' }), { status: 0, output: '', signals: '' });
      assert.deepEqual(runCollect({ LEFT: '1500', EXIT: '3' }), { status: 3, output: '', signals: '' });
      const publish = /- name: Publish\n([\s\S]*?)(?=      - name:)/.exec(workflow)[1];
      assert.match(publish, /gh release create[^]*--draft[^]*dist\/status\.json[^]*gh release edit[^]*--draft=false/);
      // Stub only gh's transport; run the documentation's real jq filters and loop.
      fs.writeFileSync(`${temp}/gh`, `#!${process.execPath}
    const { execFileSync } = require('node:child_process');
    const args = process.argv.slice(2);
    const rows = JSON.parse(process.env.RELEASES);
    if (process.env.FAIL === args[1]) process.exit(1);
    const row = rows.find(r => r.tagName === args[2]);
    const value = args[1] === 'list' ? rows.filter(r => !r.draft) : row;
    if (args[1] === 'download') process.stdout.write(JSON.stringify(row.status));
    else process.stdout.write(execFileSync('jq', ['-r', args[args.indexOf('--jq') + 1]], { input: JSON.stringify(value) }));
    `, { mode: 0o755 });
      const tag = n => `review-corpus-20261105-00000${n}`;
      const release = (n, status, draft = false) => ({ tagName: tag(n), draft, status,
        assets: status === undefined ? [] : [{ name: 'status.json' }] });
      const rows = [release(2, { complete: true }), release(5, { complete: false }),
        release(1), release(6, { complete: true }, true), release(4, { complete: 'true' }),
        release(3, {}), { tagName: 'review-corpus', assets: [] }];
      const selectionEnv = { PATH: `${temp}:${process.env.PATH}`, RELEASES: JSON.stringify(rows) };
      assert.equal(shell(selector, selectionEnv), `${tag(2)}\n`);
      assert.equal(shell(selector, { ...selectionEnv, RELEASES: JSON.stringify(rows.filter(r => r.tagName !== tag(2))) }), '');
      assert.equal(shell(selector, { ...selectionEnv, RELEASES: '[]' }), '');
      for (const failure of ['list', 'view', 'download']) {
        const got = spawnSync('bash', ['-euo', 'pipefail', '-c', selector], {
          cwd: temp, env: { ...env, ...selectionEnv, FAIL: failure }, encoding: 'utf8',
        });
        assert.equal(got.status, 1, failure);
        assert.equal(got.stdout, '', failure);
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
    assert.match(review, /^    uses: cgwalters-forge\/actions\/\.github\/workflows\/cgwalters-agentic-job.yml@f05e2372d3bd5540406d444e26c70ba8c845b07d$/m);
    const withBlock = review.split('    with:\n')[1].split('    #')[0];
    assert.deepEqual(withBlock.trim().split('\n').map(line => line.trim().split(':')[0]), ['kind', 'repo', 'item', 'head', 'pool', 'task']);
    for (const key of ['repo', 'item', 'head', 'pool']) assert.ok(withBlock.includes(`${key}: ${expression(`inputs.${key}`)}`));
    assert.doesNotMatch(review.replace(/^ *#.*$/gm, ''), /secrets:|inherit|SAFE_OUTPUTS_PAT|INFERENCE_API_KEY|AGENT_MODEL|pools\.json|needs\.profile/);
    assert.match(job('run'), /cgwalters-agentic-job.yml@main/);
    assert.match(job('run'), /SAFE_OUTPUTS_PAT: \$\{\{ secrets.CGWALTERS_BOT_PAT \}\}/);
    assert.match(dispatch, /      head:\n[^]*?        type: string\n        default: ''/);
    const gateJob = job('review-gate');
    assert.match(gateJob, /timeout-minutes: 1/);
    assert.ok(gateJob.includes(`ACTIVATION: ${expression('vars.REVIEW_DISPATCH')}`));
    for (const key of ['head', 'effort', 'config']) assert.ok(gateJob.includes(`${key.toUpperCase()}: ${expression(`inputs.${key}`)}`));
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
    assert.equal(checkGate({ EFFORT: 'heavy' }).status, 1);
    assert.equal(checkGate({ CONFIG: 'acp-experiment' }).status, 1);
    // Evaluate actual Actions expressions: exact producer title and exclusive routes.
    const evaluate = (source, inputs) => runInNewContext(source, { inputs, format: (s, ...args) => s.replace(/\{(\d+)\}/g, (_, n) => args[n]) });
    const title = inputs => /^run-name: (.*)$/m.exec(dispatch)[1].replace(/\$\{\{ (.*?) \}\}/g, (_, source) => evaluate(source, inputs));
    const inputs = { kind: 'review', repo: 'cgwalters-forge/tracker', item: '42', head, pool: 'openai', config: 'hosted' };
    assert.equal(title(inputs), `review cgwalters-forge/tracker#42 ${head} (openai)`);
    assert.equal(title({ ...inputs, config: 'acp-experiment' }), title(inputs), 'review title never gains config suffix');
    for (const kind of ['implement', 'fix', 'triage', 'research', 'review']) {
      const settings = { ...inputs, kind };
      for (const name of ['review-gate', 'review', 'profile', 'run']) {
        const condition = /if: \$\{\{ (.*?) \}\}/.exec(job(name))[1];
        assert.equal(evaluate(condition, settings), (name === 'review' || name === 'review-gate') === (kind === 'review'));
      }
      if (kind !== 'review') {
        assert.equal(title(settings), `${kind} cgwalters-forge/tracker#42 (openai)`);
        assert.equal(title({ ...settings, pool: '', config: 'acp-experiment' }), `${kind} cgwalters-forge/tracker#42 [acp-experiment]`);
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
    ]) {
      const github = { event_name, event: { issue: { pull_request: pull }, comment: { body } } };
      assert.equal(runInNewContext(gate, { github, startsWith: (s, prefix) => s.startsWith(prefix) }), want,
        `${event_name}: ${body}`);
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
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), 'f05e2372d3bd5540406d444e26c70ba8c845b07d');
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
# pinned CLI's help (AGENT_BOARD), which reads no token. The failure-only
# fallback uses runner tools and makes just one dispatch attempt.
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
      env: { PATH: process.env.PATH, RUNNER_TEMP: temp, DEFAULT_BRANCH: 'main', SUPERVISOR: '', RELEASE_TRAIN: '', ...env },
    }).toString().trimEnd().split('\n');
    const base = ['pass', 'next', '--workflow', 'poll.yml', '--branch', 'main', '--input', 'apply=true',
      '--apply-title', 'pass (apply)', '--wait-minutes', '10'];
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
    assert.match(fallback, /^ {4}needs: next$/m);
    const gate = /^ {4}if: \$\{\{ (.*) \}\}$/m.exec(fallback)[1];
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const cancelled of [false, true]) {
        for (const apply of ['', 'enabled', 'disabled']) {
          const got = require('node:vm').runInNewContext(gate, {
            cancelled: () => cancelled, needs: { next: { result } }, vars: { PASS_APPLY: apply },
          });
          assert.equal(got, result === 'failure' && !cancelled && apply === 'enabled');
        }
      }
    }
    assert.match(fallback, /^ {4}timeout-minutes: 12$/m);
    assert.match(fallback, /^ {4}permissions:\n {6}actions: write\n {4}steps:/m);
    assert.doesNotMatch(fallback, /uses:|continue-on-error:|^ {2}\S/m);
    assert.equal((fallback.match(/^ {6}- /gm) ?? []).length, 1, 'one step without setup');
    assert.match(fallback, /^ {10}GH_TOKEN: \$\{\{ github.token \}\}$/m);
    assert.match(fallback, /^ {10}DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}$/m);
    const recovery = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(fallback)[1].replace(/^ {10}/gm, '');
    const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll-fallback-'));
    try {
      fs.writeFileSync(path.join(sandbox, 'gh'), '#!/bin/bash\nif [[ $1 == api ]]; then printf "%s\\n" "$*" >&2; printf "2026-11-02T17:51:00Z\\n"; exit "${API_EXIT:-0}"; fi\nprintf "%s\\n" "$*"\nexit "${DISPATCH_EXIT:-0}"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'date'), '#!/bin/bash\nif [[ $1 == -d ]]; then printf "1000\\n"; else printf "%s\\n" "$NOW"; fi\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'sleep'), '#!/bin/bash\nprintf "sleep %s\\n" "$*"\n', { mode: 0o755 });
      const api = 'api repos/owner/repo/actions/runs/42 --jq .run_started_at';
      const dispatch = 'workflow run poll.yml --repo owner/repo --ref main -f apply=true';
      const recover = (env) => require('node:child_process').spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', recovery], {
        env: { PATH: `${sandbox}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', DEFAULT_BRANCH: 'main', ...env }, encoding: 'utf8',
      });
      for (const [now, delay] of [['1120', '480'], ['1600', null], ['1900', null], ['900', '600']]) {
        const got = recover({ NOW: now });
        assert.equal(got.status, 0, got.stderr);
        assert.equal(got.stderr.trimEnd(), api);
        assert.deepEqual(got.stdout.trimEnd().split('\n'), [...(delay ? [`sleep ${delay}`] : []), dispatch]);
      }
      const failed = recover({ NOW: '1900', DISPATCH_EXIT: '1' });
      assert.equal(failed.status, 1, 'dispatch failure stays visible');
      assert.equal(failed.stderr.trimEnd(), api);
      assert.deepEqual(failed.stdout.trimEnd().split('\n'), [dispatch], 'no retry on failure');
      const unreadable = recover({ NOW: '1900', API_EXIT: '1' });
      assert.equal(unreadable.status, 1);
      assert.equal(unreadable.stderr.trimEnd(), api);
      assert.equal(unreadable.stdout, '', 'API failure stops recovery');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    console.log('ok poll fallback is failure-only, waits at most ten minutes and dispatches once');

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
# no --daily return before any API request.
test-supervisor-config:
    #!/usr/bin/env bash
    set -euo pipefail
    jq -e '.capacityMarginPercent == 10 and
      .agent.passConfig == ".github/pass.json"' .github/supervisor/config.json > /dev/null
    if [[ -z ${AGENT_BOARD:-} ]]; then echo 'skipped: set AGENT_BOARD to the built binary'; exit 0; fi
    health=$(mktemp)
    echo '[]' > "$health"
    out=$(GH_TOKEN=unused GITHUB_RUN_ID=1 \
      GITHUB_REPOSITORY=$(jq -er .agent.requests.repository .github/supervisor/config.json) \
      "$AGENT_BOARD" supervise trigger --config .github/poll/agent-board.json \
      --supervisor-config .github/supervisor/config.json --pools .github/agentic-job/pools.json --health "$health")
    [[ $out == act=false ]]

# Validate against the actor that will consume the config, not a moving head.
build-supervisor-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$(sed -n 's/^  AGENT_BOARD_REV: \([0-9a-f]\{40\}\)$/\1/p' .github/workflows/supervisor.yml)
    [[ $rev =~ ^[0-9a-f]{40}$ ]] || { echo 'expected one supervisor pin' >&2; exit 1; }
    {{ just_executable() }} build-agent-board "$rev"

# The agent-board.json of maintain-shadow.yml's poll: pass.json's operator,
# bot and dispatch settings and the `pr` keys poll reads, following only
# FOLLOW. The pass-only `pr` keys have no poll equivalent and are left out.
maintain-shadow-config pass follow:
    #!/usr/bin/env bash
    set -euo pipefail
    jq -e --arg follow "$2" '{operator, bot, dispatchRepo, dispatchWorkflow, follow: [$follow]}
      + (.pr | {reviewWorkflow, fixPools, mergeAuthors, rebaseRounds, mergeQueue})
      | with_entries(select(.value != null))' "$1"

# maintain-shadow.yml previews with the job token only, and its poll gets
# pass.json's settings. With AGENT_BOARD, the pinned CLI must take its flags.
test-maintain-shadow:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const workflow = fs.readFileSync('.github/workflows/maintain-shadow.yml', 'utf8');
    assert.doesNotMatch(workflow, /secrets\.|: write|--apply/);
    assert.match(workflow, /^ {6}group: maintain-shadow\n {6}cancel-in-progress: false$/m);
    const pass = JSON.parse(fs.readFileSync('.github/pass.json', 'utf8'));
    const config = JSON.parse(execFileSync('{{ just_executable() }}',
      ['maintain-shadow-config', '.github/pass.json', 'cgwalters-forge/agentic-job'], { encoding: 'utf8' }));
    assert.deepEqual(config, {
      operator: pass.operator, bot: pass.bot, dispatchRepo: pass.dispatchRepo,
      dispatchWorkflow: pass.dispatchWorkflow, follow: ['cgwalters-forge/agentic-job'],
      reviewWorkflow: pass.pr.reviewWorkflow, fixPools: pass.pr.fixPools, mergeAuthors: pass.pr.mergeAuthors,
      rebaseRounds: pass.pr.rebaseRounds, mergeQueue: pass.pr.mergeQueue,
    });
    console.log('ok maintain-shadow previews read-only with pass.json\'s poll settings');
    if (process.env.AGENT_BOARD) {
      const help = execFileSync(process.env.AGENT_BOARD, ['poll', '--help']).toString();
      const command = /"\$AGENT_BOARD" poll [\s\S]*?\| tee/.exec(workflow)[0];
      for (const flag of new Set(command.match(/--[\w-]+/g))) {
        assert.match(help, new RegExp(`${flag}(?![\\w-])`), `${flag} in agent-board poll --help`);
      }
      console.log('ok the pinned agent-board poll takes every flag maintain-shadow passes');
    } else {
      console.log('skipped: set AGENT_BOARD to check the flags against the pinned CLI');
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
