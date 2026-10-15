// Probes the inference broker from the dispatch tailnet path and keeps one
// `outage` issue open while it is unreachable (#603). Refunding the fix round
// an outage interrupts belongs to agent-board, which owns the rounds.
'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const MARKER = '<!-- tracker-broker-outage -->';

function endpoint(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('INFERENCE_URL must be HTTP(S), without credentials');
  return url;
}

async function probe(value, timeout = 10000) {
  const url = endpoint(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port: url.port || (url.protocol === 'https:' ? 443 : 80) });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP timeout')); }, timeout);
      socket.once('error', err => { clearTimeout(timer); reject(err); });
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    });
    return await new Promise(resolve => {
      const req = (url.protocol === 'https:' ? https : http).get(url, res => {
        clearTimeout(timer);
        res.destroy();
        resolve(true); // Including redirects, 401, 404 and 500; never follow.
      });
      const timer = setTimeout(() => { req.destroy(); resolve(false); }, timeout);
      req.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  } catch { return false; }
}

async function publish({ token, repo, login, up, api, now = new Date().toISOString() }) {
  const path = `/repos/${repo}/issues`;
  const issues = await api(token, 'GET', `${path}?state=open&labels=outage&per_page=100`);
  if (issues.length === 100) throw new Error('Outage issue scan reached its bound');
  const issue = issues.find(i => !i.pull_request && i.user?.login === login && i.body?.startsWith(MARKER));
  const body = `${MARKER}\nBroker ${up ? 'reachable again' : 'unreachable'} from the dispatch tailnet path at ${now}.\nTCP plus one unauthenticated HTTP request; any HTTP response counts as reachable.`;
  if (up) {
    if (issue) {
      await api(token, 'POST', `${path}/${issue.number}/comments`, { body: `Broker reachable again at ${now}.` });
      await api(token, 'PATCH', `${path}/${issue.number}`, { state: 'closed', state_reason: 'completed' });
    }
  } else if (issue) {
    await api(token, 'PATCH', `${path}/${issue.number}`, { body });
  } else {
    await api(token, 'POST', `/repos/${repo}/labels`, { name: 'outage', color: 'b60205', description: 'Infrastructure unavailable' })
      .catch(err => { if (!/HTTP 422/.test(err.message)) throw err; });
    await api(token, 'POST', path, { title: 'Inference broker unreachable', body, labels: ['outage'] });
  }
}

async function main() {
  const { request } = require('./poll.cjs');
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GH_TOKEN and GITHUB_REPOSITORY are required');
  const up = await probe(process.env.INFERENCE_URL);
  await publish({ token, repo, login: (await request(token, 'GET', '/user')).login, up, api: request });
  const text = `Broker ${up ? 'reachable' : 'unreachable'} from the dispatch tailnet path.\n`;
  console.log(text.trim());
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (!up) process.exitCode = 1;
}

module.exports = { probe, publish };

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
