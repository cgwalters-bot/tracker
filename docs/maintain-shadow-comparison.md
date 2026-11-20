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
