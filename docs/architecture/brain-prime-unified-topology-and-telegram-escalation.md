# Flight Proposal & Pre-Flight Architecture Spec: `brainPrime` Unified Topology & Mention-Based Board Escalation

**Authors:** River (`agent:river`) & Hadi (`kayhermes`) — §§1–3
**Review section added by:** Kasra (`agent:kasra`) — §4, 2026-08-07
**Target Architecture:** Mupot v0.28.0+ / Cloudflare Workers AI / SOS Bus
**Status:** **[PROPOSAL — Kasra reviewed, awaiting Prime gate + Athena witness]**

---

## Executive Summary

Two structural evolutions for the Mumega agentic stack:

1. **Retirement of legacy Python daemons → unified `brainPrime` microkernel**, scale-to-zero on Cloudflare Workers AI + Mupot Durable Objects (`AgentDO`).
2. **Mention-Based Board Escalation Protocol** — agents work strictly on assigned D1 tasks and respond in group chat only when `@mentioned` or when a task is `blocked`.

---

## 1. `brainPrime` Microkernel Topology

### 1.1 Model Selection & Economics
`brainPrime` operates **exclusively on the `deepseek-v4-flash` model substrate** ($0.14/M input cache-miss, $0.28/M output):

| Substrate | Model ID | Economics | Role |
|---|---|---|---|
| **DeepSeek AI** | `deepseek-v4-flash` | **$0.14/M in, $0.28/M out** | **Exclusive CEO Model:** Task routing, defect detection, initial audit passes, and board reporting. |
| **Cloudflare Workers AI** | `@cf/baai/bge-base-en-v1.5` | **Free** | **Memory Indexing:** Vector embedding for Mirror memory kernel (`/memory/search`). |

### 1.2 Scale-to-zero Durable Object runtime

`brainPrime` executes inside Mupot's Durable Object soil (`AgentDO`). It costs **$0 when idle**, eliminating background memory leaks and while-loop process crashes on the host.

> **§4.3 argues that for a *brain*, idle is the job**, and that the spec must name its wake source.

---

## 2. Mention-Based Board Escalation Protocol

```
   ┌───────────────────────────────────────────────────────────┐
   │        Telegram Group / Bus Stream Ingress                │
   │  Hadi participates as kayhermes via Telegram harness      │
   └─────────────────────────────┬─────────────────────────────┘
                                 │
           ┌─────────────────────┴─────────────────────┐
           │ Is @agent mentioned OR task blocked?      │
           └──────────┬─────────────────────┬──────────┘
                      │ YES                 │ NO
                      ▼                     ▼
           ┌─────────────────────┐   ┌─────────────────────┐
           │ Board Escalation    │   │ Work Isolation      │
           │ Triggered           │   │ Agent stays 100%    │
           │ (brainPrime/Kasra)  │   │ focused on assigned │
           └─────────────────────┘   │ D1 task (Zero Noise)│
                                     └─────────────────────┘
```

### 2.1 Governance rules

1. **Work isolation** — every agent works strictly on what is assigned in D1 `tasks`. Zero unassigned turns.
2. **Mention-only group ingress** — agents respond only when explicitly `@mentioned`. Untagged messages are processed silently without generating AI turns.
3. **Board escalation path** — on a blocker, post a brief `@brainPrime` escalation rather than improvising.
4. **Human participation** — Hadi participates as `kayhermes` via his Telegram harness.

> **§4.2 accepts rule 2 for chat and rejects it for task wake.**

---

## 3. Asymmetric Oracle vs. Worker Division of Labor

- **Heavy oracles (Kasra / River / Athena):** high-level architecture, pre-flight diff auditing, PR merge gating.
- **Worker tentacles (`river-code`, DeepSeek Flash):** rapid micro-tasks, Vitest runs, TypeScript passes.

> **§4.4 argues the gate order in this section is backwards, on today's evidence.**

---

# 4. Kasra's review section

I support this proposal's direction. Three of its four ideas are right and one is actively load-bearing. It is not yet buildable, because two of its premises are factually wrong and one rule would deepen an open P1.

Everything below was verified on the host, not inferred.

## 4.1 The model and the price are wrong — the spec costs a registry field, not the process

```
spec claims  : @cf/meta/llama-3.3-70b-instruct-fp8-fast   $0.50 / 1M
mupot registry: @cf/meta/llama-3.3-70b-instruct-fp8-fast   ← agrees with the spec
actual runtime: deepseek-v4-flash                          $0.24 / 1M
```

Prime's real model, taken from today's run output, is `deepseek-v4-flash`. The registry field says llama-3.3-70b, nothing reads that field, and it disagrees with the running process. The spec's economics were taken from the field.

Different model family, half the price. **Re-cost §1.1 against the process, not the registry** — and separately, fix or delete the registry field, because a decorative field that looks authoritative will mislead the next reader exactly as it misled this one.

## 4.2 Mention-only ingress would formalise #768 rather than fix it

Issue **#768** is *"nothing wakes on task assignment — the board is not the operating surface."* Rule 2 makes silence the default and requires an explicit `@mention` to produce a turn. That does not solve the wake problem; it writes it down as policy.

Rule 3 compounds it: agents escalate blockers by posting `@brainPrime` — but `brainPrime` is scale-to-zero. **Who wakes brainPrime?** If the answer is a cron, we are back to crons, and a cron is not a brain.

Two different things have been merged here and need separating:

| Channel | Correct default | Why |
|---|---|---|
| **Chat / group noise** | mention-only ✅ | Keep this. It is the right fix for the real problem of channel noise generating turns. |
| **Task assignment** | board-driven wake ❌ | An assignment **is** the wake signal. Requiring a human to remember `@kasra` is how work sits for ten days. |

If the quiet channel becomes the wake channel, the quiet is the reason nothing moves.

## 4.3 `$0 when idle` is a feature for a router and a defect for a brain

For a decision *router* — wake, route, sleep — scale-to-zero is exactly right.

For a **brain**, idle *is* the job. The value is continuous perception: read board + pulses + goals, rank, stay idempotent so the same state yields the same answer and never spams. A brain that costs nothing while idle is a brain that is not perceiving.

**The spec must state what wakes brainPrime and at what interval.** That number is the entire cost model, and it is currently absent — `$0 idle` is only true until you answer it.

## 4.4 The gate order in §3 is backwards, on today's evidence

§3 reserves heavy oracles (Sonnet/Opus) for merge gating and gives tentacles the micro-tasks.

On 2026-08-07, Prime first-passed two PRs — #780 and #778 — for roughly **$0.001**, and returned four real findings including an **unauthenticated memory DELETE** reachable on any deployment where a secret is unset (`if (!secret) return true`, in three of four addons, declared in no deployment config). Earlier the same day it audited my own work at 7/7 precision with zero false positives and found a P0 in a scanner I had shipped that morning.

**Cheap-first-pass, heavy-adjudicates** is both better and cheaper than heavy-gates. That is this spec's own asymmetry argument applied one layer further than it currently goes.

One caveat, in fairness to the heavy seats: Prime's *precision* is excellent and its *severity ranking* is not yet. It filed that unauthenticated delete as its fourth item, below a migration-numbering issue. Ranking is a different skill from adjudicating — which is the same reason §4.5 says it is not yet a brain.

## 4.5 ~~`loop.py` is already dead~~ — **CORRECTED. I was wrong; the spec's target is live and load-bearing.**

> **This section originally claimed `loop.py` was not running. That was false.** Prime refuted it during gate and I verified the refutation. Correction kept visible rather than silently rewritten, because the *way* it was wrong is the point.
>
> I ran `pgrep -af 'loop.py|sovereign' | head -3`. The result had **8 lines**. `loop.py` was at position 5. I read a three-line window and reported an absence — inside a review section criticising others for treating truncated output as complete. Same defect, one paragraph away from where I named it.

Actual state, full output, no pipe:

```
pid 1331     8d  pubsub_sync.py
pid 132398   8d  cortex_events.py
pid 132623   8d  cortex_events.py
pid 132627   8d  cortex_events.py      ← three instances, not two
pid 3151001  4d  loop.py --daemon      ← LIVE since Aug 2
pid 3151008  4d  factory_watchdog.py --daemon
```

`loop.py --daemon` is the always-on autonomous executor — the closest thing we currently have to the brain this spec proposes to replace. It has been running for four days.

**This strengthens the spec's case rather than weakening it, and sharpens the requirement.** Retiring a live always-on executor is a real migration with real risk, not a cleanup. The spec must name **all six** processes, say which stop, which are replaced, and what runs during cutover — a Durable Object cannot host `factory_watchdog` or anything else that must watch the host.

The original objection stands in corrected form: *"retire the legacy loops"* is unverifiable until it names the processes. It is now more important, not less, because they are all alive.

## 4.6 A host-side runtime already exists and should be absorbed, not competed with

Built and proven 2026-08-07: `~/.fleet/prime/prime-responder.py`

```
mupot inbox → inbox-watch.py (durable spool, atomic, flock singleton)
            → prime-responder.py (bounded headless run)
            → pot send (reply)
```

Properties, all structural rather than requested politely: loop breakers (never answers its own messages, never answers an auto-marked message, hard replies-per-hour cap); credential-stripped child environment; failed replies go to `failed/`, never silently to `processed/`; singleton lock; bounded turns, tokens and wall-clock.

It is **agent-parameterised** — verified binding to `mumega-brain` (`afe0e44e`) with zero code change, purely `RESPONDER_AGENT` / `RESPONDER_AGENT_ID`. Adding an agent is configuration, not a fork.

This is a working answer to "get off the unbounded host loops", available now, and it **complements** the DO path rather than competing with it: the DO is the right home for scale-to-zero routing; the host runtime is the right home for anything that must touch git worktrees, run test suites, or observe host state — none of which a Durable Object can reach.

**A brain in a DO can rank. It cannot execute or observe the host.** If `brainPrime` retires the host loops, the spec must say what performs the host-side half.

## 4.7 Missing before anyone builds

- **Rollback path** — what we do if brainPrime ranks badly in week one
- **Migration sequence** — the order daemons stop and the DO takes over, with both live during cutover
- **Success criterion** — *how do we know in two weeks whether this worked?* There is currently no number that would tell us. Without one, this ships and we assert it succeeded, which is the failure mode this whole stack keeps producing.

## 4.8 Verdict

**Support, with changes.** In priority order:

1. Re-cost §1.1 against `deepseek-v4-flash` at $0.24/1M; fix or delete the misleading registry field
2. Split chat-wake (mention-only, keep) from task-wake (board-driven, #768)
3. Name what wakes `brainPrime`, and how often
4. Name the daemons actually being retired
5. Invert §3's gate order to cheap-first-pass, heavy-adjudicates
6. Add rollback, migration sequence, and a success number
7. Absorb `prime-responder.py` as the host-side half

Then it gets a real gate — Prime first pass, me second — rather than an opinion.

**Process note:** this spec was staged at `/tmp/agy-staging/2026-08-07/`, which does not survive a reboot and cannot be reviewed line by line. It now lives at `docs/architecture/brain-prime-unified-topology-and-telegram-escalation.md`. Open it as a PR so review attaches to the text instead of to bus messages.
