# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the scripts under .github.
test: test-poll test-session test-config

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

# Validate against the actor that will consume the config, not a moving head.
build-supervisor-agent-board:
    rev=$(node -e 'const fs = require("node:fs"); const text = fs.readFileSync(".github/workflows/supervisor.yml", "utf8"); const pins = [...text.matchAll(/^  AGENT_BOARD_REV: ([0-9a-f]{40})$/gm)]; if (pins.length !== 1) throw Error("expected one supervisor pin"); process.stdout.write(pins[0][1]);') && {{ just_executable() }} build-agent-board "$rev"

# Without a revision, the configured branch's head; poll.yml and supervisor.yml
# pass a pinned commit so the program that holds the bot's token is the reviewed one.
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

# The shared workflow check that ci.yml's lint job calls, run locally from
# a checkout of the forge's actions repository (its lint/README.md), the
# path relative to this repository's root; CONTAINER=podman without docker:
#   just lint ../actions
lint actions:
    {{ just_executable() }} --justfile "{{ actions }}/lint/Justfile" --working-directory . check
