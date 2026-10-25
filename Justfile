# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-config test-supervisor-config test-review-gate

# Whether the effective rules of a branch, GitHub's
# `repos/OWNER/REPO/rules/branches/BRANCH` response on stdin, hold what the
# `[unprotected_files]` bounds in dispatch.toml rest on: one pull_request
# rule requiring an approval and dismissing stale approvals on push. Any one
# rule is enough, as rulesets add up (review's own requires none; the org's
# does), but both must be on the same rule. Anything but an array fails.
review-gate:
    @jq -e 'type == "array" and any(.[]; .type == "pull_request" and .parameters.required_approving_review_count >= 1 and .parameters.dismiss_stale_reviews_on_push == true)' > /dev/null

# review-gate on each fixture under .github/ruleset-check, which must
# pass if its name starts with pass- and fail otherwise.
test-review-gate:
    #!/usr/bin/env bash
    set -euo pipefail
    for f in .github/ruleset-check/*.json; do
      want=fail; [[ $(basename "$f") == pass-* ]] && want=pass
      got=fail; {{ just_executable() }} review-gate < "$f" 2>/dev/null && got=pass
      [[ $got == "$want" ]] || { echo "$f: want $want, got $got" >&2; exit 1; }
      echo "ok $f ($want)"
    done

# review-gate on the default branch of every repository in
# unprotected_files.repos (ruleset-check.yml). A repository that fails it,
# or whose rules cannot be read, gets a ::error with the pull_request rules
# found and is listed in the step output `failed`; then the recipe fails.
check-review-gate:
    #!/usr/bin/env bash
    set -euo pipefail
    repos=$(python3 -c 'import sys, tomllib; print(*tomllib.load(open(sys.argv[1], "rb"))["unprotected_files"]["repos"])' .github/agentic-job/dispatch.toml)
    failed=()
    for repo in $repos; do
      rules=
      if branch=$(gh api "repos/$repo" --jq .default_branch) &&
        rules=$(gh api --paginate "repos/$repo/rules/branches/$branch" | jq -cs add); then
        if {{ just_executable() }} review-gate <<< "$rules"; then echo "ok $repo"; continue; fi
        found=$(jq -c '[.[]? | select(.type == "pull_request") | {ruleset_id, ruleset_source} + (.parameters | {required_approving_review_count, dismiss_stale_reviews_on_push})]' <<< "$rules")
        echo "::error::$repo: no pull_request rule on $branch requires an approval and dismisses stale approvals on push; found $found"
      else
        echo "::error::$repo: could not read the rules of its default branch"
      fi
      failed+=("$repo")
    done
    echo "failed=${failed[*]}" >> "${GITHUB_OUTPUT:-/dev/null}"
    [[ ${#failed[@]} -eq 0 ]]

# Runs `agentic-job config` on acp-experiment.toml where it is installed.
test-config:
    node --test .github/agentic-job/config.test.cjs

# The shipped supervisor settings through the binary supervisor.yml pins
# (AGENT_BOARD, from build-supervisor-agent-board): a cap the executor
# refuses would otherwise fail every pass after the merge. Empty checks and
# no --daily return before any API request.
test-supervisor-config:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -z ${AGENT_BOARD:-} ]]; then echo 'skipped: set AGENT_BOARD to the built binary'; exit 0; fi
    health=$(mktemp)
    echo '[]' > "$health"
    out=$(GH_TOKEN=unused GITHUB_RUN_ID=1 \
      GITHUB_REPOSITORY=$(jq -er .agent.requests.repository .github/supervisor/config.json) \
      "$AGENT_BOARD" supervise trigger --config .github/poll/agent-board.json \
      --supervisor-config .github/supervisor/config.json --pools .github/agentic-job/pools.json --health "$health")
    [[ $out == act=false ]]

# Validate against the actor that will consume the config, not a moving head.
build-supervisor-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$(sed -n 's/^  AGENT_BOARD_REV: \([0-9a-f]\{40\}\)$/\1/p' .github/workflows/supervisor.yml)
    [[ $rev =~ ^[0-9a-f]{40}$ ]] || { echo 'expected one supervisor pin' >&2; exit 1; }
    {{ just_executable() }} build-agent-board "$rev"

# Without a revision, the configured branch's head; the workflows
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
