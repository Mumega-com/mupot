# Console — Department-Template Microkernel

Status: **architecture / pre-build** · Author: Kasra · 2026-06-17
Related: [substrate-contract.md](./substrate-contract.md) · [port-interfaces-model-brain.md](./port-interfaces-model-brain.md) · [../coherence-model.md](../coherence-model.md) · ROADMAP v0.24 (breathing organism) + v0.25 (true microkernel)

This document is the spec the console re-skin and the department system build against. It
ties together four things that came out of design review: the **light enterprise console**
(a Claude Design handoff), the **candlestick "pulse"**, the **universal company functions**,
and the requirement that the whole thing be a **genuine microkernel**, not a modular monolith.

---

## 0. Context

The mupot console today is server-rendered HTML from Hono `shell()` (`src/dashboard/index.ts`),
dark-only, with a Stripe-style sidebar + pot switcher already present, and ~6 backed views
(observatory, economy, flights/fleet, approvals, agents, members). A Claude Design agent
(GH-read-only) produced **Mupot Console (Light)** — a light-primary enterprise re-skin:
editorial type (Instrument Serif / Hanken Grotesk / JetBrains Mono), deep-green accent
(`#0e7a55`) on warm-neutral whites, a **regime vital-sign** chip in the top bar, a
**candlestick "pulse"** chart, the **Gate** as swipe-cards, ranked board, fleet, agent
character sheet.

Division of labor (Hadi, 2026-06-17): **the design agent designs** (UI/UX coherence, GH-only);
**Kasra architects + wires real data.** Light is the **default**; dark is the toggle.

### Sterile-pot invariant (binding)
mupot is the **sterile, forkable pot**. It ships the **generic skeleton** — never a hardcoded
business. qNFT/FRC/molt and any tenant's specific business logic live in the **garden layer**,
not here. Departments are shipped as **generic templates**; the tenant activates and fills them.
See the garden/pot split in the mumega.com architecture notes.

---

## 1. Thesis

**The console is a department-template microkernel.** A tiny trusted core plus
capability-confined **department modules** that run in "user space," are **registered not
hardcoded**, and are **composed from the existing kernel ports** (they add no new kernel
primitives). The nav, the squads, the metrics, and the candlestick's metric options are all
**dynamic functions of which departments a pot has activated.**

Every company — any industry — has the same handful of functions. mupot ships them as dormant
**default department templates**; the owner activates the ones their business runs.

---

## 2. The universal company (default department templates)

Every business has these. mupot ships each as an activatable template. "Status" = how much
backing exists in mupot today.

| Department (template) | What every company does | mupot status | Metrics it emits → pulse |
|---|---|---|---|
| **Growth** (Sales & Marketing) | win customers, revenue-in | 🟡 seed (loops/prospects/outbound_acts) | leads, conversion, CAC, pipeline, ad-spend, revenue |
| **Operations / Delivery** | make & ship the work | 🟢 strong (tasks/squads/flights/board) | throughput, cycle time, quality, %done |
| **Finance** | money in/out, budget, runway, P&L | 🟡 partial (spend/billing/budgets; no revenue side) | spend, burn, revenue, margin, runway |
| **People / HR** | hire, org, roles, performance | 🟢 strong (agents/members/org/capabilities/char sheet) | headcount, utilization, performance, retention |
| **Customer Success / Support** | keep & serve customers post-sale | 🔴 net-new | tickets, response time, churn, CSAT, NRR |
| **Strategy / Leadership** | goals, OKRs, prioritization | 🟢 strong (brain ranks / OKRs / coherence) | goal progress, coherence regime |
| **Governance / Legal / Risk** | audit, policy, contracts, compliance | 🟢 strong (gates/audit/RBAC/sovereignty) | gate decisions, compliance, incidents |
| **IT / Infrastructure** | the stack, deploy, security, keys | 🟢 strong (deployment/keys/github/connectors) | deploys, uptime, infra cost |
| **Knowledge / Data** | institutional memory, docs | 🟡 partial (memory/engrams/content) | knowledge coverage, recall hits |

The pattern: mupot is strong on **delivery + control + people** (running the work), weak on the
**customer/money loop** (winning + keeping + counting revenue) — which is exactly the data the
candlestick wanted. The gaps to build, in order: **Growth → Finance (revenue side) → Customer Success.**

---

## 3. Microkernel design

### 3.1 The split (Liedtke's rule: a thing is in the kernel only if moving it out would break the system)

**Kernel (minimal trusted core):**
- Identity — entities/agents/members (the stable keys)
- Capability / RBAC — unforgeable scoped grants (`resolveCapabilities`/`hasCapability`, the AAGATE floor)
- Bus — message passing, gated wake-not-steer
- Audit — written at the boundary before any act
- **Department registry + lifecycle** — activate/deactivate, list-active
- **The `DepartmentModule` contract** — the seam a module must satisfy

The kernel knows **nothing** about "Growth" or "Finance." It only knows how to load a module
that conforms to the contract.

**Departments (user space):** each of §2 is a self-contained module that **registers** against
the contract. No department is privileged; Marketing is a module like any other. Even the work
pipeline can be expressed as one.

### 3.2 The contract (a new port, in the existing hexagonal-ports style)

```ts
interface DepartmentModule {
  key: string                       // 'growth' | 'finance' | …  (stable id)
  name: string                      // display
  defaultSquads: SquadSeed[]        // squads + agent-roles + default OKR/KPI to seed on activate
  metricsEmitted: MetricDescriptor[]// what it writes to the pulse (key, unit, ohlc-able?)
  consoleSection: ConsoleSectionRef // a render contract — NOT direct shell access
  requiredCapabilities: Capability[]// deny-by-default scope it runs under
  connectors: ConnectorRef[]        // GHL / Stripe / ads / helpdesk … (optional, gated)
}
```

**Critical microkernel property:** a department **composes the existing kernel ports**
(Database, Memory, Economy, Bus, Auth, the Metric/pulse port) and **adds zero new kernel
primitives.** Departments are orchestrations *on top of* the ports, not extensions of them.
The core stays minimal; departments are services built from kernel calls.

### 3.3 Registry + lifecycle (reuses the existing `departments` table)

- Activation does **not** require a schema migration. It writes a real `department` row +
  (optionally) seeds the template's squads/agents + flips a per-pot `active` flag + registers
  the module's console section and metric emitters.
- Deactivation hides the section and stops emitters; data is retained, dormant. **Isolated** —
  one department's removal cannot break the kernel or its siblings.
- Console nav = **active departments only**. The org shape *is* the activated set.

### 3.4 Capability confinement (deny-by-default — this is the AAGATE floor, #183)

Each module declares `requiredCapabilities`; the kernel enforces deny-by-default. Growth cannot
read Finance's tables, cannot mint tokens, cannot act un-gated. The capability-floor work
(PR #183, live) is the kernel guarantee that makes department isolation real, not cosmetic.
Marketing *actions* (sends, spend commits) flow through the **Gate** — agents propose, the human
authorizes — same governance story, same wake-not-steer rule.

### 3.5 The litmus test (how we "make sure it's microkernel")

> **Add a brand-new department — e.g. "Legal" — by writing ONE module that satisfies
> `DepartmentModule`, registering it, with ZERO edits to the kernel and ZERO edits to any other
> department.**

- **Yes** → it is a microkernel.
- **If adding a department requires touching core code** → it's a monolith with sections.

Removal counterpart: deactivating a department cannot break the kernel or its siblings.
**Every PR in this system is gated against this test.**

---

## 4. The pulse spine + candlestick

### 4.1 `metric_points` — the generic ingest (net-new, kernel-level)

```sql
CREATE TABLE metric_points (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  metric_key  TEXT NOT NULL,        -- 'growth.leads' | 'finance.revenue' | 'ops.throughput' …
  value       REAL NOT NULL,
  occurred_at TEXT NOT NULL,        -- ISO; intraday precision is what makes OHLC honest
  source      TEXT NOT NULL,        -- connector / brain / manual
  UNIQUE(tenant_id, metric_key, occurred_at, source)
);
-- index (tenant_id, metric_key, occurred_at)
```

Departments (and connectors) **emit timestamped readings** into this one table. It is the
single per-pot time-series spine.

### 4.2 OHLC aggregation — honest by construction

A candle needs **intraday range** (open/high/low/close as distinct values). Audited against
real mupot data:

| Series | Verdict |
|---|---|
| `cc_spend_daily`, `execution_meter` | ❌ **daily scalar** — one value/day → O=H=L=C → candle would be **fabricated**. Use a bar. |
| flight cost/day | ⚠️ real OHLC only at high volume; degenerate at 1–3 flights/day |
| task throughput | ⚠️ derivable, semantically weak |
| `loop_decisions.kpi`/day | ✅ **the one honest candle today** (intraday cycle readings) |
| leads / conversion / ad-spend / revenue | ❌ **zero backing** — net-new, arrive via Growth + connectors |

Rule: a `metric_key` is **OHLC-able only if it has multiple readings/day**. If a metric is a
daily scalar, the candle renders as a bar, not a fake candle. **Never fabricate O/H/L/C.**

### 4.3 The candle's metric selector = union of active departments' `metricsEmitted`

Activate Growth → `growth.leads`, `growth.conversion`, `growth.ad_spend` appear as candle
options. The chart's choices **follow the org.** Honest empty state ("connect a source") when a
metric has no readings — never invented numbers.

### 4.4 KPI cards — real today (no new data)

Scalar KPIs wire to existing D1 immediately: active agents/members/squads/tokens, verified work
(`tasks` done), open approvals (`tasks` review), spend (`cc_spend_daily` total/7d/today + turns),
burn $/hr (`execution_meter`), flights by status + cost, coherence C(t)+regime (brain physics KV),
active loops, prospect funnel counts. The regime chip, KPI row, approvals badge, fleet, economy
are real on day one.

---

## 5. Growth (Sales & Marketing) — the first department module

Built first because the seed exists and it feeds the candle. Reuses, doesn't rebuild:
- `loops` (engine) · `prospects` (funnel: queued→drafted→sent→replied) · `outbound_acts`
  (gated CRM side-effects) · the Gate (agent proposes a send, human authorizes).

Adds (lean, generic — not a full CRM): pipeline stages on top of `prospects`, a `campaigns`
concept, `channel_spend` (incl. ad-spend), and **every reading emits to `metric_points`** so the
candle + KPIs show leads/conversion/ad-spend per pot. Connectors (GHL, ad platforms, PostHog
pulses = the v0.24 afferent rail) feed it; connector secrets are **Hadi-gated**.

---

## 6. Build sequence

- **Phase 0 — this doc.** ✅
- **Phase 1 — Console spine re-skin.** Light-default theme tokens + 3 fonts + light/dark toggle
  + re-skinned Stripe sidebar + top-bar regime chip in `shell()`. Wire the **scalar KPIs to real
  data** (they exist today). Branch, diverse-gated, **no live flip without Hadi-go.**
- **Phase 2 — Microkernel core.** `DepartmentModule` contract + registry + activate/deactivate on
  the `departments` table + `metric_points` spine + OHLC aggregation. **Must pass the §3.5 litmus
  test.**
- **Phase 3 — Growth department** (first module) + candle wired to its metrics + honest empty states.
- **Phase 4 —** Finance revenue side · Customer Success · re-skin remaining strong departments.

---

## 7. Invariants (gated on every PR)

1. **Microkernel litmus (§3.5)** — new department = one module, zero kernel edits.
2. **Sterile pot** — no hardcoded business logic in the kernel; departments are generic templates.
3. **Capability confinement** — every module deny-by-default; actions gated (wake-not-steer).
4. **Data honesty** — receipts, not invented numbers; honest empty states; **no fabricated candles**
   on daily-scalar series.
5. **Diverse-gate** — contract + any identity/RBAC/external surface gets Opus **and** Codex
   (cross-vendor) adversarial review before merge.
6. **No arm deploys** — branch-only; merge + live-flip = Kasra-core gate + diverse second-eye + Hadi-go.

---

## 8. Open decisions (Hadi)

- **Light-primary live flip** — build behind toggle on a branch; flipping the canonical console
  default to light ships to every pot → Hadi-go.
- **Per-department connector auth** — secrets (Stripe, ad platforms, GHL) = Hadi's direct go, scoped.
- **Phase-1 build scope** — spine-only vs spine + re-skin all live views (TBD with Hadi).
