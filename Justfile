# The checks and jobs of this repository's automation. Workflows call these
# recipes rather than inline scripts, so a check runs the same here and in CI.

# Recipes see their arguments as $1, $2, ...
set positional-arguments

# Every test of the files under .github.
test: test-agent-board-install test-config test-supervisor-config test-supervisor-workflow test-poll-bounds test-poll-next test-review-gate test-forge-sync agent-board-pin

# Manual structural checks of the offline architecture-review prototype.
test-architecture-review:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');
    const test = require('node:test');

    const read = name => readFileSync(`docs/architecture-review/${name}`, 'utf8');
    const json = name => JSON.parse(read(name));
    const references = json('references.json');
    const version = references.version;
    const sample = json('sample.json');
    const results = json('results.json');

    function validateCounts(r) {
      assert.equal(r.selected_prs, sample.samples.length);
      assert.equal(r.candidate_prs_with_design_feedback + r.rejected_prs, r.selected_prs);
      assert.equal(r.architecture_concerns + r.excluded_nits + r.excluded_acknowledgements,
        r.audited_inline_comments);
      assert.equal(r.executed_reviews, r.runs.length);
      assert.ok(r.compared_prs <= r.executed_reviews);
      assert.equal(r.status, 'unfinished');
      assert.equal(r.held_out_claim, false);
      for (const key of ['matched', 'missed', 'unmatched']) assert.equal(r[key], null);
    }

    test('explicit version and pinned, publicly linked source files', () => {
      assert.equal(version, '0.1.0');
      assert.equal(results.version, version);
      assert.equal(references.references.length, 9);
      for (const [file, digest] of Object.entries(results.authoring_artifact_sha256)) {
        assert.equal(createHash('sha256').update(read(file)).digest('hex'), digest, file);
      }
      const ids = new Set();
      for (const r of references.references) {
        assert.match(r.revision, /^[a-f0-9]{40}$/);
        assert.ok(r.sections.length > 0);
        assert.ok(!ids.has(r.id));
        ids.add(r.id);
        assert.ok(read('README.md').includes(
          `https://github.com/${r.repository}/blob/${r.revision}/${r.path}`));
      }
    });

    test('six scoped architecture patterns with explicitly illustrative examples', () => {
      const library = read('patterns.md');
      const sections = library.split(/^## /m).slice(1);
      assert.equal(sections.length, 6);
      sections.forEach((s, i) => {
        assert.ok(s.startsWith(`AR-0${i + 1}:`));
        for (const label of ['Principle', 'Scope/exceptions', 'Source',
          'Good (illustrative)', 'Bad (illustrative)']) assert.ok(s.includes(`**${label}:**`));
        assert.ok(references.references.some(r => s.includes(r.id)));
      });
    });

    test('prompt covers design dimensions, evidence, uncertainty and read-only boundary', () => {
      const prompt = read('prompt.md');
      assert.ok(prompt.includes(`prompt ${version}`));
      for (const dimension of ['Invariants', 'State ownership', 'Failure and rollback',
        'Compatibility and interfaces', 'Dependency ordering', 'Privilege boundaries', 'Testing']) {
        assert.ok(prompt.includes(`**${dimension}:**`));
      }
      for (const phrase of ['untrusted **data**', 'Do not execute', 'Do not edit files',
        'concrete PR evidence', 'Uncertainty/questions', 'nit-checklist',
        '100,000', 'contaminated', 'Archive this output unchanged']) assert.ok(prompt.includes(phrase));
    });

    test('sample pins are separate from derivation and not leaked into prompt/library', () => {
      assert.equal(sample.frozen_before_prompt_authoring, true);
      assert.equal(sample.samples.length, 3);
      assert.equal(new Set(sample.samples.map(s => s.id)).size, 3);
      for (const s of sample.samples) {
        for (const sha of [s.head, s.candidate_base, ...(s.reconstructed_base ? [s.reconstructed_base] : [])]) {
          assert.match(sha, /^[a-f0-9]{40}$/);
          assert.ok(!references.references.some(r => r.revision === sha));
          for (const file of ['patterns.md', 'prompt.md']) assert.ok(!read(file).includes(sha));
        }
        for (const file of ['patterns.md', 'prompt.md']) {
          assert.ok(!read(file).includes(`/${s.repository}/pull/${s.pr}`));
        }
        assert.ok(s.review.startsWith(`https://github.com/${s.repository}/pull/${s.pr}#`));
      }
    });

    test('unfinished evaluation counts do not masquerade as zero findings', () => {
      validateCounts(results);
      assert.throws(() => validateCounts({ ...results, architecture_concerns: 5 }));
      assert.throws(() => validateCounts({ ...results, executed_reviews: 3 }));
      assert.throws(() => validateCounts({ ...results, matched: 0 }));
      assert.throws(() => validateCounts({ ...results, held_out_claim: true }));
    });

# poll must pass both of the fix bounds files dispatch selects per target.
test-poll-bounds:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const poll = require('node:fs').readFileSync('.github/workflows/poll.yml', 'utf8');
    const command = /"\$AGENT_BOARD" pass .*\\\n(?: {12}.*\\\n)* {12}.*\n/.exec(poll)?.[0];
    assert.ok(command, 'the agent-board pass command');
    assert.deepEqual([...command.matchAll(/--fix-bounds (\S+)/g)].map(m => m[1]),
      ['.github/agentic-job/fix.toml', '.github/agentic-job/midstream-fix.toml']);
    console.log('ok poll passes both fix bounds files to agent-board pass');

# poll's `next` step script, run with a stub agent-board that prints its
# arguments: the supervisor and release-train wakes are added only under
# their variables' gates. Every flag it passes is checked against the
# pinned CLI's help (AGENT_BOARD), which reads no token. The failure-only
# fallback uses runner tools and makes just one dispatch attempt.
test-poll-next:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const poll = fs.readFileSync('.github/workflows/poll.yml', 'utf8');
    const step = /^ {6}- name: Start the next pass .*\n((?: {8}.*\n)+)/m.exec(poll)?.[1];
    assert.ok(step, 'the next pass step');
    assert.match(step, /^ {10}RELEASE_TRAIN: \$\{\{ vars\.RELEASE_TRAIN \}\}$/m);
    const script = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(step)[1].replace(/^ {10}/gm, '');
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll-next-'));
    const stub = path.join(temp, 'agent-board/bin/agent-board');
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const run = (env) => execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: temp, DEFAULT_BRANCH: 'main', SUPERVISOR: '', RELEASE_TRAIN: '', ...env },
    }).toString().trimEnd().split('\n');
    const base = ['pass', 'next', '--workflow', 'poll.yml', '--branch', 'main', '--input', 'apply=true',
      '--apply-title', 'pass (apply)', '--wait-minutes', '10'];
    const supervisor = ['--supervisor-workflow', 'supervisor.yml', '--supervisor-stale-minutes', '30',
      '--supervisor-input', 'prompt=', '--supervisor-input', 'session=false'];
    const train = ['--train-workflow', 'release-train.yml', '--train-stale-minutes', '60'];
    for (const value of ['', 'enabled', 'Apply', ' apply', 'dry-run ', 'preview']) {
      assert.deepEqual(run({ RELEASE_TRAIN: value }), base, `RELEASE_TRAIN=${JSON.stringify(value)}`);
    }
    for (const value of ['dry-run', 'apply']) {
      assert.deepEqual(run({ RELEASE_TRAIN: value }), [...base, ...train], `RELEASE_TRAIN=${value}`);
    }
    for (const [value, enabled] of [['off', false], ['preview', true], ['apply', true]]) {
      assert.deepEqual(run({ SUPERVISOR: value }), enabled ? [...base, ...supervisor] : base, `SUPERVISOR=${value}`);
    }
    const all = run({ SUPERVISOR: 'preview', RELEASE_TRAIN: 'apply' });
    assert.deepEqual(all, [...base, ...supervisor, ...train]);
    fs.rmSync(temp, { recursive: true });
    console.log('ok poll next wakes the supervisor and release train only under their gates');
    if (process.env.AGENT_BOARD) {
      const help = execFileSync(process.env.AGENT_BOARD, ['pass', 'next', '--help']).toString();
      for (const flag of new Set(all.filter(arg => arg.startsWith('--')))) {
        assert.match(help, new RegExp(`${flag}(?![\\w-])`), `${flag} in agent-board pass next --help`);
      }
      console.log('ok the pinned agent-board pass next takes every flag poll next passes');
    } else {
      console.log('skipped: set AGENT_BOARD to check the flags against the pinned CLI');
    }
    const fallback = /^ {2}next-fallback:\n([\s\S]+)$/m.exec(poll)?.[1];
    assert.ok(fallback, 'the final fallback job');
    assert.match(fallback, /^ {4}needs: next$/m);
    const gate = /^ {4}if: \$\{\{ (.*) \}\}$/m.exec(fallback)[1];
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const cancelled of [false, true]) {
        for (const apply of ['', 'enabled', 'disabled']) {
          const got = require('node:vm').runInNewContext(gate, {
            cancelled: () => cancelled, needs: { next: { result } }, vars: { PASS_APPLY: apply },
          });
          assert.equal(got, result === 'failure' && !cancelled && apply === 'enabled');
        }
      }
    }
    assert.match(fallback, /^ {4}timeout-minutes: 12$/m);
    assert.match(fallback, /^ {4}permissions:\n {6}actions: write\n {4}steps:/m);
    assert.doesNotMatch(fallback, /uses:|continue-on-error:|^ {2}\S/m);
    assert.equal((fallback.match(/^ {6}- /gm) ?? []).length, 1, 'one step without setup');
    assert.match(fallback, /^ {10}GH_TOKEN: \$\{\{ github.token \}\}$/m);
    assert.match(fallback, /^ {10}DEFAULT_BRANCH: \$\{\{ github.event.repository.default_branch \}\}$/m);
    const recovery = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(fallback)[1].replace(/^ {10}/gm, '');
    const sandbox = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll-fallback-'));
    try {
      fs.writeFileSync(path.join(sandbox, 'gh'), '#!/bin/bash\nif [[ $1 == api ]]; then printf "%s\\n" "$*" >&2; printf "2026-11-02T17:51:00Z\\n"; exit "${API_EXIT:-0}"; fi\nprintf "%s\\n" "$*"\nexit "${DISPATCH_EXIT:-0}"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'date'), '#!/bin/bash\nif [[ $1 == -d ]]; then printf "1000\\n"; else printf "%s\\n" "$NOW"; fi\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sandbox, 'sleep'), '#!/bin/bash\nprintf "sleep %s\\n" "$*"\n', { mode: 0o755 });
      const api = 'api repos/owner/repo/actions/runs/42 --jq .run_started_at';
      const dispatch = 'workflow run poll.yml --repo owner/repo --ref main -f apply=true';
      const recover = (env) => require('node:child_process').spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', recovery], {
        env: { PATH: `${sandbox}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', DEFAULT_BRANCH: 'main', ...env }, encoding: 'utf8',
      });
      for (const [now, delay] of [['1120', '480'], ['1600', null], ['1900', null], ['900', '600']]) {
        const got = recover({ NOW: now });
        assert.equal(got.status, 0, got.stderr);
        assert.equal(got.stderr.trimEnd(), api);
        assert.deepEqual(got.stdout.trimEnd().split('\n'), [...(delay ? [`sleep ${delay}`] : []), dispatch]);
      }
      const failed = recover({ NOW: '1900', DISPATCH_EXIT: '1' });
      assert.equal(failed.status, 1, 'dispatch failure stays visible');
      assert.equal(failed.stderr.trimEnd(), api);
      assert.deepEqual(failed.stdout.trimEnd().split('\n'), [dispatch], 'no retry on failure');
      const unreadable = recover({ NOW: '1900', API_EXIT: '1' });
      assert.equal(unreadable.status, 1);
      assert.equal(unreadable.stderr.trimEnd(), api);
      assert.equal(unreadable.stdout, '', 'API failure stops recovery');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    console.log('ok poll fallback is failure-only, waits at most ten minutes and dispatches once');

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
    # Publication follows CI: green source alone is not an installable pin.
    if ! published=$(gh release view "build-$head" --repo "$upstream" --json isDraft --jq '.isDraft') || [[ $published != false ]]; then
      echo "$head: no published binary release yet"; exit 0
    fi
    (export RUNNER_TEMP=$(mktemp -d); trap 'rm -rf "$RUNNER_TEMP"' EXIT
      GITHUB_OUTPUT=/dev/null {{ just_executable() }} build-agent-board "$head")
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
# or null>, "justfile": <bool>, "renovate": <renovate.json or null>}. Fails
# on any drift, a repository the manifest does not list, or an exemption that
# is unknown or gives no reason. The YAML is parsed with yq (its first
# document), so only a job's `uses` counts as a call of the reviewer, and
# every such call must be at the pin. Only a manifest that sets
# renovate_preset requires the Renovate config to list it in `extends`, so
# that no repository's runner label goes stale unnoticed (#1054).
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
      | ($x | to_entries[] | select((.key | IN("review", "dependabot", "justfile", "renovate") | not) or (.value | type != "string" or length == 0))
        | "\($r) \($path): expected exempt.\(.key) to be review, dependabot, justfile or renovate with a reason, found \(.value | tojson)"),
        ("cgwalters-forge/actions/.github/workflows/cgwalters-review.yml@" as $call | "\($call)\($m.review_pin)" as $want
        | [$rv | objects | .jobs | objects | .[] | objects | .uses | strings] as $uses
        | [$uses[] | select(startswith($call))] as $calls
        | select($x.review == null and ($calls == [] or any($calls[]; . != $want)))
        | "\($r) .github/workflows/review.yml: expected uses \($want), found \(if .review == null then "no file" else if $calls == [] then $uses else $calls end | join(", ") | if . == "" then "no uses" else . end end)"),
        ([$dp | objects | .updates | arrays | .[] | objects | select(."package-ecosystem" == "github-actions")
          | (.schedule | objects | .interval) // "no interval" | tostring] as $i
        | select($x.dependabot == null and ($i == [] or any($i[]; . != "daily")))
        | "\($r) .github/dependabot.yml: expected a github-actions update with interval daily, found \(if .dependabot == null then "no file" elif $i == [] then "no github-actions update" else $i | join(", ") end)"),
        (select($x.justfile == null and .justfile != true) | "\($r) Justfile: expected a root Justfile, found none"),
        ($m.renovate_preset as $p | select($p != null and $x.renovate == null)
        | if $p | type != "string" or length == 0 then "\($r) \($path): expected renovate_preset to be a preset name, found \($p | tojson)"
          else .renovate as $text | (if $text == null then null else try ($text | fromjson) catch null end) as $rc
          | select([$rc | objects | .extends | arrays | .[] | select(. == $p)] == [])
          | "\($r) renovate.json: expected extends to list \($p), found \(if $text == null then "no file" elif $rc | type != "object" then "no JSON object" else $rc.extends // [] | tojson end)" end)
      end' --arg path "$1" <<< "$input")
    [[ -z $drift ]] || { echo "$drift"; exit 1; }

# forge-sync-drift on each fixture under .github/forge-sync/testdata, and
# under its renovate/ whose manifest sets renovate_preset, against the
# manifest.json beside it, passing for pass-* and reporting drift for the
# fixture's repository otherwise; then on this
# repository's own files against the real manifest, so moving the pin in
# review.yml fails here until review_pin moves with it, and dropping
# .github/renovate.json or renovate_preset fails too.
test-forge-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    top=.github/forge-sync/testdata
    for dir in "$top" "$top/renovate"; do
      for f in "$dir"/pass-*.json "$dir"/fail-*.json; do
        want=fail; [[ $(basename "$f") == pass-* ]] && want=pass
        got=pass; out=$({{ just_executable() }} forge-sync-drift "$dir/manifest.json" < "$f" 2> /dev/null) || got=fail
        [[ $got == pass || $out == "$(jq -r .repo "$f") "* ]] || got="an error: $out"
        [[ $got == "$want" ]] || { echo "$f: want $want, got $got" >&2; exit 1; }
        echo "ok $f ($want)"
      done
    done
    bad=$(mktemp)
    # Without renovate_preset no Renovate config is required; with one that
    # is not a preset name every repository drifts.
    {{ just_executable() }} forge-sync-drift "$top/manifest.json" < "$top/renovate/fail-no-renovate.json"
    echo "ok no renovate_preset requires no Renovate config"
    jq '.renovate_preset = 1' "$top/renovate/manifest.json" > "$bad"
    if {{ just_executable() }} forge-sync-drift "$bad" < "$top/renovate/pass-extends-preset.json" > /dev/null 2>&1; then
      echo "forge-sync-drift with renovate_preset 1: want fail, got pass" >&2; exit 1
    fi
    echo "ok forge-sync-drift refuses renovate_preset 1"
    for manifest in '{}' '{"repos": []}' '{"repos": [{}]}' '[' ''; do
      if [[ -n $manifest ]]; then echo "$manifest" > "$bad"; else rm -f "$bad"; fi
      if {{ just_executable() }} forge-sync "$bad" > /dev/null 2>&1; then
        echo "forge-sync with manifest '$manifest': want fail, got pass" >&2; exit 1
      fi
      echo "ok forge-sync refuses manifest '${manifest:-<missing>}'"
    done
    self=$(jq -n --rawfile review .github/workflows/review.yml --rawfile dependabot .github/dependabot.yml \
      --rawfile renovate .github/renovate.json '{repo: "cgwalters-forge/tracker", $review, $dependabot, justfile: true, $renovate}')
    {{ just_executable() }} forge-sync-drift .github/forge-sync/repos.json <<< "$self"
    echo "ok this repository against .github/forge-sync/repos.json"
    # The real manifest must keep requiring the preset of this repository.
    if {{ just_executable() }} forge-sync-drift .github/forge-sync/repos.json <<< "$(jq '.renovate = null' <<< "$self")" > /dev/null 2>&1; then
      echo "this repository without .github/renovate.json: want drift, got none" >&2; exit 1
    fi
    echo "ok this repository without .github/renovate.json drifts"

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
    # The Renovate config is read only when the manifest asks for a preset,
    # from the two JSON places Renovate looks for it that the forge uses.
    preset=$(jq -r '.renovate_preset // empty' "$1")
    failed=() drift=
    for repo in $repos; do
      out= renovate=null
      if j=$(fetch "$repo" Justfile) && if [[ $j == null ]]; then j=$(fetch "$repo" justfile); fi &&
        if [[ -n $preset ]]; then
          renovate=$(fetch "$repo" renovate.json) && if [[ $renovate == null ]]; then renovate=$(fetch "$repo" .github/renovate.json); fi
        fi &&
        input=$(jq -n --arg repo "$repo" --argjson review "$(fetch "$repo" .github/workflows/review.yml)" \
          --argjson dependabot "$(fetch "$repo" .github/dependabot.yml)" --argjson j "$j" --argjson renovate "$renovate" \
          '{$repo, $review, $dependabot, justfile: ($j != null), $renovate}') &&
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
# it is not installed. The build goes outside the source tree.
test-config:
    cargo test --locked --manifest-path .github/agentic-job/config-test/Cargo.toml --target-dir "{{ env('CARGO_TARGET_DIR', cache_directory() / 'tracker-config-test') }}"

# The shipped supervisor settings through the binary supervisor.yml pins
# (AGENT_BOARD, from build-supervisor-agent-board): a cap the executor
# refuses would otherwise fail every pass after the merge. Empty checks and
# no --daily return before any API request.
test-supervisor-config:
    #!/usr/bin/env bash
    set -euo pipefail
    jq -e '.capacityMarginPercent == 10 and
      .agent.passConfig == ".github/pass.json"' .github/supervisor/config.json > /dev/null
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

# No moving refs or source fallback: substituted assets must not run with the
# bot's write token. The attested manifest binds both digests to reviewed CI.
build-agent-board rev=env("AGENT_BOARD_REV", ""):
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$1
    [[ $rev =~ ^[0-9a-f]{40}$ ]] || { echo 'expected a pinned 40-character AGENT_BOARD_REV' >&2; exit 1; }
    [[ $(uname -s)-$(uname -m) == Linux-x86_64 ]] || { echo 'agent-board binaries support only Linux x86_64' >&2; exit 1; }
    repo=cgwalters-forge/agent-board target=x86_64-unknown-linux-musl
    tag=build-$rev
    dest=$RUNNER_TEMP/agent-board/bin
    mkdir -p "$dest"
    rm -f "$dest/agent-board"
    stage=$(mktemp -d "$RUNNER_TEMP/agent-board-download.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    timeout 180 gh release download "$tag" --repo "$repo" --dir "$stage" \
      --pattern "*-$target" --pattern SHA256SUMS --pattern release.json --pattern provenance.jsonl
    GH_TOKEN='' GITHUB_TOKEN='' timeout 180 gh attestation verify "$stage/release.json" \
      --bundle "$stage/provenance.jsonl" --repo "$repo" \
      --cert-identity "https://github.com/$repo/.github/workflows/ci.yml@refs/heads/main" \
      --source-ref refs/heads/main --source-digest "$rev" --deny-self-hosted-runners
    jq -e --arg repo "$repo" --arg tag "$tag" --arg commit "$rev" --arg target "$target" \
      '.schema == "agent-board.release.v1" and .repository == $repo and .tag == $tag and .commit == $commit and .target == $target' "$stage/release.json" > /dev/null
    # Accept only the two fixed filenames, never paths supplied by a manifest.
    node -e 'const fs = require("node:fs"); const d = process.argv[1]; const s = JSON.parse(fs.readFileSync(d + "/release.json")).sha256sums; if (typeof s !== "string" || !/^[0-9a-f]{64}  agent-board-x86_64-unknown-linux-musl\n[0-9a-f]{64}  gh-agent-board-x86_64-unknown-linux-musl\n$/.test(s)) throw Error("invalid release checksums"); fs.writeFileSync(d + "/attested-SHA256SUMS", s);' "$stage"
    cmp "$stage/SHA256SUMS" "$stage/attested-SHA256SUMS"
    (cd "$stage" && sha256sum --check attested-SHA256SUMS)
    install -m 755 "$stage/agent-board-$target" "$dest/agent-board"
    echo "rev=$rev" >> "${GITHUB_OUTPUT:-/dev/null}"
    echo "Installed agent-board $rev ($target)"

# Offline transport fixtures exercise the real installer; no network or token.
test-agent-board-install:
    #!/usr/bin/env node
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-install-'));
    const rev = 'a'.repeat(40);
    const target = 'x86_64-unknown-linux-musl';
    const stub = `#!/usr/bin/env node
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const args = process.argv.slice(2), mode = process.env.CASE;
    if (process.env.BUMP) {
      if (args[0] === 'api' && args.some(a => a.endsWith('/commits/main'))) { console.log('${rev}'); process.exit(0); }
      if (args[0] === 'api' && args.some(a => a.endsWith('/check-runs'))) { console.log(JSON.stringify({name: 'ci', status: 'completed', conclusion: 'success'})); process.exit(0); }
      if (args[0] === 'release' && args[1] === 'view') { console.log(mode === 'draft' ? 'true' : 'false'); process.exit(mode === 'missing-release' ? 1 : 0); }
      if (args[0] === 'api' && args.some(a => a.includes('/compare/'))) { fs.writeFileSync(process.env.MARKER, 'selected'); console.log(JSON.stringify({status: 'ahead'})); process.exit(0); }
      if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify({title: 'workflows: Move agent-board to aaaaaaa'})); process.exit(0); }
    }
    if (args[0] === 'attestation') {
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(9);
      for (const s of ['--source-digest', '${rev}', '--deny-self-hosted-runners', 'https://github.com/cgwalters-forge/agent-board/.github/workflows/ci.yml@refs/heads/main']) if (!args.includes(s)) process.exit(8);
      process.exit(mode === 'attestation' ? 1 : 0);
    }
    if (['missing-release', 'download'].includes(mode)) process.exit(1);
    const d = args[args.indexOf('--dir') + 1];
    let sums = '';
    for (const n of ['agent-board', 'gh-agent-board']) {
      const name = n + '-${target}', data = '#!/bin/sh\\nexit 0\\n';
      fs.writeFileSync(path.join(d, name), data);
      sums += crypto.createHash('sha256').update(data).digest('hex') + '  ' + name + '\\n';
    }
    fs.writeFileSync(path.join(d, 'SHA256SUMS'), mode === 'sums' ? 'bad' : sums);
    fs.writeFileSync(path.join(d, 'release.json'), JSON.stringify({schema: 'agent-board.release.v1', repository: 'cgwalters-forge/agent-board', tag: 'build-${rev}', commit: mode === 'commit' ? 'b'.repeat(40) : '${rev}', target: '${target}', sha256sums: sums}));
    fs.writeFileSync(path.join(d, 'provenance.jsonl'), 'fixture');
    if (mode === 'integrity') fs.appendFileSync(path.join(d, 'agent-board-${target}'), 'tampered');
    if (mode === 'missing-asset') fs.unlinkSync(path.join(d, 'agent-board-${target}'));
    `;
    try {
      fs.writeFileSync(path.join(dir, 'gh'), stub, {mode: 0o755});
      fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\nif [ "$CASE" = platform ]; then printf Darwin; else /usr/bin/uname "$@"; fi\n', {mode: 0o755});
      for (const mode of ['ok', 'missing-release', 'missing-asset', 'platform', 'download', 'attestation', 'commit', 'sums', 'integrity', 'revision']) {
        const temp = fs.mkdtempSync(path.join(dir, 'run-'));
        const output = path.join(temp, 'output');
        const result = spawnSync('{{ just_executable() }}', ['build-agent-board', mode === 'revision' ? '' : rev], {encoding: 'utf8', env: {...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GH_TOKEN: '', GITHUB_TOKEN: '', CASE: mode}});
        assert.equal(result.status === 0, mode === 'ok', `${mode}: ${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(path.join(temp, 'agent-board/bin/agent-board')), mode === 'ok', mode);
        if (mode === 'ok') assert.equal(fs.readFileSync(output, 'utf8'), `rev=${rev}\n`);
        else assert.equal(fs.existsSync(output), false, mode);
        console.log(`ok agent-board installer: ${mode}`);
      }
      for (const mode of ['ok', 'missing-release', 'draft', 'missing-asset', 'attestation', 'integrity']) {
        const marker = path.join(dir, 'selected');
        fs.rmSync(marker, {force: true});
        const result = spawnSync('{{ just_executable() }}', ['bump-agent-board'], {encoding: 'utf8', env: {...process.env, PATH: `${dir}:${process.env.PATH}`, CASE: mode, BUMP: '1', MARKER: marker, GITHUB_REPOSITORY: 'cgwalters-forge/tracker'}});
        assert.equal(result.status === 0, ['ok', 'missing-release', 'draft'].includes(mode), `${mode}: ${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(marker), mode === 'ok', `bump must verify before selecting: ${mode}`);
        console.log(`ok agent-board bump: ${mode}`);
      }
      const pins = fs.mkdtempSync(path.join(dir, 'pins-'));
      fs.mkdirSync(path.join(pins, '.github/workflows'), {recursive: true});
      fs.copyFileSync('Justfile', path.join(pins, 'Justfile'));
      const checkPin = () => spawnSync('{{ just_executable() }}', ['agent-board-pin'], {cwd: pins, encoding: 'utf8'});
      fs.writeFileSync(path.join(pins, '.github/workflows/a.yml'), `env:\n  AGENT_BOARD_REV: ${rev}\n`);
      assert.equal(checkPin().stdout.trim(), rev);
      fs.writeFileSync(path.join(pins, '.github/workflows/b.yml'), `env:\n  AGENT_BOARD_REV: ${'b'.repeat(40)}\n`);
      assert.notEqual(checkPin().status, 0);
      console.log('ok agent-board pin agreement and mismatch');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }

# The shared workflow check that ci.yml's lint job calls, run locally from
# a checkout of the forge's actions repository (its lint/README.md), the
# path relative to this repository's root; CONTAINER=podman without docker:
#   just lint ../actions
lint actions:
    {{ just_executable() }} --justfile "{{ actions }}/lint/Justfile" --working-directory . check
