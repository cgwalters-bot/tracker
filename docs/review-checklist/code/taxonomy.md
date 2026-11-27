# Candidate rule tags

> This text is LLM generated.

These are the tags that per-shard label files may use (see [README.md](README.md)).
They are candidates, not checklist items: the checklist keeps only rules raised on
at least 3 distinct training PRs, and labelling may show that some tags should be
merged or dropped. Changing this list after labelling starts means relabelling
the shards already done, so add a tag only for a recurring request that none of
these covers.

The list was drafted by reading the 1,273 non-empty training records of the 400
training PRs printed by the helper's `sample` mode with seed
`review-checklist-taxonomy-v1` and N 400 (its stdout, 400 newline-terminated
URLs, has SHA-256
`05916702a8cd1eac357571afb039501900b1d6e11a458062dbf588d59a233e77`). No held-out
record was read.

A tag marks a request the operator made on that PR, whether or not the author
acted on it. Approvals, CI commands (`/lgtm`, `/override`, `/retest`), thanks and
design discussion with no reusable rule get no tag; many PRs have none. Prefixes
show where an item would go: `rust-`, `c-`, `shell-`, `python-` and `go-` for
the language appendices, `commit-` for commit messages, `os-` for
project-specific image-based OS conventions, and no prefix for the core list.

## Errors

- `error-propagate`: Propagate errors with `?` or the project's throw helper instead of `unwrap`/`expect`, panics, exiting with success, or hand-written `Ok`/`Err` matches.
- `error-no-swallow`: Do not ignore or mask errors (`|| true`, `2>/dev/null`, discarded results, catch-all matches); handle only the expected case, such as `ENOENT`, and propagate the rest.
- `error-log-xor-propagate`: Either log an error or return it, not both, and keep printing out of library code so that only the CLI writes output.
- `error-context`: Give errors useful context and values (inline format arguments, the offending input) without repeating context at every level of a recursive call.
- `assert-invariants`: Use assertions for conditions that cannot come from external input, and reserve runtime errors for input that can be wrong.

## Code shape

- `reduce-nesting`: Use early returns, `let ... else` and folded conditionals to avoid deep nesting and rightward drift.
- `remove-dead-code`: Delete unused, obsolete or unnecessary code, options, clones and comments rather than carrying them.
- `dedupe-code`: Factor repeated logic into one helper once it appears a third time, and always for security-relevant comparisons.
- `reuse-existing-helper`: Use the helper, module, trait or crate the project or its ecosystem already has instead of writing a new one.
- `named-constants`: Replace magic numbers and strings with named, documented constants or `#define`s.
- `efficiency`: Avoid needless work: extra allocations and copies, `open` where `stat` will do, re-parsing, uncached regexps, unlocked stdout, or O(data) steps in a path meant to be cheap.
- `follow-project-convention`: Match the conventions already used in the surrounding code, such as its logging macros, helper traits and error types.
- `run-formatter`: Run the project's formatter (`cargo fmt`, GNU style for C) and follow its naming style, such as snake_case in Rust.

## Rust

- `rust-combinators`: Prefer `Option`/`Result`/iterator combinators (`map`, `and_then`, `ok_or_else`, `then_some`, `extend`, `filter`, `cloned`, `collect`) over hand-written matches and loops.
- `rust-std-helpers`: Use standard helpers (`split_once`, `strip_prefix`, `lines`, `trim`, `fs::read_to_string`, `read_dir`, `OnceLock::get_or_init`) instead of hand-rolled parsing or global state.
- `rust-utf8`: Choose `String`/`Utf8Path` or bytes on purpose: reject non-UTF-8 where the system forbids it, and convert lossily only to display output from other programs.
- `rust-types`: Pick types that state intent, such as `Option<Vec<T>>` for all-or-nothing, an enum instead of several bools, `Ok(())` to discard only unit, `const` constructors for literals.
- `rust-async`: Do not mark functions `async` without an `await`, and keep blocking work off the async runtime.

## C

- `c-autocleanup`: Use `g_autofree`/`g_autoptr`/`glnx_autofd` initialised to `NULL`, avoid `goto` cleanup in new code, and open file descriptors with `O_CLOEXEC`.
- `c-error-convention`: Follow the GError/`glnx_throw` convention: return `FALSE` early on error, keep the error branch as the `if`, and set errors through one helper.
- `c-modern-style`: Use C99 declare-and-initialise, explicit booleans from bitflags, correct types (`ssize_t`, `const char *`) and no pointer arithmetic on strings by accident.

## Shell, Python and Go

- `shell-strict`: Fail on errors: `pipefail`, `curl -sSLf`, checking exit status (for example `journalctl --grep` exits 0 without matches), no unquoted expansion.
- `shell-readable`: Keep shell legible: heredocs such as `RUN <<EORUN` instead of `&& \` chains, simple positional argument parsing, and no shell generated from other languages without proper quoting.
- `python-idioms`: Use Python idioms such as `with open(...)`, f-strings and `raise SystemExit(...)`.
- `go-idioms`: Follow Go idioms, such as nil slices over empty ones, returning `error`, and code that passes the race detector.

## Design and systems

- `right-layer`: Put logic in the component that owns it (lower it into the library, the OS image, the installer or upstream) rather than patching around it in a caller.
- `detect-not-hardcode`: Detect features and read configuration instead of hardcoding architectures, distributions, versions, images, users or addresses.
- `prefer-library-call`: Use a library or system call (`rustix`, `std::fs`, `cap-std`) instead of spawning `ls`, `kill`, `truncate` or similar, and run real subprocesses through the project's helpers.
- `fd-relative-fs`: Work relative to directory file descriptors (`cap-std`, `openat`, `*at` calls) rather than absolute paths or the process working directory.
- `untrusted-input`: Treat external input as hostile: checked arithmetic, length checks, digest comparison through one helper, sandboxing parsers of untrusted archives.
- `avoid-races`: Avoid races and sleep-based workarounds: atomic writes, using a returned digest instead of push-then-inspect, bounded retries with stated limits, graceful termination before SIGKILL.
- `secure-files`: Avoid predictable `/tmp` paths and use restrictive modes (`0700`) and `/run` for runtime state.
- `dependency-weight`: Weigh new dependencies, shared libraries, services and binaries against their maintenance cost, and prefer maintained ecosystem crates over obscure ones.
- `no-binaries-in-git`: Never commit compiled binaries or build output to a repository; build them or fetch them from a release.
- `api-surface`: Keep APIs private or `pub(crate)` unless needed, document public ones, and do not break a public API or a stable CLI without a version bump.
- `cli-design`: Shape command-line interfaces deliberately: enum-valued options over several flags, `--experimental` gating, hidden options, and an example in the help or man page.
- `user-facing-messages`: Make messages and prompts clear, specific and actionable, without stutter, jargon or a trailing period that breaks a URL.
- `os-image-layout`: Follow image-based OS layout: shipped content in `/usr`, `/etc` for configuration, `/var` starting empty and populated by tmpfiles.d, `/run` for runtime state, nothing in `/opt`.
- `os-prefer-systemd`: Use systemd mechanisms (units with ordering and conditions, generators, credentials, static enablement) instead of ad-hoc scripts, dracut initqueue hooks or forking.

## Naming and documentation

- `clear-naming`: Use precise, unambiguous names with the proper capitalisation of product names (SELinux, OpenShift).
- `comment-why`: Comment why code exists, with links to issues, and remove comments that are wrong or merely repeat the code.
- `docs-update`: Update documentation and man pages with the change, fixing generated docs at their source.
- `typo`: Fix spelling and grammar mistakes in code, docs and messages.

## Process

- `commit-split`: Split preparatory, unrelated or refactoring changes into their own commits or pull requests.
- `commit-message`: Write commit messages that say why, with a short, topic-prefixed subject.
- `add-tests`: Land changes with unit or integration tests that cover them.
- `hermetic-tests`: Keep unit tests from reading or changing global host state; use a temporary root, and move system-level checks to integration tests.
- `ci-design`: Keep CI reliable and proportionate: pinned inputs, cheap gating jobs, optional or periodic expensive ones, and no flaky gates.
