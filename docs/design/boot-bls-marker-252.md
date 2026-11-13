# Directory-local BLS semantics: contract for tracker #252
> This text is LLM generated.

Part of [#252](https://github.com/cgwalters-forge/tracker/issues/252). This is a
**proposed engineering contract**, not an implemented marker or consumer. Merging
it leaves #252 open. No runtime code, dispatch bounds, upstream mutation or
bootc PR #2515 rebase is included. Sources were inspected on 5 November 2026;
no VM reproduction was run.

The concrete failure to prevent is selecting the wrong offline default when
GRUB's descending filename priority disagrees with BLS `sort-key` priority.
An ESP-global bootloader-ID shortcut also mislabels classic GRUB entries on a
different boot filesystem. The single mechanism is a directory-local
`entries.srel` semantics marker. New marker publication must initially be
opt-in to a coordinated installer transaction, not automatic adoption of every
existing directory; this document adds no option or enabled behavior.

## Decision and verified baseline

The [decision context](https://github.com/cgwalters-forge/tracker/issues/252#issuecomment-6640217617)
requires markers beside the entries they describe, with ownership and persistence
rules. It and the linked spec analysis are context, not runtime evidence.

The pinned [BLS specification][bls] defines `/loader/entries.srel` **next to**
`/loader/entries/`, not inside it. Exact ASCII `type1` followed by a UNIX newline
asserts conformance; another string means other semantics; absence permits no
assumption. `grub-bls` is our proposed non-conformance identifier, not a standard
bootloader identity or a new claim that GRUB implements all BLS semantics.

Verified current paths (pins and line ranges below):

* **bootupd:** install selects the bootloader and installs components/static
  configuration, then records installed state [U1]. EFI install mounts the target
  ESP and copies the selected loader's EFI files; update applies EFI-tree diffs,
  including colocated ESPs [U2]. BIOS has a separate GRUB install/update path [U3].
  These paths do not establish a directory-local marker lifecycle. EFI selection
  or an EFI-file update alone cannot establish where classic GRUB reads entries.
* **bootc:** the bootupd caller exposes the real target `/boot` in the chroot
  [B1]. Native-composefs Type #1 creation puts classic GRUB entries on its boot
  filesystem, but grub-cc/systemd-boot entries on the mounted ESP. Upgrades prepare
  `loader/entries.staged`, later exchanged with `entries` [B2, B3]. Its current
  sorter uses BLS configuration comparison for Systemd and descending filename
  comparison for **both** Grub and GrubCC. Classification consults EFI loader
  information and ambient filesystem probes and caches identity per invocation
  [B4]. This is not a target-root marker reader. Current offline `mount --latest`
  selects composefs state-list element zero or OSTree deployment-list element
  zero, rather than resolving a marker-aware boot default [B5]. Do not describe
  that mount path as already fixed by a sorter change.
* **OSTree:** a full bootversion change removes/recreates the inactive
  `loader.N/entries`, writes entries and bootloader configuration, syncs, then
  renames `loader.tmp` over `loader`. Some deployment changes update bootlinks
  without rewriting entries [O1, O3]. Bootfs cleanup removes unreferenced payloads,
  not the sibling marker [O2]. A one-shot write through `loader` covers only one
  slot, not a persistence contract.
* **systemd:** `bootctl` creates `type1\n` under the selected `$BOOT/loader` only
  if no marker exists, including a no-overwrite publication race check [S1].
  `kernel-install` automatic layout detection reads the selected boot root's
  marker: first line `type1` selects `bls`; another first line selects `other`;
  absence falls through to entry-token-directory detection; other read errors
  fail. Explicit layout and UKI detection precede that check. `$BOOT` selection
  prefers configured root, then XBOOTLDR, then ESP, then `/boot` [S2]. Its first-line
  parser is less strict than the proposed bootc reader below. `bootctl remove`
  removes marker paths on ESP and XBOOTLDR without checking for `type1` content
  [S3]; it is not a safe generic ownership-handoff operation.

## Proposed format, scope and ownership

The only two recognized byte sequences are:

| Semantics | Escaped bytes (not literal backslash characters) | Hex bytes |
| --- | --- | --- |
| GRUB BLS dialect | `grub-bls\n` | `67 72 75 62 2d 62 6c 73 0a` |
| Conformant Type #1 | `type1\n` | `74 79 70 65 31 0a` |

No BOM, CR, spaces, NUL, extra lines or missing final LF. No marker for a
Type #2-only/UKI-only directory: it does not describe arbitrary `EFI/Linux`
contents. Type #1 entries that reference UKIs still have Type #1 directory
semantics and need the applicable marker.

For an entries directory `D`, the marker is its sibling `entries.srel` in
`D`'s loader directory. On OSTree these are physically
`boot/loader.0/entries.srel` and `boot/loader.1/entries.srel`; resolving
`boot/loader/entries.srel` reaches only the active one. Never place it at the
root of the ESP, or in `entries/`. Separate ESP and XBOOTLDR loader directories
are independent domains even on the same disk. An ESP marker cannot label
`/boot/loader/entries` on another filesystem. Mount aliases of the same physical
directory are one domain, not two votes.

| Installed consumer | Native composefs entry domain and writer | OSTree entry domain and writer | Bytes |
| --- | --- | --- | --- |
| Classic GRUB (EFI or BIOS) | Actual GRUB boot filesystem's `loader`; bootc persists | Both `boot/loader.N`; libostree persists | `grub-bls\n` |
| grub-cc | Actual ESP `loader` used by bootc; bootc persists | Both `boot/loader.N` **if wired to that consumer**; libostree persists | `grub-bls\n` |
| systemd-boot | Actual `$BOOT/loader` (currently ESP in bootc); bootc persists, coordinating bootctl | Both `boot/loader.N` **only with a supported slot-aware integration**; libostree persists | `type1\n` |

The last two OSTree cells specify the required ownership if support is added,
not proof of current install support. Bootc currently requires bootupd for
  OSTree GRUB installs (apart from architecture-specific paths) and rejects
  Systemd/GrubCC/Ukiboot there [B6]. Merely writing
`type1` does not make an unsupported loader/slot combination bootable; reject
that installation until the integration is tested. Do not move entries to the
ESP as an incidental marker change. XBOOTLDR support likewise uses its actual
entries root, not bootc's current ESP assumption.

**Owner handoff:** bootupd owns the installed bootloader's semantics decision
when it installs that loader. Its installer must receive the caller-resolved
entry domain(s), selected consumer and backend, validate them, and publish the
initial marker there. It must not guess domains from firmware or scan every
ESP. Bootc owns coordinating the transaction and passes that decision to its
entry writer or to libostree as a deployment-write input. Libostree owns
recreating/preserving each slot's marker; bootc owns composefs persistence.
Neither promotes the marker into bootloader identity. With direct systemd-boot
installation, bootctl is the initial `type1` writer, bootc preflights and verifies
the result, then takes the same persistence role. Bootupd's systemd-boot path
uses the same `type1` contract; no competing writer may overwrite a foreign
value. This is a proposed interface, not an existing bootupd CLI flag.

Possession of recognized bytes is not ownership. Fresh empty installer-created
domains can be claimed explicitly. Existing unmarked domains require explicit
adoption with an inventory of entries and configured consumer; do not infer
ownership from `.conf` suffixes. Matching recognized markers may be preserved
in shared domains, but do not authorize deleting other owners' entries.
Unknown/foreign values, malformed markers and incompatible recognized values
are preserved byte-for-byte, including in inactive OSTree slots; automatic
installation/adoption fails before destructive entry-directory recreation.
No default overwrite/repair switch is part of this contract.

## Publication, deployment and recovery

1. Under the target deployment/bootloader locks, resolve the actual mounted boot
   domains and preflight **all** affected markers, entries and selected consumer.
   For OSTree check both slots, including an existing inactive slot before its
   `entries` tree is removed. Before any bootctl call, check its selected `$BOOT`
   so create-if-absent cannot mask a conflict. Serialize bootupd, bootc,
   libostree and bootctl writers; if the common lock is unavailable, fail rather
   than proceed concurrently.
2. On a fresh, not-yet-bootable installation, prepare payloads and entries, install
   the selected bootloader/configuration, then publish markers and verify them
   before reporting success or enabling the boot target. Bootupd's initial
   publication hands the validated semantics to the entry owner. Where an
   installer necessarily creates entries earlier, they remain uncommitted until
   this verification. A failure is an incomplete installation, not success with
   guessed semantics.
3. Publish a marker via a temporary regular file in the **same loader directory**:
   write all bytes, sync the file, atomically publish without replacing an
   existing file when claiming a domain, then sync the directory. Recheck a
   racing existing file and refuse conflicts. Idempotent matching markers need
   no rewrite. Do not truncate in place. On filesystems without the required
   durability, report that limitation/failure rather than claiming a crash-safe
   commit. These rules stop a short/torn write from being mistaken for a new
   supported policy, not malicious modification of a writable boot partition.
4. For OSTree, seed both owned slots on adoption; on every full bootversion
   rewrite validate/persist the destination slot's sibling marker before
   `full_system_sync` and the `loader` symlink swap. A newly created inactive
   slot receives its marker before activation. A bootlinks-only operation
   preserves and validates the active marker. Both slots must agree for an
   owned installation; mismatches block mutation but do not authorize repair.
   Never put the marker inside the recursively replaced `entries` tree.
5. For composefs, `entries` and `entries.staged` share the same dialect. Validate
   the parent marker before staging, finalization and rollback exchanges [B3].
   Do not change its semantics during an entries-only exchange. It is stable
   machine boot-domain state, not an entry tied to one deployment digest.
6. Deployment rollback reorders entries/bootlinks, not marker semantics. Payload
   GC and deployment cleanup preserve the sibling marker while its owned domain
   exists, even if temporarily empty. Only explicit decommission of the entire
   owned domain may remove its matching marker after the consumer is disabled.
   Never remove an unknown marker or another domain's marker; do not use
   `bootctl remove` as an unqualified cleanup helper [S3].

Ordinary bootupd binary updates must preserve the established entry-domain
contract; an EFI update must not stamp every colocated ESP. A dialect-changing
bootloader replacement is an explicit **offline owner handoff**, not an ordinary
update or deployment rollback: inventory and preserve the old configuration,
disable selection of the domain, migrate all affected entries and both OSTree
slots, install the new consumer, atomically replace each known-owned marker,
verify and sync everything, then re-enable selection. No atomic commit across
filesystems is assumed. An interrupted handoff remains disabled and requires
the same transaction to finish or restore the old consumer, entries and markers;
never select a partly converted domain. Unknown markers block handoff pending
manual reconciliation outside this automatic protocol.

On a same-dialect interrupted update, the old active entries/marker remain
usable. Leftover temporary files are not markers and may be removed only by
their owner on retry. If initial publication succeeded but later work failed,
retry verifies the matching marker and completes installation; it must not
silently bless partially installed entries. If a marker is lost/corrupted,
diagnose it and require explicit reconciliation, not an opportunistic rewrite.
Upgrade to marker-aware software does not automatically backfill old installs.
Rollback to old software preserves bytes only if its writers leave the sibling
alone: test that path before enabling rollout. Readers must retain unmarked
legacy support; old writers cannot be assumed to uphold the new contract.

## Proposed target-root reader contract

Resolve entries and marker from the **same target directory handle**, following
only the target's validated OSTree `loader` slot link. Hold the target lock while
resolving/selecting a deployment. Never cache semantics globally across targets.
Host EFI variables, host `/boot` and host GRUB directories are not evidence for
an offline target. To avoid unbounded reads or following an unexpected special
file in an offline image, require a regular non-symlink marker and read at most
256 bytes plus one overflow byte. This bound is a proposed parser constraint,
not an extension of dispatch bounds.

| Observed target marker | Ordering/default-selection behavior | Mutation behavior |
| --- | --- | --- |
| Exact `grub-bls\n` | GRUB dialect, descending filename policy; do not infer Grub versus GrubCC | Only within established ownership |
| Exact `type1\n` | BLS Type #1 comparison, including sort-key/version/tiebreak rules | Only within established ownership |
| Absent (`ENOENT` for marker in a resolved loader directory) | Unknown, not proof of conformance; legacy path below | No implicit claim/backfill |
| Unknown single ASCII token plus LF | Unsupported foreign semantics; diagnostic, no automatic default | Preserve, refuse claim |
| Empty, oversized, CRLF, extra data/line, invalid encoding or nonregular file | Malformed; diagnostic error, no automatic default | Preserve, refuse repair |
| Permission/I/O error or unresolved loader directory | Error, **not absent**, no automatic default | Fail without mutation |
| Marker incompatible with explicit target consumer/dialect, or inconsistent owned slots | Conflict; no automatic default or fallback probing | Preserve, stop before activation |

Absence makes no BLS assertion. For compatibility, a separately known **target**
classic-GRUB layout (target bootloader installation configuration or its GRUB
directory alongside the entries) retains descending filename legacy behavior,
including BIOS with no ESP. If the unmarked target's consumer is not established,
require an explicit target selection/semantics input or fail automatic default
selection; an entries directory alone is insufficient. This deliberately replaces
the current heuristic that equates an EFI-less BLS-only directory with Systemd.
Explicit deployment selection can bypass ordering ambiguity, not unreadable or
conflicting state checks. This policy does not identify GrubCC from a marker.

Distinct directories may legitimately carry different markers: read each in
isolation; do not prefer an ESP marker over XBOOTLDR or a separate `/boot` marker.
Choose the target consumer's configured entry root before ordering. If a consumer
merges ESP and XBOOTLDR entries, validate each domain under that consumer and
reject incompatible dialects rather than applying one marker to both. Unrelated
foreign domains do not prevent reading an explicitly selected local domain.

Ordering selects a default only after applying supported target default-entry
configuration. A menu's first entry is not proof of a saved/one-shot default.
Implementations must resolve target-local defaults or report them unsupported,
not consult host EFI state. GRUB's actual filename comparator is RPM-style,
whereas bootc currently uses reverse string comparison [B2, B4]; fixtures below
use equal-version numeric priorities where they agree. Marker dispatch must not
claim to fix all comparator or default-selector differences. BLS ordering is not
simply lexicographic filename sorting. Keep a semantics enum separate from the
existing Grub/GrubCC/Systemd identity used for installation and payload paths.

## Acceptance matrix for implementation (not executed here)

Common adversarial pair: `bootc_test-1-1.conf` has `sort-key bootc-test-1`,
`bootc_test-1-0.conf` has `sort-key bootc-test-0`; both have `version 1` and
distinct deployment digests. With no saved/one-shot override, `grub-bls` must
select filename `...-1.conf`, `type1` must select `...-0.conf`. Assert mounted
deployment digest and default, not just a sorted vector. Bound each future VM
case to ten minutes with no unbounded discovery/retry loop.

| Case | Required assertion |
| --- | --- |
| Exact bytes and parser boundary | Check both hex sequences, final LF, and all malformed states above; a 257-byte input errors after the bounded read; never rewrite foreign bytes |
| Native composefs offline, 2+ deployments | Opposing pair for classic GRUB, grub-cc and systemd-boot; mount selected target default independent of host bootloader/EFI variables; no selection from state-list order |
| OSTree offline, 2+ deployments | Opposing pair in active slot; test loader.0 and loader.1 activation, deployment-list order disagreement, full swap and bootlinks-only path |
| Legacy and BIOS | Unmarked target GRUB remains descending, no ESP required; unmarked ambiguous BLS-only target refuses guessed default; host systemd-boot cannot change either result |
| Foreign/error states | Unknown token, empty, missing LF, CRLF, trailing line, unreadable, symlink and I/O error give distinct diagnostics; no fallback or destructive adoption |
| Cross-directory isolation | Separate `/boot`, ESP and XBOOTLDR with opposing markers; each reads locally; incompatible merged consumer fails, unrelated foreign directory survives |
| Identity versus ordering | Grub and GrubCC both consume `grub-bls` ordering without changing installed identity/payload paths; `type1` never proves systemd-boot identity |
| Owner handoff and admission | Fresh bootupd claim, direct bootctl `type1` claim, bootc/libostree persistence and idempotent retry; reject existing foreign marker including inactive slot before deleting entries |
| Upgrades, rollback, cleanup | Both OSTree slots retain marker across repeated swaps; composefs staged exchange/rollback retains dialect; GC preserves marker and foreign entries; old-software rollback tested |
| Defaults | Target saved/one-shot overrides honored where supported or explicit unsupported diagnostic; no false promise that sorted first always boots |
| Failure recovery | Inject short write, file sync, publish race, directory sync and pre/post activation failures; old active slot remains valid; incomplete fresh install is not success; interrupted offline handoff stays disabled until restored/completed |
| systemd interoperability | `grub-bls` yields kernel-install auto layout `other`, not accidental standard BLS writes; `type1` yields `bls`; absent fallback and explicit-layout/UKI precedence remain systemd behavior, not bootc assumptions |

## Source pins

These immutable links are the inspected baseline, not a promise that moving
upstream branches or vendor builds have the same behavior.

[bls]: https://github.com/uapi-group/specifications/blob/5e61460b42b91bb1e402b50a6149774d78fc0d8e/specs/boot_loader_specification.md#L432-L444
[U1]: https://github.com/coreos/bootupd/blob/a100a0981cdfa3fc5dc9ebe86b8601ae624988b3/src/bootupd.rs#L57-L344
[U2]: https://github.com/coreos/bootupd/blob/a100a0981cdfa3fc5dc9ebe86b8601ae624988b3/src/efi.rs#L501-L640
[U3]: https://github.com/coreos/bootupd/blob/a100a0981cdfa3fc5dc9ebe86b8601ae624988b3/src/bios.rs#L114-L304
[B1]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/bootloader.rs#L127-L261
[B2]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/bootc_composefs/boot.rs#L815-L1100
[B3]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/bootc_composefs/finalize.rs#L180-L213
[B4]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/bootc_composefs/status.rs#L249-L551
[B5]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/mount.rs#L93-L184
[B6]: https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/crates/lib/src/install.rs#L2093-L2156
[O1]: https://github.com/ostreedev/ostree/blob/a4cb6781b92da59107a6e6c44bee77898054cc25/src/libostree/ostree-sysroot-deploy.c#L2180-L2460
[O2]: https://github.com/ostreedev/ostree/blob/a4cb6781b92da59107a6e6c44bee77898054cc25/src/libostree/ostree-sysroot-cleanup.c#L297-L380
[O3]: https://github.com/ostreedev/ostree/blob/a4cb6781b92da59107a6e6c44bee77898054cc25/src/libostree/ostree-sysroot-deploy.c#L2913-L3039
[S1]: https://github.com/systemd/systemd/blob/4343b7c7d5adece02896fdcb61603b702afe07bd/src/bootctl/bootctl-install.c#L949-L996
[S2]: https://github.com/systemd/systemd/blob/4343b7c7d5adece02896fdcb61603b702afe07bd/src/kernel-install/kernel-install.c#L649-L931
[S3]: https://github.com/systemd/systemd/blob/4343b7c7d5adece02896fdcb61603b702afe07bd/src/bootctl/bootctl-install.c#L2018-L2042

## Ordered implementation follow-ups

1. **tracker:** obtain explicit bootupd target admission (an authorized fork,
   bounds and an issue in that allowed repository) or arrange operator-managed
   upstream work. Current dispatch bounds do not admit bootupd. This is a
   prerequisite for a dispatched bootupd implementation plan, not permission to
   expand bounds here. No cross-repository issue is filed by this run.
2. **coreos/bootupd, via the admitted target:** implement the explicit entry-domain
   install input, initial writer, ownership preflight and update preservation;
   tests cover EFI and BIOS and exact bytes. Do not add an ESP-global shortcut.
3. **ostreedev/ostree:** implement delegated semantics input, both-slot preflight
   and persistence before activation, including bootlinks-only and cleanup tests.
   Reject unsupported consumer integrations rather than just stamping markers.
4. **bootc-dev/bootc, via its authorized fork:** wire the caller's actual boot
   domains and owner handoff to those interfaces; keep publication off by default
   until coordinated lifecycle coverage passes. Implement target-root semantics
   reading, distinct identity, sorting and offline default selection (including
   multi-deployment `mount`) with the matrix above. Any new opt-in setting must
   include its concrete image/installer caller configuration in that change, or
   name its external repository, file, key and value in that PR's Caller settings.
5. **systemd/systemd and bootc integration tests:** verify existing kernel-install
   and bootctl interactions; only propose systemd changes if these tests expose
   a needed lifecycle fix. Do not rely on bootctl removal to preserve foreign
   markers. Qualify XBOOTLDR and unsupported OSTree loader combinations before
   enabling them.
6. **bootc-dev/bootc PR #2515, later:** only after writer/persistence/reader
   prerequisites land, reconcile the mount work with the established contract
   and run offline/VM acceptance and rollback tests. This PR does not rebase it.
   **tracker #252 remains open** until the marker and consumers, not just this
   contract, are implemented and verified.
