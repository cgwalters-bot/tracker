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
The [control app](https://github.com/cgwalters-forge/review) is a UI for the same queue.

[docs/bring-up.md](docs/bring-up.md) says how to start a coordinator on a
fresh machine from credentials alone, how to dispatch a run and where its
state is. [docs/credentials.md](docs/credentials.md) lists the
organization's GitHub credentials and the plan to scope them.
[docs/operator-notes.md](docs/operator-notes.md) is the log of
cgwalters' instructions.

## Review drafts

The [prose review checklist](docs/review-checklist/prose.md) gives contextual,
advisory rewrite suggestions and meaning-preservation checks. It does not enable
an automated prose reviewer. It includes a versioned [manual prompt](docs/review-checklist/prose-prompt.md)
and [positive/negative fixtures](docs/review-checklist/prose-fixtures.md).

The [checklist evaluation scorer](docs/review-checklist/evaluation-scoring.md)
counts manually adjudicated baseline/checklist findings offline. It provides
accounting and a matching rubric, not held-out evaluation results.

The [offline architecture-review prototype](docs/architecture-review/README.md)
contains a versioned pattern library and manual review procedure. It has only a
three-PR development pilot and no held-out result. It is not wired into the
production review step.

[docs/review-corpus.md](docs/review-corpus.md) describes the corpus of
cgwalters' public review feedback, published daily while incomplete, then roughly
weekly as a new dated `review-corpus-*` release. It explains how to find, pin and
download a version.

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
every `PASS_INTERVAL_MINUTES` (45), with `.github/pass.json` as its configuration. A pass
follows the bot's pull requests to a fix, a merge or a person, refreshes
the pools' usage from the inference broker and publishes the `bot-usage/v1`
snapshot the control app reads (from agent-board#306 on), plans and applies the operator's live epics,
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

### Poll read credential cutover (#1679)

The isolated **Start the agent-board pin bump** step can use Octo STS for its
two in-org reads: the agent-board branch head and tracker's existing pin PR.
Its dispatch still uses the job token, and `One pass` still uses the PAT.
This first slice does **not** give the main pass an independent rate limit.
The concrete threat is exposing a long-lived credential with bot write access
to code that needs only two public reads. No write identity, review gate,
ruleset bypass or accepted author changes in this slice: the App only reads;
`--author cgwalters-bot` still selects the existing bot-authored pin PR.

It is off by default. Set tracker repository variable `POLL_READ_STS_DOMAIN`
to the operator's Octo STS hostname (HTTPS, no scheme or path) only after the
App installation and the org-level policy below are deployed. Leave the
variable unset to retain the PAT for this step. With it set, minting is capped
at one minute, the read/dispatch step at two minutes; exchange failure or an
empty minted token never falls back to the PAT. Unset the variable to roll back
to the PAT used by `One pass` (the environment writer after the cutover).
The separate existing `AGENT_BOARD_PIN=enabled` gate still controls the step.

The policy belongs in **cgwalters-forge/.github**, not tracker, at
`.github/chainguard/tracker-poll-reads.sts.yaml`. It is an external prerequisite,
not a policy deployed by this patch. The example below is for `pass` without
an environment. After the [writer cutover](docs/credentials.md#plan) moves
`pass` into a protected environment, GitHub's default name-based subject is
`repo:cgwalters-forge/tracker:environment:<environment-name>`, not the branch
subject. Before activation, confirm the actual OIDC subject (including any
immutable IDs) and match it exactly. Keep the separate exact `ref` and
`workflow_ref` constraints: the environment subject doesn't include the
branch. The additional claims bind the grant to the exact caller, workflow
and main branch:

```yaml
issuer: https://token.actions.githubusercontent.com
subject: repo:cgwalters-forge/tracker:ref:refs/heads/main
claim_pattern:
  repository: cgwalters-forge/tracker
  workflow_ref: cgwalters-forge/tracker/\.github/workflows/poll\.yml@refs/heads/main
  ref: refs/heads/main
permissions:
  contents: read
  pull_requests: read
repositories:
  - agent-board
  - tracker
```

Verify a main-branch run before leaving the exchange enabled:
the exchange and both reads must succeed, the dispatch must still use the job
token, and a non-main/workflow-mismatched identity must be refused. Offline
coverage is `cargo test --locked --manifest-path .github/agentic-job/config-test/Cargo.toml poll_read_sts`.
No live federation or secret setting is performed here.

The main pass cannot yet be cut over safely in this repository alone. Its
pinned [credential client](https://github.com/cgwalters-forge/agent-board/blob/c80688c0d7d73e5c5cfccc022b95f16375668cb5/crates/board-forge/src/github.rs)
uses one `GH_TOKEN` for reads and writes, with only dispatch separately routed.
The pass mixes org reads with external PR follow-up, authored-PR discovery,
private broker direction, and writes whose receipts are trusted as
`cgwalters-bot`. First add opt-in org-read routing in agent-board, preserving
PAT routing for external/private-account reads and identity-sensitive writes,
then pin and configure that tested revision here. Never replace the entire
pass token with this two-repository read-only token or broaden its permissions.
App tokens use the installed App's identity, not `cgwalters-bot`, and tokens
from one installation share its rate limit: a new policy alone is not a
dedicated installation or an independent limit from other App users.

Current tracker workflow inventory (14 November 2026; all paths below are
under `.github/workflows/`) remains unchanged except the optional read step:

| PAT caller | Use and reason it remains |
| --- | --- |
| `poll.yml` | Mixed in-org/external reads and bot-authored writes in `One pass`; optional isolated pin reads above |
| `promote.yml`, `review-send.yml` | Upstream promotion/push/PR publication and approved upstream review comments; retain PAT for external bot actions |
| `dispatch.yml`, `session.yml`, `supervisor.yml` | Safe-output publication/push/status as the bot, potentially external; supervisor also has mixed private reads and in-org executor/state writes |
| `agent-board-pin.yml` | In-org pin PR/branch writes as the bot; migrate separately after authorship consumers are tested |
| `broker-probe.yml` | Reads and incident writes against the broker account outside the org |
| `release-train.yml` | In-org release/repair reads and writes; separate migration needed |
| `weekly-blog.yml` | In-org project reads and site issue/board writes; separate migration needed |
| `retro.yml`, `weekly-eval.yml` | In-org safe-output publication as the bot; separate migration needed |
| `weekly-comparison.yml` | Accepts `SAFE_OUTPUTS_PAT` from its reusable-workflow caller; publishes in-org comparison changes as that identity |

Org-wide workflow census (14 November 2026): the default branches of all 39
cgwalters-forge repositories, all public (forks included; secure-host is empty),
were searched for the four secret names. Outside tracker:

| Repository | Use |
| --- | --- |
| actions | `cgwalters-agentic-job.yml` and `cgwalters-review.yml` declare and forward `SAFE_OUTPUTS_PAT` to agentic-job; the caller chooses its value |
| agentic-job | Reusable workflows (`agentic-job.yml`, `policy.yml`, `apply.yml`, `dispatch.yml`, `review.yml`) take `SAFE_OUTPUTS_PAT` for publication and status; the `example*.yml` callers pass it from an apply environment; CI passes none |
| agent-board | `reconcile.yml` reads its staging project with `STAGING_PROJECT_READ_TOKEN` and passes `SAFE_OUTPUTS_PAT` to apply, both from environments (`staging-project-read`, `staging-project-apply`) |

No workflow outside tracker names `CGWALTERS_BOT_PAT`, and none anywhere names
`GH_READ_TOKEN`. This covers workflow references only: this run could not list
installed org, repository or environment secrets, and non-default branches were
not searched. A secret exposed to all repositories is still available to any
workflow added on any branch (tracker#1619), which is why the scope should be
restricted. `SAFE_OUTPUTS_PAT` is an input name in these workflows, not
evidence that a caller stores the value in an environment. The trust-policy
PR, mixed-read routing and writer identity compatibility are follow-up slices
of #1679.

**`CGWALTERS_BOT_PAT` is restricted to tracker** (verified 22 November 2026).
That still exposes it to tracker workflows outside protected environments;
follow the [credential cutover plan](docs/credentials.md#plan) to separate
apply from status and retire the org secret.

Scheduling is top-down (`topDown: true`): P0 epic groups are considered before
unrelated parent discovery spends the request budget. To keep already-held
items from consuming the reads needed by ready work, `readFreeHolds: true`
uses holds proven by the current board pass before reading assignment history.
Incomplete evidence still takes the normal read path; start checks and caps
are unchanged. Remove the setting to restore the default behavior.

#### Repairing needs-you questions

A label-only ask or a question superseded by a newer verdict leaves the
operator without a decision to make. Tracker opts into the pass's default-off
`revisit.repairQuestions`. It lets the existing revisit draw consider recently
active, questionless held issues in scope. Repair triage should state the
decision and options or give evidence for releasing the hold through existing
policy. Scheduling repair does not clear a hold or grant approval. Repairs
share the single revisit slot, inherited triage pools, existing candidate
scope, 14-day ordinary and 7-day held revisit timing, cooldown and pass caps.

Keep `operatorQuestionsOnly` off for now. The current agent-board pin
recognizes bot questions only in the architecture domain in this mode, and
can clear a manually applied `needs-human` pause without operator approval.
Before enabling it, the pass must honor all configured reserved domains for
trusted, concrete questions and filter needs-you separately from releasing
holds. Cleanup of placeholder holds must be limited to holds the pass can
prove it owns.

For a read-only comparison, run the workflow-pinned `agent-board pass` with
the two `poll.yml` fix bounds and its existing caps, without `--apply`. Use
`--record` in a private directory, then `--replay` for a same-input comparison
where the recording covers all needed reads. Do not publish raw recordings,
logs or hold bodies. Record the pin, config revision, what was actually read
and the resulting decisions; missing reads or a pass that never reached the
revisit draw do not establish that there are no missing questions.

On 18 November 2026, two live `--record` previews used agent-board
`52adc0d6996cbe7e56cfec0598b6194cfab74357` and tracker base
`2f09dfe491fd8b88fd9eb3a57e62c4172ccc845f` (current config versus that same
config with only `revisit.repairQuestions: true`). Startup reported the flag
off for current and no longer off for proposed. Both read-only attempts hit
the local 180-second timeout after cache diagnostics, before any revisit
decision or usable recording. A separate read of the configured private
usage/holds issue returned HTTP 404 with this run's token. This comparison
confirms flag activation at startup, not a scheduling decision or coverage of
the board or published asks.

After reviewed merge, the existing applying `poll.yml` owns repair dispatch.
Check its first completed pass with repair enabled for revisit decisions and
plan/dispatch receipts, then inspect a later `supervisor.yml` `supervisor-health`
report covering the updated publication. In the authorized view, account for
each remaining published ask without a concrete question with a pending
repair-triage URL or an explicit uncovered-scope or dependency reason (for
example, an out-of-scope pull request or an unreadable thread). Record the
applying run and report revisions and any follow-up gaps, without publishing
private ask text. Acceptance is pending until that accounting is complete;
an unchanged replay, missing data or asks merely disappearing is not proof.

To roll back, remove only `revisit.repairQuestions` in a reviewed change and
verify the next applying pass uses that revision. Ordinary revisits continue.
Already dispatched triage is not undone: inspect its receipts and outcomes
under the existing policy. Keep the holds and approval boundaries intact.

Applying passes hand off cursors, the interval and response scope in the
one-day `pass-state` artifact. Response bodies and validators never go in
the artifact, and restores ignore them in older artifacts. Previews never
publish state.
Both chain dispatches supply `previous_run_id`; restore validates that
exact run's repository, workflow, default branch, applying invocation and finished
`pass` job. Schedule/bootstrap runs without an explicit predecessor search at most
100 poll runs on the default branch for the newest earlier applying invocation,
then subject it to the same provenance checks. Missing, unreadable or untrusted
predecessors start without saved cursors.

Raw state can include private usage/holds comments or unpublished reviews even
in public repositories. Export keeps repository and thread cursors only for
repositories still readable as public, with one visibility check per distinct
cursor repository and a 90-second deadline. Action-first PR decision progress is
only partially retained: the per-repository positions are not exported, so some
repositories may restart their decision lists. Notification, operator search,
and hold-summary checkpoints can disclose private activity, so those scans
still restart each pass. Intake and maintenance records are not exported.

`livingStatus` remains disabled in hosted poll. Its replay ledger can contain
private metadata even for a public issue, so it is not part of `pass-state` or
any other public artifact. Enable it only with access-controlled durable storage
that restores the latest replay state under the applying-job lock. Unlike a cache
miss, a missing or stale ledger makes adopted issues refuse work: GitHub's comment
prose cannot reconstruct the machine records. Runner-local state is not a backup.
Historical comment cleanup remains off pending review of preview candidates.

To recover the bot rate-limit savings of authenticated 304s,
set tracker's Actions variable `PASS_RESPONSE_CACHE` to `enabled`; unset is
off. Applying passes cache encrypted response maps, including private responses.
Set the Actions secret `PASS_CACHE_KEY` to an independent, randomly generated
secret before opting in. If it is unset, the cache key is derived from the bot
PAT. Previews can restore but cannot save. The restore preflights the predecessor
attempt's exact key and default-branch ref and skips listed archives over 64 MiB.
The restore step has a two-minute timeout and extracts only the expected ciphertext
member, whose size is checked before decryption. A miss, authentication failure or
key change leaves the cursors intact and reads cold.

The one-day retention applies to the `pass-state` artifact, not the cache.
Fork PR jobs can retain copies of the ciphertext. Someone with a copy and the
secret used to encrypt it (the dedicated key, or the old PAT for a fallback
cache) can decrypt it offline, even after deletion, rotation or PAT revocation.
With a dedicated key, a PAT leak alone cannot decrypt those caches.

After redaction, a visibility change or suspected key exposure, unset
`PASS_RESPONSE_CACHE` and let in-flight passes finish. In **Actions → Caches**,
filter for `pass-responses-` and delete all matching entries. Rotate any exposed
credential before re-enabling. Unsetting the variable does not delete existing
caches; purging does not recall downloaded copies.

`poll.yml` has no schedule. `gh workflow run poll.yml` previews and
`-f apply=true` applies one pass. While the repository variable `PASS_APPLY`
is `enabled`, each applying pass also starts the next one
`PASS_INTERVAL_MINUTES` after its own start, and `next-fallback` does the
same when `next` fails. The hourly `agent-board-pin.yml` schedule checks for a
stopped chain independently of pin bumps. With `PASS_APPLY=enabled`, it
dispatches one applying pass if none on the default branch is active or was
created within twice the pass interval. Legacy scheduled runs count too. Each
active-status and recent-run search must fit on one page to establish absence;
older history need not fit. A queued attempt unchanged for over a day doesn't
block recovery if GitHub confirms it has no jobs. The new pass does its usual
bounded state lookup and provenance checks. Check the restart job's log
for the decision. This is best effort: GitHub can drop the schedule, and an
applying run can arrive between the check and dispatch.

A pass does not start the next while a newer
applying run on the default branch has not finished, so a second chain,
say from a manually started applying pass, usually folds into the newer one; a run
arriving during that check, or a newer run that never continues, can still
leave two chains or none. To keep the chain stopped, unset `PASS_APPLY` before
cancelling any waiting run. Also check for and cancel any in-flight
`restart-pass` job, and check for a pass it may already have dispatched.
Cancelling alone leaves scheduled recovery enabled.
Every pass is capped at eight agent runs, twenty
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
[docs/maintain-shadow-comparison.md](docs/maintain-shadow-comparison.md)
compares the shadow's previews with the pass's steps for 7 to 18 November 2026.

A pull request labelled `needs-human` is not touched again until the label
is removed. A fix run can request one `add_comment` explaining why it
cannot safely change the pull request, without a push (opt-in in
`.github/agentic-job/fix.toml`); the unchanged head is what stops the fix
rounds.

Text-only fixes ([#1846](https://github.com/cgwalters-forge/tracker/issues/1846))
remain off in both fix bounds. The [pinned wrapper](https://github.com/cgwalters-forge/actions/blob/a2fac2ea949255e1e901b8225d566a44f28c1e94/.github/workflows/cgwalters-agentic-job.yml)
does not request `update_pull_request`. Do not add the generic output to its
fix list: [check](https://github.com/cgwalters-forge/agentic-job/blob/2b937aaac81da06d8bff5f317e58df6ad7063e1e/crates/safe-outputs/src/check/mod.rs#L492-L513)
checks the repository and explicit number, not that the number is the fix PR,
and [apply](https://github.com/cgwalters-forge/agentic-job/blob/2b937aaac81da06d8bff5f317e58df6ad7063e1e/.github/workflows/apply.yml#L563)
uses `target: "*"`. That would let a misdirected run edit a sibling or
human-authored PR, or publish stale text against a new head.

Before enabling, agentic-job must bind the checked request to the trusted
fix repository, PR number, bot author, and pinned head, allowing at most one
title/body-only request without a push. Apply must reread the open PR and
refuse a moved head or wrong author before writing; GitHub's text update is
not a force-with-lease. Test a valid text-only update and refusals for another
PR, wrong author, moved head, draft/ref changes, and a push in the same hand-back
before pinning the updated wrapper and opting the two fix bounds in. The fix
profile describes the guarded output, not a fallback API write.

Leave `pr.holdMissingData` unset in the applying pass. The pinned board only
recognizes the legacy failure annotation from the exact dispatch attempt on an
unchanged PR head. The current fix caller can report `missing_data` with no
push as a successful `blocked` run, which that detector misses (#1571).

To preview the legacy detector without changing the checked-in policy, run
this from the tracker root with the workflow's pinned `agent-board` and a
read-only GitHub credential:

```sh
(
  set -eu
  preview=$(mktemp -d)
  trap 'rm -rf "$preview"' EXIT
  follow=cgwalters-forge/agentic-job
  jq '.pr.holdMissingData = true' .github/pass.json > "$preview/pass.json"
  just maintain-shadow-config "$preview/pass.json" "$follow" > "$preview/poll.json"
  agent-board poll --dry-run --config "$preview/poll.json" \
    --state "$preview/state.json" --follow "$follow" \
    --fix-bounds .github/agentic-job/fix.toml \
    --fix-bounds .github/agentic-job/midstream-fix.toml
)
```

If the job or check-run annotations cannot be read completely, the preview
defers the whole PR without a hold decision, even if it would otherwise take
an ordinary recovery step. A persistent read error keeps deferring it. Look
for the PR's error in the log, including `incomplete missing-data jobs`,
`incomplete missing-data annotations`, or an API error on either endpoint.
Before interpreting a hosted preview with this option as a policy comparison,
confirm the shadow job's own token can read the exact attempt's jobs and the
apply check run's annotations. The scheduled shadow does not opt in.

Apply opens complete work ready for review (`ready_when_complete` in
`dispatch.toml` and `fix.toml`), except on a midstream fork: a repository
with the `bot-midstream` topic whose main tracks upstream (#336).
Every pull request there stays a draft. `dispatch.yml` gives those targets
`midstream.toml` and `midstream-fix.toml` instead, by the target's live
metadata against `midstream.toml`'s organization rule, which agentic-job's
policy checks again; the pass follows them by the same metadata. Giving a
fork the topic admits it for implement; a fix there also needs its name in
`midstream-fix.toml`, which the pass reads with agent-board's
`--fix-bounds`, and that reader takes no rule yet.
cgwalters-review skips drafts, so a midstream pull request gets no automatic
review; `/review` still works.

### Midstream promotion

`.github/workflows/promote.yml` runs standalone `agent-board promote --config
.github/pass.json --apply --max-writes 4` every fifteen minutes, serialized
without cancelling an active run, and only on the default branch. The workflow
does not check a `PROMOTE` variable; the command uses `promote.publish` in
`.github/pass.json`.
The eight-minute invocation uses the bot token and the same verified binary
pin as the pass. Its four-write cap admits at most one whole publication,
including the create-only branch write needed for rebasing or sign-off.
With `promote.publish: true`, the applying pass's `next` job also dispatches
one default-branch run if the newest run on that branch is more than 60 minutes
old or absent and no promote run is active. The cron remains a fallback;
failed wake checks or dispatches do not stop the pass chain. This check is
best effort: another run can start between the final read and dispatch.

A manual run may instead preview the [one-time draft-body repair](#one-time-draft-body-repair-blocked-on-the-footer-fix)
through its `repair` input; that run writes nothing, and a scheduled run,
which has no inputs, only ever promotes.

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

`promote.botAuthorEmails` lets replay recognize the bot's former email when
GitHub reports no mapped author and attributes the committer to the configured
bot or `github-actions[bot]`. An email alone is not proof of authorship. This
does not change the current-head approval or sign-off gates: at the pin that
introduced this setting, unsigned drafts can pass preview but still hold in
apply, even without upstream DCO.

`just test-config` checks caller plumbing offline; `just test-pass-config`
uses the pinned binary's real validator. For a read-only live preview use
`agent-board promote --config .github/pass.json` with `GH_TOKEN`. Policies
added in a PR are not visible to that preview until merged. No live publication
or bot-fork staging verification was attempted in the preview below.

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

#### One-time draft-body repair (blocked on the footer fix)

Do not start the live repair until the [agent-board footer fix](https://github.com/cgwalters-forge/agent-board/issues/1002)
has merged and is deployed in [the verified agent-board pin](#the-agent-board-pin).
No agent-board change for it had merged as of 19 November 2026, so the pin
`46cb74b8d8a49875206ff48a2added806f9295c4` still holds complete generated
comments as ambiguous HTML ([its `contexts()`](https://github.com/cgwalters-forge/agent-board/blob/46cb74b8d8a49875206ff48a2added806f9295c4/crates/board-forge/src/promote/text.rs#L175-L209))
but can still propose edits to bodies with no generated footer, such as
`Work.` followed by `Fixes #61`; an earlier no-op
[recorded preview](https://github.com/cgwalters-forge/tracker/issues/1730#issuecomment-6938473718)
does not bound what a later revision edits. Use the
normal verified pin bump and reuse the existing pin PR rather than opening
another one. Before starting, record the exact deployed revision, verify that
it contains the merged fix, and link passing regression checks at that
revision for byte-for-byte footer preservation and continued refusal of
ambiguous bodies. A green check on a revision without the fix does not qualify.

A manual `promote.yml` dispatch with `repair=preview` (the input is `off` by
default) installs the verified binary, uses the existing bot token, and runs
`agent-board promote --config .github/pass.json --repair-bodies` instead of
the publication step. The two steps are mutually exclusive, and a schedule
has no inputs, so it only ever promotes. The `promote` concurrency group holds
one pending run and a newer pending run replaces it, so a preview dispatched
while a promotion runs can be cancelled by the next schedule before it starts:
confirm the dispatched run completed, not cancelled, before reading its log as
evidence, and dispatch again if not. `gh run list --workflow promote.yml`
finds the run; its result is only the human-readable job log
(`gh run view RUN --log`), with each draft's `would repair` before/after,
`unchanged` or `held for manual repair` line and no credentials or private
configuration. There is no machine-readable repair report.

The workflow deliberately offers no apply. Anyone with Actions write access
can dispatch it, so an apply input would let callers other than the
controller edit bot-owned drafts with the bot token. The pin bump that
deploys the footer fix adds apply, with a cap and a dispatch gate limited to
the controller; until then, apply runs only as the controller's own
`agent-board promote --config .github/pass.json --repair-bodies --apply --max-writes N`
from a deployed checkout, once the fix is deployed. Agent prose, an issue
comment or an earlier preview never applies anything.

1. Preview, which writes nothing:

   ```sh
   gh workflow run promote.yml --repo cgwalters-forge/tracker -f repair=preview
   ```

   Check that the scan covered every verified fork and finished without errors
   or deferral; a zero exit alone is not proof of completion. Review every
   proposed before/after and hold. Only unambiguous source bookkeeping in the
   bot's own open drafts may change: the source issue is the right one of the
   fork and the generated footer bytes are identical. Human-written drafts,
   two candidate sources, a source only in prose, and anything touching titles
   or commits stay held; the repair never rewrites them.
2. Before applying, know what the deployed publisher then does. A `bot-ok`
   approval binds the current head, not the body, so repair neither grants nor
   resets an approval. If body text was the only hold, the next scheduled
   promotion can publish the repaired draft under its existing current-head
   approval, before any re-preview. Defer the repair if that is not authorized.
   Repair also makes the bot the body's last editor, so a draft held on human
   text stays held until the operator edits it again and authorizes it through
   the normal promotion process. Do not change approval or publication behavior
   for this repair.
3. Apply only after that review, when there are safe edits and the controller
   can confirm a window with no concurrent draft creation or changes in the
   repair scope, from the final reviewed preview through apply. Otherwise leave
   it at preview. Give the explicit `--max-writes N`, positive and no greater
   than either the reviewed edit count or the promote job's four-write cap
   (the pinned binary bounds neither), and repeat for the next batch only
   after its own review. The cap is not a selector. As [agent-board documents at the pin](https://github.com/cgwalters-forge/agent-board/blob/46cb74b8d8a49875206ff48a2added806f9295c4/docs/architecture.md#promote),
   apply scans again rather than using a saved preview, checks that the token
   is the configured bot's, and re-reads each draft's number, state, draft
   flag, author, title and body just before editing only its body, but the
   read and write are not atomic. It writes only fork draft bodies, never
   upstream; this repository tests its own wiring, not those gates. Inspect apply diagnostics even on
   exit zero and reconcile failed or uncertain writes against the reviewed
   before/after bodies before another batch or claiming completion.
4. Preview again. Confirm a complete scan with no remaining `would repair`
   lines; agent-board documents a repaired body as unchanged by a second run,
   and this re-preview is what shows it for these drafts. If the cap left
   eligible edits, review the new preview before any further bounded batch.

Acceptance is recorded on the [repair issue](https://github.com/cgwalters-forge/tracker/issues/1730),
kept open through controller verification, and linked from
[agent-board issue 1002](https://github.com/cgwalters-forge/agent-board/issues/1002)
without closing it: the preview and re-preview run links and the apply's
output; per configured fork, which drafts were repaired, which stay held and why, and
which eligible edits remain; and a read-only promotion preview
(`agent-board promote --config .github/pass.json`, no apply flag) showing
composefs-rs PR 66's gate after the repair. Fixture tests here prove the
caller's wiring, not a live repair.

### Misctool secondary publication (dormant)

The threat is an injected task redirecting the apply token to an arbitrary
repository or proposing an unbounded tool change. `dispatch.yml` selects
`implement-secondary.toml` only when the trusted repository variable
`MISCTOOL_SECONDARY` is exactly `enabled`, the kind is `implement`, and the
primary target/output is neither misctool nor a midstream fork. Unset is off;
there is no dispatch input bypass. Primary misctool work still uses
`dispatch.toml`; analysis, review, fix and midstream routing is unchanged.

The opt-in admits one primary draft and one secondary draft to
`cgwalters-forge/misctool`, base `main`, under the separate `misctool/` run
branch prefix. The secondary gets at most 65,536 patch bytes and 10 files,
with **no protected-file exemptions**; primary exemptions are not inherited.
Primary scope/exemptions remain those of dispatch.toml except for excluding
misctool. Both PRs remain drafts on this route, even for complete work.

The actual [actions wrapper](https://github.com/cgwalters-forge/actions/blob/e084c52a9aa07f1279182cfc738de68b96016278/.github/workflows/cgwalters-agentic-job.yml)
pins agentic-job `427ce2295925654be9c35e91ca5cee91bbc2c9ea`, not the task's
historical v0.6.11. It forwards `allow`, `output-repo = inputs.repo` and
`SAFE_OUTPUTS_PAT` to apply, and requests **3 total outputs** with no caller
`max-outputs` input. These bounds match that ceiling: two PRs leave room for
only one ancillary request. The primary `create_pull_request.max` stays 1;
the secondary's own max supplies the extra collector allowance. Raising a
bounds ceiling would not raise the wrapper's requested limit.

The replacement acceptance child [actions#203](https://github.com/cgwalters-forge/actions/issues/203)
completed through [actions#222](https://github.com/cgwalters-forge/actions/pull/222).
The API records successful [dispatch 42348718765](https://github.com/cgwalters-forge/tracker/actions/runs/42348718765)
and [review 42320676566](https://github.com/cgwalters-forge/actions/actions/runs/42320676566),
both referencing wrapper `ba6c569` and helpers `427ce22`. This satisfies that
wrapper gate, **not two-PR publication**. Dispatch still follows wrapper main.

No variable, credential or live publication was changed here. Before enabling,
an authorized operator must run a controlled primary-plus-secondary draft
publication and retain both PR URLs and the run URL. Confirm apply's PAT can
fork misctool, disable and read back fork Actions, push only the run branch
and open the draft PR. Never copy that credential into artifacts or logs.
Local Rust selection/admission tests are not this proof. Upstream's pinned
secondary [publisher refusal tests](https://github.com/cgwalters-forge/agentic-job/blob/427ce2295925654be9c35e91ca5cee91bbc2c9ea/crates/safe-outputs/src/apply/secondary.rs)
and shared checker enforce foreign destinations,
other-run branches, patch limits and protected paths; they do not attest
this deployment's token access. Missing live authority/access remains an
acceptance blocker. Roll back by unsetting `MISCTOOL_SECONDARY`; cancel or
inspect outstanding runs separately, and inspect a pushed orphan branch
before retrying a failed publication.

### Endpoint-redacted replay (offline only)

A run's hand-back replaces the inference endpoint with `<inference-address>`,
so a patch that deletes or keeps base lines containing it does not apply
([#1638](https://github.com/cgwalters-forge/tracker/issues/1638)). agentic-job
v0.6.16, which dispatch.yml's wrapper pins, can recover those old-side bytes
([endpoint-redacted patch replay](https://github.com/cgwalters-forge/agentic-job/blob/2b937aaac81da06d8bff5f317e58df6ad7063e1e/docs/safe-outputs.md#endpoint-redacted-patch-replay)).

With the pinned binary on `PATH`, `just test-config` exercises capture,
check and `replay-trial` using a local clone, a synthetic `.test` endpoint
and temporary replay-enabled policy and runner configurations. The test
checks the reconstructed tree against the original change and checks
that ordinary patches and the deployed configuration do not replay.

Hosted dispatch still uses gh-aw. The pinned native publisher rejects bot
actors and labeled pull requests, even for ordinary patches that pass
check. A future rollout needs a publisher that preserves those cases and
a stage-scoped end-to-end publication canary for bot and human dispatches.

### Midstream default-branch sync

`midstream-sync.yml` runs hourly and on manual dispatch, only when the repository
variable `MIDSTREAM_SYNC` is `enabled` (unset is off), on tracker's default branch.
It uses `CGWALTERS_BOT_PAT` in `agent-apply` to fast-forward forks discovered from
the live org census: custom property `origin=fork`, topic `bot-midstream`, and a
GitHub `parent`. There is no sync allowlist. Each fork's default branch tracks its
parent's default branch, even when their branch names differ. The summary lists
every selected fork as equal, fast-forwarded, or not synced with a reason; any
refusal fails the job while allowing the remaining forks to be checked.

To prevent losing fork-only commits or racing pushes, the only write is a ref
update with `force=false`; the workflow never merges, resets, or bypasses rules.
It checks equality against the observed upstream commit after each update.
Discovery completes before writes, with at most ten 100-row pages per org list,
100 forks, 650 requests (enough for two full censuses and six per fork), twenty seconds per request and six minutes total API
time inside a ten-minute job. A truncated or failed census fails without writes.
Upstream movement after observation is picked up next run. No live sync has been
performed as part of this implementation.

Both midstream caller bounds set `[github.outputs] own-branch-repos` to
`["cgwalters-forge/*"]`, trusting org CI for own-branch pushes without committing
`accept-owner-branches` files to upstream-tracking defaults. Repository admission,
branch bounds, draft policy and protected files remain unchanged. This requires
agentic-job#3404, which dispatch's non-review policy/check/apply pin (v0.6.16)
includes. The one-time removal of fork-only default-branch commits and any job-specific ruleset bypass require a
separate operator decision on #1581; neither is implemented or authorized here.
Open midstream PRs continue through ordinary fix rounds, without special rebases.
`just test-config` executes the workflow offline with a fixture API transport.

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
[actions at `ba6c569`](https://github.com/cgwalters-forge/actions/blob/ba6c56925e63551fd4373fbeb23456a2f4a316da/.github/workflows/cgwalters-agentic-job.yml).
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
[cgwalters-agentic-job.test.mjs](https://github.com/cgwalters-forge/actions/blob/ba6c56925e63551fd4373fbeb23456a2f4a316da/.github/workflows/cgwalters-agentic-job.test.mjs)
(including missing/unknown pool, head/admission and pre-submit checks) and
[review_wrapper.rs](https://github.com/cgwalters-forge/actions/blob/ba6c56925e63551fd4373fbeb23456a2f4a316da/lint/tests/review_wrapper.rs)
(credential, immutable dependency and checked-publication boundaries).
`just test-review-wrapper PATH` runs both suites from a read-only checkout at
that exact SHA. It needs Node and Cargo, and Cargo may fetch locked dependencies
on a cold cache. It performs no live inference or review.

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

#### Caller drift prerequisite for PR #1500

The forge-sync manifest now checks the ordinary review caller, independently
of [#1500](https://github.com/cgwalters-forge/tracker/pull/1500)'s scheduling
and event stand-down changes. It covers that PR's ten review repositories,
including actions and agentic-job: defining a legacy review wrapper locally
is no longer an exemption from installing the ordinary caller. `review_pin`
is replaced by `review_workflow = dispatch.yml` and the full `review_call`
at the same immutable actions revision as tracker's `dispatch.yml` review
job, `ba6c56925e63551fd4373fbeb23456a2f4a316da`.

The concrete threat is a moving review wrapper changing the workflow gate
without a reviewed pin update. `just forge-sync` reads the selected workflow
from each repository's default branch and compares **jobs.review.uses** with
that literal call. Other jobs' calls are not checked, so they may follow main;
a comment or an unrelated pinned job cannot make a moving review job pass.
Missing callers are drift, not silently exempted. Legacy-shaped YAML in the
offline fixtures still exercises the generic exact-job comparison; the real
manifest and `just test-forge-sync` require the ordinary caller.

Merge queue reporting is off by default. Try it without changing the manifest:
`FORGE_SYNC_MERGE_QUEUE=true just forge-sync --json`. `--json` writes one report
with `failed` (repository names) and `drift` (details) to stdout; drift still
exits nonzero.

This source check neither starts reviews nor certifies live admission,
author coverage, checked publication or merge provenance. Ordinary reviews
remain off by default. Do not merge #1500's scheduling activation before its
listed callers and settings are ready. This change does not duplicate that
PR's pass settings or stand-down switch, delete event workflows or change
rulesets, model variables or broker/tailnet admission. Those cutovers and the
event-wrapper cleanup remain separate work. The forge-sync manifest is removed
from the legacy release train's caller files so that train cannot rewrite the
ordinary review pin or conflate it with the event wrapper's release pin. Other
legacy caller entries remain while those workflows are still in use. During a pass outage
no paced review starts; recovery must use the same bounded rescan and claims,
not an unpaced fallback.

### Draft-review buckets

**Blocked, not proposed (14 November 2026, #1324).** agent-board's
[draft buckets](https://github.com/cgwalters-forge/agent-board/blob/d742eb8052aec70d8d4ecf1da98bec9b645ae40f/docs/pass.md#midstream-draft-buckets-opt-in-producer-slice-of-648)
label the bot's drafts on the four midstream forks `review:quick` or
`review:deep`. The threat they guard against is a forged, stale or merely
small draft passing as reviewed. The producer was audited at
`d742eb8052aec70d8d4ecf1da98bec9b645ae40f`, which contains agent-board#680
(`9841aab`) and the architecture-finding veto. The current `AGENT_BOARD_REV`,
`a4320f759d47f95c647912d7abfc8af1fa211661`, is 219 commits later and changes
`poll/drafts.rs`, `promote/drafts.rs` and `docs/review-drafts.md`; re-audit
those before proposing the opt-in. The wrapper/caller chain is still missing, so
`.github/pass.json` sets none of `pr.draftReviewRepositories`,
`pr.reviewDispatchRepositories` or `pr.reviewPools`. `just test-review-caller`
keeps all three unset and checks the shape the coordinated change must take:

* Callers: fresh, non-truncated recursive trees for
  [bootc](https://github.com/cgwalters-forge/bootc/tree/3ff59436aa70ea4b3561fd99ac463aaa44ad53ac)
  and [composefs-rs](https://github.com/cgwalters-forge/composefs-rs/tree/c8f8eb7384bdea4aa40018f446ed3bc0fbf05ba9)
  (branch `forge`), and
  [bcvk](https://github.com/cgwalters-forge/bcvk/tree/b2d1cc90055d0c846d649bf5519b79650aabe0a9)
  and [rpm-ostree](https://github.com/cgwalters-forge/rpm-ostree/tree/911dd734bdc9d35eae33a074a613e436e7b400ee)
  (`main`), still have no `dispatch.yml`,
  `review.yml`, `workflow/review.toml` or `workflow/review-command.toml`, so
  they have no `agent-board-review-result-v1` writer job. bootc's and bcvk's gh-aw
  `review.md` reviews do not write one either. The open prerequisites are
  bootc#99, composefs-rs#69, bcvk#24 and rpm-ostree#13.
* Wrapper: actions
  [`f7bf70fd8d6f21a5e38f9690c306514ab4c294e2`](https://github.com/cgwalters-forge/actions/blob/f7bf70fd8d6f21a5e38f9690c306514ab4c294e2/.github/workflows/cgwalters-agentic-job.yml)
  still rejects drafts in admission and publication and exposes no
  `agent-board-review-result-v1` writer. Its
  [prerequisite](https://github.com/cgwalters-forge/actions/blob/f7bf70fd8d6f21a5e38f9690c306514ab4c294e2/README.md#draft-classifier-reviews-blocked-on-reusable-helper-wiring)
  is now reusable policy/check classifier-mode and trusted snapshot transport
  in **agentic-job**, not the classifier binary (already in its pinned
  `be1191213b722ad9ca085028140e44c4e6f4f43d`). Then actions#200 must wire
  coherent helper pins, explicit draft admission and checked result writing
  before the four caller migrations. An ordinary APPROVE cannot substitute
  for classifier evidence.
* Consumer: the older parser-absence finding is superseded. review
  [`b85eb8e607a0ceeb354f1a6f3e23cdf518d8ecaf`](https://github.com/cgwalters-forge/review/blob/b85eb8e607a0ceeb354f1a6f3e23cdf518d8ecaf/src/github/holds.ts#L277-L286)
  parses bounded `review_buckets` with quick/deep, assessed head, reason,
  summary and CI fields, attaching them only to non-carried items from complete
  sources. This is source-level evidence, not an end-to-end compatibility or
  current-head UI attestation.

Verification is deliberately split: `just test-review-caller` checks the
local default-off gate, proposed exact allowlists and rollback, and preserves
`follow`, `noMerge` and the private holds destination even while disabled.
It does **not** exercise classifier admission, forged/stale/incomplete writer
provenance, current-head invalidation, size fallback or consumer rendering.
Those owning-layer regressions and shared projection fixtures remain rollout
gates, not passing checks in this audit. No controller preview or live review
was run: the deployed four-caller contract needed for a meaningful rollout
preview is absent. Source reads do not attest deployed variables, credentials
or private publication. No live controller, credential or permission changes
are part of this update.

Once all three exist, propose `pr.draftReviewRepositories` and
`pr.reviewDispatchRepositories` for exactly those four repositories, plus
`pr.reviewPools = ["openai", "claude"]`. Keep them in `follow` and `pr.noMerge`,
keep the existing caps and the private holds destination, and coordinate this
with the paced-review cutover above, since `pr.reviewPools` applies to every
followed repository. Preview before applying. To roll back, remove
`pr.draftReviewRepositories`. A `review:quick` label, whether added by hand or
left over from before the rollback, never grants authority to mark ready,
merge, fix or approve. Approval stays bound to the head the control app displays.

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

Leave `SUPERVISOR_HANDBACK` unset to use the comment path. The optional
`artifact` value makes research return checked artifact identity instead of
posting the agent's requests. Both preview and apply read the same-run
requests artifact; only apply needs a prior trusted executor ledger. Apply
refuses a missing ledger, including on the first run or after all ledgers
expire. Before activation, separately review a bootstrap and recovery procedure
that produces the initial ledger from this workflow's trusted executor, with
write caps at zero. Do not seed it from agent output. The wrapper does not
support interactive sessions in artifact mode. The trigger still shows
comment-log usage as a hint; in artifact mode only the executor's ledger
accounts for artifact-path writes.

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
`session.yml`'s runs have it; the control app's chat pane reads only the
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
this repository), and the control app's last-run panel is
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
as they are. Given read-only agent-board and `review` checkouts, it also
checks that the pin's 174-decision fixture keeps each approval's card and
`review-at-head` descriptor, and that the control app reads one row per decision,
each approval actionable. The control app still counts each group member as a
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
control app revision and read the current private publication without writing: verify
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
