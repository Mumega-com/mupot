# Services Ownership, SLO, and Death Conditions

**Status:** Decision. Approved by Hadi + Codex 2026-08-05.
**Purpose:** Single source of truth for which surface owns what, preventing "more systems than attention" by requiring explicit owner, SLO, and retirement condition for each retained service. No service retained by default.

---

## The Roster

| Surface | Owner | SLO | Death Condition |
|---------|-------|-----|-----------------|
| **Mupot Core** (control plane, D1, Queues, Durable Objects, KV) | Kasra | 99.9% uptime, <100ms p99 task-claim latency | Mupot.mumega.com abandons this customer; no active projects with Mupot-gated tasks for 90 consecutive days |
| **GitHub** (durable code, PRs, issues, decision artifacts, audit trail) | Kasra (repo ops), Codex (merge gate) | 99% uptime for PR read/merge surface; logs remain immutable forever | Repository is archived or transferred without equivalent audit trail replacement; code audit reveals GitHub data is not genuine source of truth for a critical decision |
| **Linear** (human portfolio ranking, ticket state) | Loom (portfolio coordination) | 48-hour sync window from Linear to work (via LinearAdapter); read-accessible always | Portfolio migrates to new system with equivalent ranking model and receipt linkage; Linear API becomes unavailable and no offline fallback for ≥30 days |
| **PostHog** (metrics collection, CRO signals, decision data) | Athena (observability) | 24-hour ingestion window; 95% of events recorded | PostHog service is decommissioned; mupot has alternative observability layer (Honeycomb, DataDog) fully live for ≥7 days; revenue signal migrates to owned analytics |
| **GoHighLevel (GHL)** (customer webhook mirror, lead/contact sync) | Kasra (connector code), Digid ops (Digid's tenant) | Webhook acknowledgment <2s; sync within 4 hours of change | Digid self-hosts GHL replacement or migrates CRM; GHL connector unused for ≥60 days (no active webhook fires) |
| **Hermes** (announcements, agent wake signals, message routing) | Kasra (bus routing) | Message latency <500ms p99; 99.5% delivery to agent inbox | Hermes decommissioned, replaced by direct mupot task-claim queue (no announce intermediary) live for ≥7 days with no regression |
| **Module Registry** (agent presence heartbeat, capabilities) | Kasra (registry ops), Kasra-review (audits) | Heartbeat received within 120s of send; stale detection query-time (no cron) | Presence tracking fully moves to fleet-level heartbeat in agent-harness (no server-side registry needed) |
| **Mumega.com / Inkwell** (agency automation, site operations squads) | Digid ops + Kasra (web-ops squad) | Web page load <3s p75; 99% uptime | Mumega.com is archived or moved to new CMS; web-ops squad is fully inactive (no tasks) for ≥60 days |
| **Courier** (authenticated wake, durable pointers to work) | Kasra (MCP gateway) | Wake latency <1s p99; pointer resolution <200ms | Courier model fully subsumed into mupot task API (direct routing); no agent uses Courier.wake() for ≥30 days |

---

## Rules

### Ownership
- **Owner is named**, not a department or "the team." One person is accountable.
- **Owner is authorized to make the death decision** (not consult on it, but execute).
- Owner delegates operations/runbooks but stays accountable for the decision.

### SLO
- **Measurable and auditable.** Not "fast," "reliable," "good uptime" — concrete numbers.
- **Measured at boundaries humans care about**, not internal plumbing (e.g., task-claim latency, not internal queue depth).
- **Set at a level that, if broken for >N hours, the service *probably should* be killed**, not endured.

### Death Condition
- **Explicit, not implicit.** "Unused for 90 days" is explicit. "We'll figure it out later" is not retained.
- **Trigger is deterministic** — observable state or date, not sentiment or "consensus."
- **Owner executes the death decision unilaterally** once the condition is met. No second vote.
- **Death leaves a record** — a GitHub issue, a date in CHANGELOG, or a git tag `<service>-eol-2026-08-15` so future audits know why it was retired.

---

## Lifecycle

When a new surface is proposed:

1. **A prospective owner announces intent** ("Kasra here, we need a task-queueing layer") via the bus.
2. **Hadi gates it** (decision: retain or reject). If retained: proceed to (3).
3. **Owner fills in the table** with SLO + death condition before code ships.
4. **Codex adversarial gate** surfaces any death conditions that are unrealistic or contradict another surface's SLO.
5. **Hadi approves the table entry**, and the service launches.
6. **Owner monitors the SLO** (automated or manual). If SLO breaks, escalate per severity.
7. **When death condition is met**, owner closes the service (sunset, deprecation phase, final shutdown), leaves a GitHub record, and removes the table entry.

---

## This Prevents

- **"More systems than attention":** Every retained service has an owner + an SLO + a concrete kill switch. Drift is impossible — a stale service either meets its SLO or dies.
- **Zombie services:** No service lingers "until we have time to migrate." The death condition makes migration explicit.
- **Surprise dependencies:** The table is durable (GitHub); changes require a PR and Codex gate. If Mumega.com suddenly depends on PostHog and PostHog's death condition is 30 days unused, that's visible.
- **Unowned failures:** SLO + owner means "who do I page if this breaks?" is answered.

---

## Future scope (not yet decided)

- Automated SLO monitoring dashboard (mupot observability)
- Quarterly SLO audit (owner renews SLO + death condition, or escalates)
- Scheduled review of inactive services (e.g., cron job that flags services hitting death condition)
