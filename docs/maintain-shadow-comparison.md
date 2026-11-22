# Shadow versus pass on agentic-job, 7 to 18 November 2026

> This text is LLM generated.

Part of [tracker#1356](https://github.com/cgwalters-forge/tracker/issues/1356)
(step 1), written for
[tracker#1756](https://github.com/cgwalters-forge/tracker/issues/1756): the
comparison evidence
[tracker#1360](https://github.com/cgwalters-forge/tracker/issues/1360) asks for
before agentic-job's pull request follow-up is handed to its own maintainer.
`maintain-shadow.yml` runs `agent-board poll --dry-run` on
cgwalters-forge/agentic-job with pass.json's `pr` policy and takes no step; this
document compares what it said it would do with what the pass did. It records
the comparison only; it does not say that tracker#1360's gate is satisfied, and
it changes no workflow.

## Sources and coverage

| Source | Covers | Read | Limits |
|---|---|---|---|
| maintain-shadow.yml runs, `Preview` step log (`[dry-run] <repo>#<pr> <head> <kind>: <reason>` lines) | whole window | 44 runs, all successful, 721 decision lines on 208 heads of 99 pull requests | 2 to 5 runs a day (the half-hourly cron is mostly dropped); the shadow keeps no record of its own would-be steps, so it repeats a decision until the pass changes the state |
| poll.yml applying runs (`pass (apply)`, success or failure), `One pass` step log | 7 November to 16 November 13:17 UTC | 1144 runs, all logs read through the Actions API, 540 with at least one agentic-job decision line | poll.yml was disabled by hand on 16 November; previews and cancelled runs are not steps and were left out |
| `<!-- tracker-poll: ... -->` markers the pass writes on agentic-job pull requests | whole window, including after poll.yml | 522 markers on 143 of the 189 bot pull requests updated since 7 November (126 continuation, 134 rebase, 9 fix, 174 queue, 11 rerun, 64 stop, 4 agent triage), plus the `needs-human` label events | record steps only, never a wait; written by whatever ran the pass, inside or outside Actions |

Run logs are kept for 90 days, so this can be repeated from the same sources
until early February 2027; the markers stay with the pull requests. Every log
and comment was read, 760 pass logs on a second attempt after a rate limit. The
pass itself ran on 17 and 18 November outside Actions
([agent-board#1047](https://github.com/cgwalters-forge/agent-board/issues/1047)):
4 and 11 markers prove it, but its waits and reasons on those days are unknown.

Pass logs with agentic-job decision lines, per day (applying runs with lines /
applying runs):

| 7 Nov | 8 Nov | 9 Nov | 10 Nov | 11 Nov | 12 Nov | 13 Nov | 14 Nov | 15 Nov | 16 Nov |
|---|---|---|---|---|---|---|---|---|---|
| 132/132 | 0/134 | 0/134 | 0/135 | 0/98 | 37/139 | 92/92 | 109/109 | 106/106 | 64/65 |

From 8 November to 12 November 09:08 UTC the pass logged no decision on any
agentic-job pull request. That is not a retrieval failure: its stage summary
says `pull requests: the stage's request share is spent at bootc-dev/bcvk; 35
repositories wait for the next pass, which starts there` (406 of the 640 run
logs of those days name bcvk; 9 name agentic-job itself), and the pass wrote no
marker on agentic-job on 8 to 10 November and five on 11 November (two queue
admissions, one re-queue, one check rerun, one stop). The shadow, polling
agentic-job alone, kept deciding through those days.

## Method

The unit is a pull request head and a decision kind, not a tick: the 721 shadow
lines collapse to 244 (head, kind) units. For each shadow line the pass's
evidence on the same head is the nearest `One pass` log line within 90 minutes,
else the nearest marker within three hours (steps only), else nothing.

- **Agreed**: the same kind. Also counted as agreement: the shadow waiting
  because "round N is running", or skipping an already queued or labelled head,
  when that is the pass's own step it observed; and the three cases where the
  pass's nearest line was a plain wait and it took the shadow's step on that head
  within three hours ([#3673](https://github.com/cgwalters-forge/agentic-job/pull/3673)
  and [#3969](https://github.com/cgwalters-forge/agentic-job/pull/3969) were
  enqueued 12 minutes after the shadow saw the approval; the pass's cached
  conditional reads lag the shadow's fresh ones). A pass decision the pass could
  not start that tick ("not started: this pass started 3 fix runs already",
  "every pool is held") is the same decision; the shadow has no pacing.
- **Disagreed**: different kinds. A head whose ticks split between agreement and
  disagreement counts once, as a disagreement (three units).
- **Not comparable**: no pass evidence on that head near that time.
- **Pass stepped, shadow never saw the head in time**: a marker on a head the
  shadow did not see within three hours. Of 326, the shadow never saw 276 heads
  at all and saw 50 only hours later, usually after the pass had stopped on them.

## Totals

| Step | Agreed | Disagreed | Not comparable | Pass stepped, shadow never saw the head in time |
|---|---|---|---|---|
| fix | 0 | 0 | 7 | 7 |
| rebase | 13 | 38 | 8 | 92 |
| continuation | 21 | 8 | 34 | 71 |
| check rerun | 0 | 0 | 0 | 8 |
| enqueue or merge | 5 | 10 | 6 | 133 |
| needs-human | 2 | 1 | 1 | 15 |
| wait (no step) | 34 | 3 | 9 | |
| skip (a hold respected) | 40 | 0 | 4 | |
| **total** | **115** | **60** | **69** | **326** |

Where both saw the same head under the same holds they agreed, every skip
included. The shadow never decided a check rerun: its only related line waited
on a rerun the pass had reserved. One example a class:

- Agreed rebase: [#3403](https://github.com/cgwalters-forge/agentic-job/pull/3403)
  `b994a328`, rebase round 2 of 2 in
  [shadow 43401533493](https://github.com/cgwalters-forge/tracker/actions/runs/43401533493)
  and [pass 43400963561](https://github.com/cgwalters-forge/tracker/actions/runs/43400963561)
  (not started that tick, every pool held). Agreed continuation:
  [#3169](https://github.com/cgwalters-forge/agentic-job/pull/3169) `b3d25dd6`,
  "continuation round 1 is blocked, so a fresh round on another pool" in
  [shadow 43225389407](https://github.com/cgwalters-forge/tracker/actions/runs/43225389407)
  and [pass 43224677848](https://github.com/cgwalters-forge/tracker/actions/runs/43224677848).
  Agreed enqueue: [#3450](https://github.com/cgwalters-forge/agentic-job/pull/3450)
  `5386132a`, the same shadow run and
  [pass 43226289159](https://github.com/cgwalters-forge/tracker/actions/runs/43226289159).
  Agreed needs-human: [#3333](https://github.com/cgwalters-forge/agentic-job/pull/3333)
  `2b7c2221` on 16 November 01:00, the shadow's stop in
  [43783562028](https://github.com/cgwalters-forge/tracker/actions/runs/43783562028)
  and the pass's [stop marker](https://github.com/cgwalters-forge/agentic-job/pull/3333#issuecomment-6904515871)
  eight minutes later.
- Disagreed: every one is listed below.
- Not comparable, in the gap: [#3211](https://github.com/cgwalters-forge/agentic-job/pull/3211)
  `779e4323`, continuation round 1 in
  [shadow 42497292241](https://github.com/cgwalters-forge/tracker/actions/runs/42497292241)
  on 8 November; no pass line or marker. After poll.yml:
  [#4398](https://github.com/cgwalters-forge/agentic-job/pull/4398) `913ad40f`,
  fix round 1 in [shadow 44373945020](https://github.com/cgwalters-forge/tracker/actions/runs/44373945020)
  on 18 November 18:50; the pass's
  [fix round 1](https://github.com/cgwalters-forge/agentic-job/pull/4398#issuecomment-6999889856)
  on that head came on 19 November 04:40, outside the window. State changed
  between observations: [#4232](https://github.com/cgwalters-forge/agentic-job/pull/4232)
  `90a566f0`, the shadow waiting for approval in
  [43642762976](https://github.com/cgwalters-forge/tracker/actions/runs/43642762976),
  the pass enqueuing 11 minutes later in
  [43643066204](https://github.com/cgwalters-forge/tracker/actions/runs/43643066204).
- Pass stepped, shadow never saw the head: the check rerun on
  [#3473](https://github.com/cgwalters-forge/agentic-job/pull/3473#issuecomment-6834950956)
  and fix round 1 on [#3492](https://github.com/cgwalters-forge/agentic-job/pull/3492#issuecomment-6836618562),
  both on 12 November. Of the 15 needs-human stops, the shadow later saw 10
  heads only as a step it would take (the review-request holds below), 4 as a
  label it skipped, and 1 never.

Not comparable by period: 50 units in the 8 to 12 November gap (28
continuations, 5 enqueues, 4 fixes, 3 rebases, 1 needs-human, 9 waits or skips),
18 after the last poll.yml run on 16 November 13:17 (6 continuations, 5 rebases,
3 fixes, 1 enqueue, 3 waits or skips), and the one state change above.

## Every disagreement

Each row is one shadow run against the pass run nearest to it; the pull requests
are the heads it decided on. Shadow decisions are abbreviated: "rebase 1" is
"conflicts with main; approved (or, where marked, not approved), so rebase
round 1 of 2", "continue 1" is
"continuing (round 1): its checkpoint says incomplete", "enqueue" is "review
approved and checks green".

| When (UTC) | Shadow would | Pass did | Runs |
|---|---|---|---|
| 13 Nov 01:48 | rebase 1: [#3333](https://github.com/cgwalters-forge/agentic-job/pull/3333) `2b7c2221`; needs-human (review job failed again after a rerun): [#3474](https://github.com/cgwalters-forge/agentic-job/pull/3474) `1f46e33c` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43347561202), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43346223650) |
| 13 Nov 09:28 | wait (#3606 is ahead in the merge queue; rebased after it): #3333 `2b7c2221` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43401533493), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43400963561) |
| 14 Nov 03:09 | enqueue: #3474 `a0131266` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43550116068), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43549935912) |
| 14 Nov 10:17 | wait (#3964 is ahead in the merge queue): [#3693](https://github.com/cgwalters-forge/agentic-job/pull/3693) `c35c415f`, [#3701](https://github.com/cgwalters-forge/agentic-job/pull/3701) `5b358cd2`; rebase 1: [#3713](https://github.com/cgwalters-forge/agentic-job/pull/3713) `9dc24422` (not approved), [#3766](https://github.com/cgwalters-forge/agentic-job/pull/3766) `68e10cde`, [#3767](https://github.com/cgwalters-forge/agentic-job/pull/3767) `25f6bd9e`, [#3789](https://github.com/cgwalters-forge/agentic-job/pull/3789) `7bfebd9d`, [#3804](https://github.com/cgwalters-forge/agentic-job/pull/3804) `7483c5e7`, [#3817](https://github.com/cgwalters-forge/agentic-job/pull/3817) `731f4cfb`, [#3835](https://github.com/cgwalters-forge/agentic-job/pull/3835) `bdb7a101`, [#3850](https://github.com/cgwalters-forge/agentic-job/pull/3850) `17271573` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43584517337), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43583983061) |
| 14 Nov 16:44 | rebase 1: #3693 `c35c415f`, #3701 `5b358cd2`, [#3879](https://github.com/cgwalters-forge/agentic-job/pull/3879) `cfaab177`, [#3902](https://github.com/cgwalters-forge/agentic-job/pull/3902) `0a1832b1`, [#3942](https://github.com/cgwalters-forge/agentic-job/pull/3942) `e3ab6e1c`, [#3945](https://github.com/cgwalters-forge/agentic-job/pull/3945) `9ff4b910`, [#3962](https://github.com/cgwalters-forge/agentic-job/pull/3962) `58346001`, [#3963](https://github.com/cgwalters-forge/agentic-job/pull/3963) `4ae53c59`, [#3998](https://github.com/cgwalters-forge/agentic-job/pull/3998) `0dbaee85`, [#4038](https://github.com/cgwalters-forge/agentic-job/pull/4038) `21aaa535`, [#4045](https://github.com/cgwalters-forge/agentic-job/pull/4045) `22cb4f9d`; enqueue: [#4013](https://github.com/cgwalters-forge/agentic-job/pull/4013) `16aa8f86` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43617132889), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43612982265) |
| 14 Nov 21:26 | rebase 1: #3789 `938bbef6`, #3835 `d806cc79` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43642762976), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43641928288) |
| 15 Nov 01:19 | rebase 1: #3817 `924dc660`, #3879 `27c6ba25`, #3902 `cadfa821`, #3942 `01f7f41a`, #3945 `69574126`, #3963 `3147c7a1`, #3998 `d00fc5e6`, #4013 `c46c527a`, #4045 `7e7a1c48` | skip: operator review requested | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43662487218), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43661137033) |
| 15 Nov 21:00 | enqueue: #3789 `0763522f`, #3817 `4e99654c`, #3835 `d905d75d`, #3902 `775f5692`; continue 1: [#3674](https://github.com/cgwalters-forge/agentic-job/pull/3674) `06de29cf`, [#3690](https://github.com/cgwalters-forge/agentic-job/pull/3690) `5ee3b2a5`, [#3694](https://github.com/cgwalters-forge/agentic-job/pull/3694) `6167b46f`, [#3695](https://github.com/cgwalters-forge/agentic-job/pull/3695) `8821cf83`, [#3696](https://github.com/cgwalters-forge/agentic-job/pull/3696) `5ce19919`, #3879 `3426cf88`, [#4253](https://github.com/cgwalters-forge/agentic-job/pull/4253) `29d8edfb`; rebase 1: #3804 `53c780ab` | wait: open-pr-cap, land #3333 first (overlapping paths) | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43761167571), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43760558683) |
| 16 Nov 01:00 | rebase 2: #3789 `0763522f`, #3817 `4e99654c`, #3835 `d905d75d`; enqueue: #3963 `9fb41d13`, #3998 `3682a69f`, #4013 `b9dfc83a`, #4045 `76e321f8` | wait: open-pr-cap, land #3333 first | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43783562028), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43783348432) |
| 16 Nov 07:57 | rebase 1: #3998 `3682a69f`, #4013 `b9dfc83a`, #4045 `76e321f8` | wait: open-pr-cap, land #3695 first | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/43827310633), [pass](https://github.com/cgwalters-forge/tracker/actions/runs/43826574783) |
| 17 Nov 02:05 | continue: #3690 `1eff5078`, "continuation round 1 is blocked, so a fresh round on another pool" | an [agent triage recovery run](https://github.com/cgwalters-forge/agentic-job/pull/3690#issuecomment-6935325926) at 01:47 | [shadow](https://github.com/cgwalters-forge/tracker/actions/runs/44000275836) |

Three causes account for all 60.

**Review-request holds (37).** `assignHolds: true` is a top-level key of
pass.json (since commit 87555ca, 8 November), so the pass stops a ready pull
request by requesting cgwalters's review instead of adding `needs-human`, and
then skips it with `operator review requested`. `just maintain-shadow-config`
copies only pass.json's `operator`, `bot`, `dispatchRepo`, `dispatchWorkflow`
and `pr` keys, so the shadow runs without `assignHolds`: it reads the pass's
stop marker, sees no label, treats the hold as released and starts the rounds
over (a review request holds a pull request only with `assignHolds`, and a
release permits fresh rounds: agent-board's
[docs/poll.md](https://github.com/cgwalters-forge/agent-board/blob/87e1e3efbc040074eb65d4ba4c3611527aec8dc7/docs/poll.md)
at the pinned revision). [#3942](https://github.com/cgwalters-forge/agentic-job/pull/3942) is the
pattern: the pass ran rebase rounds 1 and 2 (09:24 and 10:11 on 14 November),
stopped on `e3ab6e1c` at
[11:10](https://github.com/cgwalters-forge/agentic-job/pull/3942#issuecomment-6876393023)
with "2 rebase rounds used", and the shadow at 16:44 would start "rebase round 1
of 2" on that same head. A maintainer configured like the shadow would spend
new rebase and continuation rounds on pull requests the pass had parked for the
operator, and would label `needs-human` where the pass requests a review.

**Open pull request cap (22).** `openPrCap: 6` is also top-level in pass.json
(same commit) and not in the shadow's configuration. On 15 and 16 November the
pass held approved, conflicting or incomplete pull requests with "land #3333
first; overlapping paths"; the shadow would have enqueued eight, continued seven
and rebased seven of them at once.

**Agent recovery (1).** On 17 November the pass, running outside Actions,
answered a blocked continuation on #3690 (and a blocked rebase on
[#3333](https://github.com/cgwalters-forge/agentic-job/pull/3333#issuecomment-6935323515))
with an agent triage recovery run. The recovery bounds landed in commit 172d233
on 16 November, but main's pass.json has no `pr.agentRecovery`, so neither the
shadow's configuration nor the pinned pass could have previewed that step; the
shadow would have stopped with `needs-human`.

None of the 60 is a difference in reading the pull request: review state,
checks, conflicts and checkpoints agreed on every head both sides saw. The
differences are the pass's holds and recovery that live outside the `pr`
policy the shadow copies, plus the pass's request budget, which starved
agentic-job for four days while the shadow had 41 steps ready for it.

## Same-head replay with the hold settings, 22 November 2026

`just maintain-shadow-config` now also copies pass.json's top-level
`assignHolds` and `openPrCap` (today `true` and `12`), which the pinned poll
(agent-board `cfba79e`, the same pin as poll.yml; standalone support since
agent-board `f7a090f6`) reads with the pass's bounds. To check the first two
causes above on live state rather than from the old logs, the pinned
`agent-board poll --dry-run` ran twice on cgwalters-forge/agentic-job, 05:57:30
to 05:57:53 UTC, with fresh state files and a read-only token: once with the generated
configuration minus those two keys (the old shadow) and once with it. Both read
the same 11 open bot pull requests on the same heads.

| Pull request, head | Old shadow | New shadow |
|---|---|---|
| [#4302](https://github.com/cgwalters-forge/agentic-job/pull/4302) `06189190` | fix: needs-human was removed, so the rounds start again | skip: operator review pending (pass stop for older head `01352759`) |
| [#4399](https://github.com/cgwalters-forge/agentic-job/pull/4399) `c14ea602` | the same fix | skip: operator review pending (pass stop for current head) |
| [#4402](https://github.com/cgwalters-forge/agentic-job/pull/4402) `2294ebda` | needs-human: review job failed again after a rerun | the same skip |
| [#4472](https://github.com/cgwalters-forge/agentic-job/pull/4472) `d0698169` | the same fix | the same skip |
| [#4507](https://github.com/cgwalters-forge/agentic-job/pull/4507) `d48b7e84` | the same fix | the same skip |

The other six were labelled `needs-human` and skipped by both. The old
shadow totalled 4 fix rounds and 4 pull requests in flight, the new one none.
Each new skip reads `operator review pending; requester unknown` (the
read-only token cannot tell who requested the review) and rests on a pass stop
marker: for the current head on four, for the older head `01352759` on #4302
(for example
[#4507](https://github.com/cgwalters-forge/agentic-job/pull/4507#issuecomment-7074478744),
04:58 UTC). That matches the pass's own hold, so on these heads the
review-request hold cause is closed.

Not covered: the open pull request cap. The approved search found 10 and admitted
none, and no pull request was ready to rebase, continue or enqueue behind an
overlapping older one, so neither run reached `openPrCap`. The 22 historical
cap differences are attributed to the missing key at the then-current value 6
(now 12), unverified: a replay at 12 need not reproduce the 15 to 16 November
waits, and none counts as closed until a replay finds an overlapping pull
request ready to step.

Agent recovery is unchanged: main's pass.json still has no `pr.agentRecovery`,
and the shadow copies that key only when it is set. That the 17 November
recovery runs came from a pass not configured by the checked-in file is
inferred from this absence and from the pass running outside Actions those days
(above), and a shadow cannot preview them from this file. Rolling out
missing-data and recovery handling belongs to
[tracker#1571](https://github.com/cgwalters-forge/tracker/issues/1571), not here.

Other writers remain. poll.yml applies again (dispatched runs every 45 minutes,
the latest at 05:39 UTC) and still follows agentic-job, because pass.json has no
`pr.maintainers`. The shadow never copies `maintainers`: copied, it would hand
agentic-job over to the very maintainer it previews and take no step there. So
when the pass later lists agentic-job there, the shadow keeps previewing
pass.json's policy cut to agentic-job instead of falling silent, though the
pass then has no step there to compare it with. The shadow still runs as a dry
run with the job token and publishes only its job summary.

## Overlap cap replay, 22 November 2026: not reached, unverified

This follows up the open pull request cap, which the section above left "Not
covered". The cap does not hold back a merge-ready head: at the pin it turns
only a `fix`, `rebase`, `continue`, `update` or `run rerun` step into a wait
([poll.rs:9570-9580](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/poll.rs#L9570-L9580)).
The question is whether the generated single-repo configuration makes a younger
pull request that would otherwise take such an action, say an in-bounds `fix`
or `update`, wait with `open-pr-cap: land ... first; overlapping paths` behind
an older one that shares a path, as the central pass would, while a disjoint one
eligible for the same action takes it. Answering it takes three previews of the
same input: the central pass, `poll --dry-run` with the generated
configuration, and the same configuration without `openPrCap` as a negative
control, which must take the baseline action for both pull requests. Dropping
`openPrCap` also drops the merge-queue "ahead in queue" wait for an approved
head
([poll.rs:9441-9455](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/poll.rs#L9441-L9455)),
and a conflicting rebase meets that wait before the cap, so neither pull
request may be approved for merge or need a conflict rebase. None of the three
reached the cap decision, so the question stays unverified.

The pin was agent-board `77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0`, the single
`AGENT_BOARD_REV` across `.github/workflows` (`just agent-board-pin`). It was
installed with its attestation and checksums checked by `RUNNER_TEMP=/tmp/rt
just build-agent-board 77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0`. Today `just
maintain-shadow-config .github/pass.json cgwalters-forge/agentic-job` gives
`assignHolds: true` and `openPrCap: 12`.

**The cap is not armed below its value.** `pressure_ahead`
([poll.rs:10060-10072](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/poll.rs#L10060-L10072))
counts the repository's open bot pull requests, parked ones included. While
that count is below `openPrCap`, it returns before it reads any older pull
request's paths. agentic-job had 11 such pull requests at 05:57 UTC (above) and
at the runs below, so at today's cap of 12 no ordering of readiness or overlap
could reach the gate.
At the historical cap of 6, the same 11 would have armed it. That is why a
replay at 12 cannot speak to the 22 waits of 15 and 16 November, which happened
under 6.

**No deterministic replay was possible.** At the pin, only `agent-board pass`
records and replays (`--record`, `--replay`;
[pass.rs:10799](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/pass.rs#L10799)).
`agent-board poll`, which the shadow runs, has neither. Its `--snapshot`
replaces only the board read, and its client reads only
`https://api.github.com/`
([github.rs:29](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/github.rs#L29),
[:707](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/github.rs#L707)).
Pointing `HTTPS_PROXY` at a closed port changed a 401 to `GitHub transport
failed`. This showed that the client attempted to use the proxy, not that a
fake origin could answer its requests. The client verifies TLS using platform
trust ([github.rs:800-813](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/github.rs#L800-L813)).
A local fake origin remains an untested option; it would need isolated TLS
trust and a dummy token. A central replay alone does not exercise the generated
configuration, so none was built.

**Live state did not reach the gate either.** Two read-only runs with the job
token and fresh state ran from 11:15:17 to 11:15:37 UTC, with the shadow's own
flags:

```sh
just maintain-shadow-config .github/pass.json cgwalters-forge/agentic-job > shadow.json
jq 'del(.openPrCap)' shadow.json > nocap.json
for c in shadow nocap; do
  agent-board poll --dry-run --config $c.json --follow cgwalters-forge/agentic-job --state $c-state.json \
    --fix-bounds .github/agentic-job/fix.toml --fix-bounds .github/agentic-job/midstream-fix.toml
done
```

Both made the same decisions on the same 11 heads:

- 5 were skipped as `labelled needs-human`: #3333, #4401, #4410, #4423 and #4506.
- 6 were skipped as `operator review pending` on a pass stop marker: #4302,
  #4399, #4402, #4472, #4507 and #4532.

Identical output shows only that the gate was not reached; it is not evidence of
agreement. No central preview ran. It would read the whole board, and on live
state it could not reach the gate anyway.

The closest existing evidence is agent-board's library test
[`open_pr_cap_keeps_landing_work_and_serializes_oldest_paths`](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/poll/recovery_tests.rs#L8).
It decides shared and disjoint paths at caps 1 to 3, and with no cap, under
both the pass's policy and a standalone `openPrCap`. It runs on a synthetic
fake rather than the built CLI with the generated file.

Closing this needs either replay support for `poll` and a shared fixture that
covers reads from all three previews (including reads unique to the cap-off
run), or live previews with identical decision inputs. A pass recording alone
may miss requests: replay rejects unrecorded reads
([pass.rs:10823-10828](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/pass.rs#L10823-L10828)).
For either approach, use:

- at least 12 open bot pull requests on agentic-job;
- a younger pull request that is not parked and would otherwise take a
  cap-eligible action, behind an older one that is not parked and shares a
  path;
- a disjoint control eligible for the same action, with no shared path with
  any older, non-parked bot pull request;
- fewer than `pressure::OLDER_LIMIT` older bot pull requests for each
  candidate, counting parked ones, and complete changed-file lists as read by
  the cap for both candidates and every older peer either would compare
  against. A truncated or unknown list or a scan cutoff can produce the same
  wait without finding a shared path
  ([poll.rs:10076-10104](https://github.com/cgwalters-forge/agent-board/blob/77fbe82e35bdce0d1580d78f0cf7c88e0098bdd0/crates/board-forge/src/poll.rs#L10076-L10104));
- the same decision inputs in the central preview and both shadow runs, not
  just the same heads: holds, labels and checks can change without a push.

With those inputs confirmed, require both cap-on previews to report an
`open-pr-cap` wait for the overlapping candidate naming the expected older PR
(the first one with a shared path). The disjoint control must take the baseline
action in both cap-on previews, and both candidates must take it with
`openPrCap` removed.

`AGENT_BOARD=/tmp/rt/agent-board/bin/agent-board just test-maintain-shadow`
passed with the pinned CLI. It checks that the generated configurations decode
and that out-of-bound holds are refused, not the cap decision.
