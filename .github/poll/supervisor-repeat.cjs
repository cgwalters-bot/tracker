const fs = require('node:fs');
const path = require('node:path');

// A check that cannot clear (a probe switched off, a pin waiting on a
// review) fails every pass, so the trigger started an agent every cooldown
// hour to read the same report (#804). With agent.skipUnchangedFailures, a
// pass that is not a sweep goes to the trigger only when a check fails that
// did not fail in the previous pass's report. Ids, not evidence: some
// evidence (idle's latest poll runs) changes every pass. What this holds
// back, new evidence on a failing check or a new failure that arrived
// during a cooldown, the sweep reads within two hours.

function failing(report) {
  return new Set((Array.isArray(report) ? report : [])
    .filter(check => check?.status === 'fail' && typeof check.id === 'string')
    .map(check => check.id));
}

// skip: whether the trigger is left out on this pass. Off unless enabled;
// never on a sweep or explicit request (daily), nor without two readable
// reports: a report this cannot read is left to the trigger, which
// decides from it as it did before.
function repeat(enabled, daily, current, previous) {
  const before = failing(previous);
  const fresh = [...failing(current)].filter(id => !before.has(id));
  const readable = Array.isArray(current) && Array.isArray(previous);
  return { skip: enabled === true && !daily && readable && fresh.length === 0, fresh };
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function main() {
  const config = read('.github/supervisor/config.json');
  const current = read('health.json');
  const previous = read(path.join(process.env.RUNNER_TEMP, 'previous-health/health.json'));
  const result = repeat(config?.agent?.skipUnchangedFailures, process.env.DAILY === '--daily', current, previous);
  if (result.skip) {
    const still = [...failing(current)].join(', ') || 'no check';
    console.log(`${still} failing as in the previous pass; the sweep reads them`);
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip}\n`);
}

if (require.main === module) main();

module.exports = { repeat };
