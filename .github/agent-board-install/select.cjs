// Bound discovery to 100 commits/runs and at most 30 artifact listings. Exact
// installs never select a moving ref. API failures are not absence/fallback.
const { execFileSync } = require('node:child_process');
const repo = 'cgwalters-forge/agent-board';
const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`],
  { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 }));

function select(revision, branch = 'main') {
  if (revision !== 'latest' && !/^[a-f0-9]{40}$/.test(revision)) throw Error('expected pinned revision');
  const query = `branch=${encodeURIComponent(branch)}&event=push&status=success&per_page=100`;
  const runs = api(`actions/workflows/ci.yml/runs?${query}${revision === 'latest' ? '' : `&head_sha=${revision}`}`).workflow_runs;
  const commits = revision === 'latest' ? api(`commits?sha=${encodeURIComponent(branch)}&per_page=100`).map(c => c.sha) : [revision];
  let listings = 0;
  for (const sha of commits) {
    for (const run of runs.filter(r => r.head_sha === sha && r.head_branch === branch && r.event === 'push'
      && r.status === 'completed' && r.conclusion === 'success' && r.path === '.github/workflows/ci.yml')) {
      if (++listings > 30) throw Error('agent-board artifact discovery exceeded 30 runs');
      if (!Number.isSafeInteger(run.id) || run.id <= 0) throw Error('invalid CI run id');
      // A PR artifact must never become code run with the bot's write token.
      const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`).artifacts
        .filter(a => a.name === 'agent-board-main' && a.expired === false);
      if (artifacts.length > 1) throw Error('ambiguous agent-board-main artifact');
      if (artifacts.length === 1) return { sha, run: run.id };
    }
  }
  return null;
}

if (require.main === module) {
  try { console.log(JSON.stringify(select(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { select };
