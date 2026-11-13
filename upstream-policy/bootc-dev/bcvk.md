---
verdict: bot-ok
ai-trailer: Assisted-by: AI for substantial assistance; Generated-by: AI for entirely generated work; no tool or model names
dco: no (no written DCO requirement found; operator sign-off required at promotion independently of live DCO checks)
sources:
  - repo: bootc-dev/bcvk
    path: AGENTS.md
    sha: 61261301421a394b167c737939dc27a3ce7f382a
  - repo: bootc-dev/bcvk
    path: REVIEW.md
    sha: 3068dd57b2c3ef45cb1c3147442e8d63505bb643
  - repo: bootc-dev/bcvk
    path: REVIEW_GOLANG.md
    sha: 11993395d60a99bd907bb42ef4e8ba69a83080d5
  - repo: bootc-dev/bcvk
    path: REVIEW_RUST.md
    sha: ac7983b541797fe01d8d2eb8427a0aac5fa4e6bd
  - repo: bootc-dev/bcvk
    path: docs/HACKING.md
    sha: 271bcef4dd1744cb7f5de5c335af568c6a4663eb
  - repo: bootc-dev/bcvk
    path: .claude
    sha: ea3212ee37b79e5ad335f63163d2f6a79656f088
  - repo: bootc-dev/bcvk
    path: .gemini
    sha: e74adbff6981febb684371fcd5c9a26add88638f
  - repo: bootc-dev/bcvk
    path: .github/agents
    sha: 6bbb2d214ab5c0dded74153f51268425e029088b
checked: 2026-11-12; default-branch sources and policy-name inventory checked against GitHub
rebase: any
---

# bootc-dev/bcvk contribution policy

> This text is LLM generated.

[AGENTS.md](https://github.com/bootc-dev/bcvk/blob/main/AGENTS.md) permits
generated code and text with human review, generic AI attribution and sign-off
only on explicit human action or request. Its prohibition on tool/model names
takes precedence over the conflicting attribution requests in REVIEW.md and
docs/HACKING.md. Large changes should first have a design issue.

Bot-written PR text is permitted, subject to operator review. The operator's
promotion request authorizes their sign-off, not this record. The pinned
promoter adds it independently of DCO detection and cleanly rebases behind
heads without another approval; conflicts hold.

The inventory covered the root, .github, docs and doc (absent) in this
repository and bootc-dev/.github (absent). Directory source IDs cover the
agent helper files. No CONTRIBUTING.md or DCO text was present in that inventory.
