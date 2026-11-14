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
| composefs/composefs-rs | ci.yml | bootc-revdep.yml, fuzz.yaml, publish.yml, mirror-fixture-images.yml, release.yml |
| bootc-dev/bcvk | main.yml, main-c10s.yml | docs.yml, release.yml |
| coreos/rpm-ostree | ci.yaml | container-build.yml, autovendor.yml, scorecard.yml |
| ostreedev/ostree | tests.yml, rust.yml, bootc.yaml | docs.yml, release.yml |
| composefs/composefs (C) | test.yaml, builds.yaml, ci-bootc.yml | openssf-scorecard-gate.yml |
| cgwalters-forge/agent-board | ci.yml | build.yml, site.yml, release.yml |
| cgwalters-forge/agentic-job | ci.yml | build.yml, check.yml, policy.yml, specs.yml, site.yml, workflow-ingress.yml, safe-outputs-cli.yml, release.yml |
| cgwalters-forge/tracker | ci.yml | none of the routine dispatch/operations workflows are build/test populations |
| cgwalters-forge/actions | ci.yml | workflows-check.yml, example-plain-ci.yml |
| cgwalters-forge/review | ci.yml | pages.yml |
| cgwalters-forge/agenthome | ci.yml | check.yml |
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

The existing 20-target build/test baseline is retained as a deliberately partial
daily surface under #1229; no deferred target is added or silently substituted.
Any replacement still needs trigger review. Even adding bootc
image publication alone requires replacing one current target. Covering every
deferred file cannot fit the reviewed collector's cap. Full coverage requires
a separately reviewed collector policy change; this patch does not increase
the cap, partition the window, rotate targets, or launch multiple collectors to
evade shared budgets. Publication stays off until acceptance is reviewed.

Other excluded workflows are review/label/merge bots, Copilot/dynamic workflows,
dispatch/apply/session/reconcile operations, upgrade/scheduled-release jobs,
safe-output probes, examples/experiments and lock/secure-host wrappers. Their
operational success is not build/test CI success. Event scope is always default
branch `push` and ordinary `pull_request` separately; `pull_request_target`,
`merge_group`, tag/other-branch pushes, schedules and manual/reusable dispatches
are excluded. Jenkins and other external status checks are not Actions coverage.
Fork no-history is documented here, not counted as a passing population.

## Rates, index, and follow-up

Each population displays distinct runs, observed/expected attempts, first-attempt
passes/denominator (run-level first try) and observed attempt passes/denominator.
The latter is **not an eventual run-level rate**. Cancellations, skips, active
and other conclusions remain separate. Empty denominators mean no data, never
100%. The last 30 complete UTC days use original run creation time; reruns are
observed at collection time, including attempts after the window.

Report/target completeness, auth/no-data/log/history warnings and presentation
truncation appear prominently even on collector exit zero. The complete warning
list and groups are in dated artifacts, retained for 35 days, with config/source
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

The renderer verifies collector findings and lists recurring multi-run
signatures with no mapped issue, plus reviewed unexplained flakes whose index
first_seen is **strictly older than seven days** at `until`. Exactly seven days
is not overdue. It separately audits overdue unexplained flake index entries
absent from current groups: absence, especially with incomplete coverage, does
not prove recovery. No failure issue creation, retry, quarantine, repair
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

The only destination is tracker issue 1229 and marker
`<!-- tracker-ci-health:1229:v1 -->`, owned by `github-actions[bot]` of type Bot.
A matching foreign marker, duplicate, wrong issue/ref/repository or ten full
comment pages refuses publication. Daily runs update that one comment; identical
content is a no-op. Manual preview renders the same dated JSON/Markdown and job
summary without a write. Changing the GitHub Actions token identity would
require a reviewed ownership migration, not automatic adoption of old comments.

The `Test CI-health saved reports and publication` step in `ci.yml` executes the actual inline script with canned API and file
seams, including dry-run/update, hostile excerpts, wrong refs, report/provenance
refusal, no data, incomplete history and seven-day/absent-signature boundaries.
It runs alongside `just test` in the required CI job, including the retained
November 13 live sample. To run that same Node step locally without dependencies:

```sh
node -e 'const fs = require("node:fs"); const w = fs.readFileSync(".github/workflows/ci.yml", "utf8"); eval(/- name: Test CI-health saved reports and publication\n        shell: node \{0\}\n        run: \|\n([\s\S]+?)\n\n  # actionlint/.exec(w)[1].replace(/^          /gm, ""));'
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

**Historical deployment gap (superseded by the hosted evidence below):** the read-only API lookup of
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

### 2026-11-14 hosted evidence review

The existing implementation [#1325](https://github.com/cgwalters-forge/tracker/pull/1325)
is merged, not an outstanding draft. Read-only inspection found the default-branch
workflow active and one completed [scheduled run, 43447382610](https://github.com/cgwalters-forge/tracker/actions/runs/43447382610),
at source `3310be48fae2d26472e7b840b69845729d8e5190` on November 13.
Both collect and report jobs passed. The logs record the verified installation
of `223fc372d321abfc643929faa4e8218b2422f30d`, one collection, same-run artifact
download with a matching archive digest, and `Preview only; status comment unchanged.`
The scheduled invocation had `PREVIEW=false`; the source policy's `publish: false`
kept it read-only. This is scheduled preview evidence, **not a manual dispatch
or comment-publication test**. No new collection or dispatch was made for this review.

The downloaded provenance binds that source, collector, run attempt 1 and the
unchanged config hash `f322be4b7ca7e0a34b22f433941e0d0c3edcf3017ae165503b3102f8b80cbf3b`.
The raw report SHA-256 is
`5e5af5bd2bbf7eef0dc7573a209ca245af09ca32cc4ad606f9efee6d6fb9b46b`;
the dated JSON is byte-identical. The artifacts are
[raw JSON/provenance](https://github.com/cgwalters-forge/tracker/actions/runs/43447382610/artifacts/14049485678)
(archive SHA-256 `1a497803f1aeea0e6a3cae1d1ccbab8cb4015ac82bd09fa9e406acaa7b9cfd1b`)
and [dated JSON/Markdown](https://github.com/cgwalters-forge/tracker/actions/runs/43447382610/artifacts/14049650425)
(archive SHA-256 `54cbfbbaaacbbe0a860fd1e53939c61bdbc3fc0cd4fa9190ee2195837e46aac5`).
Both were downloadable during this review; the API lists expiry on December 18,
consistent with 35-day retention, not proof they will remain available indefinitely.

The hosted report covers the same October 14–November 13 window but is a separate
sample from the local one above. **It remains incomplete.** In particular, bcvk
`main-c10s.yml` returned HTTP 404 with the job token: its empty populations are
unavailable history, unlike the local sample's completed empty listing. A
read-only follow-up on November 14 resolved it as a missing workflow, not an
access failure: `bootc-dev/bcvk` is public with default branch `main`; with a
separate read-only token, `main.yml` is active while
`repos/bootc-dev/bcvk/actions/workflows/main-c10s.yml` returns 404, no `main`
commit has touched `.github/workflows/main-c10s.yml`, and no run since October 14
has that path. The local sample's "completed empty listing" for this target was
therefore a missing workflow reported as complete. The configured target is
stale; dropping it changes the reviewed 20-target scope and config hash, so it is
left for scope review rather than changed here. Other targets retain
byte/time/log warnings, and C composefs `builds.yaml` and agenthome
`ci.yml` have no eligible history. Successful jobs do not establish full source
access, healthy CI, supported signature mappings or eventual run-level outcomes.

The saved hosted JSON was replayed through the existing config/renderer/publication
regression suite, including stale-window refusal, without another live collection.
Still missing: a hosted **manual** `preview: true` run, reviewed scope/index
acceptance (including the stale bcvk `main-c10s.yml` target), and owned-comment
create/update evidence. This patch-only handback cannot start a hosted job; the controller must
dispatch `ci-health.yml` on the default branch with `preview: true` and retain its
run/artifacts. No credential or variable change is requested. Keep publication
off and #1229 open; neither the earlier 404 deployment gap nor first-target
starvation should be reported as the current blocker.
