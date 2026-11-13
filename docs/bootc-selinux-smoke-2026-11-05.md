# bootc SELinux smoke attempt, 5 November 2026

> This text is LLM generated.

**Blocked; neither tmt smoke passed.** The attempts used bootc main
`7cde7bbe233ee45a40cff3d89d4f42b68a258d46` contains
`d296202cb2c4e44ab5270323f422e14137d3a16a`
([bootc#2494](https://github.com/bootc-dev/bootc/pull/2494)). The default-feature
container build initially timed out; later nested-Fedora attempts completed
default-feature images but failed before tmt execution, first on a missing
libvirt storage socket and then on bcvk's VM readiness timeout. A manually
booted ostree test guest printed `1` from `/sys/fs/selinux/enforce`; the
composefs disk was not booted. No output from the requested tmt SELinux
assertion was recovered for either guest. The continuation's VM and disks
are no longer available. There is
**no passing tmt plan or runtime regression finding** here, and no further
re-provisioning was attempted after these repeated setup failures.
This blocked-attempt evidence does **not** justify closing
[tracker#232](https://github.com/cgwalters-forge/tracker/issues/232).

Part of [tracker#232](https://github.com/cgwalters-forge/tracker/issues/232).
Only this evidence document is proposed. No upstream write, CI job, new control,
caller option, credential, runner or devspace was added. The no-libselinux build
and permanent CI work remain with
[tracker#103](https://github.com/cgwalters-forge/tracker/issues/103).

## First attempt: revision, method and results

The fresh, full clone was made at approximately **2026-11-05T01:38:09Z** in
`/tmp/opencode/bootc-selinux-smoke`. `git merge-base --is-ancestor` returned 0
for #2494's commit against HEAD; no source changes were made in the clone.
The final `git status --short` there was empty.

Instructions inspected at that SHA:
[CONTRIBUTING.md](https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/CONTRIBUTING.md#running-tmt-integration-tests),
[test-integration](https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/.github/workflows/ci.yml#L295),
[install-tmt](https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/.github/actions/install-tmt/action.yml),
and [Justfile](https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/Justfile).
The lib manifest's `default = ["install-to-disk", "selinux"]` was checked.
No command passed `--no-default-features`. The container RPM recipe invoked
`cargo build -j4 --release --features rhsm --bins`: default features remained
enabled, with the packaging recipe's additional `rhsm` feature.

| Requested smoke | Entrypoint outcome | tmt plan summary | `000-test-selinux-enforcing.nu` result |
| --- | --- | --- | --- |
| ostree, default grub/BLS/unsealed | Exit 124 after 60.00 s; `package` stopped while building host xtask for `local-rust-deps` | No plans started; pass/fail totals unavailable, not a tmt failure count | **Not executed; no result to quote** |
| composefs, systemd/ext4/BLS/unsealed | Exit 124 after 60.00 s; `package` reached container RPM Cargo compilation | No plans started; pass/fail totals unavailable, not a tmt failure count | **Not executed; no result to quote** |

The readonly plan is `/tmt/plans/integration/plan-01-readonly`. Its
[SELinux test](https://github.com/bootc-dev/bootc/blob/7cde7bbe233ee45a40cff3d89d4f42b68a258d46/tmt/tests/booted/readonly/000-test-selinux-enforcing.nu)
contains the assertion below. This is **source text, not observed output**:

```nu
let enforce = (open /sys/fs/selinux/enforce | str trim)
assert equal $enforce "1" "SELinux should be in enforcing mode"
print "SELinux is enforcing"
```

At this main SHA the test also has a composefs **upgrade-source** skip branch
when `BOOTC_test_upgrade_image` is nonempty. A future successful evidence run
must distinguish that skip from an actual enforcing assertion. Neither branch
was executed here. No external PR CI result is substituted for these local
post-merge attempts.

## First attempt: hosted environment and setup limits

Host: Ubuntu 26.04.1 LTS (Resolute Raccoon), x86_64, four CPUs, about 16 GiB
RAM. Kernel: `7.0.0-1017-azure`, build
`#17-Ubuntu SMP PREEMPT Thu Sep 24 15:54:51 UTC 2026`.
Initial filesystem availability: 87 GiB of 145 GiB on `/dev/root`.
The sandbox user is UID/GID 1002 and belongs to group `991(kvm)`.
`/dev/kvm` is a character device, major/minor `10, 232`, mode `0660`, owned by
`root:kvm`; read/write access checks passed. **No KVM ioctl or VM boot was
performed**, so nested virtualization functionality remains unverified.
Podman reports rootless mode, native overlay storage, cgroup v2 and
`selinuxEnabled: false`. `/sys/fs/selinux/enforce` does not exist on the host.
An SELinux-enforcing guest would still be necessary; host device access alone
does not establish that result.

| Tool | Observed version/status |
| --- | --- |
| podman | 5.7.0; Buildah 1.42.1 from `podman info` |
| cargo (host) | 1.93.1 (`083ac5135 2025-12-15`) |
| cargo (container) | Buildroot installed CentOS `cargo-1.99.1-1.el10.x86_64`; not separately version-probed |
| just | 1.45.0 |
| Python | 3.14.4; differs from workflow setup-python 3.15.2 |
| bcvk | 0.19.0, downloaded from the release used by the host setup action; executable version check passed |
| tmt | Absent initially and after failed installation of `tmt[provision-virtual]==1.80.0`; version command exit 127 |
| qemu-system-x86_64 / virsh / uv | Not found by `command -v` |

The workflow uses `bootc-dev/actions/bootc-ubuntu-setup@main` with
`libvirt: true`. Its then-current entrypoint delegates to `bootc-host-setup`.
Read-only inspection of `ci/install-deps.sh` and the Ubuntu package lists showed
bcvk 0.19.0, `libvirt-dev`, `libvirt-daemon-system`, `qemu-utils`, `virtiofsd`,
`genisoimage`, `libkrb5-dev`, `pkg-config`, `python3-virt-firmware` and, on
26.04, `ovmf-generic`. Those action sources were read at mutable `main`, not
pinned as an independently reproducible action revision. The privileged setup
script (including disk cleanup and system workarounds) was **not executed**.
`sudo -n true` failed. Instead, bcvk was unpacked into `/tmp/opencode`, and the
pinned tmt extras were attempted once in a user-owned venv. Pip failed while
building `libvirt-python` because pkg-config could not locate libvirt.
No host package/service changes or alternate runner access were attempted.

Base pullspec: `quay.io/centos-bootc/centos-bootc:stream10` (Justfile default).
The explicit pull succeeded. `podman image inspect` returned:

```text
Digest: sha256:cce220ee9bc3ae1bbd2443a21f2e6f279f3946ae4024a29e237a965815fba655
RepoDigests:
quay.io/centos-bootc/centos-bootc@sha256:7f3e1d982521a59b0c2fd7a629d185b65a43887bb03299e2a97d37bd3a48b06d
quay.io/centos-bootc/centos-bootc@sha256:cce220ee9bc3ae1bbd2443a21f2e6f279f3946ae4024a29e237a965815fba655
Image/config ID: sha256:d1da6d44097717da1b4295ee411f423938b1f690dd197b4d304dafef5a4b36b5
```

The build commands used the tag, not a digest override. The composefs
entrypoint's prerequisite pull returned the same image ID. No completed local
bootc test image or guest image digest is available.

## First attempt: command ledger

These are the verbatim shell commands used for the experiment, including
diagnostics. Every timed invocation had prefix
`/usr/bin/time -f 'exit=%x duration_s=%e' `; the table gives that invocation's
exit code and elapsed wall seconds. They ran from the tracker root unless
marked **bootc**, meaning tool `workdir=/tmp/opencode/bootc-selinux-smoke`.
Timeouts bound attempts, not test-case durations. Compound probes report the
last command's status; internal failures are called out explicitly below.
File reads/searches via read-only tools and tracker handback administration
are not smoke commands.

| Command (after timing prefix) | Directory | Exit | Seconds |
| --- | --- | ---: | ---: |
| `git clone https://github.com/bootc-dev/bootc.git /tmp/opencode/bootc-selinux-smoke` | tracker | 0 | 1.76 |
| `bash -c 'date -u +%FT%TZ; uname -a; id; ls -l /dev/kvm; test -r /dev/kvm && test -w /dev/kvm; printf "kvm_rw_exit=%s\n" "$?"; podman --version; cargo --version; just --version; tmt --version; bcvk --version; command -v qemu-system-x86_64 virsh uv pip3; df -h /tmp/opencode'` | tracker | 0 | 0.05 |
| `git -C /tmp/opencode/bootc-selinux-smoke rev-parse HEAD` | tracker | 0 | 0.00 |
| `git -C /tmp/opencode/bootc-selinux-smoke merge-base --is-ancestor d296202cb2c4e44ab5270323f422e14137d3a16a HEAD` | tracker | 0 | 0.00 |
| `podman info` | tracker | 0 | 0.97 |
| `bash -c 'python3 --version; test -e /sys/fs/selinux/enforce; printf "host_selinux_enforce_exists_exit=%s\n" "$?"; sudo -n true'` | tracker | 1 | 0.00 |
| `timeout 120 podman pull quay.io/centos-bootc/centos-bootc:stream10` | tracker | 0 | 21.84 |
| `python3 -m venv /tmp/opencode/bootc-smoke-tools` | tracker | 0 | 3.43 |
| `timeout 120 /tmp/opencode/bootc-smoke-tools/bin/pip install 'tmt[provision-virtual]==1.80.0'` | tracker | 1 | 10.88 |
| `curl --fail --show-error --location --max-time 60 --output /tmp/opencode/bcvk-x86_64.tar.gz https://github.com/bootc-dev/bcvk/releases/download/v0.19.0/bcvk-x86_64-unknown-linux-gnu.tar.gz` | tracker | 0 | 0.43 |
| `tar -xzf /tmp/opencode/bcvk-x86_64.tar.gz -C /tmp/opencode` | tracker | 0 | 0.02 |
| `podman image inspect quay.io/centos-bootc/centos-bootc:stream10 --format '{{.Digest}} {{json .RepoDigests}}'` | tracker | 0 | 0.07 |
| `/tmp/opencode/bcvk-x86_64-unknown-linux-gnu --version` | tracker | 0 | 0.00 |
| `timeout 180 just 'generic_buildargs=--network=host -v /etc/egress-proxy/ca-bundle.pem:/etc/pki/tls/certs/ca-bundle.crt:ro' no_auto_local_deps=1 build` | **bootc** | 124 | 180.00 |
| `timeout 60 just test-tmt integration` | **bootc** | 124 | 60.00 |
| `timeout 60 just test-composefs systemd ext4 bls unsealed` | **bootc** | 124 | 60.00 |
| `bash -c 'PATH=/tmp/opencode/bootc-smoke-tools/bin:$PATH; tmt --version; printf "tmt_exit=%s\n" "$?"; /tmp/opencode/bcvk-x86_64-unknown-linux-gnu --version; git -C /tmp/opencode/bootc-selinux-smoke status --short; pgrep -a -u 1002 "cargo\|rustc\|podman\|bcvk\|qemu"; printf "pgrep_exit=%s\n" "$?"'` | tracker | 0 | 0.03 |

In the first compound probe, tmt and bcvk were missing (shell exit 127);
`command -v` printed only `/usr/bin/pip3`, and the compound command ended with
successful `df`. The final process probe used the ERE
`cargo|rustc|podman|bcvk|qemu` (table escaping is for Markdown only) and returned
1 with no matches, so no matching experiment process remained. In the final
probe tmt still returned 127 and bcvk returned 0.

The explicit build's existing `no_auto_local_deps=1` switch bypassed only host
xtask path-dependency detection in this clean clone, not Rust default features.
The host-network/CA mount supplied the sandbox's documented egress setup to
container build steps without disabling TLS verification. The subsequent exact
smoke entrypoints used unmodified defaults; their package layers reused the
earlier build cache. Neither reached a new networked RUN step or tmt invocation.
The bcvk binary was version-probed by absolute path but not installed on PATH;
that setup step would also be required before a runnable smoke attempt.

<details>
<summary>Trimmed failure/build output (not guest logs)</summary>

```text
sudo: I'm sorry runner-sandbox. I'm afraid I can't do that

# pip install tmt[provision-virtual]==1.80.0
Collecting libvirt-python (from testcloud>=0.12.0->tmt[provision-virtual]==1.80.0)
Getting requirements to build wheel: finished with status 'error'
Package libvirt was not found in the pkg-config search path.
Perhaps you should add the directory containing `libvirt.pc'
to the PKG_CONFIG_PATH environment variable
Package 'libvirt' not found
exit=1 duration_s=10.88

# explicit default-feature container build
Installing : libselinux-devel-3.11-3.el10.x86_64
+ cargo build -j4 --release --features rhsm --bins
   Compiling proc-macro2 v1.0.106
   ... [dependency compilation omitted]
   Compiling proc-macro-error-attr2 v2.0.0
error: Recipe `package` was terminated by signal 15
exit=124 duration_s=180.00

# ostree entrypoint
++ cargo xtask local-rust-deps
   ... [dependency compilation omitted]
   Compiling chrono v0.4.45
error: Recipe `package` was terminated by signal 15
exit=124 duration_s=60.00

# composefs entrypoint
   Compiling xtask v0.1.0 (/tmp/opencode/bootc-selinux-smoke/crates/xtask)
    Finished `dev` profile [optimized + debuginfo] target(s) in 17.74s
     Running `target/debug/xtask local-rust-deps`
+ cargo build -j4 --release --features rhsm --bins
   ... [dependency compilation omitted]
   Compiling clap_builder v4.6.7
error: Recipe `test-composefs` was terminated on line 272 by signal 15
error: Recipe `package` was terminated by signal 15
exit=124 duration_s=60.00
```

</details>

## Continuation: host user-namespace restriction

A second hosted attempt the same day (fresh clone, same main SHA, ancestry check
0) got further on setup. The setup was all user-local and needed no sudo:
`virsh` from extracted Ubuntu `libvirt-clients` debs, session-mode libvirtd and
QEMU in a rootless container sharing `/dev/kvm`, bcvk 0.19.0, and
`tmt[provision-virtual]==1.80.0` in a venv with `PKG_CONFIG_PATH` pointing at the
extracted `libvirt-dev`. `tmt --version` reported 1.80.0 and the host `virsh`
reported KVM domain capabilities with EFI firmware. Two blockers remained.
Both likely have the same cause, though nothing was run with it lifted: the host sets
`kernel.apparmor_restrict_unprivileged_userns=1` (and
`apparmor_restrict_unprivileged_unconfined=1`). A user namespace nested inside
rootless podman, such as one created by bwrap, gets no usable capabilities:

- The default-feature build compiled all crates and RPMs (exit 1 after
  1040.55 s), then failed in the image's `rpm-ostree compose rootfs` step with
  `groupadd: cannot open /etc/gshadow: Permission denied` and
  `Could not find group 'utempter' in group file`, despite `--cap-add=all`.
- `bcvk ephemeral run`, which `bcvk libvirt run` uses to create its base
  disk, needs QEMU and virtiofsd from the host `/usr` (a hardcoded bind).
  With those supplied from a Fedora 43 `/usr`, virtiofsd 1.14.0 still failed
  under bwrap with `can't apply the child capabilities`. The same command
  works in the container without bwrap.

Changing the sysctl needs root, and this run did not try to get around the
AppArmor policy. Instead, a Fedora 43 Cloud Base VM (`43-1.6`, checksum
verified) was booted with QEMU and nested KVM (AMD, `kvm_amd nested=1`; 4
vCPUs, 13 GiB, 120 GiB disk). Inside it, bcvk 0.19.0, tmt 1.80.0, just
1.59.0, cargo 1.99.1, podman 5.6.2 and libvirt 11.6.0 were installed, with
the egress proxy and CA passed through. `just test-tmt readonly` (ostree
variant, the plan holding the SELinux test) was started there at
2026-11-05T02:30Z. It is narrower than the requested `test-tmt integration`
entrypoint, and no composefs run has started. It was still compiling when
this round ended. The VM was left running for the next round to collect, so
there is **still no observed guest SELinux result**. The first attempt's
statements above about missing libvirt/tmt and an untested KVM boot apply
only to that attempt.

## Recovered continuation: completed builds, blocked VM launch

A subsequent [continuation run](https://github.com/cgwalters-forge/tracker/actions/runs/41958198783)
re-provisioned the Fedora 43 VM on the same hosted capacity. Its changes were
not pushed because the run timed out. The results below were recovered from
its [agent-run artifact](https://github.com/cgwalters-forge/tracker/actions/runs/41958198783/artifacts/13387323198)
(`session.md` and `outcome.json`), rather than rerun in this final session.
The [transcript artifact](https://github.com/cgwalters-forge/tracker/actions/runs/41958198783/artifacts/13387462839)
contains the underlying tool calls; these artifacts have limited retention.
The run checked out the same full bootc SHA. Its Fedora build VM reported
SELinux enforcing. The earlier missing-tmt and untested-KVM statements apply
only to the first attempt, not to these later runs.

From `/root/bootc` inside that VM, the timed commands were:

| Command | Exit | Seconds | Result |
| --- | ---: | ---: | --- |
| `/usr/bin/time -f "exit=%x duration_s=%e" just test-tmt readonly > /root/ostree.log 2>&1` | 1 | 1676.99 | Default-feature build and test images completed; VM launch failed on missing `virtstoraged-sock` |
| `/usr/bin/time -f "exit=%x duration_s=%e" just variant=composefs bootloader=systemd filesystem=ext4 boot_type=bls seal_state=unsealed test-tmt --filesystem=ext4 --seal-state=unsealed --boot-type=bls readonly > /root/composefs.log 2>&1` | 1 | 767.44 | Images built; after libvirt sockets were enabled, bcvk's ephemeral install VM timed out waiting for readiness |
| `/usr/bin/time -f "exit=%x duration_s=%e" just build > /root/ostree-build.log 2>&1` | 0 | 150.43 | Cached ostree rebuild completed |

Both smoke commands were narrowed to `readonly`, not the full requested
integration entrypoints. For `/tmt/plans/integration/plan-01-readonly`, both
failed during VM provisioning: **no tmt pass/fail totals and no
`000-test-selinux-enforcing.nu` output** were obtained. Trimmed observed output:

```text
# ostree
Failed to connect socket to '/var/run/libvirt/virtstoraged-sock': No such file or directory
Aborting test run: failed to launch VM for plan /tmt/plans/integration/plan-01-readonly (infrastructure failure)
exit=1 duration_s=1676.99

# composefs
Timeout waiting for readiness after 240s
exit=1 duration_s=767.44
```

The bcvk install VM added another virtualization level inside Fedora. A bare
kernel probe there took 54 seconds to reach a no-initrd panic, suggesting
slow nested boot, but not proving why the readiness timeout occurred.
The run then installed both images to disks inside Fedora using
`bootc install to-disk --via-loopback` and copied them to the runner for
UEFI QEMU boots without that extra level. Only the ostree disk was booted.
Its console/SSH probe printed:

```text
CentOS Stream 10 (Coughlan)
Kernel 6.12.0-280.el10.x86_64 on x86_64
6.12.0-280.el10.x86_64
1
```

The final `1` was the direct `/sys/fs/selinux/enforce` read, **not** the
Nushell assertion or a tmt result. The rebuilt ostree test image ID was
`727d631f650aadfc9dfe64e1768ed30ae568c82b3e5dacc1b829cff18d2d1984`;
the composefs test image ID was
`57cb57fcf97a4b6892fddd0598c5e911cbdbdc1e2a4cb92133d3434833bd8fee`.
The ostree qcow2's SHA-256 matched before and after transfer:
`b1f34db6e50c746509b5d56a9ba04d2c822ed41701a807ad469bbcefac008e1a`.
These local image identities are not substitutes for immutable registry
digests or a successful smoke. The transcript records a pending tmt
connect-provisioner invocation against the ostree guest just before the run
was interrupted, with no completion status or output. Its execution and result
could not be recovered. The composefs disk was not booted.

## Final recovery and remaining evidence

This final session found no `/tmp/smoke/vm`, prior bootc clone, or Podman
containers. `command -v` found podman, just and cargo, but not QEMU, virsh,
bcvk or tmt; `/dev/kvm` remained readable/writable. `sudo -n true` still
failed. The compound recovery probe exited 1 in 0.03 seconds; its attempted
`sysctl` query was unavailable on PATH, so it did not re-verify the earlier
AppArmor settings. No guest results can be collected from the removed VM.
The previous continuation's failed job log reports a session runtime timeout,
not a bootc test failure. The PR has no `VERDICT` review comment and no failing
required check at head `6bff47912fdc2c9f36881c15b372c0effb908c2c`.

Evidence collection stops here after the repeated hosted and nested-VM
attempts, rather than provisioning the same setup again. This concludes the
blocked-attempt record, **not** the runtime validation requested by #232.
Missing evidence is both tmt plan summaries and both guest enforcing-test
results; the direct ostree probe does not fill that gap.

To satisfy #232, finish the existing workflow's dependencies in an authorized
environment, complete a default-feature build against an identified main SHA,
and capture actual ostree and composefs tmt plan summaries plus the enforcing
assertion's output in each guest. Keep #232 open until that runtime evidence
exists. No compile-only checks were substituted for it.
