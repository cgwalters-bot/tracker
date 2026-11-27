# Code review checklist: frozen split and labelling

> This text is LLM generated.

This directory holds the inputs for mining the code style and nit checklist
([#1231](https://github.com/cgwalters-forge/tracker/issues/1231)). It is not the
checklist yet: no training PR has been labelled here.

- [provenance.json](provenance.json) is the splitter's record of the frozen split
  of [review-corpus-20261120-135903](https://github.com/cgwalters-forge/tracker/releases/tag/review-corpus-20261120-135903):
  snapshot checksums (matching that release's `SHA256SUMS`), the fixed cutoff,
  output hashes and counts (4,238 training PRs, 457 held out).
- [holdout.md](holdout.md) lists the held-out PRs, URLs only. Never open their
  feedback while mining or labelling; it is reserved for evaluation (#1232).
- [taxonomy.md](taxonomy.md) defines the candidate rule tags that labels use.

The corpus itself stays outside git. To reproduce the split, download and verify
the tag and run the splitter as in [Preparing the frozen checklist
split](../../review-corpus.md#preparing-the-frozen-checklist-split); its
`provenance.json` and the contents of the fence in [holdout.md](holdout.md) must
be byte-identical to the splitter's `provenance.json` and `holdout.txt`.

## Sharding and labelling

Labelling is done one shard at a time so that each run stays within a bounded
context. The helper below has three explicit modes and nothing calls it
automatically. Each refuses a `training.jsonl` whose SHA-256 differs from
`training_sha256` in the given provenance, so shards and samples always come from
this frozen split, never from a newer corpus or one that includes held-out PRs.
Run it from this repository like the splitter, with paths outside git:

```sh
node -e 'eval(require("node:fs").readFileSync("docs/review-checklist/code/README.md", "utf8").split("```js label-shards\n")[1].split("\n```")[0]); main(process.argv.slice(1))' -- shard docs/review-checklist/code/provenance.json split/training.jsonl new-shards
```

- `shard PROVENANCE TRAINING NEW_OUTPUT` sorts the training PRs by canonical URL
  (the splitter's lowercased `https://github.com/OWNER/REPO/pull/N`) and writes
  `shard-001.jsonl`, `shard-002.jsonl`, …, each holding every record of at most
  500 PRs, plus `shards.json` with each shard's SHA-256 and counts. The output
  directory must not exist yet. The same split always gives the same shards.
- `sample PROVENANCE TRAINING SEED N` prints at most 400 training PR URLs, ranked
  by SHA-256 of the JSON pair `[SEED, URL]`. [taxonomy.md](taxonomy.md) records the
  seed it was built from.
- `validate PROVENANCE TRAINING TAXONOMY HOLDOUT SHARD LABELS` checks a label
  file against the taxonomy and [holdout.md](holdout.md). Use the committed
  provenance, taxonomy and holdout files, the original training split, and a
  shard with its generated filename. Validation checks the holdout digest and
  regenerates the expected shard digest from the verified training split before
  reading labels. It prints the verified shard digest and tag counts.

A label file has one compact JSON object per line, exactly one for each PR in
its shard. Write each line with `JSON.stringify`: the validator rejects any
line that does not round-trip byte for byte, including duplicate keys at any
depth. Write UTF-8 with LF line endings:

```json
{"pr":"https://github.com/owner/repo/pull/12","tags":["rust-combinators"],"examples":{"rust-combinators":["https://github.com/owner/repo/pull/12#discussion_r34"]}}
```

`pr` is the canonical URL; `tags` lists distinct tag ids from the taxonomy
(possibly none); `examples` maps some of those tags to at most three comment URLs
each, which must be the `url` of a record of that PR in the shard and have the
form of a review or PR comment URL. A PR listed in the holdout is refused. No
other field is accepted. Threat: label files are committed, and later mining steps read them.
Carrying comment text, or citing comments from held-out or other PRs, would
copy untrusted feedback into the repository and leak evaluation material; the
validator admits only identities and tag ids. Errors name line numbers, never
record text. Inputs are bounded to 128 MiB and 250,000 records (training and
shards), 1 MiB (metadata and taxonomy) and 16 MiB (labels). That label limit
fits 500 PRs with 32 tags each, 64 characters per tag, and up to three example
URLs per tag. Both PR and example URLs are at most 256 characters.

```js label-shards
// Explicit offline helper for labelling the #1231 training split.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHARD_PRS = 500;
const MAX_SAMPLE = 400;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_SMALL = 1024 * 1024;
const MAX_LABEL_BYTES = 16 * 1024 * 1024;
const MAX_URL = 256;
const MAX_RECORDS = 250000;
const MAX_TAGS = 32;
const MAX_EXAMPLES = 3;
const TAG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PR = /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9][0-9]*$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readBounded(filename, limit) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    requireThat(fs.fstatSync(fd).isFile(), `${path.basename(filename)} is not a regular file`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    let n;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    requireThat(size <= limit, `${path.basename(filename)} exceeds ${limit} bytes`);
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

const decode = (bytes, what) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`${what} is not valid UTF-8`); }
};

// Groups records by PR without echoing any record text in errors.
function readRecords(bytes, what) {
  const lines = decode(bytes, what).split('\n');
  if (lines.at(-1) === '') lines.pop();
  requireThat(lines.length > 0 && lines.length <= MAX_RECORDS, `${what}: expected 1..${MAX_RECORDS} records`);
  const prs = new Map();
  lines.forEach((line, index) => {
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`${what}: invalid JSON at record ${index + 1}`); }
    requireThat(r?.schema_version === 1 && typeof r.repository === 'string'
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository) && Number.isSafeInteger(r.pr_number)
      && r.pr_number > 0 && typeof r.url === 'string', `${what}: invalid metadata at record ${index + 1}`);
    const key = `https://github.com/${r.repository.toLowerCase()}/pull/${r.pr_number}`;
    if (!prs.has(key)) prs.set(key, { lines: [], urls: new Set() });
    prs.get(key).lines.push(line);
    prs.get(key).urls.add(r.url);
  });
  return prs;
}

function readTraining(provenanceFile, trainingFile) {
  let provenance;
  try { provenance = JSON.parse(decode(readBounded(provenanceFile, MAX_SMALL), 'provenance')); }
  catch { throw new Error('invalid provenance JSON'); }
  requireThat(provenance?.schema === 'review-checklist.split.v1' && /^[0-9a-f]{64}$/.test(provenance.training_sha256),
    'provenance is not a review-checklist.split.v1 record');
  const bytes = readBounded(trainingFile, MAX_BYTES);
  requireThat(digest(bytes) === provenance.training_sha256, 'training.jsonl does not match provenance training_sha256');
  const prs = readRecords(bytes, 'training');
  requireThat(prs.size === provenance.training_prs, 'training PR count does not match provenance');
  return { provenance, prs };
}

// Both shard publication and validation use this exact byte representation.
function* trainingShards(prs) {
  const urls = [...prs.keys()].sort();
  for (let i = 0; i < urls.length; i += SHARD_PRS) {
    const chunk = urls.slice(i, i + SHARD_PRS);
    const lines = chunk.flatMap(url => prs.get(url).lines);
    const text = lines.join('\n') + '\n';
    const file = `shard-${String(i / SHARD_PRS + 1).padStart(3, '0')}.jsonl`;
    yield { chunk, text, entry: { file, sha256: digest(text), prs: chunk.length, records: lines.length,
      first: chunk[0], last: chunk.at(-1) } };
  }
}

function shardTraining(prs, output) {
  requireThat(!fs.existsSync(output), 'output already exists; use a new directory');
  const shards = [];
  const staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), '.review-shards-'));
  try {
    for (const { text, entry } of trainingShards(prs)) {
      fs.writeFileSync(path.join(staging, entry.file), text);
      shards.push(entry);
    }
    const manifest = { schema: 'review-checklist.shards.v1', shard_prs: SHARD_PRS, shards };
    fs.writeFileSync(path.join(staging, 'shards.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return shards.map(({ file, prs, records }) => ({ file, prs, records }));
}

function sampleTraining(prs, seed, n) {
  requireThat(typeof seed === 'string' && seed.trim().length > 0 && seed.length <= 128, 'expected a non-empty seed of at most 128 characters');
  requireThat(Number.isSafeInteger(n) && n > 0 && n <= MAX_SAMPLE, `sample size must be 1..${MAX_SAMPLE}`);
  return [...prs.keys()].map(url => ({ url, rank: digest(JSON.stringify([seed, url])) }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.url < b.url ? -1 : 1)
    .slice(0, n).map(({ url }) => url);
}

// Tag ids are the backticked names of taxonomy.md's `- `id`: definition` lines.
function parseTaxonomy(text) {
  const ids = [...text.matchAll(/^- `([^`\n]*)`: \S/gm)].map(match => match[1]);
  requireThat(ids.length > 0 && ids.every(id => TAG.test(id)), 'taxonomy needs `- `tag-id`: definition` lines with lowercase ids');
  requireThat(new Set(ids).size === ids.length, 'taxonomy has duplicate tag ids');
  return new Set(ids);
}

// Examples must be comment URLs of their own PR, so a malformed record `url`
// cannot carry text into a committed label file.
const isCommentUrl = (url, pr) => url.length <= MAX_URL && url.toLowerCase().startsWith(`${pr}#`)
  && /^#(discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]*$/.test(url.slice(pr.length));

function validateLabels(tags, holdout, prs, text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const seen = new Set();
  const counts = {};
  lines.forEach((line, index) => {
    const at = `label line ${index + 1}`;
    let label;
    try { label = JSON.parse(line); } catch { throw new Error(`${at}: invalid JSON`); }
    requireThat(JSON.stringify(label) === line, `${at}: expected compact JSON.stringify output without duplicate keys`);
    requireThat(isObject(label) && Object.keys(label).sort().join() === 'examples,pr,tags',
      `${at}: expected exactly pr, tags and examples`);
    requireThat(typeof label.pr === 'string' && label.pr.length <= MAX_URL && PR.test(label.pr)
      && prs.has(label.pr), `${at}: pr is not a canonical PR URL in this shard`);
    requireThat(!holdout.has(label.pr), `${at}: pr is held out; label only training shards`);
    requireThat(!seen.has(label.pr), `${at}: duplicate pr`);
    seen.add(label.pr);
    requireThat(Array.isArray(label.tags) && label.tags.length <= MAX_TAGS && new Set(label.tags).size === label.tags.length
      && label.tags.every(tag => typeof tag === 'string' && tags.has(tag)), `${at}: tags must be distinct taxonomy ids`);
    requireThat(isObject(label.examples), `${at}: examples must be an object`);
    for (const [tag, urls] of Object.entries(label.examples)) {
      requireThat(label.tags.includes(tag), `${at}: examples key is not one of its tags`);
      requireThat(Array.isArray(urls) && urls.length > 0 && urls.length <= MAX_EXAMPLES && new Set(urls).size === urls.length
        && urls.every(url => typeof url === 'string' && isCommentUrl(url, label.pr) && prs.get(label.pr).urls.has(url)),
      `${at}: examples must be 1..${MAX_EXAMPLES} distinct comment URLs of this PR`);
    }
    for (const tag of label.tags) counts[tag] = (counts[tag] ?? 0) + 1;
  });
  requireThat(seen.size === prs.size, `labels cover ${seen.size} of ${prs.size} shard PRs`);
  return { prs: seen.size, tags: Object.fromEntries(Object.entries(counts).sort()) };
}

function readHoldout(filename, provenance) {
  const text = decode(readBounded(filename, MAX_SMALL), 'holdout');
  const fence = '\n```text holdout\n';
  const start = text.indexOf(fence);
  requireThat(start !== -1 && text.endsWith('\n```\n'), 'invalid holdout fence');
  const payload = text.slice(start + fence.length, -4);
  requireThat(digest(payload) === provenance.holdout_sha256, 'holdout does not match provenance holdout_sha256');
  const urls = payload.split('\n');
  requireThat(urls.pop() === '' && urls.every(url => PR.test(url)), 'invalid holdout URLs');
  const holdout = new Set(urls);
  requireThat(urls.length === holdout.size && holdout.size === provenance.heldout_prs, 'holdout PR count does not match provenance');
  return holdout;
}

function main(args) {
  const usage = 'Usage: shard PROVENANCE TRAINING NEW_OUTPUT | sample PROVENANCE TRAINING SEED N | validate PROVENANCE TRAINING TAXONOMY HOLDOUT SHARD LABELS\n'
    + 'Offline only; see docs/review-checklist/code/README.md. Output holds identities, hashes and counts, never feedback.';
  const [mode, ...rest] = args;
  try {
    if (mode === 'shard' && rest.length === 3) {
      console.log(JSON.stringify(shardTraining(readTraining(rest[0], rest[1]).prs, rest[2])));
    } else if (mode === 'sample' && rest.length === 4) {
      requireThat(/^[1-9][0-9]*$/.test(rest[3]), 'sample size must be a positive integer');
      console.log(sampleTraining(readTraining(rest[0], rest[1]).prs, rest[2], Number(rest[3])).join('\n'));
    } else if (mode === 'validate' && rest.length === 6) {
      const [provenanceFile, trainingFile, taxonomyFile, holdoutFile, shardFile, labelFile] = rest;
      const { provenance, prs } = readTraining(provenanceFile, trainingFile);
      const tags = parseTaxonomy(decode(readBounded(taxonomyFile, MAX_SMALL), 'taxonomy'));
      const holdout = readHoldout(holdoutFile, provenance);
      const actual = digest(readBounded(shardFile, MAX_BYTES));
      for (const { chunk, entry } of trainingShards(prs)) {
        if (entry.file !== path.basename(shardFile)) continue;
        requireThat(entry.sha256 === actual, 'shard does not match the frozen training split');
        const shardPrs = new Map(chunk.map(url => [url, prs.get(url)]));
        const result = validateLabels(tags, holdout, shardPrs, decode(readBounded(labelFile, MAX_LABEL_BYTES), 'labels'));
        console.log(JSON.stringify({ shard_sha256: actual, ...result }));
        return;
      }
      throw new Error('shard filename does not match the frozen training split');
    } else {
      console.log(usage);
      process.exitCode = mode === '--help' ? 0 : 1;
    }
  } catch (error) {
    // Parser and filesystem errors must never echo corpus data.
    console.error(error instanceof TypeError ? 'invalid input structure' : error.message);
    process.exitCode = 1;
  }
}
```

The `Test review-checklist label shards` step in `ci.yml` runs these modes on
synthetic records, including refusals.
