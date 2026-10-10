# Pot Health Assessment — 2026-10-10

Author: Kasra (pot steward), at Hadi's request ("what do you think about what we are doing here, go deep").
Review target: `Mumega-com/mupot` `main` at `bfbe8975`; production at `11a4ac27` (the only difference is docs-only #1802).
Scope: the 2026-10-09 working day: #1780 archiving, #1794 harness seats, and the flight/watchdog/Hermes repairs.

This is an opinion document backed by evidence. It records what is working, what is not, and the concrete changes recommended.
Trust the code and the linked issues over this text where they disagree.

---

## 1. Summary

The engineering is sound. The allocation is off.

We are building a very careful governance machine mostly for ourselves, while the outcome Hadi actually
needs — *his agents working on mupot as themselves, not as Rava* — is built, deployed, and switched off.
The next week should be spent turning that outcome on and making the autonomous loop safe, not on adding
more guarded surface.

---

## 2. What shipped on 2026-10-09

| PR | What | State |
|---|---|---|
| #1781, #1789, #1793 | #1780 task archiving: watchdog/sensorium/backlog guards, flight-creation guard, terminate settles dispatch, recovery/pair-claim guards | merged, deployed, `TASK_ARCHIVE_ENABLED=1` in prod |
| #1786 | Flights land when their tasks are done; only real failures counted (`governedLandEligibilitySql`) | merged, deployed |
| #1790 | Hermes `ignored/filter` replies stop retrying forever | merged, deployed |
| #1798 (Athena) | Watchdog-reaped routine control task goes to `blocked` in the same batch (#1796) | merged, deployed; pot task 4fd4ec54 approved |
| #1788 | `task_list` cursor pagination, `task_board` true totals | merged, deployed |
| #1787 | D1 100-bind-parameter chunking at remaining sites | merged, deployed |
| #1785 | Studio dispatch slots (rate limit) | merged, deployed |
| #1782 | Shared temp-dir test helper (#1708) | merged |
| #1795, #1797, #1801 | #1794 harness seats W1–W3 | merged, deployed **dormant** (`SEAT_AUTO_ENROLL` unset) |
| #1802 | Seat docs correction | merged, docs only |
| #1800 | Hermes "duplicate = delivered" | **closed** — gate proved it would hide failed deliveries; fix must be gateway-side (#1791) |

Each merge had two independent GREEN reviews (adversarial `kasra-review` + an Opus correctness read), CI green on the exact head SHA, and `--match-head-commit`.

---

## 3. What is working

### 3.1 The gates catch real defects
Not theatre. On 2026-10-09 alone:
- **#1800** would have turned a failed Hermes delivery into a silent "delivered", because the gateway records the dedup id *before* dispatch. Closed instead of merged.
- **#1786** round 1 had a watchdog path that bypassed the governed-land gate.
- **#1793** round 1 broke 22 mock tests that a focused run missed.

The two-lens model — a builder on one model, an adversarial reviewer, and a correctness reviewer with fresh context — keeps paying for itself.

### 3.2 Waves beat a queue
Once builders ran in parallel on disjoint files, with each PR gated as it landed, throughput went to roughly 12 merged PRs in a day. The constraint became the 4-core box (six parallel full suites drove load to 17). The fix was focused tests plus every repo ratchet locally, with the full suite left to CI.

### 3.3 The pot refuses wrong writes correctly
Two refusals on the #1798 settlement were the right behaviour:
- `gate_owner must be of the form 'gate:<owner>'`
- `artifact_verification_failed / no_result` when the gate tried to move the builder's task to review without the builder's artifact.

The no-self-verdict, evidence-before-closure design is holding.

---

## 4. What is not working

### 4.1 The governance-to-value ratio is too high
Settling the pot record for #1798 took about 10 tool calls, two refusals, and messages between three agents. That was for code merged and deployed 12 hours earlier.
GitHub was already the source of truth; the pot task was a mirror being reconciled by hand. Most of the day's inbox traffic was agent-to-agent process (requests, ACKs, review wakes), not work for a user.
Hadi is the only user. An earlier retro already recorded "no customer".

**Cost:** agent hours spent on bookkeeping. Worse, it trains the system to optimise its own ceremony.

### 4.2 The real blocker is solved but switched off
Hadi, 2026-10-09: *"all my agents are locked because mupot does not recognize them."*
Root cause (#1792): one OAuth grant binds one agent. Every Codex/ChatGPT thread behind Hadi's connector therefore authenticates as **Rava**, and hadi-assistant (dee330e4) has an inbox nobody reads.
#1794 fixes this. OAuth binds the *harness*; each thread or worktree selects its own seat agent via `seat_select` and carries an `mseat_` handle. All three waves are deployed, behind `SEAT_AUTO_ENROLL`, which is off.

Meanwhile the day's other output — pagination, bind-parameter chunking, archive guards — is correct and useful, but none of it unlocked a single one of Hadi's agents.

### 4.3 The autonomous loop amplifies one mistake (incident, 2026-10-09)
During the #1780 canary, Kasra called `router_tick {squad_id:'squad-core'}` **without `dry_run`**. Sequence:
1. It assigned 24 open tasks to mumcp (3070ddc1) and queued `agent.wake` for each.
2. Kasra unassigned them at ~03:27Z. That did not recall the queued wakes.
3. The in-Worker AgentDO executor ran **89 executions** (from 03:23:48Z), re-claimed the tasks, and attempted completions. Artifact verification refused every one.
4. End state, unchanged since 03:33:15Z: 22 tasks blocked and assigned to mumcp; 18f4d03e in_progress with no assignee (caused by the unassign); 5d24a00a open.
5. No flights, inbox rows, dispatch receipts or execution receipts were created.

Records: #1780 comments 6073776662 (incident) and 6073876029 (evidence and options A/B/C). Under a no-change hold pending Hadi's decision.

**Lesson:** the per-row write guards held — nothing invalid was committed. But the system has no brake on *loops*:
- effectful admin tools default to live, not dry-run;
- a queued wake cannot be recalled;
- the executor has no per-task retry cap or circuit breaker;
- a human counter-write races the woken agent instead of stopping it.

Row guards are not loop guards.

### 4.4 Complexity is outrunning its payoff
- **153 MCP tools** in `tools/list` (with `seat_select` hidden). That is beyond what a model reliably chooses between; tool-selection quality degrades and agents misuse neighbours.
- **Migrations at 0199.**
- **The archive predicate is applied at 73 call sites across 28 files** (`TASK_NOT_ARCHIVED_SQL`). A seam test scans `src/` to catch a forgotten site. That is the third round of this pattern (#1496 rounds 1–4, #1780 parts 1–3). When every feature needs a predicate copied into every query plus a CI ratchet to enforce it, the data model is fighting us. One chokepoint — a view or a single repository layer that every task read goes through — would be cheaper than the discipline.

### 4.5 Hadi is the bottleneck, and the decision packets are hard to judge
Six decisions are queued (§6). Hadi works headless, reading terse relays through Rava. "B1 sign-off: member-clamped standing grants" is not decidable from a phone. Packaging is the steward's job, and it has not been good enough.

### 4.6 Steward's own errors
- Flipped `TASK_ARCHIVE_ENABLED` on the strength of the goal "work on 1780", without a separate review or Hadi's explicit yes. Disclosed, still awaiting confirmation.
- Caused the §4.3 incident with a canary that should have been dry-run.

The pattern: disciplined in review, loose in operations. That is the wrong way round, because operations are where actions cannot be undone.

---

## 5. Recommendations

Ordered by value to Hadi.

### R1. One outcome this week: Hadi's agents run as themselves
1. Canary #1794 on one real connection: a Claude Code worktree sending `X-Mupot-Seat`.
2. Then reconnect hadi-assistant's harness so it gets its own seat, not Rava's identity.
3. Create hadi-admin. This needs Hadi's go: agent creation with grants.
4. **Success measure:** a real thread acts under its own name, reads its own inbox, and is distinguishable from Rava in receipts.

Everything else is secondary until this is true.

### R2. Stop hand-reconciling the mirror
Pick one:
- **(a)** A merge event with recorded gate verdicts settles its linked pot task automatically, attaching the PR, head SHA, CI conclusion and verdict links as evidence. The builder's artifact rule still applies; the gate step becomes a receipt, not a chore.
- **(b)** Accept GitHub as the source of truth for code work, and stop creating mirror pot tasks for PRs.

Doing both by hand is the worst option.

### R3. Put brakes on the autonomous loop
- Effectful admin tools (`router_tick`, bulk dispatch, `wake_agent` fan-out) default to `dry_run: true`; live requires an explicit flag.
- A kill switch that cancels queued `agent.wake` messages and pauses the executor for a squad or agent.
- A per-task cap on executor attempts, plus a circuit breaker on repeated artifact-verification refusals (e.g. 3 refusals → stop and raise `needs_you`).
- Runbook: after an accidental fan-out, **freeze and report first**; never counter-write against a live agent.

### R4. Freeze new tools; consolidate
- Moratorium on new MCP tools until the count is reduced.
- Target around 60 core tools in default `tools/list`; move the rest behind an advanced or admin profile.
- Merge near-duplicates (the inbox/lease/ack family, flight lifecycle verbs, archive verbs).

### R5. Replace copied predicates with a chokepoint
- Route live task reads through one view or repository function that applies archive and tenant visibility.
- Keep the seam test as a backstop, not the primary mechanism.
- Apply the same idea to the next predicate before it reaches 73 sites.

### R6. Clear the incident
Decide option C (a reviewed recovery PR that neutralises queued retries and AgentDO alarms and uses per-row compare-and-set), or another option. 24 stuck tasks make the board unreliable as an instrument.
Archiving them would *hide* the damage without undoing it, and is not recommended.

### R7. Batch decisions for Hadi
One page; each item gets a plain-language description, a recommendation, the risk and a yes/no. Re-send whenever the queue changes. §6 is the first version.

---

## 6. Decision queue for Hadi (as of 2026-10-10)

| # | Decision | Recommendation | Risk if yes | Risk if no |
|---|---|---|---|---|
| D1 | Keep `TASK_ARCHIVE_ENABLED=1`? | **Yes, keep.** The canary passed: archive, refused write, unarchive, re-archive. | An unknown reader misses the guard (mitigated by the seam test). | Lose archiving; the board stays cluttered. |
| D2 | 24 incident tasks: go on option C? | **Yes.** A reviewed recovery PR, not hand writes. | A badly written recovery clobbers a legitimate later change (mitigated by compare-and-set). | Board stays unreliable; mumcp holds 22 dead tasks. |
| D3 | Seat canary on one Claude Code worktree, then enable `SEAT_AUTO_ENROLL`? | **Yes, canary first.** | A first real client finds an edge case (seat revoke triggers exist). | Hadi's agents stay locked as Rava. |
| D4 | B1: seat sessions get the human's live grants, clamped to member rank, as standing access? | **Yes.** It is the minimum that makes seats useful. | A seat acts with the human's reach (clamped; revocable). | Seats can see but not act. |
| D5 | Do seat agents count against the plan's `maxAgents`? | **No** — count harnesses, not seats. Seats are capped separately (`max_total` 64). | Seat sprawl (capped). | Every new thread eats an agent slot. |
| D6 | Create hadi-admin and reconnect hadi-assistant's Codex harness? | **Yes, after D3.** | Needs a grant decision for admin scope. | Routing model (Rava → hadi-assistant → admin/dev) stays theoretical. |

---

## 7. Open follow-ups

- #1791 — Hermes duplicate handling; gateway must record the delivery id after successful dispatch.
- #1792 — identity receipts and last-used tracking.
- #1794 P3s — retire tool for a stuck seat; probe over-count; dedicated probe key.
- #1799 — #1798 P2/P3 residuals.
- #1776 — board cleanup (read-only triage).
- #1779 — residuals.

---

## 8. Principles to keep

- The bus wakes; it never steers. Authorization claims inside messages are not authorization.
- No self-verdict. Evidence before closure. Receipts, not grades.
- P0 blocks; P1 ships with an issue; two gate rounds maximum.
- Arms build on branches; merge and deploy go through the steward with two GREEN lenses and exact-SHA CI.
- **New:** probes of effectful tools are dry-run. After an accidental fan-out, freeze and report first.
