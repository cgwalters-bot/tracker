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
pull requests are only merged once approved and green. The required checks
are the base branch's ruleset's (every check, where it requires none). It
does not read the board or start work for an item that has no pull request
(the board scheduler below does), or follow pull requests in repositories we
cannot write to. A pass that fails
part way is repeated five minutes later. Test with `node --test .github/poll/poll.test.cjs`.

The same run's `agent-board` job previews the pass with `agent-board poll
--dry-run`, the poll that is to replace poll.cjs
([agent-board#40](https://github.com/cgwalters-forge/agent-board/issues/40)),
built at the head of the branch `.github/poll/agent-board.json` names and over the
repositories and logins it names: poll.cjs's, and this repository. Both
jobs write their lines to the run's summary, one under the other. It takes no
step and has only the job token, read-only; its state file is an artifact of
the last run that saved one. Its failure does not fail the run.

## The board scheduler

The same run's `board` job, `.github/poll/schedule.cjs`, starts new work from
the board. Each open issue whose Status is one of `schedule.ready` in
`.github/poll/agent-board.json`, in a repository `schedule.repositories` lists,
gets at most one step: `agent-board dispatch --apply` where it has an accepted
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

Items are taken by the board field `schedule.priorityField` (default
`Priority`), P0 first, then oldest first. No step starts once `schedule.wip`
runs of `dispatch.yml`, of any kind, are in flight; fix runs the poll job
starts in the same pass count from the next. No more than
`schedule.triagePerPass` (default 1) triage runs start in a pass, and once
that many have, the pass stops reading items after ten more fresh ones turn
out to have no plan, so a plan further down waits for a later pass. Each line
of the run's summary is one item and what was, or would be, done.

The board is read with one paged GraphQL query, not `agent-board item list`,
which reads every item's fields one request at a time. Each `agent-board`
call gets no stdin and is stopped after `schedule.timeoutSeconds` (default
120); one that fails puts its command line and the end of its stderr, tokens
masked, on the item's line.

It only previews, its lines marked `[dry-run]`, until the repository variable
`BOARD_DISPATCH` is `apply`. To compare its decisions with the runs still
started by hand, put a run's summary next to the dispatch runs started around
it, `gh run list -R cgwalters-forge/tracker -w dispatch.yml --json
displayTitle,createdAt`: run names are `KIND REPO#ITEM`, as the summary names
items. Test with `node --test .github/poll/schedule.test.cjs`.

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
