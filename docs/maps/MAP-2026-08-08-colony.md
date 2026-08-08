# MAP: 2026-08-08 Colony Fanout — 6-Tentacle Weave

**Status:** Live tracking document  
**Last updated:** 2026-08-08  
**Anchor:** Task a4c6b179-86d3-4b94-a6ee-01575947fc36

---

## Summary

6-deepseek-v4-flash tentacle fanout; codex seat retired, fleet consolidated (loom canonical, athena prime). Unblocks: token verify + 2 routine enables + #815 merge + dashboard credential loop. Machine 90% designed.

---

## 1. EXISTING TRACKERS (Do Not Duplicate)

| ID | Scope | Tracker | Owner | Status | Notes |
|---|---|---|---|---|---|
| 286d4212 | Routines | [#813 MERGED](https://github.com/Mumega-com/mupot/pull/813) | kasra | ✅ MERGED 08-08 | Token minted. Verify + enable. Incl. fleet-coherency 16c06b57 |
| 90075f12 | Codex token | [#814 MERGED](https://github.com/Mumega-com/mupot/pull/814) | — | 🔴 RED re-gate | Re-gate to real fix (not merged as-is) |
| 343d3a99 | CF Global API Key | Dashboard loop | dara + hadi | 🔴 P0 BLOCK | Needs Hadi/Dara dashboard credential loop |
| f16dfac1 | Shabrang | Dashboard loop | — | 🔴 P1 BLOCK | Same loop as CF API key |
| a20102b1 | Agentic audit | — | athena | 📋 ASSIGNED | Deliver due (unspecified deadline) |
| mupot#772 | Capture mechanism | [#772](https://github.com/Mumega-com/mupot/issues/772) | — | — | — |
| mupot#783 | Token rotation | [#783](https://github.com/Mumega-com/mupot/issues/783) | — | — | — |
| mupot#15 | Metering | [#15](https://github.com/Mumega-com/mupot/issues/15) | — | — | Unified execution metering (Flight 5) |
| flight 00b2ef4b | GEO scanner | [#651](https://github.com/Mumega-com/mupot/pull/651) + [#574](https://github.com/Mumega-com/mupot/issues/574) | — | 📋 LIVE | FIRST LIVE SCANS OK 2026-08-03. Remaining: cadence timer + receipt-sink 404 + profile upstream |
| mupot#645 | Caged lanes | [#645](https://github.com/Mumega-com/mupot/pull/645) | — | 🟡 HELD | Codex lane paused pending acceptance predicate. Gate holding. |
| mupot#732 | Dispatch | [#732](https://github.com/Mumega-com/mupot/issues/732) | — | — | — |
| mupot#734 | Dispatch cont. | [#734](https://github.com/Mumega-com/mupot/issues/734) | — | — | — |
| mupot#733 | ACK protocol | [#733](https://github.com/Mumega-com/mupot/issues/733) | — | — | — |

---

## 2. NEW TASKS FILED 2026-08-08

| Task | Scope | Tracker | Owner | Status |
|---|---|---|---|---|
| Registry ↔ Spine alignment | Identity/registry | **NEEDS ISSUE** | — | — |
| Board hygiene sweep | Board | **NEEDS ISSUE** | — | — |
| Meter/cost wiring | Tokenecon | **NEEDS ISSUE** | — | — |

---

## 3. DERIVED WORK (Child Tasks / Notes)

| Scope | Items | Status | Notes |
|---|---|---|---|
| Identity | registry drift, founder seal (MU.100.001 §6 ratified 08-06) | — | — |
| Board | board sweep, cost.ts wiring | — | — |
| Tokenecon | cost.ts, meter/burn gauge | — | — |
| Security | agentic audit (a20102b1 → athena) | 📋 ASSIGNED | — |
| Content | shabrang (f16dfac1) | 🔴 P1 | Dashboard loop needed |
| Routines | Two routines: **NEEDS ENABLE** | — | See §4 below |

---

## 4. ROUTINE ENABLES (DONE WHEN)

**Requirement:** Two routines must be enabled.

Candidates (require verification):

1. **fleet-coherency-sweep** (asha, hourly, report-only)
   - Gate: mumega-com#728
   - Brief: `~/.fleet/asha/coherency-brief-v1.md`
   - Checks runtime vs. spine (MU.100.002), P1 if drift detected
   - Status: Code complete, enable pending

2. **fleet-survey** (onboarding + survey pass, #818/#820)
   - Brief: Snapshot fleet harness state for onboarding
   - Status: Code merged, enable pending

| Routine | Project | Trigger | Owner | Status | Action |
|---|---|---|---|---|---|
| fleet-coherency-sweep | mupot | cron (hourly) | asha | 📋 DRAFT | Verify + enable |
| fleet-survey | mupot | manual | — | 📋 DRAFT | Verify + enable |

---

## 5. BURN GAUGE

| Metric | Current | Target | Status |
|---|---|---|---|
| Routine execution cost tracking | Not wired | Real (via cost.ts) | — |
| Meter/budget enforcement | Partial | Complete integration | — |
| Fleet telemetry burn | Manual loop | Automated (steward) | — |

---

## 6. ROUTING & OWNERSHIP

Items awaiting final ownership assignment:

| ID | Scope | Gap | Responsibility |
|---|---|---|---|
| mupot#772 | Capture mechanism | owner + deadline | — |
| mupot#783 | Token rotation | owner + deadline | — |
| mupot#15 | Metering | owner + deadline | — |
| flight 00b2ef4b | GEO scanner | owner for "receipt-sink 404" | — |
| PR #645 | Caged lanes | owner for acceptance predicate gate | — |
| mupot#732 | Dispatch | owner + scope | — |
| mupot#734 | Dispatch cont. | owner + scope | — |
| mupot#733 | ACK protocol | owner + implementation | — |

---

## 7. DONE CHECKLIST

- [ ] Every tracker item above has owner + issue (or marked no-action)
- [ ] Two routines identified and enabled (fleet-coherency-sweep + fleet-survey candidates)
- [ ] Burn gauge integrated (cost.ts ↔ metering)
- [ ] All child tasks filed as GitHub issues
- [ ] No duplicates created
- [ ] PR #815 (routine cross-squad fix) merged ✅
- [ ] Dashboard credential loop unblocked (343d3a99 + f16dfac1)
- [ ] Fleet-coherency sweep (asha, 16c06b57) verified live

---

## Notes

**Fleet status 2026-08-08:**
- Loom: canonical (Hadi/qNFT)
- Athena: prime/deepseek-v4-flash
- Kasra: build/merge lane
- River: flights (reserved)
- Asha: coherency clock (hourly fleet-sweep)
- Mubot: Hermes comms gateway
- Codex: retired

**Spine:** MU.100.002 (state layer under MU.100.001 law). Six agent nodes + roster. Update authority: any Council agent, PR-gated.

**Deployment:** v0.29.0 cut (not yet tagged). Capabilities are preview until release passes gate.
