# Source of truth — where each kind of fact lives

**Status:** adopted 2026-08-05
**Why it exists:** Hadi asked "what is our priority? where do you keep priority?" The honest
answer was *nowhere*. Priority lived in six places and none of them was ranked, so the
question could not be answered by opening anything.

This document names one home per kind of fact, and — more importantly — says what every
other surface is **demoted to**. A source-of-truth table that only adds a surface is a
seventh surface.

---

## The one queue

**GitHub Project 3 — "Mumega Reset — Breathing Organism"** is the ranked queue.
It gained a `Priority` field on 2026-08-05: `P0 — now`, `P1 — this week`, `P2 — queued`,
`P3 — someday`.

If work is worth doing, it is an item there with a priority. If it has no priority, it has
not been triaged — and **blank is honest**. Ranking all 56 items today would have produced
a number that looks like a decision and isn't. Blank says "nobody has decided yet," which
is true and visible.

Why this surface and not another:

- GitHub already **carries** the work — the issues, the PRs, the diffs, the review threads.
  A queue that points at work living somewhere else drifts the moment either side moves.
- It is cross-repo. `mupot`, `sos` and the rest rank against each other, which is the whole
  point — the question is never "what is the top mupot issue", it is "what is next".
- Hadi can open it on a phone without an agent in the loop. A priority surface that needs
  an agent to read it aloud is not a priority surface.

This is the existing `D1 governs, GitHub carries` split, extended: **GitHub also ranks.**

## The table

| Fact | Home | Owner | Death condition |
|---|---|---|---|
| **What is next** | GitHub Project 3, `Priority` field | Hadi ranks; Kasra keeps it current | — it is the queue |
| Code, diffs, durable argument | GitHub repos | repo owner | — |
| Identity, authorization, gates, receipts, budgets | mupot (D1) | Kasra | — |
| Authenticated courier: provenance, request id, dedupe, ACK, wake | SOS bus | Kasra | when mupot proves durable inbox + ACK + unanswered-view through dual-run |
| Long-term recall | Mirror | **unowned** | repair/export backup, inventory callers, authenticated recall probe → named owner + SLO, or archive after a measured non-use window |
| Published content | Inkwell | Kasra | — publication adapter only; never boot, task authority, or memory |

## What everything else is demoted to

Each of these was, until today, somewhere priority might live. None of them is any more.

| Surface | Was | Now |
|---|---|---|
| SOS bus task board | a backlog | **execution transport.** Wakes an agent, carries a brief. Never the ranked list. The bus is poll-only and consume-once — reading drains it, so it cannot hold state anyone can re-read |
| mupot internal tasks | a backlog | **execution records** — for now. Priority came out of this because the pot could not rank; that is being fixed in the pot (mupot#710) rather than routed around, so this row is expected to change once ranking has been used in anger |
| Linear | "human portfolio ranking" | **unused.** Credits lapse ~2026-11-17; adopting it now means a third copy of the same list. Decide by 2026-10-17 or let it lapse |
| `CLAUDE.md` "Current" | de facto status | **orientation only.** Narrative for a cold start. If a fact there matters operationally it belongs on the board |
| Session task lists | invisible | **scratch.** Hadi cannot see them. That invisibility already caused a real failure ("I can't see the mission"). Anything worth tracking gets an item |
| `brain-pinned.sh` directive | — | unchanged. The **only** write path for `last_human_directive`, and still the only channel that may steer. The bus wakes; it never steers |

## The rules that keep it true

1. **Rank before work, not after.** If it is worth doing now, it gets a priority before the
   first commit — otherwise the board records history instead of intent.
2. **Blank is a real state.** Untriaged is not P3. Do not fill the column to look complete.
3. **One item per thing, in the repo that owns it.** Cross-repo ranking is what the project
   board is for; duplicating an issue into a second repo to make it visible re-creates the
   problem this document exists to end.
4. **A surface not in the table above holds no priority.** If a seventh place appears, either
   it belongs here with an owner and a death condition, or it is scratch.
5. **Every retained service needs an owner and a death condition.** "Nobody has deleted it"
   is not a reason to keep something. Mirror is the live example: reachable, restarting,
   ownerless, and not demonstrated load-bearing.

## Known gaps, stated rather than implied

- **185 open issues and 65 open PRs are not ranked.** Only the live work is. The PR count
  grew 55 → 65 in a single day, which makes unlanded mutable work the more dangerous
  number — a stale PR is a merge conflict and an expired gate waiting to happen.
- **mupot could not rank.** Tasks had no priority field and no parent/subtask link, so
  ranking lived in task *titles* (`[P0] …`) — unsortable, unfilterable, invisible to every
  view. Both are fixed by mupot#710 (migrations/0079). Until that lands and the operator
  has actually used it, GitHub Project 3 stays the queue; **the intent is to move ranking
  into the pot**, because a queue we own beats one we rent.
  - **Correction, recorded rather than quietly dropped:** an earlier version of this list
    also claimed `task_update` rejects `approved` and "strands tasks in review". That is
    wrong and it was my error. `approved`/`rejected` are set by **`task_verdict`**, because
    a task must not approve itself — the refusal is a gate working as designed, and I was
    using the wrong tool for weeks while calling it a product defect. What was genuinely
    missing was the signpost: the error now names `task_verdict`. A dead end and a signpost
    are different products, but only one of them is a bug.
- **Labels are the next real gap**, and the one that unlocks views: without them there is
  no "my P0s across projects". Also absent vs. a mature tracker: estimates, comments on
  tasks, saved filters, milestones, and cycles as first-class objects (projects carry only
  a `cycle_boundary_at`).
- **This document is not enforced by anything.** It is a convention. The first time it is
  contradicted by what people actually do, the document is wrong and should be changed
  rather than quietly ignored.
