# tracker

> This text is LLM generated.

Work items and questions for [cgwalters-bot](https://github.com/cgwalters-bot)'s
workstream. The [Workstream board](https://github.com/orgs/cgwalters-forge/projects/1)
is a view over these issues plus the upstream issues and PRs the bot works on;
anything on the board that isn't upstream is an issue here.

- **Work items** are ordinary issues. Larger efforts are parent issues whose
  sub-issues are the steps, so the board shows their progress.
- **Questions for cgwalters** are issues labelled `question` and assigned to
  him, usually a sub-issue of the work item they block. The first line says
  which item that is (`Blocks: <url>`). They offer lettered options, the
  recommended one first as A.

## Answering a question

Comment on the question issue. To pick an option, make the first line of
the comment just its letter (e.g. `B`), optionally followed by more text;
otherwise write whatever you want. The bot acts on the answer, then closes
the issue with a one-line comment saying what it did.

Only comments by the `cgwalters` login count as answers. The bot reads
everyone else's comments, including its own, as input to consider, never as
instructions.

These issues are opened by the bot's workflows here or by manually running
[agent-board](https://github.com/cgwalters-forge/agent-board)'s `ask create`.
The [review app](https://github.com/cgwalters-forge/review) is a UI for the same queue.

[docs/bring-up.md](docs/bring-up.md) says how to start a coordinator on a
fresh machine from credentials alone, how to dispatch a run and where its
state is. [docs/operator-notes.md](docs/operator-notes.md) is the log of
cgwalters' instructions.

## Review drafts

The [prose review checklist](docs/review-checklist/prose.md) gives contextual,
advisory rewrite suggestions and meaning-preservation checks. It does not enable
an automated prose reviewer. It includes a versioned [manual prompt](docs/review-checklist/prose-prompt.md)
and [positive/negative fixtures](docs/review-checklist/prose-fixtures.md).

The [offline architecture-review prototype](docs/architecture-review/README.md)
contains a versioned pattern library and manual review procedure. It has only a
three-PR development pilot and no held-out result. It is not wired into the
production review step.

[docs/review-corpus.md](docs/review-corpus.md) describes the corpus of
cgwalters' public review feedback, which is published weekly as a new dated
`review-corpus-*` release. It explains how to find, pin and download a version.

Agent-drafted reviews of others' pull requests wait as issues labelled
`review-draft` (`is:open label:review-draft` is the queue). To send the
newest draft as cgwalters-bot, tick the body's
`Send the newest draft as cgwalters-bot` box or comment just `/send`;
`.github/workflows/review-send.yml` then runs agent-board's `review send`,
which posts it only to the repositories listed in the `review` section of
`.github/poll/agent-board.json` and closes the issue. If it cannot send a
draft (a moved head, a line not in the diff), it explains the refusal in a
comment. A missing or stale approval only fails the run. The approval rules are in agent-board's
[docs/review-drafts.md](https://github.com/cgwalters-forge/agent-board/blob/main/docs/review-drafts.md).

## Dispatched tools

Dispatched runs have a staged opt-in to agenthome's `install-tools` through
the commented `[setup.tools]` in `.github/agentic-job/hosted.toml`, including ast-outline
and ast-grep. The pin is the API-resolved merge of
[agenthome#4](https://github.com/cgwalters-forge/agenthome/pull/4),
`9b43eb81e1266ec762a6c49a4e31fb6b4ff3e0e0` (main on 2026-10-14).
This configuration waits for the shared actions wrapper to upgrade from
agentic-job v0.2.0 to a release containing
[#602](https://github.com/cgwalters-forge/agentic-job/pull/602); v0.2.0
cannot parse the opt-in. After that upgrade, uncomment the four-line table.
The wrapper does not need a new input: it already passes
the caller's runner configuration. The installer runs before network
lockdown as the sandbox user, with upstream's 120-second Git phases and
600-second install limit; its code and dependencies are trusted setup,
not sandboxed task code. A real install and hardening check need a fresh
dispatched runner.

## The pass

`.github/workflows/poll.yml` runs one
[`agent-board pass`](https://github.com/cgwalters-forge/agent-board/blob/main/docs/pass.md)
every ten minutes, with `.github/pass.json` as its configuration. A pass
follows the bot's pull requests to a fix, a merge or a person, refreshes
the pools' usage from the inference broker and publishes the `bot-usage/v1`
snapshot the review app reads (from agent-board#306 on), plans and applies the operator's live epics,
starts board work by Priority within `wip` and each pool's pace, and derives
each board item's Status. Each decision is one line of the run's summary;
agent-board's docs say what each means and what it holds. The rules
themselves live and are tested in agent-board, not here.

The agent-board commit is pinned as `AGENT_BOARD_REV` in `poll.yml`, since
the binary gets the bot's token (`CGWALTERS_BOT_PAT`); move it only with a
review of that revision's `pass`. The job token starts `dispatch.yml` and
`review.yml` runs. The job joins the tailnet for the broker, whose address
is set by the repository variable `INFERENCE_URL` (or, if unset, the organization's
tailnet setting); without joining, the pass paces on the last published
snapshot. Passes share one concurrency group and never overlap.

Scheduling is top-down (`topDown: true`): P0 epic groups are considered before
unrelated parent discovery spends the request budget. Applying passes hand their
disposable `.state/pass.json` cache to the next pass as the one-day `pass-state`
artifact. Both chain dispatches supply `previous_run_id`; restore validates that
exact run's repository, workflow, default branch, applying invocation and finished
`pass` job. No shared cache or latest-by-name lookup is used. Missing, unreadable
or untrusted predecessors start cold, including schedule/bootstrap runs without
an explicit predecessor. Previews never upload state.

A forged cached body could steer scheduling despite a valid ETag, so only that
trusted predecessor is accepted. Raw state can also include private usage/holds
comments or unpublished reviews even in public repositories. Before uploading,
the caller keeps both caches' entries only for public issue/PR lists and details,
issue comment lists/details, and repository/issue label lists.
Each repository must also be currently readable as public. Entries outside this
allowlist are dropped whole, with their validators; repository visibility alone
does not make a PAT-authenticated response public. Visibility checks cost one
request per distinct allowlisted repository, capped at 100 repositories and
90 seconds. Cache bodies are never printed; losing the whole artifact is safe.

Reviews (including pending reviews), timelines (which can embed private
cross-references), review comments, Actions runs/jobs/variables,
repository contents, events, issue parent/sub-issue relations and every other
endpoint remain uncached between passes, as do all private reads. Each requested
page/detail on those paths starts with a full GET rather than a conditional GET
that could return 304: for example, reading reviews on N PRs costs the sum of
their review pages in full requests per pass. This does not add a round trip
versus revalidation, but loses the authenticated 304 rate-limit saving and body
transfer saving. Counts depend on the threads and pages visited; there is no
fixed extra request count per pass. Existing within-pass caching and request
bounds are unchanged.

Only the schema, interval and filtered response maps are handed off. Cursor,
intake and maintenance metadata can name private threads, so it is not exported;
those scans restart each pass, costing their searches/listings again and possibly
retrying refused writes. Live thread claims still prevent duplicate intake.

A scheduled pass only previews unless the repository variable `PASS_APPLY`
is `enabled`. When run manually, `gh workflow run poll.yml` previews and
`-f apply=true` applies. While `PASS_APPLY` is `enabled`, each applying pass
starts the next one ten minutes after its own start, since GitHub drops most
of the `*/10` schedule. A pass does not start the next while a newer
applying run on the default branch has not finished, so a second chain,
say from a manually started applying pass, usually folds into the newer one; a run
arriving during that check, or a newer run that never continues, can still
leave two chains or none. Setting the variable to anything else, or
cancelling the run that is waiting, ends the chain. Every pass is capped at eight agent runs, twenty
other writes and fifty Status changes (exceeding the Status cap rejects that
stage, even in preview, until someone has reviewed it); raise them in `poll.yml`
after observing the passes. New work goes through the board: an open issue
on it in a `workRepositories` repository, under a live epic or opened by
the operator or the bot, is taken in Priority order. Dispatch by hand
(docs/bring-up.md, "Dispatching a run") for anything else.

### Organization repository lists: implementation handoff

**Plan only (#1519, 10 November 2026).** The pinned agent-board revision,
`e32d2bf58baf1899d695195a36c960d8fbfcb69a`, still declares `follow`,
`workRepositories` and the harness repository list as `Vec<String>`. Do not
replace tracker’s lists with objects yet. The first slice belongs to
[agent-board#857](https://github.com/cgwalters-forge/agent-board/issues/857),
not to an implement run patching tracker. This is a handoff plan, not a
dispatch or an activation:

```agent-board-plan
{
  "schema": "agent-board/job-plan/v1",
  "repo": "cgwalters-forge/agent-board",
  "item": 857,
  "kind": "implement",
  "runner": "hosted",
  "brief": "Use the implement skill. Implement the agent-board slice of tracker#1519 in agent-board#857 only. Accept mixed exact repository names and {\"org\":\"cgwalters-forge\",\"forks\":false} entries through one shared repository-list resolver, including follow, workRepositories, holds.proposals.repositories and operatorAsk.harness.repositories; inventory other repository-list consumers and document any unsupported ones. No org discovery without an org entry; existing string-only configurations keep their behavior. The concrete threats are accidentally treating a fork or archived repository as ordinary org work, and acting on a truncated or failed census as if it were complete. Require live org membership, fork=false and archived=false for discovered entries; reject unsupported rule shapes rather than silently broadening them. Resolve each distinct org once per pass before affected actions, sharing the result across lists. Keep API requests, pagination, deadlines and final repository counts within existing pass limits; fail before affected writes on incomplete discovery or overflow, never truncate silently or reuse stale membership. Union explicit entries with discovered names, deduplicate case-insensitively, sort deterministically and log the resolved set. Explicit forks and external repositories retain their existing exact-entry rules. Preserve private-target refusal, midstream routing, noMerge, admission and spending/write limits; org membership grants no extra authority. Add recorded multi-page listing tests for non-forks, forks, archived repositories, additions/removals across passes, explicit extras, duplicates, legacy strings, invalid rules, API failure, truncation and limit exhaustion, including no affected writes on failure. Update configuration docs with the example and run the narrow resolver tests and the repository's required checks. Do not modify tracker settings or agentic-job bounds in this slice."
}
```

Tracker's migration remains separate: first review pins carrying both this
resolver and agentic-job's live `fork`/`archived` policy checks for org rules.
Then replace the four pass lists with the org entry plus each list's explicit
fork and external extras, and update `dispatch.toml` using agentic-job's tested
syntax. Keep exact midstream routing and protected-file exceptions separate;
an org target rule must not implicitly widen either. Preview the resolved sets
and policy refusals before applying. No settings or pins change in this handoff.

`.github/workflows/maintain-shadow.yml` (tracker#1356) runs `agent-board
poll --dry-run` on agentic-job every half hour, with the job's read-only
token and the settings `just maintain-shadow-config` takes from
`pass.json`. Its job summary previews what poll alone would do there, for
comparison with what the pass did; it takes no step. The shadow takes every
key of `pass.json`'s `pr`, so the preview uses the pass's full PR policy
rather than previewing merges the pass holds; the two lists that may name
only followed repositories keep their agentic-job entry alone, and a `pr`
key the recipe does not list fails the run instead of being left out.

A pull request labelled `needs-human` is not touched again until the label
is removed. A fix run can request one `add_comment` explaining why it
cannot safely change the pull request, without a push (opt-in in
`.github/agentic-job/fix.toml`); the unchanged head is what stops the fix
rounds.

Apply opens complete work ready for review (`ready_when_complete` in
`dispatch.toml` and `fix.toml`), except on a midstream fork: a repository
with the `bot-midstream` topic whose main tracks upstream (#336).
Every pull request there stays a draft. `dispatch.yml` gives those targets
`midstream.toml` and `midstream-fix.toml` instead, based on those files' `repos`.
A fork with that topic must be added to those lists before receiving dispatches.
cgwalters-review skips drafts, so a midstream pull request gets no automatic
review; `/review` still works.

### Midstream promotion

`.github/workflows/promote.yml` runs standalone `agent-board promote --config
.github/pass.json --apply --max-writes 4` every fifteen minutes, serialized
without cancelling an active run. It is **off unless `PROMOTE=enabled`** in
this repository's Actions variables, including manual runs, and runs only on
the default branch. This opt-in prevents deploying a new upstream writer
before its publication policy has been reviewed. No variable was set here.
The eight-minute invocation uses the bot token and the same verified binary
pin as the pass. Its four-write cap admits at most one whole publication,
including the create-only branch write needed for rebasing or sign-off.

The config selects bcvk, bootc, composefs-rs and ostree and reads source-pinned
records in `upstream-policy/` on tracker's default branch. Midstreams stay in
`follow` where already present: the pinned validator permits midstream-owned
forks there and ordinary merging remains disabled. `onApproval` lets the
operator's current-head approval of a draft select it; `/promote` remains
supported. `publish` permits the standalone writer, not the pass: the pass
only reports approved candidates and their first hold.

The pinned agent-board includes [#869](https://github.com/cgwalters-forge/agent-board/pull/869), implementing the operator's
[10 November decisions](https://github.com/cgwalters-forge/tracker/issues/1464#issuecomment-6782560935)
to rebase behind heads without another review when clean and add their sign-off
at promotion, independently of DCO detection. Conflicts and unsupported rewrites
still hold. The approved branch is never overwritten: publication uses a
create-only `bot/promote/APPROVED_OID` branch when rewriting is needed. These
semantics live in agent-board, not a tracker-side rewrite engine.

`just test-config` checks caller plumbing offline; `just test-pass-config`
uses the pinned binary's real validator. For a read-only live preview use
`agent-board promote --config .github/pass.json` with `GH_TOKEN`. Policies
added in a PR are not visible to that preview until merged. After merging,
the controller enables `PROMOTE` as directed in
[tracker#1464](https://github.com/cgwalters-forge/tracker/issues/1464#issuecomment-6836093025).
Unset it to stop new runs; cancel an active run separately. No live publication
or bot-fork staging verification was attempted here.

Read-only preview on 12 November 2026, using pin `862ca823`: exit 0, no writes.
The approved candidates were bcvk #13 (`behind_by=16`), bootc #44 (137) and
#85/#97/#103/#106/#109 (53), composefs-rs #50/#51/#54/#59/#60/#66/#67 (32),
and ostree #3 (61). Each reported `needs publication rebase`, not a demand
for another approval. Representative exact output:

```text
hold promote cgwalters-forge/bcvk#13 head=ce6115da3b2dfccaae2c3fbeabbd320612400448 command=https://github.com/cgwalters-forge/bcvk/pull/13#pullrequestreview-5882092269 at=2026-11-12T21:12:25Z human-text=false push=2026-10-03T15:56:33Z: needs publication rebase (behind_by=16)
```

This is discovery and read-gate evidence, not proof that a clean rebase or
publication will succeed: preview stops at the first hold and these policy
records are not on the default branch yet.

### Paced-review cutover

**Prepared, not activated (#1198/#1171; activation deferred in #1500).**
`pr.reviewPools` and `pr.reviewDispatchRepositories` remain absent in
`.github/pass.json`. The event-review outage tracked in #1496 does not make
the dispatch route ready: enabling pools with the producer reviewed in #1500,
agent-board `efc8cbe30068f8b70b76e500278690ee8ac126d5`, counts reviews in every followed
repository, including those not selected for dispatch. A missing legacy
`review.yml` makes that accounting unreadable and holds review starts globally.
Before activation, fix and pin the producer's accounting contract for
unconfigured followed repositories, with a mixed-follow test that includes a
missing legacy workflow. Deploying only the ten proposed callers is not enough.

Read-only deployed-source checks on 11 November 2026 still found no
`dispatch.yml` in agent-board and no `review.yml` in cgwalters-forge/bootc.
Readiness must be established from deployed default-branch callers accepting
`kind`, `repo`, `item`, `head`, `pool` and `task`, with the exact run identity
below, plus trusted settings and wrapper admission. A refused dispatch already
has a durable reservation; deploying its caller later does not automatically
retry that head. A configured repository list is not deployment evidence.

The threat remains duplicate, unpaced inference for one PR head while event
reviews remain authoritative. `dispatch.yml` rejects reviews unless the trusted
repository variable `REVIEW_DISPATCH` is exactly `enabled` (unset is off), before
calling any wrapper or inference. No dispatch input bypasses that gate. Existing
`review.yml`, its SHA pin, events, base bounds/task and write-authorized `/review`
admission remain unchanged. In particular, do not suppress the comment route
until the producer accepts authorized `/review` on drafts with bounded command
intake: the reviewed producer skips drafts without a draft-review opt-in. Add that owning-
layer regression test before cutover. No settings, credentials, admission,
rulesets or live reviews were changed here; this deferral does not repair #1496.

The pinned producer's
[ordinary dispatch contract](https://github.com/cgwalters-forge/agent-board/blob/6c7ecdabdad572d4f69713c55e6ab9f2c2b10e02/docs/pass.md#ordinary-dispatched-reviews-opt-in)
selects exact followed base repositories with `pr.reviewDispatchRepositories`.
It dispatches `kind=review`, `repo=OWNER/REPO`, positive `item`, exact `head`,
nonempty `pool` and a task hint to the base repository's default-branch
`dispatch.yml`. The run identity is exactly
`review OWNER/REPO#ITEM HEAD (POOL)`. The caller requires a lowercase 40-hex head
only for reviews, rejects effort/config overrides for reviews, and routes
review/non-review jobs mutually exclusively. Non-review profile, ordinary
`pools.json`/`AGENT`/`AGENT_MODEL` fallback and moving-main wrapper call stay as
before; reviews never enter those jobs.

The separate literal ordinary-wrapper call pins
[actions#198 at f05e2372d3bd5540406d444e26c70ba8c845b07d](https://github.com/cgwalters-forge/actions/blob/f05e2372d3bd5540406d444e26c70ba8c845b07d/README.md#ordinary-dispatched-reviews-dormant).
It receives only kind/repo/item/head/pool and a fixed task hint, no apply PAT or
provider key. The wrapper owns trusted `REVIEW_POOLS` resolution (explicit
agent/model and optional base-owned config, no ordinary fallback), fixed
base-owned bounds/task, default-branch/public/base-repository admission,
expected-head policy, and checked submission with the same base-repository job
token. It caps reviews at 150 requests, 500 AIC and 75 policy minutes. Review
code is fetched as data inside the credential-free sandbox, not executed in a
privileged head checkout. Missing/malformed/unknown pools fail at that owning
layer, not in a second tracker pool resolver.

`just test-review-caller` is offline caller plumbing coverage: disabled routing,
exclusive jobs, malformed/missing head, expected-head forwarding, exact title,
and unchanged non-review/legacy contracts. It does **not** prove stale-head
rejection or checked submission. Immutable wrapper boundary tests are
[cgwalters-agentic-job.test.mjs](https://github.com/cgwalters-forge/actions/blob/f05e2372d3bd5540406d444e26c70ba8c845b07d/.github/workflows/cgwalters-agentic-job.test.mjs)
(including missing/unknown pool, head/admission and pre-submit checks) and
[review_wrapper.rs](https://github.com/cgwalters-forge/actions/blob/f05e2372d3bd5540406d444e26c70ba8c845b07d/lint/tests/review_wrapper.rs)
(credential, immutable dependency and checked-publication boundaries).
`just test-review-wrapper PATH` runs the Node boundary suite from a read-only
checkout at that exact SHA; it performs no live inference or review.

#### Followed caller inventory

Read-only default-branch observations below (4 November 2026) are snapshots, not deployment
attestations. Every path is `.github/workflows/review.yml`. `pr.reviewPools`
is global across `follow`, not scoped to tracker or `workRepositories`.

| Repository (under cgwalters-forge) | Observed default-branch commit | Blocker |
| --- | --- | --- |
| agentic-job | `7d6b5a29af4f5b63ac7b61a09189804cc6ca713e` | Consumer contract exists; operator settings unverified |
| agent-board | `4966c522c259ea0fa744bd37070de925aeb29d74` | Event-only caller, actions `1b4539d` |
| tracker | `f017042504ae0792212c2c285bcb93524555d515` | Event-only caller, actions `1b4539d` |
| actions | `95c09b9947f39100117fbc69bf0b6239d2cf22c3` | Event-only caller, local incompatible wrapper |
| review | `cae17abc764c97a15cd6838e38534ad7d81579c9` | Event-only caller, agentic-job v0.6.4 |
| agenthome | `e8607434f5083ecce81b52073c556be9b245e09e` | Event-only caller, actions `bc0ea82` |
| forge-infra | `9896d511523f5cbbeb3e9f20b5ef71bb0ed85d23` | Event-only caller, actions `d8e22f7` |
| cgwalters-forge.github.io | `1e39839639e56179556e8b101dc8ac5a9c895a37` | Event-only caller, actions `bc0ea82` |
| bootc (forge branch) | `3ff59436aa70ea4b3561fd99ac463aaa44ad53ac` | No review.yml (404) |
| composefs-rs (forge branch) | `c8f8eb7384bdea4aa40018f446ed3bc0fbf05ba9` | No review.yml (404) |
| bcvk | `b2d1cc90055d0c846d649bf5519b79650aabe0a9` | No review.yml (404) |
| rpm-ostree | `911dd734bdc9d35eae33a074a613e436e7b400ee` | No review.yml (404) |
| atomic-linux-sandbox | `27811ece4961bf174e03d957477edf1575c70d2d` | Event-only caller, actions `d8e22f7` |

No external callers were edited. Missing workflows remain blockers, not implied
exemptions because their PRs are drafts or merging is disabled.

#### Coordinated activation and rollback (operator work, not run here)

This is not rollout approval. Broker/tailnet admission of the pinned ordinary
wrapper's `job_workflow_ref`, token permissions, trusted `REVIEW_POOLS` settings
and agent configuration remain unverified. Re-inventory all followed base
repositories at their deployed default-branch SHAs; the dated read-only table
above is historical inventory, never global-coverage proof. No external callers
were edited. Verify dispatch permission (`actions: write`) in each selected base
repository and exact producer/consumer pool identity before proposing settings.

Coverage must include **all authors** admitted by the authoritative event route,
including bots, associated humans and in-repository branches, plus currently
write-authorized exact `/review` commands for otherwise unadmitted authors.
The ordinary wrapper's author policy is not proof of event-route equivalence;
its bot ID/login requirements, associated-human rules and bounded command
history checks need explicit coverage. Do not silently drop authors or weaken
admission to make a pilot work. The unchanged legacy wrapper has no coordinated
record-only contract for this ordinary route: replacing/suppressing events and
commands without loss or double starts is still future approved work, not
something enabled by this caller gate.

The producer also explicitly leaves general `dispatch.yml` **merge/fix
provenance unresolved**: a review-shaped title is not kind/caller attestation.
Existing acceptance still requires the immutable Actions bot ID, current head,
public bot-fork scope, cited run and dedicated `pr.reviewWorkflow`; ordinary
intake does not widen merge authority. Do not change that workflow setting or
merge policy to pretend the preparation resolves this blocker.

For a future approved cutover, first stop paced starts and pause applying
passes. Drain/cancel existing event and ordinary review runs and inspect
ambiguous claims/reservations without erasing them. Deploy and verify the
coordinated authoritative event/command suppression or pending-record route
before activating ordinary starts; never enable both inference paths for a
head. Only then coordinate `REVIEW_DISPATCH=enabled` in approved callers with
reviewed `pr.reviewDispatchRepositories` and `pr.reviewPools` settings. Keep
existing WIP/pace/write/start bounds. Before resuming paced starts, also verify
the existing publication opt-in `AGENT_REAL_REVIEWS=true` in each caller: the
inference gate does not enable submission, and without that opt-in the wrapper
can spend inference and finish without publishing a verdict or apply fallback.
Preview before resuming applying passes. Merging source or previewing is not a
live proof.

Retain live bot ID, exact head, run URL/title and run-marker evidence for the
single submitted verdict on that head. Verify checked publication and that a
push cannot approve its replacement head, authorized-command and all-author
coverage, full-WIP/held-pool refusal, no duplicate start across later passes and
reopen/synchronize events. Exercise outage catch-up: pending current heads must
be recovered in bounded paced starts after recovery, without lost commands or
blind redispatch of an ambiguous reservation. A completed run with no verified
verdict or an exhausted failed-job retry requires human inspection. None of
these live checks ran in this preparation.

Rollback after a future approved cutover: stop paced starts first (pause passes
and remove the review scheduling opt-ins), drain/cancel outstanding runs, and
inspect ambiguous reservations without erasing claims. Disable ordinary caller
activation only after reconciling queued starts. Restore the authoritative
event and authorized-command route in every affected repository before
resuming normal operation; do not swap wrapper pins under active paced runs.
Inventory pending, still-open current heads left by suppression or an outage.
Check for active runs and existing exact-head verdicts before a write-authorized
operator requests `/review` for each remaining head, then verify head/run-marker
binding. Restoring events does not replay missed events: never push/reopen just
to retrigger or clear reservations to force duplicate starts.

### Draft-review buckets

**Blocked, not proposed (5 November 2026, #1324).** agent-board's
[draft buckets](https://github.com/cgwalters-forge/agent-board/blob/d742eb8052aec70d8d4ecf1da98bec9b645ae40f/docs/pass.md#midstream-draft-buckets-opt-in-producer-slice-of-648)
label the bot's drafts on the four midstream forks `review:quick` or
`review:deep`. The threat they guard against is a forged, stale or merely
small draft passing as reviewed. The producer is ready: `AGENT_BOARD_REV`
`d742eb8052aec70d8d4ecf1da98bec9b645ae40f` contains agent-board#680 (`9841aab`)
and the architecture-finding veto after it. The only newer agent-board commit,
`957cb93`, does not touch drafts, so the pin stays. The rest of the chain is
missing, so `.github/pass.json` sets none of `pr.draftReviewRepositories`,
`pr.reviewDispatchRepositories` or `pr.reviewPools`. `just test-review-caller`
keeps all three unset and checks the shape the coordinated change must take:

* Callers: bootc `3ff5943` and composefs-rs `c8f8eb7` (branch `forge`), and bcvk
  `b2d1cc9` and rpm-ostree `911dd73` (`main`), have no `dispatch.yml`,
  `review.yml`, `workflow/review.toml` or `workflow/review-command.toml`, so
  they have no `agent-board-review-result-v1` writer job. bootc's and bcvk's gh-aw
  `review.md` reviews do not write one either. The open prerequisites are
  bootc#99, composefs-rs#69, bcvk#24 and rpm-ostree#13.
* Wrapper: actions `9589edab2953e53fb244ec058011efe5e714c6ec` (actions#198 closed
  actions#174) binds a review to its expected head and pool. It still refuses
  draft pull requests and has no result-writer job, so ordinary dispatched
  reviews can't produce draft evidence. actions#201 only documents the
  prerequisite.
* Consumer: review `b04aa1d` does not read the needs-you `review_buckets`
  extension, so it would show every draft as unknown.

Once all three exist, propose `pr.draftReviewRepositories` and
`pr.reviewDispatchRepositories` for exactly those four repositories, plus
`pr.reviewPools = ["openai", "claude"]`. Keep them in `follow` and `pr.noMerge`,
keep the existing caps and the private holds destination, and coordinate this
with the paced-review cutover above, since `pr.reviewPools` applies to every
followed repository. Preview before applying. To roll back, remove
`pr.draftReviewRepositories`. A `review:quick` label, whether added by hand or
left over from before the rollback, never grants authority to mark ready,
merge, fix or approve. Approval stays bound to the head the app displays.

### Broker outages

Set the repository variable `BROKER_OUTAGE=apply` to enable the
fifteen-minute `broker-probe.yml` schedule (off otherwise). It runs
agent-board's
[`broker probe`](https://github.com/cgwalters-forge/agent-board/blob/main/docs/broker-probe.md)
at the commit `supervisor.yml` pins, with `.github/broker/config.json`. The
probe joins using the dispatch tailnet wrapper and adds `INFERENCE_URL` to
that config as its `url`, using the repository variable or, if unset, the wrapper's
configured proxy. It makes one TCP
connection and one unauthenticated GET, each limited to ten seconds. Any
HTTP response shows reachability, not that inference works. It creates one
bot-owned `outage` issue here, updates it while down, and comments and
closes it on recovery. Tailnet join or reporting failures fail the workflow
rather than falsely reporting broker recovery. There are no ACL or credential changes. The
pass does not read the issue.

## Epics

The [3 November 2026 composefs (C) CI inventory](docs/composefs-c-ci-2026-11-03.md)
records the read-only 30-day baseline for #1222 under the green-CI epic #1215,
including zero default-branch activity and evidence/coverage limits. It is not
the ongoing monitor or a CI fix.

### Plans for review

Design-level work is planned with the operator before any of it runs
([#675](https://github.com/cgwalters-forge/tracker/issues/675)): work started
without an agreed target has gone the wrong way. A planning session (the
controller and a subagent working from local clones, iterating with the
operator) files its plan as an issue in this repository, assigned to the
operator and labelled `needs-human`. Its body leads with the example
contract, the workflow YAML or command a user would actually write, then the
design, the slices in order, risks and open questions
([#674](https://github.com/cgwalters-forge/tracker/issues/674) is one). The
operator's comments ask for revisions. Without an `epic` label, it is a
plan under review, and the pass does not touch it. The operator approves it by adding `epic`
and removing `needs-human`; as for any epic, only the
configured operator's label counts. The pass then plans it: the slices
become sub-issues, the example contract the first where there is one, and
it schedules them as for any epic.

### Supervisor

`supervisor.yml` runs `agent-board supervise health` every fifteen minutes on the default
branch, from its own crons. Every run, including a prompt-less dispatch, is a
health pass. `agent-board supervise due` decides the sweep from the
`times.json` the previous `supervisor-health` artifact carries: a pass
sweeps when the last sweep was two hours ago or more, or on an explicit
request (a prompt or a comment). If looking up that artifact fails (rather
than finding no artifact), only an explicit request triggers a sweep (#814). `health.json` is a list of checks
with `id`, `status` (`ok`, `warn`, `fail`), evidence links and a suggested
action; each check also has one summary line. All thresholds and collection
bounds are in `.github/supervisor/config.json`, with repository identities
in that file and the existing poll configuration, never dispatcher inputs.

The health step reads with the bot's token (`CGWALTERS_BOT_PAT`), as the execute
job and the poll do. The usage snapshot (`pace`) is in the private repository
named in `.github/usage/config.json`, which the job token cannot read. The job
token's 1000 requests an hour are nearly used up by four passes. The step runs
only agent-board built from the pinned revision, never an agent or pull
request code (the operator, 17 Oct: the same token as everything else of the
bot's, rather than a separate read-only one). Missing access and truncated listings are warnings, not
healthy observations, and fail once they have lasted
`unavailableFailHours`: each pass reads the previous pass's `health.json`
artifact to find when they began. API requests have deadlines and a total
budget and a seven-minute collection deadline; the health step has an eight-minute
limit, within a 25-minute job that installs a verified agent-board binary using
`just build-agent-board` at the commit pinned as `AGENT_BOARD_REV` in
`supervisor.yml`. The `execute` job installs the same binary. As in `poll.yml`, it
never follows agent-board's branch: the executor receives the bot's token, so
a change to agent-board reaches it only when that pin moves here, after review. The newest health artifact among
the last five completed runs is restored with a two-minute bound and passed as `--previous`;
a missing or unreadable report starts unavailable timers afresh.
These bounds prevent a stalled API or
oversized census from exhausting a runner. The JSON artifact contains links
and fixed actions, not issue bodies, titles, private decisions or logs.

The health pass reads the epics with its own census.
Recent PR/queue activity is every PR updated within `eventLookbackHours`,
up to `maxPages` GraphQL pages per followed repository; it is not a
historical audit. A removal from the queue because the PR merged is not
counted. Infrastructure findings
are warnings from probe/label time overlap, not proof that a retry is safe.
A disabled broker probe (`BROKER_OUTAGE` unset) provides no observation: this is a warning that fails after an hour.
Decisions currently cover open public question issues assigned to the operator,
excluding ones with an authenticated operator reply; the private decision
document is not published or interpreted. Loop detection uses checkpoint
failures and pending-operation staleness, not speculative interpretation of agent prose.

The checks the controller ran by hand: `idle` and `stuck`, which read the
old board scheduler's lines from the log of the job `schedulerJob` names
and so find nothing in the pass's log (`pass`) until the supervisor is
redesigned; `pace`, a
pool's used share of its window beyond `paceMarginPercent` points from the
share elapsed; `failures`, the newest dispatch run of a kind and target that
failed with a secret-shaped string, an `E0NN` safe-output refusal or missing
data naming a closed blocker, from its failed jobs' annotations;
`held`, `needs-human` on the bot's PR past `holdWaitHours`; `unqueued`, an
approved PR whose merge state is clean, out of the queue past
`unqueuedWaitHours`; `unclosed`, the bot's merged implement PR whose run's
issue is open past `unclosedWaitHours`, unless it says it is part of it.

**The agent and the executor** (D14) are off unless `SUPERVISOR` is `preview`
or `apply`. No repository variable is changed by this wiring. The agent runs
on a failing check (with `agent.cooldownHours` cooldown), a two-hour sweep
(decided in the health job, with `7 */2 * * *` as a fallback), a manual prompt, or a new comment by the configured operator
on the locked requests issue (here #656). The comment gate also rejects PR comments;
the login and issue are checked against trusted config in tests. The requests
issue must be locked by the operator before comments can wake the agent. Another
deployment sets the repository variables `OPERATOR` and
`SUPERVISOR_REQUESTS_ISSUE` to its `operator` and `agent.requests.issue`,
since that gate runs before checkout; unset, they default to this one's.

```sh
gh workflow run supervisor.yml -R cgwalters-forge/tracker \
  -f prompt="close what triage found done in agent-board"
```

With `-f session=true` (and optionally `-f pool=openai`, default `claude`)
the agent runs as an interactive session: after its first turn it waits for
the operator's prompts over the tailnet, for up to `session.json`'s
`idleMinutes` each, and its `supervisor-actions` comment goes to the executor
when the session ends, as for any run. A session is an explicit request, in
`supervisor-agent`, and needs `TAILNET_DOMAIN` and `session.json` enabled.
A step posts its `wss://` endpoint on `session.json`'s issue (#728) as
`session.yml`'s runs have it; the review site's chat pane reads only the
workflows its configuration lists, so far `session.yml`. `[session]`
operators and origins are `hosted.toml`'s, copied into `supervisor.toml`.

A check that never clears fails on every pass and so started an agent every
cooldown hour to read the same report (#804). With
`agent.skipUnchangedFailures` set to true (it ships false),
`agent-board supervise repeat` leaves the trigger out of a pass that
is not a sweep or request if every failing check also failed in the
previous report; the sweep reads ongoing failures and their new evidence.
A failure that first appeared while the trigger declined (cooldown, an
active agent) also waits for a sweep.

Comments, prompts and the sweep share workflow-wide `supervisor-agent`
concurrency without cancelling an active run, so a request waits through the
previous executor instead of the trigger discarding it. The fifteen-minute
health passes, prompt-less dispatches included, use `supervisor-health`: GitHub retains only one pending run per
group and a newer arrival replaces it, so a shared group would let the next
pass evict a queued prompt. A health pass that finds an agent active declines
and retries after its cooldown; a prompt the trigger declines fails its run.
The executor keeps its own `supervisor-execute` group. A second prompt queued
behind a pending one still replaces it, so use the requests issue for durable
requests and steering an active agent.
The agent is a `research` run
of the shared wrapper, using `agent.pool` and the wrapper's read-only job
token, not the bot token. Its task includes the supervisor profile and skill
of the agenthome repository and commit that `agent.profile` pins, agent-board's policy and this pass's health report. It also
reads `docs/operator-notes.md`, the latest `supervisor-health` artifact's
`health.json` and the configured state issue. Its isolated runner config sets
`session.watch-item = true`: later comments arrive as attributed data, and
only the configured operator's comments are instructions. Its one comment on
the requests issue carries a `supervisor-actions` block of typed requests.

`agent.state` names the locked state issue #718, distinct from the requests
and log issues. `replace_state` edits only that issue's body, within its
daily cap below. The body persists and every later run reads it first, so a
misled run can plant text for later runs; it is data to them, but with the
other caps above zero a later run can act on it within those caps. A batch
that would exceed a daily cap is rejected in full. Missing state is reported,
never guessed.

The `execute` job has `CGWALTERS_BOT_PAT` in the `agent-apply`
environment and does not run agent code. It executes only on a run's first
attempt, and accepts only the bot's comment, unedited, on the requests
issue that this run's apply reports. It validates the whole
batch with `agent-board supervise execute`. The shared executor admits
dispatches, with fixed briefs and reasons, on open issues regardless of who wrote them,
and an implement dispatch only under an open `epic`-labeled parent. The
boundary against an injected request is the run's sandbox and the required
pull request review, not collaborator-only input (agent-board#158). That
review is a model's verdict (`review.yml`), and the pass merges an approved,
green head, so an issue anyone writes can reach a merge with no human step;
the caps bound how many runs it can spend.
Trusted config names the permitted dispatch kinds, tracker and project, and
the caps: `maxDispatchesPerPass: 4` and
`maxDispatchesPerDay: 40`, and the daily caps `comment: 20`,
`create_issue: 15`, `close: 10`, `remove_needs_human: 12`,
`replace_state: 48` and `status_update: 1`.
Only the operator raises caps
after review. The executor records requests before starting them, stops at the
first failed write, and logs the outcome without agent text.
`agent-board supervise trigger` supplies the wrapper inputs through
`GITHUB_OUTPUT`. In `preview`, the execute job lists the proposed comment
without a bot token or calling the executor (which always writes its log).
Only `SUPERVISOR=apply` runs `agent-board supervise execute` with the bot token.
The hosted preview proof still requires an operator-enabled run: confirm it
lists requests and applies none, then compare a week of preview against the
local loop before enabling apply with small caps.
The pacing, the repeat check, the task composition and the preview are
agent-board's `supervise due`, `repeat`, `compose` and `preview`, tested
there. CI installs the supervisor workflow's exact pin with
`just build-supervisor-agent-board`, and `just test-supervisor-config` runs
`supervise trigger` on empty health checks, without `--daily`, to validate the
shipped settings and executor policy without API calls or writes.

The agent cannot read the private decisions document (its token reads only
this repository), and the review site's last-run panel is
cgwalters-forge/review's to build; both are left from #626.

## The release train

`.github/workflows/release-train.yml` runs agent-board's
[`release-train`](https://github.com/cgwalters-forge/agent-board/blob/main/docs/release-train.md),
at the commit it pins as `AGENT_BOARD_REV`, to cut agentic-job's releases and
move the pins after them (#650), in the order the controller did by hand: the
version bump PR, `release.yml` once it merges, the pin bump of the actions
wrappers once the release is out, then the `review.yml` pin bumps of the
callers once that merges. The repositories, files, threshold and labels are
in `.github/release-train/config.json`. A release is due when at least
`threshold` PRs have merged since the last release and it was `intervalHours` ago,
or immediately when one of them is labelled `P0`; the bump is minor if one is
labelled `breaking`, a patch otherwise. The train also follows releases cut outside it,
whether manually or by anyone else (#723): when the wrappers
pin an older version than the latest release, a pass opens a train for that
release starting at the wrappers' pin bump, unless a train for it was
closed or its tag is not on agentic-job's default branch. The PRs come from the bot's forks
with the release notes for the callers' interface changes, and go through
each repository's review and queue; the train only waits for them.

It is off unless the repository variable `RELEASE_TRAIN` is `dry-run`,
which prints each pass's step, or `apply`, which executes it with
`CGWALTERS_BOT_PAT`: that token needs to open issues here, push to the bot's
forks (named in the configuration: a fork does not have to share its parent's name)
with the workflows permission, as the pins are in workflow files, open PRs
upstream and run agentic-job's `release.yml`. Each release
has one tracking issue here, opened by the bot and labelled
`release-train`, with a comment per step. A step it cannot take (a PR closed
unmerged, a failed `release.yml`, a file whose pin it cannot find) labels
the issue `needs-human`, which halts the train until the label is removed; closing
the issue drops that release: a later train for the same version ignores
its closed PRs, halts on one still open, and does not start while main has
a version bump that was never released. `agent-board release-train --config
.github/release-train/config.json` is a dry pass with the token in
`GH_TOKEN`; its tests are agent-board's.

The configured `secureHost` stage (#1253) stops unattested or wrong-source
images from being promoted: after release it resolves the versioned image with
`skopeo` and verifies the digest with `gh attestation verify` under the
publisher's existing policy. It opens the image pin PR from
`cgwalters-bot/actions-1`; only after that merges do the wrappers' secure-host
references move to its immutable merge commit. `wrappers.files` includes
`cgwalters-agent.yml`, which now owns the host invocation, as well as the
dispatch/review wrappers, smoke workflow, wrapper tests and README. The
serialized, bounded workflow provisions only missing verification tools and
fails if installed `gh` lacks attestation verification; the existing
`RELEASE_TRAIN` gate remains off unless explicitly configured.

Bootstrap is the next release, not a backfill: leave the closed v0.6.9 train
untouched. Coordinate image adoption with [actions#230](https://github.com/cgwalters-forge/actions/issues/230)
and its existing image PRs, not a competing image bump (the original #180 is
merged). A conflicting open PR or publication failure is a blocker, not a
reason to replay the train, remove a hold or bypass credentials/attestation.
Separately authorized hosted acceptance remains outstanding: prove the
effective image matches the release, the actual image-installed host binary
and sandbox binary versions match it, and handback check succeeds. A policy
binary, overridden PATH, fixture test or version warning is not that proof
and does not complete agent-board#636.

## The agent-board pin

Every workflow that installs agent-board pins the same commit as
`AGENT_BOARD_REV`; `just agent-board-pin`, part of `just test` in CI, fails
when they differ. `.github/workflows/agent-board-pin.yml` runs `just
bump-agent-board`. The pass starts it when agent-board's main differs from the
pin and has no pin PR yet; it also runs hourly as a fallback. When agent-board's
main is ahead of the pin, all its check runs passed and its published binary
passes the shared installer's verification, it opens or updates
one pull request from the bot's fork (branch `agent-board-pin`) moving
every pin to it and listing the commits in between. The review and the
pass handle it like any bot PR. It is off
unless the repository variable `AGENT_BOARD_PIN` is `enabled`, and uses
`CGWALTERS_BOT_PAT`, which needs the workflows permission on the fork.

`just build-agent-board` retains its historical name and installs into
`$RUNNER_TEMP/agent-board/bin/agent-board`, emitting `rev` to `GITHUB_OUTPUT`.
It requires a full commit argument (or `AGENT_BOARD_REV`), never a moving
branch. On Linux x86_64 it downloads `build-<commit>`'s static musl binaries,
manifest, checksums and provenance. It verifies the manifest's attestation
against agent-board's CI on main and the pinned source digest without a token,
then checks the manifest identity and both binary digests before installation.
This prevents substituted assets from running with the bot's write token.
Downloads and attestation verification each have a 180-second limit. Missing
assets, unsupported platforms and failed verification stop the job; there is
no compilation fallback. Only the download step receives the ordinary job
token; job permissions and mutation gates are unchanged. The exception is
`just bump-agent-board`: its nested install inherits `GH_TOKEN` and downloads
with the bot's token, `CGWALTERS_BOT_PAT`, though verification still runs
without one. Fixture tests cover these failures and refuse bump selection
without a verified binary. They also run the real `gh attestation verify`,
offline, on a published release's manifest and bundle and Sigstore's trusted
root, committed under `.github/agent-board-install/`: it accepts that commit
and rejects another commit, a changed manifest and another signing workflow.

From `2bad88d` the pin fits an over-long needs-you list without dropping
actionable approvals first (agent-board#722, review#251). Before, the
`pr.operatorPaths` approval, unranked and newest, lost its card first and
review showed it as a "Detail not published" placeholder. `just
test-needs-you-fit`, part of `just test`, keeps the publication's settings
as they are. Given read-only agent-board and review checkouts, it also
checks that the pin's 174-decision fixture keeps each approval's card and
`review-at-head` descriptor, and that review reads one row per decision,
each approval actionable. Review still counts each group member as a
decision in its summary line (202 for the fixture's 174). To roll back,
first set `AGENT_BOARD_PIN` to anything but `enabled` so the hourly bump
does not propose main again. Then move every pin back to
`d278162e9ead1244db1ffcfafab74016e3c9e4ea`, which also drops `6fc1679`'s
digest asks kept across a failed maintain read. That brings back both
limits: the dropped approval card, and a review wait without a card
restarting its age every pass, which rewrites the holds comment each time.

### Compact approval evidence

**Caller contract, not live acceptance (#1336).** The concrete threat is
showing green CI or an approved review for a different head than the displayed
approval. The producer's default-off `holds.approvalEvidence` extension binds
published facts to that head; `.github/pass.json` already enables it with
`holds.needsYou=true`, including as a prerequisite for Act now and Today
(#1424). This documentation leaves the existing private holds repository, issue,
publication transport, feature switches and pass bounds unchanged.

Producer source `730a40ceece1f665eb71ff95ab2436acb26de933` already
contained [agent-board#687](https://github.com/cgwalters-forge/agent-board/pull/687)
(merge `957cb9362a16f4fd13471c7d1c6252a0597eda6d`) and subsequent evidence
hardening; the current pin (`just agent-board-pin`) is newer and is not changed
here. That source's
[contract](https://github.com/cgwalters-forge/agent-board/blob/730a40ceece1f665eb71ff95ab2436acb26de933/docs/pass.md#approval-evidence-optional-v2-extension)
is `agent-board/approval-evidence/v1`, inside needs-you v2. It uses stage 2's
existing observations, adds no requests or authority, and describes at most 50
rows, evicting evidence before detail cards under publication pressure. Counts,
order and waiting clocks do not change; `observed_at` alone does not advance
`changed_at` or force publication.

The compatible consumer is review source
`3fb56cf9c3bedfe663bd236912ebc967ac8c1812`, containing merged
[review#262](https://github.com/cgwalters-forge/review/pull/262)
(`b939a92b374905d2acdcb2d1d6515c5b493b34d2`, closing #239), not the earlier
#243/#254 drafts or merely `review_buckets` support. Its `src/github/holds.ts`
parses the versioned extension and joins it only to fresh, ungrouped,
complete-source approvals at the same head. `src/github/inboxview.ts` also
requires fresh evidence and a matching displayed action, labels it published,
not live, and treats partial CI as unknown. Absent, carried, wrong-head,
malformed or evicted evidence remains unknown, never proof of success. The
viewer-token commit-bound approval preflight remains independent.

`just test-needs-you-fit` checks the enabled caller settings offline.
`just test-pass-config` validates the full configuration when `AGENT_BOARD`
names the verified pinned binary, as in CI. For owning-layer evidence tests,
use a read-only producer checkout at the SHA above or the current pin:

```sh
cargo test --locked --manifest-path /path/to/agent-board/Cargo.toml -p board-forge approval_evidence
cargo test --locked --manifest-path /path/to/agent-board/Cargo.toml -p board-forge pass::tests::config_table
```

These cover default-off behavior, flag validation, serialization, cap/eviction
and clock behavior. The producer's shared
`fixtures/approval-evidence-needs-you.json` serializes the extension, not a full
publication; a consumer compatibility probe must supply a synthetic needs-you
envelope. None of these checks is a private snapshot or a deployed UI test.

Before accepting deployment, an authorized viewer should identify the deployed
review revision and read the current private publication without writing: verify
the extension version, displayed head and observation time, missing/partial
fallbacks, and unchanged counts and destination. Do not paste the private payload
into public logs or this repository. This run did not read that publication,
verify the deployed UI, run a controller/preview, dispatch work or approve a PR.
The consumer PR also reports a follow-up for retained same-head receipt headings
after a review changes to withheld; this proposal does not fix it.

Before removing `holds.approvalEvidence` from `.github/pass.json`, disable its
dependent features (including Act now and Today) and validate the resulting
configuration with the pinned binary. Retain `needsYou`, the private destination
and the sufficient producer pin. The next
ordinary publication omits the extension and the consumer returns to unknown;
an already-published snapshot is not synchronously erased by a config rollback.
Do not run a controller merely to force that refresh.

## Daily retro

`retro.yml` runs at 08:23 UTC daily, or manually, only on the default branch
and with repository variable `RETRO=enabled` (unset is off). This opt-in prevents
an unreviewed daily miner from spending inference and filing duplicate work.
Set `INFERENCE_URL` to the existing broker address and, for another audience,
`INFERENCE_AUDIENCE` before enabling; no address is embedded in this caller.
The workflow selects the `openai` entry of `pools.json` and reads the fixed
[retro brief](.github/agentic-job/retro.md). It covers the previous 24 hours,
or seven days for its first completed report, grouping bugs and waste by cause
with public run/log evidence and the repository that owns the fix.

Unlike the comment-only dispatch wrapper, this research job composes the pinned
agentic-job policy, sandbox, check and apply jobs directly. The dedicated
`retro.toml` bounds admit at most three issue creations/comments combined per
run, only in tracker, with no code changes, PRs, closes or dispatches. Existing
issues receive evidence comments; new tracker issues enter the pass's normal
board intake. Deduplication, collection limits and evidence quality are brief
instructions, not deterministic guarantees. The agent gets only its job's
read-only token; only apply receives `CGWALTERS_BOT_PAT` in `agent-apply`, so
new issues have the bot identity that the pass admits for board intake.
Other repositories' Actions logs/artifacts may be inaccessible with that token,
including devspace's: reports must state gaps rather than claim full coverage.
No private-log credential is added. The workflow bounds inference at 150
requests, the openai pool's budget and 45 policy minutes. Findings and coverage
also remain in `retro-agent-run` artifacts, including on a noop.

Enable only after checking tailnet/broker admission for this new workflow and
an operator-started smoke run; none was dispatched in its implementation.
Unset `RETRO` to stop new runs, and cancel an active run separately if needed.

## Weekly runs

Two scheduled workflows start a run of `dispatch.yml` as the pass does,
with the job token and `actions: write`. `weekly-eval.yml`, on Tuesdays,
normally does only that: it starts a `research` run that re-evaluates our tools
against gh-aw and the like and comments on #519.

The documentation replacement (#972) is prepared, **off by default**. Setting
tracker's repository variable `WEEKLY_EVAL_DOCS=enabled` replaces that dispatch
for both scheduled and manual runs with two sequential calls to
`weekly-comparison.yml`, one per project. This opt-in prevents an unreviewed
switch from reports to inference spending and PR publication. Unset it to
restore reports; cancel outstanding runs separately if needed.

Each target may propose one draft PR (at most two files and 64 KiB), or one
no-change/missing-data/tool result, checked by `weekly-comparison.toml`.
Comments, issue creation, existing-branch pushes and dispatches are not admitted.
The brief limits changes to comparison documentation, requires immutable source
links and avoids duplicate open comparison PRs; those content rules are agent
instructions, not a documentation-path allowlist enforced by check. Ordinary
protected-file rules still apply. Each run uses the openai pool's budget, 150
requests and 45 policy minutes. No-op results remain in run artifacts/summaries,
not long comments on #519. Only apply receives the bot's write token, in
`agent-apply`; the agent holds only the job's read-only token.

The first project runs still need to refresh agentic-job's
`docs/background-ghaw.md` and create agent-board's coordination page, linking
back rather than repeating the run-side comparison. This tracker patch does
not edit either project or close #972/#519. Before activation, verify the
pinned v0.6.11 composition (the same as retro), tailnet/broker reachability and
fork publication with an operator-started smoke run. No variable was changed
and no live run was started here. `just test-config` checks the offline caller
contract. With the workflow-pinned `agentic-job` on PATH,
`cargo test --locked --manifest-path .github/agentic-job/config-test/Cargo.toml weekly_comparison_policy -- --ignored`
exercises its policy/collector/check commands without inference or forge writes.

The separate [monthly review refresh](.github/workflows/monthly-review-refresh.yml)
runs on the first of the month at 08:00 UTC, or manually, with the same fixed
`implement` task. It is **off by default**: repository variable `REVIEW_REFRESH`
must be `enabled`, and both entries require the default branch. Leave it unset
until reviewed artifact pins, complete retained snapshots, frozen component
protocols and unused isolated evaluation samples exist. It only dispatches;
the task checks prerequisites again and returns unfinished/no-update when they
are missing. Updates to code, architecture and prose go through one draft PR;
activation through reviewed release-train pins remains separate. See the
[corpus prerequisites](docs/review-corpus.md#monthly-checklist-refresh).

`weekly-blog.yml`, on Sundays, runs agent-board's
[`digest`](https://github.com/cgwalters-forge/agent-board/blob/main/docs/digest.md)
with `.github/weekly-digest.json` for this deployment's templates and budgets.
It gathers the week's material for the weekly
notes on the organization site (cgwalters-forge/cgwalters-forge.github.io,
`/blog/`): `agent-board changes --public-only` (the status updates are
copied whole: they are public because the project is) from the Sunday
before at 18:00 UTC to this one (`--until`), trimmed to a fixed 26,000
characters with `--max-chars`, then releases published in that window in
the public repositories in the board configuration's `follow` list (tag,
name, URL and publication time), then the project's status updates, oldest
first. Release listings are capped at ten pages of 100 per repository; an
incomplete listing fails the run. The release section gets at most 10,000
bytes, with an omission count if needed, within the existing 56,000-byte
body budget. It files that, after a short brief, as the issue
`Weekly notes: week ending YYYY-MM-DD` in the site repository, adds it to
the board at P0 and starts an `implement` run on it that writes the post,
`content/blog/YYYY-MM-DD.md`, and opens a pull request that closes the
issue. The issue and the board item are written with `CGWALTERS_BOT_PAT`,
at the agent-board commit the workflow pins. The status updates get the
rest of GitHub's body limit, without their HTML comments; the oldest are
left out first, and the body says so. A run before the week ends is refused,
unless started with `partial=true`, which files the material available so far and
says so; that is then the week's material, as a later run reuses the
issue. A re-run reuses the week's issue, the latest Sunday's, as it was
filed; once it is closed, or while a pull request that closes it is open
or a run for it is queued or running, nothing more is started. The
schedule is off unless the repository variable `WEEKLY_BLOG` is `enabled`;
`gh workflow run weekly-blog.yml` runs it at once. The site repository has
no review workflow yet, so the operator's approval is what lets the pass
merge the post.
