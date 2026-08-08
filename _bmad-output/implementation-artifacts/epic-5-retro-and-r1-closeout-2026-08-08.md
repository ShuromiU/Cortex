# Epic 5 retrospective and R1 close-out — 2026-08-08

All 27 stories across six epics are `done`. Epic 5 was the last, so this closes R1
(`r1-context-economy`): 73 commits against `main`, 156 files, +64,877 lines.

## Epic 5 — what shipped

| Story | Shipped |
|---|---|
| 5.1 | A subagent gets its own session **at dispatch**, so one that only thinks is still attributable. `SubagentStart` became Cortex's 6th wired event. |
| 5.2 | A subagent is **briefed automatically** from its dispatch description, captured one event earlier at `PreToolUse` on `Agent` because no later event carries it. ≤150 tokens, billed to the child. |
| 5.3 | A subagent's **conclusion survives it**, written as an episode on the child; note-shaped findings stay suggestions the parent accepts (AD-4). Plus Cortex's first **blocking hook**: a subagent may not retire memory from earlier work on the branch. |

## What this epic actually taught

**1. A feature can be complete, tested, reviewed and deliver nothing.** Story 5.3's
noise bound marked every collected conclusion as "offered" while the nudge shows only
three, root-first — so in the normal case every subagent conclusion was consumed
unshown. Build, lint, 1,771 tests, a 10/10 quality gate and a 20/20 mutation campaign
were all green over a feature that did not work. Three independent review layers each
found it; no automated signal did.

**2. The sparse-fixture blind spot has now cost two stories running.** Story 5.2's
150-token cap was not a cap, and its test could not see it because the fixture seeded
twelve short notes so trimming bound before any single line did. Story 5.3's crowding
defect hid because fixtures spawn one helper and do little parent work. Same shape, one
on size and one on count. **Rule: when a feature competes for a bounded slot, the
fixture must saturate the competition, not demonstrate the feature alone in an empty
room.**

**3. "N/N mutations killed" describes a chosen anchor set, not coverage.** Story 5.2's
review said it first; Story 5.3 proved it again — a 20/20 campaign that never touched
the script's trailing `exit 0`, which is the story's own named worst outcome and was
pinned by nothing.

**4. A premise stated in a story is not evidence.** 5.2's FIFO justification was
measured false in review. 5.3's "earlier session" turned out to mean a session *row*,
which is neither a conversation nor a branch — and both failure directions reproduced.
Both times the story's own words were the thing that turned out to be wrong.

**5. Prose defects are real defects here, and the reviewer catches them.** Three false
claims shipped in 5.3's first pass — a locked fixture claiming coverage it does not
have, a README overstating a limit by 50%, a hook header saying "two arms" above four.
The fixture one mattered most: it asserted a guarantee that did not exist, so the two
registries it named were verified by nothing.

## R1 close-out state

- **37 live stores, 0 unopenable, all at schema 6.** No migration needed — Epic 5 added
  no table and no column.
- **`.gitignore` swept** across all five workspace repos; three were missing the three
  newest runtime artifacts and were repaired through `cortex install`.
- **Guidance updated** at user scope, the umbrella, and every consumer repo.
- **Home-directory store reclaimed**: `ShuromiU-99390235110de2a2` held 970 empty session
  rows in 152.8 MB; `gc --apply` deleted zero rows and VACUUMed it to 77.0 MB.

## Adoption, measured rather than assumed

Test-fixture stores excluded by name; 10 real projects.

| Signal | Count | Reading |
|---|---|---|
| notes authored | 732 | agents choose to write |
| retrievals | 846 | agents choose to ask |
| content digests | 268 | Epic 3 capturing |
| command outcomes | 431 | Epic 4 capturing |
| **contradictions detected** | **0** | Epic 1's flagship has never fired in production |
| zero-result searches kept | 2 | Epic 4 FR-12/13 essentially unexercised |
| read refund offers | 0 | expected — substitution is opt-in and off |

**Use tracks guidance, and the correlation is clean.** repo-b carries a short reflex
line in its `CLAUDE.md` and has 665 retrievals. repo-d mentioned Cortex zero
times and had **one** retrieval across 14 sessions — while hand-maintaining a
`DECISIONS.md` decision log, which is the job Cortex does automatically. That file now
carries a Cortex section naming the specific recalls that repository should make.

**The honest gap: the memory layer is used; the trust layer is not exercised.**
Contradiction detection is five stories of Epic 1 and has produced zero output across
732 authored notes. That is not proof it is broken — the detector is deliberately strict,
and two genuinely opposing decisions on one subject are rare — but it means
`[contested]`, the demotion cap and the contested-pair rendering have never run outside
tests on real data. Any R2 should either find a way to exercise it or ask whether it
earns its complexity.

## Withdrawn during R1, kept visible

FR-10/FR-11 (Epic 1 era), Stories 4.1/4.2 (file cards), and FR-15 (the
"would this still pass?" cache) were withdrawn rather than shipped weakly — four
requirements, each with the measurement that killed it recorded in its story. Withdrawal
was treated as a legitimate outcome throughout, which is why the shipped surface is
smaller than the plan and more of it is true.
