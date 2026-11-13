# Architecture pattern library 0.1.0

> This text is LLM generated.

Source IDs refer to the pinned public files and sections in
[README.md](README.md) and [references.json](references.json). These are project
conventions/designs plus explicitly identified cross-project inferences, not
mined operator rules. Every Good/Bad pair below is **illustrative**, not code
quoted from a historical PR or evidence of a historical defect. Use the target
project's contract when it differs; cite the applicability argument, not merely
the authority of systemd.

## AR-01: One owner for an error's public report

**Principle:** Preserve the failure through composable helpers; the boundary
that decides user-visible policy owns non-debug logging. Avoid duplicate reports
and success-looking failures that make retry/recovery decisions unreliable.

**Scope/exceptions:** systemd uses negative errno, non-logging library routines,
and logging/non-logging function contracts. Debug logging is permitted; some
constructors/lookups return NULL. Translate the ownership principle, not errno
or C syntax, to Rust or GLib. Independent failures may deserve distinct reports.

**Source:** systemd, S-style, Error Handling and Logging. Its logging section
explicitly distinguishes logging-to-non-logging and logging-to-logging calls.
This is a project convention, not demonstrated operator preference.

**Good (illustrative):** `read_config()` returns a contextual error; `main`
chooses whether an absent optional config is acceptable and logs a real failure
once, without discarding its cause.

**Bad (illustrative):** a helper logs an optional missing file as fatal, returns
a generic failure, and two callers log it again. The caller cannot distinguish
retryable I/O failure from a configuration error.

## AR-02: Lifetime follows explicit ownership transfer

**Principle:** One owner releases each resource on success, failure and partial
initialization. Borrowing and ownership transfer must be distinguishable. File
descriptors should not accidentally survive exec and confer authority on children.

**Scope/exceptions:** Close-on-exec is the default for newly acquired fds, not a
ban on deliberate stdio/socket activation inheritance. Check the API's documented
consumption-on-failure contract. Cleanup must not hide errors needed for data
durability; safe close is not proof that prior writes reached disk. Reference
counting is valid when ownership really is shared; cycles still need a policy.

**Source:** systemd, S-style Destructors/File Descriptors; S-fd-h `_cleanup_close_`,
`TAKE_FD`, `close_and_replace`; S-fd-c `safe_close` and `rearrange_stdio`.
Historical source evidence: `safe_close` preserves errno and returns `-EBADF`;
`rearrange_stdio` documents consuming inputs above fd 2 on both success and
failure, and deliberately turns off CLOEXEC for stdio. Those facts explain the
exception; they are not operator-review evidence.

**Good (illustrative):** acquire an fd with CLOEXEC into a cleanup owner, validate
the object, then explicitly transfer it into the returned object only on success.
A partially initialized destructor tolerates missing fields.

**Bad (illustrative):** both a stack cleanup and the returned object believe they
own the fd; an error path closes it twice, potentially closing a reused descriptor.

## AR-03: Compose through a declared stable interface

**Principle:** Separate mechanisms behind narrow documented contracts so tools
can be composed without depending on each other's private representation. Identify
who consumes the interface and preserve compatibility for those consumers.

**Scope/exceptions:** Not all output is an API. systemd distinguishes documented
machine output from human status output and private protocols. Internal APIs can
change with their callers. A new abstraction needs a concrete consumer; small
composable tools do not require splitting every function into another process.

**Source:** systemd S-interface, stability promise and independent programs;
composefs C-design, metadata/data separation and the `mkcomposefs`/mount helper
roles. The shared cross-project principle is a synthesis; the documented systemd
stability promise does not automatically apply to composefs or bootc internals.

**Good (illustrative):** a consumer reads documented machine properties, accepts
additive fields, and uses a single image-reference parser shared with its fetcher.

**Bad (illustrative):** a caller scrapes human `status` text or edits a tool's
private on-disk bookkeeping; a harmless display or layout change breaks updates.

## AR-04: Activation, ordering and readiness are different edges

**Principle:** Model the dependency graph and failure semantics, not just a
sequence that happened to work. Starting a prerequisite, ordering after its start,
and ensuring it remains available are separate requirements.

**Scope/exceptions:** systemd `After=` alone does not pull a unit in; `Requires=`
alone does not order it. `Wants=` tolerates failures; default/implicit dependencies
may supply edges. `Requires=` does not guarantee continuous active state; see
`BindsTo=` plus `After=` when that is truly required. Readiness depends on the
service type/protocol. Prefer socket/bus activation where it removes explicit
edges; do not make optional services mandatory without a reason.

**Source:** systemd S-unit Description, Automatic dependencies and the Wants=,
Requires=, Before=/After=, BindsTo= entries. A documented project model, not an
operator preference or a generic instruction to add dependencies everywhere.

**Good (illustrative):** where a mandatory initializer must complete first, pull
it in and order the consumer after its completion; test failure and shutdown
ordering as well as startup. Explain any implicit edge being relied upon.

**Bad (illustrative):** sleep five seconds before opening an assumed-ready
socket, or add only `After=initializer.service` and assume it starts the initializer.

## AR-05: Stage, commit, and name the rollback boundary

**Principle:** Prepare a new coherent state without damaging the active one;
identify the publication point, durability requirements and recovery from each
interruption. State explicitly which mutable data is outside the transaction.

**Scope/exceptions:** OSTree's deployment/boot configuration transaction is not
a transaction for arbitrary application databases. bootc's deployed `/var` is
shared persistent state, while `/etc` has deployment-specific merge behavior;
transient configuration changes the contract. Atomic rename alone is not a
durability argument. A rollback that cannot undo an external side effect must
say so and provide a compatible recovery/migration strategy.

**Source:** ostree O-upgrade, deployment assembly and bootversion swapping;
O-rollback, selecting previous boot entries; bootc B-state, build vs deployment,
`/etc` and `/var`. These are documented designs; the general staging principle is
a synthesis, not a blanket promise of automatic boot-health rollback.

**Good (illustrative):** prepare and validate the new deployment, publish boot
selection only once it is usable, retain the old bootable deployment, and test
power-loss windows plus an old binary opening the retained application state.

**Bad (illustrative):** change the live tree and database schema in place, then
promise a boot-entry switch rolls both back; garbage-collect rollback data before
publication is durable.

## AR-06: Integrity and authority need explicit trust roots

**Principle:** Identify the untrusted actor, controlled inputs and privileged
operation before proposing a control. Integrity checks need an independently
trusted expected value; resource handles do not automatically make inputs safe.

**Scope/exceptions:** composefs integrity is optional/configuration-dependent;
content addressing alone is not authentication. Mount setup and writable overlays
have separate authority/state questions. Avoid speculative hardening: a control
must stop a concrete path to harm in the target deployment and fit its trust model.
Do not assume the same controls are needed for public ephemeral read-only data.

**Source:** composefs C-design Filesystem integrity and bootable hosts (data
digests plus a trusted metadata image digest); systemd S-fd-c
`fd_verify_safe_flags_full` documents the threat of an extrinsic O_PATH fd tricking
a privileged service into access the client lacks. S-style Runtime Behaviour
requires bounds on user-allocatable resources. The general authority framing is
a synthesis, not evidence that the operator asks for every possible control.

**Good (illustrative):** a privileged consumer checks a metadata digest obtained
from its trusted boot chain and then validates backing-file digests; a received fd
is checked against the operation's allowed access modes and ownership contract.

**Bad (illustrative):** accept both a filesystem image and its purported trusted
digest from the attacker, or reopen a client's O_PATH fd with stronger access and
claim that fd passing proves authorization.
