# Bringing up a coordinator

The coordinator is the session that picks work from the
[board](https://github.com/orgs/cgwalters-forge/projects/1) and dispatches
it. This page is how to start one on a machine that holds nothing but
credentials: everything else it needs is on the forge, and what is not yet
is listed at the end.

## What to clone

Two repositories. [cgwalters-bot/homegit](https://github.com/cgwalters-bot/homegit)
has the tools (`bin/bot-runs`, `bin/bot-board`, `bin/bot-git`), by
convention at `~/src/github/cgwalters-bot/homegit`. This repository has the
dispatch workflow, the bounds and per-kind profiles under
`.github/agentic-job`, the pull request poll, the operator's instructions
([operator-notes.md](operator-notes.md)) and this page. Read the notes
before dispatching anything: briefs and decisions are checked against them,
and a new instruction is appended there, verbatim and dated, in a pull
request. The wrapper every run goes through,
[cgwalters-forge/actions](https://github.com/cgwalters-forge/actions), and
[cgwalters-forge/agentic-job](https://github.com/cgwalters-forge/agentic-job)
are pinned by commit in `.github/workflows/dispatch.yml` and need no clone.

## Credentials and settings

On the machine, two files, neither of them in any repository. The bot
account's token is in a file of its own, and `~/.config/bot-supervisor.env`
names that file in `BOT_SUPERVISOR_GH_TOKEN_FILE`. Every shell starts the
same way, and never prints the token:

```sh
cd ~/src/github/cgwalters-bot/homegit
set -a; . ~/.config/bot-supervisor.env; set +a
export GH_TOKEN="$(cat "$BOT_SUPERVISOR_GH_TOKEN_FILE")"
```

On the forge, already in place and only to be checked: the organization
secret `CGWALTERS_BOT_PAT`, which apply and the poll act with, and the
environment `agent-apply` here, which gates apply. The wrapper has a
default for each deployment setting, and this repository's variables
override them: `AGENT`, `AGENT_MODEL`, `INFERENCE_URL`,
`INFERENCE_AUDIENCE`, `AGENT_RUNNER`, `AGENT_CONFIG_REPO` and
`AGENT_CONFIG_PATH`. `gh variable list -R cgwalters-forge/tracker` and
`gh secret list -o cgwalters-forge` show the names; the secret's value is
cgwalters' to store, and the bot never copies or prints it. The inference
proxy and the tailnet the runs join are a host of his, with its own policy,
and are not brought up from here.

## Dispatching a run

Write the sentences particular to the task in a file and name the target:

```sh
bin/bot-runs dispatch --backend agentic-job --caller cgwalters-forge/tracker \
    --repo OWNER/REPO --item N --kind KIND BRIEFFILE
```

`KIND` is implement, review, fix, triage or research; `N` is an issue, or a
pull request for review and fix; `OWNER/REPO` must be listed in
`.github/agentic-job/dispatch.toml` (`fix.toml` for a fix). The standing
instructions of each kind are not part of the brief: `dispatch.yml` puts
`.github/agentic-job/profiles/KIND.md` before it, so they change by a pull
request here and a brief says only what this item needs. An implement run
with `claude` or `opencode` also gets agentic-job's skills (its
`docs/skills.md`): its implement skill carries the procedure, the
self-review with a subagent included, and `profiles/implement.md` only
what is ours. `vibe` gets no skills, so an implement that would run it,
from the pool or the variable `AGENT`, fails before it starts. Fix has no
skill yet and keeps its full profile. `dispatch.yml` also takes an
optional `pool` input, `claude`, `openai` or `mistral`, which
`.github/agentic-job/pools.json` maps to a fixed agent and model (`claude`
with `claude-opus-5-5`, `opencode` with `praxis/gpt-6.1-sol`, `vibe` with
`zai-glm-5-3`) and a run budget in AIC, hundredths of a dollar
(`budget`); left empty, the repository variables `AGENT` and `AGENT_MODEL`
apply. Any other value fails the run before it starts. A pool may also say
what its provider allows a period, for tools to pace runs against where the
provider reports no quota: `allowance` is `amount` in `currency` per
`period`, which is `calendar-month` (`mistral`: 300 USD). Nothing in this
repository enforces it. The poll alternates its fix rounds between the
first two, except that a first round that is only toil goes to `mistral`;
`mistral` is for toil such as triage. The run applies
its own result: a pull request from the bot's fork, or one comment on the
item. `scripts/wait-run RUN` waits for a run and prints its conclusion and
failed jobs.

## What is in flight

Nothing has to be remembered by the coordinator. The runs themselves are
`gh run list -R cgwalters-forge/tracker` (the run name is the kind and the
item). What they opened is the bot's open pull requests on `dispatch/`
branches, `gh pr list -R OWNER/REPO --author cgwalters-bot`, in each
repository the bounds name. Where each of those stands, its fix rounds and
the run working on it, is in the one comment the poll keeps on the pull
request (it carries a `tracker-poll` marker); `needs-human` labels the ones
the poll gave up on. The README describes the poll.

## Where state lives

The board holds what is to be done and whose turn it is, and questions for
cgwalters are issues here. Each pull request's progress is in the poll's
marker comment and each run's in its status comment on the item. This
repository holds the workflows, bounds, profiles and the operator's notes,
and `docs/rulesets/` keeps snapshots of our repositories' rulesets, named
by repository, taken before changing them. To put one back, look up the
ruleset's id with `gh api repos/OWNER/REPO/rulesets` and run
`jq '{name, target, enforcement, conditions, rules, bypass_actors}' FILE | gh api -X PUT repos/OWNER/REPO/rulesets/ID --input -`
(`-X POST repos/OWNER/REPO/rulesets` where it no longer exists).

## Still only on the machine

Credentials, by design: the token file, the environment file and the
broker's policy on the inference host. The coordinator session itself,
which is a chat on one machine; what it knows that matters is supposed to
be on the board or in the notes, and anything that is not is lost with it.
And the loop that watches for cgwalters' comments on active issues and
wakes the coordinator: it is not yet on the forge. It is a loop on the
coordinator's machine, so on a fresh one nothing notices an answer until
the coordinator looks for itself; the plan in
[#507](https://github.com/cgwalters-forge/tracker/issues/507) is a
workflow here on `issue_comment`.
