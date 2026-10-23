'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { MARKER, find, probe, publish, request } = require('./broker.cjs');

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

test('only the bot\'s marked, open outage issue is found', async () => {
  const issue = (over = {}) => ({ number: 7, user: { login: 'configured-bot' }, body: `${MARKER}\nBroker unreachable`, ...over });
  const found = issues => find({ token: 'token', repo: 'configured/repo', login: 'configured-bot',
    api: async (token, method, path) => {
      assert.deepEqual([token, method, path], ['token', 'GET', '/repos/configured/repo/issues?state=open&labels=outage&per_page=100']);
      return issues;
    } });
  assert.equal((await found([issue()])).number, 7);
  for (const other of [issue({ user: { login: 'visitor' } }), issue({ pull_request: {} }), issue({ body: 'Broker unreachable' })]) {
    assert.equal(await found([other]), null);
  }
  await assert.rejects(found(Array.from({ length: 100 }, () => issue({ user: { login: 'visitor' } }))), /bound/);
});

test('a GitHub request that stalls fails the call with its method and path', { timeout: 10e3 }, async t => {
  // Accepts and never answers, or sends the headers and stalls in the body.
  const server = http.createServer((req, res) => {
    if (req.url === '/body') { res.writeHead(200); res.write('{'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => realFetch(url.replace('https://api.github.com', base), init));
  await assert.rejects(request('token', 'GET', '/silent', undefined, 200), { message: /^GET \/silent: .*timeout/ });
  await assert.rejects(request('token', 'POST', '/body', {}, 200), { message: /^POST \/body: .*timeout/ });
});
