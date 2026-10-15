'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Threat: public artifacts disclose the private issue's last-written body.
// Only authenticated ciphertext may cross the artifact boundary. The key is a
// repository secret, not an input or the GitHub token (which can rotate).
function keyFrom(text) {
  if (!/^[a-fA-F0-9]{64}$/.test(text ?? '')) throw new Error('invalid decisions key');
  return Buffer.from(text, 'hex');
}

function seal(body, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}

function open(body, key) {
  if (body.length < 28 || body.length > 256 * 1024) throw new Error('invalid baseline size');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
  decipher.setAuthTag(body.subarray(-16));
  return Buffer.concat([decipher.update(body.subarray(12, -16)), decipher.final()]);
}

function readDecisions(env, settings, run = spawnSync) {
  if (!env.DECISIONS_STATE_KEY) return { status: 'disabled', changes: [] };
  let dir;
  try {
    const key = keyFrom(env.DECISIONS_STATE_KEY);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-decisions-'));
    const config = path.join(dir, 'agent-board.json');
    const baseline = path.join(dir, 'agent-board.decisions-state.md');
    fs.writeFileSync(config, JSON.stringify({ decisions: settings.decisions }), { mode: 0o600 });
    const saved = `${env.POLL_STATE}.decisions.enc`;
    if (fs.existsSync(saved)) {
      if (fs.statSync(saved).size > 256 * 1024) throw new Error('oversized baseline');
      fs.writeFileSync(baseline, open(fs.readFileSync(saved), key), { mode: 0o600 });
    }
    const { DECISIONS_STATE_KEY, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, ...childEnv } = env;
    // Threat: errors, replies, option labels and before/after text all contain
    // private data. Neither output stream nor exception details may be logged.
    const result = run(env.AGENT_BOARD, ['ask', 'read', '--config', config], {
      env: childEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error('read failed');
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data.changes) || data.changes.length > 1000 || typeof data.other_edits !== 'boolean') {
      throw new Error('invalid decisions response');
    }
    const changes = data.changes.map(entry => {
      if (!entry || typeof entry.id !== 'string' || !/^D[1-9][0-9]{0,19}$/.test(entry.id) || !Array.isArray(entry.ticked) || entry.ticked.length > 10) {
        throw new Error('invalid decision');
      }
      const options = entry.ticked.map(line => {
        const match = typeof line === 'string' && /^- \[[xX]\] ([A-J])\) /.exec(line);
        if (!match) throw new Error('invalid option');
        return match[1];
      });
      return { id: entry.id, options };
    });
    // ask read deliberately does not advance the last-written baseline. Carry
    // an existing baseline unchanged, including one seeded by a private writer.
    if (fs.existsSync(baseline)) fs.writeFileSync(saved, seal(fs.readFileSync(baseline), key), { mode: 0o600 });
    return { status: 'ok', changes, other_edits: data.other_edits };
  } catch {
    return { status: 'failed', changes: [] };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { readDecisions, keyFrom, seal, open };
