# GitHub credentials

> This text is LLM generated.
> It records a read-only inventory taken on 2026-11-22 (tracker bb61962,
> actions main, agentic-job v0.6.16, agent-board 8eba8a1, devspace cd62032,
> GitHub API names and scopes only) and the plan to scope the credentials
> ([#1863](https://github.com/cgwalters-forge/tracker/issues/1863)). It holds
> no secret values or private addresses.

## Current state

| Credential | Storage | Holders | Purpose | Blast radius |
| --- | --- | --- | --- | --- |
| `CGWALTERS_BOT_PAT` | Organization secret, visible to tracker only, bound to no environment | Direct: poll (pass and pin bump), promote, midstream-sync (already in `agent-apply`), supervisor, review-send, release-train, weekly-blog, agent-board-pin, broker-probe. Forwarded as `SAFE_OUTPUTS_PAT`: dispatch, session and supervisor via the actions wrapper; weekly-eval via weekly-comparison and retro both call agentic-job's `apply.yml` directly with `notify: none` | Everything cgwalters-bot does: board and issue writes, forks, pushes, pull requests, promotion | Any tracker workflow on any branch can read it; the main-only guards are per-file `if:` conditions, not enforced. Whatever cgwalters-bot can do, in every repository it reaches |
| `APP_PRIVATE_KEY` | Repository secret of tracker | `app-token-check.yml` (in the `github-app` environment) | Mint scoped installation tokens of the org's App (#766, #768) | Any tracker workflow can read the key and mint tokens for every repository the App is installed on. The workflow's comment says it is an environment secret of `github-app`; that environment holds no secrets |
| octo-sts | Public octo-sts.dev; trust policies in cgwalters-forge/.github (`renovate`, `control-plane`) | poll.yml's `tracker-poll-reads` exchange | Short-lived token for the agent-board branch head and existing tracker pin PR reads only; not `One pass` | Inert: `tracker-poll-reads` has no policy and `POLL_READ_STS_DOMAIN` is unset, so the pin reads still use the PAT |
| Devspace `SAFE_OUTPUTS_PAT` | Repository secret of devspace, token type unknown | devspace's `agent.yml` explicitly forwards it to the wrapper at `@main` | Apply and wrapper status for devspace runs | The caller can read it outside `agent-apply`, which has no branch policy, and the wrapper code that receives it changes whenever actions' main does |

The agent job never receives the PAT. Apply runs only checked outputs, but
holds the PAT in its git credentials, forks into cgwalters-bot's account
(found through `GET /user`) and opens the pull request.

An App installation token with `contents: write` can push to a repository
covered by its installation if repository rules permit it. But installation
tokens, including those issued through octo-sts, act as the App's `[bot]`
login, not `cgwalters-bot`. They cannot substitute for that user in apply's
current fork path or satisfy agent-board's checks for that author. Keep the
user credential for the existing fork and promotion paths unless those
workflows and their identity checks are deliberately changed.

## Options

- **Read the writer credential only in protected jobs.** Store the apply
  credential as an environment-only secret read by the job that performs
  apply. Callers pass the name, not a caller-visible writer value. Route
  status through a separate narrow grant. This restricts who can read the
  writer credential, not what it can do.
- **octo-sts per-repository trust policies** keyed on the apply job's OIDC
  claims (repository, workflow ref, environment). Short-lived, narrowly
  scoped tokens, but not a drop-in for the existing user-identity paths.
- **App installation tokens** through agentic-job's existing role-bindings.
  Per-role permissions and a separate rate limit; same `[bot]` limits.
- **Brokered GitHub App user tokens.** A candidate for short-lived
  credentials that retain the user identity. Access is the intersection of
  the user's and the App's access. Verify that the App can cover both the
  bot-owned forks and the actual promotion targets before choosing it.

## Plan

Steps marked [OPERATOR] need an organization or repository admin; the others
are pull requests.

Before provisioning any replacement writer in steps 2 or 4, land reviewed,
immutable pins for the executable dependencies of every job that can receive
or influence the writer. This includes direct PAT jobs, reusable workflows,
and the actions, checkouts and downloaded tools they execute transitively.
Use commit SHAs or verify artifact digests against reviewed values. A branch
gate admits the caller's ref, not its dependencies; even an earlier setup
step can change what a later writer step runs. For example, both `poll.yml` and
`broker-probe.yml` must stop running `actions/tailscale@main` before their
replacement credentials are provisioned. If a dependency cannot be pinned,
remove it from the writer's execution path before provisioning the credential.

Use fresh environments for the replacement writers. Reruns keep the original
caller SHA and ref, so even an old run from `main` can request an environment
secret when its job starts. A fresh environment name alone is not a gate:
an old caller with a moving dependency could still reach it. [OPERATOR] Limit
the environments to `main` and require a deployment protection rule or reviewer
approval that checks the caller SHA in GitHub's run metadata against the
reviewed revisions with immutable dependencies. Disable gate bypasses. Deny
pre-cutover runs and reruns, and confirm the gate rejects a pre-cutover SHA
before adding secrets. Do not provision the writers if that gate cannot be
enforced. Unattended jobs need an automated rule, not manual approval. For
poll, verify that the successor run passes the gate without intervention.

1. [OPERATOR] Give the `github-app` environment a main branch policy if it
   lacks one, move `APP_PRIVATE_KEY` into it and delete the repository
   secret.
2. Replace tracker's shared caller secret with separate apply and status
   paths before retiring the organization grant:
   - First land and pin workflow support for independent status with the
     legacy apply writer. Dispatch's current wrapper has no status-only input,
     and its agentic-job v0.6.16 `policy.yml` notify and `apply.yml` conclude
     ignore `STATUS_TOKEN` in legacy mode. Supplying the secret alone cannot
     split status; turning on role bindings also switches apply to `PUSH_TOKEN`
     and `PUBLICATION_TOKEN` and is a separate migration (step 5).
   - With that support pinned, route policy-notify and `apply.yml`'s `conclude`
     to a separate credential with only the repositories and permissions
     needed for status. Both run outside the writer environment. Dispatch,
     session and supervisor go through the actions wrapper.
     Weekly-eval → weekly-comparison → `apply.yml` and retro → `apply.yml`
     bypass the wrapper and use `notify: none`. Check the `conclude`
     missing-data path even with notifications disabled; use the job token for
     in-repo status where it suffices, and the narrow status grant wherever
     cross-repo status is needed.
   - Wire `apply.yml` to the new protected environment. [OPERATOR] Store the
     replacement writer as `SAFE_OUTPUTS_PAT` there only. Replace the
     mappings from `CGWALTERS_BOT_PAT` on every apply call path with
     `SAFE_OUTPUTS_PAT: ${{ secrets.SAFE_OUTPUTS_PAT }}` at each reusable call
     boundary. GitHub [requires that mapping](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow)
     even though only the job in `apply.yml` that declares the environment can
     read its environment value. Do not map the writer name into policy-notify
     or provide a repository- or organization-level value for it. Migrate
     each direct PAT-using job in the table (including supervisor's direct
     uses) to a credential in a new protected environment it declares. Check
     the Tailscale OIDC trust rules for the new environment subjects and verify
     that both poll and broker-probe still join before retiring the old grant.
   - Verify a real fork PR, cross-repository status, and each direct job's
     required GitHub operations separately on bounded runs without the old
     credential. Check that finish edits the same cross-repository comment
     that start created. While STS is still disabled, use poll's new
     environment writer for the two pin-discovery reads and verify both
     work without the org PAT. This is also the fallback if STS is later
     disabled. [OPERATOR] Delete the org secret once no workflow depends on
     it and revoke the old token after confirming no other consumer uses it.
3. [OPERATOR] Follow the [README's scoped policy and negative check](../README.md#poll-read-credential-cutover-1679)
   before activating `POLL_READ_STS_DOMAIN`. After step 2 puts poll's `pass`
   job in an environment, use its actual environment subject, not the branch
   subject in the example. Keep the exact `ref` and `workflow_ref` constraints.
   Only the two pin-discovery reads leave the PAT; `One pass` still uses a PAT
   and the pin bump dispatch still uses the job token. Once enabled, failed
   exchange skips pin discovery instead of falling back to the PAT.
4. Devspace: after meeting the pinning and deployment gate prerequisites,
   use the same apply/status split and explicit apply-path mapping as in
   step 2. [OPERATOR] Provision the replacement only in the new environment,
   and remove the same-name repository secret before running the canary;
   otherwise the mapping still passes the old value to the wrapper. Verify a
   real fork PR and status separately within the existing bounds, and check
   that the new grants reach only the intended repositories and operations.
   Public-only is not a repository allowlist. [OPERATOR] Revoke the old token
   before expanding bounds to any cgwalters-forge targets. Verify permissions
   and repository coverage before admitting new targets.
5. Later (#766, #768): role-bindings through the wrapper, with status and
   review on App tokens; fork push and promotion on a cgwalters-bot
   credential, ideally broker-minted.

## Verified and inferred

Verified, from the workflows at bb61962 and the GitHub API: which workflows
read `CGWALTERS_BOT_PAT` and forward it, the secrets' storage and visibility,
that `github-app` holds no secrets, the octo-sts policies that exist, that
`POLL_READ_STS_DOMAIN` is unset, devspace's environment without a branch
policy and its `@main` wrapper reference.

Inferred, not checked: the token types (classic or fine-grained) of both
PATs; whether octo-sts subjects work across organizations for the devspace;
whether a fine-grained PAT can cover every repository and permission apply
and promotion need (fine-grained PATs reach only the owner's resources and
organizations that allow them); whether tracker's `github-app` and
`agent-apply` environments have branch policies, and that they can be
restricted to main without breaking a caller.
