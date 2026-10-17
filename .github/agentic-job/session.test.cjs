'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { compose } = require('./session.cjs');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const config = { enabled: true, repository: 'owner/tracker', issue: 7, idleMinutes: 10 };
const pools = JSON.parse(read('pools.json'));

test('sessions fail closed until enabled in repository configuration', () => {
  const actual = JSON.parse(read('session.json'));
  assert.equal(typeof actual.enabled, 'boolean');
  assert.throws(() => compose({ ...actual, enabled: false }, pools, 'profile'), /disabled/);
  assert.doesNotThrow(() => compose({ ...actual, enabled: true }, pools, 'profile'));
  const hosted = read('hosted.toml');
  assert.match(hosted, /\[session\]/);
  assert.doesNotMatch(hosted, /listen\s*=\s*true/);
});

test('CLI serializes multiline prompts as data and supplies defaults', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
  try {
    const root = path.join(temp, '.github/agentic-job');
    fs.mkdirSync(path.join(root, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(root, 'pools.json'), JSON.stringify(pools));
    fs.writeFileSync(path.join(root, 'profiles/session.md'), 'profile');
    fs.mkdirSync(path.join(temp, '.github/supervisor'));
    fs.writeFileSync(path.join(temp, '.github/supervisor/config.json'), JSON.stringify({ agent: {
      state: { repository: 'owner/tracker', issue: 8 }, requests: { repository: 'owner/tracker', issue: 9 } } }));
    // A stand-in gh, answering the supervisor fetches by the path they name.
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncase "$2" in\n' +
      '  *profiles/supervisor.md\?ref=*) printf PROFILE ;;\n  *skills/supervisor/SKILL.md\?ref=*) printf SKILL ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o755 });
    const output = path.join(temp, 'output');
    const prompt = 'hello\nitem=999\ntask<<evil\nend';
    const env = { ...process.env, GITHUB_OUTPUT: output, PROMPT: prompt, PATH: `${bin}:${process.env.PATH}` };
    delete env.POOL;
    delete env.IDLE;
    const result = spawnSync(process.execPath, [path.join(__dirname, 'session.cjs')], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(output, 'utf8');
    const delimiter = text.split('\n')[0].split('<<')[1];
    const parsed = {};
    const lines = text.trimEnd().split('\n');
    while (lines.length) {
      const header = lines.shift();
      assert.ok(header.endsWith(`<<${delimiter}`));
      const end = lines.indexOf(delimiter);
      assert.notEqual(end, -1);
      parsed[header.split('<<')[0]] = lines.splice(0, end).join('\n');
      lines.shift();
    }
    const profile = 'profile\nState issue: owner/tracker#8. Requests issue: owner/tracker#9.\n\nPROFILE\nSKILL';
    assert.deepEqual(parsed, compose(config, pools, profile, { prompt }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('configuration fixes the publication issue and default idle; pools are closed', () => {
  const result = compose(config, pools, 'profile');
  assert.equal(result.repo, config.repository);
  assert.equal(result.item, '7');
  assert.equal(result.idle, '10');
  assert.equal(result.agent, pools.claude.agent);
  for (const pool of Object.keys(pools)) assert.equal(compose(config, pools, '', { pool }).model, pools[pool].model);
  for (const pool of ['unknown', '__proto__', 'constructor', '../claude']) {
    assert.throws(() => compose(config, pools, '', { pool }), /Unknown pool/);
  }
});

test('idle wait, target and task are bounded', () => {
  for (const idle of ['0', '61', '-1', '1.5', ' 10', '1\nx=y']) {
    assert.throws(() => compose(config, pools, '', { idle }), /1 to 60/);
  }
  for (const idle of ['1', '60']) assert.equal(compose(config, pools, '', { idle }).idle, idle);
  assert.throws(() => compose({ ...config, idleMinutes: 61 }, pools, ''), /1 to 60/);
  for (const change of [{ repository: 'bad' }, { repository: 'a/b\nx=y' }, { issue: 0 }, { issue: 1.5 }]) {
    assert.throws(() => compose({ ...config, ...change }, pools, ''), /repository or issue/);
  }
  const prompt = 'hello\nrepo=attacker/repo\n${{ secrets.TOKEN }}';
  assert.equal(compose(config, pools, 'profile', { prompt }).task, `profile\n\nOpening prompt (task data):\n${prompt}`);
  assert.throws(() => compose(config, pools, '', { prompt: 'é'.repeat(30000) }), /60000 bytes/);
});

test('workflow uses only configured targets and the wrapper session path', () => {
  const workflow = read('../workflows/session.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /options: \[claude, openai, mistral\]\n\s+default: claude/);
  assert.match(workflow, /if: github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
  assert.match(workflow, /runs-on: ubuntu-26.04/);
  assert.doesNotMatch(workflow, /ubuntu-latest|secrets: inherit|inputs\.(repo|item|operators|origins)/);
  assert.match(workflow, /uses: cgwalters-forge\/actions\/\.github\/workflows\/cgwalters-agentic-job.yml@main/);
  for (const output of ['repo', 'item', 'idle', 'task', 'agent', 'model', 'budget']) {
    assert.ok(workflow.includes(`needs.profile.outputs.${output}`));
  }
  assert.match(workflow, /kind: research/);
  assert.match(workflow, /session: true/);
  assert.match(workflow, /allow: .github\/agentic-job\/dispatch.toml/);
  assert.match(workflow, /config: .github\/agentic-job\/hosted.toml/);
  assert.match(workflow, /run: just session-profile/);
  // The supervisor's profile and skill are fetched with the job's read token.
  assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
  const rules = read('profiles/session.md');
  assert.match(rules, /Keep the working tree clean/);
  // The opening-turn rule leads, ahead of the supervisor's profile.
  assert.match(rules.split('\n\n').slice(0, 2).join('\n'), /first turn: reply "ready"/);
});
