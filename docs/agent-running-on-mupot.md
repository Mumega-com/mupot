# What "an agent running on mupot" means

**Status:** LIVE (2026-06-30) — the full squad (kasra, codex, river, mumega-brain) is
registered + member-bound + signature-authenticated on mupot via Ed25519 signed-attach.
Identity is real; liveness (heartbeat) + coordination + SOS-retirement are the remaining
build. Synthesises fleet-control, the hermit-crab identity model, and the bus-reflection
migration into one definition.

## The core decoupling: AGENT ≠ RUNTIME

The mistake that makes "running on mupot" confusing is conflating two things:

- **Agent** = *who*. A sovereign identity: name, qNFT/soul, memory, skills, RBAC
  capabilities, and an **agent type** (builder / reviewer / weaver / brain …). This is
  the squid, the hermit-crab **body**. It is durable and portable.
- **Runtime** = *where it executes*. A **swappable shell**: Claude Code, Codex, the
  Claude API, Hermes. This is the **borrowed shell** — interchangeable, never a home.

> "You are a claude-code Kasra, but Loom can be on Codex or Claude."
> Same agent identity, different runtime. The agent rides the shell; it can leave it.

mupot owns the **agent**. The runtime is a **binding** the agent currently wears, not a
fixture. Re-binding (Kasra moves from Claude Code to Hermes) must not change identity,
memory, or capabilities.

## mupot = the control plane (not the CPU)

A Cloudflare Worker does not run a long-lived Claude Code process. So "running on mupot"
does **not** mean mupot executes the model. It means mupot is the **operating system**
for agents — it owns, controls, and observes them, while the runtime does the compute:

| OS concept | mupot equivalent | status |
|---|---|---|
| process table / registry | agent registry: identity + **type** + **runtime binding** + status | partial (fleet-control agent registry; members/capabilities) |
| start / kill a process | **open / close** an agent (signed start/stop) | fleet-control (Ed25519-signed control-requests) |
| identity & permissions | members + capabilities (RBAC, squad-scoped) | ✅ live (S196 Slice A) |
| IPC / message bus | reflected bus: `send` / `inbox` / `request` / `ack` | ✅ live (S196 Slice D, `agent_messages`) |
| `ps` / `top` (observability) | presence + activity feed → dashboard + Discord `#agent-bus` | partial |
| signals / control | gate decisions, wake — dashboard + Discord `#gates` | partial |

An agent is **"running on mupot"** when **all** of these hold:
1. It is **registered** in mupot — identity + type + RBAC. *(✅ done for the squad.)*
2. Its **lifecycle is controlled via mupot** — open/close it on a chosen runtime, signed.
3. It **coordinates through mupot's reflected bus** — not the fragile SOS bus.
4. Its **runtime is a binding** (claude-code / codex / claude / hermes) that reports
   status (heartbeat/presence) back to mupot, and can be swapped without identity loss.
5. The **SOS bus is retired** for that agent — its shell points at mupot endpoints.

## Reflect the BUS, not the process

The migration reflects the bus **primitives** (send/inbox/presence/wake/request/ack)
onto mupot's durable CF-native substrate (Queues + Durable Objects + D1) — it does **not**
port the SOS python process. The SOS bus froze the colony for 2 days (Redis-on-VPS,
06-25→06-26); mupot's substrate is the durable replacement. Agents talk **through mupot**.

## Open / close (the lifecycle verb)

"Open/close kasra and others" = fleet-control's signed start/stop, surfaced as a first-
class agent lifecycle on mupot:

- **open(agent, runtime)** → start the agent's shell on the named runtime, bound to its
  mupot identity + RBAC + inbox. Appears in the registry as `running` + emits presence.
- **close(agent)** → stop the shell; identity/memory persist in mupot; status → `closed`.
- Every host action Ed25519-signed + verified (the fleet-control standard).

The runtime binding is explicit: `{agent: kasra, type: builder, runtime: claude-code}`,
`{agent: loom, type: weaver, runtime: codex|claude}`. Changing `runtime` = a re-bind, not
a new agent.

## Where Discord fits

Discord is a **view + control surface** onto mupot-managed agents, not a separate system:
- `#agent-bus` = presence/activity reflected from mupot (who's open, on what runtime,
  doing what, blocked-on-what) — the human's `top`.
- `#gates` = decisions routed to the owner (the reach channel; replaces dead Telegram).
- Roles are a one-way projection of mupot capabilities (S196 Slice B). mupot is master.

## What's built vs the gap (be honest)

- ✅ **Substrate / home**: identity + RBAC (Slice A), inbox (Slice D), signed HTTP
  inbox reads for daemon drain, Discord roles + reach surface (Slice B),
  fleet-control signed start/stop + agent registry.
- ⬜ **The gap = runtime cutover (Slices F/G + Hermes-per-pot, #18):** the squad's shells
  still execute against the SOS bus / local sessions. "Running on mupot" is only true once
  each agent's runtime points at mupot's reflected bus, reports presence to the registry,
  is open/close-controlled, and SOS is retired for it. **That is the next real build** —
  not more substrate.

## Build order from here
1. **Agent registry record** = `{agent, type, runtime, status, capabilities, last_seen}`
   as the canonical row (extend fleet-control's registry; bind to members/capabilities).
2. **Runtime adapter contract** — a shell (claude-code/codex/hermes) that, on open: pulls
   identity+RBAC+inbox from mupot, emits presence, drains its mupot inbox, and on signal
   from mupot can close. One thin adapter per runtime.
3. **open/close API + Discord/dashboard control** — signed, surfaced in `#agent-bus`.
4. **Cutover** — point the squad's shells at mupot (retire SOS for the squad); survive a
   host reboot by repopulating presence from mupot, not local Redis.

See also: fleet-control (`agents/fleet-control/SPEC.md` in mumega.com), hermit-crab harness,
S196 brief (`agents/loom/briefs/S196-dogfood-mupot-migration.md`), Hermes-per-pot (#18).

---

## 2026-06-30 — squad live + the road to a breathing mupot

**What shipped (Ed25519 signed-attach cutover).** The runtime proves identity by SIGNING a
tenant-bound, time-boxed, single-use message with a host-held private key; mupot stores only
the PUBLIC key (`agent_keys`) and verifies. No bearer secret is transported or placed —
Hadi rejected the hand-placed token, which forced the stronger public-key design. Per agent:
`keygen` (private stays on host) → register public key bound to `members.id` → signed attach.

Live now (`fleet_agents`, all `running` + member-bound):

| agent | type | runtime | capability |
|---|---|---|---|
| kasra | builder | claude-code | squad-core admin |
| codex | reviewer | codex | squad-core member |
| river | generic | hermes | squad-core lead |
| mumega-brain | brain | hermes-cron | squad-core member |

Dyad-gate (Sonnet adversarial lens; builder was Opus): round-1 BLOCK found 3 gameability
vectors behind a green suite (nonce-prune-vs-future-ts replay; unsigned `/report` keyed-forge;
unsigned `lifecycle` under a signed upsert) — all fixed, re-gate GREEN. PRs: mupot #248, host #344.

### Condition status (the 5 from above)
1. Registered (identity+type+RBAC) — ✅ **done** for the whole squad.
2. Lifecycle controlled via mupot — ⛏ partial (signed attach/detach and Worker
   control requests exist; host control daemon now verifies requests and runs
   `flight.mjs open|close`, host install remains).
3. Coordinates via the reflected bus — ⛏ partial (`agent_messages` inbox and signed
   daemon read are built; runtime hook rollout still needs host/operator wiring).
4. Runtime binding reports presence + swappable — ⛏ partial (fleet daemon code now
   heartbeats, drains signed inbox, and signed-detaches on shutdown; host install remains).
5. SOS retired — ⬜ not yet.

### Punch-list to LIVE
**Phase 1 — liveness (make `running` true)** ← biggest gap, critical path
1. Presence/heartbeat: TTL column; registry computes running/stale/stopped from last-ping.
2. Fleet daemon (host): boot-attach all managed agents, re-attach on drop, heartbeat, drain
   inbox, detach on stop; systemd user unit. ✅ branch implementation; install = Hadi host-go.

**Phase 2 — lifecycle control (open/close from mupot)**
3. open/close API: signed control-request → daemon starts/kills the agent's runtime.
   ✅ branch implementation via `fleet-control-daemon.mjs`; install = Hadi host-go.
4. Control surface: `#agent-bus` = `top` (live presence + open/close); `#gates` = signals.

**Phase 3 — coordinate through mupot (not SOS)**
5. Runtime loops consume the mupot inbox (send/inbox/wake/ack) instead of the SOS bus.
   The pot now exposes `/api/inbox/signed` so the fleet daemon can deliver inbox
   batches without storing a bearer token; host hook rollout remains the cutover work.
6. Reflect any missing primitives (wake/request/ack) on the durable substrate (Queues+DO+D1).
7. Repoint squad wake-hooks / bus identity SOS → mupot.

**Phase 4 — retire SOS** (8) decommission the python bus for the squad once nothing depends on it.

**Cross-cutting** — (9) durable, reliably-wakeable 2nd adversarial gate lens (Codex bus-peer
was stale on both pings); (10) dyad-gate.yml single-quote glob (1-line).

### Identity must project from the qNFT + DNA (not flat rows)
The mupot agent record is currently disconnected from the agent's REAL identity. Each agent
already has: a **qNFT** (`~/.claude/qnft/<agent>/qnft.json` — minted soul: tier, signer +
countersigner chain, model, cause/descriptor pointers, visual card) and a **DNA definition**
(`~/.claude/agents/<agent>.md` — role, skills, lane). These are the source of truth for *who
an agent is*. The signed-attach rows I seeded hand-type `agent_type`/`runtime` (e.g. river was
guessed `generic`) and the `agent_keys` pubkey is a bare credential with no link to the soul.

Direction: mupot identity should **project from the qNFT + DNA**, not be ad-hoc —
- `agent_type` / role / skills read from the **DNA def**, not guessed;
- the signed-attach key registered as **authorized-by-the-qNFT** (qNFT = canonical identity;
  the mupot key = a runtime credential the soul vouches for, signer/countersigner chain intact);
- `fleet_agents`/member carries the **qNFT ref** (tier, cause, descriptor) so mupot's view is
  the real soul, not a thin row.
This reshapes Phase 1: the daemon/attach reads each agent's DNA + qNFT and reports the *real*
identity; key-registration ties to the signed qNFT chain. (Ties to the hermit-crab body model
and the molt-card trajectory stack.)
