# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-config test-supervisor-config test-review-gate test-weekly-material agent-board-pin

# Exercise the actual release selection and body filters without API calls.
test-weekly-material:
    #!/usr/bin/env python3
    import json, os, pathlib, re, subprocess, tempfile

    workflow = pathlib.Path('.github/workflows/weekly-blog.yml').read_text()
    select = re.search(r"jq --arg repo .*? -c '\n(.*?)\n\s*'", workflow, re.S).group(1)
    compose = re.search(r"--slurpfile updates .*? '\n(.*?)\n\s*' >", workflow, re.S).group(1)
    since, until = '2026-10-18T18:00:00Z', '2026-10-25T18:00:00Z'

    def jq(program, values, data=None):
        args = ['jq', '-jn' if data is None else '-c']
        for key, value in values.items():
            args += ['--argjson', key, json.dumps(value)]
        result = subprocess.run(args + [program], input=json.dumps(data) if data is not None else None,
                                text=True, capture_output=True, check=True)
        return result.stdout

    def release(tag, published=since, **extra):
        return dict(tag_name=tag, name='Release ' + tag, html_url='https://github.com/example/tool/releases/tag/' + tag,
                    published_at=published, draft=False, **extra)

    data = [release('v0.6.3'), release('v0.6.4', '2026-10-24T18:00:00Z', prerelease=True),
            release('old', '2026-10-18T17:59:59Z'), release('next', until), release('unpublished', None)]
    data.append(dict(release('draft'), draft=True))
    selected = [json.loads(line) for line in jq(select, dict(repo='example/tool', since=since, until=until), data).splitlines()]
    assert [r['tag'] for r in selected] == ['v0.6.3', 'v0.6.4'], selected
    assert selected[0] == dict(repository='example/tool', tag='v0.6.3', name='Release v0.6.3',
                               url=data[0]['html_url'], published_at=since)

    start = workflow.index('          : > "$material/releases.jsonl"')
    collect = workflow[start:].split('          gh api graphql', 1)[0]
    mock = '''gh() {
      if [[ $2 == repos/*/releases* ]]; then
        [[ $2 == repos/cgwalters-forge/agentic-job/releases* ]] || return 91
        [[ $mode != api-failure ]] || return 92
        if [[ $mode == capped ]]; then jq -n '[range(100) | {draft:false, published_at:null}]';
        elif [[ $2 == *page=1 ]]; then jq -n --argjson r "$fixture" '[range(100) | $r]';
        else printf '[]'; fi
      elif [[ $2 == repos/cgwalters-forge/agentic-job ]]; then printf public;
      elif [[ $mode == visibility-failure ]]; then return 93;
      else printf private; fi
    }
    '''
    with tempfile.TemporaryDirectory() as material:
        env = dict(os.environ, material=material, since=since, until=until, fixture=json.dumps(data[0]))
        for mode, code in [('normal', 0), ('capped', 1), ('api-failure', 92), ('visibility-failure', 93)]:
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', mock + collect],
                                    env=dict(env, mode=mode), capture_output=True, text=True)
            assert result.returncode == code, (mode, result)
            if mode == 'normal':
                rows = pathlib.Path(material, 'releases.jsonl').read_text().splitlines()
                assert len(rows) == 100 and all(json.loads(r)['repository'] == 'cgwalters-forge/agentic-job' for r in rows)

    def body(releases=selected, updates=None, limit=56000, changes='Changes\n'):
        return jq(compose, dict(brief='Brief', since=since, until=until, limit=limit,
                               project_url='https://github.com/orgs/example/projects/1', changes=changes,
                               releases=releases, updates=[updates or []]))

    update = dict(createdAt=since, status='ON_TRACK', body='Progress<!-- hidden -->')
    text = body(updates=[update])
    assert text.index('## Changes') < text.index('## Releases') < text.index('## Project status')
    assert all(str(v) in text for r in selected for v in r.values())
    assert 'hidden' not in text and 'Progress' in text
    assert '_None were published this week._' in body(releases=[])
    assert '_None were posted this week._' in body()
    huge = [dict(selected[0], name='界' * 4000)] + selected
    text = body(releases=huge)
    section = text.split('## Releases')[1].split('## Project status')[0]
    assert len(('## Releases' + section).encode()) <= 10000 and 'releases left out' in section
    text = body(updates=[update, dict(update, createdAt='2026-10-19T18:00:00Z', body='界' * 20000)])
    assert len(text.encode()) <= 56000 and 'status updates of the week are left out' in text
    assert 'v0.6.3' in text and 'v0.6.4' in text
    size = len(body().encode())
    assert len(body(limit=size).encode()) == size
    assert body(limit=size - 1) == ''
    print('ok weekly release selection, section order, empty windows, omissions and byte budget')

# The one agent-board commit every workflow pins as `  AGENT_BOARD_REV:`,
# printed; fails when the workflows pin different revisions, or none, so a
# move by hand cannot miss a workflow.
agent-board-pin:
    #!/usr/bin/env bash
    set -euo pipefail
    pins=$(sed -n 's/^  AGENT_BOARD_REV: //p' .github/workflows/*.yml | sort -u)
    if ! [[ $pins =~ ^[0-9a-f]{40}$ ]]; then
      echo "::error::.github/workflows pin more than one agent-board revision, or none:" >&2
      grep -H '^  AGENT_BOARD_REV:' .github/workflows/*.yml >&2 || true
      exit 1
    fi
    echo "$pins"

# Opens or updates the one pull request, from the bot's fork, that moves
# every AGENT_BOARD_REV to the head of agent-board's configured branch
# (.github/poll/agent-board.json), once all that commit's check runs have
# passed and it is ahead of the pin (agent-board-pin.yml). It commits in this
# checkout, and needs GITHUB_REPOSITORY and GH_TOKEN to push and open the PR.
bump-agent-board:
    #!/usr/bin/env bash
    set -euo pipefail
    pin=$({{ just_executable() }} agent-board-pin)
    source=$(jq -er .source .github/poll/agent-board.json)
    branch=$(jq -er .branch .github/poll/agent-board.json)
    bot=$(jq -er .bot .github/poll/agent-board.json)
    upstream=${source#https://github.com/}
    head=$(gh api "repos/$upstream/commits/$branch" --jq .sha)
    [[ $head =~ ^[0-9a-f]{40}$ ]]
    if [[ $head == "$pin" ]]; then echo "the pin is $branch's head $head"; exit 0; fi
    runs=$(gh api --paginate "repos/$upstream/commits/$head/check-runs" --jq '.check_runs[] | {name, status, conclusion}' | jq -cs .)
    if ! jq -e 'length > 0 and all(.[]; .status == "completed" and (.conclusion | IN("success", "neutral", "skipped")))' <<< "$runs" > /dev/null; then
      echo "$head: CI is not green yet: $runs"; exit 0
    fi
    # Never backwards or onto rewritten history; compare lists at most 250 commits.
    compare=$(gh api "repos/$upstream/compare/$pin...$head")
    status=$(jq -r .status <<< "$compare")
    [[ $status == ahead ]] || { echo "::error::$head is $status of the pin $pin, not ahead"; exit 1; }
    title="workflows: Move agent-board to ${head:0:7}"
    pr_branch=agent-board-pin
    open=$(gh pr list --repo "$GITHUB_REPOSITORY" --author "$bot" --head "$pr_branch" --state open --json number,title --jq '.[0] // empty')
    if [[ $(jq -r '.title // ""' <<< "$open") == "$title" ]]; then echo "already proposed: $title"; exit 0; fi
    fork=$(gh api --paginate "repos/$GITHUB_REPOSITORY/forks" --jq ".[] | select(.owner.login == \"$bot\") | .full_name" | head -n1)
    [[ -n $fork ]] || { echo "::error::$bot has no fork of $GITHUB_REPOSITORY"; exit 1; }
    body=$(
      echo "Every \`AGENT_BOARD_REV\` in \`.github/workflows/\` moves from $pin to $head, $branch's head, whose check runs all passed. Review [what changes]($source/compare/$pin...$head) in the program given the bot's token. The agent-board commits in between:"
      echo
      # Subjects in code spans, so their #N and @login do not reference here.
      jq -r --arg s "$source" '.commits[] | "- [\(.sha[0:7])](\($s)/commit/\(.sha)) `\(.commit.message | split("\n")[0] | gsub("`"; "'\''"))`"' <<< "$compare"
      jq -r 'if .total_commits > (.commits | length) then "\n\(.total_commits - (.commits | length)) more commits are not listed." else empty end' <<< "$compare"
    )
    sed -i "s/^  AGENT_BOARD_REV: $pin\$/  AGENT_BOARD_REV: $head/" .github/workflows/*.yml
    [[ $({{ just_executable() }} agent-board-pin) == "$head" ]]
    email=$(gh api "users/$bot" --jq '"\(.id)+\(.login)@users.noreply.github.com"')
    git -c user.name="$bot" -c user.email="$email" commit -q -a -m "$title" -m "$body"
    gh auth setup-git
    git push -q --force "https://github.com/$fork" "HEAD:refs/heads/$pr_branch"
    if [[ -n $open ]]; then
      gh pr edit "$(jq -r .number <<< "$open")" --repo "$GITHUB_REPOSITORY" --title "$title" --body "$body"
    else
      gh pr create --repo "$GITHUB_REPOSITORY" --head "${fork%%/*}:$pr_branch" --base "$(gh repo view "$GITHUB_REPOSITORY" --json defaultBranchRef --jq .defaultBranchRef.name)" --title "$title" --body "$body"
    fi

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

# The runner configuration's checks; those that run `agentic-job` skip where
# it is not installed.
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
