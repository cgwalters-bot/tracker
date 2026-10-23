// Probes the inference broker from the dispatch tailnet path and keeps one
// `outage` issue open while it is unreachable (#603), for a person to see.
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

// The bot's open outage issue, if any. Anyone who can open an issue can add
// a label and the marker, so only the probe's own login counts.
async function find({ token, repo, login, api }) {
  const issues = await api(token, 'GET', `/repos/${repo}/issues?state=open&labels=outage&per_page=100`);
  if (issues.length === 100) throw new Error('Outage issue scan reached its bound');
  return issues.find(i => !i.pull_request && i.user?.login === login && i.body?.startsWith(MARKER)) ?? null;
}

// Whether an outage holds agent runs: { url, number } of the open issue, or
// null. The probe rewrites the issue every 15 minutes while the broker is
// down, so one not updated for `staleMinutes` means the probe stopped (say,
// BROKER_OUTAGE unset after it opened); it does not hold, lest a forgotten
// issue stop every run for good. A failed read throws: it is not "no outage".
async function publish({ token, repo, login, up, api, now = new Date().toISOString() }) {
  const path = `/repos/${repo}/issues`;
  const issue = await find({ token, repo, login, api });
  const body = `${MARKER}\nBroker ${up ? 'reachable again' : 'unreachable'} from the dispatch tailnet path at ${now}.\nTCP plus one unauthenticated HTTP request; any HTTP response counts as reachable.`;
  if (up) {
    // The close first: a probe that failed between the two would otherwise
    // say so again every 15 minutes; a closed issue is not found again.
    if (issue) {
      await api(token, 'PATCH', `${path}/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      await api(token, 'POST', `${path}/${issue.number}/comments`, { body: `Broker reachable again at ${now}.` });
    }
  } else if (issue) {
    await api(token, 'PATCH', `${path}/${issue.number}`, { body });
  } else {
    await api(token, 'POST', `/repos/${repo}/labels`, { name: 'outage', color: 'b60205', description: 'Infrastructure unavailable' })
      .catch(err => { if (!/HTTP 422/.test(err.message)) throw err; });
    await api(token, 'POST', path, { title: 'Inference broker unreachable', body, labels: ['outage'] });
  }
}

// fetch never times out by itself, and a connection GitHub accepts and never
// answers would hold the probe until the step's timeout kills it (#819).
async function request(token, method, path, body, timeoutMs = 30e3) {
  let res, text;
  try {
    res = await fetch('https://api.github.com' + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'tracker-broker-probe' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`${method} ${path}: ${err.cause?.message || err.message}`);
  }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
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

module.exports = { MARKER, find, probe, publish, request };

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
