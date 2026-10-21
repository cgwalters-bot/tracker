// `just enqueue <issue>... [priority=P1] [--dry-run]` (tracker#838): puts
// each issue on the board agent-board.json's `schedule` names, sets its
// priority (and, when it is new there, Status Todo), then starts poll.yml
// once with the issues as its `items` input, so the next board pass
// considers them first (schedule.cjs's requestedItems). A recipe here, not an
// agent-board subcommand: the `items` input and its bounds are this
// repository's, and so is the board's config. Runs with the operator's own
// gh login; with --dry-run it reads the board and changes nothing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CONFIG_FILE = path.join(__dirname, 'agent-board.json');
const WORKFLOW = 'poll.yml';

const usage = 'usage: just enqueue <issue-url | owner/repo#n>... [priority=P1] [--dry-run]';

function parseArgs(argv, schedule) {
  let priority = 'P1';
  let dryRun = false;
  const refs = new Map();
  for (const arg of argv) {
    if (arg === '--dry-run') { dryRun = true; continue; }
    const p = /^priority=(.+)$/.exec(arg);
    if (p) { priority = p[1]; continue; }
    // Numbers as schedule.cjs's requestedItems takes them.
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d{0,9})\/?$/.exec(arg) ?? /^([\w.-]+\/[\w.-]+)#([1-9]\d{0,9})$/.exec(arg);
    if (!m) throw new Error(`${arg}: not an issue URL or owner/repo#n; ${usage}`);
    const repository = m[1].toLowerCase();
    // Checked here as the poll checks them, so a mistake is said before the
    // board is changed rather than in the run's log.
    if (!schedule.repositories.some(r => r.toLowerCase() === repository)) throw new Error(`${m[1]} is not in schedule.repositories, so the poll would not take it; dispatch it by hand`);
    refs.set(`${repository}#${m[2]}`, { repository, number: Number(m[2]) });
  }
  if (!refs.size) throw new Error(usage);
  if (!schedule.fill) throw new Error('schedule.fill is off, so the poll takes no items; dispatch by hand');
  if (refs.size > schedule.fill) throw new Error(`${refs.size} issues, more than schedule.fill (${schedule.fill ?? 0}), the most one pass takes first`);
  return { refs: [...refs.values()], priority, dryRun };
}

const BOARD_QUERY = `query($owner: String!, $number: Int!, $field: String!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    id
    priority: field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } }
    status: field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
  } } }
}`;

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    id url
    projectItems(first: 100) { nodes { id project { id } } pageInfo { hasNextPage } }
  } }
}`;

const ADD = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;

const SET = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

// `gh api`, with a JSON body on stdin if there is one; `run` is spawnSync, or a test's.
function ghApi(run, args, body) {
  const result = run('gh', ['api', ...args, ...(body ? ['--input', '-'] : [])],
    { input: body ? JSON.stringify(body) : '', encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`gh api ${args.join(' ')}: ${result.error?.message ?? String(result.stderr ?? '').trim().split('\n').at(-1)}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function gql(run, query, variables) {
  const out = ghApi(run, ['graphql'], { query, variables });
  if (out?.errors?.length) throw new Error(`GraphQL: ${out.errors.map(e => e.message).join('; ').slice(0, 500)}`);
  return out.data;
}

const option = (field, name, what) => {
  const found = field?.options?.find(o => o.name === name);
  if (!found) throw new Error(`the board's ${what} field has no option ${name}${field?.options ? ` (it has ${field.options.map(o => o.name).join(', ')})` : ''}`);
  return found.id;
};

async function enqueue(argv, { run = spawnSync, log = console.log, text = fs.readFileSync(CONFIG_FILE, 'utf8') } = {}) {
  const config = JSON.parse(text);
  const s = config.schedule;
  const { refs, priority, dryRun } = parseArgs(argv, s);
  const say = line => log(dryRun ? `[dry-run] ${line}` : line);
  const board = gql(run, BOARD_QUERY, { owner: s.owner, number: s.project, field: s.priorityField ?? 'Priority' }).repositoryOwner?.projectV2;
  if (!board) throw new Error(`board ${s.owner}/${s.project} not readable`);
  // Both looked up before anything is written, so a wrong name changes nothing.
  const priorityOption = option(board.priority, priority, s.priorityField ?? 'Priority');
  const todo = option(board.status, 'Todo', 'Status');
  const set = (item, field, value) => gql(run, SET, { project: board.id, item, field, option: value });  // Every issue is read before the first write, so one not found changes nothing.
  const issues = refs.map(({ repository, number }) => {
    const [owner, name] = repository.split('/');
    const issue = gql(run, ISSUE_QUERY, { owner, name, number }).repository?.issue;
    if (!issue) throw new Error(`${repository}#${number} not found`);
    // An item past the page would be taken for new and have its Status reset.
    if (issue.projectItems.pageInfo?.hasNextPage) throw new Error(`${issue.url} is on too many boards to tell whether it is on this one`);
    return issue;
  });
  for (const issue of issues) {
    const on = issue.projectItems.nodes.find(i => i.project.id === board.id);
    if (on) {
      if (!dryRun) set(on.id, board.priority.id, priorityOption);
      say(`${issue.url}: on the board already; Priority ${priority}`);
      continue;
    }
    if (!dryRun) {
      const item = gql(run, ADD, { project: board.id, content: issue.id }).addProjectV2ItemById.item.id;
      set(item, board.priority.id, priorityOption);
      set(item, board.status.id, todo);
    }
    say(`${issue.url}: added to the board; Priority ${priority}, Status Todo`);
  }
  const items = refs.map(r => `${r.repository}#${r.number}`).join(' ');
  const repo = config.dispatchRepo;
  if (dryRun) { say(`would start ${WORKFLOW} in ${repo} with items: ${items}`); return; }
  const { default_branch: ref } = ghApi(run, [`repos/${repo}`]);
  const at = [`repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, '--method', 'POST'];
  const body = { ref, inputs: { items } };
  let started;
  try {
    started = ghApi(run, at, { ...body, return_run_details: true });
  } catch (err) {
    // As schedule.cjs: where the API does not know return_run_details.
    if (!/HTTP 422/.test(err.message)) throw err;
    started = ghApi(run, at, body);
  }
  say(`started ${WORKFLOW} with items: ${items}; ${started?.html_url ?? `https://github.com/${repo}/actions/workflows/${WORKFLOW}`}`);
}

module.exports = { enqueue, parseArgs };

if (require.main === module) {
  enqueue(process.argv.slice(2)).catch(err => { console.error(`enqueue: ${err.message}`); process.exitCode = 1; });
}
