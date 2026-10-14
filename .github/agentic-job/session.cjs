'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

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

function main() {
  // The workflow gates checkout on the default branch; the wrapper repeats it.
  const root = '.github/agentic-job/';
  const result = compose(JSON.parse(fs.readFileSync(`${root}session.json`)),
    JSON.parse(fs.readFileSync(`${root}pools.json`)),
    fs.readFileSync(`${root}profiles/session.md`, 'utf8'),
    { pool: process.env.POOL, idle: process.env.IDLE, prompt: process.env.PROMPT });
  const delimiter = `session-${crypto.randomBytes(16).toString('hex')}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result)
    .map(([key, value]) => `${key}<<${delimiter}\n${value}\n${delimiter}\n`).join(''));
}

module.exports = { compose };
if (require.main === module) main();
