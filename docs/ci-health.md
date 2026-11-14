# Daily rolling CI observations

> This text is LLM generated.

Part of #1229, not acceptance of the green-CI epic. The concrete publication
threat is an unapproved scope or rehearsal replacing the daily status. The one
policy is `.github/ci-health/publication.json`, `publish: false` by default.
Review scope and live acceptance before changing it to `true` in review.
Manual runs default to `preview: true`; preview cannot override this policy.
No secrets or repository variables need changing. Collection remains read-only
even when publication is enabled.

The daily 06:43 UTC and manual entry points run only on the API default branch
of `cgwalters-forge/tracker`, serialized without cancellation, with 15/5-minute
collection/report job limits. The collector is the reviewed agent-board
`223fc372d321abfc643929faa4e8218b2422f30d`, installed by the existing attested
`just build-agent-board` recipe, not a source build or moving branch.
Its [interface and budgets](https://github.com/cgwalters-forge/agent-board/blob/223fc372d321abfc643929faa4e8218b2422f30d/docs/ci-health.md)
were checked against both CLI and collector source. `ci-health --config FILE
--format json` runs exactly once; Markdown is rendered from that saved JSON.
`--format human` would collect again and is deliberately not used.

## Explicit partial scope

The fixed config has **20 workflow targets across 15 repositories**, not full
project coverage. All 15 default branches were discovered through the repository
API on 2026-11-05 and were `main`. The collector discovers them again on every
run (not assumed from this snapshot). It cannot reconstruct historical default
branch renames. No dynamic workflow discovery runs in the workflow.

Observation choices follow inventories [#1216](https://github.com/cgwalters-forge/tracker/issues/1216),
[#1217](https://github.com/cgwalters-forge/tracker/issues/1217),
[#1218](https://github.com/cgwalters-forge/tracker/issues/1218),
[#1219](https://github.com/cgwalters-forge/tracker/issues/1219),
[#1220](https://github.com/cgwalters-forge/tracker/issues/1220),
[#1222](https://github.com/cgwalters-forge/tracker/issues/1222) and
[#1223](https://github.com/cgwalters-forge/tracker/issues/1223).
#1221 is not an additional inventory project. Forge forks of the OS projects
had absent/disabled Actions history; public upstream Actions are the observation
source, **not** permission to write there. C composefs is its own project,
`composefs/composefs`, never substituted with composefs-rs. `cgwalters/bcvk`
redirects to the canonical `bootc-dev/bcvk`, which is configured explicitly.

| Repository | Configured workflow files | Deferred relevant workflow files |
|---|---|---|
| bootc-dev/bootc | ci.yml | build-and-publish.yml, autovendor.yml, docs.yml, release.yml |
| composefs/composefs-rs | ci.yml, bootc-revdep.yml | fuzz.yaml, publish.yml, mirror-fixture-images.yml, release.yml |
| bootc-dev/bcvk | main.yml | docs.yml, release.yml |
| coreos/rpm-ostree | ci.yaml | container-build.yml, autovendor.yml, scorecard.yml |
| ostreedev/ostree | tests.yml, rust.yml, bootc.yaml | docs.yml, release.yml |
| composefs/composefs (C) | test.yaml, builds.yaml, ci-bootc.yml | openssf-scorecard-gate.yml |
| cgwalters-forge/agent-board | ci.yml | build.yml, site.yml, release.yml |
| cgwalters-forge/agentic-job | ci.yml | build.yml, check.yml, policy.yml, specs.yml, site.yml, workflow-ingress.yml, safe-outputs-cli.yml, release.yml |
| cgwalters-forge/tracker | ci.yml | none of the routine dispatch/operations workflows are build/test populations |
| cgwalters-forge/actions | ci.yml | workflows-check.yml, example-plain-ci.yml |
| cgwalters-forge/review | ci.yml | pages.yml |
| cgwalters-forge/agenthome | check.yml | none (ci.yml is retired) |
| cgwalters-forge/misctool | ci.yml | release.yml |
| cgwalters-forge/atomic-linux-sandbox | build.yml | composefs.yml |
| cgwalters-bot/praxis-credential-broker | ci.yml | container-images.yml |

The last nine rows are **all nine** harness repositories requested in #1223;
neither forge-infra nor the forge website is substituted for the credential
broker. The table is conservative: deferred files need trigger/reusable-call
review; a schedule-only or reusable-only file may have no eligible standalone
population. Workflow API registration is not proof it has eligible runs.
The incomplete #1223 inventory has not established the complete harness workflow
and signature inventory yet.

The build/test baseline remains a deliberately partial daily surface under
#1229. The reverse-dependency addition below uses the slot freed by removing the
nonexistent bcvk target, under the unchanged 20-target ceiling. Covering every
deferred file cannot fit the reviewed collector's cap. Full coverage requires
a separately reviewed collector policy change; this patch does not increase
the cap, partition the window, rotate targets, or launch multiple collectors to
evade shared budgets. Publication stays off until acceptance is reviewed.

### bcvk target correction (14 November 2026)

Read-only inspection found that `main-c10s.yml` is not a bcvk workflow, rather
than treating its 404 as proof that all bcvk Actions require more credentials.
The [workflow listing](https://api.github.com/repos/bootc-dev/bcvk/actions/workflows)
returned the active `main.yml` (ID 166610689), but no `main-c10s.yml`.
Both the latter's contents and workflow-runs endpoints returned 404; the commit
history query for that path returned an empty array. This is current API evidence,
not proof that the path never existed in any historical branch.

The retained [main.yml at a3e2327](https://github.com/bootc-dev/bcvk/blob/a3e2327d9ce3448242cbb62cbdf20ef47a534752/.github/workflows/main.yml)
has `push` and `pull_request` triggers for `main`, and builds and runs unit and
integration tests. Its runs API was readable, including default-branch push
[42536699199](https://github.com/bootc-dev/bcvk/actions/runs/42536699199) and PR
[42479738386](https://github.com/bootc-dev/bcvk/actions/runs/42479738386).
Remove only the nonexistent target, retaining `main.yml` and all 15 repositories;
do not replace it with a scheduled automation job or silently enlarge scope.
No new control, credential, collector pin, budget or publication setting is added.

The November 13 sample is unchanged evidence of the old 20-target configuration,
including its 404. Offline replay supplies that exact historical target list and
also checks that today's configuration refuses the old report before
rendering. New reports and their scope label use the current list. A fresh hosted
preview with the corrected configuration remains necessary: these API reads and
offline tests do not establish job-token coverage or complete #1229 acceptance.

### Observe composefs-rs reverse-dependency failures (14 November 2026)

Use the freed slot for `composefs/composefs-rs / bootc-revdep.yml`, rather than
leaving the recurring pre-job failure in [inventory G1](composefs-rs-ci-2026-11-03.md#pre-job-failures-g1)
outside the daily rates. Read-only trigger review at
[`424c820`](https://github.com/composefs/composefs-rs/blob/424c820c5e5237fef9e73a7446415108ab3eb7f9/.github/workflows/bootc-revdep.yml)
confirms `push` and `pull_request` on `main`, plus `merge_group` and manual
dispatch. Only the first two eligible populations are collected; this does not
admit queue, manual, tag or other-branch runs.

The runs API returned failed main pushes
[42114866124](https://github.com/composefs/composefs-rs/actions/runs/42114866124) and
[42114121703](https://github.com/composefs/composefs-rs/actions/runs/42114121703)
on November 5, and failed PR run
[43532296046](https://github.com/composefs/composefs-rs/actions/runs/43532296046)
on November 14. The latter's jobs endpoint returned zero jobs. The source still
contains `if: never()`. These reads establish an observable population, not a new
30-day census or a new causal signature. The existing repair owner is
[composefs-rs#61](https://github.com/cgwalters-forge/composefs-rs/issues/61), with
open draft [#66, branch `bot/revdep-never`](https://github.com/cgwalters-forge/composefs-rs/pull/66);
this configuration change does not duplicate that fix or enable its VM tests.

Zero-job failures still contribute to failed run/attempt rates even when no job
log yields a signature. Do not invent an index hash from the workflow name or
treat an empty group list as recovery. Offline rendering tests cover failed
populations with no groups and visible incomplete-log warnings. The historical
November 13 JSON stays unchanged and replays only with its historical targets:
both old and new lists have 20 entries, but different identities.

No new mechanism or control is added. Publication remains off, all 15 repositories
remain covered by the configured scope, and the collector pin and global budgets
stay fixed. Returning from 19 to 20 targets reduces each target's enrichment
share; coverage may remain incomplete. A fresh hosted preview of this exact
configuration, signature mappings and repeated fix evidence remain with #1229
and #1223. No collector invocation, hosted dispatch or status write ran here.

### Agenthome target correction (14 November 2026)

Replace retired `cgwalters-forge/agenthome / ci.yml` with `check.yml` in the
same slot. At [`ce75a39`](https://github.com/cgwalters-forge/agenthome/tree/ce75a397b285ee000d4046bae405e0ecb6bb08d6/.github/workflows),
`ci.yml` is absent (contents API 404), though Actions still lists it as active.
Its runs endpoint returned only three PR runs, all on October 13, outside the
retained sample's window. Registration alone did not establish current coverage.
The [current check workflow](https://github.com/cgwalters-forge/agenthome/blob/ce75a397b285ee000d4046bae405e0ecb6bb08d6/.github/workflows/check.yml)
triggers on `push` and `pull_request` and runs `just check` and pinned-tool smoke
checks. Read-only runs API evidence includes failed main push
[43560910313](https://github.com/cgwalters-forge/agenthome/actions/runs/43560910313),
successful main push [43555939068](https://github.com/cgwalters-forge/agenthome/actions/runs/43555939068)
and successful PR [43555284546](https://github.com/cgwalters-forge/agenthome/actions/runs/43555284546).
These establish eligible populations, not the failure's cause or a 30-day census.

The 20-target/15-repository scope, collector budgets and default-off publication
policy are unchanged; no new control or workflow discovery is added. Offline
tests cover both populations under the corrected label and reject a report with
the retired target before rendering or publication. The November 13 JSON remains
unchanged historical evidence, replayed with its original targets. A fresh hosted
preview and evidence-backed signature mappings remain acceptance work under
#1229/#1223; no hosted dispatch, collection or status write ran for this correction.

Other excluded workflows are review/label/merge bots, Copilot/dynamic workflows,
dispatch/apply/session/reconcile operations, upgrade/scheduled-release jobs,
safe-output probes, examples/experiments and lock/secure-host wrappers. Their
operational success is not build/test CI success. Event scope is always default
branch `push` and ordinary `pull_request` separately; `pull_request_target`,
`merge_group`, tag/other-branch pushes, schedules and manual/reusable dispatches
are excluded. Jenkins and other external status checks are not Actions coverage.
Fork no-history is documented here, not counted as a passing population.

## Rates, index, and follow-up

The dated Markdown, summary and optional status show **coverage totals** before
the bounded warning preview. Every configured target is counted once as complete,
listing-incomplete, or listing-complete with incomplete attempts/logs. Separately,
each population reports how many targets have no observed runs. This includes
unavailable history, not just completed empty listings; it is not proof of
inactivity or passing CI. Cancelled/skipped/active/other-only populations have
runs and are not counted as empty even though their pass-rate denominator is zero.
These totals use the full validated report, not the displayed warning count,
and describe only configured scope, not all project workflows. Tests cover mixed
coverage with truncated warnings, entirely empty complete/incomplete reports,
and preview/publication parity. No option, collection or budget change is added;
publication stays off.

The dated Markdown, job summary and optional status show finding totals before
their detail sections: all observed signature groups, unclassified groups,
recurring groups without an issue, observed overdue unexplained flakes, and
absent overdue unexplained index entries. These counts use the entire validated
report/index, not the twelve displayed groups or the byte-limited preview.
Categories overlap; they are not run counts or a count of unique root causes.
Absent entries are kept separate because they are not current observations.
Zero findings, especially with incomplete collection or an empty index, do not
establish healthy CI. This adds no option, collection or classification, and
publication remains off. Offline coverage includes truncated mixed groups,
single-run/high-occurrence failures, the seven-day boundary, explained and
non-flake exclusions, empty reports, and preview/publication parity.

Failure groups show their first observed timestamp **within the report window**,
not the failure's all-time onset or the reviewed index's flake-age clock. Each
retained sample links to its exact run attempt and job, so a later rerun cannot
silently redirect investigation to the latest attempt's overview. These links
use the already validated run URL and numeric attempt/job IDs; no extra API
requests or log downloads are made. Groups without samples gain no invented
evidence. The dated Markdown, summary and optional owned status use the same
evidence text, subject to the existing status truncation limits. Publication
remains off by default; this does not complete #1223's classification inventory
or #1229's hosted acceptance.

The saved-report validator bounds each group's distinct run count by the sum of
observed push and PR runs across that repository's configured workflows. This
prevents impossible recurrence from outranking real failures while allowing a
cross-workflow group to exceed one workflow listing's 1,000-run cap. Runs from
other repositories cannot supply the bound. Groups may overlap, so their counts
are not summed against the population. This is only a consistency bound: the
report has no complete run-ID ledger to prove membership or job provenance.
Incomplete collection still supplies a bound on what was actually observed, not
all runs that might exist. Tests cover empty populations, both populations and
multiple workflows, the exact bound and refusal before dated writes/publication.
No new option or API request is added; publication remains off by default.

Each population displays distinct runs, observed/expected attempts, first-attempt
passes/denominator (run-level first try) and observed attempt passes/denominator.
The latter is **not an eventual run-level rate**. Cancellations, skips, active
and other conclusions remain separate. Empty denominators mean no data, never
100%. The last 30 complete UTC days use original run creation time; reruns are
observed at collection time, including attempts after the window.

Each population row also shows **failed attempts (first/all observed)**, including
pre-job failures and failures whose logs could not yield a signature. Zero observed
groups must not hide these failures or make readers derive their counts from pass
rates. The first count is a subset of the second, not an additional count; repeated
failed attempts are not distinct failing runs. Counts reflect only observed history,
with coverage and observed/expected attempts beside them. Cancellations, skips,
active and other outcomes are not failures. The dated Markdown, summary and optional
status share these counts without changing JSON, collection or publication policy.
Offline regression coverage includes no signatures, reruns, incomplete history,
nonterminal/excluded outcomes and preview/publication parity. No new option or
control is added; publication remains off and #1229 acceptance remains outstanding.

Failure-evidence run and job IDs must be positive safe integers, and sample
attempt numbers must be in `1..100`, matching the pinned collector's attempt cap.
Zero IDs or attempt zero could otherwise produce impossible links presented as
evidence; attempts above the cap cannot have been collected by this version.
The validator refuses these before dated artifacts or status publication, rather
than repairing or dropping samples. This is a structural check, not proof that a
job exists or failed: no extra API lookup, option or publication activation is
added. Regression tests cover invalid numeric types, zero/negative/fractional and
unsafe values, and both attempt boundaries. Live acceptance and evidence-backed
signature mappings remain separate work under #1229/#1223.

The saved-report validator also bounds terminal attempts outside the first-try
denominator by `expected_attempts - runs`. Otherwise two single-attempt runs,
one pass and one failure, could claim a 100% first-try rate by omitting the first
failure while retaining internally consistent totals. This check follows the
[pinned collector's counting contract](https://github.com/cgwalters-forge/agent-board/blob/223fc372d321abfc643929faa4e8218b2422f30d/crates/board-forge/src/ci_health.rs):
each listed run contributes one first attempt and its remaining expected attempts
are reruns. It applies separately to push and PR populations before dated writes
or publication. Missing first-attempt history remains valid when the rerun budget
allows it; cancelled/skipped/active/other outcomes need not enter either terminal
denominator. No new option, collector request or activation is added; publication
remains off. Regression fixtures exercise omitted successes and failures, the
combined rerun bound, exact boundaries and incomplete attempt history.

Report/target completeness, auth/no-data/log/history warnings and presentation
truncation appear prominently even on collector exit zero. Warnings can exceed
the status preview, so each population row also carries **target
coverage**: `INCOMPLETE listing`, `INCOMPLETE attempts/logs` (listing finished but
enrichment did not), or `Complete`. Listing incompleteness takes precedence; it
does not imply attempts or logs are complete. These are the collector's existing
target-level flags, shared by both populations, not separate population-level
coverage claims. A partial 100% rate therefore retains its caveat even when earlier
targets fill the warning preview. `Complete` means only this configured target;
an empty denominator still reads `no data`, never a passing or healthy verdict.
The same column appears in the dated Markdown, job summary and status comment;
JSON, collection budgets and default-off publication are unchanged. Offline
regressions exercise all three states in both populations, with truncated warnings
and empty complete targets, in preview and opted-in publication fixtures.

The complete warning list and groups are in dated artifacts, retained for 35 days, with config/source
revision, collector revision and run links. Fixed collector budgets remain 500
operations, 120 seconds before operations, ten 100-item listing pages, 1 MiB per
log and 32 MiB aggregate decoded data; individual requests can overrun the
deadline. The older sample below demonstrates starvation of later targets.
The new pin lists breadth-first, then enriches within fixed per-target shares
of the same global budget. Unused shares are not redistributed. This prevents
one busy target from monopolizing work, not all incomplete observations.

The reviewed classification index is capped by the publisher at 100 entries.
It is intentionally **empty** initially: none of the inventory comments supplies
an exact collector signature plus verified owner/evidence mapping. Generic TMT
summary errors in the sample cannot safely be mapped to causal failures in those
inventories. Do not manufacture hashes from truncated excerpts or classify by
an issue URL. Unknown observations and `recurring_without_issue` remain visible.
Add entries only after checking the exact full-signature identity, evidence,
owner and fix state; use `open`/`staged`, not `deployed`, for proposals/drafts.

Pending mappings (not new failure issues): bootc #68, #66, drafts bootc#70/#76
and follow-ups bootc#86–#90 from #1216; composefs-rs#61/#4 from #1217; tracker#44
and draft bcvk#2 from #1218; rpm-ostree#9/#10 and tracker#56 from #1219; the
#1220 follow-ups #1242/#1243/#1245/#1246. #1222 supports no failing C composefs
signature. #1223 is unfinished, so all nine harness signature/owner mappings
remain pending. Reuse #1120's actual disposition for lint-tool availability:
the proposed `setup.rust-lints` key never existed, the replacement uses explicit
distribution packages, and #1071 owns hosted continuation acceptance. Do not
invent a new lint fix or interpret #1120 closure as deployment/CI proof.

Within the existing finding priority (number of findings, descending), failure
groups sort by distinct affected runs, descending, then by the existing text
tie-break. Alphabetical order alone could put the most widespread recurrence
past the status's 12-entry limit. Occurrence counts do not break ties: repeated
attempts or matrix jobs must not outrank failures affecting more distinct runs.
These are observed counts under partial coverage, not estimates of total impact.
The dated Markdown uses the same ordering and retains every group; saved JSON
is unchanged. Offline fixtures exercise reversed input, equal-run ties, higher
finding priority, high-occurrence/low-run groups, preview and opted-in publication.
No new control, collection or budget change is added; publication stays off.

The renderer verifies collector findings and lists recurring multi-run
signatures with no mapped issue, plus reviewed unexplained flakes whose index
first_seen is **strictly older than seven days** at `until`. Exactly seven days
is not overdue. It separately audits overdue unexplained flake index entries
absent from current groups: absence, especially with incomplete coverage, does
not prove recovery. Each absent overdue entry includes its reviewed first-seen
date and issue (or explicit `none`), alongside owner and fix state, so the
seven-day follow-up does not require searching the config by signature. This
date is the index's age clock, not a new observation or proof of recurrence.
The dated report, summary and optional status share this escaped context under
the existing section byte/count limits; full entries remain in the artifact.
Offline tests cover mapped/unmapped issues, hostile text and explained/non-flake
exclusions. Publication remains off; no new option or API request is added.
No failure issue creation, retry, quarantine, repair
dispatch, arbitrary action or upstream write is available.

## Publication boundary and acceptance

The write-token job has no checkout. Its only executable report logic is the
reviewed inline workflow script; downloaded JSON is parsed, never executed.
It uses the repository-scoped `GITHUB_TOKEN`, not the bot's broad PAT. Same-run
artifact download (no caller-selected run), source SHA config fetch, manifest
digests, schema/shape/count/rate/size checks, exact ordered targets, collector
bounds/window and classification checks precede publication. Logs/names/warnings
are escaped for HTML, Markdown and mentions; sample links must be exact Actions
run URLs of configured repositories. Unknown provenance refuses publication.

Window endpoints must round-trip through the pinned collector's UTC timestamp
form (`YYYY-MM-DDT00:00:00.000Z`) before rendering or writing dated files.
JavaScript's date parser alone accepts alternate spellings and even normalizes
February 30 to March 2; these could mislabel the observation window or break
the filename/upload contract. Such inputs refuse before either dated write,
the upload-ready output, or a status write. The existing 30-day, midnight and
freshness checks still apply. Offline tests cover both endpoints, normalized
invalid dates, valid boundaries and replay of the retained collector sample.

Failure observations' `first_seen` timestamps must also round-trip through UTC
inside `[since, until)`. Unlike window endpoints, the pinned collector preserves
GitHub's `created_at` text here: accept second precision (`...:00Z`) as well as
the millisecond report form (`...:00.000Z`). They need not be midnight.
Otherwise an impossible date such as February 30 can be
silently normalized into the reporting window and accepted as failure evidence.
The existing validator rejects rather than repairs that input before dated files
or publication; no new control or request is added and publication remains off.
Regression tests cover normalized dates, alternate spellings, invalid types, both
window edges and valid sub-day instants. Hosted acceptance remains with #1229;
this does not replace the evidence work in #1618 or complete the epic.

The noncanonical-date fixtures require parseable input, not epoch equality with
UTC midnight: Node parses slash-form dates in the local timezone. This keeps the
offline check usable outside UTC without weakening the renderer's exact-format
refusal. Run the same command below with `TZ=UTC`, `TZ=America/New_York` or
`TZ=Asia/Kolkata` to check UTC, DST-observing and fractional-offset environments;
each must reject the same alternate spellings before writing dated files.

Impossible populations could otherwise publish passing attempts for zero runs.
The publisher enforces the pinned collector's existing limits: every listed run
has at least its latest attempt observed, expected attempts are at most 100 per
run, and the two populations together contain at most 1,000 runs per target
(ten pages). Partial enrichment can still leave observed attempts below expected
attempts; empty populations remain no data. Offline refusal tests exercise both
populations and the shared listing cap, with no rendered artifact or status
write on refusal. These checks do not enable publication or expand collection.

The only destination is tracker issue 1229 and marker
`<!-- tracker-ci-health:1229:v1 -->`, owned by `github-actions[bot]` of type Bot.
A matching foreign marker, duplicate, wrong issue/ref/repository or ten full
comment pages refuses publication. Daily runs update that one comment; identical
content is a no-op. Manual preview renders the same dated JSON/Markdown and job
summary without a write. Changing the GitHub Actions token identity would
require a reviewed ownership migration, not automatic adoption of old comments.

The owned status window must never move backwards. A delayed rerun from yesterday
can still pass the two-day freshness check after today's run has published;
workflow serialization alone does not stop that overwrite. Before updating, the
publisher reads the canonical date from the existing owned heading and refuses
an older incoming window. An absent or invalid heading also refuses, requiring
manual repair rather than guessing its age. Same-window updates remain allowed
to refresh observed attempts, and identical content remains a no-op. This orders
window dates, not collection times within a day. The check reuses the bounded
comment listing, adds no requests or option, and leaves publication off. Preview
still renders older fresh windows without consulting the status; refused writes
retain their validated dated artifacts. Offline regression tests cover advancing,
same-day and regressing windows, malformed dates, and preview/default-off paths.
Hosted create/update acceptance remains with #1229 and the evidence in #1618.

Valid warning and failure text can expand during escaping and UTF-8 encoding;
a count-only preview limit could therefore refuse the entire status as too large.
The status and job summary now keep each of their three detail sections within
12,000 encoded bytes, including an explicit omitted-entry count. Warnings and
failure groups still show at most 12 entries; absent overdue index entries show
at most 100. Entries are kept whole, in order (findings first for failure groups),
so links and escape sequences are never cut. An entry too large to fit stops that
section, not report publication. Full details remain in the dated JSON/Markdown
artifact; the population table, provenance, coverage caveats and overall
60,000-byte refusal stay unchanged. This adds no option or collection and leaves
publication off. Offline tests cover escaped and multibyte text, omission counts,
artifact retention and both preview and opted-in publication.

Warning inputs retain their 2,000-character limit independently of the target
label. Each is validated and escaped before composition, so adding a label
cannot reject an otherwise valid maximum-length warning. The composed line is
not escaped a second time; the same encoded-byte section and artifact limits
still apply. Boundary tests cover plain, markup-like and multibyte warnings at
the limit and refusal one character beyond it, without enabling publication.

The warning preview takes one entry per target per round in configured order,
with each target's collector diagnostics before its generic incomplete/no-data
notices. This prevents one noisy target from consuming all twelve slots before
another target's diagnostic is considered. It does not guarantee every target
fits: the existing twelve-entry and 12,000-byte bounds still apply, whole entries
are retained, and the omission count includes all unshown warnings. Target coverage
stays beside every population rate; the full dated Markdown retains every warning
grouped by target and saved JSON is unchanged. Offline fixtures cover uneven
warning counts, escaping and preview/publication parity. No collection, new option
or activation is added; publication remains off pending #1229 acceptance.

Once validation and both dated file writes finish, the workflow marks the pair
ready for upload. The upload still runs if the later summary, marker checks or
status API write fails; the reporting step and job remain failed. This prevents
a publication outage from discarding the validated evidence needed to diagnose
it. Invalid reports and partially written pairs are not uploaded as dated
reports, and cancellation does not force an upload. The original raw artifact
remains separate. Offline regressions inject summary/API and file-write failures
and check the upload condition; no live publication acceptance is implied.

### Manual artifact-retention rehearsal

`.github/workflows/ci-health-rehearsal.yml` isolates the remaining Actions-runner
semantics check from collection and issue publication. To avoid accidental red
runs, it has no schedule and its sole `confirm` input defaults to false. An
authorized controller can dispatch it on the default branch after merge:

```sh
gh workflow run ci-health-rehearsal.yml --repo cgwalters-forge/tracker --ref main -f confirm=true
```

Three fixed fixture jobs fail deliberately: before writing, after only the JSON
write, and after both dated writes and the ready output. They use the production
upload condition and pinned artifact actions. Only the ready pair should upload.
The dependent `verify` job checks this attempt's job/step conclusions and artifact
names, then downloads and compares both files byte-for-byte. It makes two bounded
listing requests, refuses truncated listings, and has only Actions read access.
Each job is capped at five minutes; the single fixture artifact expires in one
day. There is no checkout, collector, issue API, secret, or publication opt-in.

**Expected result: the workflow is red, all three fixture jobs are failed, and
`verify` is green.** A green workflow or a skipped/failed verifier is not acceptance.
Retain the run URL, attempt, source SHA and verifier log as evidence; rerunning
uses attempt-qualified artifacts. This tests runner output retention and upload
behavior, not real renderer validation or a live issue write. Offline tests check
the fixture failure paths and parity with production. No hosted rehearsal was
dispatched in this implementation; controller execution remains outstanding.

The `Test CI-health saved reports and publication` step in `ci.yml` executes the actual inline script with canned API and file
seams, including dry-run/update, hostile excerpts, wrong refs, report/provenance
refusal, no data, incomplete history and seven-day/absent-signature boundaries.
It runs alongside `just test` in the required CI job, including the retained
November 13 live sample. To run that same Node step locally without dependencies:

```sh
node -e 'const fs = require("node:fs"); const w = fs.readFileSync(".github/workflows/ci.yml", "utf8").split("- name: Test CI-health saved reports and publication\n")[1]; eval(/shell: node \{0\}\n        run: \|\n([\s\S]+?)\n\n  # actionlint/.exec(w)[1].replace(/^          /gm, ""));'
```

Setting `CI_HEALTH_SAMPLE=/path/report.json` substitutes another saved
live sample offline; it does not perform a second collection. Replay uses a
collection-time clock and also verifies refusal at the two-day freshness limit.
The collector and tests live in admitted workflow steps, not new standalone
scripts or Justfile growth; the repository's shrink policy is unchanged.
This addresses the [required shrink failure](https://github.com/cgwalters-forge/tracker/actions/runs/43339618479/job/131604352757).
The ten offline tests, full repository tests, actionlint, online zizmor and
runner-label checks passed locally; a three-way merge with main leaves its
Justfile unchanged. Review: one adversarial pass, no findings left open.

### 2026-11-05 read-only acceptance sample

One authorized read-only collection used the old verified binary
`d742eb8052aec70d8d4ecf1da98bec9b645ae40f` and the exact
20-target config in this patch (SHA-256
`f322be4b7ca7e0a34b22f433941e0d0c3edcf3017ae165503b3102f8b80cbf3b`),
based on tracker source `7e1cea77b42bd01a412e05786b825871aac2cc38` plus this
uncommitted config. Report SHA-256:
`042a163562b59cb587b63a0d46f761720250aeebaf3b82b9d0768dcc8efc5fd1`.
Command: `RUNNER_TEMP=/tmp/opencode just collect-ci-health` with source/run
metadata supplied via environment; source GitHub Actions API, exclusive window
`2026-10-06T00:00:00Z` to `2026-11-05T00:00:00Z`. This is a local collection,
not a hosted workflow run, and no comment was posted.

**INCOMPLETE:** bootc `ci.yml` listed successfully but logs returned 404,
exceeded the 1 MiB bound, or lacked a supported meaningful first error. The
shared collection budget exhausted during bootc. All **19 later targets**
reported unavailable/incomplete budget-exhausted history and no eligible
history observed. These are not healthy or even fully surveyed repositories.

Bootc default_push: 48 runs, 48/48 observed/expected attempts, first try 43/43
passes, observed attempts 43/43 passes, five cancellations. Bootc pull_request:
179 runs, 185/225 observed/expected attempts, first try 48/103 passes (46.6%),
observed attempts 70/138 passes (50.7%), 47 cancellations. Missing attempts and
logs make these partial observed rates, not eventual success or causal census.

Example retained run evidence: [bootc run 41931405225](https://github.com/bootc-dev/bootc/actions/runs/41931405225)
had an unavailable job log. [Run 41257939727](https://github.com/bootc-dev/bootc/actions/runs/41257939727),
[41218504387](https://github.com/bootc-dev/bootc/actions/runs/41218504387) and
[41206820574](https://github.com/bootc-dev/bootc/actions/runs/41206820574) sample
the recurring `test-upgrade (centos-10, ostree)` generic TMT failure signature
`20ecefae07cc07c79003e373846ed900044b9864b83461537e52eb9b3cb76ca4`
(nine distinct runs), still unknown and `recurring_without_issue`. It is not
safe to map that summary to one of the inventory's underlying defects.

This sample proves the pinned command, config acceptance and bounded incomplete
report production, not full 15-repository acceptance. Still unverified live:
hosted `GITHUB_TOKEN` access to every source (local authorization differs),
all later-target history/log coverage, hosted artifact upload/download/retention,
daily scheduling and owned-comment create/update with the repository token.
Keep #1229 open; approve scope/budget expectations, complete pending mappings,
then run manual preview on the merged default branch before enabling publication.

**Historical blocker (addressed by the November 13 sample below):** this sample did not demonstrate the
configured cross-repository baseline in practice. If the current fixed collector
cannot reach every target's history within its shared budget, a separately
reviewed agent-board change to allocate listing work across targets before deep
log collection is needed, followed by a reviewed tracker pin and another bounded
acceptance sample. This patch does not install an unreviewed replacement or
pretend that named-but-unobserved targets satisfy coverage. Do not enable
publication merely because the offline tests pass.

### 2026-11-13 bounded cross-repository sample

The collector-fairness prerequisite [agent-board#833](https://github.com/cgwalters-forge/agent-board/pull/833)
was approved at `9c0cef05499f1f16d0cd937acbfcc83b609ecc06` and merged as
`223fc372d321abfc643929faa4e8218b2422f30d`. The latter's `build-<commit>` release
passed the existing installer's manifest attestation, source identity and binary
checksum checks locally. Only the read-only workflow uses this `CI_HEALTH_REV`;
the shared `AGENT_BOARD_REV` pins of write-capable automation remain unchanged.
The collection step exports that exact revision into provenance; the isolated
renderer and its tests require it independently.

One invocation of `RUNNER_TEMP=/tmp/opencode just collect-ci-health`, with
`AGENT_BOARD_REV` set to that pin, read the unchanged config (SHA-256
`f322be4b7ca7e0a34b22f433941e0d0c3edcf3017ae165503b3102f8b80cbf3b`).
Source was tracker `d633548871910f6c9390c8cc844909f125c1591f` plus the uncommitted
collector-pin/test changes. Window: `2026-10-14T00:00:00Z` through exclusive
`2026-11-13T00:00:00Z`. This is local API authorization, not hosted job-token proof.
No window partition, target rotation, second collection or budget change was used.

The [retained JSON](ci-health-2026-11-13.json) is semantically identical to the
saved collector output (deep-equality checked), with whitespace changed only.
Its SHA-256 is `eb3b1ba7441ed2c0acb8420cdce4f4a2dae7e36e32ec14e61402fdda406ebb15`;
the original output's was `224e7027693ceca6ce442f37751b5442528d4ef2ce02a65479b472de931c01f6`.
Decoded data: 24,754,647 bytes. All 20 targets were reached, across all 15
repositories. Fourteen listings completed; six stopped at their target byte
share, retaining partial counts. Seventeen targets have eligible runs; bcvk
`main-c10s.yml`, C composefs `builds.yaml` and agenthome `ci.yml` have completed
listings with no eligible history, not passing populations. Only four targets
have complete observations. The report remains **INCOMPLETE**, with log/time/byte
warnings and missing attempts visible. In particular, a truncated 100% rate is
not evidence of a healthy 30-day population.

The two retained signatures are unknown, not newly classified: ostree's generic
`unitcontainer-build` exit 139 and the broker's `spend_rolls_off_an_hour_at_a_time_after_a_week`
panic. The ostree sample is `bootc.yaml`, job `unit-tests (stream10)`; tracker#39
includes historical unitcontainer exit-139 observations, but the shared exit code
alone does not establish a common failing process or an exact collector mapping.
The #1220/#1223 inventories do not establish the full
identity/owner/fix mapping of either sample. Each occurs in one observed run;
neither supports recurrence or same-SHA recovery here. The index stays empty,
pending mappings above stay visible, and no issue closure is called deployment.

**Hosted acceptance unavailable in this handback:** the read-only API lookup of
`repos/cgwalters-forge/tracker/actions/workflows/ci-health.yml` and the default
branch file lookup both returned HTTP 404 on November 13. The workflow is not
deployed on the default branch. This run can hand back a patch, not push or start
hosted jobs; it did not dispatch a different ref to bypass the default-branch
guard. After merge, the controller must run manual `preview: true` and retain
its run URL, all-source job-token access, raw/rendered artifact digests and
upload/download/retention evidence. Scheduling and owned-comment create/update
also remain unverified. These are deployment evidence gaps, not a request to
change policy, credentials or variables. Keep publication off and #1229 open
until that acceptance is reviewed.
