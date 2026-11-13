---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance; Generated-by: AI for entirely generated work; no tool or model names
dco: yes (DCO app on PRs; promote checks live branch rules and checks)
sources:
  - repo: composefs/composefs-rs
    path: AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: composefs/composefs-rs
    path: REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
  - repo: composefs/composefs-rs
    path: .claude
    sha: ea3212ee37b79e5ad335f63163d2f6a79656f088
  - repo: composefs/composefs-rs
    path: .gemini
    sha: e74adbff6981febb684371fcd5c9a26add88638f
checked: 2026-11-11; default-branch sources and policy-name inventory rechecked against GitHub
rebase: any
---

# composefs/composefs-rs contribution policy

> This text is LLM generated.

Seeded from [homegit's record](https://github.com/cgwalters/homegit/blob/c027d9f4/upstream-policy/composefs/composefs-rs.md).
[AGENTS.md](https://github.com/composefs/composefs-rs/blob/main/AGENTS.md)
is shared with bootc: generated code and text are allowed with human review,
generic AI attribution and sign-off only on explicit human action or request.
Its prohibition on tool/model names takes precedence over REVIEW.md's
conflicting attribution wording. Changes over about 500 substantial lines
should first have a design issue. There is no CONTRIBUTING.md.

Bot-written PR text is permitted, subject to operator review. The operator's
promotion request authorizes their sign-off, not this record. The pinned
promoter implements the operator's
[10 November decision](https://github.com/cgwalters-forge/tracker/issues/1464#issuecomment-6782560935)
to allow a clean promotion rebase without another approval; conflicts hold.

The inventory covered the root, .github, docs and doc in this repository and
composefs/.github (absent). Directory source IDs cover the agent helper files;
symlinked CLAUDE.md aliases are not recorded as independent file sources.
