# Operator Vocabulary Artifact — mupot Dashboard

**Captured:** 2026-06-11
**Issue:** Mumega-com/mupot#124
**Status:** PRESERVED BY DESIGN — this is the OPERATOR rendering vocabulary.

---

## Why this document exists

mupot renders the same substrate through **three vocabularies** for three
audiences:

1. **Operator rendering** — the substrate/console skin the day-to-day operator
   sees (squads, divisions, the "substrate console" framing). This is a real
   product surface, kept on purpose.
2. **Enterprise rendering** — the HR/IAM-grounded skin for B2B buyers (AI Agents
   / Digital Workforce, Sponsor/Owner, Entitlements, Provision/Decommission).
   Issue #124 grounds the enterprise-facing surfaces in this vocabulary.
3. **(Future) game/creature rendering** — not present in the dashboard codebase
   today.

Issue #124 grounds **only the enterprise-facing surfaces**. It does NOT strip
the operator vocabulary — the operator skin stays. This artifact snapshots the
operator/admin label strings **as they existed before** the enterprise grounding
so the operator rendering's wording is never lost. If we later split the two
renderings behind a flag, this is the source of truth for the operator skin.

---

## Snapshot — operator label strings (pre-grounding)

### Top nav (`shell()` — `src/dashboard/index.ts`)

| Position | Label |
|---|---|
| brand line | `<brand> · substrate console` |
| nav | Overview · Send · Approvals · Loops · Brain · Flights · Agents · Fleet · Members · Divisions · Scoped Keys · Setup · Sign out |

### `/members` admin console — `membersAdminBody` (`index.ts`)

| Element | Operator string |
|---|---|
| crumbs | `Overview / Members` |
| h1 | `Members` |
| subtitle | `... humans are first-class network nodes (one person = one member, many channels).` |
| h2 | `Invite a member` |
| invite help | `An invite is redeemed once: first connect mints the member, capability and a workspace token. The capability applies org-wide unless you scope it to a department.` |
| form labels | Email · Department · Capability |
| button | `Create invite` |
| h2 | `Roster` |
| table headers | Member · Channels · Capabilities · Status · Actions |
| row actions | `Suspend` / `Reactivate` · `Grant capability` |
| grant modal h3 | `Grant capability — <who>` |
| grant modal labels | Scope type · Scope · Capability |
| grant modal buttons | `Cancel` · `Grant` |

### `/members` connect page — `membersPageBody` (`index.ts`)

| Element | Operator string |
|---|---|
| crumbs | `Overview / Members` |
| h1 | `Members` |
| subtitle | `... A token is what a member pastes into their workspace config ... Mint one below — it is shown exactly once.` |
| empty | `No members yet. Invite someone from the Divisions / admin console — first connect mints their member + token.` |
| table headers | Member · Channels · Tokens · Mint |
| token states | `no live tokens` · `Revoke` |
| mint form | Label · Channel (workspace / IM / dashboard) · `Mint token` |
| show-once h1 | `Token minted for <name>` |

### `/admin/divisions` — `divisionsAdminBody` (`index.ts`)

| Element | Operator string |
|---|---|
| crumbs | `Overview / Divisions` |
| h1 | `Divisions` |
| empty | `No departments yet. Seed the org via POST /api/org/departments ...` |
| subtitle | `... <n> departments · <n> squads. A head is any member holding lead or stronger capability on that scope.` |
| squad meta | `· squad` |
| dept head line | `Department head: <heads>` |
| no-head | `no head assigned` |
| footer | `Assign a head from the Members page — grant a member lead (or higher) on the department or squad scope.` |

### `/admin/keys` — `keysPageBody` (`src/dashboard/keys.ts`)

| Element | Operator string |
|---|---|
| crumbs | `Overview › Members › Scoped API Keys` |
| h1 | `Scoped API Keys` |
| intro | `Mint a fine-grained API key for a member based on a role preset. ...` |
| h2 | `Mint a key` |
| form labels | Role preset · Member · Squad (scope) · Department (scope) |
| button | `Mint key` |
| h2 | `Active scoped keys` |
| table headers | Member · Label (preset:scope) · Created |
| show-once h1 | `Key minted` |

### `/admin/connectors` — `connectorsPageBody` / `connectorAddedBody` / `connectorRotatedBody` (`src/connectors/dashboard.ts`)

| Element | Operator string |
|---|---|
| crumbs | `Overview › Connector Credentials` |
| h1 | `Connector Credentials` |
| intro | `Tool credentials (Telegram bot tokens, Instantly keys, GHL, custom) stored encrypted at rest. ...` |
| h2 | `Add connector` |
| form labels | Type · Label · Secret / Token · Scope (Pot-wide / Squad / Agent) · Scope ID (UUID) · Meta |
| button | `Add connector` |
| h2 | `Active connectors` |
| table headers | Type · Label · Scope · Added · Actions |
| scope label | `Pot-wide` |
| row actions | `Rotate` · `Revoke` |
| add confirm h1 | `Connector added` |
| rotate confirm h1 | `Secret rotated` |

### Operator/work surfaces — UNTOUCHED (operator skin retained)

These keep their operator vocabulary entirely; #124 does not touch them:

- `/` Overview swimlane — "Fleet activity · last 24h", "Needs your decision", "Recent tasks", "work unit"
- `/send` — "Send a task"
- `/approvals` — "Approvals"
- `/loops` — "Loops", "Goal-seeking work-units running on the heartbeat ..."
- `/brain` — "Brain", "Per-pot loop governor ...", Pause/Resume/Kill
- `/flights` — "Flights"
- `/fleet` — "Fleet"
- `/agents`, `/agents/:id` — "Agents", "Console"
- `/squads/:id` — squad board, charter
- `/setup` — first-run wizard: "Org & brand", "Departments", "Squads", "Invite team", "Model", "IM", "First agent"

---

## Operator → Enterprise mapping applied in #124

For the record, the grounding applied to the enterprise surfaces above:

| Operator term | Enterprise term (#124) |
|---|---|
| Members (roster) | AI Agents / Digital Workforce; the list = Directory / Agent System of Record |
| member | (human) Sponsor / Owner; (agent) AI Agent / Non-Human Identity |
| Roster | Directory (Agent System of Record) |
| Grant capability | Grant Entitlement |
| Capability / Capabilities | Entitlement / Entitlements |
| Divisions | Organization / Departments |
| squad | Team |
| Connector Credentials | Connector Credentials (kept) — labelled Credentials / Access |
| Provision/add | Provision / Onboard |
| Suspend/Revoke | Revoke (emergency) / Decommission (retire) |

The operator surfaces above retain the left-column vocabulary. The enterprise
surfaces use the right column.
