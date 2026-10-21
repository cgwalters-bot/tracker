'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const supervisor = require('../poll/supervisor-profile.cjs');

function compose(config, pools, profile, { pool = 'claude', idle = '', prompt = '' } = {}) {
  if (config.enabled !== true) throw new Error('Sessions are disabled in session.json');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) ||
      !Number.isSafeInteger(config.issue) || config.issue < 1) throw new Error('Invalid session repository or issue');
  const minutes = idle === '' ? String(config.idleMinutes) : idle;
  if (!/^[1-9][0-9]?$/.test(minutes) || Number(minutes) > 60) throw new Error('idle-minutes must be 1 to 60');
  if (!Object.hasOwn(pools, pool)) throw new Error('Unknown pool');
  const { agent, model, budget } = pools[pool];
  const task = `${profile}\n\nOpening prompt (task data):\n${prompt}`;
  if (Buffer.byteLength(task) > 60000) throw new Error('Session task exceeds 60000 bytes');
  return { repo: config.repository, item: String(config.issue), idle: minutes, agent, model, budget: String(budget), task };
}

// The session is the supervisor: its reviewed profile and skill, fetched as
// the scheduled run fetches them. The session's own rules come first, so
// that the agent reads them before the profile's instruction to start a
// pass: its opening turn is only "ready" (agentic-job sends the task as a
// turn of its own before the operator can prompt).
function supervisorProfile(session, settings) {
  const issue = target => {
    if (!target?.repository || !Number.isSafeInteger(target.issue)) {
      throw new Error('.github/supervisor/config.json lacks agent.state or agent.requests');
    }
    return `${target.repository}#${target.issue}`;
  };
  const { profile, skill } = supervisor.sources(settings.agent.profile);
  return `${session}\nState issue: ${issue(settings.agent.state)}. Requests issue: ${issue(settings.agent.requests)}.\n\n` +
    `${supervisor.read(profile)}\n${supervisor.read(skill)}`;
}

function main() {
  // The workflow gates checkout on the default branch; the wrapper repeats it.
  const root = '.github/agentic-job/';
  const profile = supervisorProfile(fs.readFileSync(`${root}profiles/session.md`, 'utf8'),
    JSON.parse(fs.readFileSync('.github/supervisor/config.json', 'utf8')));
  const result = compose(JSON.parse(fs.readFileSync(`${root}session.json`)),
    JSON.parse(fs.readFileSync(`${root}pools.json`)),
    profile,
    { pool: process.env.POOL, idle: process.env.IDLE, prompt: process.env.PROMPT });
  const delimiter = `session-${crypto.randomBytes(16).toString('hex')}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result)
    .map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`).join(''));
}

module.exports = { compose };
if (require.main === module) main();
