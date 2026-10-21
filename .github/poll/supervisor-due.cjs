const fs = require('node:fs');
const path = require('node:path');

// GitHub's cron started one supervisor run in two hours on 17 Oct while the
// poll, which chains itself, ran every few minutes (#730). So supervisor.yml
// also starts at the end of each poll run, and paces itself here from the
// times the previous health artifact carries, not from which cron fired.
const HEALTH_MS = 15 * 60 * 1000;
const SWEEP_MS = 2 * 60 * 60 * 1000;

// A missing, unreadable or future time is no previous pass: due.
function since(at, now) {
  const time = Date.parse(at);
  return Number.isFinite(time) && time <= now ? now - time : Infinity;
}

// health: whether this run takes a health pass; only the poll's chain is
// rate-limited, since it fires every few minutes and the crons are only a
// fallback. The chain is workflow_run and the dispatch without a prompt that
// every poll pass makes (#763); its empty prompt asks for nothing explicit.
// daily: whether the trigger bypasses the failure cooldown, for an
// explicit request or a sweep that is due, the last one two hours ago.
// read: whether the previous report could be looked up at all. If not (a
// rate-limited job token, an API error), the times are unknown rather than
// absent, and taking them as no previous pass would make every chained run
// a sweep with no cooldown (#814); the chain waits, the crons take health
// passes and only explicit requests bypass the cooldown.
function due(event, previous, now, prompt = '', read = true) {
  const chain = event === 'workflow_run' || (event === 'workflow_dispatch' && prompt === '');
  const explicit = !chain && (event === 'workflow_dispatch' || event === 'issue_comment');
  const health = !chain || (read && since(previous.health, now) >= HEALTH_MS);
  const daily = health && (explicit || (read && since(previous.sweep, now) >= SWEEP_MS));
  const stamp = new Date(now).toISOString();
  return {
    health,
    daily,
    times: { health: health ? stamp : previous.health ?? null, sweep: daily ? stamp : previous.sweep ?? null },
  };
}

function main() {
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'previous-health/times.json'), 'utf8')) ?? {};
  } catch {}
  const result = due(process.env.EVENT, previous, Date.now(), process.env.PROMPT ?? '', process.env.READ === 'true');
  // Uploaded beside health.json, so the next run reads both from one artifact.
  fs.writeFileSync('times.json', `${JSON.stringify(result.times)}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `health=${result.health}\ndaily=${result.daily}\n`);
}

if (require.main === module) main();

module.exports = { due };
