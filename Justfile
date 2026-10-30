# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-config test-supervisor-config test-supervisor-workflow test-poll-next test-review-gate test-forge-sync test-weekly-material agent-board-pin

# poll.yml's `next` step as written, with gh and sleep mocked: after its
# sleep it dispatches unless a newer applying run on the default branch is
# still to finish, and fails without dispatching when it cannot tell (#1019).
test-poll-next:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const workflow = fs.readFileSync('.github/workflows/poll.yml', 'utf8');
    const script = /- name: Start the next pass ten minutes after this one started\n(?: {8}.*\n)*? {8}run: \|\n((?: {10}.*\n)+)/
      .exec(workflow)[1].replace(/^ {10}/gm, '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-next-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\necho "sleep $*" >> "$MOCK_LOG"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
    echo "gh $*" >> "$MOCK_LOG"
    case "$1 $2" in
      "api "*) echo "$MOCK_STARTED" ;;
      "run list") [[ -z $MOCK_FAIL ]] || exit 1; cat "$MOCK_RUNS" ;;
      "workflow run") ;;
      *) exit 2 ;;
    esac
    `.replace(/^ {4}/gm, ''), { mode: 0o755 });
    const t0 = '2026-10-29T23:20:00Z', later = '2026-10-29T23:25:00Z', earlier = '2026-10-29T23:15:00Z';
    const run = (id, createdAt, fields) => ({ databaseId: id, createdAt, status: 'queued', event: 'schedule',
      displayTitle: 'pass', headBranch: 'main', ...fields });
    const me = run(100, t0, { status: 'in_progress', event: 'workflow_dispatch', displayTitle: 'pass (apply)' });
    const applying = { event: 'workflow_dispatch', displayTitle: 'pass (apply)' };
    const statuses = ['queued', 'waiting', 'pending', 'requested', 'in_progress'];
    for (const [name, runs, want] of [
      ['lone chain', [me], 'dispatch'],
      ['offset duplicate chain', [run(105, later, { ...applying, status: 'in_progress' }), me], 'skip'],
      ['newer schedule run', [run(105, later), me], 'skip'],
      ...statuses.map(status => [`newer ${status} run`, [run(105, later, { ...applying, status }), me], 'skip']),
      ['older queued run', [me, run(90, earlier, applying)], 'dispatch'],
      ['newer completed run', [run(105, later, { ...applying, status: 'completed' }), me], 'dispatch'],
      ['newer cancelled run', [run(105, later, { ...applying, status: 'completed', conclusion: 'cancelled' }), me], 'dispatch'],
      ['same second, higher id', [run(101, t0, applying), me], 'skip'],
      ['same second, lower id', [me, run(99, t0, applying)], 'dispatch'],
      ['newer preview', [run(105, later, { event: 'workflow_dispatch', displayTitle: 'pass' }), me], 'dispatch'],
      ['newer run on another branch', [run(105, later, { ...applying, headBranch: 'other' }), me], 'dispatch'],
      ['newer schedule run on another branch', [run(105, later, { headBranch: 'other' }), me], 'dispatch'],
      ['this run beyond the list', [run(105, later, { status: 'completed' })], 'fail'],
      ['run list fails', null, 'fail'],
    ]) {
      const log = path.join(dir, 'log');
      fs.writeFileSync(log, '');
      fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs ?? []));
      const started = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, MOCK_STARTED: started,
          MOCK_RUNS: path.join(dir, 'runs.json'), MOCK_FAIL: runs ? '' : '1',
          GH_TOKEN: 'unused', RUN_ID: '100', DEFAULT_BRANCH: 'main', GITHUB_REPOSITORY: 'o/r' },
      });
      // Mocked sleep returns at once; the check comes after it.
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ').slice(0, 3).join(' '));
      const detail = `${name}: ${result.stdout}${result.stderr}`;
      assert.deepEqual(calls.slice(0, 3).map(c => c.replace(/^sleep \d+$/, 'sleep')),
        ['gh api repos/o/r/actions/runs/100', 'sleep', 'gh run list'], detail);
      assert.match(fs.readFileSync(log, 'utf8'), /^gh run list --repo o\/r --workflow poll\.yml --branch main --limit 200 /m, detail);
      const dispatched = calls.includes('gh workflow run');
      assert.equal(result.status === 0 ? (dispatched ? 'dispatch' : 'skip') : 'fail', want, detail);
      assert.ok(!(result.status !== 0 && dispatched), detail);
      if (dispatched) assert.match(fs.readFileSync(log, 'utf8'), /^gh workflow run poll\.yml --repo o\/r --ref main -f apply=true$/m, detail);
      console.log(`ok ${name}: ${want}`);
    }
    fs.rmSync(dir, { recursive: true });

# supervisor.yml's folded concurrency group and health `if`, evaluated as
# JavaScript on events: a run the gate skips gets a group of its own
# (#803), and a session dispatch, prompt or not, is an agent run.
test-supervisor-workflow:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const workflow = fs.readFileSync('.github/workflows/supervisor.yml', 'utf8');
    const folded = (key, indent) => new RegExp(`^${' '.repeat(indent)}${key}: >-\\n((?:${' '.repeat(indent + 2)}.*\\n)+)`, 'm')
      .exec(workflow)[1].split('\n').map(line => line.trim()).filter(Boolean).join(' ');
    const group = /^\$\{\{ (.*) \}\}$/.exec(folded('group', 2))[1];
    const gate = folded('if', 4);
    assert.ok(group.startsWith(`(!(${gate}) && format('supervisor-ignored-{0}', github.run_id))`));
    const { operator } = JSON.parse(fs.readFileSync('.github/poll/agent-board.json', 'utf8'));
    const { issue } = JSON.parse(fs.readFileSync('.github/supervisor/config.json', 'utf8')).agent.requests;
    const comment = { user: { login: operator } };
    const requests = { number: issue, locked: true };
    const dispatch = (inputs, ref) => ({ event_name: 'workflow_dispatch', inputs: { prompt: '', session: false, ...inputs }, ref });
    for (const [event, expected] of [
      [{ event_name: 'issue_comment', event: { comment, issue: requests } }, 'supervisor-agent'],
      [{ event_name: 'issue_comment', event: { comment, issue: { ...requests, locked: false } } }, 'supervisor-ignored-42'],
      [{ event_name: 'issue_comment', event: { comment, issue: { ...requests, pull_request: { url: 'x' } } } }, 'supervisor-ignored-42'],
      [{ event_name: 'issue_comment', event: { comment: { user: { login: 'outsider' } }, issue: requests } }, 'supervisor-ignored-42'],
      [dispatch({ prompt: 'do it' }), 'supervisor-agent'],
      [dispatch({ prompt: 'do it' }, 'refs/heads/other'), 'supervisor-ignored-42'],
      [dispatch({}), 'supervisor-health'],
      [dispatch({}, 'refs/heads/other'), 'supervisor-ignored-42'],
      [dispatch({ session: true }), 'supervisor-agent'],
      [dispatch({ session: true, prompt: 'look at #1' }), 'supervisor-agent'],
      [dispatch({ session: true }, 'refs/heads/other'), 'supervisor-ignored-42'],
      [{ event_name: 'schedule', event: { schedule: '*/15 * * * *' } }, 'supervisor-health'],
      [{ event_name: 'schedule', event: { schedule: '7 */2 * * *' } }, 'supervisor-agent'],
    ]) {
      const context = {
        format: (f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => a[i]),
        fromJSON: JSON.parse,
        vars: {},
        inputs: event.inputs ?? {},
        github: {
          event_name: event.event_name, run_id: 42, ref: event.ref ?? 'refs/heads/main',
          event: { repository: { default_branch: 'main' }, ...event.event },
        },
      };
      const got = vm.runInNewContext(group, context);
      assert.equal(got, expected, JSON.stringify(event));
      assert.equal(vm.runInNewContext(gate, context), !got.startsWith('supervisor-ignored-'), JSON.stringify(event));
    }
    // A session is an explicit request to `due`, and reaches the wrapper
    // with session.json's idle timeout.
    assert.match(workflow, /^ {10}PROMPT: \$\{\{ inputs\.prompt \|\| \(inputs\.session && 'session' \|\| ''\) \}\}$/m);
    assert.match(workflow, /^ {6}session: \$\{\{ needs\.health\.outputs\.session == 'true' \}\}\n {6}idle-minutes: \$\{\{ needs\.health\.outputs\.idle \}\}$/m);
    assert.match(workflow, /"idle=\\\(\.idleMinutes\)"' \.github\/agentic-job\/session\.json/);
    console.log('ok supervisor concurrency groups and health gate, sessions included');

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

# A repository's drift from the manifest (.github/forge-sync/repos.json,
# #544), one line each, from its fetched files on stdin:
# {"repo": ..., "review": <review.yml or null>, "dependabot": <dependabot.yml
# or null>, "justfile": <bool>}. Fails on any drift, a repository the
# manifest does not list, or an exemption that is unknown or gives no reason.
# The YAML is parsed with yq (its first document), so only a job's `uses`
# counts as a call of the reviewer, and every such call must be at the pin.
forge-sync-drift manifest:
    #!/usr/bin/env bash
    set -euo pipefail
    input=$(cat)
    yaml() { jq -r --arg k "$1" '.[$k] // empty' <<< "$input" | yq -p=yaml -o=json -I=0 'select(document_index == 0)'; }
    review=$(yaml review)
    dependabot=$(yaml dependabot)
    drift=$(jq -r --slurpfile m "$1" --argjson rv "$review" --argjson dp "$dependabot" '
      $m[0] as $m | .repo as $r | (first($m.repos[] | select(.repo == $r)) // null) as $e
      | if $e == null then "\($r) \($path): expected an entry, found none" else ($e.exempt // {}) as $x
      | ($x | to_entries[] | select((.key | IN("review", "dependabot", "justfile") | not) or (.value | type != "string" or length == 0))
        | "\($r) \($path): expected exempt.\(.key) to be review, dependabot or justfile with a reason, found \(.value | tojson)"),
        ("cgwalters-forge/actions/.github/workflows/cgwalters-review.yml@" as $call | "\($call)\($m.review_pin)" as $want
        | [$rv | objects | .jobs | objects | .[] | objects | .uses | strings] as $uses
        | [$uses[] | select(startswith($call))] as $calls
        | select($x.review == null and ($calls == [] or any($calls[]; . != $want)))
        | "\($r) .github/workflows/review.yml: expected uses \($want), found \(if .review == null then "no file" else if $calls == [] then $uses else $calls end | join(", ") | if . == "" then "no uses" else . end end)"),
        ([$dp | objects | .updates | arrays | .[] | objects | select(."package-ecosystem" == "github-actions")
          | (.schedule | objects | .interval) // "no interval" | tostring] as $i
        | select($x.dependabot == null and ($i == [] or any($i[]; . != "daily")))
        | "\($r) .github/dependabot.yml: expected a github-actions update with interval daily, found \(if .dependabot == null then "no file" elif $i == [] then "no github-actions update" else $i | join(", ") end)"),
        (select($x.justfile == null and .justfile != true) | "\($r) Justfile: expected a root Justfile, found none")
      end' --arg path "$1" <<< "$input")
    [[ -z $drift ]] || { echo "$drift"; exit 1; }

# forge-sync-drift on each fixture under .github/forge-sync/testdata against
# its manifest.json, passing for pass-* and reporting drift for the fixture's
# repository otherwise; then on this
# repository's own files against the real manifest, so moving the pin in
# review.yml fails here until review_pin moves with it.
test-forge-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=.github/forge-sync/testdata
    for f in "$dir"/pass-*.json "$dir"/fail-*.json; do
      want=fail; [[ $(basename "$f") == pass-* ]] && want=pass
      got=pass; out=$({{ just_executable() }} forge-sync-drift "$dir/manifest.json" < "$f" 2> /dev/null) || got=fail
      [[ $got == pass || $out == "$(jq -r .repo "$f") "* ]] || got="an error: $out"
      [[ $got == "$want" ]] || { echo "$f: want $want, got $got" >&2; exit 1; }
      echo "ok $f ($want)"
    done
    bad=$(mktemp)
    for manifest in '{}' '{"repos": []}' '{"repos": [{}]}' '[' ''; do
      if [[ -n $manifest ]]; then echo "$manifest" > "$bad"; else rm -f "$bad"; fi
      if {{ just_executable() }} forge-sync "$bad" > /dev/null 2>&1; then
        echo "forge-sync with manifest '$manifest': want fail, got pass" >&2; exit 1
      fi
      echo "ok forge-sync refuses manifest '${manifest:-<missing>}'"
    done
    jq -n --rawfile review .github/workflows/review.yml --rawfile dependabot .github/dependabot.yml \
      '{repo: "cgwalters-forge/tracker", $review, $dependabot, justfile: true}' |
      {{ just_executable() }} forge-sync-drift .github/forge-sync/repos.json
    echo "ok this repository against .github/forge-sync/repos.json"

# forge-sync-drift on the default branch of every repository in the
# manifest, read through the contents API (a 404 is a missing file); fails
# if any repository drifted or could not be read. The step output `failed`
# lists those repositories and `drift`, a JSON string, their drift lines
# (forge-sync.yml).
forge-sync manifest=".github/forge-sync/repos.json":
    #!/usr/bin/env bash
    set -euo pipefail
    err=$(mktemp)
    trap 'rm -f "$err"' EXIT
    fetch() {
      local body
      if body=$(gh api "repos/$1/contents/$2" -H 'Accept: application/vnd.github.raw' 2> "$err"); then jq -Rs . <<< "$body"
      elif grep -q 'HTTP 404' "$err"; then echo null
      else echo "::error::$1: could not read $2: $(cat "$err")" >&2; return 1; fi
    }
    repos=$(jq -er '.repos | select(length > 0 and all(.[]; .repo | type == "string")) | .[].repo' "$1") || { echo "::error::$1: expected a manifest listing repos" >&2; exit 1; }
    failed=() drift=
    for repo in $repos; do
      out=
      if j=$(fetch "$repo" Justfile) && if [[ $j == null ]]; then j=$(fetch "$repo" justfile); fi &&
        input=$(jq -n --arg repo "$repo" --argjson review "$(fetch "$repo" .github/workflows/review.yml)" \
          --argjson dependabot "$(fetch "$repo" .github/dependabot.yml)" --argjson j "$j" \
          '{$repo, $review, $dependabot, justfile: ($j != null)}') &&
        out=$({{ just_executable() }} forge-sync-drift "$1" <<< "$input"); then
        echo "ok $repo"; continue
      fi
      out=${out:-"$repo: could not be read or checked"}
      echo "$out"; drift+=$out$'\n'; failed+=("$repo")
    done
    # The lines quote the repositories' files, so the output is capped.
    drift=${drift%$'\n'}
    printf 'failed=%s\ndrift=%s\n' "${failed[*]}" "$(jq -nc --arg d "${drift:0:50000}" '$d')" >> "${GITHUB_OUTPUT:-/dev/null}"
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
