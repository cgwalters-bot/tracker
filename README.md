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
cgwalters-forge/agentic-job and cgwalters-forge/agent-board and takes at most
one step for each:

- a draft with no failed check is marked ready for review, which is what
  starts the event review;
- a head whose `review` status is a failure, or with a failed required check,
  gets one `fix` run of `dispatch.yml`, its task carrying the review comment
  and the failed job's name and log link, at most once per head and twice per
  pull request. The task asks for the fix folded into the commit it corrects,
  which `replacement_max_commits` in `.github/agentic-job/fix.toml` lets the
  run push as a rewrite of the branch;
- a head that conflicts with its base, approved or not, gets the same `fix`
  run, counted in the same rounds, its task asking for the commits rebased
  onto the current base and pushed as that rewrite, with no commit on top;
- a head with `review` success and its required checks green gets auto-merge
  (or the merge queue; a plain rebase merge where the repository has neither),
  once GitHub says it is mergeable: while that is unknown, as it is for a
  while after a push, the pass does nothing and the next one looks again;
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
does not read the board, start work for an item that has no pull request, or
follow pull requests in repositories we cannot write to. A pass that fails
part way is repeated five minutes later. Test with `node --test .github/poll/poll.test.cjs`.
