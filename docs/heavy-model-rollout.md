# Dormant heavy-model dispatch

> This text is LLM generated.

This records tracker#1326's caller preparation and tracker#1614's evidence for
[agent-board#650](https://github.com/cgwalters-forge/agent-board/issues/650), not
activation, under [tracker#939](https://github.com/cgwalters-forge/tracker/issues/939).
The contract is agent-board's
[docs/dispatch.md at #653's merge](https://github.com/cgwalters-forge/agent-board/blob/77869b56bcfa02c2d03c79af365b2ad51c96de06/docs/dispatch.md#heavy-model-caller-contract).
On 5 November 2026 the open tracker PR inventory had no overlapping heavy caller
change; #1103 was already merged. tracker#1198 remains the separate ordinary-wrapper
review caller work. No review workflow, pin, scheduling setting or pool is changed here.

## One opt-in, one resolver

The threat is a plan selecting an arbitrary model, escaping a pool's budget/holds,
or silently receiving a weaker model. The only new control is string input
`effort`, empty by default, with exactly one nonempty value: `heavy`.
`.github/workflows/dispatch.yml` resolves through the pinned
`agent-board pools resolve` (tracker#1476), whose tests now cover these rules;
it reads `pools.json` from the trusted
caller checkout, never from the target or an agent-selected path. Board parsing,
pacing, holds, usage and broker accounting are not duplicated here.

An explicit pool selects its existing agent/model/budget. With empty effort, all
outputs and variable fallbacks are unchanged. For heavy with no explicit pool,
the existing `AGENT` (default `opencode`) and `AGENT_MODEL` variables must identify
exactly one pool by its **ordinary** agent/model pair. Missing model, no match or
ambiguous matches refuse before the wrapper starts. The wrapper's moving
deployment default is not guessed: use an explicit pool when `AGENT_MODEL` is
unset. Explicit pool wins over variables.

Only the resolved model changes. Explicit calls retain the pool's agent and
budget; inherited calls retain their existing empty agent/budget outputs (the
wrapper still supplies the inherited agent and its 500 AIC default budget), not
a newly inferred pool budget. For example, inherited claude does not acquire
3000 AIC just by requesting heavy. The original run title/pool identity,
concurrency, bounds, skills, apply environment and named-token handoff stay put.
No new slot or usage identity is created. Missing or malformed `heavy.model`
refuses, never falls back. Heavy review requests refuse: review's base-owned
model mapping and immutable wrapper pin belong to #1198, not this resolver.

## Parser inventory and offline evidence

These are source/pin observations, **not attestations of deployed runtime versions**.
Tracker was inspected at `aff303ddf7189dfa3cdc7416703ba71d0284c3da`.
The representative fixture adds only
`openai.heavy = {"model":"praxis/gpt-6-astra"}` to a temporary copy of production
pools. No shared pools file or pin was advanced to make a test pass.

| Consumer | Exact inspected source/pin | Result with representative fixture |
| --- | --- | --- |
| Dispatch resolver | tracker `.github/workflows/dispatch.yml` in this change | Default, explicit and inherited resolution exercised through the real workflow shell step; invalid effort/pool/variant fails with no outputs. |
| Ordinary wrapper | actions `d0fbda304bbd717057b30c2a44f39f29bd1b4e24`, `.github/workflows/cgwalters-agentic-job.yml`, followed at `main` | Does not parse pools.json. Source inspection: `inputs.model` wins over `vars.AGENT_MODEL` and deployment default, feeds target output then policy model. Policy/check/apply pin agentic-job `3f9f6425119b97bb3620a38fe0adc8e79be7dc8e` (v0.6.11); prepare/run use that policy source. Actual runner/summary-writer execution not exercised here: rollout blocker. |
| Usage/pass | agent-board `957cb9362a16f4fd13471c7d1c6252a0597eda6d`, `crates/board-forge/src/pass/usage.rs`, `pass.rs`, `poll/pace.rs` | Pass reads pacing pools from `.github/pass.json`, not inference pools.json (no `--pools` in poll's pass call). Tier parser accepts the additional object unchanged in the fixture. Pinned heavy weekly-budget and start-once/hold tests run offline; cost fixture prices actual summary model and leaves unlisted models null/unpriced. |
| Supervisor trigger/executor | Same agent-board pin, `supervise/agent.rs::Policy::new`, `poll/pace.rs::tiers` | Actual public parsers accept fixture with identical pool names/tiers. `supervisor.yml` session-settings jq reads only ordinary agent/model/budget; extra heavy is ignored. Trigger and executor share Policy, not separate strict pool structs. |
| Session | Same agent-board pin, `supervise/profile.rs::session` | Actual parser exercised with normal and heavy fixtures: identical outputs, still ordinary model. No effort is added to session/supervisor workflows. |
| Event review | tracker review pins actions `02d0342d682cf1c265668d7823009ae1936c4061`, `.github/workflows/cgwalters-review.yml` | No pools.json parser/input. Source inspection: event-only wrapper uses variables; agentic-job policy/check/apply pin `3f9f6425119b97bb3620a38fe0adc8e79be7dc8e`; admit/deployment/tailscale pin actions `c9a9501729bc306f3efdc188056b51149c1c9398`. No pin or review activation change. |
| Review UI usage allowance | review `4a8d672b01912db31d38912938af11929058eadc`, `src/github/usage.ts::parseBudget`, target in `src/github/usage-config.json` | Actual TypeScript parser imported with Node: fixture preserves $300 Mistral monthly allowance. **Deployed UI commit is unknown: blocker**, not permission to advance a source pin. |

The board binary pin is shared by poll, supervisor, session, review-send and the
other `AGENT_BOARD_REV` consumers (`just agent-board-pin` checks agreement).
Its Cargo.lock additionally pins safe-outputs to agentic-job
`009ac9883c9278293114c54f8376a5f40d88300f`; that is not the wrapper's runtime pin
and is not a pools parser. No strict pool struct was found on the inspected paths.
Unknown deployed consumers remain blockers even though inspected parsers tolerate
the new member.

Reproduce offline after obtaining read-only source checkouts at those revisions:

```sh
just test-heavy-consumers /path/to/pinned-agent-board
just test-heavy-review /path/to/inspected-review
AGENT_BOARD=/path/to/pinned-agent-board/target/debug/agent-board just test
env -u GH_TOKEN -u GITHUB_TOKEN CONTAINER=podman just lint /path/to/actions
```

The manual board recipe compiles the public-parser fixture against the workflow
pin and runs that pin's existing actual-model pricing, weekly-budget refusal and
heavy/default pacing/hold/start-once tests. It does not reimplement those policies.
The review probe prints its inspected SHA; compare it with this inventory and the
actual deployed UI before drawing a compatibility conclusion. Network is needed
to obtain source/dependencies/images, not for fixture execution or inference.

## Activation blockers owned by #650

### Evidence checked on 13 November 2026

This updates the historical offline inventory above using the
[8 November triage](https://github.com/cgwalters-forge/agent-board/issues/650#issuecomment-6719079210).
That triage is context, not a runtime attestation. **The model is recorded, but
the astra pool's usage reading and seven-day spend could not be verified with
this run's access. Production pools.json therefore stays unchanged**, including
astra and fable; no `openai.heavy` key is added.

1. **Caller and summary writer: source and live artifact confirmed.**
   [tracker#1334](https://github.com/cgwalters-forge/tracker/pull/1334) merged the
   dormant caller. At the inspected tracker commit
   [`08de6a4c`](https://github.com/cgwalters-forge/tracker/blob/08de6a4c9c6cf9eee975e1f91fc10648d0c184f2/.github/workflows/dispatch.yml#L62-L67),
   `effort` is still empty by default; the
   [resolver](https://github.com/cgwalters-forge/tracker/blob/08de6a4c9c6cf9eee975e1f91fc10648d0c184f2/.github/workflows/dispatch.yml#L299-L312)
   passes it to the pinned board binary. The ordinary
   [wrapper at `428fc617`](https://github.com/cgwalters-forge/actions/blob/428fc617f985f8c5c4aabaf22afdbf2dfc744010/.github/workflows/cgwalters-agentic-job.yml#L512)
   now pins agentic-job `427ce2295925654be9c35e91ca5cee91bbc2c9ea`, not the older
   v0.6.11 pin in the offline inventory. Its
   [summary writer](https://github.com/cgwalters-forge/agentic-job/blob/427ce2295925654be9c35e91ca5cee91bbc2c9ea/crates/agentic-job/src/run/summary.rs#L455-L457)
   writes `digest.model.clone().or_else(|| measured.model.clone())`: the
   agent-reported session model, falling back to the requested model. This is
   not independent provider verification.

   The successful astra-pool
   [run 43524496794](https://github.com/cgwalters-forge/tracker/actions/runs/43524496794)
   (13 November, tracker#596) references those same wrapper/runtime SHAs in its
   [run metadata](https://api.github.com/repos/cgwalters-forge/tracker/actions/runs/43524496794).
   Its `dispatch-triage-agent-run`
   [artifact 14084328794](https://github.com/cgwalters-forge/tracker/actions/runs/43524496794/artifacts/14084328794)
   contains `summary.json` with `model: praxis/gpt-6-astra`, `aic_budget: 500`,
   `tokens_source: praxis`, and finished broker usage with 22 requests and
   `unmetered: 0`. Thus the current pinned runner actually records the selected
   model for an ordinary astra run; explicit/inherited **heavy** runs are still
   untested.

2. **Review UI: deployed commit identified and parser checked.**
   [Deployment 7778346699](https://api.github.com/repos/cgwalters-forge/review/deployments/7778346699)
   names `dcd3607737cd96f00f2fa241e212b7b9192b173e` for `github-pages`; its
   [statuses](https://api.github.com/repos/cgwalters-forge/review/deployments/7778346699/statuses)
   record success at 22:49:51Z, with the
   [deployment job](https://github.com/cgwalters-forge/review/actions/runs/43522301086/job/132219666675)
   and the review UI URL. The legacy Pages builds endpoint returned HTTP 404;
   the successful deployment record supplies the commit instead.
   `just test-heavy-review /tmp/opencode/review` passed at that same SHA (also
   review main when inspected): the actual `parseBudget` accepts the heavy
   fixture and preserves the $300 Mistral allowance. The probe's generic
   “deployed UI revision remains unverified” output does not inspect deployments;
   the separate record above identifies this deployment. No UI pin was advanced.
   The earlier consumer inventory remains source evidence, not an exhaustive
   attestation of unknown out-of-tree readers.

3. **Hosted only; routed heavy is out of scope, not a prerequisite.**
   bootc-dev's
   [`agent.yml` at `cd62032d`](https://github.com/bootc-dev/cgwalters-devspace-sandbox/blob/cd62032dbd948ca9fd5b9286ee0c0db74720b963/.github/workflows/agent.yml)
   has no `effort` dispatch input and resolves only the ordinary model. Sending
   that unknown input is refused by GitHub, not silently downgraded. Heavy here
   is limited to tracker's hosted dispatch, not devspace, native Forgejo,
   session/supervisor defaults or review. No external workflow/config change is
   proposed or required for this hosted-only scope.

4. **Pricing: metered run cost present; required pool accounting still missing.**
   The same astra artifact reports 66,855 input, 930,176 cache-read and 3,381
   output tokens. Its `cost` is USD 1.7436, `basis: list`, `source: metered`,
   `prices: 2026-10-29`, `partial: false`, `estimated: false`, with model entries
   `gpt-6-astra: 1.7433` and `gpt-6-luna: 0.0002`. This is positive evidence of
   metered cost for the astra run, not proof of the broker's deployed weekly
   price table or the board's astra pool reading. Rounded model costs and mixed
   model totals alone cannot independently establish token-price math.

   The review source
   [locates usage in bot-ops#1](https://github.com/cgwalters-forge/review/blob/dcd3607737cd96f00f2fa241e212b7b9192b173e/src/github/config.ts#L170-L176).
   `gh api repos/cgwalters-forge/bot-ops/issues/1/comments` returned HTTP 404
   with this run's token. The public
   [pass 43525295623](https://github.com/cgwalters-forge/tracker/actions/runs/43525295623)
   log's `One pass` output at 23:25:04Z reports only claude/openai usage and links
   the [usage comment](https://github.com/cgwalters-forge/bot-ops/issues/1#issuecomment-5951584283);
   its artifact listing contains only `pass-state`, not a spend snapshot.
   **Exact remaining gap:** a readable recent astra usage reading and
   trailing-seven-day `spend.runs` with actual-model price/rates, token-price
   math, unchanged grant/holds and single-slot identity. Missing-price
   unpriced/no-reading refusal and weekly-limit/pacing behavior remain required;
   offline fixtures do not establish production accounting. Do not change
   broker policy or infer pricing coverage merely from the astra pool name.

5. **Review isolation unchanged.** #1198 remains separate. Keep review.yml's
   reviewed pin, base-owned mapping and credential-free execution; no review
   scheduling or heavy review dispatch is enabled by this work.

### Before #650 closes

After the accounting gap is resolved, a separately reviewed change may add only
`openai.heavy = {"model":"praxis/gpt-6-astra"}` and run
`just test-dispatch-pool` and `just test`, reporting actual results. The former
recipe is absent at the inspected tracker commit (resolution moved to the pinned
board binary); do not claim it passed or advance pins to manufacture a result.

Then one explicit `pool=openai, effort=heavy` hosted run and one inherited
`effort=heavy` hosted run (ordinary `AGENT`/`AGENT_MODEL` uniquely matching openai)
must show selection of `praxis/gpt-6-astra` in resolver output and `summary.json`,
unchanged pool/slot identity and grant/holds, and priced actual-model usage in
the seven-day spend with checked token math. Explicit agent/budget must stay
openai's; inherited agent/budget fallbacks must remain unchanged. Board's
`docs/job-plans.md` must also stop telling callers to omit effort before
[agent-board#650](https://github.com/cgwalters-forge/agent-board/issues/650) closes.
These runs were not dispatched here. This is evidence, **not activation**, and
heavy is not one of tracker#939's five gates.

No live dispatch, broker policy, credentials, rulesets, external repository files
or settings were changed. Rollback of future heavy activation is to stop heavy
plans and remove the heavy opt-in/key; ordinary models and callers stay unchanged.
