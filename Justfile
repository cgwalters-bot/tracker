# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the scripts under .github.
test: test-poll test-usage test-session test-tools test-config test-supervisor test-release-train

test-supervisor:
    node --test .github/supervisor/*.test.cjs

supervisor:
    node .github/supervisor/health.cjs

test-release-train:
    node --test .github/release-train/*.test.cjs

# One pass of the release train (release-train.yml); without --apply it
# prints the step it would take. GH_TOKEN is the bot's token.
release-train *args:
    node .github/release-train/train.cjs "$@"

# After `supervisor`: whether the agent runs, from health.json (supervisor.yml).
supervisor-trigger:
    node .github/supervisor/trigger.cjs

# Performs the agent's validated requests; GH_TOKEN is the bot's, RESULT_URL
# the agent's comment.
supervisor-execute:
    node .github/supervisor/execute.cjs

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

build-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    source=$(jq -er .source .github/poll/agent-board.json)
    branch=$(jq -er .branch .github/poll/agent-board.json)
    rev=$(git ls-remote --exit-code "$source" "refs/heads/$branch" | cut -f1)
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
