'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { MARKER, heldBy, probe, publish } = require('./broker.cjs');

test('probe accepts any HTTP response without credentials or redirects', async t => {
  let status = 401;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(status, { location: 'http://unreachable.invalid' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  // Allow for CI contention; the separate non-HTTP test checks short deadlines.
  for (status of [200, 301, 401, 404, 500]) assert.equal(await probe(url, 5000), true);
  await assert.rejects(probe('http://user:password@localhost'), /without credentials/);
});

test('probe bounds non-HTTP listeners and detects refused connections', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probe(url, 25), false);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probe(url, 25), false);
});

test('outage issue is created, updated in place, then closed on recovery', async () => {
  let issues = [];
  const writes = [];
  const api = async (_token, method, path, body) => {
    if (method === 'GET') return issues;
    writes.push({ method, path, body });
    if (method === 'POST' && path.endsWith('/issues')) issues = [{ ...body, number: 7, user: { login: 'configured-bot' } }];
  };
  const input = { token: 'token', repo: 'configured/repo', login: 'configured-bot', api };
  await publish({ ...input, up: true });
  assert.equal(writes.length, 0);
  await publish({ ...input, up: false });
  await publish({ ...input, up: false });
  await publish({ ...input, up: true });
  assert.equal(writes.filter(w => w.path.endsWith('/issues')).length, 1);
  assert.equal(writes.filter(w => w.method === 'PATCH' && w.body.body).length, 1);
  assert.equal(writes.at(-2).body.state, 'closed');
  assert.match(writes.at(-1).body.body, /reachable again/);
});

test('a failed close on recovery does not repeat the recovery comment', async () => {
  const issues = [{ number: 7, user: { login: 'configured-bot' }, body: `${MARKER}\nBroker unreachable` }];
  const writes = [];
  const api = async (_token, method, path, body) => {
    if (method === 'GET') return issues;
    if (method === 'PATCH') throw new Error('HTTP 502');
    writes.push({ method, path, body });
  };
  const input = { token: 'token', repo: 'configured/repo', login: 'configured-bot', api, up: true };
  await assert.rejects(publish(input), /HTTP 502/);
  await assert.rejects(publish(input), /HTTP 502/);
  assert.deepEqual(writes, []);
});

test('only the bot\'s fresh, marked, open outage issue holds', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const issue = (over = {}) => ({ number: 7, html_url: 'https://github.com/configured/repo/issues/7', user: { login: 'configured-bot' },
    body: `${MARKER}\nBroker unreachable`, updated_at: '2026-10-16T11:50:00Z', ...over });
  const lines = [];
  const held = issues => heldBy({ token: 'token', repo: 'configured/repo', login: 'configured-bot', now, log: line => lines.push(line),
    api: async (token, method, path) => {
      assert.deepEqual([token, method, path], ['token', 'GET', '/repos/configured/repo/issues?state=open&labels=outage&per_page=100']);
      return issues;
    } });
  assert.deepEqual(await held([issue()]), { url: 'https://github.com/configured/repo/issues/7', number: 7 });
  for (const other of [
    issue({ user: { login: 'visitor' } }), issue({ pull_request: {} }), issue({ body: 'Broker unreachable' }),
    issue({ updated_at: '2026-10-16T10:59:00Z' }),
  ]) assert.equal(await held([other]), null);
  assert.deepEqual(lines, ['outage issue #7 is stale; not holding']);
  assert.equal(await held([]), null);
  await assert.rejects(held(Array.from({ length: 100 }, () => issue({ user: { login: 'visitor' } }))), /bound/);
  await assert.rejects(heldBy({ token: 'token', repo: 'configured/repo', login: 'configured-bot', api: async () => { throw new Error('HTTP 502'); } }), /HTTP 502/);
});
