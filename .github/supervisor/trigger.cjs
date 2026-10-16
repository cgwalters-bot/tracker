'use strict';

// Whether the supervisor's agent runs on this pass, and its task. It runs on
// a failing check or on the daily pass, never on warnings alone. A failure
// that persists (a lagging pin, a broker outage) fails every fifteen-minute
// pass, so after an agent run the next waits `agent.cooldownHours` unless it
// is the daily one: without that, one stuck check spends a run per pass.
const fs = require('node:fs');
const crypto = require('node:crypto');
const settings = require('../poll/agent-board.json');
const pools = require('../agentic-job/pools.json');
const config = require('./config.json');
const { policyFrom } = require('./actions.cjs');
const { client } = require('./execute.cjs');

const MAX_TASK_BYTES = 48 * 1024; // The wrapper's 64 KiB includes the issue text.

// Any other run of this workflow, started inside the cooldown or still
// running, whose agent call ran. A skipped call is one job named `agent`; a
// call that ran has jobs named `agent / ...`.
async function recentAgent(get, repo, runId, now, hours) {
  const since = new Date(now - hours * 3600000).toISOString();
  const base = `/repos/${repo}/actions/workflows/supervisor.yml/runs?per_page=100`;
  const runs = new Map();
  for (const query of [`&created=%3E%3D${since}`, '&status=in_progress']) {
    for (const run of (await get(base + query)).workflow_runs) runs.set(run.id, run);
  }
  runs.delete(runId);
  for (const run of runs.values()) {
    const { jobs } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    if (jobs.some(j => j.name.startsWith('agent / ') || (j.name === 'agent' && j.conclusion !== 'skipped'))) return true;
  }
  return false;
}

async function decide(checks, { daily, policy, recent }) {
  if (!policy) return { act: false, reason: 'the requests and log issues are not configured' };
  const failing = checks.filter(c => c.status === 'fail').map(c => c.id);
  // The daily pass skips the cooldown, but not an agent still running.
  if (daily) return await recent(0) ? { act: false, reason: 'the daily pass; an agent is still running' } : { act: true, reason: 'the daily pass' };
  if (!failing.length) return { act: false, reason: 'no check fails' };
  if (await recent(config.agent.cooldownHours)) return { act: false, reason: `${failing.join(', ')} failing; an agent ran within the cooldown` };
  return { act: true, reason: `${failing.join(', ')} failing` };
}

function compose(playbook, checks, policy, reason) {
  const { organization, repositories, log, variables, kinds, pools: names } = policy;
  const task = `${playbook}\n## This pass\n\nWhy you run: ${reason}.\n\nPolicy:\n\n\`\`\`json\n${
    JSON.stringify({ organization, repositories, log, variables, kinds, pools: names }, null, 2)}\n\`\`\`\n\nHealth report:\n\n\`\`\`json\n${
    JSON.stringify(checks, null, 2)}\n\`\`\`\n`;
  if (Buffer.byteLength(task) > MAX_TASK_BYTES) throw new Error('supervisor task too large');
  return task;
}

async function main() {
  const checks = JSON.parse(fs.readFileSync('health.json', 'utf8'));
  const policy = policyFrom(config, settings, pools);
  const get = path => client(process.env.GH_TOKEN)('GET', path);
  const repo = process.env.GITHUB_REPOSITORY;
  const { act, reason } = await decide(checks, {
    daily: process.env.DAILY === 'true', policy,
    recent: hours => recentAgent(get, repo, Number(process.env.GITHUB_RUN_ID), Date.now(), hours),
  });
  const out = [`act=${act}`];
  if (act) {
    const pool = pools[config.agent.pool];
    const task = compose(fs.readFileSync(`${__dirname}/playbook.md`, 'utf8'), checks, policy, reason);
    const delimiter = `task-${crypto.randomBytes(16).toString('hex')}`;
    out.push(`repo=${policy.requests.repository}`, `item=${policy.requests.issue}`,
      `agent=${pool.agent}`, `model=${pool.model}`, `budget=${pool.budget}`, `task<<${delimiter}`, task, delimiter);
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `agent: ${act ? 'runs' : 'skipped'}, ${reason}\n`);
}

module.exports = { compose, decide, recentAgent };

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
