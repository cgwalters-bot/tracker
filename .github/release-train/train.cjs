'use strict';

// The release train (#650): cuts a release of config.release.repository and
// moves its callers' pins, one step a pass, as the controller did by hand:
// the version bump PR, release.yml once it merges, the wrappers' pin PR once
// the release is out, then each caller's review.yml pin PR once that merges.
// Every PR goes through its repository's review and queue like any other.
// A pass keeps no state of its own: it reads the stage from GitHub, from the
// one open tracking issue and the PRs on its branch, so a lost or repeated
// pass neither skips nor repeats a step. Without --apply it only prints.
const config = require('./config.json');
const { bot } = require('../poll/agent-board.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hour = 3600000;

// A problem with what is to be edited rather than with the API: retrying
// would not help, so the train stalls for a person instead.
class Stall extends Error {}

function nextVersion(version, breaking) {
  const m = SEMVER.exec(version);
  if (!m) throw new Stall(`not a version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  return breaking ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

// Why a release is due, or null. merged: the PRs merged since the last
// release, each with its label names.
function due(merged, published, now, cfg = config) {
  if (!merged.length) return null;
  if (merged.some(p => p.labels.includes(cfg.labels.urgent))) return `a ${cfg.labels.urgent} fix merged`;
  if (merged.length < cfg.threshold) return null;
  if (now - Date.parse(published) < cfg.intervalHours * hour) return null;
  return `${merged.length} pull requests merged`;
}

// The next step of an open train, from what GitHub shows of it. Each PR is
// null (not opened yet) or { state, merged, html_url, merge_commit_sha }.
function next(f) {
  const closed = (pr, what) => pr.state === 'closed' && !pr.merged && { step: 'stall', reason: `${what} was closed unmerged` };
  if (!f.bump) return { step: 'bump' };
  if (!f.bump.merged) return closed(f.bump, 'the version bump') || { step: 'wait', reason: 'the version bump' };
  if (!f.release) {
    if (!f.run) return { step: 'release' };
    if (f.run.status !== 'completed') return { step: 'wait', reason: 'release.yml' };
    // Not dispatched again: a failed release needs a look first.
    return { step: 'stall', reason: `release.yml ended ${f.run.conclusion} without a release` };
  }
  if (!f.wrappers) return { step: 'wrappers' };
  if (!f.wrappers.merged) return closed(f.wrappers, 'the wrappers\' pin bump') || { step: 'wait', reason: 'the wrappers\' pin bump' };
  const missing = f.callers.filter(c => !c.pr).map(c => c.repository);
  if (missing.length) return { step: 'callers', repositories: missing };
  for (const c of f.callers) {
    const stall = closed(c.pr, `${c.repository}'s pin bump`);
    if (stall) return stall;
  }
  if (f.callers.every(c => c.pr.merged)) return { step: 'done' };
  return { step: 'wait', reason: 'the review.yml pin bumps' };
}

// The workspace version in Cargo.toml and every path package (no `source`)
// in Cargo.lock, as agentic-job's own version bumps change them.
function bumpCargo(files, from, to) {
  const toml = files['Cargo.toml'].replace(
    new RegExp(`(^\\[workspace\\.package\\]\\n(?:[^[\\n][^\\n]*\\n|\\n)*?version = ")${esc(from)}(")`, 'm'),
    (_, a, b) => a + to + b);
  const lock = files['Cargo.lock'].split('\n\n').map(block =>
    block.startsWith('[[package]]') && !/^source = /m.test(block)
      ? block.replace(new RegExp(`^version = "${esc(from)}"$`, 'm'), `version = "${to}"`)
      : block).join('\n\n');
  if (toml === files['Cargo.toml'] || lock === files['Cargo.lock']) throw new Stall(`no workspace version ${from} to raise`);
  return { 'Cargo.toml': toml, 'Cargo.lock': lock };
}

function workspaceVersion(toml) {
  return /^\[workspace\.package\]\n(?:[^[\n][^\n]*\n|\n)*?version = "([^"]+)"/m.exec(toml)?.[1];
}

// Moves every pin of target's workflows in files to to.pin, a tag or a
// commit, and the "<project> vX.Y.Z" that names the version beside it, in
// plain or regex-escaped form (a test asserting the pin), to to.version.
// Every file must change: a file that no longer has the pin is a layout
// this cannot follow, and a PR missing it would be half a bump.
function repin(files, target, project, to) {
  const uses = new RegExp(`${esc(target)}/\\.github/workflows/[\\w.-]+\\.yml@(v\\d+\\.\\d+\\.\\d+|[0-9a-f]{40})(.*)$`, 'gm');
  const named = new RegExp(`${esc(project)} \\**v(\\d+\\.\\d+\\.\\d+)`);
  const pins = new Set();
  const versions = new Set();
  for (const text of Object.values(files)) {
    for (const m of text.matchAll(uses)) {
      pins.add(m[1]);
      versions.add(m[1].startsWith('v') ? m[1].slice(1) : named.exec(m[2])?.[1]);
    }
  }
  if (pins.size !== 1 || versions.size !== 1 || versions.has(undefined)) throw new Stall(`no single pin of ${target} with its version`);
  const [pin] = pins;
  const [version] = versions;
  if (pin === to.pin) throw new Stall(`${target} is already pinned at ${pin}`);
  // A commit is unique wherever it appears; a tag is moved only in a pin.
  const pinned = pin.startsWith('v')
    ? new RegExp(`(${esc(target)}/\\.github/workflows/[\\w.-]+\\.yml@)${esc(pin)}(?!\\d)`, 'g')
    : new RegExp(`()${pin}`, 'g');
  const escaped = v => v.replace(/\./g, '\\.');
  const out = {};
  for (const [path, text] of Object.entries(files)) {
    out[path] = text
      .replace(pinned, (_, a) => a + to.pin)
      .replace(new RegExp(`(${esc(project)} \\**v)${esc(version)}(?!\\d)`, 'g'), (_, a) => a + to.version)
      .replace(new RegExp(`(${esc(project)} \\**v)${esc(escaped(version))}(?!\\d)`, 'g'), (_, a) => a + escaped(to.version));
    if (out[path] === text) throw new Stall(`${path} has no pin of ${target} to move`);
  }
  return { files: out, from: { pin, version } };
}

function client(token, cfg = config, clock = Date.now) {
  let requests = 0;
  return async (method, path, body) => {
    // Bounds a pass however the API answers.
    if (++requests > cfg.maxRequests) throw new Error('request budget exhausted');
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.requestTimeoutSeconds * 1000),
    });
    if (!response.ok) throw Object.assign(new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}`), { status: response.status });
    return response.status === 204 ? null : response.json();
  };
}

async function pass({ api, apply = false, now = Date.now(), log = console.log, cfg = config, owner = bot }) {
  const enc = encodeURIComponent;
  const project = cfg.release.repository.split('/')[1];
  const title = v => `${project} v${v} release train`;
  const titled = new RegExp(`^${esc(project)} v(\\d+\\.\\d+\\.\\d+) release train$`);
  const branch = v => `release-train/v${v}`;
  const write = async (what, fn) => {
    log(`${apply ? '' : 'would: '}${what}`);
    return apply ? fn() : undefined;
  };
  const optional = promise => promise.catch(e => { if (e.status === 404) return null; throw e; });
  const comment = (issue, body) => write(`comment on ${issue.html_url}: ${body}`,
    () => api('POST', `/repos/${cfg.tracking}/issues/${issue.number}/comments`, { body }));

  // The PR on ref from target's fork, opened since this train began: a PR
  // of a dropped train for the same version is not this train's.
  const pull = async (target, ref, since) => {
    const pulls = await api('GET', `/repos/${target.repository}/pulls?state=all&head=${enc(`${target.fork.split('/')[0]}:${ref}`)}&per_page=${cfg.pageSize}`);
    const pr = pulls.find(p => !since || !p.created_at || Date.parse(p.created_at) >= Date.parse(since));
    return pr ? { state: pr.state, merged: Boolean(pr.merged_at), merged_at: pr.merged_at, html_url: pr.html_url, merge_commit_sha: pr.merge_commit_sha } : null;
  };

  // Opens a PR from the bot's fork, as the bot's other PRs are, so the poll
  // follows it to a fix or a merge like those. The commit is made on the
  // fork through the API on the default branch's head; files keep mode
  // 100644, which every file the train edits has. The fork is configured,
  // as forks need not share their parent's name, and checked: a fork of
  // another repository would take the branch but could never be its PR.
  const open = async (target, ref, text, edit) => {
    const repo = target.repository;
    const fork = target.fork;
    if ((await api('GET', `/repos/${fork}`)).parent?.full_name !== repo) throw new Stall(`${fork} is not a fork of ${repo}`);
    const { default_branch: base } = await api('GET', `/repos/${repo}`);
    const head = await api('GET', `/repos/${repo}/commits/${enc(base)}`);
    const files = {};
    for (const path of edit.paths) {
      const file = await api('GET', `/repos/${repo}/contents/${path.split('/').map(enc).join('/')}?ref=${head.sha}`);
      if (file.encoding !== 'base64') throw new Stall(`${repo}:${path} is too large to edit through the API`);
      files[path] = Buffer.from(file.content, 'base64').toString('utf8');
    }
    const changed = edit.apply(files);
    // A dropped train's PR still open on the branch: the force push below
    // would change what its reviewers saw.
    const stale = await api('GET', `/repos/${repo}/pulls?state=open&head=${enc(`${fork.split('/')[0]}:${ref}`)}&per_page=${cfg.pageSize}`);
    if (stale.length) throw new Stall(`${stale[0].html_url} from a dropped train is still open on ${ref}; close it`);
    return write(`open a PR on ${repo} from ${fork}:${ref} changing ${Object.keys(changed).join(', ')}: ${text.title}`, async () => {
      const tree = await api('POST', `/repos/${fork}/git/trees`, {
        base_tree: head.commit.tree.sha,
        tree: Object.entries(changed).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await api('POST', `/repos/${fork}/git/commits`, { message: `${text.title}\n\n${text.why}\n`, tree: tree.sha, parents: [head.sha] });
      // A branch left by a pass that failed before its PR is replaced:
      // without a PR on it, nobody has reviewed it.
      await api('POST', `/repos/${fork}/git/refs`, { ref: `refs/heads/${ref}`, sha: commit.sha }).catch(e => {
        if (e.status !== 422) throw e;
        return api('PATCH', `/repos/${fork}/git/refs/heads/${ref}`, { sha: commit.sha, force: true });
      });
      const pr = await api('POST', `/repos/${repo}/pulls`, { title: text.title, body: text.body, head: `${fork.split('/')[0]}:${ref}`, base });
      return pr.html_url;
    });
  };

  // The release repository's state since its last release.
  const pending = async () => {
    const repo = cfg.release.repository;
    const latest = await api('GET', `/repos/${repo}/releases/latest`);
    const current = latest.tag_name.replace(/^v/, '');
    const { default_branch: base } = await api('GET', `/repos/${repo}`);
    const toml = await api('GET', `/repos/${repo}/contents/Cargo.toml?ref=${enc(base)}`);
    const workspace = workspaceVersion(Buffer.from(toml.content, 'base64').toString('utf8'));
    const q = `repo:${repo} is:pr is:merged base:${base} merged:>${latest.published_at}`;
    const found = await api('GET', `/search/issues?q=${enc(q)}&per_page=${cfg.pageSize}`);
    // Labels decide the bump and the urgency: all of them or none.
    if (found.incomplete_results || found.total_count > found.items.length) throw new Error('merged pull requests truncated');
    const merged = found.items.map(i => ({ number: i.number, title: i.title, labels: i.labels.map(l => l.name) }));
    return { latest, current, workspace, merged };
  };

  const issues = await api('GET', `/repos/${cfg.tracking}/issues?state=open&labels=${enc(cfg.labels.tracking)}&creator=${enc(owner)}&per_page=${cfg.pageSize}`);
  // Only the bot's own issues: anyone may open one with this title.
  const trains = issues.filter(i => !i.pull_request && i.user?.login === owner && titled.test(i.title));
  if (trains.length > 1) throw new Error('more than one open release train');

  let issue = trains[0];
  if (!issue) {
    const { latest, current, workspace, merged } = await pending();
    if (workspace !== current) return log(`main is at ${workspace}, not the last release ${latest.tag_name}: not starting`);
    const reason = due(merged, latest.published_at, now, cfg);
    if (!reason) return log(`not due: ${merged.length} pull requests merged since ${latest.tag_name}`);
    const version = nextVersion(current, merged.some(p => p.labels.includes(cfg.labels.breaking)));
    log(`due: ${reason} since ${latest.tag_name}; next is v${version}`);
    issue = await write(`open the tracking issue "${title(version)}"`, () => api('POST', `/repos/${cfg.tracking}/issues`, {
      title: title(version),
      body: `The release train's steps for ${cfg.release.repository} v${version}, one comment each (.github/release-train). Due: ${reason} since ${latest.tag_name}. Label it \`${cfg.labels.stalled}\` to halt the train; close it to drop this release.`,
      labels: [cfg.labels.tracking],
    }));
    issue ??= { number: 0, html_url: '(new tracking issue)', title: title(version), labels: [], created_at: new Date(now).toISOString() };
  }

  const version = titled.exec(issue.title)[1];
  if (issue.labels.some(l => (l.name ?? l) === cfg.labels.stalled)) return log(`${issue.html_url} is labelled ${cfg.labels.stalled}: halted`);
  const facts = { bump: await pull(cfg.release, branch(version), issue.created_at) };
  facts.release = await optional(api('GET', `/repos/${cfg.release.repository}/releases/tags/v${version}`));
  if (facts.bump?.merged && !facts.release) {
    const runs = await api('GET', `/repos/${cfg.release.repository}/actions/workflows/${cfg.release.workflow}/runs?event=workflow_dispatch&created=${enc(`>=${facts.bump.merged_at}`)}&per_page=${cfg.pageSize}`);
    facts.run = runs.workflow_runs[0] ?? null;
  }
  facts.wrappers = await pull(cfg.wrappers, branch(version), issue.created_at);
  facts.callers = [];
  for (const c of cfg.callers) facts.callers.push({ repository: c.repository, pr: await pull(c, branch(version), issue.created_at) });

  const step = next(facts);
  log(`${issue.html_url} v${version}: ${step.step}${step.reason ? ` (${step.reason})` : ''}`);
  // The notes come from merged PR titles: data for whoever wires the
  // interface changes through, fenced so that they read as such.
  const notes = () => [
    `The train only moves the pin: wire through, in this PR, any interface change of [v${version}](${facts.release.html_url}) that callers must pass on. Tracked on ${issue.html_url}. Its release notes, as data:`,
    '', '````text', (facts.release.body ?? '').slice(0, 30000).replace(/`{4,}/g, '```'), '````',
  ].join('\n');
  try {
    switch (step.step) {
      case 'bump': {
        const { latest, current, merged } = await pending();
        if (nextVersion(current, true) !== version && nextVersion(current, false) !== version) throw new Stall(`v${version} does not follow ${latest.tag_name}`);
        const why = `Releases what merged since ${latest.tag_name} so that callers can pin it, through the release train (${issue.html_url}).`;
        const url = await open(cfg.release, branch(version), {
          title: `release: Prepare ${version}`,
          why,
          body: [why, '', `Merged since ${latest.tag_name}:`, ...merged.map(p => `- #${p.number} ${p.title}${p.labels.length ? ` (${p.labels.join(', ')})` : ''}`)].join('\n'),
        }, { paths: ['Cargo.toml', 'Cargo.lock'], apply: files => bumpCargo(files, current, version) });
        return comment(issue, `Opened the version bump: ${url ?? '(dry run)'}`);
      }
      case 'release': {
        // release.yml releases main's head, so what merged after the bump
        // was opened ships too: a breaking change among it needs a minor.
        const { current, merged } = await pending();
        if (merged.some(p => p.labels.includes(cfg.labels.breaking)) && nextVersion(current, true) !== version) {
          throw new Stall(`a PR labelled ${cfg.labels.breaking} merged, so v${version} would be the wrong version`);
        }
        const { default_branch: ref } = await api('GET', `/repos/${cfg.release.repository}`);
        await write(`run ${cfg.release.workflow} on ${cfg.release.repository} for ${version}`, () =>
          api('POST', `/repos/${cfg.release.repository}/actions/workflows/${cfg.release.workflow}/dispatches`, { ref, inputs: { version } }));
        return comment(issue, `Ran ${cfg.release.workflow} for ${version}, as the bump merged: ${facts.bump.html_url}`);
      }
      case 'wrappers': {
        const why = `Moves the wrappers to ${project} v${version} so callers get its changes, through the release train.`;
        const url = await open(cfg.wrappers, branch(version), { title: `wrappers: Pin ${project} v${version}`, why, body: `${why}\n\n${notes()}` },
          { paths: cfg.wrappers.files, apply: files => repin(files, cfg.release.repository, project, { pin: `v${version}`, version }).files });
        return comment(issue, `Opened the wrappers' pin bump: ${url ?? '(dry run)'}`);
      }
      case 'callers': {
        const urls = [];
        for (const repo of step.repositories) {
          const caller = cfg.callers.find(c => c.repository === repo);
          const why = `Moves review.yml to the wrappers' commit for ${project} v${version}, so this repository's reviews run it, through the release train.`;
          urls.push(await open(caller, branch(version), { title: `review: Pin ${project} v${version}`, why, body: `${why}\n\n${notes()}` },
            { paths: caller.files, apply: files => repin(files, cfg.wrappers.repository, project, { pin: facts.wrappers.merge_commit_sha, version }).files }) ?? `(dry run on ${repo})`);
        }
        return comment(issue, `Opened the review.yml pin bumps: ${urls.join(', ')}`);
      }
      case 'stall':
        throw new Stall(step.reason);
      case 'done':
        await comment(issue, `Done: v${version} is released and pinned by the wrappers and every caller.`);
        return write(`close ${issue.html_url}`, () => api('PATCH', `/repos/${cfg.tracking}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' }));
      default:
        return undefined;
    }
  } catch (e) {
    if (!(e instanceof Stall)) throw e;
    // The label first: a pass that failed between the two would otherwise
    // say so again every hour.
    await write(`label ${issue.html_url} ${cfg.labels.stalled}`, () =>
      api('POST', `/repos/${cfg.tracking}/issues/${issue.number}/labels`, { labels: [cfg.labels.stalled] }));
    return comment(issue, `Halted: ${e.message}. Fix it, then remove the \`${cfg.labels.stalled}\` label.`);
  }
}

module.exports = { nextVersion, due, next, bumpCargo, workspaceVersion, repin, pass, Stall };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--apply')) {
    console.error('usage: train.cjs [--apply]');
    process.exit(2);
  }
  pass({ api: client(process.env.GH_TOKEN), apply: args.includes('--apply') })
    .catch(e => { console.error(`release-train: ${e.message}`); process.exitCode = 1; });
}
