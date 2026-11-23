# Bringing up a coordinator

> This text is LLM generated.

The coordinator picks work from the
[board](https://github.com/orgs/cgwalters-forge/projects/1) and dispatches
it. It runs here, as `poll.yml`: a chain of `agent-board pass` runs follows
pull requests, plans and applies the operator's epics, schedules board work
and derives board Status (the README's "The pass"). A dispatch with
`apply=true` writes; a plain dispatch only previews, in the run's summary.
The repository variable `PASS_APPLY` gates the chain: while it is `enabled`,
each applying pass starts the next and the hourly pin workflow checks for a
stopped chain. To keep the chain stopped, follow the shutdown steps in
[The pass](../README.md#the-pass). A person at a machine with only credentials
checks on it, manually dispatches work
it does not dispatch, and answers questions it cannot answer. Everything they need
is on the forge, except for the items listed at the end.
[cgwalters-bot/homegit](https://github.com/cgwalters-bot/homegit), whose
`bin/bot-runs`, `bin/bot-board`, `bin/bot-git` and `bin/bot-capacity` did
this from one machine, is now frozen: nothing here needs a checkout of
it ([homegit-freeze.md](homegit-freeze.md) lists what replaced it). A
change to a repository, this one's notes included, is a dispatched run's
pull request, not a commit made on the machine.

This first part describes the existing deployment, not defaults for another
organization. For a new installation, start with
[A second operator's deployment](#a-second-operators-deployment) below.

## What to clone

This repository, which has the
dispatch workflow, the bounds and per-kind profiles under
`.github/agentic-job`, the pass's configuration, the operator's instructions
([operator-notes.md](operator-notes.md)) and this page. Read the notes
before dispatching anything: briefs and decisions are checked against them,
and a new instruction is appended there, verbatim and dated, in a pull
request. The wrapper every run goes through,
[cgwalters-forge/actions](https://github.com/cgwalters-forge/actions), is
used from its main in `.github/workflows/dispatch.yml`; you don't need to clone it.
It brings [cgwalters-forge/agentic-job](https://github.com/cgwalters-forge/agentic-job)
at the commit selected by its main.

Besides `gh`, one tool: [agent-board](https://github.com/cgwalters-forge/agent-board),
the board's CLI, built from source as its README says (Rust supporting
edition 2024; there are no releases). The workflows here build it the same way, at
the commit each pins as `AGENT_BOARD_REV`.

```sh
cargo install --locked --git https://github.com/cgwalters-forge/agent-board agent-board
```

## Credentials and settings

The machine needs two files, neither of them in any repository. The bot
account's token is in a file of its own, and `~/.config/bot-supervisor.env`
names that file in `BOT_SUPERVISOR_GH_TOKEN_FILE`. Every shell starts the
same way, and never prints the token:

```sh
set -a; . ~/.config/bot-supervisor.env; set +a
export GH_TOKEN="$(cat "$BOT_SUPERVISOR_GH_TOKEN_FILE")"
```

On the forge, check the existing organization secret `CGWALTERS_BOT_PAT`,
which apply and the pass use, and the environment `agent-apply` here,
which gates apply. The wrapper has a
default for each deployment setting, and this repository's variables
override them: `AGENT`, `AGENT_MODEL`, `INFERENCE_URL`,
`INFERENCE_AUDIENCE`, `AGENT_RUNNER`, `AGENT_CONFIG_REPO` and
`AGENT_CONFIG_PATH`. `gh variable list -R cgwalters-forge/tracker` and
`gh secret list -o cgwalters-forge` show the names; the secret's value is
cgwalters' to store, and the bot never copies or prints it. The inference
proxy and the tailnet the runs join are on a host of his, with its own policy,
and are not brought up from here. A manual `poll.yml` run with `apply=true`
can write even with `PASS_APPLY` unset; the variable gates the successor
chain, not that manual input.

## Dispatching a run

The pass starts board work by itself (a triage run where an issue has no
accepted plan, then the implement plan it proposes) and the fix rounds of
pull requests, once `PASS_APPLY` is `enabled`. New work it can take is put
on the board with a Priority. Anything else is started by
hand: write the task-specific instructions in a file and name the
target. Run it on the default branch, which the wrapper requires. The task
is public, in the run's inputs; `pool` may be left out:

```sh
gh workflow run dispatch.yml -R cgwalters-forge/tracker \
    -f kind=KIND -f repo=OWNER/REPO -f item=N -f task="$(cat BRIEFFILE)" -f pool=POOL
```

`KIND` is implement, review, fix, triage or research; `N` is an issue, or a
pull request for review and fix; `OWNER/REPO` must be admitted by
`.github/agentic-job/dispatch.toml` (`fix.toml` for a fix), or, for a
midstream fork, by `midstream.toml` and `midstream-fix.toml` instead.
dispatch.toml and midstream.toml admit the organization's repositories
by their live metadata; the fix bounds still name theirs.

For an implement run using `dispatch.toml`, `-f base=dispatch/…` can select an
existing branch in the target repository. Leave it out to start from `main`.
Other dispatch kinds do not accept the override, and midstream and secondary
bounds still limit the base to `main`.

This does not enable same-repository PR heads. The wrapper with actions#309
still uses agentic-job v0.6.16, which rejects the new in-repo setting. Once the
wrapper pins a release containing [agentic-job#4509](https://github.com/cgwalters-forge/agentic-job/pull/4509),
set `own-branch-repos = ["cgwalters-forge/*"]` and `in-repo-pull-requests = true`
under `[github.outputs]` in `.github/agentic-job/dispatch.toml`. Before opting
in, verify the bot's upstream write access is scoped by a ruleset to
`dispatch/**` and that the admitted repositories trust their CI to run bot
branch commits. Repositories with a `.github` exemption still use fork heads.

For a staged implement issue, add `-f issue_repo=cgwalters-forge/tracker`:
`N` then names the issue there, while `repo` remains the checkout and PR
target. Empty or omitted `issue_repo` keeps the same-repository behavior.
The caller forwards it as agentic-job's `item-repo` for task context,
hand-back comments and qualified closing links. The selected target bounds
must admit both repositories; this does not expand any repository list or
midstream permissions. Review and fix do not accept a separate issue repository.
Run titles keep `KIND TARGET#N` for the pass's target/WIP accounting, not as
an issue lookup identity.

Runs push as `cgwalters-bot`, and apply pushes a branch to a repository
that account owns only if the repository's default branch has
`.github/agentic-job/accept-owner-branches` naming it
([agentic-job's owner-branch documentation](https://github.com/cgwalters-forge/agentic-job/blob/main/docs/workflow.md#a-repository-the-applying-account-owns));
otherwise apply fails with "owns ... and has no fork of it to push to"
(#517). So a `cgwalters-bot/*` repository is a dispatch or fix target only
once that file is there, and a test in `.github/agentic-job/config-test/tests/config.rs`
keeps the list of such repositories. `cgwalters-bot/praxis-credential-broker`
is the one so far (praxis-credential-broker#37). It is in the pass's `follow`
and `workRepositories`, but `pr.noMerge` disables new automatic merge/queue
admissions. Its deployment stays in the operator's private infrastructure.

### Broker review prerequisites (#1237)

This is a partial tracker safeguard, not an enabled broker review loop.
`just test-config` requires every work repository to be followed and preserves
the broker's `noMerge` guard; there is no local exemption field. Any future
exemption needs an explicit consumer-supported contract and tests.

Read-only checks on 13 November 2026 found only `ci.yml` and
`container-images.yml` in the broker's default-branch workflow directory.
By comparison, [agent-board's base-owned review caller](https://github.com/cgwalters-forge/agent-board/blob/main/.github/workflows/review.yml)
handles PR events and `/review` with a pinned reusable wrapper, without running
head code in the privileged caller. The broker needs an equivalent reviewed
caller and its trusted review policy before following can yield reviews.

The [producer's poll contract](https://github.com/cgwalters-forge/agent-board/blob/main/docs/poll.md#one-pass)
binds automated verdicts to public bot-fork provenance. Owner-branch apply
permission alone does not establish same-repository-head review provenance or
automatic fix eligibility. Verify that supported path in the producer and
broker before claiming review/fix coverage; do not loosen provenance here.

The broker's active [ruleset 24017893](https://github.com/cgwalters-bot/praxis-credential-broker/rules/24017893)
still required zero approving reviews and did not dismiss stale approvals at
that check. Operator-owned prerequisites are at least one required approving
review, stale-approval dismissal, and confirmation of the intended review
identity, wrapper/broker admission and token/App permissions. Those permissions
and admission were not verified. No ruleset, credential, admission or scheduling
setting was changed. Keep `noMerge` until these prerequisites are verified;
following alone is not approval protection and cannot complete #1237.

The standing
instructions for each kind are separate from the brief: `dispatch.yml` puts
`.github/agentic-job/profiles/KIND.md` before it, so they change by a pull
request here and a brief says only what this item needs. An implement run
with `claude` or `opencode` also gets agentic-job's skills (its
`docs/skills.md`): its implement skill carries the procedure, the
self-review with a subagent included, and `profiles/implement.md` contains only
our additions. `vibe` gets no skills, so an implement run that would use it,
from the pool or the variable `AGENT`, gets `profiles/implement-full.md`
instead, which spells the procedure out. Fix has no skill yet and
keeps its full profile. Implement and fix also get agenthome's skills
(`AGENT_CONFIG_REPO`), and their profiles name its commit-messages skill
rather than repeat it; `implement-full.md` and `fix.md` keep a short
version for vibe. Both of these spell out the self-review too: up
to three passes of a subagent reviewing the diff against the base before
the run hands it back (#543). `dispatch.yml` also takes an
optional `pool` input, `claude`, `openai` or `mistral`, which
`.github/agentic-job/pools.json` maps to a fixed agent and model (`claude`
with `claude-opus-5-5`, `opencode` with `praxis/gpt-6.1-sol`, `vibe` with
`zai-glm-5-3`) and a run budget in AIC, hundredths of a dollar
(`budget`); left empty, the repository variables `AGENT` and `AGENT_MODEL`
apply. Any other value fails the run before it starts. A pool may also say
what its provider allows per period, so tools can pace runs when the
provider reports no quota: `allowance` is `amount` in `currency` per
`period`, which is `calendar-month` (`mistral`: 300 USD). Declaring an
allowance does not make it a pacing window. Every pool has a `tier`, 1
(`claude`, `openai`, `fable`) or 2 (`mistral`); `"auto": false` keeps `fable`,
whose allowance is separate, for manual dispatch. The pass paces its runs on the pools
`.github/pass.json` names, and alternates fix rounds between its
`pr.fixPools`, except that a first round that is only toil goes to
`pr.toilFixPool`. The run applies
its own result: a pull request from the bot's fork, or one comment on the
item. `gh run watch RUN -R cgwalters-forge/tracker --exit-status` waits
for a run and fails unless it succeeds; `gh run view RUN -R
cgwalters-forge/tracker --json jobs -q '.jobs[] | select(.conclusion ==
"failure") | .name'` names its failed jobs.

### Mistral triage rollout

Mistral remains manual. The [Mistral rollout wrapper pin](https://github.com/cgwalters-forge/actions/blob/a2fac2ea949255e1e901b8225d566a44f28c1e94/.github/workflows/cgwalters-agentic-job.yml)
pins agentic-job v0.6.16, which contains v0.6.3. In the reused
[hosted triage](https://github.com/cgwalters-forge/tracker/actions/runs/44424357279),
the previous wrapper pin used the same agentic-job release. Vibe's startup
log names `zai-glm-5-3`, and the [published result](https://github.com/cgwalters-forge/tracker/issues/1758#issuecomment-6995358830)
correctly diagnosed the apt download deadline in the `packages` stage and
identified separate error-reporting work. Its advice to re-pin for the mirror
fix was stale: v0.6.16 already contains that fix. No new trial was dispatched.

The [pinned pass's usage reader](https://github.com/cgwalters-forge/agent-board/blob/8eba8a193aad9e7ac137297fb8f24079cdcdc7c8/crates/board-forge/src/pass/usage.rs)
publishes Mistral's broker-lifetime request and token counters, not a current
calendar-month spend window. The [hosted pass](https://github.com/cgwalters-forge/tracker/actions/runs/45034110724)
reported paced usage only for Claude and OpenAI. Adding `pools.mistral` would
produce a `no-reading` hold, not a usable pace. Do not bypass this by treating
missing usage as zero. Before enabling triage, verify that the pass consumes a
current USD usage window against the existing $300 monthly allowance and holds
on missing usage. Keep the configured 1000-AIC run budget and the wrapper's
400-request cap. The request cap bounds Vibe when its model is unpriced; the
AIC setting alone is not proof of a dollar cutoff. Keep sessions on their
existing pools: the pinned pass draws session pools from `triagePools`, so
adding Mistral there alone would not be triage-only.

Rollback after any activation: restore `triagePools` to `["openai", "claude"]`
and remove `pools.mistral` from `.github/pass.json`. This is already the current
configuration; rollback leaves manual dispatch and the pool limits intact.

### gh-agentic-workflows upgrade handoff (#258)

To prevent staged changes from advancing an upstream-tracking fork main,
`cgwalters-forge/gh-agentic-workflows` uses the existing midstream implement
and fix bounds: PRs stay draft, and the pass follows them for fix rounds
but `pr.noMerge` prohibits merging into the fork. It is not an ordinary
ready-when-complete target. After #1312's target admission, the separately
reviewed workflow-edit admission permits only this exact repository's
`.github/` in `midstream.toml` and `midstream-fix.toml`. Protected root
filenames and all other midstream forks' protected paths remain blocked.
This tracker PR must receive the existing required review before its
exception takes effect.

The remaining handoff follows the
[current-release-on-fork direction](https://github.com/cgwalters-forge/tracker/issues/258#issuecomment-6640207439).
The fork's effective `main` rules were rechecked on 2026-11-05: organization
ruleset 25084478 requires one approving review and dismisses stale approvals
on push. `check-review-gate` now discovers and deduplicates exceptions from
both ordinary and midstream implement/fix bounds, so `ruleset-check.yml`
monitors this gate too. Missing or unreadable rules block admission; they do
not justify weaker requirements or broader protected-file exemptions.

After that reviewed admission, open a fork issue in
`cgwalters-forge/gh-agentic-workflows` linked to #258, then stage a fork-only
draft PR upgrading gh-aw to the current stable release (v1.0.1 was observed
at triage; recheck before
pinning). Compile `drafter`, `review`, `fix`, `queue-triage` and `ci-triage`
with the pinned CLI and run the fork repository's tests, recording the pin,
commands and results in the PR. Compilation alone does not prove live
`bootc-bot[bot]` PR checkout: fresh live bot review/checkout verification remains
a separate step with run evidence. This tracker prerequisite changes no
repository settings, opens no upstream PR, retriggers no upstream run and
does not close #258. The fork issue, upgrade, compilation, repository tests
and fresh checkout evidence remain later work before any upstream delivery.

### ostree target admission (#1242, #1243, #1245, #1246)

`cgwalters-forge/ostree` already uses the same route as bcvk: the existing
`midstream.toml` and `comment.toml` rules match its fork metadata, and
`midstream-fix.toml` names it for fix rounds. The pass follows it as a work
repository, includes it in proposal holds, and bars local merges. It is on
the board schedule, not the legacy follow list. Implement PRs stay drafts
and fixes cannot mark them ready, so staged work does not advance the
upstream-tracking default branch through this lane.

Repository admission does not authorize workflow edits. To prevent a run
from changing privileged CI, ostree remains outside `unprotected_files` in
both profiles; #1239's current workflow-admission plan excludes it. Before
dispatching work that needs a workflow change, obtain separate reviewed
authorization for the exact target and paths, audit privileged triggers and
secret exposure on the fork, and verify current-head review with stale
approvals dismissed. Do not route around the patch check.

On 18 November 2026, read-only GitHub API checks confirmed the public fork
of `ostreedev/ostree` has default branch `main`, topic `bot-midstream` and
custom property `origin=fork`. The effective branch rules report org ruleset
25084478 requiring one approval and dismissing stale approvals on push.
The separate legacy branch-protection endpoint returned HTTP 403. The daily
`check-review-gate` covers workflow-exempt repositories, not ostree.

The original handoff described the fork as issues-disabled; the API now
reports issues enabled, but no issue for the Debian 32-bit DNS failure was
found. Before a subsequent implement plan, the controller needs a real
destination issue in the fork, not a tracker number or PR number. Proposed
title: **CI: Diagnose Debian 32-bit setup DNS failures**. Proposed body:

> The Debian Stable 32 bit job fails during container setup: `apt-get update`
> cannot resolve `deb.debian.org`, then installation fails with missing package
> indexes. Reproduce with pinned image and runner inputs, compare against the
> last good setup, fix the DNS cause, and make index-fetch failures fatal with
> a clear diagnostic. Keep the 32-bit job; use bounded retries only if the
> reproduction demonstrates transient recovery.

After an issue exists and workflow edits are authorized, use the actual fork
issue URL on a standalone `Part of` line in any ostree draft. No fork settings,
issues or workflows were changed here. Keep #1242 open for DNS reproduction,
repair and workflow admission.

### Excluded fix requests: receiving evidence (#1293, companion #1292)

The four historical requests reached tracker with `fix.toml` supplied, and
policy refused the excluded heads before agent/apply work:

| Target / head | First receiving run | Repeated receiving run |
| --- | --- | --- |
| agentic-job#2107 / `per-forge-bounds-sections` | [41910329480](https://github.com/cgwalters-forge/tracker/actions/runs/41910329480) | [41919391010](https://github.com/cgwalters-forge/tracker/actions/runs/41919391010) |
| tracker#1050 / `pass-follow-midstream` | [41910378386](https://github.com/cgwalters-forge/tracker/actions/runs/41910378386) | [41919396986](https://github.com/cgwalters-forge/tracker/actions/runs/41919396986) |

Both targets closed unmerged on 4 November 2026 around 22:20 UTC. #2107 named
#2978 as replacement (now obsolete, superseded by merged #2641); #1050's
[move receipt](https://github.com/cgwalters-forge/tracker/pull/1050#issuecomment-6643599909)
names #1282, merged at 22:42:18. Do not reopen/retry either target, revive
#2978, widen bounds or add owner-branch acceptance to clear these refusals.

Read-only investigation refreshed on 9 November still identifies no owning
producer route. All four dispatches name event `workflow_dispatch` and actor
`cgwalters-bot`: the credential actor is not the initiating command/session.
They started at 20:50:01, 21:47:45, 20:50:19 and 21:47:47 UTC respectively.
Their policy jobs
[126857065437](https://github.com/cgwalters-forge/tracker/actions/runs/41910329480/job/126857065437),
[126887728244](https://github.com/cgwalters-forge/tracker/actions/runs/41919391010/job/126887728244),
[126857979707](https://github.com/cgwalters-forge/tracker/actions/runs/41910378386/job/126857979707) and
[126887797064](https://github.com/cgwalters-forge/tracker/actions/runs/41919396986/job/126887797064)
show the selected fix bounds and excluded `PUSH_BRANCH`; agent/apply skipped.
Nearby passes [41909029850](https://github.com/cgwalters-forge/tracker/actions/runs/41909029850),
[41910623749](https://github.com/cgwalters-forge/tracker/actions/runs/41910623749) and
[41918624419](https://github.com/cgwalters-forge/tracker/actions/runs/41918624419)
record `needs-human` skips, not a dispatch receipt linking these requests.
The searched target comments/round receipts likewise do not tie a producer
to these four runs: earlier round records name other runs, and #2107's
20:02:30 receipt records `rounds:0, stopped:true`. The later malformed JSON
Lines [report on #656](https://github.com/cgwalters-forge/tracker/issues/656#issuecomment-6644175411)
was refused before writes; it is not an initiating receipt.

Missing evidence is a producer command/session/workflow receipt correlating
the target and resulting dispatch run ID, plus the initiating admission inputs:
selected head, kind, pool, triggering request/checkpoint, lifecycle/hold/bounds
observations and admission decision at dispatch time. No producer repository or
route is proven. A current pass regression or scheduler defect is not
established; lifecycle resolution does not close this attribution gap. Keep
#1293 open: this receiving change is partial progress for both incidents.

CI's required `test` job builds the real agentic-job resolver/compiler at
`a5f7a3963fd41f3eb09c4406aa5bc8e30ee42be2` (v0.6.10), outside the read-only
source checkout, and runs the inline Node replay without a missing-binary skip.
The replay stays inline to respect the deployment-script no-growth rule.
For local replay, set `ADMISSION_ACTIONS` and `ADMISSION_POLICY` to the source
checkouts and `RUNNER_TEMP` to a scratch directory. Run the workflow's build
command with the policy manifest path adjusted, then execute its
`Required offline dispatch admission replay` Node step unchanged.
The actions checkout must contain `95c09b9947f39100117fbc69bf0b6239d2cf22c3`
and `bac2da6d67101ab6ca520d9d63adc46da77e4513`. Tests read their actual wrapper
guards, dependencies and bounds selector, including apply's policy-success
condition. The fixture carries sanitized closed-PR projections;
open-state incident variants reconstruct the policy logs. Historical bounds
are projected to the two target repositories and relevant push/noop outputs;
current branch globs must still match. Repeated identical requests on both
excluded heads refuse; closed/superseded targets stop at resolution even with
an allowed head, while an open `bot/**` control compiles. This is offline
receiving coverage, **not prevention of external redispatch**, live Actions
execution or proof of a producer fix. The non-review production wrapper still
follows main, so these historical assertions do not attest future revisions.

This consolidates #1438 and #1461, replacing #1461's merged README section,
replay and always-on receipt. #1437 has since merged its companion refusal
coverage; that coverage remains intact. Retire #1438 rather than merge it as
an independent fix. Its retirement needs an authorized route; this branch
update cannot close other pull requests.

The optional admission receipt addresses a specific diagnostic leak: Actions
prints step `env` before the script can truncate or escape it. It is **off by
default**, enabled only by tracker repository variable
`DISPATCH_ADMISSION_RECEIPT=enabled`; no caller is required to enable it.
No raw dispatch inputs enter that step's env or script interpolation. The
script reads the event file locally, selects only validated public metadata,
and emits one bounded JSON-escaped `tracker-dispatch-admission/v1` line.
Bounds outputs are allowlisted before Actions logs env; missing/invalid fields
become empty, including missing profile outputs. No task, whole-event dump,
credential or claimed producer identity is emitted. The job has no permissions,
checkout or secrets and a one-minute timeout. It neither admits requests nor
changes bounds; wrapper failure alone is not proof of policy refusal. Tests
cover oversized/missing inputs and outputs, including pre-script env exposure.
The threat addressed is diagnostic exposure, not producer authentication; the
receipt cannot recover an absent producer receipt or resolve the whole issue.

## Board writes, questions and status updates

Use agent-board and the bot's `GH_TOKEN` for manual writes. Each write only prints
what it would do until given `--apply`:

```sh
board="agent-board --owner cgwalters-forge --project 1"
$board item add OWNER/REPO#N --priority P1 --apply
$board item edit OWNER/REPO#N --field Status=Todo --apply
$board -R cgwalters-forge/tracker ask create "QUESTION" --item OWNER/REPO#N \
    --assignee cgwalters --option "RECOMMENDED" --option "OTHER" --recommend "WHY" --apply
$board ask resolve cgwalters-forge/tracker#N "WHAT WAS DONE" --apply
$board project status-update --status on-track --body FILE
```

`ask create` opens the `question` issue the README describes in the
repository `-R` names (without it, next to the item it blocks), and sets it
and the item it blocks to Needs human; `ask resolve` comments, closes and sets it
Done. `project status-update` writes at once.
Read commands (`item list`, `item view`, `ask list`, `project view`) don't need
`--apply`. A job plan is sent with
`agent-board dispatch ISSUE --dry-run` first, then `--apply`, with
`--caller cgwalters-forge/tracker --workflow dispatch.yml`. Only the pass sends
an epic plan, which it pins. To unblock an epic held on its plan, comment on
it as the operator; the next pass plans it again.

## What is in flight

### An interactive session

`session.yml` starts a fresh read-only coordinator through the same wrapper.
It is enabled in `.github/agentic-job/session.json`, which sets the fixed
tracker repository and session issue; `[session] operators` (tailnet logins,
not GitHub logins) and `origins` are in `hosted.toml`, and it needs the
repository variable `TAILNET_DOMAIN`. The login
list prevents other tailnet users from prompting the agent; the origin list prevents
cross-site WebSocket hijacking from another page in the operator's browser.
Never take these lists or the publication issue from dispatch inputs.

Operator prerequisites: permit the operator to reach the runner's serve port,
isolate runners from each other, and enable tailnet HTTPS
([agentic-job#536](https://github.com/cgwalters-forge/agentic-job/issues/536));
choose the operator login list and the control app's origins
([tracker#576](https://github.com/cgwalters-forge/tracker/issues/576)). Record any
applied tailnet change in the operator's private infrastructure log. No
tailnet change is made by this workflow.

Dispatch on the default branch with an optional public opening prompt, a pool
(default `claude`) and `idle-minutes` (empty uses the config's 10; range 1–60).
The wrapper posts the `wss://` endpoint in the fixed issue's run status while
the session is live; wait for the agent job's summary to show it served.
One session runs at a time. The agent builds agent-board from the source in
`agent-board.json` and uses only read commands with its read-only job token.
That token may not read the organisation's private project: missing access is
reported, never replaced with a write credential. A separate read-only project
credential is not added here.

This uses the wrapper's research profile: no patch or board mutation, and at
most one end-of-session comment plus bounded diagnostic outputs, checked and
applied separately under `dispatch.toml`. Dispatching work, board updates,
mid-session writes, the control app's pane and a scripted fake-agent end-to-end
run remain follow-ups. `session.yml` composes the task with agent-board's
`supervise session`, at the commit `supervisor.yml` pins, where it is tested.

The coordinator doesn't need to remember anything. List the runs with
`gh run list -R cgwalters-forge/tracker` (the run name is the kind and the
item). Find the bot's open pull requests on `dispatch/`
branches with `gh pr list -R OWNER/REPO --author cgwalters-bot` in each
repository named in the bounds. Each pull request's status, fix rounds and
active run are in the single comment the pass maintains on the pull
request (it carries a `tracker-poll` marker); `needs-human` labels the ones
the pass gave up on.

## Where state lives

The board holds what is to be done and whose turn it is, and questions for
cgwalters are issues here. Each pull request's progress is in the pass's
marker comment and each run's in its status comment on the item. This
repository holds the workflows, bounds, profiles and the operator's notes,
and `docs/rulesets/` keeps snapshots of our repositories' rulesets, named
by repository, taken before changing them. To put one back, look up the
ruleset's id with `gh api repos/OWNER/REPO/rulesets` and run
`jq '{name, target, enforcement, conditions, rules, bypass_actors}' FILE | gh api -X PUT repos/OWNER/REPO/rulesets/ID --input -`
(`-X POST repos/OWNER/REPO/rulesets` where it no longer exists).
The snapshots are not checked against the live rulesets. What is checked,
daily by `ruleset-check.yml`, is the property the `[unprotected_files]`
bounds in ordinary and midstream implement/fix files rest on: on each
exempted repository's default branch some ruleset, the org's 25084478 today,
requires an approving
review and dismisses stale approvals on push. A repository without it
fails the run and gets a comment on one open "Ruleset drift" issue here;
`just check-review-gate` runs the same check locally.

### First-party merge queues

Without a queue, the coordinator cannot enqueue an eligible pull request and
may fall back to a direct rebase merge instead of letting GitHub check the
merge group. The [organization ruleset design](rulesets/cgwalters-forge-first-party-merge-queue.json)
shows the intended policy: the default branch of repositories with the custom
property `origin=first-party`, no bypass actors, and an all-green `REBASE`
queue. This matches the existing queues and the forge's rebase convention,
including rebase-only `actions`.

**Do not import this JSON as an organization ruleset.** GitHub documents
`merge_queue` as repository-level only in its [ruleset documentation source](https://github.com/github/docs/blob/main/content/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets.md),
and omits it from the [organization create/update request schema](https://docs.github.com/en/rest/orgs/rules).
The control app's `apply_org_ruleset` can read the reviewed JSON and preserve
the property condition, but it writes to the organization ruleset endpoint,
which doesn't support this rule. The JSON is a reference for the desired org
policy and the source of the repository-level body below, not a deployable
org policy.

1. As an operator with organization property read and repository administration
   access, list the targets from the property's values, not repository search:

   ```sh
   gh api --paginate orgs/cgwalters-forge/properties/values --jq \
     '.[] | select(any(.properties[]; .property_name == "origin" and .value == "first-party")) | .repository_full_name'
   ```

   Confirm each repository's property and default branch; skip forks, mirrors,
   and repositories where the default branch doesn't exist yet. Check that
   rebase merging is enabled and that the required CI checks report on
   `merge_group` before enabling the queue, or queued PRs can stall.
2. Leave any existing working queue in place. Where a queue is missing, use
   the reviewed JSON without its organization-only property condition to
   create a separate repository ruleset. This leaves existing approval, CI,
   and other branch rules intact. Substitute the repository you're applying to:

   ```sh
   jq 'del(.conditions.repository_property)' docs/rulesets/cgwalters-forge-first-party-merge-queue.json |
     gh api -X POST repos/cgwalters-forge/REPO/rulesets --input -
   ```

3. Read `gh api repos/cgwalters-forge/REPO/rules/branches/BRANCH` for that
   default branch and confirm an effective `merge_queue` rule with `REBASE`.
   Verify that a queued PR runs its required checks and merges. If the new
   rule blocks merges unexpectedly, disable just the new ruleset and check
   which protections remain; do not replace the existing CI or approval rules.

For the repositories in [the forge-sync manifest](../.github/forge-sync/repos.json),
`just forge-sync` checks whether `main` exists and has a queue, whether enabled
by classic branch protection or a ruleset. Try it locally with
`FORGE_SYNC_MERGE_QUEUE=true just forge-sync --json`. The scheduled check ships
off: after rollout, set `merge_queue` to `true` in `.github/forge-sync/repos.json`.
It makes one read-only GraphQL query per non-exempt repository (20-second
timeout) and distinguishes a read error from a missing branch or queue.
An `exempt.merge_queue` entry needs a nonblank reason and only suppresses this
report; it doesn't change any GitHub settings. The report is a presence
check, not a test of merge method or CI readiness. The rollout includes
first-party repositories outside that manifest (such as `.github` and
`workflow-compiler`); those repositories are not monitored by this check.

## Moving this deployment to infra

**Tracker remains the only deployment writer. Infra is offline-only as
written.** This is an inventory at
[tracker `f08f48d`](https://github.com/cgwalters-forge/tracker/tree/f08f48d95e37603f75be1bc66fbda92302dec769)
and [cgwalters-forge/infra `effda4a`](https://github.com/cgwalters-forge/infra/tree/effda4afbb9ae44dc216db9d5954afeebd47e607),
not an instruction to install a second caller. The destination is the
`bot-midstream` fork of `bootc-dev/infra`, not its upstream or `forge-infra`.
Its [workflow directory](https://github.com/cgwalters-forge/infra/tree/effda4afbb9ae44dc216db9d5954afeebd47e607/.github/workflows)
already has image builds, merge, renovate, upgrade, sync-common and generated
drafter/fix/review workflows. `review.lock.yml` is not `review.yml`, but both
could act on the same PR. Its `Justfile` is already occupied; its
[upgrade workflow](https://github.com/cgwalters-forge/infra/blob/effda4afbb9ae44dc216db9d5954afeebd47e607/.github/workflows/upgrade.yml)
recompiles gh-aw sources and refreshes `.github/aw/actions-lock.json`. It does
not own agent-board or actions wrapper pins. Before staging,
agree who owns downstream-only files on `main` and which PR checks and
privileged events may coexist. Tracker's midstream sync only fast-forwards:
after a downstream-only commit it reports divergence rather than merging
upstream changes. Resolve that ownership before relying on sync. If unresolved,
do not install on the fork. File presence is not evidence of activation.

### Which identity changes?

* **Caller:** the repository receiving Actions dispatches, running the jobs and
  serving their run URLs would change. In [pass.json](../.github/pass.json)
  and [poll/agent-board.json](../.github/poll/agent-board.json) distinguish
  `dispatchRepo`/`dispatchWorkflow` from repositories being worked on. Keep
  the default-branch input contract, run-name prefix and `issue_repo` routing.
* **Policy:** caller checkouts and wrapper `allow` paths must resolve trusted
  [bounds, profiles, pool and runner maps](../.github/agentic-job) at the
  reviewed source. Moving dispatch requires moving or explicitly sourcing those
  inputs together, not falling back to target code. Target review policy
  (`workflow/review*`) stays on each trusted base. Keep `promote.policyRepository`
  and `policyPath` pointing to tracker's [upstream policy](../upstream-policy).
* **State:** keep Project 1, tracker epics, questions, proposals and maintain
  digest, target PR markers and staged issue comments at their current hosts.
  [Supervisor config](../.github/supervisor/config.json) names tracker issues
  656 (requests) and 718 (state), operator issue 2 (log); decisions stay on
  operator issue 1 and holds/usage on bot-ops issue 1. Session publication stays
  on the issue in [session.json](../.github/agentic-job/session.json). Do not
  replace all occurrences of `tracker` or recreate issues at the destination.
  This also applies to **new** staged work. With `notifications` enabled, the
  [pinned pass](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/pass.rs#L5876-L5884)
  uses `dispatchRepo` as the staging fallback for topic-admitted forks with
  issues disabled, such as `cgwalters-forge/rhel-bootc-examples`. Changing the
  dispatch route alone sends new issues and their receipts to infra; changing
  it back does not move them. The [triage brief](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/pass.rs#L10085-L10098)
  also takes its tracker filing destination from `dispatchRepo`. So does the
  operator-comment [tracking issue](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/poll/comments.rs#L2332-L2340)
  for any repository without a `notification_intake` route, such as
  non-bot PRs and threads outside our own space: new tracking issues and
  copied comments would land on infra, and searches for existing ones
  would miss tracker. Keep cutover offline until intake staging, tracking
  issues and triage filing use tracker independently of dispatch in both
  directions.

### Caller inventory

The links below are the checked-in `.github/workflows` callers. “Move” means
candidate after authorization, not enabled. “Keep” means leave at source until
its owner explicitly relocates or retires it. Manual means `workflow_dispatch`.

| Caller | Entry points and dependency | Disposition |
| --- | --- | --- |
| [dispatch.yml](../.github/workflows/dispatch.yml) | Manual/API from pass, supervisor, CLI and report callers; resolves profiles/pools/bounds and calls the actions wrapper (different SHAs for review and non-review). | Move only the non-review kinds, with admission replay and disabled runner map. Keep `review-gate`/`review` in tracker's `dispatch.yml`: [forge-sync](../.github/forge-sync/repos.json) expects that pinned review job there, and it publishes with the base repository's job token. Keep the review lane absent or `REVIEW_DISPATCH` off on infra unless the paced-review rollout moves it separately. |
| [poll.yml](../.github/workflows/poll.yml) | Ten-minute cron, manual apply/preview, successor and recovery dispatch; `.github/pass.json`, fix bounds, `just build-agent-board`. `next` can also wake supervisor, release train and maintain-shadow; pass can request a pin bump. | Move as a single chain, including its readers of stored run references. |
| [supervisor.yml](../.github/workflows/supervisor.yml) | Two crons, poll wake-up, manual prompt/session and request-issue comment. Uses `.github/{poll/agent-board,supervisor/config,usage/config}.json`, pools and supervisor bounds. | Pause through the handoff unless health can read both hosts as described below, even if the executor stays on tracker. Move health/judge/execute only after resolving event delivery: tracker comments do not trigger infra, and the session guard compares the publication repo to the caller. No second executor. |
| [session.yml](../.github/workflows/session.yml), [review-send.yml](../.github/workflows/review-send.yml) | Manual session uses session config/profile, poll and supervisor config; review-send reads issue/comment events and the poll review allowlist. | Keep: publication and operator gestures belong to the original issues. |
| [agent-board-pin.yml](../.github/workflows/agent-board-pin.yml) | Hourly/manual or pass wake-up; `just bump-agent-board` rewrites matching workflow pins in its own checkout. | Pause bumps until each host has a verified publication route for its pin set, as described below. |
| [release-train.yml](../.github/workflows/release-train.yml) | Scheduled/manual or poll wake-up; the [caller list](../.github/release-train/config.json) names `review.yml` and its tests on tracker and agent-board, not the moved dispatch wrapper. | Keep the tracker cron, config and tracking issue; do not copy or wake a second train on infra. |
| [promote.yml](../.github/workflows/promote.yml), [midstream-sync.yml](../.github/workflows/midstream-sync.yml) | Scheduled/manual promotion from pass config; scheduled/manual fork sync. | Keep; resolve destination fork ownership before either can advance it. |
| [broker-probe.yml](../.github/workflows/broker-probe.yml) | Probe cron uses `.github/broker/config.json`. | Keep on tracker; its health evidence does not move with poll. |
| [maintain-shadow.yml](../.github/workflows/maintain-shadow.yml) | Tracker cron/manual preview; poll wake-up currently looks only in its own repository. | Keep the tracker cron without the moved wake-up (`MAINTAIN_SHADOW` off on infra). Switch the shadow's fix-run route separately as described below. |
| [forge-sync.yml](../.github/workflows/forge-sync.yml), [ruleset-check.yml](../.github/workflows/ruleset-check.yml) | Daily/manual; `.github/forge-sync/repos.json` and workflow-exempt bounds; report drift on tracker. | Keep with policy and issue publication. |
| [ci-health.yml](../.github/workflows/ci-health.yml), [ci-health-rehearsal.yml](../.github/workflows/ci-health-rehearsal.yml) | Daily/manual collection/publication using `.github/ci-health/`; confirmed manual fixture. | Keep reports, fixture and repository guard together. |
| [weekly-models.yml](../.github/workflows/weekly-models.yml), [monthly-review-refresh.yml](../.github/workflows/monthly-review-refresh.yml), [weekly-eval.yml](../.github/workflows/weekly-eval.yml) | Scheduled/manual; dispatch in `GITHUB_REPOSITORY` or, for eval's documentation mode, call [weekly-comparison.yml](../.github/workflows/weekly-comparison.yml) with comparison profile/bounds. | Keep report targets; redirect dispatch endpoint or pause producers at cutover. |
| [retro.yml](../.github/workflows/retro.yml), [review-corpus.yml](../.github/workflows/review-corpus.yml) | Scheduled/manual; retro profile/bounds and repository release assets. | Keep publications and consumers at existing hosts. The [retro task](../.github/agentic-job/retro.md) collects dispatch artifacts and pass logs only from tracker with a tracker-scoped job token: before either handoff, reroute it to read both run hosts for any window spanning the handoff, with an approved read identity for infra, or pause it. |
| [weekly-blog.yml](../.github/workflows/weekly-blog.yml) | Scheduled/manual `digest --apply` writes the site issue and board item, then uses the tracker job token to start tracker `dispatch.yml` ([digest config](../.github/weekly-digest.json)). | Keep publication at the site; pause both entry points until the dispatch route is approved. Turning off `WEEKLY_BLOG` stops only the schedule. |
| [ci.yml](../.github/workflows/ci.yml), [review.yml](../.github/workflows/review.yml) | PR/merge group CI; base-owned PR/comment review. | Keep tracker checks/review for tracker changes. Move caller-specific assertions with their caller, not the whole CI or another review bot. |
| [tailnet-join.yml](../.github/workflows/tailnet-join.yml), [soak.yml](../.github/workflows/soak.yml) | Manual diagnostics; soak uses `workflow/soak.cjs`, `soak*.toml` and [its procedure](soak.md). | Keep dormant, not a production dependency or a parity run. Retire redundant copies only after an owner confirms no consumers. |

Check the edges outside these YAML files before switching a producer:

* For dispatch kinds that move, change the workflow host in `gh workflow run -R`
  or the caller in [`agent-board dispatch --caller`](https://github.com/cgwalters-forge/agent-board/blob/b5677d3edf35a1d1d54b18f3307738b9e1484c4c/crates/agent-board/src/dispatch.rs),
  not the item host. Send `kind=review` via `gh workflow run` to the PR's base
  repository as before (tracker for tracker PRs). The control app's [runpass.ts](https://github.com/cgwalters-forge/review/blob/a7959b377b81c84b50d303ac26081c0dc6f5ee15/src/github/runpass.ts)
  currently builds both its poll dispatch and its run link from `TRACKER_REPO`;
  separate these from issue reads. Its [live run sources](https://github.com/cgwalters-forge/review/blob/a7959b377b81c84b50d303ac26081c0dc6f5ee15/src/github/liveruns.ts)
  also select which runs are visible and eligible for cancellation. Check the
  actual repo on the run card in both cutover and rollback. [Item dispatch](https://github.com/cgwalters-forge/review/blob/a7959b377b81c84b50d303ac26081c0dc6f5ee15/src/github/itemdispatch.ts)
  posts a plan and follows the URL in the receipt; do not convert it into a
  second direct dispatcher. Check `src/github/chat-config.json` session source
  separately. In [usage-config.json](https://github.com/cgwalters-forge/review/blob/a7959b377b81c84b50d303ac26081c0dc6f5ee15/src/github/usage-config.json),
  the allowance reads the pool policy file; the cost read uses tracker's `data`
  ref. Moving one does not move the other. Preserve old absolute run links, not just numeric IDs. Unknown
  CLI/automation clients need an owner or a confirmed pause before cutover.
* Give the retained shadow its own fix-run route: `just maintain-shadow-config`
  copies `dispatchRepo` from tracker's `.github/pass.json`, so an infra read
  grant alone does not change the lookup. Change the workflow's generated
  route to infra with approved read access (the tracker job token is
  repository-scoped); reverse that route on rollback. The shadow must pass
  the stored-reference gate below with its own scheduled config and read identity
  before comparisons resume. A shadow preview does not qualify the applying
  poll.
* The pinned [supervisor health collector](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/supervise/health.rs#L1885-L1949)
  reads poll, active runners and `broker-probe.yml` from one `dispatchRepo`.
  Keeping that route on tracker misses infra poll runs; switching it to infra
  misses the retained tracker probe, regardless of where supervisor executes.
  Before relying on health or enabling supervisor on either host, require
  separate read routes and verify that the same collection sees a poll run and
  active runner on their intended host and reads a non-skipped probe result on
  tracker. Replay the stored-reference gate below for supervisor's health
  readers too: both old- and new-host receipts must yield the expected
  observations. Otherwise keep supervisor paused, including its crons, manual
  and comment entries and poll wake-ups. Recheck the routes after rollback.
  Health parity does not qualify execute: separately replay its in-flight
  lookup and authorized dispatch route for an approved request. Neither may
  assume that the supervisor's own host is the active coordinator.
* The [Justfile](../Justfile) checks shared `AGENT_BOARD_REV` and installs a
  verified binary; include [.github/agent-board-install](../.github/agent-board-install)
  provenance/release inputs, not just a SHA substitution. Record each
  wrapper's literal `uses` ref, including moving refs, for historical parity.
  Consult the [pin lifecycle work](https://github.com/cgwalters-forge/tracker/issues/1694)
  before changing upgrade policy. Keep historical replays at their original pins.
  `just bump-agent-board` updates only its checkout and publishes via a
  bot-owned fork of `GITHUB_REPOSITORY`. Moving it alone strands tracker pins;
  copying it does not establish an infra fork or publication route. Before
  resuming bumps, name an updater for each host's pin set and verify its fork,
  PR destination and covered files, or keep bumps paused on both hosts. The
  non-review dispatch wrapper pin is reviewed separately from the release train.

The inventory is historical, not the deployed trigger map. For example, at
[tracker `30a97bc`](https://github.com/cgwalters-forge/tracker/tree/30a97bcabd52e2fd6e406debd124ca34998acefe)
poll no longer has a cron, `agent-board-pin.yml` can restart an applying pass
on its hourly schedule with `PASS_APPLY` enabled even when `AGENT_BOARD_PIN`
is off, and poll can wake `promote.yml`. Do not treat pausing pin bumps as
pausing recovery, or let infra wake the retained promotion lane by default.

### Go/no-go and rollback checklist

**Outgoing writer fence (both directions).** Before the incoming host's first
write, enforce a durable denial of writes by the outgoing coordinator. Cover
poll and every other writer being moved, including dispatch and pending
safe-output apply jobs. Pause producers, but enforce the denial at the workflow
admission or write-authority boundary, not just in the UI or scheduler. Where
the fence relies on revocation, remove the outgoing poll grant and deny new
write grants for the moved lanes, including tokens minted on demand. Invalidate
already-issued credentials that could still write, or confirm they have expired.
An intentionally retained lane must not be able to re-enable or invoke a moved
writer with write authority.

Record the enforced settings and test denials with non-production credentials
under the same controls. Cover new runs and reruns (including prior revisions),
manual/API dispatch (including same-repo workflow callers), and automated
triggers, including successors and recovery. Drain or cancel queued, waiting
and running jobs and their children; reconcile their receipts because some
writes may already have landed. A quiet run list is a cross-check, not a fence:
`PASS_APPLY` off still permits manual `apply=true`, and concurrency groups are
repository-local. If denial or reconciliation cannot be shown, do not start the
incoming writer. Keep the fence in force through steady state; lift it only
after the other host passes this same gate in the reverse handoff.

**Stored-reference gate (both directions).** `dispatchRepo` selects where
new runs start; it must not silently change where existing records are read.
The pinned pass stores bare run IDs, run URLs and issue numbers in durable
records and resolves them under whatever `dispatchRepo` is current; its
readers ignore the host in a stored URL. For example, the
[poll](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/poll.rs#L9249-L9263)
looks up even completed runs named by actionable PR markers, and
[epic planning](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/crates/board-forge/src/pass/epics.rs#L2122-L2141)
looks up the run of an unanswered planning receipt and treats a 404 as a
deletion at the Unix epoch, so the six-hour retry is due at once even for a
run that just completed. Others at that pin include operator-comment fix
markers, triage reservations (`poll/recovery.rs`), run-bound lease refs
stored in `dispatchRepo` itself, and notification claims that keep only a
tracking issue number (`poll/notify.rs`). The supervisor's health reader
instead filters run links by the `dispatchRepo` host and silently skips the
other host's. The gate covers the mechanism, not this list: inventory every
reader in the reviewed candidate binary that resolves a stored reference
against `dispatchRepo` and apply the gate to each record kind. An unlisted
reader blocks cutover. A cold cache and a drained run list do not clear
these records.

Keep the incoming applying poll off unless its reviewed reader can resolve
each such record that is or can become actionable without being replaced to
its trusted original repository and read the run, issue and result evidence
needed for follow-up there, or all such outgoing records have been durably
settled. For an unanswered epic plan, settled means its plan has landed or
the epic is held for the operator; a request still within its answer or
retry window is not settled. A hold that can be lifted is not settlement.
Preserve the run history and record the disposition of each settled record;
do not hide unresolved work by dropping records or treating a failed read as
no run.

Replay both directions offline through the actual applying pass with
simulated writes. Include an open PR at an unchanged head with a completed
outgoing fix still named by its marker, and a known incoming marker on
another PR. Also replay the outgoing PR held at handoff and then released at
the same head. For epics, include an unanswered outgoing planning receipt
whose run is still running, one whose run just completed without a plan,
and one already retried once. Verify original-host reads, the expected
follow-up and unchanged epic cooldowns without duplicate dispatch or early
replanning. For the reconciliation route, start with the same fixtures and
show that settlement leaves no outgoing lookup or lost follow-up even after
release, and that incoming records still resolve. Use the same cases for the
retained shadow before relying on its comparisons.

1. **Offline parity first.** Reconcile the historical inventory against each
   host's actual deployed revisions and settings before comparing the
   outgoing and inactive candidate trees. Diff workflow events, permissions,
   environments, refs, config paths and output destinations. For both
   directions, include all actual restart, recovery and wake-up paths in the
   fence, drain and offline rehearsal, including jobs in retained workflows
   that can wake a moved writer. Keep the full `just test-config` on
   tracker: it reads retained workflows such as `midstream-sync.yml`,
   `promote.yml` and `review.yml`. For source/candidate comparison, use a local
   fixture harness over each tree's actual caller YAML and configs, with no
   hosted runs. Use the fixtures from `test-runner-profiles`, `test-poll-bounds`,
   `test-poll-next`, `test-pass-state`, `test-supervisor-config` and
   `test-supervisor-workflow` in the [Justfile](../Justfile), and the dispatch
   admission replay and pass-state export cases from [CI](../.github/workflows/ci.yml).
   Bring the fixture inputs and pinned dependencies into the harness, not
   tracker's CI or unrelated workflows into infra. Use the verified binary
   pinned by the caller under test; a skipped binary check is not parity.
   Run `pass --check-config` with the candidate config and both fix bounds
   separately, using `just test-pass-config` on tracker as the reference:
   this read-only check needs the org listing. Compare
   accepted and refused targets, emitted dispatch argv, predecessor selection,
   filtered artifact contents and simulated writes/receipts. Only the reviewed
   caller identity and new run URLs should differ. Replay qualifying upstream
   work for an issues-disabled, topic-admitted fork with simulated writes in
   both cutover and rollback configurations. In each replay require the new
   staging issue and its receipt comments on tracker, with the receipt's new
   run URL on the intended caller and no staging issue or receipt writes on
   infra. Also replay triage for cross-project and controller work with a
   resolved single-project route, and assert that the emitted triage task
   keeps cross-project and controller filing on tracker in both directions,
   while preserving the resolved fork destination for single-project work.
   Replay an operator comment on a non-bot PR and on a thread outside our
   own space, with and without an existing tracking issue and claim, and
   require the tracking issue and copied comments on tracker in both
   directions. Missing evidence or a coupled filing route blocks cutover. Keep
   both sets of checks until acceptance; retire source-only caller assertions
   when the caller is retired. Schema/policy and repository CI tests stay
   where their inputs live.
   Use [agent-board fresh-deploy validation](https://github.com/cgwalters-forge/agent-board/issues/282)
   for staging evidence and [runner-gate work](https://github.com/cgwalters-forge/tracker/issues/1490)
   for external execution; neither is satisfied by this inventory.
2. **Obtain separate operator approval.** Verify destination default-branch
   rulesets, required checks, current-head approval/stale dismissal, fork sync
   and bypass policy; protected `agent-apply`, safe-output credentials, poll
   read STS, wrapper owner/caller admission, broker OIDC audience/workflow identity,
   and tailnet federation/tags/ACLs. Review the variable names in the settings
   checklist below. Poll uses the job token for same-repo dispatch. A tracker
   producer's `actions: write` does not grant dispatch on infra; leave it
   paused unless a cross-repo identity is separately approved or it moves.
   These are decisions, not verified live grants. No widening
   of bounds or transfer of secret values is part of parity.
3. **Fence credentials and dependencies separately for each moved lane.** Do
   not make the organization `CGWALTERS_BOT_PAT` repository-visible on infra.
   Default-branch rules, `agent-apply` and checked outputs do not restrict
   access to a repository-visible secret from other workflows or refs. Poll
   passes the PAT to `pass` outside `agent-apply`, even for previews; dispatch
   passes it to the wrapper as `SAFE_OUTPUTS_PAT`; supervisor uses it in
   `health` outside `agent-apply` as well as in later jobs.

   Before each lane's first hosted run with credentials (including the
   dispatch canary), require a separately revocable grant that admits only
   its reviewed workflow code and denies every other workflow/ref. Verify
   immutable reviewed pins for all executable dependencies, including
   transitive actions, unless the credential boundary enforces the reviewed
   resolution. A caller SHA alone does not pin poll's `tailscale@main` or
   supervisor's wrapper at `@main`. Test denial with non-production
   credentials; leave each unproven lane paused without a live grant.

   Record the expected GitHub actor for each writing lane and verify the
   grant resolves to that actor. Test that the existing consuming path
   accepts a representative receipt attributed to that actor before
   accepting the lane. In particular, the plan dispatcher must see an
   already trusted plan writer; a successful comment by a different actor
   is not parity. Do not widen reader trust to pass the check.

   For poll, separately prove that the manual batch can be approved for
   exactly one run at the approved revision and caps, with
   other manual runs, reruns, schedules and successors denied. `PASS_APPLY`
   off stops chaining, not manual `apply=true`. Neither a verbal approval nor
   the checked canary output enforces this boundary. Until both controls are
   proven, stop at offline parity: no infra poll credential, hosted poll
   preview or cutover.
4. **Fence tracker before allowing infra writes.** Record approved revisions,
   trigger settings, outstanding plan/PR receipts and both repos' queued,
   waiting-for-approval and running jobs. Before fencing tracker, require a
    reviewed tracker rollback route and rehearse it offline end to end with
    non-production credentials: the staging gate in step 1, the per-lane
    controls in step 3, and step 6 with tracker as incoming host, including
    follow-up on a simulated infra receipt and a child admitted from the
    authorized tracker batch. The current workflows are not that route.
    If rollback is not ready, leave tracker in place. Apply the outgoing writer
    fence to tracker before the infra canary. Pause CLI/UI dispatch, report producers, scheduled and
   issue-comment entry points, and poll-triggered wake-ups for the moved
   lanes. Record the denial checks and
   the drain/reconciliation results.
5. **Start from known state.** Record the last tracker run URLs and artifact
   provenance before expiry: `pass-state` (one day, public cursors and scope)
   and `supervisor-health` (two days). Neither is an issue database. Never pass
   a tracker `previous_run_id` as an infra predecessor, import raw `.state`, or
   assume a missing health baseline means healthy. For a deliberate cold
   preview on either host, use manual `apply=false` and `previous_run_id=cold`.
   In the pinned [validator](../Justfile), the nonempty, nonnumeric value
   selects no predecessor without discovery; leaving the input empty can
   discover an older run on that host. Verify the validator reports no trusted
   predecessor, the restore step is skipped, and the pass reports it started
   cold. Recheck this behavior if the validator or binary changes. Keep
   `AGENT_BOARD_PIN` off (even a preview can wake the updater). Compare the
   board/issue census, pending requests, WIP, holds, pacing, cooldowns and
   proposed actions with the last trusted receipts. Block on ambiguous or
   duplicate work. Keep historical artifacts/check/apply in their original runs.
6. **Accept one writer or stop.** With the outgoing host fenced, schedules
    stopped and `PASS_APPLY` off, open only the incoming canary's item-scoped
    grant. Use a manual dispatch on one approved test item, not an applying
    board pass. Before any write-capable job starts,
   enforce admission for exactly one run at the approved revision and issue
   repository/number. Test denial for a different item and a rerun. The
   independent output check must bind the result to the same item. The total
   write allowance is one comment and no PR; keep status helpers that write
   outside the output check disabled for the canary. If any write path cannot
   be constrained, stop. Record caller/ref, admission and output check results,
   status-helper disposition, checked artifact, apply receipt, original issue
   and new run URL. Confirm only the allowed comment landed and the control
   app shows the destination run.

   Before the first manual applying poll on either host, apply the
   stored-reference gate to the current PR, epic and claim census after the outgoing
   writer is fenced and drained. Include records that could become actionable
   again and unanswered planning receipts whose runs just completed. If any
   record in scope lacks a proven read route or recorded settlement, stop
   with chaining and applying off.

    Close the item-scoped canary grant. Keep child writes closed by default:
    the poll's job token submits the same `workflow_dispatch` event as a
    direct manual/API caller, and the current receiver checks target bounds,
    not parentage. Neither paused producers nor a reviewed ref binds a child
    to the batch. Before starting the first applying poll in either direction,
    prove a receiving-side control that admits each child write only once,
    against a trusted record of a request from the approved poll run, within
    its caps. Bind the grant to the actual child run and attempt as well as the
    intended revision, lane, target and inputs; matching caller-supplied
    inputs or parent IDs is not proof. The control may
    hold each child's write grant pending that match, but must cover every
    write path, including status helpers, not only safe-output apply.

    Test without production credentials: a matched child can write; an
    unrelated manual/API request on the same approved ref (even with identical
    inputs arriving first), a mismatched request and an unapproved replay or
    rerun cannot. Replay a legitimate poll-requested retry in both directions:
    bind a fresh attempt under the same controls or explicitly defer and
    reconcile it. Reading an old-host run never reopens its write grant.
    Keep the per-lane controls in step 3, unrelated producers paused and
    chaining off. No general production child
    write grant during the batch. The checked-in dispatch route does not meet
    this gate; without a proven receiver, stop before the applying batch.

   Use the enforced one-run gate for that poll **at its actual batch caps**,
   with chaining still off. Approve that run with `previous_run_id=cold`;
   verify no trusted predecessor, a skipped restore and a cold pass as in
   step 5. Require the `pass` job to conclude successfully and verify its
   receipts. A failed `pass` can still export state and pass predecessor
   validation; reconcile its writes and do not use that batch to authorize
   chaining. Match the batch's dispatch receipts to actual child runs and
   verify their admission. An accepted dispatch request or a plan receipt
   alone does not prove the child was admitted. Require at least one
   poll-started child to complete with its expected result; a batch with no
   child, an unexpected refusal, or a missing result is not acceptance.
   Reconcile the receipts and leave chaining off if that evidence is missing.

   After a successful batch, set `previous_run_id` in a manual preview to
   that exact run on the same host.
   Record the validated run ID, successful `pass-state` download from that
   run, and evidence that the pinned pass loaded its `.state/pass.json`.
   If the run cannot attest to load success, add a non-secret load result to
   the reviewed candidate before acceptance. A green preview alone is not
   proof: missing provenance, a failed download, or bad state can start cold.
    Before enabling the chain, require and test per-run admission at the
    poll's own write boundary for its approved start, any scheduled run,
    successor and recovery. Verify unrelated manual/API runs and unapproved
    reruns cannot write to the board or issues, even before child dispatch.
    Require the same per-request child admission for those batches. Direct
    producers that resume need separate authorization, not the poll grant.
    Then enable the chain and verify one successor, no duplicate dispatches
    and an idle outgoing host through a chain interval. Keep that host fenced;
    unaccepted lanes stay paused, including supervisor unless it passed the
    applicable checks above.
    No such live evidence was collected here.
7. **Rollback on a wrong host, missing receipt, duplicate, or state mismatch.**
   Apply the same outgoing writer fence to infra first. Revoke infra's poll
   grant and verify it cannot be issued or read there. Verify that moved
   non-poll writers cannot obtain new write grants either. Reconcile both run
   lists against issue and PR receipts. Do not lift tracker's fence if infra's
   denial or reconciliation is unproven.
   Restore recorded tracker routes, revisions and settings with writes still
   off, including reversing the shadow lookup override. Check the restored
   configuration against step 1's staging replay before allowing writes.
   Require step 3's credential and dependency controls before restoring
   access for each moved lane. Use the deliberate cold preview against current
   issue state, not an old snapshot. Repeat step 6 on tracker: the item-scoped
    canary, the stored-reference gate with infra as outgoing host, the gated
    manual batch with `previous_run_id=cold` and the same receiving-side child
    admission, and the positive preview restore check before resuming its
    chain. Verify a unique successor.
   Keep infra fenced; preserve both run histories.

## Where an operator comment goes

- On a live epic here: the next pass plans the epic again with it.
- Anywhere else: nothing reads the comment as such; the next pass acts on
  the thread's current state. Outside the followed repositories, bootc-dev
  included, a comment reaches no pass at all.

"The next pass" is the pass's cadence: every `PASS_INTERVAL_MINUTES` (45) by
the chain in `poll.yml`. The hourly pin workflow can restart a stopped chain
when `PASS_APPLY` is `enabled`; see [The pass](../README.md#the-pass).

## Recovery drill

To show that the forge is enough, a person on a fresh machine holding only
the credentials above brings up a coordinator from nothing:

1. Clone this repository. It checks out the default branch, with
   `docs/operator-notes.md` and this page in it.
2. Install `gh` and agent-board as [What to clone](#what-to-clone) says,
   and start a shell as [Credentials and settings](#credentials-and-settings)
   says. `gh auth status` names the bot account and `agent-board --help`
   runs.
3. Read [operator-notes.md](operator-notes.md). Nothing below goes against
   an instruction there.
4. Run `gh workflow run poll.yml -R cgwalters-forge/tracker` and wait for
   it with `gh run watch RUN -R cgwalters-forge/tracker --exit-status`.
   It succeeds, and its summary previews
   the epics and pull requests the board and `gh pr list` show as open.
   This preview writes nothing and starts no next pass. Resuming the board
   is a different step, `-f apply=true` with `PASS_APPLY` `enabled`: that
   run starts a chain, and if one is already running, whichever chain has
   the older run stops at its next dispatch, leaving one. Two runs started
   within moments of each other's check can still both continue, and the
   surviving run can still fail or be cancelled, so check `gh run list -R
   cgwalters-forge/tracker -w poll.yml` a pass later.
5. Dispatch one research run, `gh workflow run dispatch.yml -R
   cgwalters-forge/tracker -f kind=research -f repo=cgwalters-forge/tracker
   -f item=507 -f task="$(cat BRIEFFILE)"`, with a brief asking for a short
   check of this page. The run succeeds and leaves its one comment on the
   item.

The result of a drill is recorded as a dated comment on
[#507](https://github.com/cgwalters-forge/tracker/issues/507), with the
links to the runs.

## Still only on the machine

Credentials, by design: the token file, the environment file and the
broker's policy on the inference host.
Dispatch briefs written before
[#508](https://github.com/cgwalters-forge/tracker/issues/508) were on tmpfs
and are lost. Each later task's text reaches `dispatch.yml` as its `task`
input, and can be read back from that run's log only while GitHub keeps
the log.

## A second operator's deployment

This is a GitHub walkthrough for an operator starting in their own
organization, not recovery of this deployment. The source of truth is
agent-board's [setup](https://github.com/cgwalters-forge/agent-board/blob/main/docs/setup.md)
and [pass configuration](https://github.com/cgwalters-forge/agent-board/blob/main/docs/pass.md#one-configuration-file),
agentic-job's [workflow](https://github.com/cgwalters-forge/agentic-job/blob/main/docs/workflow.md)
and [inference](https://github.com/cgwalters-forge/agentic-job/blob/main/docs/inference.md)
guides, and the actions [README](https://github.com/cgwalters-forge/actions/blob/main/README.md)
and [deployment file](https://github.com/cgwalters-forge/actions/blob/main/deployment/deployment.json).
These links follow main; use documentation at the reviewed revisions you
actually deploy where main differs. In particular, the actions wrappers
currently compose agentic-job v0.6.2; main's workflow/isolation layout is
newer. Do not mix their steps or assume a main-only input is available.

### 1. Choose identities and create the board

Create an organization Project v2, a public caller/tracker repository with
a protected default branch, a disposable public target repository and a
dedicated bot account. Choose the human operator login, bot login,
organization login **and numeric owner ID**, caller `OWNER/REPO`, default
branch, dispatch workflow basename, target repository lists and project
number (not its node ID). Keep these in trusted deployment configuration,
not task inputs. Authorize Actions/reusable workflows, bot access and token
SSO/organization approval where needed. Project writes and fork-based PR
apply have different credential requirements; a board read proves neither.

Follow setup's **Connect one lane** for the Status/Priority options,
`project init` (only missing Turn/Run/Result fields), labels and operator
assignment. Install `gh` and agent-board from a reviewed source revision.
Run setup's offline rehearsal without tokens first, then make a live
snapshot and preview reconciliation against your project. Never copy
fixture identities into live configuration. Keep scheduling off.

### 2. Own the wrappers and prove dispatch/check/apply

Deploy your own copy of the actions wrappers, or arrange explicit admission
with their operator; upstream rejects owners absent from `admit/owners.json`.
For an independent copy, set that file to your organization login and numeric
ID, set `deployment/deployment.json`'s `agent-config-repo` and `agent-model`,
and repoint both wrappers' literal `uses: cgwalters-forge/actions/...` lines
at your copy. Otherwise they still execute upstream admission, tailnet and
deployment defaults. Follow the
[deployment action](https://github.com/cgwalters-forge/actions/blob/main/deployment/README.md)
and [admission action](https://github.com/cgwalters-forge/actions/blob/main/admit/README.md),
not a search-and-replace of upstream source names: pinned agentic-job calls
and their expected-source guards must continue to agree.

Install the actions README's dispatch caller on your protected default
branch, pointing `uses` at your wrapper. Keep its `kind`, `repo`, `item`,
`task` interface and `KIND OWNER/REPO#N` run-name prefix that agent-board
recognizes. Supply caller-owned `.github/agentic-job/dispatch.toml`,
`fix.toml`, `hosted.toml` and profiles if adopting tracker's profile composer.
Set exact `repos`, allowed `bases`, output types/counts, file bounds and
finite time/request/spending limits; do not inherit this deployment's
allowlists or `.github` exemptions. Follow agentic-job's
[scripted trial](https://github.com/cgwalters-forge/agentic-job/blob/main/docs/dispatch.md#ten-minute-scripted-trial)
for the first model-free research run on a throwaway issue. The wrapper
supports `agent: fake`; that run doesn't need a broker or tailnet.

The README's minimal caller is enough for that manual trial, **not** for
automatic pass work. Before enabling pools, extend it to accept `pool`
and resolve it through a trusted, closed pool-to-agent/model/budget map,
passing those resolved settings to the wrapper and rejecting unknown pools.
Use agent-board's [dispatch contract](https://github.com/cgwalters-forge/agent-board/blob/main/docs/dispatch.md#the-request)
and this repository's [pool-capable caller](../.github/workflows/dispatch.yml)
and [pool mapping](../.github/agentic-job/pools.json) as references, replacing
the values with yours. The pass sends `pool` when selecting automatic work;
without that declared input GitHub refuses the dispatch with HTTP 422.
The contract's optional `base` input is for stacked plans; do not enable
those unless your chosen caller supports it too.

Before provisioning a PR-producing writer, review and pin the workflow and
its executable dependencies as in the [credential cutover plan](credentials.md#plan).
For cross-repository status, require a pin that supports independent status
with the legacy apply writer. The dispatch pin described in the plan lacks
this feature: supplying `STATUS_TOKEN` alone doesn't enable it, and role
mode also changes apply to `PUSH_TOKEN` and `PUBLICATION_TOKEN`. Do not copy
the writer to a caller-visible secret to keep status working.

Create a fresh apply environment for the writer, restricted to the protected
default branch. Require an unbypassable gate that checks the reviewed caller
SHA, not just the branch, and verify that it rejects a pre-cutover revision
before adding the secret on an existing installation. Use an automated gate
for unattended workflows. Store the legacy writer as `SAFE_OUTPUTS_PAT` only
in that environment, and configure the apply job to declare it.
Keep an explicit `SAFE_OUTPUTS_PAT: ${{ secrets.SAFE_OUTPUTS_PAT }}`
mapping at each call boundary to apply: it passes the name, but the calling
job cannot read the environment value. Give cross-repository status its own
narrow credential. Verify apply separately, and check that finish edits the
comment created by start before retiring any shared secret. Follow workflow's
**The apply job and its token** for fork permissions/scopes. Keep fork Actions
off and forks free of secrets. Never pass the writer to the agent or check.

Inspect policy admission, the agent artifact, the independent check report
and `applied.json`, not just a green dispatch. Check runs on a separate
machine without the apply credential; only accepted outputs reach apply.
Start with a comment, then one harmless documentation PR, verifying the
fork, base, files and destination. Scripted success does not prove inference,
review or a scheduled loop.

### 3. Register inference and install review separately

Provision a broker and runners' network path using the inference guide;
provider credentials stay at the broker. Set your own `INFERENCE_URL` and
`INFERENCE_AUDIENCE` together, never copying a deployment's address. Use
`inference-register: github-oidc` (the wrappers' default). Their composed
agent jobs run in the wrappers themselves: admit the **actual wrapper
identity**, not just agentic-job.yml. Follow inference's **Which workflows
a broker admits**: `called_workflows` can bind the reusable file/ref or
pinned SHA and calling repository IDs; a caller-composed job instead needs
repository-scoped `any_workflow`, admitting any workflow there able to
request OIDC. Record which form you authorized, finite broker budgets,
audience and workflow revision; update admission when pins change.
`id-token: write` alone does not register a workflow at the broker.

Set up your own Tailscale OIDC federation, client ID, runner tags and ACLs
following the [tailnet action](https://github.com/cgwalters-forge/actions/blob/main/tailscale/README.md).
Federation and broker must check the same admitted numeric owner IDs as
the wrappers, not only their shared `job_workflow_ref`. Confirm the join
and reachability before a real research run. The shared workflow does not
provide a supported provider-key shortcut; do not provision
`INFERENCE_API_KEY` for this walkthrough.

In each target install a caller of your `cgwalters-review.yml` wrapper,
using the actions README's events, condition and six permission grants,
plus `workflow/review.toml`, `review-command.toml` and `review.md` on the
trusted base. Set repository/base/event/bot bounds for your target. Never
execute PR head code in privileged jobs. Exercise a review and synchronize
cancellation on a disposable PR. Real approval submission requires both
`AGENT_REAL_REVIEWS=true` and GitHub Actions' permission to create/approve
PRs. Leave it unset initially; choose required reviews, stale-approval
dismissal and merge policy independently. An agent verdict is not human
authorization; review's compatibility status is not a merge gate.

### 4. Preview a pass, then enable one poll caller

Write a fresh `pass.json` using setup's minimal live example. Set
`operator`, `bot`, `dispatchRepo`, `dispatchWorkflow`, `dispatchRef`,
`board.owner`, `board.project` and exact `workRepositories`; begin with
`wip: 0`, `triage: false`, no `follow` and no `epics`. This schema is **not**
`.github/poll/agent-board.json`: unknown keys and nulls are refused.
From a trusted default-branch checkout with a read credential, run:

```sh
agent-board pass --config pass.json --max-dispatch 0 --max-writes 0 --max-status-changes 5
```

No `--apply`. Zero caps bound dispatch/write proposals; more than five
Status changes rejects the entire stage. These caps prevent an unexpectedly
large first census from becoming an approved batch; they don't replace the write
gate. Inspect every error and held line before proceeding.

To preview automatic candidates, choose positive `wip` and `pools` with
your own private `usage.repository`/`issue`. Set `usage.url` only when the
caller reaches the broker's usage endpoint; otherwise pacing reads the
published snapshot. Enable only tested lanes: `follow` and
`pr.reviewWorkflow`/`pr.fixPools` for PR follow-up, `epics.repository` for
epics, and `triage` plus `triagePools`/`planPools` for no-plan work. Pool
names must match dispatch's agent/model/budget mapping. Do not import
tracker's WIP, pace, budgets or retry policy as defaults.

The exhaustive pass reference linked above covers optional fields. Every
additional identity/destination must be yours: `holds.repository`/`issue`
(private, with `holds.needsYou` for the control app); `holds.proposals`'s repository,
label, repositories and org; `direction.repository`/`issue`;
`maintain.repos.include`/`exclude` and `maintain.digest.repository`/`issue`;
`sweep.repository`; all `pr` repository, author, head-owner, workflow and
pool lists; `budget`'s source/URL/pool map or weekly amount and harness
repositories; and `promote`'s forks/upstreams/bases, policy repository/path
and operator sign-off if enabling promotion. Choose model `prices`, pacing
targets/bursts, triage/revisit/sweep/maintain timing, overlap/stall/retry/merge
caps and optional state/cache paths, or omit them for documented defaults.
Unused sections stay absent.

Install one pinned poll caller as setup's **Pinned callers** describes:
trusted config, reviewed `AGENT_BOARD_REV`, serialized passes, finite job
timeout and explicit dispatch/write/Status caps. This repository's
`poll.yml` also needs its Justfile build recipe, pass/fix bounds, secret
mapping and tailnet configuration; it is an example, not an installer.
Its direct tailnet call does not forward the wrappers' tailnet variables:
adapt that action call with your own inputs or organization entry too.
Preview by hand, then try a small explicit apply, verify receipts and a
second idle pass in staging, and only then start the chain: set
`PASS_APPLY=enabled`, run `gh workflow run poll.yml -f apply=true`, and
check that its `next` job started a new `pass (apply)` run. There is no
schedule; unsetting the variable stops the chain but does not prevent a
manual `apply=true`.
Never run two appliers against one board.

### Repository variables and secrets checklist

Set these on the caller and each review target as applicable: reusable
workflows read the calling repository's variables. These are choices, not
values to copy from this deployment:

| Variable | Deployment's choice |
| --- | --- |
| `AGENT`, `AGENT_MODEL` | Supported agent and model served by your broker; test one first |
| `AGENT_RUNNER` | Disposable runner label(s), encoded as JSON |
| `AGENT_CONFIG` | Trusted runner TOML path, or deliberately use the wrapper's documented default |
| `AGENT_CONFIG_REPO`, `AGENT_CONFIG_PATH` | Your agent configuration repository and configuration directory |
| `INFERENCE_URL`, `INFERENCE_AUDIENCE` | Your reachable broker root and matching OIDC audience |
| `AGENTIC_JOB_TAILSCALE_OAUTH_CLIENT_ID`, `AGENTIC_JOB_TAILSCALE_TAGS` | Your federated client ID and tags; both needed for an unlisted organization |
| `APPLY_ENVIRONMENT` | Protected caller environment, unless fixed by dispatch input |
| `PASS_APPLY` | Unset during bring-up; `enabled` only after watching bounded applies |
| `AGENT_REAL_REVIEWS` | Unset until checked review submission is wanted; then `true` |
| `REVIEW_BOT_IDS` | Optional JSON numeric bot IDs, also admitted by login in review bounds |
| `AGENTIC_JOB_DETECT_MODEL` | Leave unset: these wrappers' hosted detector has no tailnet join |

Secret names only: `SAFE_OUTPUTS_PAT` is the wrapper/apply interface;
`CGWALTERS_BOT_PAT` is this caller's stored name and pass credential, not
a required name for your deployment. Local CLI reads use `GH_TOKEN`; a
pass may use `DISPATCH_TOKEN` separately for Actions write. No model key,
tailnet auth key or OAuth client secret belongs in these workflows.
Auxiliary automation is not needed for this loop: leave `SUPERVISOR`,
`BROKER_OUTAGE`, `RELEASE_TRAIN`, `AGENT_BOARD_PIN` and `WEEKLY_BLOG` unset.
If later copying those callers, replace their configs and issue IDs too;
supervisor's pre-checkout gate needs `OPERATOR` and
`SUPERVISOR_REQUESTS_ISSUE`, and sessions need `TAILNET_DOMAIN` and trusted
operator/origin lists. These are separate installations.

<a name="5-host-the-review-app-for-your-operator"></a>

### 5. Host the control app for your operator

Use the control app's [README](https://github.com/cgwalters-forge/review/blob/main/README.md)
for Node requirements, `npm ci`, `npm run check`, local serving and static
hosting. It is a browser client of GitHub, not the review workflow or a
scheduler. Its current GitHub pages are **Needs you** and **Status**; old
chat/operations routes do not provide an interactive coordinator.

Before building your copy, edit
[`src/github/config.ts`](https://github.com/cgwalters-forge/review/blob/main/src/github/config.ts):
`BOARD_OWNER`, `BOARD_NUMBER`, `OPERATOR`, `BOT_LOGIN`, `FORGE_ORG`,
`TRACKER_REPO`, `USAGE_REPO` and `USAGE_ISSUE` must match your pass. Review
field/status/label constants and `ROLE_APPS`; list only trusted identities.
Replace the operator sign-off locally if using Make it mine, never adopting
someone else's identity. The file retains old devspace/workflow/heartbeat
constants too; do not point them at this deployment. Set these companion
files under `src/github/` before publication:

- `action-config.json`: operator, planner, tracker, repository allowlist,
  project URL and org for operator proposals.
- `decisions-config.json`: document repo/number or `document: null` to
  disable that source; choose whether to keep `legacyQuestions`.
- `review-draft-config.json`: leave disabled unless installing the matching
  draft/send workflow; then set tracker, label, authors, sendBox, workflow, ref.
- `usage-config.json`: allowance repository/path and cost repository/ref.
- `chat-config.json`: replace network domain and source
  repo/workflow/issue/publisher even with no browser chat pane; the build
  still reads it for its connection policy. To disable, use
  `{"tailnetDomain":"","sources":[]}` rather than deleting the imported file.

Choose your own static site repository, Pages workflow and publication URL.
The build contains public configuration, never tokens or private issue
contents. Sign in only to a site you trust with the operator's token using
the README's scopes; it is stored in that browser and sent to GitHub, not
installed as an Actions secret. Confirm your project and published
holds/status first, then test writes only on throwaway items. Missing or
stale snapshots do not prove the queue is empty.

### Remaining deployment coupling

The known configurability work is
[actions#106](https://github.com/cgwalters-forge/actions/issues/106) and
[agent-board#226](https://github.com/cgwalters-forge/agent-board/issues/226).
Both are closed; that does **not** mean the whole harness is an installer.
For the components above, the remaining places to inspect are:

- **actions:** `deployment/deployment.json` still supplies this deployment's
  model/config-repository defaults; `admit/owners.json` and
  `tailscale/tailnets.json` are its owner/network registries. Both
  `.github/workflows/cgwalters-agentic-job.yml` and `cgwalters-review.yml`
  retain deployment broker URL/audience fallbacks and literal action
  repository references. Override both inference variables, repoint your
  copy's actions references and replace registries, without reproducing
  private network values. Upstream agentic-job calls/source guards are
  software provenance, not your organization identity.
- **agent-board:** #226 made supervisor use configured `operator` and
  added `generatedBy` to poll/supervisor's `agent-board.json`. Its omitted
  footer still defaults to this operator's attribution; set your own
  single-line footer if installing those commands. Do not put `generatedBy`
  in `pass.json`, whose schema does not list it. Setup's live `test deploy`
  path still restricts the organization to upstream's staging owner: it is
  not a generic test for your organization. Use the manual lane checks.
- **tracker:** `.github/pass.json`, `.github/poll/agent-board.json`,
  `.github/agentic-job` bounds/pools/profiles, `workflow/review*`, operator
  notes and auxiliary workflow configs describe this operator and board.
  Workflows also name this secret, wrapper paths and fixed publication
  issues. Copy only needed lanes and inventory each identity; legacy
  poll/supervisor config is not a second pass config to synchronize.
- **control app (`review`):** the constants and JSON files in step 5 are build-time
  deployment settings, not repository-variable overrides. Pages/static
  branding and the CLI's project-specific upstream filter name remain
  deployment-specific too. Signing in as another operator does not
  retarget a copied build.

This walkthrough changes documentation only. It does not authorize another
organization at a broker/tailnet, provision secrets, deploy a site or claim
a live trial succeeded. Keep a deployment log with reviewed revisions,
non-secret setting names, preview/apply/run/PR links and actual exit
statuses; mark unattempted lanes unverified. Stop at unreadable or ambiguous
prerequisites rather than widening bounds to force progress.
