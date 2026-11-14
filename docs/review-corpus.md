# Review corpus

> This text is LLM generated.

The review corpus is cgwalters' public review feedback on other people's
pull requests: inline review comments, review bodies and pull request
comments, one JSON object per comment. It is the input for the review
checklist work in [#1224](https://github.com/cgwalters-forge/tracker/issues/1224).
It is too large for git, so it is published as
[releases](https://github.com/cgwalters-forge/tracker/releases) of this
repository, never committed here. Each refresh is a new release tagged
`review-corpus-YYYYMMDD-HHMMSS`, the UTC time its run began collecting; the
newest holds the current corpus.
This repository's releases are immutable, so a published one never changes.
The undated `review-corpus` release is an empty leftover from before this
scheme; ignore it.

## What it holds

Each new release has four assets (older releases lack `status.json`):

- `review-corpus.jsonl.zst`: the corpus, zstd-compressed JSON Lines. Its
  schema is misctool's
  [JSONL schema, version 1](https://github.com/cgwalters-forge/misctool/blob/v0.1.0/README.md#jsonl-schema-version-1).
  The `outcome` field is evidence that a file changed after the comment,
  not proof that the author acted on it. Comment bodies are untrusted text.
- `review-corpus-state.json`: the collector's resume state. Only the
  workflow uses it.
- `status.json`: `complete` (a JSON boolean), `stopped_for_quota`,
  `collector_version`, `login`, `window` and `run_url`. `complete` is true
  only when the collector finishes; the quota reserve, rate limits, timeouts
  and errors make it false, and `stopped_for_quota` is true when the reserve
  stopped it. Releases from before the reserve lack `stopped_for_quota`.
  The window has `since` (inclusive UTC date) and `until: null` (no fixed
  upper bound).
  Complete means the collector finished, not that GitHub has no gaps.
- `SHA256SUMS`: the checksums of the other three.

The window is all feedback created on or after 2020-11-01 (UTC) on public
pull requests that cgwalters did not author. The collector finds pull
requests through GitHub search, so search index lag, deleted comments and
repositories that have since gone private can leave gaps. misctool's README
lists its limits.

The release notes give the date of the last refresh, whether that run
finished, the checksums and the collector's `stats`: record counts by
repository, language and year. The repositories the corpus covers are the
keys of the `repositories` count there. They are not listed here because they
change with each refresh.

## Refreshing

`.github/workflows/review-corpus.yml` runs weekly and on manual dispatch,
once the repository variable `REVIEW_CORPUS` is `enabled`. It installs the
pinned misctool release and verifies its build attestation. It downloads the
corpus and state of the newest published `review-corpus-*` release, collects
from where the state left off and publishes the result as a new release:
created as a draft, given its four assets, then published. The first run,
finding none, starts from nothing.

Before resuming, the download step checks both the compressed corpus and resume
state against `SHA256SUMS` from that same release. A missing file, missing checksum
or mismatch stops the run before decompression, collection or publication, so
damaged corpus/cursor bytes cannot be carried into a new snapshot. It does not
fall back to an older release or start over. Inspect the failed download and
restore a verified snapshot before retrying; do not bypass the check. Historical
releases without `status.json` still work because only the two resume assets are
checked. This detects corruption, not a malicious publisher who can replace both
assets and their checksums. The existing opt-in and ten-minute download bound
are unchanged; CI covers this path without network access.

The collector uses the job token, whose core API quota is shared by every
workflow in this repository. So that the pass, dispatch, review and the
supervisor keep working, the workflow checks the quota left before starting
the collector and once a minute after, and does not start it, or stops it,
once fewer than `RATE_LIMIT_RESERVE` (500 of the token's 1,000 an hour)
requests remain. It stops it with SIGTERM, then SIGKILL after 30 seconds,
as the step's time limit ends it with signals. Such a run publishes what it
has, records the quota stop in the notes and `status.json`, and succeeds;
the next run resumes. A reserve not below the token's hourly limit fails
the run before collecting or publishing; set it to 0 to turn the reserve
off. The first backfill takes several runs. A run that stops early for another reason, a rate limit the reserve missed,
the time limit or an error, also publishes what it has. It records that it
stopped early in the notes and `status.json`, and the run fails. Dispatch it again
(or wait for the schedule) to resume. The collector runs with a job token that cannot write.
The publishing job's token can write the repository's contents, but the job
runs only release API operations on its own snapshot.

An API error or a non-integer quota response also stops collection, using the
same bounded termination, but fails the collection step rather than reporting
an ordinary quota stop. Otherwise an unavailable quota endpoint could let the
collector drain the token shared with review and dispatch. Retained output can
still be published as incomplete (`complete: false`, `stopped_for_quota: false`);
if the first run has no corpus/state yet, packing fails and nothing is published.
Each quota read, including the preflight limit check, has a ten-second deadline
and is killed after five more seconds if it ignores termination. Without this
bound, a stalled read could leave the collector spending the shared quota until
the five-hour collection step expires. A timed-out monitoring read follows the
same unknown-quota failure path and bounded collector shutdown; a timed-out
preflight check fails before collection. These are fixed bounds, not a new
setting; collection remains off unless `REVIEW_CORPUS=enabled`.

The preflight also requires the hourly limit to be one to ten decimal digits,
just like the remaining-quota read. It interprets leading zeros as decimal and
rejects expressions, variable names, whitespace and oversized values before
shell arithmetic. Otherwise malformed API text could pass the reserve check or
be evaluated as an expression. An invalid limit stops the run before collection
or publication; retry after quota reads recover, rather than disabling the reserve.

Retry after quota reads recover. Setting the reserve to 0 skips quota reads
altogether. `just test-review-corpus` exercises these paths offline, including
a collector that ignores SIGTERM; it does not run a live backfill.

If an upload is interrupted, the run leaves an unpublished draft release.
Re-run the failed **publish job**, within the `review-corpus` artifact's seven-day
retention, to replace all four assets from that same artifact and publish it.
Publication first searches all release pages for the tag, refusing multiple
matches before creating or repairing anything. Recovery requires a draft whose
target commit and exact run marker in the notes match this run. The selected or
newly created release ID is retained for asset replacement and publication,
rather than resolving the tag again. This prevents a tag collision from replacing another run's
assets; it is not protection against a malicious release writer. A published
release, a foreign draft or a failed lookup/upload stops recovery without
publishing. Old drafts without the marker require manual inspection and cleanup.
The existing opt-in and fifteen-minute publish-job bound are unchanged;
`just test-config` tests recovery and refusals offline, including interrupted
asset replacement and a server that accepts duplicate draft creation.

Before any release API call, publication recomputes checksums for all three data
assets in the downloaded artifact and compares the entire manifest, ignoring
entry order. Missing or damaged files and missing, duplicate or extra checksum
entries stop publication before creating a release or deleting a draft's assets.
This prevents a damaged artifact from becoming an immutable snapshot; it does not
authenticate a publisher able to replace both bytes and checksums. No paths from
the manifest are opened. Restore the verified collection artifact before retrying,
rather than regenerating checksums for damaged bytes. `just test-config` covers
these refusals for both first publication and draft recovery, without API access.
This uses the existing opt-in and fifteen-minute job bound, not a new setting.

A new collection run ignores drafts and resumes from the last published release,
so nothing is lost but the interrupted run's work; delete abandoned drafts by
hand. Recovery does not overwrite an immutable snapshot or restart collection.

To move to a newer misctool, change `MISCTOOL_VERSION` in the workflow and the
schema link above.

## Pinning and downloading a version

A version is a release tag. The newest is the last `review-corpus-*` tag in
sort order, skipping the undated `review-corpus`:

```sh
tag=$(gh release list --repo cgwalters-forge/tracker --exclude-drafts --limit 1000 --json tagName \
  --jq '[.[].tagName | select(test("^review-corpus-[0-9]{8}-[0-9]{6}$"))] | sort | last // empty') || exit 1
```

The newest release can be a partial backfill. To avoid mining an unfinished
backfill, select the newest **complete** snapshot instead. This checks at
most 1,000 published releases, newest tag first, skipping old releases with
no marker. API and download errors stop the command rather than silently
selecting an older snapshot. No match prints nothing; do not download with
an empty tag. Resume still uses the newest release, even if incomplete.

A `complete: true` marker alone can misidentify another operator's corpus or a
quota-stopped backfill as mining input. The selector therefore validates marked
snapshots against this corpus's login, window and run provenance before accepting
them. Malformed or contradictory metadata stops selection rather than hiding a
broken release by falling back. Missing markers are still skipped; the historical
absence of `stopped_for_quota` is allowed. This is a manual, read-only check, not
activation of mining or a claim that GitHub's search results are exhaustive.

```sh
tags=$(gh release list --repo cgwalters-forge/tracker --exclude-drafts --limit 1000 --json tagName \
  --jq '[.[].tagName | select(test("^review-corpus-[0-9]{8}-[0-9]{6}$"))] | sort | reverse | .[]') || exit 1
for tag in $tags; do
  marked=$(gh release view "$tag" --repo cgwalters-forge/tracker --json assets --jq 'any(.assets[]; .name == "status.json")') || exit 1
  [ "$marked" = true ] || continue
  status=$(gh release download "$tag" --repo cgwalters-forge/tracker --pattern status.json --output -) || exit 1
  complete=$(printf '%s' "$status" | jq -rs '
    (if length == 1 then .[0] else error("invalid review corpus status") end) |
    if type == "object" and (.complete | type) == "boolean"
      and .login == "cgwalters" and .window == {since: "2020-11-01", until: null}
      and (.collector_version | type == "string" and length > 0)
      and (.run_url | type == "string" and test("^https://github[.]com/cgwalters-forge/tracker/actions/runs/[1-9][0-9]*\\z"))
      and ((has("stopped_for_quota") | not) or (.stopped_for_quota | type) == "boolean")
      and (.complete != true or .stopped_for_quota != true)
    then .complete else error("invalid review corpus status") end') || exit 1
  if [ "$complete" = true ]; then printf '%s\n' "$tag"; break; fi
done
```

Set `tag` to the printed complete tag, then run this in an empty directory with
Bash. It downloads current-format snapshots only (all three data assets are
required). An empty tag must not make `gh` download an unrelated latest release.
A missing checksum must not let unchecked corpus bytes reach decompression:
compare the entire manifest with locally computed checksums, rather than using
`--ignore-missing`. Reordered entries work; missing, duplicate, extra or damaged
entries fail. No paths from the downloaded manifest are opened.

```sh
[ -n "$tag" ] || { printf '%s\n' 'No corpus tag selected' >&2; exit 1; }
gh release download "$tag" --repo cgwalters-forge/tracker --pattern review-corpus.jsonl.zst \
  --pattern review-corpus-state.json --pattern status.json --pattern SHA256SUMS || exit 1
sha256sum review-corpus.jsonl.zst review-corpus-state.json status.json > actual-checksums || exit 1
LC_ALL=C sort SHA256SUMS > expected-checksums || exit 1
LC_ALL=C sort actual-checksums > sorted-checksums || exit 1
diff -u expected-checksums sorted-checksums || exit 1
zstd -d review-corpus.jsonl.zst
```

Keep the tag and verified `status.json` with the downloaded snapshot. The marker
does not change the existing newest-release interface or historical assets.
The selector validates metadata, not asset bytes or the cited run's authenticity;
the subsequent checksum verification remains required. `just test-review-corpus`
runs this exact selector against offline release fixtures, including refusals.

The checksum check only catches a corrupt download. To pin a version, record its
tag and the corpus checksum from `SHA256SUMS` or the release notes, then
download that tag and check against the recorded value:

```sh
echo "SHA256  review-corpus.jsonl.zst" | sha256sum --check
```

Published releases are immutable, so a pinned tag keeps serving the same
file.

## Preparing the frozen checklist split

Before mining #1231, keep held-out feedback out of the miner's context. Splitting
individual comments by date leaks later comments on the same PR across the split;
using the first row also misclassifies unsorted records. The explicit offline
splitter groups **all three comment kinds by repository and PR**, using the
earliest recorded `created_at`, not `updated_at`. First feedback on or after
`2026-06-01T00:00:00Z` holds out the whole PR. The cutoff is fixed, not an option.

After selecting a complete snapshot and checking its release notes for an early
stop, download its four assets as above without opening the corpus in the mining
session. From this repository, run the splitter kept below in this document:

```sh
node -e 'eval(require("node:fs").readFileSync("docs/review-corpus.md", "utf8").split("```js split-corpus\n")[1].split("\n```")[0]); main(process.argv.slice(1))' -- review-corpus-YYYYMMDD-HHMMSS /tmp/snapshot /tmp/new-split
```

Use the real selected tag and existing snapshot directory; the output must not
exist and its parent must exist. Passing `--help` instead of the three arguments
describes the invocation. Node and zstd are required. It independently
checks all three asset digests and complete-snapshot metadata before decompressing,
then writes `training.jsonl`, sorted held-out PR URLs in `holdout.txt`, a text-free
sampling inventory in `holdout-metadata.json`, and
`provenance.json` with the fixed cutoff, input/output hashes and record/PR counts.
Only counts go to stdout; feedback never goes to stdout or validation errors.
Give the miner only these outputs, not the original snapshot. There is deliberately
no held-out feedback file. Preserve the provenance and holdout list with the
eventual checklist; keep corpus bytes outside git.

For #1232, reopening held-out feedback just to find PRs with inline comments and
language coverage would contaminate evaluation. Use `holdout-metadata.json`
instead: its `review-checklist.holdout-metadata.v1` schema has a sorted `prs`
array with only `url`, `first_feedback`, `inline_comments` and `inline_languages`.
The last field counts inline comments in fixed categories `Rust`, `C`, `shell`,
`Go`, `Python`, `docs` and `other`. Collector labels `Shell` and `Docs` map to
lowercase categories; unknown, null or absent labels count as `other`, never as
free-form output. Non-string labels other than null are invalid. PR-level comments
affect the first-feedback date but not inline counts. PRs with no inline comments
remain visible with zero counts; exclude them from #1232's sample.

These counts describe language coverage, not style/nit eligibility or review
quality. No comment text, IDs, paths, hunks, outcomes or commit metadata are
copied into the inventory. Mixed-language PRs retain all their counts; the frozen
sampling protocol must choose their single stratum and allocation before reviews,
not silently take a majority here. The inventory itself neither selects the 30 PRs nor
establishes that enough eligible PRs exist. Archive it with the frozen sample and
verify `holdout_metadata_sha256` in `provenance.json`. Existing split directories
are never upgraded in place; an older frozen split remains valid and must not be
replaced by a newer corpus just to obtain this additional metadata.

### Freezing a text-free evaluation sample

The same offline snippet has an explicit `--sample` mode for #1232:

```sh
node -e 'eval(require("node:fs").readFileSync("docs/review-corpus.md", "utf8").split("```js split-corpus\n")[1].split("\n```")[0]); main(process.argv.slice(1))' -- --sample holdout-metadata.json plan.json
```

It prints a JSON candidate sample, not feedback or an evaluation result. First
verify the inventory's checksum against the frozen split provenance. Archive the
plan, inventory and output before any review; never try seeds until a desired
result appears. No workflow invokes this mode.

The plan is `{"seed":"predeclared-seed","allocation":{"Rust":10,"C":10,"other":10}}`.
Choose allocations from text-free coverage before reviews; omitted strata get
zero slots, and positive integer allocations must total exactly 30. This is an
example, not a claim that these strata have enough eligible PRs. The fixed
mixed-language rule is the largest inline-comment count, with ties broken in
`Rust, C, shell, Go, Python, docs, other` order. PRs with no inline comments are
excluded. Within each stratum, rank by SHA-256 of the JSON pair `[seed, canonical
PR URL]`, then by URL. This is deterministic sampling, not a claim of statistical
representativeness. Insufficient coverage fails rather than borrowing slots or
shrinking the sample. Metadata cannot establish style/nit eligibility; record
later exclusions without substituting favorable PRs or claiming a complete run.

Threat: hand-picking candidates after opening feedback contaminates the held-out
comparison. This mechanism uses only fixed metadata, emits only URLs/strata and
counts, and binds the source bytes with a digest. It does not prove the seed was
predeclared or prevent someone rerunning it. Inventory reads remain bounded to
128 MiB and 250,000 PRs; the plan is limited to 16 KiB. Unknown fields are rejected
so feedback cannot accidentally be passed through as sampling provenance.

This command is off unless explicitly invoked; no workflow calls it. To bound a
malformed snapshot, compressed corpus and state are each limited to 128 MiB,
status to 16 KiB, and the manifest to 4 KiB. Decompression is limited to 128 MiB
and 30 seconds; parsing accepts at most 250,000 records. Oversized input, bad
metadata, duplicate comment identities, invalid UTF-8/JSON or invalid UTC dates
fail without publishing a split. Review these fixed bounds if a real complete
snapshot exceeds them; do not silently truncate. Existing output is refused so a
refresh cannot replace a frozen split by accident.

The splitter does not authenticate release provenance, establish completeness
beyond the marker, or discover earlier feedback omitted by collection. "First"
means first in the pinned corpus window, not necessarily the PR's entire history.
It expects the collector's UTC second-resolution timestamps. The supplied tag is
recorded, not looked up. Hashes bind bytes, not the truth of their metadata. A
later snapshot must not replace a frozen holdout or supply tuning feedback.

The splitter lives here rather than in a script file because the repository's
deployment code may only shrink (#890):

```js split-corpus
// Explicit offline preparation for #1231, not a miner or evaluation runner.
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CUTOFF = '2026-06-01T00:00:00Z';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 250000;
const LANGUAGES = ['Rust', 'C', 'shell', 'Go', 'Python', 'docs', 'other'];
const ASSETS = ['review-corpus.jsonl.zst', 'review-corpus-state.json', 'status.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function readBounded(filename, limit) {
  const stat = fs.lstatSync(filename);
  requireThat(stat.isFile() && stat.size <= limit, 'snapshot asset is not a bounded regular file');
  return fs.readFileSync(filename);
}

// Neither errors nor stdout include record text, paths, or diff hunks.
function partition(bytes) {
  requireThat(bytes.length <= MAX_BYTES, 'decompressed corpus exceeds 128 MiB');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  requireThat(lines.length > 0 && lines.length <= MAX_RECORDS, 'expected 1..250000 records');
  const prs = new Map();
  const seen = new Set();
  const keys = lines.map((line, index) => {
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`invalid JSON at record ${index + 1}`); }
    const validDate = typeof r?.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.created_at)
      && Number.isFinite(Date.parse(r.created_at))
      && new Date(r.created_at).toISOString() === r.created_at.replace('Z', '.000Z');
    requireThat(r?.schema_version === 1 && ['review-comment', 'review-body', 'pr-comment'].includes(r.kind)
      && typeof r.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository)
      && Number.isSafeInteger(r.pr_number) && r.pr_number > 0
      && Number.isSafeInteger(r.comment_id) && r.comment_id > 0
      && typeof r.body === 'string' && validDate, `invalid metadata at record ${index + 1}`);
    const identity = `${r.kind}:${r.comment_id}`;
    requireThat(!seen.has(identity), `duplicate identity at record ${index + 1}`);
    seen.add(identity);
    const key = `https://github.com/${r.repository.toLowerCase()}/pull/${r.pr_number}`;
    if (!prs.has(key)) prs.set(key, { url: key, first_feedback: r.created_at,
      inline_comments: 0, inline_languages: Object.fromEntries(LANGUAGES.map(language => [language, 0])) });
    const pr = prs.get(key);
    if (r.created_at < pr.first_feedback) pr.first_feedback = r.created_at;
    if (r.kind === 'review-comment') {
      requireThat(r.language == null || typeof r.language === 'string', `invalid language at record ${index + 1}`);
      // Only fixed labels escape into the sampling inventory, never corpus text.
      const label = r.language === 'Shell' ? 'shell' : r.language === 'Docs' ? 'docs' : r.language;
      const language = LANGUAGES.includes(label) ? label : 'other';
      pr.inline_comments++;
      pr.inline_languages[language]++;
    }
    return key;
  });
  // Decide only after scanning ALL metadata: input order and comment kind do not
  // define a PR's first feedback. Later comments on a training PR stay training.
  const held = new Set([...prs].filter(([, pr]) => pr.first_feedback >= CUTOFF).map(([key]) => key).sort());
  const training = lines.filter((_, i) => !held.has(keys[i]));
  return {
    training: training.length ? training.join('\n') + '\n' : '',
    holdout: [...held].map(key => key + '\n').join(''),
    metadata: JSON.stringify({ schema: 'review-checklist.holdout-metadata.v1', prs: [...held].map(key => prs.get(key)) }, null, 2) + '\n',
    counts: { records: lines.length, training_records: training.length,
      heldout_records: lines.length - training.length, training_prs: prs.size - held.size, heldout_prs: held.size },
  };
}

function splitSnapshot(tag, snapshot, output) {
  requireThat(/^review-corpus-\d{8}-\d{6}$/.test(tag), 'expected a dated review-corpus tag');
  requireThat(!fs.existsSync(output), 'output already exists; use a new directory, never overwrite a frozen split');
  const manifest = readBounded(path.join(snapshot, 'SHA256SUMS'), 4096).toString('utf8');
  const assets = new Map(ASSETS.map(name => [name, readBounded(path.join(snapshot, name), name === 'status.json' ? 16384 : MAX_BYTES)]));
  const checksums = ASSETS.map(name => `${digest(assets.get(name))}  ${name}`).sort();
  requireThat(manifest.trimEnd().split('\n').sort().join('\n') === checksums.join('\n'), 'snapshot checksum coverage or digest mismatch');
  let status;
  try { status = JSON.parse(assets.get('status.json')); } catch { throw new Error('invalid snapshot status JSON'); }
  requireThat(status?.complete === true && (status.stopped_for_quota === undefined || status.stopped_for_quota === false)
    && status.login === 'cgwalters' && status.window?.since === '2020-11-01' && status.window?.until === null
    && typeof status.collector_version === 'string' && status.collector_version.length > 0
    && typeof status.run_url === 'string' && /^https:\/\/github\.com\/cgwalters-forge\/tracker\/actions\/runs\/[1-9][0-9]*$/.test(status.run_url),
  'snapshot must be complete cgwalters feedback for the documented window and run');
  let bytes;
  try {
    bytes = execFileSync('zstd', ['-dc'], { input: assets.get('review-corpus.jsonl.zst'), maxBuffer: MAX_BYTES, timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('decompression failed or exceeded 128 MiB/30 seconds; check zstd and snapshot'); }
  const split = partition(bytes);
  const provenance = { schema: 'review-checklist.split.v1', tag, cutoff: CUTOFF,
    snapshot_sha256: Object.fromEntries(ASSETS.map(name => [name, digest(assets.get(name))])),
    training_sha256: digest(split.training), holdout_sha256: digest(split.holdout),
    holdout_metadata_sha256: digest(split.metadata), ...split.counts };
  const staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), '.review-split-'));
  try {
    fs.writeFileSync(path.join(staging, 'training.jsonl'), split.training);
    fs.writeFileSync(path.join(staging, 'holdout.txt'), split.holdout);
    fs.writeFileSync(path.join(staging, 'holdout-metadata.json'), split.metadata);
    fs.writeFileSync(path.join(staging, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return split.counts;
}

function sampleInventory(bytes, plan) {
  const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  requireThat(fields(plan, ['seed', 'allocation']) && typeof plan.seed === 'string'
    && plan.seed.trim().length > 0 && plan.seed.length <= 128, 'expected a predeclared seed and allocation');
  requireThat(plan.allocation && typeof plan.allocation === 'object' && !Array.isArray(plan.allocation)
    && Object.entries(plan.allocation).every(([language, n]) => LANGUAGES.includes(language)
      && Number.isSafeInteger(n) && n > 0 && n <= 30)
    && Object.values(plan.allocation).reduce((a, b) => a + b, 0) === 30, 'allocation must total 30 across known strata');
  requireThat(bytes.length <= MAX_BYTES, 'inventory exceeds 128 MiB');
  let inventory;
  try { inventory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid inventory UTF-8 or JSON'); }
  requireThat(fields(inventory, ['schema', 'prs']) && inventory.schema === 'review-checklist.holdout-metadata.v1'
    && Array.isArray(inventory.prs) && inventory.prs.length <= MAX_RECORDS, 'invalid inventory schema or PR count');
  const seen = new Set();
  const strata = Object.fromEntries(LANGUAGES.map(language => [language, []]));
  for (const pr of inventory.prs) {
    requireThat(fields(pr, ['url', 'first_feedback', 'inline_comments', 'inline_languages'])
      && typeof pr.url === 'string' && pr.url.length <= 1024
      && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr.url)
      && typeof pr.first_feedback === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pr.first_feedback)
      && Number.isFinite(Date.parse(pr.first_feedback))
      && new Date(pr.first_feedback).toISOString() === pr.first_feedback.replace('Z', '.000Z')
      && pr.first_feedback >= CUTOFF, 'invalid held-out PR metadata');
    const url = pr.url.toLowerCase();
    requireThat(!seen.has(url), 'duplicate inventory PR');
    seen.add(url);
    requireThat(fields(pr.inline_languages, LANGUAGES) && Number.isSafeInteger(pr.inline_comments)
      && pr.inline_comments >= 0 && pr.inline_comments <= MAX_RECORDS
      && Object.values(pr.inline_languages).every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_RECORDS)
      && Object.values(pr.inline_languages).reduce((a, b) => a + b, 0) === pr.inline_comments, 'invalid inline counts');
    if (!pr.inline_comments) continue;
    const language = LANGUAGES.reduce((best, next) => pr.inline_languages[next] > pr.inline_languages[best] ? next : best);
    strata[language].push({ url, rank: digest(JSON.stringify([plan.seed, url])) });
  }
  const prs = [];
  const available = {};
  const allocation = {};
  for (const language of LANGUAGES) {
    available[language] = strata[language].length;
    allocation[language] = plan.allocation[language] ?? 0;
    requireThat(available[language] >= allocation[language], `insufficient candidates for ${language}; freeze a feasible allocation before reviews`);
    strata[language].sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.url < b.url ? -1 : 1);
    prs.push(...strata[language].slice(0, allocation[language]).map(({ url }) => ({ url, language })));
  }
  return { schema: 'review-checklist.sample.v1', inventory_sha256: digest(bytes), seed: plan.seed,
    stratum_rule: 'largest-inline-count; ties: Rust,C,shell,Go,Python,docs,other', allocation, available, prs };
}

function main(args) {
  if (args.length === 3 && args[0] === '--sample') {
    let plan;
    try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(args[2], 16384))); }
    catch { throw new Error('invalid or oversized sampling plan'); }
    console.log(JSON.stringify(sampleInventory(readBounded(args[1], MAX_BYTES), plan), null, 2));
    return;
  }
  if (args.length !== 3 || args.includes('--help')) {
    console.log('Usage: TAG SNAPSHOT NEW_OUTPUT | --sample INVENTORY PLAN (see "Preparing the frozen checklist split" in docs/review-corpus.md)\nOffline only; verify release notes and download the four snapshot assets first.\nWrites training.jsonl, held-out PR URLs, text-free sampling metadata and provenance; sampling prints candidate URLs/strata, never feedback.');
    process.exitCode = args.includes('--help') ? 0 : 1;
    return;
  }
  try { console.log(JSON.stringify(splitSnapshot(...args))); }
  catch (error) {
    // JSON parser and external-program errors must never echo corpus data.
    console.error(error instanceof TypeError ? 'invalid corpus structure' : error.message);
    process.exitCode = 1;
  }
}
```

The `Test review-corpus holdout split` step in `ci.yml` exercises synthetic
snapshots, the real zstd path, cutoff boundaries, unsorted/case-varied PR identities, all comment kinds,
checksum/metadata failures, text-free language counts, output isolation and fixed parser bounds. No complete
corpus was mined for this preparation; #1342's released retry fix and a completed
backfill still precede #1231, with held-out evaluation separate in #1232.

## Monthly checklist refresh

[monthly-review-refresh.yml](../.github/workflows/monthly-review-refresh.yml)
dispatches the same trusted task manually and on the first day of each month
at 08:00 UTC. It does not collect a corpus, run evaluations in the trigger job,
or deploy reviewers. To prevent premature mining of partial evidence, both
entries are off unless repository variable `REVIEW_REFRESH` is `enabled`, and
only run from the default branch. This change leaves the variable unset.

Before enabling, review immutable commit/content-hash pins for all three
artifacts at their versioned home, their development/holdout split, and each
component's frozen evaluation protocol. Also require retained complete
checksum-pinned baseline/candidate snapshots and unused feedback-isolated
samples. The code checklist is not yet present here; prose 0.1.0 has thin
operator evidence and illustrative fixtures, not an evaluation. Architecture
0.1.0 is a development pilot, not a held-out result. These are not ready-to-use
refresh prerequisites or approvals.

The current `dispatch.toml` also forces complete PRs ready for review; a task's
requested draft flag cannot override it. The refresh therefore must return
unfinished/no-update until a reviewed caller/policy change guarantees draft-only
publication at the admitted versioned home. It must not fake an incomplete
checkpoint to obtain a draft. This dispatcher adds no alternate writer or
policy-selection option.

The dispatched task must check these prerequisites each time, before mining;
an enabled switch is not evidence. Missing or partial snapshots, unavailable
artifacts/protocols, exhausted isolated samples, failed audits or insufficient
evidence produce an honest unfinished/no-update report, without guessed rules,
scores or an empty version bump. Its finite release discovery stops at 1,000
published releases; a missing match is a gap, not permission for a backfill.
The workflow's five-minute bound is for dispatch only; the existing implement
runner and checked-output policy bound the subsequent run.

Keep frozen holdouts, prior outputs and use ledgers intact; never move the
cutoff or reuse test material to improve scores. Reviewer packets must exclude
feedback, labels, later fixes and scoring records. Bot proposals, generated
cleanup and author-associated assisted edits are not verified operator wording
preferences. Archive component-specific caught/missed/unmatched/scorable and
noise-audit denominators, model/run provenance and prose false-positive and
meaning-change audits. Supported updates and version bumps belong in one draft
PR at the versioned home. Reviewed release-train pin rollout is separate;
the refresh must never activate pins automatically.

`just test-review-refresh` tests admission, dispatch arguments and the task's
prerequisite/no-update instructions offline. These are prompt-contract tests,
not proof that a model obeyed them or that an evaluation completed.
