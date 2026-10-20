# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the scripts under .github.
test: test-poll test-usage test-session test-tools test-config test-release-train

test-release-train:
    node --test .github/release-train/*.test.cjs

# One pass of the release train (release-train.yml); without --apply it
# prints the step it would take. GH_TOKEN is the bot's token.
release-train *args:
    node .github/release-train/train.cjs "$@"

test-tools:
    node --test .github/agentic-job/tools.test.cjs

# Runs `agentic-job config` on acp-experiment.toml where it is installed.
test-config:
    node --test .github/agentic-job/config.test.cjs

test-session:
    node --test .github/agentic-job/session.test.cjs

session-profile:
    node .github/agentic-job/session.cjs

test-poll:
    cd .github/poll && node --test

broker-probe:
    node .github/poll/broker.cjs

coordinator *args:
    node .github/poll/coordinator.cjs "$@"

# Only a validated login can become a single-line Actions output.
comment-wake-config:
    jq -er '"operator=\(.operator | select(type == "string") | select(test("^[A-Za-z0-9][A-Za-z0-9-]{0,38}\\z")))"' .github/poll/agent-board.json >> "$GITHUB_OUTPUT"

poll *args:
    node .github/poll/poll.cjs "$@"

# Dispatch only the default branch's publisher in this repository.
refresh-usage:
    gh workflow run usage.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"

# Without a prompt: supervisor.yml paces it as a poll-chain start.
start-supervisor:
    gh workflow run supervisor.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"

# Reuse the release train's due check; poll.yml gates this on its existing opt-in.
start-release-train:
    gh workflow run release-train.yml --repo "$GITHUB_REPOSITORY" --ref "$DEFAULT_BRANCH"

# Validate against the actor that will consume the config, not a moving head.
build-supervisor-agent-board:
    rev=$(node -e 'const fs = require("node:fs"); const text = fs.readFileSync(".github/workflows/supervisor.yml", "utf8"); const pins = [...text.matchAll(/^  AGENT_BOARD_REV: ([0-9a-f]{40})$/gm)]; if (pins.length !== 1) throw Error("expected one supervisor pin"); process.stdout.write(pins[0][1]);') && {{ just_executable() }} build-agent-board "$rev"

# Without a revision, the configured branch's head; supervisor.yml passes a
# pinned commit so the program that holds the bot's token is the reviewed one.
build-agent-board rev="":
    #!/usr/bin/env bash
    set -euo pipefail
    source=$(jq -er .source .github/poll/agent-board.json)
    rev=${1:-}
    if [[ -z $rev ]]; then
      branch=$(jq -er .branch .github/poll/agent-board.json)
      rev=$(git ls-remote --exit-code "$source" "refs/heads/$branch" | cut -f1)
    fi
    [[ $rev =~ ^[0-9a-f]{40}$ ]]
    cargo install --locked --root "$RUNNER_TEMP/agent-board" --git "$source" --rev "$rev" agent-board
    echo "rev=$rev" >> "$GITHUB_OUTPUT"

test-usage:
    cd .github/usage && node --test

# Publish the usage snapshot (usage.yml): INFERENCE_URL names the broker,
# GH_TOKEN is the bot's token; --dry-run prints the comment instead.
publish-usage *args:
    node .github/usage/usage.cjs "$@"

# The shared workflow check that ci.yml's lint job calls, run locally from
# a checkout of the forge's actions repository (its lint/README.md), the
# path relative to this repository's root; CONTAINER=podman without docker:
#   just lint ../actions
lint actions:
    {{ just_executable() }} --justfile "{{ actions }}/lint/Justfile" --working-directory . check
