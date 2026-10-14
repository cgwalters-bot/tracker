const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

const config = readFileSync(`${__dirname}/hosted.toml`, 'utf8');
const dispatch = readFileSync(`${__dirname}/../workflows/dispatch.yml`, 'utf8');

// These assertions cover the caller wiring, not TOML parsing or privileged
// installation (which needs agentic-job's next release and a fresh runner).
test('tools opt-in is staged without breaking the deployed v0.2.0 parser', () => {
  assert.doesNotMatch(config, /^\[setup\.tools\]/m,
    'enable only after the shared wrapper upgrades beyond v0.2.0');
  const staged = config.replace(/^# /gm, '');
  const table = staged.split('[setup.tools]\n')[1]?.split(/^\[/m)[0];
  assert.ok(table, 'tools opt-in must be ready in the caller configuration');
  assert.match(table, /^repository = "https:\/\/[^"\s]+"$/m);
  assert.match(table, /^revision = "[0-9a-f]{40}"$/m);
  assert.match(table, /^recipe = "install-tools"$/m);
  assert.doesNotMatch(dispatch, /^\s+(?:config|agent-config):/m,
    'dispatch must retain the wrapper default hosted.toml path');
  assert.doesNotMatch(dispatch, /^\s+(?:tools|tools-repository|tools-revision):/m,
    'dispatchers must not select pre-lockdown setup code');
});

test('installer prerequisites are installed for every target', () => {
  const packages = JSON.parse(config.match(/^packages = (\[[^\n]+\])$/m)[1]);
  for (const tool of ['git', 'just', 'nodejs', 'npm', 'curl', 'tar', 'unzip']) {
    assert.ok(packages.includes(tool), `missing installer prerequisite: ${tool}`);
  }
});
