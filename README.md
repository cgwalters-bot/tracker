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

The bot's workflows here, or
[agent-board](https://github.com/cgwalters-forge/agent-board)'s `ask create`
by hand, open these issues. The
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

### Private decisions

Each pass also runs `agent-board ask read` when the repository secret
`DECISIONS_STATE_KEY` is set (64 hexadecimal digits, a random 256-bit key).
It is off without that secret. `decisions` in the default-branch
`.github/poll/agent-board.json` names the private issue; the poll's existing bot
PAT must have issue read/write access there. This change does not grant token
permissions or act on any answer.

The public log and summary contain only `decisions/v1` JSON with `status`,
`changes` (`id` and `options`, letters only), and `other_edits`. Option labels,
replies, before/after bodies and child diagnostics are never forwarded. The
controller must read reply text from the private issue, not the public panel.
A failed read fails the pass and keeps the retry chain alive.

The last-written baseline is not a last-read cursor: repeated reads continue
to report unanswered edits until a private writer updates the document.
Agent-board recovers it from bot edit history when no local baseline exists.
To carry a private writer's `agent-board.decisions-state.md` between passes,
encrypt its bytes with `seal(body, keyFrom(key))` from
`.github/poll/decisions.cjs` and seed `poll-state.json.decisions.enc` in the
trusted poll state artifact. Never upload the plaintext baseline. Restored
baselines are decrypted only in an owner-private temporary directory and
removed after the bounded read; the artifact carries authenticated ciphertext
beside the usual poll state. Rotate/reseed the encrypted baseline when rotating
the key. `ask read` itself never writes or advances this last-written baseline.
No real issue is fetched by `node --test .github/poll/decisions.test.cjs`.

`.github/workflows/poll.yml` runs one `agent-board poll --apply` pass through
`just poll`; `.github/poll/poll.cjs` only adapts its output, not its decisions. A pass
is started by the end of every `dispatch.yml` run here (`workflow_run`), by
the pass before it, and by a ten minute schedule that GitHub may delay or
drop, so nothing outside GitHub has to keep it going: while a `dispatch/`
pull request of the bot is open and not labelled `needs-human`, or a pass
could not read one, the job waits five minutes and starts the next pass
itself (`gh workflow run` with the job token). Activity also keeps the interval
short. With nothing in flight or newly active the
chain ends, and the next dispatch run or the schedule starts it again. The
passes share one concurrency group, which keeps one run and one pending
successor, so the triggers cannot add up to parallel chains; a pass that an
event asks for during the wait runs when the wait is over. To start one by
hand, `gh workflow run poll.yml`; its `dry-run` input only prints. Each pass looks at the open pull requests the configured bot authored in
the repositories of `follow` in `.github/poll/agent-board.json` and takes at most
one step for each:

- a draft with a checkpoint is continued, and one without gets `needs-human`:
  apply opens complete work ready for review itself, which is what starts
  the event review (`ready_when_complete` in `.github/agentic-job/dispatch.toml`
  and `fix.toml`);
- a head whose authenticated review requests changes, or with a failed required check,
  gets one `fix` run of `dispatch.yml`, its task carrying the review
  and the failed job's name and log link, at most once per head and twice per
  pull request. The rounds alternate between the `claude` and `openai` pools,
  but a first round that is only toil (a rebase, placeholder subjects, or
  review findings that each open by naming a commit message, a description,
  a rebase or formatting, and no failed check) goes to `openai`, and the
  round after it to `claude`. A finding that is not plainly toil keeps the
  round on the usual pools. The task asks for the fix folded into the commit it corrects,
  which `replacement_max_commits` in `.github/agentic-job/fix.toml` lets the
  run push as a rewrite of the branch;
- a head that conflicts with its base, approved or not, gets the same `fix`
  run, counted in the same rounds, its task asking for the commits rebased
  onto the current base and pushed as that rewrite, with no commit on top;
- a head with an authenticated approving review and its required checks green
  gets a head-pinned rebase merge (or enters the required merge queue),
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

A blocked fix can request one `add_comment` explaining why it cannot safely
change the pull request, without a push request or replacement series. This
is opt-in in the caller's `fix.toml`, bounded to one comment on the run's
target; it gives the agent no label or merge authority. The fix profile asks
for this rather than a fabricated patch. The unchanged head, not the comment's
text, is what the poll uses to stop the fix loop.

The rounds live in one comment on the pull request that the poll edits in
place. A pull request labelled `needs-human` is not touched again: remove the
label to have the poll start again on it with fresh rounds, on the same head
too.

### Broker outages

Set the repository variable `BROKER_OUTAGE=apply` to enable the
fifteen-minute `broker-probe.yml` schedule (off otherwise). The probe joins
using the dispatch tailnet wrapper and resolves `INFERENCE_URL` from the
repository variable, else the wrapper's configured proxy. It makes one TCP
connection and one unauthenticated GET, each bounded to ten seconds; any
HTTP response is reachable, not a claim that inference works. It creates one
bot-owned `outage` issue here, updates it while down, and comments and
closes it on recovery. Tailnet join or reporting failures fail the workflow,
not a false broker recovery. There are no ACL or credential changes.

While the bot's `outage` issue is open and was refreshed in the last hour,
the poll, the board scheduler and the coordinator only preview, so no agent
run starts and merges wait too; a stale one (the probe stopped) does not
hold. A fix or continuation run that failed inside an outage window, from 30
minutes before the issue opened until it closed, waits and gets its round
back once the issue closes (agent-board#110, `brokerOutage` in
`.github/poll/agent-board.json`). Both do nothing until `BROKER_OUTAGE=apply`.
Test with `just test-poll`.

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
part way is repeated five minutes later. Test with `just test-poll`.

The binary is built afresh at the head of the configured source branch, never
from a cache, and reads policy with `--config` from this default-branch checkout.
The bot token acts on pull requests; the job token only dispatches fix runs and
the successor pass. `reviewWorkflow` identifies the event-review workflow;
only its authenticated review of this head or the operator's review counts,
not a `review` status or a `VERDICT` comment. Existing auto-merge/queue entries
are left alone; the poll never enables auto-merge on a future, unreviewed push.
A pass is bounded to five minutes and the adapter bounds captured output to
4 MiB. Its failure fails the job and keeps the polling chain alive.

Only successful applying passes save state, under a name tied to the built
commit, restored only from this workflow's own default-branch runs in this
repository. Dry runs neither restore nor publish that trusted state, so a
concurrent preview cannot replace an actor's cached observations.

### Cutover comparison (#598)

On 15 October 2026, a read-only capture of the open followed PRs (including
every scheduler target) was replayed through tracker `4b87977`'s `decide` and
agent-board `a35bf0411e451b149ff6483f137c0b0a874b492c`'s `decide` and
`classify_checks`, with the same pull, rules, comments, fix/review run responses
and timestamp for each. All eight actions agreed: agentic-job#528 and #144,
agent-board#51 and #45, and agenthome#1 skipped; tracker#601, actions#36 and
agenthome#6 waited. No writes were made.

The reason differences were intentional: existing auto-merge takes precedence
over a conflict on agentic-job#528; agent-board#45 reports auto-merge rather
than the old combined queue/auto-merge reason. tracker#601 and actions#36 had
a failed legacy review status and a running fix marker, but no authenticated
review of the head: both wait, now for that review rather than for the fix.
agenthome#6 likewise waits for a head review, not a status. All other reasons
matched. The old actor and its decision tests are retired; agent-board owns
the review/merge policy tests, and this repository tests the adapter and workflow.

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
[job plan](https://github.com/cgwalters-forge/agent-board/blob/main/docs/job-plans.md);
without a plan it is skipped as `no plan`, and a plan of another kind is left
to be dispatched by hand, since the bot that posts a run's comments is an
accepted planner and one run must not start the next. Umbrellas
(issues with sub-issues), issues labelled `epic` or `question`, and the configured
coordinator status issue are skipped. GitHub closing references to a merged PR
are reported as "probably done by OWNER/REPO#N; close it?" rather than dispatched.
Open closing PRs and PR cross-references from the same organization stop a
dispatch as `PR open: OWNER/REPO#N`, regardless of author. A merged
cross-reference counts as probably done only when a line of its body starting
`Refs`, `Implements` or a closing keyword names the issue: a PR that only mentions it, such as the
one whose run filed it as a follow-up, does not. Closed, unmerged PRs do not count.

`schedule.triage` (0 to 5; 0, off, if unset) turns those two guesses,
probably done and `no plan`, into questions rather than skips that stall the
board ([#636](https://github.com/cgwalters-forge/tracker/issues/636)). Each
pass asks at most that many: an item gets one `kind: triage` run (on
`schedule.triagePool`, `coordinator.planPool` if unset, taking a slot) that compares the issue with the
candidate PR and later merged ones and answers in a `schedule-triage` block:
done (the next pass closes the issue, linking the answer), partly or not done
(with an implement plan for what is left, which is then dispatched as any plan),
or needs design. A `no plan` item whose body has under 200 non-space
characters gets no run, only a needs-design record. A bot comment records each
question before the run starts, so it is asked once; unanswered, needs-design
and answered items without a plan are then counted but not listed on each pass,
until an unanswered question is a day old. Delete the record to ask again; a
needs-design one lapses when the body changes. Only the bot's or the operator's
comments count as records or answers, so a visitor cannot close an issue; an
issue reopened after the scheduler closed it goes on as not done. When a pass
starts nothing with slots free under `schedule.wip`, its last line is `idle:`
with the count of items skipped for each reason.
Native open dependencies, board Status `Blocked`, and explicit `blocked by`,
`depends on`, or `waiting on/for` references in the issue body or accepted job
plan brief stop work as `blocked by`. Closed prerequisites do not block.
An explicit `Branch: NAME` in the brief is checked against open PR heads and
existing branches in the target repository, to avoid repeating planned work.
These checks
also apply to a plan's target; unreadable or incomplete metadata skips the item.
Each metadata query reads at most 100 labels, closing references,
cross-reference events, native dependencies and board memberships, refusing
incomplete pages. Target board holds are checked even outside the candidate list.
Text checks read at most ten distinct dependencies and ten explicit branches.
An item is skipped
while a `dispatch.yml` run for it, or for the item its plan targets, is in
flight or a pull request of the bot says `Refs` to it; while its plan has a
dispatch record (agent-board's, by this job or by hand; a writer edits or
replaces the plan to dispatch again). Items of unlisted repositories, upstream ones
among them, are skipped as "not a followed repository", as is a plan whose
target is in one: upstream work is the operator's to start.

`schedule.retries` (0 to 2; 0, off, if unset) acts on what a recorded plan's
run did instead of skipping it as dispatched already for ever
([#645](https://github.com/cgwalters-forge/tracker/issues/645)). The run is
the one the record links, and its result is agentic-job's status comment for
that run on the run's target: only the bot's (or, on this repository, the
job token's), and only its own text of a run that ended well, not the
agent's quoted reason or a check's refusal, may name the pull request, which
must be the bot's. A cancelled run keeps the old skip. A merged pull request closes the
issue with a comment linking it (an issue reopened after that is left
alone); one whose body says `Part of` is a triage question instead, with
`schedule.triage` on. An open one is skipped as `PR open`; one closed unmerged
is left to a person. A run that failed or ended without a pull request is
dispatched again, alone, with the status in its brief: the scheduler posts a
record of the same plan with a `schedule-retry` line, removes the old
record's marker and starts the run, at most `schedule.retries` times; then
the issue is labelled `needs-human`, which the scheduler skips. A run that
handed back missing data naming an issue of a followed repository gets that
issue as a native blocked-by link (a pull request is only waited on), and the
plan runs again once it closes. A record without a run link, a batched
extra's, and a run whose status comment a later run replaced keep the old
skip. Editing or replacing the plan starts the attempts again. The idle line
also counts the recorded runs by outcome.

`schedule.operatorRetryPools` (empty, off, if unset) keeps an operator's
request from being dropped when its run fails
([#792](https://github.com/cgwalters-forge/tracker/issues/792)). Each pass,
before the census, it reads the newest dispatch runs. When the newest run on
one of agent-board's `OWNER/REPO#N: operator request` issues here (open, and
opened by the bot) is a failed triage or research run, the scheduler
records an `operator-retry` line on the issue and runs it again once, on the
first listed pool that is not the failed run's. If the retry fails too, if no
other pool is listed, or if an hour after its record no newer run is listed,
the issue is labelled `needs-human` instead. A pass
reads at most ten such issues and takes at most three steps.

`schedule.fill` (0 to 20; 0, off, if unset; needs `schedule.triage`) fills
slots the epics leave free while the pool is under its pace
([#672](https://github.com/cgwalters-forge/tracker/issues/672)). The pace is
the usage snapshot below, for `coordinator.planPool`: fill mode is its paced
window's used share below the pace the usage job holds it to (its target of
the share of that window gone), and is off when the
snapshot is missing or over three hours old, its reading of the pool was
observed over a day ago (30 hours, as the coordinator's daily planning run renews it; with no epic to plan, fill mode stays off until some run does), or it holds the pool. In fill mode the
pass also takes up to `schedule.fill` open issues of the scheduled
repositories, after every epic sub-issue, by board priority, then age: only
issues the operator or the bot opened (in a public repository a stranger's
would spend the pool), on the board (so that no control issue, such as the
supervisor's requests or a broker outage, is closed by a triage answer), with
no parent, not an epic or the coordinator's status issue, and no `epic`,
`question`, `needs-human` or `needs-design` label. Only the 100 oldest
open issues of each repository are read, and the first `schedule.fill` are
taken whether or not they can move, so one held in a skip, such as a triage
answer of needs design, keeps its place until it is labelled. Each gets the checks a sub-issue gets (an open pull request or a
dispatched plan skips it), and is asked of a triage run first, within the
`schedule.triage` budget, so a stale one is closed; its plan is dispatched once
the run answers not done. A triage or research plan is dispatched in fill mode
too, alone and out of the same per-pass budget, instead of being left to a
person. The coordinator's minimum planning interval is at most an hour in fill
mode. The pass prints `mode: fill (...)` or `mode: normal (...)` with the
figures, and its last line says it, as `idle: ...` or `filled: N of M free
slot(s)`.

`schedule.batch` (0 to 5; 0, off, if unset) is passed as agent-board's
`dispatch --batch N`, so one implement run and its pull request also do up to
N small sibling sub-issues that have their own accepted plans
([batching](https://github.com/cgwalters-forge/agent-board/blob/main/docs/job-plans.md#batching)).
Each extra the dry run names gets the checks its item had (runs, bot pull
requests, board Status `Blocked`, eligibility); if one fails, the item runs
alone, without `--batch`. Only the item's own part of a batched brief is read
for its dependencies. The issues a run batches are held for the rest of the pass, and an extra's
record is released by agent-board's rule: once its batch's primary issue is
closed and no open pull request closes it, it may be scheduled again. A bot
pull request holds every issue it `Refs` or closes, and the coordinator's
status names a batched pull request once, with its issues.

Candidates are taken by their epic's board field `schedule.priorityField`
(default `Priority`), then by their own, which the coordinator sets, P0 first,
then oldest first; a sub-issue of two epics is taken once, from the one that
ranks it first. An epic the census cannot read in full gives no candidates
and fails the pass, after the rest is done, so that a board the token cannot
read is not taken for one with no live epics; so do open epics past the
census's 50. Who added a sub-issue to a live epic is not checked. No step
starts once `schedule.wip` runs of `dispatch.yml`, of any kind, are in
flight; fix runs the poll job starts in the same pass count from the next.
Every candidate in the bounded census can be probed, so unplanned items cannot
starve plans farther down, and each step is taken as it is decided, so a pass
the job's timeout stops has still started the plans ranked first. Each line
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
operator's comments ask for revisions. While it has no `epic` label it is a
plan under review: the census does not read it, so neither the coordinator
nor the scheduler, fill mode included, touches it. The operator adding `epic`
is the approval; as for any epic, only the configured operator's label
counts. The coordinator then removes `needs-human` and plans it: the slices
become sub-issues, the example contract the first where there is one, and the
scheduler runs them as for any epic.

### Supervisor

`supervisor.yml` runs `agent-board supervise health` every fifteen minutes on the default
branch. GitHub's cron started one run in two hours on 17 Oct (#730), so, like
the poll, it also starts at the end of each poll run, and each non-dry poll
pass dispatches it without a prompt, since self-dispatched passes raise no
`workflow_run` (#763). `.github/poll/supervisor-due.cjs` paces both from the
`times.json` the previous `supervisor-health` artifact carries: a poll-started
run within fifteen minutes of the last health pass ends before the build, and
a pass sweeps when the last sweep was two hours ago or more. The crons remain
as a fallback; they and explicit requests (a prompt or a comment) are not
rate-limited. A dispatch without a prompt, by hand too, is paced as a
poll-started run. Scheduled runs used to be skipped: the job also required the
repository variable `SUPERVISOR=observe`, which was never set. The health pass
only reads, so it now always runs. `health.json` is a list of checks
with `id`, `status` (`ok`, `warn`, `fail`), evidence links and a suggested
action; each check also has one summary line. All thresholds and collection
bounds are in `.github/supervisor/config.json`, with repository identities
in that file and the existing poll configuration, never dispatcher inputs.

The health step reads with the bot's token (`CGWALTERS_BOT_PAT`), as the execute
job and the poll do. The usage snapshot (`pace`) is on a private repository,
`.github/usage/config.json`'s, which the job token cannot read, and the job
token's 1000 requests an hour come near four passes' worth. The step runs
only agent-board built from the pinned revision, never an agent or pull
request code (the operator, 17 Oct: the same token as everything else of the
bot's, rather than a separate read-only one). Missing access and truncated listings are warnings, not
healthy observations, and fail once they have lasted
`unavailableFailHours`: each pass reads the previous pass's `health.json`
artifact for since when. API requests have deadlines and a total
budget and a seven-minute collection deadline; the health step has an eight-minute
limit, within a 25-minute job that also builds agent-board afresh using
`just build-agent-board` at the commit pinned as `AGENT_BOARD_REV` in
`supervisor.yml`, which the `execute` job builds too. Unlike `poll.yml`, it
never follows agent-board's branch: the executor receives the bot's token, so
a change to agent-board reaches it only when that pin moves here, after review. The newest health artifact among
the last five completed runs is restored with a two-minute bound and passed as `--previous`;
a missing or unreadable report starts unavailable timers afresh.
These bounds prevent a stalled API or
oversized census from exhausting a runner. The JSON artifact contains links
and fixed actions, not issue bodies, titles, private decisions or logs.

The pass reuses the epic census and authenticated coordinator checkpoints.
Recent PR/queue activity is every PR updated within `eventLookbackHours`,
up to `maxPages` GraphQL pages per followed repository; it is not a
historical audit. A removal from the queue because the PR merged is not
counted. Infrastructure findings
are warnings from probe/label time overlap, not proof that a retry is safe.
A broker probe switched off (`BROKER_OUTAGE` unset) is no observation: a warning that fails after an hour.
Decisions currently cover open public question issues assigned to the operator,
excluding ones with an authenticated operator reply; the private decision
document is not published or interpreted. Loop detection uses checkpoint
failures and pending-operation staleness, not speculative interpretation of agent prose.

The checks the controller ran by hand: `idle`, the board job's log of the
last `idlePasses` scheduler passes each ending `idle: N slot(s) free and
nothing started`; `stuck`, a plan the latest pass skipped as dispatched
already whose recorded run ended with its PR (the branch
`implementBranchPrefix` names after the run) merged or none; `pace`, a
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
on the locked requests issue (#656). The comment gate also rejects PR comments;
the login and issue are checked against trusted config in tests. The requests
issue must be locked by the operator before comment wakes work.

```sh
gh workflow run supervisor.yml -R cgwalters-forge/tracker \
  -f prompt="close what triage found done in agent-board"
```

A check that cannot clear fails every pass and so started an agent every
cooldown hour to read the same report (#804). With
`agent.skipUnchangedFailures` set to true (it ships false),
`.github/poll/supervisor-repeat.cjs` leaves the trigger out of a pass that
is not a sweep or request when no check fails that did not fail in the
previous report; the sweep reads standing failures and their new evidence.
A failure that first appeared while the trigger declined (cooldown, an
active agent) also waits for a sweep.

Comments, prompts and the sweep share workflow-wide `supervisor-agent`
concurrency without cancelling an active run, so a request waits through the
previous executor instead of the trigger discarding it. The fifteen-minute
health passes, poll-started ones included, use `supervisor-health`: GitHub retains only one pending run per
group and a newer arrival replaces it, so a shared group would let the next
pass evict a queued prompt. A health pass that finds an agent active declines
and retries after its cooldown; a prompt the trigger declines fails its run.
The executor keeps its own `supervisor-execute` group. A second prompt queued
behind a pending one still replaces it, so use the requests issue for durable
requests and steering an active agent.
The agent is a `research` run
of the shared wrapper, using `agent.pool` and the wrapper's read-only job
token, not the bot token. Its task includes the pinned agenthome supervisor
profile and skill, agent-board's policy and this pass's health report. It also
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
that would pass a daily cap is rejected whole. Missing state is reported,
never guessed.

The `execute` job holds `CGWALTERS_BOT_PAT` in the `agent-apply`
environment and runs no agent code. It executes only on a run's first
attempt, and accepts only the bot's comment, unedited, on the requests
issue that this run's apply reports. It validates the whole
batch with `agent-board supervise execute`. The shared executor admits
dispatches, with fixed briefs and reasons, on open issues whoever wrote them,
and an implement dispatch only under an open `epic`-labeled parent. The
boundary against an injected request is the run's sandbox and the required
pull request review, not collaborator-only input (agent-board#158). That
review is a model's verdict (`review.yml`), and the poll merges an approved,
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
Test the workflow wiring with `just test-poll` (set `AGENT_BOARD` to a built
binary for the shipped-config CLI test); policy tests live in agent-board.
CI builds that binary from the supervisor workflow's exact pin with
`just build-supervisor-agent-board`. The CLI test uses empty health checks,
without `--daily`, to validate settings and executor policy without API calls
or writes, and checks that an invalid status-update cap is refused.

The agent cannot read the private decisions document (its token reads only
this repository), and the review site's last-run panel is
cgwalters-forge/review's to build; both are left from #626.

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
can expand its repository or Priority bounds. The allowed Priority options,
and the project and field IDs, are read from the configured project
(`schedule.project`, `schedule.priorityField`) when an epic is planned or
previewed, never from a plan; the brief names them as the only values. New
sub-issues start at the field's last option.
A plan that `agent-board epic apply --dry-run` refuses (stderr
`error: newest epic plan URL: ...`, URL being the matched plan) fails that epic only: it is cleared,
counted toward `coordinator.maxFailedRuns` like a run that posted no plan, and
its refusal (capped at 2000 characters) is quoted in the next brief, and the
pass goes on to the next epic. Other agent-board failures leave the plan
pending, uncounted, for the next pass. Every epic error is counted and logged
with its issue, without preventing the next epic from getting its turn.

At most one live epic per pass gets a planning run or an apply preview that
is not refused. Planning is
`kind=triage`, with the epic's census facts and only authenticated operator
comments as decisions. Its one comment carries an `agent-board-epic-plan`.
`coordinator.planPool` in `agent-board.json` defaults to `claude`: epic
planning must not inherit the triage toil pool.
A later pass invokes `agent-board epic apply --dry-run`, then `--apply` only
with `COORDINATOR=apply`. Both calls pin the matched JSON request, comment ID
and `updated_at`, preventing a newer or edited plan from substituting actions
between reads. Exit 3 leaves the epic pending without counting a failure, so
the next pass re-checks it. Success checkpoints the checked fingerprint, not
a fresh census that might hide concurrent operator changes.
An already-claimed response triggers a fresh bounded census, never a replay.
Recovery requires each create's title to identify exactly one distinct child in
the planned repository, with the expected body, requested labels and job plan,
enrolled with the planned (or default) Priority, each
close to be closed, each rescope body to match, and each Priority write to match.
Missing or ambiguous effects retain pending and are named in the error. A full
match checkpoints `pending: null, reconcile: true` just like a successful apply.
Plan pinning does not guard concurrent epic-intent or child-body edits at the
mutation boundary; that still requires upstream observation preconditions.
Ordering is only Priority, with no Ready step.
Epics are selected by Priority (P0 first, as the scheduler ranks them), then issue number.
An approved plan (see Plans for review above), a live epic assigned to the
operator whose `needs-human` label is older than the operator's `epic`
label, loses `needs-human` in the pass that dispatches its planning run, and
not before; a preview logs `approved: would remove needs-human`. A
`needs-human` the operator adds to a live epic later is left alone.
Changed intent, sub-issue text or board facts trigger planning; the decision
logic also forces a daily pass after a completed applied checkpoint. Pending
plans do not get additional daily runs. The coordinator fingerprints content rather than
the epic's `updated_at`, so its own comments do not start another plan.
Results carry a unique `request` in their fenced JSON (not a plain-text line
or hidden HTML marker). Plans use the optional `agent-board-epic-plan` field;
the poll builds the configured agent-board branch head, which includes #77's pinned apply,
so no release upgrade is needed. Status blocks contain exactly
`{"request":"<id>","prose":"..."}`, with prose of 1 to 4000 characters.
Only an exact request match from a trusted writer at or after the pending
timestamp counts;
an obsolete run must finish before its request is replaced,
and a matching result hidden behind a newer writer's plan is not applied.
Pending runs briefed with the old line fail once and retry normally; no
checkpoints need resetting.

Reporting uses the same triage/checkpoint mechanism on
`coordinator.statusIssue` in the epic repository. Its `coordinator.statusPool`
is configured as `openai` (the fallback remains `mistral`). The status brief
requires writing only from the supplied facts, without reading the repository.
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
Status prose is Markdown, normally limited to eight lines and 2,000 characters: a
plain link to the configured `coordinator.reviewUrl` Decisions page (no count, as
the status cannot see every source Decisions merges), one line per live epic with health, merges and blockers,
optional linked failure clusters, and one linked pool usage line. Larger censuses
get one line per live or unread epic plus three, at most the census's 50 epics
plus three lines, with 300
additional characters per extra line (15,500 maximum); unread epics
must be identified as unavailable. Decisions
remain the live list, not repeated asks in the status. Activity is sampled
(30 runs, five recently updated PRs per repository, ten blockers per epic), not
exhaustive history. Usage is marked stale after three hours by the snapshot's
`updated_at`; missing or invalid timestamps are stale too.
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

Each non-dry `poll` pass explicitly dispatches `.github/workflows/usage.yml`,
even when idle and not starting a successor. Job-token-started polls cannot
rely on `workflow_run` to start the publisher; that trigger remains for other
completed polls, with a fifteen-minute cron fallback and manual dispatch. It publishes the
`bot-usage/v1` snapshot that the review app's pool meters read: one comment by
the bot, edited in place, on the issue `.github/usage/config.json` names, in a
repository GitHub must say is private. Before joining, it reads the configured
bot's comment (the first 100 comments only) and skips publication when every
paced pool's `observed_at` is less than ten minutes old. Missing, malformed,
future or stale observations cause a publish attempt. Runs remain serialized.
It joins the tailnet as the agent job
does and reads the inference broker's `/usage` (the variable `INFERENCE_URL`,
else the organization's tailnet setting). It holds the claude and openai pools,
paced as homegit's frozen `bin/bot-capacity` paced them (the config's `pacing`), but
read from the windows the broker sees in the providers' answers: claude's is
therefore the account as the broker sees it, not Claude Code's status line on
a machine. Mistral has its counters and the monthly allowance of
`.github/agentic-job/pools.json`, with this month's tokens and the
allowance's `prices` (USD per million tokens, by model) when those are
configured, for the review app's estimate of the spend. Mistral's counters are
observed when `/usage` is fetched, not subscription usage from a provider billing API.
Claude's `unified_7d` utilization and absolute reset are response headers;
OpenAI's `secondary` used percentage, window length and reset-after seconds
are response headers too (reset-after is relative to that header's observation,
not the publisher's clock). The broker does not poll the providers when `/usage`
is fetched. Thus successful publisher runs need not mean fresh provider data.
Each weekly meter uses that window's `observed_at`, never a newer short
window's timestamp; `computed_at` dates the pace calculation. Pace is recomputed
from the window start (reset minus duration) on every publication.
A broker it cannot read fails the run and
leaves the last snapshot, and its time, as they were. The broker keeps its
readings in memory, so after a restart it has none until a run goes through
it: a pool without a reading keeps the last one published, with its own
time, until that window resets, and is null after it, never the old comment's
hold. A reset does not prove zero usage: until a new provider header arrives
the pool is unknown, not zero. Fresh Mistral counters are published even if
both subscription pools are unknown. Consumers must accept this case and use
each pool's observation time for staleness, not the envelope's `updated_at`.
The existing fifteen-minute schedule bounds normal publication delay after
a reset to one tick; GitHub may delay or drop scheduled runs, so this is not
an hourly delivery guarantee or an exact reset-time wakeup.
There is no operator-machine credential or status-line reader in this hosted
path. Machine-only readings must stay out of it. Live provider refresh needs
a broker-side source; the review site's null-pool handling and staleness logic
live outside this repository. `just publish-usage --dry-run` prints the comment
(without carrying anything over); test with `just test-usage`.

## The release train

`.github/workflows/release-train.yml` cuts agentic-job's releases and moves
the pins after them (#650), in the order the controller did by hand: the
version bump PR, `release.yml` once it merges, the pin bump of the actions
wrappers once the release is out, then the `review.yml` pin bumps of the
callers once that merges. The repositories, files, threshold and labels are
in `.github/release-train/config.json`. A release is due when at least
`threshold` PRs merged since the last one and that was `intervalHours` ago,
or at once when one of them is labelled `P0`; the bump is minor if one is
labelled `breaking`, a patch otherwise. A release cut outside the train,
by hand or by anyone, is followed all the same (#723): when the wrappers
pin an older version than the latest release, a pass opens a train for that
release starting at the wrappers' pin bump, unless a train for it was
closed or its tag is not on agentic-job's default branch. The PRs come from the bot's forks
with the release notes for the callers' interface changes, and go through
each repository's review and queue; the train only waits for them.

Each non-dry poll pass also dispatches the train on the default branch when
enabled, so a delayed or dropped hourly cron does not strand a due release.
The dispatch has a one-minute bound and failure does not stop the poll;
the train serializes passes and checks whether work is due without a build
or tailnet join. The hourly cron remains a fallback.

It is off unless the repository variable `RELEASE_TRAIN` is `dry-run`,
which prints each pass's step, or `apply`, which takes it with
`CGWALTERS_BOT_PAT`: that token needs to open issues here, push to the bot's
forks (named in the configuration: a fork need not share its parent's name)
with the workflows permission, as the pins are in workflow files, open PRs
upstream and run agentic-job's `release.yml`. Each release
has one tracking issue here, opened by the bot and labelled
`release-train`, with a comment per step. A step it cannot take (a PR closed
unmerged, a failed `release.yml`, a file whose pin it cannot find) labels
the issue `needs-human`, which halts the train until the label goes; closing
the issue drops that release: a later train for the same version ignores
its closed PRs, halts on one still open, and does not start while main has
a version bump that was never released. Test with `just test-release-train`;
`just release-train` is a dry pass with the token in `GH_TOKEN`.
