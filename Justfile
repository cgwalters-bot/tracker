# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the scripts under .github.
test: test-poll test-usage test-session test-tools

test-tools:
    node --test .github/agentic-job/tools.test.cjs

test-session:
    node --test .github/agentic-job/session.test.cjs

session-profile:
    node .github/agentic-job/session.cjs

test-poll:
    cd .github/poll && node --test

coordinator *args:
    node .github/poll/coordinator.cjs "$@"

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
