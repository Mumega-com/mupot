# Digid Hybrid + Agent Orient — Design

**Goal:** Make digid a sovereign **hybrid organism** — a forked SOS *mind* on the isolated `digid`
Linux user wired to the live mupot-digid *body* — and build the **orient** seam that drops any
agent (any harness) into its basin: who it is, exact scope, chain of command, tools, and its live
field state (coherence/trust/spin). The orient packet is the anti-hallucination grounding that
stops agents assuming, starting from scratch, or ignoring available tools.

**Architecture:** Body↔Mind. mupot = CF-aligned **body** (org/RBAC/tasks/flights/presence/gated
acts). A per-tenant **fork of SOS** = the **mind** (coherence field, spin, trust, utility
gradient). They share one CF substrate (the mind uses the pot's D1+Vectorize as its memory tier)
and connect through a **seam**: #70 connector (mind→body dispatch + outcome pull) + **orient**
(body-agent reads structural state from the body, field state from a pot-local mirror the mind
pushes inbound). No fork of the brain's organs into the pot; no egress from the sealed pot.

**Tech stack:** mupot — Cloudflare Workers, Hono, D1, Vectorize, member-token bearer auth, MCP.
Mind — SOS/sovereign (Python) forked + scoped per tenant via systemd `cortex-events@digid`.

**Evidence base:** [architecture-audit-mupot-vs-sos.md](../../architecture-audit-mupot-vs-sos.md)
(organ boundary) and `docs/viamar-seed-install-gap-2026-05-30.md` in the mumega.com repo (the seed
bring-up path). This spec assumes those findings.

---

## 1. The hybrid (one animal, two layers, on the `digid` user)

```
            ┌─────────────────────────  digid Linux user (isolated)  ─────────────────────────┐
   MIND     │  SOS fork (cortex-events@digid)  ·  own Redis/tokens  ·  BRAIN_TENANT_SCOPE=digid │
  (field)   │  coherence C(t)/regime · spin (genetics values) · trust tiers · utility gradient  │
            └───────────────┬───────────────────────────────────────────▲─────────────────────┘
                            │ dispatch flights (POST /api/flights)        │ pull outcomes (GET)
                            │ push field-state (POST /api/agents/field)   │ — all INBOUND
            ┌───────────────▼───────────────────────────────────────────┴─────────────────────┐
   BODY     │  mupot-digid  (agents.digid.ca, CF Worker)  — SEALED, inbound-only                │
  (form)    │  org/squads/agents · tasks · flights · presence · gated acts · dashboard · D1+Vec  │
            └────────────────────────────────────────────────────────────────────────────────┘
                  ▲ orient (MCP tool + HTTP twin): structural half (body) + field half (mirror)
                  │
              any agent, any harness (Claude Code · Codex · ChatGPT Business · Hermes)
```

**The hybrid trick:** the mind runs with `SOS_MEMORY_BACKEND=cloudflare` → its memory tier *is*
the body's D1+Vectorize. One CF substrate; the mind is a thin Python coordinator over the same
pot. No Postgres/Mirror tier to stand up.

**Isolation (S180, absolute):** digid's mind owns its Redis, bus tokens, LLM key, and
`BRAIN_TENANT_SCOPE=digid`. The central mumega brain stays scoped to `mumega` and never touches
digid ops. The body is single-tenant-per-pot (`TENANT_SLUG=digid`).

**Why sealed + inbound-only matters:** the body never egresses. Every mind→body interaction is the
mind calling in (dispatch, land, push field-state). So the body keeps working — and agents keep
getting oriented — even if the mind is asleep; orient reads a *local mirror*, not the live mind.

---

## 2. The seam contract

Two directions, both **mind-initiated inbound** to the sealed body:

| Direction | Endpoint | Built? |
|---|---|---|
| Mind dispatches a gated flight | `POST /api/flights` | ✅ #70 (live) |
| Mind reports outcome | `POST /api/flights/:id/land` \| `/fail` | ✅ #70 (live) |
| Mind pulls outcomes → re-measures C(t) | `GET /api/flights` | ✅ #70 (live) |
| **Mind pushes per-agent field-state** | `POST /api/agents/:id/field` | ❌ **new (S1)** |
| **Agent reads its orient packet** | `orient` MCP tool + `GET /api/orient` | ❌ **new (S1)** |

The field-state push is what makes orient's "field half" real without the body ever reaching out.

---

## 3. orient — the basin-drop (the buildable keystone, mupot lane)

### 3.1 One packet, two modes
A single assembler, served on demand. **First call** for an agent with no induction record =
full induction (recorded, `induction: true` — the formal welcome). **Every later session** = the
same packet, refreshed live, plus a "what changed since you were last here" delta. Harnesses are
stateless/thread-per-message, so re-orientation is the continuity layer — the bubble the agent
taps to know where it is in the story.

### 3.2 Two halves
**Structural half (the body owns, read from D1):**
- **Identity** — "You are `<name>` (`<role>`), on `<harness>`, agent id `<id>`."
- **Placement + chain of command** — department → squad; **supervisor = the squad's
  `memberships.capability` lead/owner — escalate there** (if you *are* lead, supervisor = the
  dept/org owner). Squad-mates + live presence.
- **Exact scope + magnitude (anti-assumption core)** — autonomy enum (`suggest`/`draft`/
  `execute`/`execute_with_approval` — e.g. "you may NOT ship, only draft"), KPI target + progress,
  and the **exact** list of your open/assigned tasks. "Do not expand scope or start from scratch."
- **Tools** — your RBAC verbs + effort/budget ceiling + the pot's MCP endpoint + skills available.
  "Use these — they exist; do not rebuild them."
- **The rails** — read state before acting · write work to GitHub · pass the gate · read memory ·
  rest when no defect.

**Field half (the mind owns, read from the pot-local mirror — S1's `agent_field` table):**
- **Coherence / regime** — your current C(t) + regime (flow/chaos/coercion/stall).
- **Trust tier** — your trust level + what it unlocks (the anti-crash friction).
- **Spin** — your endogenous values / learning-strategy (so you self-rotate with intent).

The field half is **read-only mirror** in the body: present if the mind has pushed it, gracefully
omitted if not (so orient works before the mind is wired — degrades, never errors).

### 3.3 The directive brief (field-physics framing made literal)
The rendered brief is **directive, not informational** — it is the basin-drop:
- **Basin** — your scope/KPI/squad is the well; settle here, don't wander.
- **Spin** — your autonomy + values + own goal; you self-rotate (act), you don't wait.
- **Orbit** — the rails + chain of command = clean, non-colliding trajectory.
- **No-crash** — scope bounds + supervisor + the gate + trust tier = the walls; you cannot fly
  off into "from scratch" or collide with another agent's work.

### 3.4 Delivery
`orient` **MCP tool** (harness-agnostic — every harness speaks MCP, incl. ChatGPT Business
connectors) + **`GET /api/orient`** HTTP twin (for the mind, the Slack adapter, non-MCP callers).
One service fn, two transports. Identity from the member-token bearer → `memberId` → agent row.

### 3.5 Brain-induced onboarding
An un-inducted agent is a small incoherence; digid's mind detects it (new enrollment / never
oriented) and proactively triggers orient via the seam, so onboarding is automatic — the agent is
dropped into its basin without waiting to be told.

---

## 4. Decomposition (each sub-project gets its own spec → plan → build)

| # | Sub-project | Lane | Depends on | One-line |
|---|---|---|---|---|
| **S1** | **orient seam** (this spec's core) | **mupot dev (mine)** | — | `agent_field` table + `POST /api/agents/:id/field` (mind push) + `buildOrientPacket` + `orient` MCP tool + `GET /api/orient` + directive brief + induction record/delta. Field half degrades gracefully if no mind. |
| **S2** | **#80 brain-side caller** | runtime (Hadi/gated) | S1 + digid mind | digid's mind: detect defect → `POST /api/flights`; poll outcomes → re-measure C(t); push field-state → `POST /api/agents/:id/field`; trigger orient for new agents. Closes the loop end-to-end. |
| **S3** | **digid mind bring-up runbook** | runtime (Hadi/gated) | — | Per the seed gap doc: fork SOS on the `digid` user, `sos setup --defaults`, `SOS_MEMORY_BACKEND=cloudflare` (= mupot-digid D1+Vectorize), digid LLM creds, demote Vertex-ADC, seed systemd bundle, `cortex-events@digid` scope=digid. I write it; Hadi runs it. |

**Sequence:** S1 first (pure dev, my lane, unblocks everything, works standalone with the field
half dormant). Then S3 (stand up the mind) and S2 (wire it) together to light up the full loop +
field half on digid. S1 ships value immediately (every agent orientable) even before S2/S3.

---

## 5. Out of scope (own specs later)
- **Per-agent MCP *attachment*** (ChatGPT-Business-style connectors per agent) — orient v1 reports
  the tools that exist; attaching arbitrary MCPs per agent is a later slice.
- **Slack adapter + harness-agnostic thread-state** — your 2 ChatGPT Business agents; a channel
  adapter (`src/channels/adapters/slack.ts`) + thread→agent state continuity.
- **Porting the field organs** (genetics/trust/bank) into the pot for tenants who run *no* SOS —
  deferred; the hybrid keeps the field in the forked mind.

## 6. Testing
S1 is a pure assembler over D1 + a mirror table — tested without a Worker: chain-of-command
resolution (lead vs self-is-lead), exact-scope/magnitude rendering, field-half present/absent
(graceful degrade), induction-vs-reorient + delta, the directive brief string. Then thin transport
tests (auth, identity resolution) + the field-push endpoint (auth = org-admin, tenant-scoped, like
the #70 connector). Adversarial gate on the new write endpoint (it accepts mind-pushed state).

## 7. Open questions
- **digid mind state** (Hadi verifying): is `cortex-events@digid` already running on the digid
  user, and does it use CF memory backend yet? Determines whether S3 is "verify/wire" or "stand up
  fresh." S1 does not block on this.
- Field-state freshness/TTL: how stale may the mirror be before orient flags it? (Propose: show
  `field_updated_at`; if older than N, mark field half "stale — mind may be asleep.")
