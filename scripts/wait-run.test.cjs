const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// A stand-in gh: `repo view` answers with the directory it was asked from,
// `run view` records the repository it was given and reports completion.
function run(env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-run-'));
  try {
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(temp, 'log');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "repo view") [ -z "$NO_REPO" ] || exit 1; printf 'from/%s\\n' "$(basename "$PWD")" ;;
  "run view") echo "$5" >> "${log}"; case "$7" in status) echo completed ;; *) echo success ;; esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync(path.join(__dirname, 'wait-run'), ['42'], {
      cwd: temp, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    return { result, repos: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('wait-run defaults to the repository of its own checkout', () => {
  const { result, repos } = run({ WAIT_RUN_REPO: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(repos.length > 0);
  for (const repo of repos) assert.equal(repo, `from/${path.basename(__dirname)}`);
});

test('wait-run stops before polling when it cannot name the repository', () => {
  const { result, repos } = run({ WAIT_RUN_REPO: '', NO_REPO: '1' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /set WAIT_RUN_REPO/);
  assert.deepEqual(repos, []);
});

test('WAIT_RUN_REPO overrides the default', () => {
  const { result, repos } = run({ WAIT_RUN_REPO: 'other/repo' });
  assert.equal(result.status, 0, result.stderr);
  for (const repo of repos) assert.equal(repo, 'other/repo');
});
