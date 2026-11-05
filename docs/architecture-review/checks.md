# Architecture review checks

> This text is LLM generated.

The JavaScript block below is the architecture-review prototype's checking
script. `just test-architecture-review [mode] [id]` runs it from the repository
root; it lives here because the Justfile may only shrink (#890).
[Local verification](README.md#local-verification) describes the modes.

```javascript
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync, lstatSync, readdirSync, mkdtempSync, rmSync, renameSync } = require('node:fs');

const read = name => readFileSync(`docs/architecture-review/${name}`, 'utf8');
const json = name => JSON.parse(read(name));
const references = json('references.json');
const version = references.version;
const sample = json('sample.json');
const results = json('results.json');

const sha256 = text => createHash('sha256').update(text).digest('hex');

// Manual only: no network in the default check or fixtures. Bound network
// requests so missing history cannot turn a packet audit into a crawl.
const api = (endpoint, accept = 'application/vnd.github+json') => execFileSync(
  'gh', ['api', endpoint, '-H', `Accept: ${accept}`, '-H', 'X-GitHub-Api-Version: 2022-11-28'],
  { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
const text = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const apiJSON = endpoint => JSON.parse(text(api(endpoint)));
const save = (name, value) => writeFileSync(`docs/architecture-review/${name}`, JSON.stringify(value, null, 2) + '\n');

function annotate(diff) {
  let next = null;
  return diff.split('\n').map(line => {
    if (line.startsWith('diff --git ')) next = null;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); return line; }
    if (next !== null && /^[ +\-]/.test(line)) {
      const number = line[0] === '-' ? '' : String(next++);
      return number.padStart(4) + ' ' + line;
    }
    return line;
  }).join('\n');
}

// Context (historical identity) follows the diff, counts toward the limits
// and is never omitted: a packet that cannot hold it is not built.
function select(diff, sources, limits, context = []) {
  const files = [{ name: 'diff.patch', data: Buffer.from(annotate(text(diff)), 'utf8') }, ...context];
  let total = files.reduce((sum, f) => sum + f.data.length, 0);
  assert.ok(limits.max_files >= files.length && total <= limits.max_bytes, 'complete annotated diff and context must fit');
  const omitted = [];
  const names = new Set(files.map(f => f.name));
  // UTF-8 byte ordering is independent of the host locale.
  sources.sort((a, b) => a.data.length - b.data.length || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const source of sources) {
    const name = 'head/' + source.path.replaceAll('/', '__');
    assert.ok(!names.has(name), `filename collision: ${source.path}`);
    names.add(name);
    // No lossy decoding, BOM stripping or newline normalization: binary
    // sources are omitted whole, as the diff only says they changed.
    try {
      text(source.data);
    } catch {
      omitted.push({ path: source.path, revision: source.revision, bytes: source.data.length,
        reason: 'not UTF-8 text; diff.patch records the binary change' });
      continue;
    }
    if (files.length >= limits.max_files || total + source.data.length > limits.max_bytes) {
      omitted.push({ path: source.path, revision: source.revision, bytes: source.data.length,
        reason: 'packet byte/file limit; changed hunks remain in diff.patch' });
    } else {
      files.push({ name, path: source.path, data: source.data });
      total += source.data.length;
    }
  }
  return { files, omitted, total_bytes: total };
}

function comparePacket(packet, manifest) {
  const files = manifest.files.map(expected => {
    const actual = packet.files.find(f => f.name === expected.name);
    return { name: expected.name, expected_bytes: expected.bytes, actual_bytes: actual?.data.length ?? null,
      expected_sha256: expected.sha256, actual_sha256: actual ? sha256(actual.data) : null,
      match: !!actual && actual.data.length === expected.bytes && sha256(actual.data) === expected.sha256 };
  });
  return { files, expected_total_bytes: manifest.total_bytes, actual_total_bytes: packet.total_bytes,
    expected_file_order: manifest.files.map(f => f.name), actual_file_order: packet.files.map(f => f.name),
    expected_omitted: manifest.omitted, actual_omitted: packet.omitted,
    total_match: packet.total_bytes === manifest.total_bytes,
    ordering_match: JSON.stringify(packet.files.map(f => f.name)) === JSON.stringify(manifest.files.map(f => f.name)),
    omissions_match: JSON.stringify(packet.omitted) === JSON.stringify(manifest.omitted),
    all_match: files.every(f => f.match) && packet.total_bytes === manifest.total_bytes &&
      JSON.stringify(packet.files.map(f => f.name)) === JSON.stringify(manifest.files.map(f => f.name)) &&
      JSON.stringify(packet.omitted) === JSON.stringify(manifest.omitted) };
}

function validateHistory(comparison, s, manifest) {
  const base = s.reconstructed_base ?? s.candidate_base;
  assert.equal(comparison.status, 'ahead');
  assert.equal(comparison.merge_base_commit.sha, base);
  assert.equal(comparison.total_commits, comparison.commits.length, 'truncated commits');
  assert.ok(comparison.files.length < 300, 'possibly truncated changed files');
  assert.equal(manifest.first_feedback_at, s.feedback_at);
  assert.ok(comparison.commits.every(c => c.commit.committer.date <= s.feedback_at), 'post-feedback commit');
  assert.deepEqual(comparison.commits.map(c => ({ sha: c.sha, committed: c.commit.committer.date })), manifest.commits);
}

// Hashes alone miss extra context (especially feedback) beside reviewed files.
// The only allowed directories are the root and head, if the manifest uses it.
function readPacket(directory, manifest) {
  const names = manifest.files.map(f => f.name);
  assert.equal(new Set(names).size, names.length, 'duplicate packet filename');
  assert.ok(names.includes('diff.patch'), 'missing diff.patch');
  for (const name of names) assert.match(name, /^(?:diff\.patch|identity\.md|head\/[^/]+)$/);
  for (const name of names) assert.ok(!['head/.', 'head/..'].includes(name), 'unsafe packet filename');
  const directories = names.some(n => n.startsWith('head/')) ? ['', 'head'] : [''];
  for (const dir of directories) {
    const path = dir ? `${directory}/${dir}` : directory;
    assert.ok(lstatSync(path).isDirectory(), `not a real directory: ${path}`);
    const expected = dir ? names.filter(n => n.startsWith('head/')).map(n => n.slice(5)) :
      [...names.filter(n => !n.includes('/')), ...(directories.includes('head') ? ['head'] : [])];
    assert.deepEqual([...readdirSync(path)].sort(), expected.sort(), `unexpected packet entries: ${path}`);
  }
  return names.map(name => {
    const path = `${directory}/${name}`;
    assert.ok(lstatSync(path).isFile(), `not a regular packet file: ${path}`);
    return { name, data: readFileSync(path) };
  });
}

function fetchSources(repository, files, revision) {
  return files.filter(f => f.status !== 'removed').map(f => {
    const path = f.filename.split('/').map(encodeURIComponent).join('/');
    const content = apiJSON(`repos/${repository}/contents/${path}?ref=${revision}`);
    assert.equal(content.type, 'file');
    assert.equal(content.encoding, 'base64');
    const data = Buffer.from(content.content, 'base64');
    assert.equal(data.length, content.size, 'missing or truncated contents');
    return { path: f.filename, revision, data };
  });
}

function publish(directory, packet, manifest) {
  const staging = mkdtempSync(`${directory}.staging-`);
  try {
    if (packet.files.some(f => f.name.startsWith('head/'))) mkdirSync(`${staging}/head`);
    for (const file of packet.files) writeFileSync(`${staging}/${file.name}`, file.data);
    const files = readPacket(staging, manifest);
    assert.ok(comparePacket({ ...packet, files }, manifest).all_match, 'staged packet MISMATCH');
    // Replace the entire old tree: no stale source or scoring material survives.
    // Publication is after comparison; a failed retrieval never publishes new bytes.
    rmSync(directory, { recursive: true, force: true });
    renameSync(staging, directory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const heldOutLimits = { max_files: 30, max_bytes: 100000 };
const packetDirectory = (id, heldOut) => `/tmp/opencode/architecture-review-${heldOut ? 'held-out-' : ''}${id}`;

const identityQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { title body lastEditedAt
    timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100) { pageInfo { hasNextPage }
      nodes { ... on RenamedTitleEvent { createdAt previousTitle } } } } } }`;

// Neutral identity as of first feedback: repository, title and the
// author's description verbatim, without the PR number or URL. Title
// renames are timeline events; a description
// edited after feedback has no trusted snapshot here, so it is unavailable.
function historicalIdentity(repository, pr, at) {
  const renames = pr.timelineItems.nodes;
  if (pr.timelineItems.pageInfo.hasNextPage || (pr.lastEditedAt && pr.lastEditedAt >= at) ||
    renames.some(r => r.createdAt === at)) return null;
  const later = renames.filter(r => r.createdAt > at).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const title = later.length ? later[0].previousTitle : pr.title;
  return Buffer.from(`Repository: ${repository}\nTitle: ${title}\n\n${pr.body ?? ''}`, 'utf8');
}

if (process.argv[2] === 'verify') {
  const id = process.argv[3];
  const heldOut = json('held-out-selection.json').selected.some(s => s.id === id);
  assert.ok(heldOut || sample.samples.some(s => s.id === id && s.status === 'evaluated'), 'unknown evaluated sample');
  const manifest = json(heldOut ? `held-out/${id}.manifest.json` : `runs/${id}.manifest.json`);
  const files = readPacket(packetDirectory(id, heldOut), manifest);
  const report = comparePacket({ files, omitted: manifest.omitted,
    total_bytes: files.reduce((sum, f) => sum + f.data.length, 0) }, manifest);
  // Exact directory integrity and bytes, not independently reconstructed selection/omissions.
  console.log(`${id}: exact packet verification ${report.all_match ? 'matches' : 'MISMATCH'}`);
  if (!report.all_match) console.log(JSON.stringify(report, null, 2));
  process.exit(report.all_match ? 0 : 1);
}

if (process.argv[2] === 'rebuild') {
  const id = process.argv[3];
  const s = sample.samples.find(s => s.id === id && s.status === 'evaluated');
  assert.ok(s, 'unknown evaluated sample');
  const manifest = json(`runs/${id}.manifest.json`);
  const base = s.reconstructed_base ?? s.candidate_base;
  const endpoint = `repos/${s.repository}/compare/${base}...${s.head}`;
  const comparison = apiJSON(endpoint);
  validateHistory(comparison, s, manifest);
  const diff = api(endpoint, 'application/vnd.github.diff');
  const packet = select(diff, fetchSources(s.repository, comparison.files, s.head), manifest.limits);
  const report = { schema: 'architecture-review.rebuild.v1', id, builder: 'Justfile test-architecture-review rebuild',
    historical_identity: 'Only matching bytes are reconstructed evidence; no new historical review ran.',
    manifest_sha256: sha256(read(`runs/${id}.manifest.json`)),
    ancestry: { status: comparison.status, merge_base: comparison.merge_base_commit.sha, commits_match: true, pre_feedback: true },
    ...comparePacket(packet, manifest) };
  assert.ok(report.all_match, `reconstructed packet MISMATCH: ${JSON.stringify(report)}`);
  publish(`/tmp/opencode/architecture-review-${id}`, packet, manifest);
  save(`runs/${id}.rebuild.json`, report);
  console.log(`${id}: exact packet matches; details in runs/${id}.rebuild.json`);
  process.exit(0);
}

// Builds a frozen held-out candidate's packet from the selection alone (no
// feedback is fetched) and archives its controller-only manifest; a later
// run must reproduce that manifest exactly.
if (process.argv[2] === 'held-out-packet') {
  const id = process.argv[3];
  const s = json('held-out-selection.json').selected.find(s => s.id === id);
  assert.ok(s, 'unknown held-out candidate');
  const endpoint = `repos/${s.repository}/compare/${s.base}...${s.reviewed_revision}`;
  const comparison = apiJSON(endpoint);
  validateHistory(comparison, { candidate_base: s.base, feedback_at: s.first_feedback_at },
    { first_feedback_at: s.first_feedback_at, commits: s.commits });
  assert.deepEqual(comparison.files.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })),
    s.files, 'changed files differ from the frozen selection');
  const diff = api(endpoint, 'application/vnd.github.diff');
  assert.equal(sha256(diff), s.diff_sha256, 'diff differs from the frozen selection');
  const [owner, name] = s.repository.split('/');
  const response = JSON.parse(text(execFileSync('gh', ['api', 'graphql', '-f', `query=${identityQuery}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${s.pr}`], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 })));
  assert.ok(!response.errors, `identity query: ${JSON.stringify(response.errors)}`);
  const identity = historicalIdentity(s.repository, response.data.repository.pullRequest, s.first_feedback_at);
  const packet = select(diff, fetchSources(s.repository, comparison.files, s.reviewed_revision), heldOutLimits,
    identity ? [{ name: 'identity.md', data: identity }] : []);
  const manifest = { schema: 'architecture-review.packet.v1', id,
    visibility: 'Controller only: the reviewer receives the packet files, never this manifest.',
    repository: s.repository, base: s.base, head: s.reviewed_revision,
    ancestry: { compare_status: comparison.status, merge_base: comparison.merge_base_commit.sha, total_commits: comparison.total_commits },
    commits: s.commits, first_feedback_at: s.first_feedback_at,
    title_description: identity ? 'identity.md: title as of first feedback from rename events; description never edited after it' :
      'unavailable: renamed at first feedback, truncated rename history or description edited after it; current text omitted',
    project_guidance: 'not supplied', limits: heldOutLimits, total_bytes: packet.total_bytes,
    files: packet.files.map(f => ({ name: f.name,
      ...(f.name === 'diff.patch' ? { revision: `${s.base}...${s.reviewed_revision}` } :
        f.path ? { path: f.path, revision: s.reviewed_revision } : {}),
      bytes: f.data.length, sha256: sha256(f.data) })),
    omitted: packet.omitted };
  const file = `held-out/${id}.manifest.json`;
  let frozen = null;
  try { frozen = json(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (frozen) assert.deepEqual(manifest, frozen, `${id}: reconstruction differs from the archived manifest`);
  publish(packetDirectory(id, true), packet, manifest);
  if (!frozen) {
    mkdirSync('docs/architecture-review/held-out', { recursive: true });
    save(file, manifest);
  }
  console.log(`${id}: packet in ${packetDirectory(id, true)} matches ${file}`);
  process.exit(0);
}

if (process.argv[2] === 'feedback') {
  const inventory = { schema: 'architecture-review.feedback.v1', author: 'cgwalters', retrieved_at: new Date().toISOString(),
    purpose: 'Scoring only; never historical reviewer input.', samples: [] };
  for (const s of sample.samples.filter(s => s.status === 'evaluated')) {
    const entry = { id: s.id, channels: [], units: [] };
    for (const [channel, endpoint] of [
      ['inline', `repos/${s.repository}/pulls/${s.pr}/comments`],
      ['review', `repos/${s.repository}/pulls/${s.pr}/reviews`],
      ['pr', `repos/${s.repository}/issues/${s.pr}/comments`],
    ]) {
      let complete = false;
      const pages = [];
      for (let page = 1; page <= 10; page++) {
        const rows = apiJSON(`${endpoint}?per_page=100&page=${page}`);
        pages.push(rows.length);
        for (const r of rows.filter(r => r.user.login === 'cgwalters')) {
          entry.units.push({ channel, id: r.id, url: r.html_url, body: r.body ?? '',
            created_at: r.created_at ?? r.submitted_at, updated_at: r.updated_at ?? null,
            commit_id: r.commit_id ?? null, in_reply_to_id: r.in_reply_to_id ?? null,
            path: r.path ?? null, original_line: r.original_line ?? null, diff_hunk: r.diff_hunk ?? null });
        }
        if (rows.length < 100) { complete = true; break; }
      }
      assert.ok(complete, `pagination cap: ${endpoint}`);
      entry.channels.push({ channel, endpoint, per_page: 100, page_sizes: pages, complete });
    }
    inventory.samples.push(entry);
  }
  save('feedback.json', inventory);
  console.log('Archived paginated cgwalters feedback for three samples; classification is separate.');
  process.exit(0);
}

assert.ok(['test', 'fixtures', 'e2e'].includes(process.argv[2]), 'expected test, fixtures, e2e, rebuild, held-out-packet, verify or feedback');
if (process.argv[2] === 'e2e') test('offline canned-API rebuild/verify dispatch', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const sandbox = fs.mkdtempSync('/tmp/opencode/architecture-review-test-');
  const source = /^```javascript\n([^]*?)^```$/m.exec(fs.readFileSync('docs/architecture-review/checks.md', 'utf8'))[1];
  const id = 'B2588';
  const s = sample.samples.find(s => s.id === id);
  const base = s.reconstructed_base ?? s.candidate_base;
  const endpoint = `repos/${s.repository}/compare/${base}...${s.head}`;
  const diff = '@@ -1 +1 @@\n-old\n+new\n';
  const data = Buffer.from('new\n');
  const packet = select(Buffer.from(diff), [{ path: 'x', revision: s.head, data }], { max_files: 30, max_bytes: 100000 });
  const manifest = { files: packet.files.map(f => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
    total_bytes: packet.total_bytes, omitted: [], limits: { max_files: 30, max_bytes: 100000 },
    first_feedback_at: s.feedback_at, commits: [{ sha: s.head, committed: s.feedback_at }] };
  const history = { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 1,
    commits: [{ sha: s.head, commit: { committer: { date: s.feedback_at } } }], files: [{ filename: 'x', status: 'modified' }] };
  const directory = `${sandbox}/packet`;
  const map = path => typeof path === 'string' && path.startsWith(`/tmp/opencode/architecture-review-${id}`) ?
    path.replace(`/tmp/opencode/architecture-review-${id}`, directory) : path;
  const exit = {};
  let failure = null;
  let calls = 0;
  const wrappedFS = { ...fs };
  for (const method of ['readFileSync', 'lstatSync', 'readdirSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'writeFileSync']) {
    wrappedFS[method] = (path, ...args) => {
      if (path === `docs/architecture-review/runs/${id}.manifest.json` && method === 'readFileSync') return JSON.stringify(manifest);
      if (path === `docs/architecture-review/runs/${id}.rebuild.json` && method === 'writeFileSync') path = `${sandbox}/report.json`;
      if (failure === 'staging' && method === 'writeFileSync' && path.includes('.staging-') && path.endsWith('/head/x')) args[0] = 'damaged staging';
      return fs[method](map(path), ...args);
    };
  }
  wrappedFS.renameSync = (from, to) => fs.renameSync(map(from), map(to));
  const dispatch = mode => {
    let status = null;
    try {
      vm.runInNewContext(source, { Buffer, TextDecoder, console: { log() {} },
        process: { argv: ['node', 'recipe', mode, id], exit(code) { status = code; throw exit; } },
        require(name) {
          if (name === 'node:fs') return wrappedFS;
          if (name === 'node:child_process') return { execFileSync(command, args, options) {
            calls++;
            assert.equal(command, 'gh');
            assert.equal(args[0], 'api');
            assert.equal(options.timeout, 20000);
            assert.equal(options.maxBuffer, 8 * 1024 * 1024);
            if (failure === 'retrieval') throw new Error('canned retrieval failure');
            if (args[1] === endpoint) return Buffer.from(args.includes('Accept: application/vnd.github.diff') ?
              (failure === 'comparison' ? diff + 'bad' : diff) : JSON.stringify(history));
            assert.equal(args[1], `repos/${s.repository}/contents/x?ref=${s.head}`);
            return Buffer.from(JSON.stringify({ type: 'file', encoding: 'base64', content: data.toString('base64'), size: data.length }));
          } };
          return require(name);
        } });
    } catch (error) {
      if (error !== exit) return { status: 1, error };
    }
    return { status };
  };
  const succeeds = mode => { const result = dispatch(mode); assert.equal(result.status, 0, `${mode}: ${result.error?.stack ?? ''}`); };
  const fails = mode => assert.equal(dispatch(mode).status, 1, mode);
  try {
    succeeds('rebuild');
    succeeds('verify');
    const before = calls;
    for (const [name, kind] of [['head/obsolete.txt', 'file'], ['feedback.json', 'file'],
      ['feedback', 'directory'], ['head/extra', 'directory'], ['head/link', 'symlink']]) {
      const path = `${directory}/${name}`;
      if (kind === 'directory') fs.mkdirSync(path);
      else if (kind === 'symlink') fs.symlinkSync(`${directory}/diff.patch`, path);
      else fs.writeFileSync(path, 'stale feedback');
      fails('verify');
      succeeds('rebuild');
      assert.equal(fs.existsSync(path), false, name);
      succeeds('verify');
    }
    assert.ok(calls > before);
    succeeds('rebuild'); // Repeated reconstruction has the same exact packet.
    for (const name of ['diff.patch', 'head/x']) {
      fs.rmSync(`${directory}/${name}`);
      fs.symlinkSync(`${sandbox}/report.json`, `${directory}/${name}`);
      fails('verify');
      succeeds('rebuild');
    }
    fs.renameSync(`${directory}/head`, `${sandbox}/old-head`);
    fs.symlinkSync(`${sandbox}/old-head`, `${directory}/head`);
    fails('verify');
    succeeds('rebuild');
    fs.renameSync(directory, `${sandbox}/old-packet`);
    fs.symlinkSync(`${sandbox}/old-packet`, directory);
    fails('verify');
    succeeds('rebuild');
    fs.writeFileSync(`${directory}/head/x`, 'bad\n');
    fails('verify');
    for (const reason of ['retrieval', 'comparison', 'staging']) {
      failure = reason;
      const oldReport = fs.readFileSync(`${sandbox}/report.json`, 'utf8');
      fails('rebuild');
      assert.equal(fs.readFileSync(`${directory}/head/x`, 'utf8'), 'bad\n', 'failed rebuild does not publish');
      assert.equal(fs.readFileSync(`${sandbox}/report.json`, 'utf8'), oldReport);
      fails('verify');
      fs.rmSync(directory, { recursive: true });
      fails('rebuild');
      assert.equal(fs.existsSync(directory), false, 'failed rebuild does not create a packet');
      failure = null;
      succeeds('rebuild');
      fs.writeFileSync(`${directory}/head/x`, 'bad\n');
    }
    fs.rmSync(`${directory}/head/x`);
    fails('verify');
    failure = null;
    succeeds('rebuild');
    succeeds('verify');
    assert.deepEqual(fs.readdirSync(sandbox).filter(n => n.includes('.staging-')), []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
test('offline packet annotation and selection fixtures', () => {
  const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n\\ No newline at end of file\n';
  assert.equal(annotate(diff), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n     -old\n   1 +new\n   2  same\n\\ No newline at end of file\n');
  assert.equal(annotate('@@ -0,0 +1 @@\n+é\r\n'), '@@ -0,0 +1 @@\n   1 +é\r\n');
  assert.equal(annotate('@@ -1 +0,0 @@\n-x'), '@@ -1 +0,0 @@\n     -x');
  const sources = ['z', 'a', 'large'].map(path => ({ path, data: Buffer.from(path === 'large' ? 'xxx' : 'é') }));
  const packet = select(Buffer.from(''), sources, { max_files: 2, max_bytes: 2 });
  assert.deepEqual(packet.files.map(f => f.name), ['diff.patch', 'head/a']);
  assert.equal(packet.total_bytes, 2);
  assert.equal(packet.omitted.length, 2);
  assert.equal(select(Buffer.from(''), sources, { max_files: 30, max_bytes: 4 }).files.length, 3);
  assert.equal(select(Buffer.from(''), sources, { max_files: 1, max_bytes: 100 }).files.length, 1);
  assert.equal(select(Buffer.from(''), sources, { max_files: 30, max_bytes: 1 }).files.length, 1);
  assert.throws(() => select(Buffer.from('abc'), [], { max_files: 30, max_bytes: 2 }));
  assert.throws(() => select(Buffer.from(''), [{ path: 'a/b', data: Buffer.from('') }, { path: 'a__b', data: Buffer.from('') }], { max_files: 30, max_bytes: 10 }));
  assert.throws(() => text(Buffer.from([255])));
  const binary = select(Buffer.from(''), [{ path: 'b', data: Buffer.from([255]) }, ...sources], { max_files: 30, max_bytes: 100 });
  assert.deepEqual(binary.files.map(f => f.name), ['diff.patch', 'head/a', 'head/z', 'head/large']);
  assert.deepEqual(binary.omitted.map(o => [o.path, o.reason]), [['b', 'not UTF-8 text; diff.patch records the binary change']]);
  const context = [{ name: 'identity.md', data: Buffer.from('id') }];
  assert.deepEqual(select(Buffer.from(''), sources, { max_files: 2, max_bytes: 3 }, context).files.map(f => f.name), ['diff.patch', 'identity.md']);
  assert.throws(() => select(Buffer.from(''), sources, { max_files: 1, max_bytes: 100 }, context));
  assert.throws(() => select(Buffer.from(''), sources, { max_files: 30, max_bytes: 1 }, context));
  const renamed = { title: 'new', body: 'text\r\n', lastEditedAt: null,
    timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ createdAt: '2026-01-03T00:00:00Z', previousTitle: 'old' },
      { createdAt: '2026-01-01T00:00:00Z', previousTitle: 'older' }, { createdAt: '2026-01-04T00:00:00Z', previousTitle: 'mid' }] } };
  const at = '2026-01-02T00:00:00Z';
  assert.equal(text(historicalIdentity('o/r', renamed, at)), 'Repository: o/r\nTitle: old\n\ntext\r\n');
  assert.equal(text(historicalIdentity('o/r', { ...renamed, body: null, lastEditedAt: '2026-01-01T00:00:00Z' }, '2026-01-05T00:00:00Z')),
    'Repository: o/r\nTitle: new\n\n');
  for (const change of [{ lastEditedAt: at }, { lastEditedAt: '2026-01-03T00:00:00Z' },
    { timelineItems: { ...renamed.timelineItems, pageInfo: { hasNextPage: true } } },
    { timelineItems: { ...renamed.timelineItems, nodes: [{ createdAt: at, previousTitle: 'x' }] } }]) {
    assert.equal(historicalIdentity('o/r', { ...renamed, ...change }, at), null);
  }
  const manifest = { files: packet.files.map(f => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })), total_bytes: 2, omitted: packet.omitted };
  assert.equal(comparePacket(packet, manifest).all_match, true);
  assert.equal(comparePacket({ ...packet, files: packet.files.map(f => ({ ...f, data: Buffer.from('bad') })) }, manifest).all_match, false);
  assert.equal(comparePacket(packet, { ...manifest, total_bytes: 3 }).all_match, false);
  assert.equal(comparePacket(packet, { ...manifest, omitted: [] }).all_match, false);
  assert.equal(comparePacket(packet, { ...manifest, files: manifest.files.map(f => ({ ...f, sha256: '0'.repeat(64) })) }).all_match, false);
  assert.equal(comparePacket({ ...packet, files: [...packet.files].reverse() }, manifest).all_match, false);
  const s = { candidate_base: 'base', feedback_at: '2026-01-02T00:00:00Z' };
  const commits = [{ sha: 'head', commit: { committer: { date: '2026-01-01T00:00:00Z' } } }];
  const history = { status: 'ahead', merge_base_commit: { sha: 'base' }, total_commits: 1, commits, files: [] };
  const frozen = { first_feedback_at: s.feedback_at, commits: [{ sha: 'head', committed: '2026-01-01T00:00:00Z' }] };
  validateHistory(history, s, frozen);
  assert.throws(() => validateHistory({ ...history, status: 'diverged' }, s, frozen));
  assert.throws(() => validateHistory({ ...history, merge_base_commit: { sha: 'wrong' } }, s, frozen));
  assert.throws(() => validateHistory({ ...history, total_commits: 2 }, s, frozen));
  assert.throws(() => validateHistory({ ...history, files: Array(300).fill({}) }, s, frozen));
  assert.throws(() => validateHistory(history, { ...s, feedback_at: '2025-01-01T00:00:00Z' }, { ...frozen, first_feedback_at: '2025-01-01T00:00:00Z' }));
  assert.throws(() => validateHistory(history, s, { ...frozen, commits: [] }));
});

// The frozen selection: an ordered prefix of discovery, five accepted PRs
// outside every exclusion, and history that precedes first feedback.
function validateHeldOutSelection(h, sel) {
  assert.equal(sel.schema, 'architecture-review.held-out-selection.v1');
  const order = sel.discovery.flatMap(d => d.results.map(r => `${d.repository}#${r.pr}`));
  assert.equal(order.length, h.denominators.discovered_prs);
  assert.ok(order.length <= h.discovery_cap);
  assert.ok(sel.discovery.every(d => d.status === 'failed' || (d.incomplete_results === false && d.results.length === d.per_page)));
  const examined = sel.examined.map(e => `${e.repository}#${e.pr}`);
  // A failed search may only follow every examined PR: selection never skips a repository.
  const failed = sel.discovery.findIndex(d => d.status !== 'ok');
  assert.ok(failed === -1 || sel.discovery.slice(failed).every(d => !examined.some(e => e.startsWith(`${d.repository}#`))),
    'examined past a failed search');
  assert.deepEqual(examined, order.slice(0, examined.length), 'examined out of discovery order');
  assert.equal(examined.length, h.denominators.examined_prs);
  const accepted = sel.examined.filter(e => e.decision === 'accepted');
  assert.ok(sel.examined.every(e => ['accepted', 'rejected'].includes(e.decision) && (e.reason || e.contract)));
  assert.equal(accepted.length, h.minimum_eligible_prs);
  assert.equal(sel.examined.at(-1).decision, 'accepted', 'examination continued past the fifth eligible PR');
  const excluded = [...h.pilot_exclusions, ...h.derivation_inventory.exclusions];
  assert.ok(accepted.every(e => !excluded.includes(`${e.repository}#${e.pr}`)), 'excluded PR accepted');
  assert.deepEqual(h.candidates, sel.selected.map(s => ({ id: s.id, repository: s.repository, pr: s.pr })));
  assert.deepEqual(accepted.map(e => `${e.repository}#${e.pr}`), sel.selected.map(s => `${s.repository}#${s.pr}`));
  for (const s of sel.selected) {
    const e = accepted.find(e => e.repository === s.repository && e.pr === s.pr);
    assert.ok(e.contract && e.changed_symbols.length > 0 && s.base_method, s.id);
    assert.deepEqual(e.channels.map(c => c.channel), ['inline', 'review', 'pr'], `${s.id}: channels`);
    assert.ok(e.channels.every(c => c.complete), `${s.id}: truncated channel`);
    assert.equal(s.first_feedback_at, e.first_feedback.at);
    assert.equal(s.reviewed_revision, e.first_feedback.commit_id);
    assert.match(s.reviewed_revision, /^[a-f0-9]{40}$/);
    assert.ok(s.commits.length > 0 && s.commits.at(-1).sha === s.reviewed_revision, `${s.id}: head`);
    assert.ok(s.commits.every(c => c.committed <= s.first_feedback_at) && s.base_committed <= s.first_feedback_at, `${s.id}: post-feedback history`);
  }
}

// Archived manifests of the held-out packets: frozen history, the shared
// limits, the complete diff first and the counted identity file beside it.
function validateHeldOutPackets(h, sel) {
  assert.deepEqual(h.packets.map(p => p.id), h.candidates.map(c => c.id), 'a packet for each candidate, in order');
  for (const p of h.packets) {
    assert.equal(p.manifest, `held-out/${p.id}.manifest.json`);
    assert.equal(sha256(read(p.manifest)), p.manifest_sha256, p.id);
    const m = json(p.manifest);
    const s = sel.selected.find(s => s.id === p.id);
    assert.equal(m.id, p.id);
    assert.equal(m.repository, s.repository, p.id);
    assert.equal(m.base, s.base, p.id);
    assert.equal(m.head, s.reviewed_revision, p.id);
    assert.equal(m.first_feedback_at, s.first_feedback_at, p.id);
    assert.deepEqual(m.commits, s.commits, p.id);
    assert.deepEqual(m.ancestry, { compare_status: 'ahead', merge_base: s.base, total_commits: s.commits.length }, p.id);
    assert.deepEqual(m.limits, heldOutLimits, p.id);
    assert.equal(m.files[0].name, 'diff.patch', p.id);
    assert.equal(m.files.some(f => f.name === 'identity.md'), m.title_description.startsWith('identity.md'), p.id);
    assert.ok(m.files.length <= m.limits.max_files, p.id);
    assert.equal(m.total_bytes, m.files.reduce((sum, f) => sum + f.bytes, 0), p.id);
    assert.ok(m.total_bytes <= m.limits.max_bytes, p.id);
  }
}

// This ledger is a checkpoint before any review, not a schema for completed
// runs. A future execution must add evidence validation before accepting scores.
function validateHeldOutCheckpoint(h, sel) {
  assert.equal(h.schema, 'architecture-review.held-out.v1');
  assert.equal(h.status, 'unfinished');
  assert.equal(h.held_out_claim, false);
  assert.match(h.frozen_from_revision, /^[a-f0-9]{40}$/);
  assert.equal(h.minimum_eligible_prs, 5);
  assert.equal(h.discovery_cap, 60);
  assert.deepEqual(Object.keys(h.artifact_sha256).sort(), ['patterns.md', 'prompt.md', 'references.json']);
  for (const [file, digest] of Object.entries(h.artifact_sha256)) assert.equal(sha256(read(file)), digest, file);
  assert.equal(h.protocol_sha256, sha256(read('held-out-protocol.md')));
  assert.deepEqual([...h.pilot_exclusions].sort(), sample.samples.map(s => `${s.repository}#${s.pr}`).sort());
  assert.equal(h.derivation_inventory.status, 'complete');
  assert.ok(h.derivation_inventory.sources.length > 0);
  assert.equal(new Set(h.derivation_inventory.exclusions).size, h.derivation_inventory.exclusions.length);
  assert.ok(h.pilot_exclusions.every(p => h.derivation_inventory.exclusions.includes(p)));
  assert.deepEqual(h.prerequisites, { inference: 'unavailable', isolation: 'unverified', candidate_eligibility: 'verified' });
  assert.ok(h.blockers.length > 0 && h.blockers.every(b => typeof b === 'string' && b.length > 0));
  assert.equal(h.candidate_feedback_accessed, 'metadata-only');
  assert.equal(h.selection_sha256, sha256(read('held-out-selection.json')));
  validateHeldOutSelection(h, sel);
  validateHeldOutPackets(h, sel);
  for (const key of ['runs', 'scoring_runs']) assert.deepEqual(h[key], []);
  assert.deepEqual(h.denominators, { ...h.denominators, selected_prs: h.candidates.length,
    eligible_prs: h.candidates.length, packet_complete_prs: h.packets.length, attempted_prs: 0, completed_prs: 0,
    contaminated_prs: 0, scored_prs: 0 });
  assert.equal(h.scores, null, 'no scores without isolated reviews and separate scoring evidence');
  assert.match(h.human_adjudication, /Not obtained/);
}

test('held-out freeze, exclusion inventory, frozen selection and unexecuted denominators', () => {
  const h = json('held-out.json');
  const sel = json('held-out-selection.json');
  validateHeldOutCheckpoint(h, sel);
  const [first] = sel.selected;
  const accepted = sel.examined.findIndex(e => e.decision === 'accepted');
  const invalid = [
    { status: 'completed' }, { held_out_claim: true }, { scores: {} },
    { candidate_feedback_accessed: true }, { minimum_eligible_prs: 4 },
    { discovery_cap: 39 }, { pilot_exclusions: h.pilot_exclusions.slice(0, -1) },
    { pilot_exclusions: [...h.pilot_exclusions, h.pilot_exclusions[0]] },
    { artifact_sha256: { ...h.artifact_sha256, 'prompt.md': '0'.repeat(64) } },
    { protocol_sha256: '0'.repeat(64) }, { selection_sha256: '0'.repeat(64) },
    { derivation_inventory: { ...h.derivation_inventory, status: 'pending' } },
    { derivation_inventory: { ...h.derivation_inventory, exclusions: [...h.derivation_inventory.exclusions, 'bootc-dev/bootc#105'] } },
    { prerequisites: { ...h.prerequisites, isolation: 'verified' } },
    { candidates: [{ id: 'B2603', repository: 'bootc-dev/bootc', pr: 2603 }, ...h.candidates.slice(1)] },
    { candidates: h.candidates.slice(1) },
    { runs: [{ id: 'invented' }] }, { scoring_runs: [{ id: 'invented' }] },
    { packets: h.packets.slice(1) }, { packets: [...h.packets].reverse() },
    { packets: h.packets.map((p, i) => i ? p : { ...p, manifest_sha256: '0'.repeat(64) }) },
    { packets: h.packets.map((p, i) => i ? p : { ...p, manifest: 'runs/B2588.manifest.json' }) },
    { blockers: [] },
    ...Object.keys(h.denominators).map(key => ({ denominators: { ...h.denominators, [key]: h.denominators[key] + 1 } })),
  ];
  for (const change of invalid) assert.throws(() => validateHeldOutCheckpoint({ ...h, ...change }, sel));
  const invalidSelection = [
    { examined: [...sel.examined].reverse() },
    { examined: sel.examined.map((e, i) => i === accepted ? { ...e, decision: 'rejected', reason: 'x' } : e) },
    { examined: [...sel.examined, { ...sel.examined[0], decision: 'rejected', reason: 'x' }] },
    { selected: [{ ...first, first_feedback_at: '2000-01-01T00:00:00Z' }, ...sel.selected.slice(1)] },
    { selected: [{ ...first, reviewed_revision: '0'.repeat(40) }, ...sel.selected.slice(1)] },
    { selected: [{ ...first, commits: [] }, ...sel.selected.slice(1)] },
    { discovery: sel.discovery.map(d => ({ ...d, incomplete_results: true })) },
    { discovery: [...sel.discovery, sel.discovery[0]] },
    { discovery: [{ ...sel.discovery[0], status: 'failed' }, ...sel.discovery.slice(1)] },
    { examined: sel.examined.map((e, i) => i === accepted ? { ...e, channels: e.channels.slice(1) } : e) },
    { selected: [{ ...first, base_method: undefined }, ...sel.selected.slice(1)] },
  ];
  for (const change of invalidSelection) assert.throws(() => validateHeldOutSelection(h, { ...sel, ...change }));
});

function validateCounts(r) {
  const evaluated = sample.samples.filter(s => s.status === 'evaluated');
  assert.equal(r.selected_prs, sample.samples.length);
  assert.equal(r.evaluated_prs, evaluated.length);
  assert.equal(r.evaluated_prs + r.rejected_prs, r.selected_prs);
  assert.equal(r.architecture_concerns + r.excluded_nits + r.excluded_acknowledgements + r.excluded_empty_reviews,
    r.classification_units);
  assert.equal(r.classification_units, r.audited_feedback_records + r.split_extra_units);
  assert.equal(r.audited_feedback_records, r.audited_inline_comments + r.audited_review_bodies + r.audited_pr_comments);
  assert.equal(r.architecture_concerns, r.concerns.length);
  assert.equal(r.executed_reviews, r.runs.length);
  assert.deepEqual(r.runs.map(run => run.id), evaluated.map(s => s.id));
  assert.ok(r.compared_prs <= r.executed_reviews);
  assert.equal(r.status, 'development_pilot');
  assert.equal(r.held_out_claim, false);
  for (const c of r.concerns) {
    assert.ok(['concern', 'question'].includes(c.stratum), c.id);
    assert.ok(r.runs.some(run => c.id.startsWith(`${run.id}-`)), c.id);
    if (c.matched_by) assert.ok(c.scorable && c.matched_by.startsWith(c.id.split('-')[0]), c.id);
    if (!c.scorable) assert.ok(c.unscorable_reason, c.id);
  }
  for (const f of Object.values(r.findings)) assert.equal(f.matched + f.unmatched, f.total);
  for (const [key, stratum] of [['concerns', 'concern'], ['questions', 'question']]) {
    const units = r.concerns.filter(c => c.stratum === stratum);
    const counts = r.strata[key];
    assert.equal(counts.total, units.length);
    assert.equal(counts.scorable, units.filter(c => c.scorable).length);
    assert.equal(counts.matched, units.filter(c => c.matched_by).length);
    assert.equal(counts.missed, counts.scorable - counts.matched);
    assert.equal(counts.unscorable, counts.total - counts.scorable);
  }
  const a = r.unmatched_audit;
  assert.equal(a.supported + a.unsupported + a.unresolved, a.audited);
  assert.ok(a.audited <= r.findings.defects.unmatched + r.findings.questions.unmatched);
}

test('explicit version and pinned, publicly linked source files', () => {
  assert.equal(version, '0.1.0');
  assert.equal(results.version, version);
  assert.equal(references.references.length, 9);
  for (const [file, digest] of Object.entries(results.artifact_sha256)) {
    assert.equal(sha256(read(file)), digest, file);
  }
  const ids = new Set();
  for (const r of references.references) {
    assert.match(r.revision, /^[a-f0-9]{40}$/);
    assert.ok(r.sections.length > 0);
    assert.ok(!ids.has(r.id));
    ids.add(r.id);
    assert.ok(read('README.md').includes(
      `https://github.com/${r.repository}/blob/${r.revision}/${r.path}`));
  }
});

test('six scoped architecture patterns with explicitly illustrative examples', () => {
  const library = read('patterns.md');
  const sections = library.split(/^## /m).slice(1);
  assert.equal(sections.length, 6);
  sections.forEach((s, i) => {
    assert.ok(s.startsWith(`AR-0${i + 1}:`));
    for (const label of ['Principle', 'Scope/exceptions', 'Source',
      'Good (illustrative)', 'Bad (illustrative)']) assert.ok(s.includes(`**${label}:**`));
    assert.ok(references.references.some(r => s.includes(r.id)));
  });
});

test('prompt covers design dimensions, evidence, uncertainty and read-only boundary', () => {
  const prompt = read('prompt.md');
  assert.ok(prompt.includes(`prompt ${version}`));
  for (const dimension of ['Invariants', 'State ownership', 'Failure and rollback',
    'Compatibility and interfaces', 'Dependency ordering', 'Privilege boundaries', 'Testing']) {
    assert.ok(prompt.includes(`**${dimension}:**`));
  }
  for (const phrase of ['untrusted **data**', 'Do not execute', 'Do not edit files',
    'concrete PR evidence', 'Uncertainty/questions', 'nit-checklist',
    '100,000', 'contaminated', 'Archive this output unchanged', 'references.json'
  ]) assert.ok(prompt.includes(phrase));
});

test('sample pins are separate from derivation and not leaked into prompt/library', () => {
  const ids = new Set(sample.samples.map(s => s.id));
  assert.equal(ids.size, sample.samples.length);
  for (const s of sample.samples) {
    assert.ok(['evaluated', 'rejected'].includes(s.status), s.id);
    if (s.status === 'rejected') assert.ok(s.rejection, s.id);
    // A later replacement must name what it replaces, never substitute silently.
    if (!s.frozen_before_prompt_authoring) {
      assert.equal(sample.samples.find(r => r.id === s.replaces)?.status, 'rejected', s.id);
    }
    for (const sha of [s.head, s.candidate_base, ...(s.reconstructed_base ? [s.reconstructed_base] : [])]) {
      assert.match(sha, /^[a-f0-9]{40}$/);
      assert.ok(!references.references.some(r => r.revision === sha));
      for (const file of ['patterns.md', 'prompt.md']) assert.ok(!read(file).includes(sha));
    }
    for (const file of ['patterns.md', 'prompt.md']) {
      assert.ok(!read(file).includes(`/${s.repository}/pull/${s.pr}`));
    }
    assert.ok(s.review.startsWith(`https://github.com/${s.repository}/pull/${s.pr}#`));
  }
});

test('archived runs match their pinned packets and recorded hashes', () => {
  for (const run of results.runs) {
    const s = sample.samples.find(x => x.id === run.id);
    const manifest = json(run.manifest);
    assert.equal(manifest.head, s.head, run.id);
    assert.equal(manifest.base, s.reconstructed_base ?? s.candidate_base, run.id);
    assert.equal(manifest.ancestry.compare_status, 'ahead', run.id);
    assert.ok(manifest.commits.every(c => c.committed <= s.feedback_at), run.id);
    assert.ok(manifest.files.length <= manifest.limits.max_files, run.id);
    assert.ok(manifest.total_bytes <= manifest.limits.max_bytes, run.id);
    assert.equal(sha256(read(run.manifest)), run.manifest_sha256, run.id);
    const output = read(run.output);
    assert.equal(sha256(output), run.output_sha256, run.id);
    assert.ok(output.startsWith('Architecture review'), run.id);
    assert.ok(output.includes(s.head), run.id);
  }
});

function validateReportIDs(reports) {
  const ids = reports.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate rebuild report ID');
  assert.deepEqual([...ids].sort(), sample.samples.filter(s => s.status === 'evaluated').map(s => s.id).sort(),
    'rebuild report IDs must exactly cover evaluated runs');
}

test('rebuild reports compare every recorded size/digest and selection with frozen manifests', () => {
  const reports = results.packet_rebuilds.map(json);
  validateReportIDs(reports);
  assert.throws(() => validateReportIDs([reports[0], reports[0], reports[0]]), /duplicate/);
  assert.throws(() => validateReportIDs(reports.slice(1)), /exactly cover/);
  assert.throws(() => validateReportIDs(reports.map((r, i) => i ? r : { ...r, id: 'unknown' })), /exactly cover/);
  for (const report of reports) {
    const run = results.runs.find(r => r.id === report.id);
    const manifest = json(run.manifest);
    assert.equal(report.manifest_sha256, sha256(read(run.manifest)));
    assert.equal(report.expected_total_bytes, manifest.total_bytes);
    assert.equal(report.actual_total_bytes, manifest.total_bytes);
    assert.deepEqual(report.expected_file_order, manifest.files.map(f => f.name));
    assert.deepEqual(report.actual_file_order, report.expected_file_order);
    assert.deepEqual(report.expected_omitted, manifest.omitted);
    assert.deepEqual(report.actual_omitted, manifest.omitted);
    assert.equal(report.files.length, manifest.files.length);
    report.files.forEach((file, i) => {
      const expected = manifest.files[i];
      assert.equal(file.name, expected.name);
      assert.equal(file.expected_bytes, expected.bytes);
      assert.equal(file.actual_bytes, expected.bytes);
      assert.equal(file.expected_sha256, expected.sha256);
      assert.equal(file.actual_sha256, expected.sha256);
      assert.equal(file.match, true);
    });
    for (const flag of ['all_match', 'ordering_match', 'total_match', 'omissions_match']) assert.equal(report[flag], true);
    assert.equal(report.ancestry.status, 'ahead');
    assert.equal(report.ancestry.merge_base, manifest.base);
    assert.equal(report.ancestry.pre_feedback, true);
    assert.equal(report.ancestry.commits_match, true);
  }
});

test('all paginated feedback records have explicit root-deduplicated dispositions', () => {
  const inventory = json(results.feedback_inventory);
  const scoring = json(results.independent_scoring);
  assert.equal(scoring.provenance.feedback_sha256, sha256(read(results.feedback_inventory)));
  assert.equal(inventory.author, 'cgwalters');
  assert.deepEqual(inventory.samples.map(s => s.id), results.runs.map(r => r.id));
  const records = inventory.samples.flatMap(s => s.units);
  assert.equal(records.length, results.audited_feedback_records);
  assert.equal(new Set(records.map(r => r.id)).size, records.length);
  assert.equal(scoring.units.length, records.length);
  for (const [channel, count] of [['inline', results.audited_inline_comments], ['review', results.audited_review_bodies], ['pr', results.audited_pr_comments]]) {
    assert.equal(records.filter(r => r.channel === channel).length, count);
  }
  for (const entry of inventory.samples) {
    assert.deepEqual(entry.channels.map(c => c.channel), ['inline', 'review', 'pr']);
    for (const channel of entry.channels) {
      assert.equal(channel.complete, true);
      assert.equal(channel.per_page, 100);
      assert.ok(channel.page_sizes.length > 0 && channel.page_sizes.length <= 10);
      assert.ok(channel.page_sizes.at(-1) < 100);
      assert.ok(channel.page_sizes.slice(0, -1).every(n => n === 100));
    }
    const frozen = sample.samples.find(s => s.id === entry.id);
    assert.equal(entry.units.map(u => u.created_at).sort()[0], frozen.feedback_at);
    for (const record of entry.units) {
      const units = scoring.units.filter(u => u.record_id === record.id);
      assert.equal(units.length, 1);
      const unit = units[0];
      assert.equal(unit.sample, entry.id);
      assert.equal(unit.url, record.url);
      assert.ok(unit.reason);
      assert.ok(['concern', 'question', 'nit', 'empty'].includes(unit.classification));
      if (unit.classification === 'empty') assert.equal(record.body, '');
      for (const root of unit.roots) {
        const concern = results.concerns.find(c => c.id === root);
        assert.ok(concern, root);
        assert.equal(concern.stratum, unit.classification);
        assert.equal(concern.scorable, unit.scorable);
        assert.equal(concern.matched_by, unit.matched_by);
      }
    }
  }
  const roots = scoring.units.flatMap(u => u.roots);
  assert.equal(new Set(roots).size, roots.length);
  assert.deepEqual([...roots].sort(), results.concerns.map(c => c.id).sort());
  assert.equal(scoring.units.filter(u => u.classification === 'nit').length, results.excluded_nits);
  assert.equal(scoring.units.filter(u => u.classification === 'empty').length, results.excluded_empty_reviews);
  assert.equal(results.scoring_passes, 2);
  assert.match(results.human_adjudication, /not obtained/);
  const totals = scoring.independent_totals;
  for (const [key, value] of Object.entries({ feedback_records: records.length, roots: roots.length,
    scorable_concerns: results.strata.concerns.scorable, matched_concerns: results.strata.concerns.matched,
    scorable_questions: results.strata.questions.scorable, matched_questions: results.strata.questions.matched,
    unscorable_concerns: results.strata.concerns.unscorable, excluded_nits: results.excluded_nits,
    excluded_empty_reviews: results.excluded_empty_reviews })) assert.equal(totals[key], value);
  assert.equal(scoring.finding_dispositions.length, results.findings.defects.total + results.findings.questions.total);
  assert.equal(scoring.finding_dispositions.filter(f => f.matched_by_feedback).length, results.findings.questions.matched);
  for (const key of ['supported', 'unsupported', 'unresolved']) {
    assert.equal(scoring.finding_dispositions.filter(f => f.audit === key).length, results.unmatched_audit[key]);
  }
});

test('evaluation counts are consistent and make no held-out claim', () => {
  validateCounts(results);
  assert.throws(() => validateCounts({ ...results, architecture_concerns: 4 }));
  assert.throws(() => validateCounts({ ...results, executed_reviews: 2 }));
  assert.throws(() => validateCounts({ ...results, held_out_claim: true }));
  assert.throws(() => validateCounts({
    ...results, concerns: results.concerns.map(c => ({ ...c, scorable: true, unscorable_reason: undefined, matched_by: c.matched_by ?? 'X1' })),
  }));
  assert.throws(() => validateCounts({
    ...results, unmatched_audit: { ...results.unmatched_audit, supported: 3 },
  }));
});
```
