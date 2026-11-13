# composefs (C) CI inventory — 3 November 2026

> This text is LLM generated.

This is the read-only baseline for [tracker#1222](https://github.com/cgwalters-forge/tracker/issues/1222),
part of [#1215](https://github.com/cgwalters-forge/tracker/issues/1215), observing
**composefs/composefs (C), not composefs-rs**. Four available ordinary-PR
workflow runs succeeded, across two revisions of one PR. There were no available
default-branch push runs. No evidence of a recurring **failed** job/test signature was found,
so there is no basis for a flake/infra/real classification or a new fix issue.
This does not establish default-branch health, fix CI, or supply the ongoing
monitor owned by [tracker#1229](https://github.com/cgwalters-forge/tracker/issues/1229)
and [agent-board#649](https://github.com/cgwalters-forge/agent-board/issues/649).

## Collection contract and limits

The frozen collection cutoff is **2026-11-03T23:15:52Z**. The exact 30-day UTC
interval is **[2026-10-04T23:15:52Z, 2026-11-03T23:15:52Z)** (2,592,000 seconds).
Runs enter by `created_at`, not completion/update time; a rerun belongs to its
original run, not a new denominator. REST's inclusive `created=start..end` query
was checked locally against the half-open interval; no boundary run occurred.
Subsequent reads validate this frozen census rather than move the cutoff.
Conclusions are as retrieved, not a reconstruction of status at the cutoff.

Only GET requests through `gh api` were made. The repository metadata identified
the default branch as `main`; its head was
`ec2573a0f68f548ae91f3e10acc990a08f9122dc` (28 July 2026).
Issue bodies and comments on #1222 and #1215 were read as data. Their comment
lists contained six and five entries respectively, all on one page of 100;
neither contained a cgwalters-authored decision. Bot plans do not authorize a C
implementation repository.

Collection ceilings: **100 API invocations**, 100 entries/page, at most ten
pages per listing, attempts 1 through the reported latest attempt (at most ten
per run), and **12 job-log requests**, at most **2 MiB captured per response**
and **16 MiB captured in total**. Multi-call collection commands had 20–30-second
timeouts; the validation/log subprocesses had 20-second request timeouts and
the combined validation had a 120-second limit. These are collection bounds,
not new CI controls. Reaching a bound means coverage is unknown, not that the result is green.
`gh`/redirects can make additional HTTP exchanges: the request ceiling counts
explicit API invocations, not network packets or redirect hops. The capture
limit does not claim to bound bytes downloaded internally by `gh`.

All required run/job/attempt metadata fit below the caps. The log-request ceiling
was reached: eight initial requests were refused by `gh`'s terminal-escape output
guard; four selected retries allowed escape bytes into captured memory and
stripped ANSI sequences before showing excerpts. Those four succeeded, totalling
**272,116 bytes**. No expiry/deletion response was encountered. Full log coverage
is **not** claimed: distcheck and bootc logs remain uninspected after the local
output refusal, as do build/lint/sentinel logs not selected for download.

## Populations and denominators

The unfiltered repository run listing returned `total_count=4`, four records on
page 1, and an empty page 2 (`per_page=100`). This covers events, not just the
current workflow registry. Independent `event=push&branch=main` and
`event=pull_request` queries returned zero and the same four IDs respectively.

| Population | Distinct runs | Initial successes / runs | Eventual successes / runs |
| --- | ---: | ---: | ---: |
| Default-branch `push`, branch `main` | 0 | 0/0, undefined | 0/0, undefined |
| Ordinary `pull_request` | 4 | 4/4 | 4/4 |
| Excluded `merge_group` | 0 | — | — |
| Excluded tag pushes | 0 | — | — |
| Excluded non-default branch pushes | 0 | — | — |
| Excluded manual `workflow_dispatch` | 0 | — | — |
| Excluded other events (including schedule/PR-target) | 0 | — | — |

There are **4 distinct run IDs, 4 attempts, 18 distinct job IDs/job attempts**.
All runs and jobs are completed/success. Failures, cancellations, skipped jobs,
in-progress/queued runs, timed-out, neutral, action-required and other conclusions
are each zero in these available records. Initial and eventual denominators are
distinct runs (or distinct workflow/job-name appearances), not retries. All four
latest attempts are 1; each `/runs/ID/attempts/1` was retrieved and matched to its
run. No failed earlier attempt is hidden by a green rerun in the returned history;
there were no attempts 2+ to inspect. This is not evidence about deleted runs or
attempts that GitHub no longer exposes.

### Workflows, including zero activity

The Actions workflow registry returned four active workflows on page 1 and none
on page 2. Per-workflow counts below sum to four. Default-push denominators are
zero for **every** workflow; their pass rate is undefined, not 100%.

| Workflow (ID) | Path under `.github/workflows/` | PR runs | Initial / eventual successful runs | Job attempts |
| --- | --- | ---: | ---: | ---: |
| Test (27828758) | `test.yaml` | 2 | 2/2 / 2/2 | 16 |
| revdep CI bootc (118155863) | `ci-bootc.yml` | 2 | 2/2 / 2/2 | 2 |
| Build binaries (134039796) | `builds.yaml` | 0 | 0/0 / 0/0 | 0 |
| OpenSSF Scorecard (245400093) | `openssf-scorecard-gate.yml` | 0 | 0/0 / 0/0 | 0 |

### Run ledger and PR identity

All rows are `pull_request`, branch `gh-449`, attempt **1**, initial **success**,
eventual **success**. Run creation dates below are UTC.

| Created | Workflow | Run / attempt evidence | Head revision |
| --- | --- | --- | --- |
| 2026-10-14 11:29:39 | Test | [38556945807/1](https://github.com/composefs/composefs/actions/runs/38556945807/attempts/1) | `a2f0d5f3fd5367fc241921729ca89c33ad1757ad` |
| 2026-10-14 11:29:39 | revdep CI bootc | [38556945931/1](https://github.com/composefs/composefs/actions/runs/38556945931/attempts/1) | `a2f0d5f3fd5367fc241921729ca89c33ad1757ad` |
| 2026-10-16 12:13:04 | Test | [38898980628/1](https://github.com/composefs/composefs/actions/runs/38898980628/attempts/1) | `5ff87511c2bacd825b00e1503bbf828a1c2e8265` |
| 2026-10-16 12:13:04 | revdep CI bootc | [38898980636/1](https://github.com/composefs/composefs/actions/runs/38898980636/attempts/1) | `5ff87511c2bacd825b00e1503bbf828a1c2e8265` |

The run and attempt `pull_requests` arrays, and both commit-to-PR association
queries, were empty. They must not be used to infer “not a PR.” Head-filtered
`pulls?state=all&head=Kiskae:gh-449` returned
[PR #450](https://github.com/composefs/composefs/pull/450), open/unmerged,
`Kiskae/composefs:gh-449` → `composefs/composefs:main`, with current head `5ff8751…`
and base `ec2573a…`. Both inspected Test logs explicitly checked out
`refs/remotes/pull/450/merge`, identifying even the superseded 14 October head.
The actual test checkouts were synthetic merges:

* 14 October: `14ea59baa2205964dad716211d9221a6ff953476`.
* 16 October: `e053509ef9355f19adf543d7951da9f129b68178`.

The commit API verified both parents: the stated base and each head. Thus these
are ordinary PRs against main, not tests of main itself or of the head alone.
Bootc identity is corroborated by the matching event/head/branch and creation
time; its checkout log was not inspected. The current PR commit list has only
the later head; the earlier association rests on the archived checkout evidence,
not an invented present-day commit association.

### Job ledger and execution coverage

Each row has PR initial **2/2** and eventual **2/2** successful job appearances,
two attempts total, zero failure/cancel/skip/in-progress, and default-push **0/0**.
The dated columns link every job; `#step:N:1` is a UI log location. The REST
download is `GET /repos/composefs/composefs/actions/jobs/JOB_ID/logs`.

| Workflow / job | 14 October job | 16 October job | What success actually covers |
| --- | --- | --- | --- |
| Test / Build with ASAN | [115828337248](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828337248#step:8:1) | [116966256470](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256470#step:8:1) | Unit tests step succeeded; both logs: 6 OK, 0 fail/skip/timeout |
| Test / Build without ASAN | [115828337252](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828337252) | [116966256518](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256518) | Build/install artifacts, not a unit-test run |
| Test / Build on Ubuntu Focal | [115828337314](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828337314) | [116966256692](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256692) | Baseline build, not tests |
| Test / Build (24.04, clang) | [115828337030](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828337030) | [116966256648](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256648) | Compiler build, not tests |
| Test / clang-format | [115828337226](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828337226) | [116966256534](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256534) | Formatting only |
| Test / distcheck | [115828336934](https://github.com/composefs/composefs/actions/runs/38556945807/job/115828336934#step:5:1) | [116966256780](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966256780#step:5:1) | `meson dist` step success; individual test results unverified |
| Test / integration | [115829029916](https://github.com/composefs/composefs/actions/runs/38556945807/job/115829029916#step:8:1) | [116966867855](https://github.com/composefs/composefs/actions/runs/38898980628/job/116966867855#step:8:1) | Both ordinary and fsverity-required steps succeeded (steps 8 and 9); logs inspected |
| Test / required-checks | [115829601409](https://github.com/composefs/composefs/actions/runs/38556945807/job/115829601409) | [116967380900](https://github.com/composefs/composefs/actions/runs/38898980628/job/116967380900) | Sentinel, not tests; source accepts skipped dependencies |
| revdep CI bootc / c9s-bootc-e2e | [115828338030](https://github.com/composefs/composefs/actions/runs/38556945931/job/115828338030#step:4:1) | [116966256061](https://github.com/composefs/composefs/actions/runs/38898980636/job/116966256061#step:4:1) | Container build and `bootc install` step success; not proof of booting a VM |

Job listing totals were 8, 1, 8, 1; every attempt's page 2 was empty. Each of
the four named binary-build matrix entries (Ubuntu 24.04/22.04, Fedora 41,
CentOS stream9) has zero observed job appearances. Scorecard jobs cannot be
enumerated from the available source; zero activity is not a passing scorecard.
The unit-test total is 12 successful Meson test cases across two runs, not 12
independent revisions or 12 successful workflow runs. Integration step success
does not imply every optional capability was exercised.

## Workflow revision inspection and uncertainty

The default-branch workflow-path commit listing for the interval returned no
commits (one page, fewer than 100). Directory reads at the base, both PR heads,
and both tested merge revisions all reported the same three workflow blobs:

| File | Blob SHA |
| --- | --- |
| `test.yaml` | `55365ad490d9b028fcfbbd41856d3de25af6ef4c` |
| `ci-bootc.yml` | `8cc84c662de0708af879a3323ec7bd7aab7b869a` |
| `builds.yaml` | `34e2988e3b9a7aed6303656386892e9549efec82` |

Read the pinned [Test source](https://github.com/composefs/composefs/blob/5ff87511c2bacd825b00e1503bbf828a1c2e8265/.github/workflows/test.yaml),
[bootc source](https://github.com/composefs/composefs/blob/5ff87511c2bacd825b00e1503bbf828a1c2e8265/.github/workflows/ci-bootc.yml),
and [binary source](https://github.com/composefs/composefs/blob/ec2573a0f68f548ae91f3e10acc990a08f9122dc/.github/workflows/builds.yaml).
Test selects main pushes/PRs and merge groups; bootc also admits manual runs;
binary builds admit pushes, including events excluded from the primary population.
There are no observed runs in those excluded populations. Build binaries does
not invoke a test command. The Test sentinel explicitly accepts `skipped`;
the actual job/step records, not sentinel success alone, establish execution here.

**Unresolved source/record discrepancy:** the fetched Test source refers to
checkout v3 in several jobs, while recorded step names say v4; the integration
dependency-step names also differ. Directory blob equality is not a proof of
the exact YAML executed by Actions. The executable workflow provenance is
therefore only partially verified; execution claims above use recorded steps
and the four downloaded logs, with source used to explain intended coverage.
No workflow change or cause is inferred from this discrepancy.

The registry's active OpenSSF workflow (created 12 March 2026) is absent from
all five inspected Git trees. Its definition, trigger rules and historical jobs
are unavailable in this source census; registry activity alone is not execution.
Deleted workflow/run history is not recoverable from these APIs. The no-change
listing describes main only, not all discarded PR heads.

## Error grouping and existing ownership

There are **0 failed attempts / 4 attempts** and **0 failed job attempts / 18**
in the returned metadata. Thus there are no failed-attempt first-error groups,
no evidence-supported failure classifications, and **no ready-to-file tracker
fix title/body**. A green rerun would not prove flake root cause; none occurred.

One repeated **non-fatal diagnostic**, not a failed-job signature, deserves
preservation: integration emitted
`ERROR: FS_IOC_ENABLE_VERITY failed on '/composefs/test-fsverity': Operation not supported`
on 14 October at **11:32:25.8639510Z** and 16 October at
**12:15:33.6018374Z** (the integration job/log links above, step 8).
Frequency: **2/2 integration job attempts**, affecting both heads and tested
merges in the ledger. Both ordinary and required-verity steps still succeeded.
The pinned [integration script](https://github.com/composefs/composefs/blob/5ff87511c2bacd825b00e1503bbf828a1c2e8265/tests/integration.sh)
allows the ordinary probe to fail, but exits if verity is unavailable when
`WITH_TEMP_VERITY=1`. This supports an optional-capability diagnostic, **not** a
flake, infra failure or real failed test. Exact runner filesystem cause is
unverified. Do not turn a grep for “ERROR” into two failed jobs.

Read-only searches included **open and closed issues and PRs**, without a state
filter, 100/page. These four queries each fit on page 1, matched `total_count`,
and returned `incomplete_results=false`:

* `repo:composefs/composefs CI in:title,body`: 25 results.
* `repo:composefs/composefs fsverity in:title,body`: 33 results.
* `repo:cgwalters-forge/tracker composefs in:title`: 82 results.
* `repo:cgwalters-forge/tracker "FS_IOC_ENABLE_VERITY"`: 2 results.

These are scoped duplicate searches, not a claim to enumerate every issue by
synonym. The existing open [composefs#389, GHA ci with fsverity](https://github.com/composefs/composefs/issues/389)
already covers runner filesystem/verity setup; its body suggests `tune2fs` as
an alternative to the loopback filesystem. It is unassigned; no ownership was
changed. This inventory neither declares it fixed nor proposes a duplicate.
[PR #450](https://github.com/composefs/composefs/pull/450) is an **unmerged**
xattr-handling proposal, not a landed fix or an observed failing-CI recurrence.
[PR #437](https://github.com/composefs/composefs/pull/437) (merge-queue support,
merged 12 June 2026) and [#416](https://github.com/composefs/composefs/pull/416)
(checksum-test timeout, merged 5 April 2025) are **landed historical changes**,
not explanations for failures in this window. Tracker's matching verity issues
#334 and #360 concern composefs-rs, not ownership of this C inventory.

Since there is no evidence of an uncovered recurring failure, no fix,
quarantine owner or repeated-run acceptance issue is invented here. If later evidence justifies
one, its acceptance must name the exact tested merge/head revision and an exact
repetition count; these two different revisions are not repeated-run validation
of any fix.

## Operator decision and remaining coverage

**Operator decision needed before implementation:** designate an allowed
C-composefs midstream staging repository, its upstream-tracking base branch,
and the reviewed dispatch/work bounds that may target it. No such target is
authorized here. Keep this inventory in tracker until cgwalters decides; do not
create a fork, broaden bounds, dispatch tests, post upstream, or substitute
the allowed composefs-rs repository. No caller option or control is added.

The available metadata census is complete within the stated window and API
surface, but coverage of historical reality is not guaranteed: deleted runs,
unexposed attempts, removed workflow definitions and unavailable historical PR
associations cannot be counted as successes. Only one PR and two days were
active; there is no default-branch execution sample. Logs were selectively
inspected, not exhausted, and executable workflow provenance has the discrepancy
above. No hidden test-case skips are ruled out beyond the inspected Meson
summary. No live CI execution, rerun, implementation fix or ongoing monitoring
was performed.

Validation used independent read-only run filters, all four attempt endpoints,
all four paginated job listings, commit parent checks and PR checkout evidence.
Assertions checked interval membership, distinct IDs, event/branch/attempt
membership, successful conclusions, exact job URLs and totals (2×8 + 2×1 = 18).
All linked run/job IDs were returned by the API; UI fragment rendering itself
was not browser-tested. Local Markdown/link and whitespace checks are recorded
in the accompanying PR. The bounded log inspection's initial output-guard
failures are coverage gaps, not API history expiry and not passing log checks.
