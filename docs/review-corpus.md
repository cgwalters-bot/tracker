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
