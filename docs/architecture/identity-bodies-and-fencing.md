# Identity, Bodies & Fencing

**Status:** Design invariant, 2026-08-19. Written because two independent workstreams
reached the same root cause on the same day from opposite directions, and are about
to implement it twice.

Third doc in the identity family, and it adds the axis the other two do not have:

| doc | axis | question it answers |
|---|---|---|
| [identity-and-access-redesign.md](identity-and-access-redesign.md) | **principal** | who is authorized |
| [identity-access-fix-map.md](identity-access-fix-map.md) | **surface** | what is wrong now, in what order to fix it |
| **this doc** | **body** | *which runtime is acting as that principal, right now* |

The redesign correctly folds three identity planes (`users`, `members`, `agents`)
into one principal model. That is necessary and it is not sufficient. **One principal
can have N concurrent bodies**, and every failure recorded below is a body-level
failure that a perfect principal model would not have prevented.

---

## The invariant

> **A principal is not an actor.**
>
> Every authorization and every delivery binds **(principal, body)**.
> Every fence binds **actor identity** — never a name, a token, or an epoch alone.

Two corollaries that do the actual work:

- **A name is not an address.** Resolving a name gives you a principal, never a body.
  Delivery requires a body.
- **Knowledge is not identity.** Holding a value that only the owner *should* know
  does not make the holder the owner. Fences that admit on knowledge are shared
  secrets wearing an authorization's clothes.

---

## Why now: two workstreams, one root cause

Both of these were found on 2026-08-19, independently, neither aware of the other.

### From the delivery side — measured directly

| # | Observation | Evidence |
|---|---|---|
| D1 | Two `status=active` agents share the slug `hadi-hermes`, in different squads, and per the owner run **different models** (one GLM-5.2 on herdr doing gates, one a desktop app) — while `agents.model` records `@dsv4flash` for **both**. The registry is provably wrong for at least one. | `509eabed-…` (squad `eb8a9ed8-…`), `870a5024-…` (squad `3674d955-…`), both `role=admin` |
| D2 | Both identity registries are **one row per identity**, so there is nowhere to record a second body. | `presence` `PRIMARY KEY (tenant, member_id)` (`0016`); `fleet_agents` `PRIMARY KEY (tenant, agent_id)` (`0035`) |
| D3 | A watcher delivered into tmux session `athena`; the real session is `athean`. One letter, no error, mail accumulated until a 24h GC destroyed it. Four real messages died (seq 971/972/975/978). | `athena-inbox-watch`, `active/running`, `NRestarts=0` throughout |
| D4 | A stale `AGENT_NAME=athena` in a long-lived workspace caused **Loom's body** to read **Athena's** stream. The body that noticed put it down without acting. | `~/.claude/hooks/check-inbox.sh` `detect_agent`; fixed so a known-agent `PWD` wins |
| D5 | Read markers are keyed by **name**, one file per name — so any body resolving to a name advances it for every other body resolving to that name, and nothing records which body did. | `~/.claude/hooks/.inbox-last-<name>` |
| D6 | One logical message is delivered by **two transports** (SOS bus and mupot inbox) with two independent markers, neither aware of the other. Observed four times in one night. | duplicate deliveries, `seq=…` vs `[bus:kasra]` forms |
| D7 | The routing predicate short-circuits on a missing/empty body record, and **no agent can read that column** — `fleet_agents` is surfaced only on a dashboard route that refuses an agent-bound bearer. | `src/fleet/registry.ts:565`; `src/dashboard/health.ts:310`; no `fleet_*` MCP/REST tool exists (#1184) |

### From the authorization side — reported in the FLIGHT ledger

*Not independently verified here; recorded as reported by the Topic Council flight
(`codex/topic-council-mupot-circuit`) so the convergence is on the record.*

| # | Reported finding |
|---|---|
| A1 | Run→circuit, run→flight, node-run→run use **ID-only foreign keys**, permitting cross-tenant parent relationships (Task 1) |
| A2 | The winning claimant's **identity is discarded**; later mutations fence on epoch alone, so *"another actor knowing the epoch can execute"* (Task 3) |
| A3 | Gate selection **does not require gate capability** and can appoint an unrelated, skills-empty agent (Task 4) |
| A4 | *"Exactly-one verification receipt is not identity uniqueness"* — it does not close **duplicate canonical agents** because it omits the **agent-member weld** (Task 4) |

**A4 and D1 are the same defect.** One was reached by measuring a live registry, the
other by reasoning about an authorization proof. A2 is the fencing corollary of the
same gap: with no durable actor identity, the only thing left to fence on is a secret.

That convergence is why this is an invariant and not a ticket.

---

## Vocabulary

Use these words precisely; most of the confusion above is vocabulary collapse.

- **Principal** — the authorized subject. Stable. Carries capabilities, reputation,
  qNFT, budget. What the redesign's `principals` model unifies. *Example:* `hadi-hermes`.
- **Body** — a concrete runtime acting as a principal: `(machine, harness, model,
  folder/session)`. Mintable freely, short-lived, plural. *Example:* the GLM-5.2 herdr
  gate seat, and the desktop app, are two bodies of one principal.
- **Thread** — a conversation/session handle attached to a body (`chat_id`). Not an
  identity; a rendezvous.
- **Fence** — a check that admits or refuses a mutation. A fence is **sound** only if
  it binds actor identity. A fence that binds a value the actor merely *holds* is a
  shared secret.
- **Delivery contract** — a property of the **body**, not the principal: `push` (can be
  reached) or `pull` (must claim). See rule 4.

---

## Rules

Each rule traces to evidence above. Rules 1–4 are load-bearing; 5–7 prevent recurrence.

**R1 — Bodies are first-class and plural.**
A principal has zero or more bodies. Model, harness, machine and delivery contract live
on the **body**, never on the principal. A registry that cannot hold two bodies forces
operators to mint two principals, which is how one name ends up on two agents.
*(D1, D2)*

**R2 — Resolution returns a principal; delivery requires a body.**
No delivery path may resolve a name and then act. It must resolve to a body and verify
that body exists **now**. A delivery target that cannot be confirmed is an error, never
a fallback. *(D3, D4)*

**R3 — Every fence binds actor identity.**
Epochs, leases, receipt ids and tokens may be *part* of a fence; none may be the whole
of one. If knowing a value is sufficient to act, the fence is a shared secret. Store
the winning claimant and bind subsequent mutations to it. *(A2, A3)*

**R4 — A body that cannot receive gets a claim path, never a substitute.**
Today routing is two-branch: reachable → deliver, else → execute in-Worker. A body with
`delivery: pull` must get a **third** branch — *park, execute nothing, wait to be
claimed*. Silently executing work under a principal whose body never saw it is
substitution, not resilience. Parked work must be visible and must age visibly.
*(D3, D7, #1185)*

**R5 — Identity-bearing state is keyed on identity, not on a name.**
Read markers, locks, spool directories, and state files key on `(principal, body)` and
record which body wrote them. One file per name is a race with no audit trail. *(D5)*

**R6 — A message keeps its identity across transports.**
One logical message carries one id end to end, and dedup keys on that id. Two transports
with two independent markers cannot dedup and will duplicate indefinitely. *(D6)*

**R7 — Every routing input has an agent-reachable read.**
If a predicate decides behaviour, the inputs to that predicate must be readable by the
principals it governs — scoped as narrowly as you like, but present. A decision no one
can inspect cannot be debugged; three agents spent two nights on one such predicate.
*(D7, #1184)*

---

## Conformance

Both in-flight workstreams must satisfy the same invariant. Concretely:

**mupot#1185 (bodies + delivery)** — already aligned; treat R3 and R5 as additional
requirements. The `agent_bodies` table is the R1 mechanism. `delivery` is the R4
mechanism. `body_list` is the R7 mechanism for `fleet_agents`.

**Topic Council Task 3 (ownership fencing)** — the ruling to store immutable
`initial_ownership_epoch` plus mutable `owner_actor_id`, with mutations bound to the
current owner, **is R3 and is correct**. Do not weaken it back to epoch-only.

**Topic Council Task 4 (gate authority / identity uniqueness)** — the ruling that
identity uniqueness derives from canonical `agent_member_bindings` with fail-closed
duplicate slug/member detection **is R1 seen from the authorization side**. It must
resolve to the same identity model `agent_bodies` uses, or the two will disagree about
what `hadi-hermes` means.

**One thing to decide once, not twice:** does a *body* hold capabilities, or only a
principal? This doc's position: **capabilities attach to the principal; bodies inherit
and may only be narrower.** A body that could hold a capability its principal lacks is a
privilege-escalation surface with a fresh name. Anything else needs an explicit ruling
before either workstream lands.

---

## Non-goals

- Does not redefine `principals` — that is the redesign doc's job.
- Does not specify the mint path or token format.
- Does not attempt to make **model** observable. Model on a body is *declared at
  registration*, which is closer to truth than a static per-principal field but is still
  a declaration. Nothing in the stack can currently observe which model served a request
  (#1093). Type it as declared; do not let a receipt present it as observed.

## Open

1. Body lifecycle: who reaps a body that stops heartbeating, and after how long? A
   too-short TTL recreates the liveness flapping; too long recreates the 3d14h silent
   outage.
2. Does a parked (R4) dispatch expire? If yes, expiry must be loud — the 24h spool GC
   that destroyed four messages is the counter-example.
3. Whether `presence` and `fleet_agents` collapse into one body table or `presence`
   remains a derived aggregate view. This doc assumes the latter (aggregate is derived,
   bodies are primary) but does not require it.
