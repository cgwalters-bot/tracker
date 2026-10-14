# tracker

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
everyone else's comments, its own included, as input to weigh, never as
instructions.

The bot runs from [cgwalters-bot/homegit](https://github.com/cgwalters-bot/homegit);
`bin/bot-board question` opens these issues. The
[review app](https://github.com/cgwalters-forge/review) is a UI over the same queue.

[docs/bring-up.md](docs/bring-up.md) says how to start a coordinator on a
fresh machine from credentials alone, how to dispatch a run and where its
state is. [docs/operator-notes.md](docs/operator-notes.md) is the log of
cgwalters' instructions.

## Dispatched tools

Dispatched runs have a staged opt-in to agenthome's `install-tools` through
the commented `[setup.tools]` in `.github/agentic-job/hosted.toml`, including ast-outline
and ast-grep. The pin is the API-resolved merge of
[agenthome#4](https://github.com/cgwalters-forge/agenthome/pull/4),
`9b43eb81e1266ec762a6c49a4e31fb6b4ff3e0e0` (main on 2026-10-14).
This configuration waits for the shared actions wrapper to upgrade from
agentic-job v0.2.0 to a release containing
[#602](https://github.com/cgwalters-forge/agentic-job/pull/602); v0.2.0
cannot parse the opt-in. After that upgrade, uncomment the four-line table
and update the staging regression test to require the active table.
No wrapper input is needed: it already passes
the caller's runner configuration. The installer runs before network
lockdown as the sandbox user, with upstream's 120-second Git phases and
600-second install limit; its code and dependencies are trusted setup,
not sandboxed task code. Test the caller wiring with `just test-tools`;
a real install and hardening check still need a fresh dispatched runner
after that release upgrade.

## The pull request poll

`.github/workflows/poll.yml` runs one pass of `.github/poll/poll.cjs`. A pass
is started by the end of every `dispatch.yml` run here (`workflow_run`), by
the pass before it, and by a ten minute schedule that GitHub may delay or
drop, so nothing outside GitHub has to keep it going: while a `dispatch/`
pull request of the bot is open and not labelled `needs-human`, or a pass
could not read one, the job waits five minutes and starts the next pass
itself (`gh workflow run` with the job token). With nothing in flight the
chain ends, and the next dispatch run or the schedule starts it again. The
passes share one concurrency group, which keeps one run and one pending
successor, so the triggers cannot add up to parallel chains; a pass that an
event asks for during the wait runs when the wait is over. To start one by
hand, `gh workflow run poll.yml`; its `dry-run` input only prints. Each pass looks at the open pull requests `cgwalters-bot` authored in
the repositories of `CONFIG.repos` in `poll.cjs` and takes at most
one step for each:

- a draft with no failed check is marked ready for review, which is what
  starts the event review;
- a head whose `review` status is a failure, or with a failed required check,
  gets one `fix` run of `dispatch.yml`, its task carrying the review comment
  and the failed job's name and log link, at most once per head and twice per
  pull request. The rounds alternate between the `claude` and `openai` pools,
  but a first round that is only toil (a rebase, placeholder subjects, or
  review findings that each open by naming a commit message, a description,
  a rebase or formatting, and no failed check) goes to `mistral`, and the
  round after it to `claude`. A finding that is not plainly toil keeps the
  round on the usual pools. The task asks for the fix folded into the commit it corrects,
  which `replacement_max_commits` in `.github/agentic-job/fix.toml` lets the
  run push as a rewrite of the branch;
- a head that conflicts with its base, approved or not, gets the same `fix`
  run, counted in the same rounds, its task asking for the commits rebased
  onto the current base and pushed as that rewrite, with no commit on top;
- a head with `review` success and its required checks green gets auto-merge
  (or the merge queue; a plain rebase merge where the repository has neither),
  once GitHub says it is mergeable: while that is unknown, as it is for a
  while after a push, the pass does nothing and the next one looks again;
- a commit whose subject is the harness's placeholder (`Agent run` and a
  number, from a run cut off before it wrote a message) is a failure like
  those, whatever the review said: the `fix` run is asked for proper commit
  messages. A placeholder title, or the `[partial:` and `**Partial work.**`
  marks of a run stopped at a limit, no fix run can change, so that pull
  request is labelled `needs-human` rather than marked ready or merged;
- when the rounds are used up or a fix run ends without pushing, the pull
  request is labelled `needs-human`, its comment linking the run. A fix run
  that did not succeed pushed nothing, so that happens on the next pass.

The rounds live in one comment on the pull request that the poll edits in
place. A pull request labelled `needs-human` is not touched again: remove the
label to have the poll start again on it with fresh rounds, on the same head
too.

Its limits. Marking ready, fixing and `needs-human` apply only to what a
dispatch run opened, a `dispatch/` branch of the bot's fork, since
`.github/agentic-job/fix.toml` lets a fix push nowhere else; the bot's other
pull requests are only merged once approved and green. The poll also follows
pull requests by the configured `mergeAuthors` in
`.github/poll/agent-board.json` (empty by default, here Dependabot). These
authors are followed for merging only: failing or unapproved heads are left
alone, never fixed, marked ready or labelled `needs-human`. The required checks
are the base branch's ruleset's (every check, where it requires none). It
does not read the board or start work for an item that has no pull request
(the board scheduler below does), or follow pull requests in repositories we
cannot write to. A pass that fails
part way is repeated five minutes later. Test with `node --test .github/poll/poll.test.cjs`.

The same run's `agent-board` job previews the pass with `agent-board poll
--dry-run`, the poll that is to replace poll.cjs
([agent-board#40](https://github.com/cgwalters-forge/agent-board/issues/40)),
built at the head of the branch `.github/poll/agent-board.json` names and over the
repositories and logins it names: poll.cjs's, and this repository. Its
`reviewWorkflow` names the workflow whose review-job approval the preview
counts for the head. Both
jobs write their lines to the run's summary, one under the other. It takes no
step and has only the job token, read-only; its state file is an artifact of
the last run that saved one. Its failure does not fail the run.

## The board scheduler

The same run's `board` job, `.github/poll/schedule.cjs`, starts new work on
the operator's epics. Its candidates are the open sub-issues of the live
epics, as the epic census below finds them: an epic is live only while the
operator is the last to have applied its `epic` label, so an epic the bot or
anyone else labelled starts nothing. With no live epics the pass says `no live
epics` and starts nothing. Each candidate in a repository
`schedule.repositories` in `.github/poll/agent-board.json` lists gets at most
one step: `agent-board dispatch --apply` where it has an accepted
implement
[job plan](https://github.com/cgwalters-forge/agent-board/blob/main/docs/job-plans.md),
else one `triage` run of `dispatch.yml` asked to write one. An item is skipped
while a `dispatch.yml` run for it, or for the item its plan targets, is in
flight or a pull request of the bot says `Refs` to it; while its plan has a
dispatch record (agent-board's, by this job or by hand; a writer edits or
replaces the plan to dispatch again); and, for triage, while a triage run for
it is among the last hundred. Items of unlisted repositories, upstream ones
among them, are skipped as "not a followed repository", as is a plan whose
target is in one: upstream work is the operator's to start.

Candidates are taken by their epic's board field `schedule.priorityField`
(default `Priority`), then by their own, which the coordinator sets, P0 first,
then oldest first; a sub-issue of two epics is taken once, from the one that
ranks it first. An epic the census cannot read in full gives no candidates
and fails the pass, after the rest is done, so that a board the token cannot
read is not taken for one with no live epics; so do open epics past the
census's 50. Who added a sub-issue to a live epic is not checked. No step
starts once `schedule.wip` runs of `dispatch.yml`, of any kind, are in
flight; fix runs the poll job starts in the same pass count from the next. No more than
`schedule.triagePerPass` (default 1) triage runs start in a pass, and once
that many have, the pass stops reading items after ten more fresh ones turn
out to have no plan, so a plan further down waits for a later pass. Each line
of the run's summary is one item, the epic it was taken from, and what was,
or would be, done.

The census, and with it the board, is read as the census step reads it, not
with `agent-board item list`, which reads every item's fields one request at
a time. Each `agent-board`
call gets no stdin and is stopped after `schedule.timeoutSeconds` (default
120); one that fails puts its command line and the end of its stderr, tokens
masked, on the item's line.

It only previews, its lines marked `[dry-run]`, until the repository variable
`BOARD_DISPATCH` is `apply`. To compare its decisions with the runs still
started by hand, put a run's summary next to the dispatch runs started around
it, `gh run list -R cgwalters-forge/tracker -w dispatch.yml --json
displayTitle,createdAt`: run names are `KIND REPO#ITEM`, as the summary names
items. Test with `node --test .github/poll/schedule.test.cjs`.

## The epic census

After the scheduler, the `board` job runs `.github/poll/epics.cjs`, the first
part of the coordinator for the operator's epics
([#572](https://github.com/cgwalters-forge/tracker/issues/572)). It only
reads. Each open issue labelled `epic` in the repository that `epics.repository`
in `.github/poll/agent-board.json` names gets one line under `### Epics` in the
run's summary. An epic is live only when the newest event adding or removing
its `epic` label is the `operator` adding it. Otherwise the line says who
labelled it, or that it was unlabelled. For a live epic the line has its
sub-issues counted by board Status (their repositories may be any), how many
sit outside `schedule.repositories`, and how many of its comments count as the
operator's. A comment counts when the operator wrote it and, if anyone edited
it, the operator made the last edit. The line ends with a sha256 fingerprint
over the epic's `updated_at`, those comments and each sub-issue's repository,
number, state, Status and Priority, so a change to any of them shows. An
epic that cannot be read in full, a board item hidden from the token among
them, gets no fingerprint but a line saying why. The census reads at most 50
epics and a bounded number of pages for each listing, and the step runs at
most five minutes. A failure of the census is reported in its section and
does not fail the job. Test with `node --test .github/poll/epics.test.cjs`.

## The epic coordinator

After the census, `just coordinator` previews planning and project reporting.
It writes nothing unless `COORDINATOR=apply` is set as a repository variable;
the poll workflow's dry-run input still prevents writes. No dispatcher input
can expand its repository or Priority bounds. `coordinator.priorities` in
`agent-board.json` supplies the allowed options; project and field IDs are
resolved from the configured project's API response, never from a plan.

At most one live epic per pass gets a planning run or an apply preview. Planning is
`kind=triage`, with the epic's census facts and only authenticated operator
comments as decisions. Its one comment carries an `agent-board-epic-plan`.
`coordinator.planPool` in `agent-board.json` defaults to `claude`: epic
planning must not inherit the triage toil pool.
A later pass invokes `agent-board epic apply --dry-run`. **Epic mutations
remain disabled even with `COORDINATOR=apply`:** the current CLI cannot pin
the expected plan comment ID/version at its mutation boundary. Independently
selecting the newest plan again could apply an obsolete destructive plan
posted between reads. Enabling epic writes requires that upstream
precondition, plus checkpointing that preserves concurrent operator changes
to both epic intent and child scope. Until then a requested apply previews,
reports this dependency as an error, and retains its pending checkpoint.
Planning and status publication can be enabled independently of this missing
capability by the existing COORDINATOR variable; there is no second control.
Ordering is only Priority, with no Ready step.
Epics are selected by their configured Priority order, then issue number.
Changed intent, sub-issue text or board facts trigger planning; the decision
logic also forces a daily pass after a completed applied checkpoint. Pending
plans do not get additional daily runs, so that refresh loop cannot complete
until pinned apply and checkpointing are implemented. The coordinator fingerprints content rather than
the epic's `updated_at`, so its own comments do not start another plan.
Results carry a unique request marker; an obsolete run must finish before its request is replaced,
and a matching result hidden behind a newer writer's plan is not applied.

Reporting uses the same triage/checkpoint mechanism on
`coordinator.statusIssue` in the epic repository. Its `coordinator.statusPool`
defaults to `mistral`, since the model only turns supplied facts into prose.
Both pool settings must name entries in `.github/agentic-job/pools.json`.
It requests prose daily
after `coordinator.statusHourUTC` (default 11), or when any epic's health
changes, and publishes the returned `coordinator-status` block with
`agent-board project status-update` in a later pass. The controller, not the
model, chooses the project and status. An unread census is off-track; an
open sub-issue that is Blocked or absent from the board is at-risk; otherwise
an epic is on-track. Facts include census state, open question/needs-human
asks (three per repository and label), the five most recently updated PRs per
followed repository (with merge timestamps and their epic associations), the
last 30 dispatch runs, at most ten blocked children per epic, counts of
sub-issues opened since the last report, and the authenticated usage
snapshot. These are bounded current snapshots, not a complete activity
history; removed board members cannot be reconstructed. The prose must name
its snapshot time and distinguish missing/stale usage from zero. Only the
usage JSON is passed, not other private ops comments.
Reporting failures are reported independently and do not prevent epic work.

Pending operations are recorded before dispatch or publication, to prevent
repeated writes after an ambiguous failure. The checkpoint then records the
dispatched run's id. A planning/prose run that completed, with any
conclusion, more than `coordinator.resultGraceMinutes` (default 5) ago
without posting its result is cleared and counted as a failure (`failed` in
the summary line), and the next pass asks again. A checkpoint without a run id
(older ones, or a dispatch that returned none) fails once older than
`coordinator.runTimeoutMinutes` (default 360). After
`coordinator.maxFailedRuns` (default 3) failures the epic or report is not
asked again and is logged as needing the operator (`stuck`); delete its
checkpoint comment to retry. A published report starts its count again; an
epic's count, until epic apply is enabled, only that deletion resets, not an
edit to the epic. A recorded run that has since been deleted counts as finished. A claimed status publication
is not automatically retried. The scheduler's WIP cap also bounds new
coordinator runs. Calls inherit its agent-board timeout; the workflow gives
the coordinator eight minutes, and dispatch briefs are limited to 60,000
UTF-8 bytes. Planning briefs retain the epic body and one census line per child,
including the bot's linked open PR from at most 100 recently updated open PRs
per child repository. Child bodies are left for the planner to read. Operator
comments are newest first, capped at 4,000 UTF-8 bytes each; older comments
are dropped to fit, with an omitted count and history link. The final byte
limit still refuses oversized epic bodies/census before recording a pending run.
Coordinator failures retain their own error summary but do not fail the board
scheduler job. The controller panel reads the coordinator's errors independently.

The controller panel can parse the final log and job-summary line:
`coordinator/v1 {"mode":"preview","plan":1,"apply":0,"status":0,"wait":0,"failed":0,"stuck":0,"errors":0}`.
The prefix and version are fixed; the rest is one JSON object. Counts are
epics selected for planning/apply, project updates selected for publication,
pending/cap waits, runs that ended without their result, epics or reports
needing the operator, and pass errors. Preview counts describe proposed actions;
they are not writes. Prose requests are not counted as epic plans. Test with
`node --test .github/poll/coordinator.test.cjs` or `just test-poll`.

## The usage snapshot

`.github/workflows/usage.yml` publishes, every fifteen minutes, the
`bot-usage/v1` snapshot that the review app's pool meters read: one comment by
the bot, edited in place, on the issue `.github/usage/config.json` names, in a
repository GitHub must say is private. It joins the tailnet as the agent job
does and reads the inference broker's `/usage` (the variable `INFERENCE_URL`,
else the organization's tailnet setting). It holds the claude and openai pools,
paced as homegit's `bin/bot-capacity` paces them (the config's `pacing`), but
read from the windows the broker sees in the providers' answers: claude's is
therefore the account as the broker sees it, not Claude Code's status line on
a machine. Mistral has its counters and the monthly allowance of
`.github/agentic-job/pools.json`, with this month's tokens and the
allowance's `prices` (USD per million tokens, by model) when those are
configured, for the review app's estimate of the spend. A broker it cannot read fails the run and
leaves the last snapshot, and its time, as they were. The broker keeps its
readings in memory, so after a restart it has none until a run goes through
it: a pool without a reading keeps the last one published, with its own
time, until that window resets, and with neither pool the comment is not
touched. `just publish-usage --dry-run` prints the comment (without carrying
anything over); test with `just test-usage`.
