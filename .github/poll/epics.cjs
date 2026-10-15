#!/usr/bin/env node
// The epic census (cgwalters-forge/tracker#572, its first slice): what the
// coordinator will plan from, read and summarized, with nothing written.
// The operator owns epics: an open issue labelled `epic` in
// `epics.repository` of agent-board.json is live only if the operator
// applied that label, as its timeline says, since anyone who can triage can
// label an issue, the bot included, and a coordinator must not plan from an
// epic the operator never made. For each live epic it reads the sub-issues
// with their board Status and Priority, counts the operator's comments
// (those that carry intent), and prints a fingerprint that changes when any
// of that does, so that a later slice can do nothing when nothing changed.
// Standard library only; the helpers above `main` are pure and are what
// epics.test.cjs covers. The output is the markdown for the job summary.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./poll.cjs');
const { loadConfig } = require('./schedule.cjs');

const CONFIG_FILE = path.join(__dirname, 'agent-board.json');
const LABEL = 'epic';
// Bounds on one census, which shares the bot token's budget with the
// scheduler: past these it says so rather than read on.
const MAX_EPICS = 50;
const BOARD_PAGES = 50;
const COMMENT_PAGES = 20;
// Pages of 100 for each REST listing: an epic's timeline, its sub-issues
// (GitHub allows 100 to a parent) and the open epics themselves.
const REST_PAGES = 20;

const lower = s => String(s ?? '').toLowerCase();

// The schedule config, with the repository whose `epic` issues are read.
function loadEpicsConfig(text) {
  const config = loadConfig(text);
  const repository = JSON.parse(text).epics?.repository;
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('agent-board.json: epics.repository must name OWNER/REPO');
  }
  return { ...config, epicsRepository: repository };
}

// Whether the `epic` label stands as the operator applied it: the newest
// labeled or unlabeled event for it decides, so the operator re-applying
// it after the bot makes an epic live, and anyone removing it after the
// operator does not. { live: true } or { live: false, why }.
function provenance(timeline, operator) {
  const last = timeline.filter(e => (e.event === 'labeled' || e.event === 'unlabeled') && lower(e.label?.name) === LABEL).at(-1);
  const who = last?.actor?.login ?? 'an unknown account';
  if (!last) return { live: false, why: 'no labelled event in its timeline' };
  if (last.event === 'unlabeled') return { live: false, why: `unlabelled by ${who}` };
  if (lower(last.actor?.login) !== lower(operator)) return { live: false, why: `labelled by ${who}, not the operator` };
  return { live: true };
}

// The operator's comments that count, by agent-board's rule for plans
// (board-forge's plan.rs, newest_plan): written by the operator and, if
// edited at all, last edited by the operator, as GitHub lets anyone with
// write access edit a comment. An edit GitHub cannot name the editor of
// does not count as the operator's. `comments` are GraphQL nodes.
function operatorComments(comments, operator) {
  const is = actor => actor?.login !== undefined && lower(actor.login) === lower(operator);
  return comments.filter(c => is(c.author) && !((c.lastEditedAt || c.editor) && !is(c.editor)))
    .map(c => ({ id: String(c.databaseId), updated_at: c.updatedAt, body: c.body ?? '' }));
}

// OWNER/REPO of a REST issue, from its repository_url.
const repoOf = issue => /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? '')?.[1] ?? 'unknown';

// One sub-issue as the census keeps it: its board fields come from
// `board`, a Map from lower-cased issue URL to { status, priority }.
function subIssue(issue, board, followed) {
  const repository = repoOf(issue);
  const on = board.get(lower(issue.html_url));
  return {
    ...(typeof issue.title === 'string' ? { title: issue.title, body: issue.body ?? '' } : {}),
    number: issue.number, repository, state: issue.state, updated_at: issue.updated_at,
    url: issue.html_url, created: issue.created_at,
    status: on?.status ?? null, priority: on?.priority ?? null, onBoard: Boolean(on),
    followed: followed.has(lower(repository)),
  };
}

// JSON with object keys sorted, so that equal values hash equally.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// What a coordinator would act on, hashed: the epic's updated_at, the
// counted comments and each sub-issue's place and board fields, every list
// sorted, so that the order GitHub returns them in does not matter.
function fingerprint(epic, comments, subs) {
  const byKey = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const sorted = (list, key) => list.map(v => ({ k: key(v), v })).sort(byKey).map(x => x.v);
  const doc = {
    updated_at: epic.updated_at,
    comments: sorted(comments.map(c => ({ id: c.id, updated_at: c.updated_at })), c => c.id.padStart(20, '0')),
    sub_issues: sorted(subs.map(s => ({ number: s.number, repository: lower(s.repository), state: s.state, status: s.status, priority: s.priority })),
      s => `${s.repository}#${String(s.number).padStart(12, '0')}`),
  };
  return crypto.createHash('sha256').update(canonical(doc)).digest('hex');
}

// The summary's line for one epic. Titles are left out: they are anyone's
// text, and the summary is markdown.
function summaryLine(repository, entry) {
  const name = `${repository}#${entry.number}`;
  if (entry.error) return `- ${name}: could not be read: ${escape(entry.error)}`;
  if (!entry.live) return `- ${name}: not live, ${escape(entry.why)}`;
  const counts = new Map();
  for (const s of entry.subs) {
    const k = s.status ?? 'not on the board';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Status names are the board's settings, escaped as any outside text.
  const statuses = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${escape(k)} ${n}`).join(', ');
  const outside = entry.subs.filter(s => !s.followed).length;
  return `- ${name}: live; ${entry.subs.length} sub-issue(s)${statuses ? ` (${statuses})` : ''}`
    + `${outside ? `, ${outside} outside the scheduled repositories` : ''}`
    + `; ${entry.comments.length} operator comment(s); fingerprint \`${entry.fingerprint}\``;
}

// Error text may quote an API response; it must not make markup.
const escape = s => String(s).replace(/[&<>`[\]*_|\\]/g, c => `&#${c.charCodeAt(0)};`).replace(/\s+/g, ' ').slice(0, 500);

function summary(repository, entries, note) {
  const lines = ['### Epics', ''];
  if (!entries.length) lines.push(`No open issue labelled \`${LABEL}\` in ${repository}.`);
  lines.push(...entries.map(e => summaryLine(repository, e)));
  if (note) lines.push('', note);
  return lines.join('\n');
}

// poll.cjs's `paged`, with a bound: past `pages` pages it throws.
async function pagedUpTo(get, path, pages = REST_PAGES) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const items = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`${path}: more than ${pages * 100} entries`);
}

// Every issue's Status and Priority on the board, by lower-cased URL.
const BOARD_QUERY = `query($owner: String!, $number: Int!, $priority: String!, $cursor: String) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    items(first: 100, after: $cursor) {
      nodes {
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        priority: fieldValueByName(name: $priority) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content { ... on Issue { url } }
      }
      pageInfo { hasNextPage endCursor }
    }
  } } }
}`;

// A page may come back with errors beside its data, for an item the token
// cannot read: they are kept, and an epic with a sub-issue not found on the
// board is then not fingerprinted, since that sub-issue may be one of them.
async function readBoard(post, config) {
  const board = new Map();
  const errors = new Set();
  let cursor = null;
  for (let page = 0; page < BOARD_PAGES; page++) {
    const out = await post({ query: BOARD_QUERY, variables: { owner: config.owner, number: config.project, priority: config.priorityField, cursor } });
    const items = out.data?.repositoryOwner?.projectV2?.items;
    if (!items) throw new Error(`board ${config.owner}/${config.project} not readable: ${(out.errors ?? []).map(e => e.message).join('; ')}`);
    for (const e of out.errors ?? []) errors.add(e.message);
    for (const n of items.nodes) {
      if (n?.content?.url) board.set(lower(n.content.url), { status: n.status?.name ?? null, priority: n.priority?.name ?? null });
    }
    if (!items.pageInfo.hasNextPage) return { board, errors: [...errors] };
    cursor = items.pageInfo.endCursor;
  }
  throw new Error(`board ${config.owner}/${config.project} has more than ${BOARD_PAGES * 100} items`);
}

// REST does not say who last edited a comment; GraphQL does.
const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    comments(first: 100, after: $cursor) {
      nodes { databaseId updatedAt lastEditedAt body author { login } editor { login } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;

async function readComments(post, repository, number) {
  const [owner, name] = repository.split('/');
  const all = [];
  let cursor = null;
  for (let page = 0; page < COMMENT_PAGES; page++) {
    const out = await post({ query: COMMENTS_QUERY, variables: { owner, name, number, cursor } });
    const comments = out.data?.repository?.issue?.comments;
    // A partial page would leave out comments, and so change the count.
    if (!comments || out.errors?.length) throw new Error(`comments not readable: ${(out.errors ?? []).map(e => e.message).join('; ')}`);
    all.push(...comments.nodes);
    if (!comments.pageInfo.hasNextPage) return all;
    cursor = comments.pageInfo.endCursor;
  }
  throw new Error(`more than ${COMMENT_PAGES * 100} comments`);
}

// One census: an entry for each open epic read, as summaryLine takes it,
// and a note when there were more than it reads. A live epic's entry has
// its own board Priority too, which the scheduler orders its sub-issues by.
// `get` and `post` are the REST and GraphQL requests.
async function census(get, post, config) {
  const repo = config.epicsRepository;
  const open = (await pagedUpTo(get, `/repos/${repo}/issues?state=open&labels=${LABEL}`))
    .filter(i => !i.pull_request).sort((a, b) => a.number - b.number);
  const epics = open.slice(0, MAX_EPICS);
  const note = open.length > MAX_EPICS ? `${open.length - MAX_EPICS} more epic(s) not read: the census reads ${MAX_EPICS}.` : '';
  let boardRead;
  const entries = [];
  for (const epic of epics) {
    const entry = { number: epic.number };
    entries.push(entry);
    try {
      Object.assign(entry, provenance(await pagedUpTo(get, `/repos/${repo}/issues/${epic.number}/timeline`), config.operator));
      if (!entry.live) continue;
      // Read once, when the first epic is live; a failure is kept, not
      // retried for each epic after it.
      const board = await (boardRead ??= readBoard(post, config));
      const subs = (await pagedUpTo(get, `/repos/${repo}/issues/${epic.number}/sub_issues`)).map(i => subIssue(i, board.board, config.followed));
      if (board.errors.length && subs.some(s => !s.onBoard)) throw new Error(`board read errors: ${board.errors.slice(0, 5).join('; ')}`);
      const comments = operatorComments(await readComments(post, repo, epic.number), config.operator);
      const priority = board.board.get(lower(epic.html_url))?.priority ?? null;
      Object.assign(entry, { title: epic.title, body: epic.body, priority, subs, comments, fingerprint: fingerprint(epic, comments, subs) });
    } catch (err) {
      // One epic not read is said on its line; the others go on.
      entry.error = err.message;
    }
  }
  return { entries, note };
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required');
  const config = loadEpicsConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const { entries, note } = await census(p => request(token, 'GET', p), body => request(token, 'POST', '/graphql', body), config);
  console.log(summary(config.epicsRepository, entries, note));
}

module.exports = { MAX_EPICS, canonical, census, fingerprint, loadEpicsConfig, main, operatorComments, pagedUpTo, provenance, readBoard, readComments, subIssue, summary, summaryLine };

if (require.main === module) {
  main().catch(err => {
    console.log(`### Epics\n\nThe census failed: ${escape(err.message)}`);
    process.exit(1);
  });
}
