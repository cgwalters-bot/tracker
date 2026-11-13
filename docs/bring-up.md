# Bringing up a coordinator

> This text is LLM generated.

The coordinator picks work from the
[board](https://github.com/orgs/cgwalters-forge/projects/1) and dispatches
it. It runs here, as `poll.yml`: one scheduled `agent-board pass` follows
pull requests, plans and applies the operator's epics, schedules board work
and derives board Status (the README's "The pass"). Its writes are off until
the repository variable `PASS_APPLY` is `enabled`; until then it only
previews, in the run's summary. Once enabled, each pass starts the next;
unsetting the variable stops them. A person
at a machine with only credentials checks on it, manually dispatches work
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
can write even with `PASS_APPLY` unset; the variable gates scheduled apply
and the successor chain, not that manual input.

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
pull request for review and fix; `OWNER/REPO` must be listed in
`.github/agentic-job/dispatch.toml` (`fix.toml` for a fix), or, for a
midstream fork, in `midstream.toml` and `midstream-fix.toml` instead.

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
`period`, which is `calendar-month` (`mistral`: 300 USD). Nothing in this
repository enforces it. Every pool has a `tier`, 1 (`claude`, `openai`,
`fable`) or 2 (`mistral`); `"auto": false` keeps `fable`, whose allowance
is separate, for manual dispatch. The pass paces its runs on the pools
`.github/pass.json` names, and alternates fix rounds between its
`pr.fixPools`, except that a first round that is only toil goes to
`pr.toilFixPool`. The run applies
its own result: a pull request from the bot's fork, or one comment on the
item. `gh run watch RUN -R cgwalters-forge/tracker --exit-status` waits
for a run and fails unless it succeeds; `gh run view RUN -R
cgwalters-forge/tracker --json jobs -q '.jobs[] | select(.conclusion ==
"failure") | .name'` names its failed jobs.

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
choose the operator login list and review site's origins
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
mid-session writes, the review site's pane and a scripted fake-agent end-to-end
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

## Where an operator comment goes

- On a live epic here: the next pass plans the epic again with it.
- Anywhere else: nothing reads the comment as such; the next pass acts on
  the thread's current state. Outside the followed repositories, bootc-dev
  included, a comment reaches no pass at all.

"The next pass" is the pass's cadence: every ten minutes on the schedule,
which GitHub may delay.

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

Before a PR-producing run, create the caller's protected apply environment
(here `agent-apply`), restrict it to the protected default branch and
explicitly forward `SAFE_OUTPUTS_PAT`. A repository/organization secret
can have a deployment-chosen stored name (here `CGWALTERS_BOT_PAT`) mapped
to `SAFE_OUTPUTS_PAT`; an environment-only secret must be stored and
forwarded as `SAFE_OUTPUTS_PAT`. Follow workflow's **The apply job and its
token** for fork permissions/scopes. Keep fork Actions off and forks free
of secrets. Never pass this token to the agent or check. Status helpers may
also use the explicitly forwarded token, outside apply's environment gate.

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
(private, with `holds.needsYou` for the app); `holds.proposals`'s repository,
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
second idle pass in staging, and only then enable scheduling. In this
caller `PASS_APPLY=enabled` enables scheduled writes and successor runs;
unsetting it stops that chain but does not prevent manual `apply=true`.
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

### 5. Host the review app for your operator

Use the review app's [README](https://github.com/cgwalters-forge/review/blob/main/README.md)
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
- **review:** the constants and JSON files in step 5 are build-time
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
