'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { probe, publish } = require('./broker.cjs');

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
  for (status of [200, 301, 401, 404, 500]) assert.equal(await probe(url, 100), true);
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
  assert.equal(writes.at(-1).body.state, 'closed');
});
