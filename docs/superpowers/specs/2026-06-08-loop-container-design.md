# Loop Container — a resource-bound, MCP-native, governed loop runtime

**Status:** design / for review
**Date:** 2026-06-08
**Author:** Kasra (architect)
**Repo:** Mumega-com/mupot

---

## 1. What this is (and is not)

We build the **container**, not the content. The container is a runtime that runs *any*
goal-seeking agent loop and enforces what that loop is allowed to consume. A specific
loop (outreach, support, research) is a **declarative config** that plugs into the
container — it is not code we hardcode into the runtime.

> A **Loop** is a declarative resource that binds RESOURCES (sources, channels, a human
> gate, a money budget, compute, a cadence) to a GOAL. The container runs the loop's
> cycle and **enforces the resource accounting** — meter compute, cap dollars, gate
> risky acts, stop on dry-round/budget/kill — *regardless of what the loop does*.

The first config we ship to prove the container is **Digid grant-funding outreach**, but
the outreach specifics live entirely in *config + adapters*, never in the runtime.

### Non-goals (YAGNI — explicitly out)
- **We do NOT build the reasoning loop.** ReAct / plan-execute is commoditized (LangGraph
  ~34.5M monthly downloads, MIT). The reasoning step is thin and swappable. Our value is
  the container + resource accounting, not the cleverness of the planner.
- **We do NOT build custom Source/Channel adapters as the primary seam.** The seam is MCP
  (see §4). Custom adapters are a fallback for non-MCP async channels only.
- **We do NOT build the full per-prospect durable Workflow in v1.** The simple in-loop
  path proves the motion first; graduating to Workflows-per-unit is a later phase (§7).

---

## 2. Why now — problem + market

**Problem (internal).** mupot's loop already turns (`runGoalCycle` + metabolism heartbeat,
v0.3.0/v0.7.0) but it is hollow: it spawns generic task *strings*, measures a vanity KPI
(done-count), and never touches the real gears (the prospect queue, the gate, GHL send,
the reply stream). The brain thinks; the gears are built but unwired.

**Market direction (researched 2026-06-08, sources in §11).** Every structural force
points at this container:
- **Durable execution is consensus substrate.** Cloudflare Workflows V2 GA + Dynamic
  Workflows (May 2026) give per-tenant/per-agent durable plans and `waitForEvent`
  (a human gate at zero idle cost). Temporal/Inngest/AWS/Vercel all shipped the same.
- **MCP won.** ~97M monthly SDK downloads; donated to a neutral foundation (Anthropic +
  OpenAI + Block, Dec 2025); ~17k public servers. It is infrastructure, not a feature.
- **Governed autonomy is the documented GAP and the differentiator.** Only ~44% of orgs
  have any agent financial guardrail (Gartner). Observability tools *alert*; none
  *enforce* at the execution layer (a real $47k runaway-loop bill is cited). "Loop limits
  + tool-call caps" is named the new unit economics of agentic SaaS.
- **Hyperscalers are descending toward this layer** (Google Gemini Enterprise Agent
  Platform, AWS Bedrock AgentCore). The window is ~2 quarters. The one moat they cannot
  copy: **sovereign / CF-native / self-host — the tenant owns the data and runs on their
  own account.** That is the frame, not a feature.

**Strategic consequence.** Build the governance primitives (enforcement-layer budget cap,
declarative gate, audit) *first and correctly* — that is what enterprise buyers actually
purchase, and nobody has it at the substrate layer yet.

---

## 3. The Loop manifest (the declarative resource)

A loop is one declarative record. Illustrative shape (final field names settled in the
plan):

```
Loop {
  id, tenant, squad_id/agent_id          // who runs it (fractal: agent ⊂ squad ⊂ pot)
  goal:    { okr, kpi: KpiSpec }          // KpiSpec = how the OUTCOME is measured (§5)
  sources: [ ResourceRef ]                // what it perceives  (MCP-native, §4)
  channels:[ ResourceRef ]                // how it acts        (MCP-native, §4)
  gate:    { require_approval, timeout, on_timeout: 'pause'|'reject' }   // §6
  budget:  { cap_micro_usd, effort }      // the hard ceiling (§6), + effort dial
  cadence: { heartbeat?, on_event?, alarm? }  // three paces (§5)
  stop:    { dry_rounds_max, on_kpi_met, kill }
  status:  active | paused | done | killed
}
```

`ResourceRef` is `{ kind: 'mcp', url, auth_ref, tool_filter? }` first-class; a small set
of built-in kinds (`'queue'`, `'memory'`) for things that are already in-pot and not worth
an MCP hop. Everything external is MCP.

A config (e.g. outreach) is just a manifest instance — no new runtime code.

---

## 4. Resource model — the six resources

The container's whole job is to run the cycle **and account for these six**. Sources and
channels collapse onto **one MCP-shaped seam**.

| Resource | What it is | Seam / status in mupot |
|----------|-----------|------------------------|
| **Cognition** | model calls | metered in micro-USD (`cost.ts`, #15) ✅ |
| **Money** | hard $ ceiling | **enforcement-layer cap (#4) — build first, §6** |
| **Sources** (in) | queue · memory · Drive · reply-stream · web · DB | **MCP-native** `ResourceRef`; built-ins: queue, memory |
| **Channels** (out)| GHL · email · Discord · Telegram · CRM | **MCP-native**; existing `src/channels/adapters` = built-in fallback for async |
| **Human gate** | approval capacity | verdict endpoint + `/approvals` ✅; made declarative (§6) |
| **Time** | tick · event · alarm | metabolism cron ✅; event-resume + DO alarm = small add |

**Design rule:** a loop's reach over sources and channels is exactly its bound
`ResourceRef`s. The container resolves an MCP `ResourceRef` to its tool list at run time;
the loop can call nothing it did not bind. This is the capability boundary *and* the
plug-in model (any of the ~17k MCP servers becomes a source/channel with zero adapter
code — including our own `mcp.mumega.com`, a pot's own MCP seam, ChatGPT's connector, and
Google Drive).

---

## 5. The runtime — how a loop RUNS

Generalize `runGoalCycle` into the canonical cycle (perceive → reason → act → observe),
source/channel-agnostic. The reasoning step is a thin, swappable seam (§1 non-goal).

- **perceive** — read bound **sources** (resolve each `ResourceRef`; for MCP, call its
  read/search tools). Produce the loop's working context.
- **reason** — the model proposes next action(s), bounded by `effort` (task budget) and by
  the live budget check (§6). Swappable; not our differentiator.
- **act** — emit proposed action(s) to bound **channels**, *through the gate* where policy
  requires (§6). An act that targets a write channel and is gated becomes a `pending`
  record, never a direct send.
- **observe** — read outcomes back from sources (e.g. a reply stream) and recompute the
  **outcome KPI** via the loop's `KpiSpec` — NOT a task count. `KpiSpec` names the signal
  (`positive_replies`, `meetings`, `prs_merged`, …) and the source that supplies it. The
  done-count default stays only as the explicit fallback when no `KpiSpec` is given.
- **pace** — three paces, declared per loop, not one flat cron:
  - **heartbeat** — the metabolism tick (have it) for periodic scans/discovery.
  - **on_event** — an inbound event (a reply webhook) *resumes* the loop immediately.
  - **alarm** — a DO alarm for per-unit timers (follow-up after N days).
- **stop** — the container halts the loop on any of: `dry_rounds_max` consecutive empty
  ticks (→ pause + notify), budget exhausted, `kpi >= 100`, or explicit kill.

---

## 6. Governance — the differentiator (build first, build right)

Three primitives. These are the market gap; they must be substrate-enforced, declarative,
and audited.

### 6.1 Enforcement-layer budget cap (#4) — PHASE 0
The cap must **terminate the loop before the next model call initiates** — not alert after
the spend. Concretely: the meter already records micro-USD per agent (#15). Add a
**pre-call gate**: `reserveOrBlock(env, agentId, estimatedCostMicroUsd)` consulted *before*
any model/tool spend in the cycle; if `spent + estimate > cap_micro_usd` → block, the
cycle records `decided:'budget_exhausted'`, the loop pauses, zero further spend. Soft
alerts (e.g. 80%) are secondary. This is a **canonical sensitive surface** (eligibility/
veto) → parallel adversarial review before merge; the meter contract already forbids
adding enforcement without its own adversarial pass.

### 6.2 Declarative human gate (`waitForEvent`)
The gate is a named field in the manifest: `gate: { require_approval, timeout, on_timeout }`.
The container enforces it. v1 reuses the existing verdict endpoint + `/approvals` (an act
becomes `pending`, fires only post-approved-verdict via the existing `runApprovedActs`,
which independently re-reads `task_verdicts`). The graduation (§7) maps this field directly
onto a Dynamic-Workflow `step.waitForEvent('approval', { timeout })` — zero idle cost.
**on_timeout defaults to `pause`, never auto-approve** (an agent must not win approval by
outwaiting a distracted human).

### 6.3 Audit
Every act, gate verdict, budget block, and stop emits an attributed, append-only record
(the bus + `task_verdicts` patterns already exist). The audit chain is a sensitive surface
(integrity) → adversarial-reviewed.

---

## 7. Durable-execution substrate (the graduation path)

v1 runs the cycle in-loop (metabolism tick → `runGoalCycle` → gated task + act → existing
GHL send + inbound webhook). This proves the motion with the least new surface.

Graduation (own later spec, NOT v1): each unit's act-and-track runs as a **Dynamic
Workflow** instance — `step.do` for each side-effect (durable, replayable, idempotent),
`step.waitForEvent('approval', { timeout })` as the gate, inbound reply `sendEvent`
resumes it, a `step` alarm schedules follow-up. D1 stays authoritative over the droppable
resume event (a `sendEvent` to a non-parked instance is silently dropped — established in
#7). This is exactly the surface CF Dynamic Workflows is engineered for.

---

## 8. Components (isolated, testable units)

1. **`loops` table + manifest type** (migration) — the declarative resource (§3). Storage
   + Zod validation at the boundary.
2. **`ResourceRef` resolver** (`src/loops/resources.ts`) — resolve a ref to a live handle:
   MCP (`{kind:'mcp',url,auth_ref}`) → an MCP client over the bound server's tool list;
   built-ins `queue`/`memory` → in-pot handles. Pure interface: `read(query)→items`,
   `act(tool,args)→result`. One place that knows MCP; the runtime stays seam-only.
3. **Runtime** (`src/loops/runtime.ts`) — the perceive/reason/act/observe/stop cycle (§5),
   source/channel-agnostic. Replaces the hardcoded body of `runGoalCycle` with a
   manifest-driven one; reasoning injected.
4. **Budget enforcer** (`src/agents/meter.ts` extension, #4) — `reserveOrBlock` pre-call
   gate (§6.1). Phase 0.
5. **Gate binding** — declarative `gate` field → existing verdict/approvals path (§6.2).
6. **KPI signal** (`src/loops/kpi.ts`) — `KpiSpec` → outcome number from a named source;
   done-count fallback retained explicitly.
7. **Cadence wiring** — metabolism (have it) + event-resume entry + DO-alarm follow-up.
8. **Outreach config + 2 things** — the manifest instance + a `prospects` source (queue,
   built-in) + GHL channel (MCP or existing adapter). The Digid/CASL/offer specifics live
   here, not in the runtime: CASL consent basis forces the gate on; opt-out always
   suppresses; rate-limit per day. (This is the proving config, §9.)
9. **Digid pot promotion** — enable cron + metabolism on the Digid pot (now inbound-only)
   so the heartbeat ticks; seed an outreach squad via squad-pack (#11 pattern).

---

## 9. Data flow (outreach as the proving config)

```
metabolism heartbeat → runtime(loop=outreach-manifest)
  perceive : pull next prospect from `prospects` source (+ memory context)
  reason   : draft message for THAT prospect (model, effort-bounded, budget-checked)
  act      : create gated task + pending outbound_act on the GHL channel
           → /approvals  (batch HITL; CASL: unknown-consent/CA contact MUST gate)
  (human approves) → verdict endpoint → runApprovedActs → GHL send  [existing #8]
  on_event : GHL inbound webhook (reply) → resume → categorize (positive|neutral|optout|bounce)
  observe  : update prospect status + KPI = positive_replies ÷ target  (outcome, not count)
  alarm    : sent-no-reply > N days → follow-up (depth ≤ 3)
  stop     : no prospects (dry-round → pause+notify) | budget cap hit | kpi met | kill
```

---

## 10. Error handling, testing, adversarial gates

**Failure modes (fail safe):** failed draft → prospect stays `queued`; failed send → act
stays `pending` (claim-before-send guard from #8 prevents double-send); opt-out always
wins and is immediate; a budget block pauses with zero spend; a dropped resume event is
recovered by D1 re-read.

**Testing:** every unit pure with injected seams (model, createTask, createAct, MCP client,
clock, writeProgress). Unit-test: ResourceRef resolver (MCP + built-ins), runtime cycle
decisions, budget enforcer (the pre-call block boundary), KPI signal, CASL gate decision,
dry-round counter, follow-up selector, reply categorizer.

**Adversarial gates (sensitive surfaces — run in PARALLEL before each merge):**
- budget cap bypass / off-by-one at the boundary (eligibility-veto surface)
- auto-send without an approved verdict (external surface)
- cross-tenant source read via a bound `ResourceRef` (memory/identity surface)
- opt-out race; CASL consent bypass
- audit chain gaps (integrity surface)
- double-send on retry (already covered by #8 claim-before-send; regression-guard)

---

## 11. Phasing

- **P0 — Enforcement budget cap (#4).** Pre-call hard kill. Own adversarial pass. Ships
  independently; the governance primitive that is independently valuable.
- **P1 — Loop manifest + storage + ResourceRef resolver (MCP-native seam).**
- **P2 — Manifest-driven runtime** (generalize `runGoalCycle`; reasoning injected).
- **P3 — Declarative gate binding + outcome KPI signal + cadence (event-resume, alarm).**
- **P4 — Outreach config + prospects source + GHL channel + CASL/opt-out/rate guards.**
- **P5 — Promote Digid pot + seed outreach squad → first live (gated) send.**
- **Later (own spec) — graduate act-and-track to Dynamic Workflows** (§7).

Each phase: shipped + tested + deployed + adversarial-gated (where sensitive) + CHANGELOG
+ close its issue. No invisible work.

---

## 12. Strategic notes (not build scope)
- **Pricing direction** (market): per-seat is dying; substrate prices on **loops executed +
  budget-capacity governed**, not seats. Lock the unit before first enterprise contracts.
- **Moat framing:** sovereign / CF-native / self-host. Make it the frame.
- **Connector/Drive/pot-sync** all fold into the **MCP `ResourceRef` seam** — they become
  "bind another MCP source/channel," not separate projects.

---

## 13. Open decisions (for review)
1. **MCP client in-Worker:** which minimal MCP client do we run inside a CF Worker for the
   `ResourceRef` resolver (size budget < 1MB)? (research spike in P1)
2. **Built-in vs MCP for the prospect queue:** start as an in-pot built-in source (faster)
   and expose it over MCP later — agreed? (assumed yes in §8)
3. **P0 independence:** ship the budget cap as its own PR/release before P1, or fold into
   the container branch? (assumed: own PR, merges first)

---

## 14. Sources (market scan 2026-06-08)
Cloudflare Dynamic Workflows (blog.cloudflare.com/dynamic-workflows) · Workflows V2 GA
(infoq.com/news/2026/05/cloudflare-workflows-v2-release) · Anthropic — donating MCP to the
Agentic AI Foundation (anthropic.com/news) · MCP adoption 2026 (digitalapplied.com) · FinOps
for agents / loop limits (infoworld.com) · The $47k agent loop (dev.to/waxell) · Agentic AI
cost governance (finout.io) · Vertex AI enhanced tool governance (cloud.google.com/blog) ·
Bedrock AgentCore (docs.aws.amazon.com) · Assistants API sunset Aug 2026
(community.openai.com) · SaaS/agentic pricing 2026 (getmonetizely.com) · Bessemer AI pricing
playbook (bvp.com). Agentic-loop patterns scan (OODA/planner-executor/HITL/self-pacing)
on file.
