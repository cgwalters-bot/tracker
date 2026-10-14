// node --test .github/poll/epics.test.cjs
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { canonical, fingerprint, loadEpicsConfig, main, operatorComments, pagedUpTo, provenance, readBoard, readComments, subIssue, summary } = require('./epics.cjs');

const OP = 'cgwalters';
const BOT = 'cgwalters-bot';
const ev = (event, login, label = 'epic') => ({ event, actor: { login }, label: { name: label } });

test('the repository config names the repository of epics', () => {
  const config = loadEpicsConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  assert.match(config.epicsRepository, /^[\w.-]+\/[\w.-]+$/);
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  for (const epics of [undefined, {}, { repository: 'tracker' }, { repository: 'o/t/x' }, { repository: 'o/t; x' }]) {
    assert.throws(() => loadEpicsConfig(JSON.stringify({ ...all, epics })), /epics.repository/);
  }
});

test('an epic is live only if the operator applied its label last', () => {
  const cases = [
    [[ev('labeled', BOT)], { live: false, why: `labelled by ${BOT}, not the operator` }],
    [[ev('labeled', OP)], { live: true }],
    // Logins compare without case.
    [[ev('labeled', 'CGWalters')], { live: true }],
    // The operator confirms a bot's epic by applying the label again.
    [[ev('labeled', BOT), ev('unlabeled', OP), ev('labeled', OP)], { live: true }],
    [[ev('labeled', OP), ev('unlabeled', BOT)], { live: false, why: `unlabelled by ${BOT}` }],
    [[ev('labeled', OP), ev('unlabeled', OP), ev('labeled', BOT)], { live: false, why: `labelled by ${BOT}, not the operator` }],
    // Other labels and events do not count.
    [[ev('labeled', OP), ev('labeled', BOT, 'bug'), { event: 'commented', actor: { login: BOT } }], { live: true }],
    [[ev('labeled', OP, 'Epic')], { live: true }],
    [[ev('labeled', BOT, 'bug')], { live: false, why: 'no labelled event in its timeline' }],
    [[{ event: 'labeled', actor: null, label: { name: 'epic' } }], { live: false, why: 'labelled by an unknown account, not the operator' }],
  ];
  for (const [timeline, expected] of cases) assert.deepEqual(provenance(timeline, OP), expected, JSON.stringify(timeline));
});

test('only the operator\'s comments, last edited by the operator, count', () => {
  const c = (id, author, extra = {}) => ({ databaseId: id, updatedAt: `2026-10-1${id}T00:00:00Z`, lastEditedAt: null, author: author && { login: author }, editor: null, ...extra });
  const comments = [
    c(1, OP),
    c(2, BOT),
    c(3, 'someone'),
    c(4, OP, { lastEditedAt: '2026-10-14T00:00:00Z', editor: { login: OP } }),
    c(5, OP, { lastEditedAt: '2026-10-14T00:00:00Z', editor: { login: BOT } }),
    // An edit GitHub cannot name the editor of is not the operator's.
    c(6, OP, { lastEditedAt: '2026-10-14T00:00:00Z', editor: null }),
    c(7, null),
    c(8, 'CGWALTERS'),
  ];
  assert.deepEqual(operatorComments(comments, OP).map(x => x.id), ['1', '4', '8']);
  assert.deepEqual(operatorComments([c(1, OP)], OP), [{ id: '1', updated_at: '2026-10-11T00:00:00Z' }]);
});

const epic = { updated_at: '2026-10-14T00:00:00Z' };
const comments = [{ id: '10', updated_at: '2026-10-13T00:00:00Z' }, { id: '9', updated_at: '2026-10-12T00:00:00Z' }];
const subs = [
  { number: 2, repository: 'o/r', state: 'open', status: 'Ready', priority: 'P1', updated_at: 'x', followed: true },
  { number: 1, repository: 'o/r', state: 'closed', status: 'Done', priority: null, updated_at: 'y', followed: true },
  { number: 1, repository: 'up/stream', state: 'open', status: null, priority: null, updated_at: 'z', followed: false },
];

test('the fingerprint does not depend on order', () => {
  const base = fingerprint(epic, comments, subs);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint(epic, [...comments].reverse(), [...subs].reverse()), base);
  assert.equal(fingerprint(epic, comments, [subs[2], subs[0], subs[1]]), base);
  // Fields outside it, and the repository's case, leave it as it is.
  assert.equal(fingerprint(epic, comments, subs.map(s => ({ ...s, updated_at: 'later', followed: !s.followed }))), base);
  assert.equal(fingerprint(epic, comments, subs.map(s => ({ ...s, repository: s.repository.toUpperCase() }))), base);
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
});

test('the fingerprint changes with each input', () => {
  const base = fingerprint(epic, comments, subs);
  const changed = [
    fingerprint({ updated_at: '2026-10-15T00:00:00Z' }, comments, subs),
    fingerprint(epic, comments.slice(1), subs),
    fingerprint(epic, [{ ...comments[0], updated_at: 'later' }, comments[1]], subs),
    fingerprint(epic, [{ ...comments[0], id: '11' }, comments[1]], subs),
    fingerprint(epic, comments, subs.slice(1)),
  ];
  for (const field of ['number', 'repository', 'state', 'status', 'priority']) {
    changed.push(fingerprint(epic, comments, [{ ...subs[0], [field]: field === 'number' ? 3 : 'other' }, subs[1], subs[2]]));
  }
  for (const f of changed) assert.notEqual(f, base);
  assert.equal(new Set(changed).size, changed.length);
});

test('a sub-issue takes its board fields by URL and its repository from the API', () => {
  const board = new Map([['https://github.com/o/r/issues/2', { status: 'Ready', priority: 'P1' }]]);
  const issue = (repo, n) => ({ number: n, state: 'open', updated_at: 't', html_url: `https://github.com/${repo}/issues/${n}`, repository_url: `https://api.github.com/repos/${repo}` });
  assert.deepEqual(subIssue(issue('O/R', 2), board, new Set(['o/r'])),
    { number: 2, repository: 'O/R', state: 'open', updated_at: 't', url: 'https://github.com/O/R/issues/2', created: undefined, status: 'Ready', priority: 'P1', onBoard: true, followed: true });
  assert.deepEqual(subIssue(issue('up/stream', 2), board, new Set(['o/r'])),
    { number: 2, repository: 'up/stream', state: 'open', updated_at: 't', url: 'https://github.com/up/stream/issues/2', created: undefined, status: null, priority: null, onBoard: false, followed: false });
});

test('the board is read by pages into Status and Priority by URL', async () => {
  const pages = [
    { nodes: [{ status: { name: 'Ready' }, priority: { name: 'P0' }, content: { url: 'https://github.com/O/R/issues/1' } }, { content: null }, { status: {}, content: {} }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [{ status: null, priority: null, content: { url: 'https://github.com/o/r/issues/2' } }], pageInfo: { hasNextPage: false } },
  ];
  const cursors = [];
  const post = async body => { cursors.push(body.variables.cursor); return { data: { repositoryOwner: { projectV2: { items: pages.shift() } } } }; };
  const { board, errors } = await readBoard(post, { owner: 'o', project: 1, priorityField: 'Priority' });
  assert.deepEqual(cursors, [null, 'c1']);
  assert.deepEqual(errors, []);
  assert.deepEqual([...board], [
    ['https://github.com/o/r/issues/1', { status: 'Ready', priority: 'P0' }],
    ['https://github.com/o/r/issues/2', { status: null, priority: null }],
  ]);
  const partial = async () => ({ data: { repositoryOwner: { projectV2: { items: { nodes: [{ content: null }], pageInfo: { hasNextPage: false } } } } }, errors: [{ message: 'hidden' }, { message: 'hidden' }] });
  assert.deepEqual((await readBoard(partial, { owner: 'o', project: 1, priorityField: 'P' })).errors, ['hidden']);
  await assert.rejects(readBoard(async () => ({ errors: [{ message: 'nope' }] }), { owner: 'o', project: 1, priorityField: 'P' }), /not readable: nope/);
});

test('the summary has a line per epic', () => {
  const entries = [
    { number: 1, live: true, subs, comments, fingerprint: 'f'.repeat(64) },
    { number: 2, live: false, why: `labelled by ${BOT}, not the operator` },
    { number: 3, live: false, why: 'unlabelled by someone' },
    { number: 4, error: 'GET /x: HTTP 502 <b>bad</b>' },
    { number: 5, live: true, subs: [], comments: [], fingerprint: 'a'.repeat(64) },
  ];
  assert.equal(summary('o/t', entries, ''), [
    '### Epics',
    '',
    `- o/t#1: live; 3 sub-issue(s) (Done 1, Ready 1, not on the board 1), 1 outside the scheduled repositories; 2 operator comment(s); fingerprint \`${'f'.repeat(64)}\``,
    `- o/t#2: not live, labelled by ${BOT}, not the operator`,
    '- o/t#3: not live, unlabelled by someone',
    '- o/t#4: could not be read: GET /x: HTTP 502 &#60;b&#62;bad&#60;/b&#62;',
    `- o/t#5: live; 0 sub-issue(s); 0 operator comment(s); fingerprint \`${'a'.repeat(64)}\``,
  ].join('\n'));
  assert.equal(summary('o/t', [], 'note'), '### Epics\n\nNo open issue labelled `epic` in o/t.\n\nnote');
});

test('outside text in a line cannot make markup', () => {
  const line = summary('o/t', [
    { number: 1, live: false, why: 'labelled by evil[bot], not the operator' },
    { number: 2, live: true, subs: [{ ...subs[0], status: '<img src=x>`[x](y)' }], comments: [], fingerprint: 'f' },
  ], '');
  assert.match(line, /evil&#91;bot&#93;/);
  assert.match(line, /\(&#60;img src=x&#62;&#96;&#91;x&#93;\(y\) 1\)/);
  assert.doesNotMatch(line, /<img|`\[/);
});

test('comments are read by pages, and stop at the bound', async () => {
  const node = id => ({ databaseId: id, author: { login: OP } });
  const pages = [
    { nodes: [node(1)], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [node(2)], pageInfo: { hasNextPage: false } },
  ];
  const seen = [];
  const post = async body => { seen.push(body.variables); return { data: { repository: { issue: { comments: pages.shift() } } } }; };
  assert.deepEqual((await readComments(post, 'o/t', 7)).map(c => c.databaseId), [1, 2]);
  assert.deepEqual(seen.map(v => [v.owner, v.name, v.number, v.cursor]), [['o', 't', 7, null], ['o', 't', 7, 'c1']]);
  await assert.rejects(readComments(async () => ({ errors: [{ message: 'gone' }] }), 'o/t', 7), /not readable: gone/);
  // A page with errors beside its data may be missing comments.
  const partial = async () => ({ data: { repository: { issue: { comments: { nodes: [node(1)], pageInfo: { hasNextPage: false } } } } }, errors: [{ message: 'one hidden' }] });
  await assert.rejects(readComments(partial, 'o/t', 7), /not readable: one hidden/);
  const endless = async () => ({ data: { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c' } } } } } });
  await assert.rejects(readComments(endless, 'o/t', 7), /more than 2000 comments/);
});

test('REST listings are paged up to a bound', async () => {
  const paths = [];
  const full = Array.from({ length: 100 }, (_, i) => i);
  const get = async p => { paths.push(p); return paths.length < 3 ? full : [1]; };
  assert.equal((await pagedUpTo(get, '/x?a=1')).length, 201);
  assert.deepEqual(paths, ['/x?a=1&per_page=100&page=1', '/x?a=1&per_page=100&page=2', '/x?a=1&per_page=100&page=3']);
  await assert.rejects(pagedUpTo(async () => full, '/y', 2), /\/y: more than 200 entries/);
});

test('a board without end stops the census', async () => {
  const post = async () => ({ data: { repositoryOwner: { projectV2: { items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c' } } } } } });
  await assert.rejects(readBoard(post, { owner: 'o', project: 1, priorityField: 'P' }), /more than 5000 items/);
});

test('a census over a stubbed API reads the board once, and only for live epics', async () => {
  const config = loadEpicsConfig(fs.readFileSync(path.join(__dirname, 'agent-board.json'), 'utf8'));
  const repo = config.epicsRepository;
  const op = config.operator;
  const url = n => `https://github.com/${repo}/issues/${n}`;
  const issue = (n, extra = {}) => ({ number: n, state: 'open', updated_at: 't', html_url: url(n), repository_url: `https://api.github.com/repos/${repo}`, ...extra });
  const rest = {
    [`/repos/${repo}/issues?state=open&labels=epic`]: [issue(3), issue(1), issue(2), issue(9, { pull_request: {} })],
    [`/repos/${repo}/issues/1/timeline`]: [ev('labeled', BOT), ev('labeled', op)],
    [`/repos/${repo}/issues/2/timeline`]: [ev('labeled', BOT)],
    [`/repos/${repo}/issues/3/timeline`]: [ev('labeled', op)],
    [`/repos/${repo}/issues/1/sub_issues`]: [issue(10), issue(11, { state: 'closed' })],
  };
  const calls = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realToken = process.env.GH_TOKEN;
  let out = '';
  globalThis.fetch = async (u, init) => {
    const p = u.replace('https://api.github.com', '');
    calls.push(p);
    let body;
    if (p === '/graphql') {
      const { query } = JSON.parse(init.body);
      body = query.includes('projectV2')
        ? { data: { repositoryOwner: { projectV2: { items: { nodes: [{ status: { name: 'Ready' }, priority: { name: 'P1' }, content: { url: url(10) } }], pageInfo: { hasNextPage: false } } } } } }
        : { data: { repository: { issue: { comments: { nodes: [{ databaseId: 5, updatedAt: 't', author: { login: op } }, { databaseId: 6, updatedAt: 't', author: { login: BOT } }], pageInfo: { hasNextPage: false } } } } } };
    } else {
      const key = p.replace(/[?&]per_page=100&page=1$/, '');
      if (!(key in rest)) return new Response('nope', { status: 404 });
      body = rest[key];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  console.log = line => { out += line; };
  process.env.GH_TOKEN = 'test-token';
  try {
    await main();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    if (realToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = realToken;
  }
  const lines = out.split('\n');
  assert.equal(lines[0], '### Epics');
  assert.match(lines[2], new RegExp(`^- ${repo}#1: live; 2 sub-issue\\(s\\) \\(Ready 1, not on the board 1\\); 1 operator comment\\(s\\); fingerprint \`[0-9a-f]{64}\`$`));
  assert.equal(lines[3], `- ${repo}#2: not live, labelled by ${BOT}, not the operator`);
  // #3 is live, but its sub-issues are not readable here: its line says so, the others stand.
  assert.match(lines[4], new RegExp(`^- ${repo}#3: could not be read: GET /repos/${repo}/issues/3/sub&#95;issues.*HTTP 404 nope$`));
  assert.equal(lines.length, 5);
  // One board read, for both live epics, and #1's comments.
  assert.equal(calls.filter(c => c === '/graphql').length, 2);
  assert.ok(!calls.some(c => c.includes('/issues/9')));
});
