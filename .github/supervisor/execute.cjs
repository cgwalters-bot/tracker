'use strict';

// The executor: the only job of supervisor.yml with the bot's token. It reads
// the agent's one comment, which apply posted from this run's checked safe
// outputs, and performs the typed requests in it. The agent may have read
// prompt-injected text, so its requests are data: the whole batch is
// validated (actions.cjs), then every target is read and checked, and only
// then is anything written. Each action is one line with a link in the log.
const fs = require('node:fs');
const settings = require('../poll/agent-board.json');
const pools = require('../agentic-job/pools.json');
const config = require('./config.json');
const { MARKER, record } = require('../poll/coordinator.cjs');
const { validateBatch, policyFrom } = require('./actions.cjs');

const BLOCK = 'supervisor-actions';

function client(token, timeoutMs = 20000) {
  return async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'tracker-supervisor' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status: a response body could echo text into the public log.
    if (!response.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

// The comment must be on the configured requests issue; result-url is this
// run's own apply output, so a comment elsewhere is not the agent's.
function requestComment(url, policy) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)#issuecomment-([1-9]\d*)$/.exec(url ?? '');
  if (!match || match[1] !== policy.requests.repository || Number(match[2]) !== policy.requests.issue) {
    throw new Error('The result is not a comment on the supervisor requests issue');
  }
  return Number(match[3]);
}

// The JSON Lines of the one block; none means the agent asked for nothing.
function extract(body) {
  const blocks = [...(body ?? '').matchAll(new RegExp('^```' + BLOCK + '[ \\t]*\\r?\\n([\\s\\S]*?)^```\\s*$', 'gm'))];
  if (blocks.length > 1) throw new Error(`More than one ${BLOCK} block`);
  return blocks.length ? blocks[0][1].replace(/\r/g, '') : '';
}

const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;

// Reads only. Returns what perform needs, or throws on a target of the wrong
// type or owner: the schema says a number is positive, not what it names.
async function preflight(api, policy, r) {
  const { repository: repo } = r;
  switch (r.action) {
    case 'rerun': case 'cancel': {
      const run = await api('GET', `/repos/${repo}/actions/runs/${r.run}`);
      // A re-run of the supervisor's own executor would replay its batch.
      if (typeof run.path !== 'string' || run.path.startsWith('.github/workflows/supervisor.yml')) throw new Error('Not the supervisor\'s own runs');
      if (r.action === 'rerun' && !['.github/workflows/poll.yml', '.github/workflows/broker-probe.yml'].includes(run.path)) {
        throw new Error('Only poll and broker probe runs may be rerun');
      }
      return { link: run.html_url };
    }
    case 'dequeue': {
      const pull = await api('GET', `/repos/${repo}/pulls/${r.item}`);
      if (pull.state !== 'open') throw new Error('Not an open pull request');
      return { link: pull.html_url, node: pull.node_id };
    }
    case 'set_variable':
      // The allowlisted variables are the dispatch repository's own switches.
      if (repo !== policy.dispatchRepo) throw new Error('Variables are set only on the dispatch repository');
      return { link: `https://github.com/${repo}/settings/variables/actions` };
    case 'reset_checkpoint': {
      if (repo !== policy.epicsRepository) throw new Error('Checkpoints are only in the epics repository');
      const comment = await api('GET', `/repos/${repo}/issues/comments/${r.comment}`);
      if (comment.user?.login !== policy.bot || !comment.body?.startsWith(`<!-- ${MARKER}: `)) {
        throw new Error('Not a coordinator checkpoint');
      }
      // Deleting it clears the whole record, not only the failure count: with
      // a run in flight the coordinator would start another one.
      if (record([{ author: comment.user, body: comment.body, databaseId: comment.id }], policy.bot).state.pending) throw new Error('The checkpoint has a pending operation');
      return { link: comment.html_url };
    }
    case 'edit_log': {
      const issue = await api('GET', `/repos/${repo}/issues/${r.item}`);
      if (issue.user?.login !== policy.bot) throw new Error('The log issue is not the bot\'s');
      return { link: issue.html_url };
    }
    default: {
      const issue = await api('GET', `/repos/${repo}/issues/${r.item}`);
      return { link: issue.html_url };
    }
  }
}

async function perform(api, policy, r, target, ctx) {
  const { repository: repo } = r;
  const signed = text => `${text}\n\n<sub>Supervisor run: ${ctx.runUrl}</sub>`;
  const graphql = async (query, variables) => {
    const result = await api('POST', '/graphql', { query, variables });
    if (result?.errors?.length) throw new Error('GraphQL error');
  };
  switch (r.action) {
    case 'rerun': return api('POST', `/repos/${repo}/actions/runs/${r.run}/rerun-failed-jobs`);
    case 'cancel': return api('POST', `/repos/${repo}/actions/runs/${r.run}/cancel`);
    case 'dequeue':
      return graphql('mutation($id: ID!) { dequeuePullRequest(input: {id: $id}) { clientMutationId } }', { id: target.node });
    case 'set_variable': return api('PATCH', `/repos/${repo}/actions/variables/${r.name}`, { name: r.name, value: r.value });
    case 'reset_checkpoint': return api('DELETE', `/repos/${repo}/issues/comments/${r.comment}`);
    case 'comment': return api('POST', `/repos/${repo}/issues/${r.item}/comments`, { body: signed(r.body) });
    case 'edit_log': return api('PATCH', `/repos/${repo}/issues/${r.item}`, { body: r.body });
  }
  throw new Error('Unknown supervisor action');
}

// The line names the action and its target, never the agent's free text.
function describe(r) {
  const target = r.run ? `run ${r.run}` : r.comment ? `comment ${r.comment}` : r.item ? `#${r.item}` :
    `${r.name}=${JSON.stringify(r.value)}`;
  const extra = r.action === 'dispatch' ? ` (${r.kind}, ${r.pool})` : r.label ? ` \`${r.label.replace(/`/g, '')}\`` : '';
  return `\`${r.action}\` ${r.repository} ${target}${extra}`;
}

async function execute({ api, policy, resultUrl, runUrl, defaultBranch, attempt }) {
  const lines = [];
  let requests;
  let targets;
  try {
    // A re-run would perform the same batch again, possibly long after the
    // pass that asked for it; the next scheduled pass asks afresh instead.
    if (attempt !== 1) throw new Error('Only a run\'s first attempt executes');
    const id = requestComment(resultUrl, policy);
    const comment = await api('GET', `/repos/${policy.requests.repository}/issues/comments/${id}`);
    // Anyone who can edit the bot's comment must not choose the batch.
    if (comment.user?.login !== policy.bot || comment.updated_at !== comment.created_at) {
      throw new Error('The requests comment is not the bot\'s as posted');
    }
    requests = validateBatch(extract(comment.body), policy);
    targets = [];
    for (const r of requests) targets.push(await preflight(api, policy, r));
  } catch (err) {
    // A parse error quotes its input; the other messages are fixed text.
    const reason = err instanceof SyntaxError ? 'Malformed JSON Lines' : err.message;
    return { ok: false, lines: [`- refused the whole batch: ${reason}`] };
  }
  let ok = true;
  for (const [i, r] of requests.entries()) {
    if (!ok) { lines.push(`- ${describe(r)}: not attempted`); continue; }
    try {
      await perform(api, policy, r, targets[i], { runUrl, defaultBranch });
      lines.push(`- ${describe(r)}: done, ${targets[i].link}`);
    } catch (err) {
      // Stop at the first failure: later requests may assume earlier ones.
      ok = false;
      lines.push(`- ${describe(r)}: failed (${err.message}), ${targets[i].link}`);
    }
  }
  return { ok, lines };
}

async function main() {
  const policy = policyFrom(config, settings, pools);
  if (!policy) throw new Error('supervisor: the requests and log issues are not configured');
  const api = client(process.env.GH_TOKEN);
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const resultUrl = process.env.RESULT_URL;
  const { ok, lines } = await execute({
    api, policy, resultUrl, runUrl, defaultBranch: process.env.DEFAULT_BRANCH, attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  let requests = 'requests';
  try { requestComment(resultUrl, policy); requests = `[requests](${resultUrl})`; } catch { /* named in the lines */ }
  const body = [`Supervisor [run](${runUrl}), ${requests}:`, ...(lines.length ? lines : ['- no action requested'])].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
  console.log(body);
  await api('POST', `/repos/${policy.log.repository}/issues/${policy.log.issue}/comments`, { body });
  if (!ok) process.exitCode = 1;
}

module.exports = { client, execute, extract, requestComment };

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
