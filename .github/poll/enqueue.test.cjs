'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { enqueue, parseArgs } = require('./enqueue.cjs');

const CONFIG = { dispatchRepo: 'o/tracker', schedule: { owner: 'o', project: 1, fill: 2, priorityField: 'Priority', repositories: ['o/r', 'o/p'] } };
const field = (id, names) => ({ id, options: names.map(name => ({ id: `${id}-${name}`, name })) });
const BOARD = { id: 'PVT', priority: field('PRI', ['P0', 'P1', 'P2']), status: field('ST', ['Todo', 'Done']) };

// A fake `gh api`: #3 of o/r is on the board already, #4 of o/p is not.
// Returns the runner and every call it got, as [args, body].
function fakeGh({ details = true } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    assert.equal(cmd, 'gh');
    const body = opts.input ? JSON.parse(opts.input) : null;
    calls.push([args.slice(1, -2).join(' ') || args.slice(1).join(' '), body]);
    const ok = data => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });
    if (args[1] === 'graphql') {
      const { query, variables } = body;
      if (query.includes('repositoryOwner')) return ok({ data: { repositoryOwner: { projectV2: BOARD } } });
      if (query.includes('issue(number')) {
        const on = variables.number === 3 ? [{ id: 'ITEM3', project: { id: 'PVT' } }] : [{ id: 'OTHER', project: { id: 'PVT_other' } }];
        return ok({ data: { repository: { issue: { id: `I${variables.number}`, url: `https://github.com/${variables.owner}/${variables.name}/issues/${variables.number}`, projectItems: { nodes: on } } } } });
      }
      if (query.includes('addProjectV2ItemById')) return ok({ data: { addProjectV2ItemById: { item: { id: `NEW-${variables.content}` } } } });
      if (query.includes('updateProjectV2ItemFieldValue')) return ok({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } } });
    }
    if (args[1] === 'repos/o/tracker') return ok({ default_branch: 'main' });
    if (args[1] === 'repos/o/tracker/actions/workflows/poll.yml/dispatches') {
      if (body.return_run_details && !details) return { status: 1, stdout: '', stderr: 'gh: HTTP 422 Unprocessable' };
      return ok(body.return_run_details ? { workflow_run_id: 9, html_url: 'https://github.com/o/tracker/actions/runs/9' } : null);
    }
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { run, calls };
}

async function go(argv, opts) {
  const gh = fakeGh(opts);
  const out = [];
  await enqueue(argv, { run: gh.run, log: line => out.push(line), text: JSON.stringify(CONFIG) });
  return { out, calls: gh.calls };
}

const writes = calls => calls.filter(([, body]) => /mutation/.test(body?.query ?? '') || body?.inputs);

test('arguments: issue URLs or owner/repo#n of scheduled repositories, a priority, at most schedule.fill', () => {
  assert.deepEqual(parseArgs(['https://github.com/O/R/issues/3', 'o/p#4', 'o/r#3', 'priority=P0', '--dry-run'], CONFIG.schedule),
    { refs: [{ repository: 'o/r', number: 3 }, { repository: 'o/p', number: 4 }], priority: 'P0', dryRun: true });
  assert.equal(parseArgs(['o/r#3'], CONFIG.schedule).priority, 'P1');
  for (const [argv, why] of [[[], /usage/], [['o/r'], /not an issue URL/], [['https://github.com/o/r/pull/3'], /not an issue URL/],
    [['up/stream#1'], /not in schedule\.repositories.*by hand/], [['o/r#1', 'o/r#2', 'o/p#3'], /3 issues, more than schedule\.fill \(2\)/]]) {
    assert.throws(() => parseArgs(argv, CONFIG.schedule), why, argv.join(' '));
  }
});

test('--dry-run reads the board, says what it would do and writes nothing', async () => {
  const { out, calls } = await go(['https://github.com/o/r/issues/3', 'o/p#4', 'priority=P0', '--dry-run']);
  assert.deepEqual(out, [
    '[dry-run] https://github.com/o/r/issues/3: on the board already; Priority P0',
    '[dry-run] https://github.com/o/p/issues/4: added to the board; Priority P0, Status Todo',
    '[dry-run] would start poll.yml in o/tracker with items: o/r#3 o/p#4',
  ]);
  assert.deepEqual(writes(calls), []);
});

test('an issue on the board gets its priority; a new one is added as Todo; one poll run with the items', async () => {
  const { out, calls } = await go(['o/r#3', 'o/p#4']);
  assert.deepEqual(out, [
    'https://github.com/o/r/issues/3: on the board already; Priority P1',
    'https://github.com/o/p/issues/4: added to the board; Priority P1, Status Todo',
    'started poll.yml with items: o/r#3 o/p#4; https://github.com/o/tracker/actions/runs/9',
  ]);
  const sets = writes(calls).map(([, b]) => b.variables ?? b.inputs);
  assert.deepEqual(sets, [
    { project: 'PVT', item: 'ITEM3', field: 'PRI', option: 'PRI-P1' },
    { project: 'PVT', content: 'I4' },
    { project: 'PVT', item: 'NEW-I4', field: 'PRI', option: 'PRI-P1' },
    { project: 'PVT', item: 'NEW-I4', field: 'ST', option: 'ST-Todo' },
    { items: 'o/r#3 o/p#4' },
  ]);
  assert.equal(writes(calls).at(-1)[1].ref, 'main');
});

test('without run details the dispatch is sent again plainly; a priority the board lacks changes nothing', async () => {
  const { out } = await go(['o/r#3'], { details: false });
  assert.equal(out.at(-1), 'started poll.yml with items: o/r#3; https://github.com/o/tracker/actions/workflows/poll.yml');
  const gh = fakeGh();
  await assert.rejects(enqueue(['o/r#3', 'priority=P7'], { run: gh.run, log: () => {}, text: JSON.stringify(CONFIG) }), /no option P7 \(it has P0, P1, P2\)/);
  assert.deepEqual(writes(gh.calls), []);
});

test('an issue not found, after others that were, changes nothing', async () => {
  const gh = fakeGh();
  const run = (cmd, args, opts) => (/"number":99/.test(opts.input ?? '') ? { status: 0, stdout: JSON.stringify({ data: { repository: { issue: null } } }) } : gh.run(cmd, args, opts));
  await assert.rejects(enqueue(['o/p#4', 'o/r#99'], { run, log: () => {}, text: JSON.stringify(CONFIG) }), /o\/r#99 not found/);
  assert.deepEqual(writes(gh.calls), []);
  assert.throws(() => parseArgs(['o/r#1'], { ...CONFIG.schedule, fill: 0 }), /schedule\.fill is off/);
  assert.throws(() => parseArgs(['o/r#0'], CONFIG.schedule), /not an issue URL/);
});
