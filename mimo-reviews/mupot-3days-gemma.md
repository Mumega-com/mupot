# Mupot 3-Day Review Report (2026-08-16 to 2026-08-19)

**Prepared by:** Independent Review Subagent (Gemma)
**Scope:** github.com/Mumega-com/mupot

## 1. Built/Merged Summary

### [flight/watchdog]
- **Description:** Significant advancement in the flight lifecycle management via the `watchdog` component. Implemented mechanisms to reap stalled flights (`src/flight/watchdog.ts`) and introduced `reap_receipts` (`0109_flight_reap_receipts.sql`) to provide an audit trail distinct from successful flight landings. Refined testing for the "sleep guard" to ensure it accounts for migration-related delays.
- **Risk/Observation:** There is a delicate balance between "stalled" and "slow." If watchdog timeouts are too aggressive or don't account for the jitter in flight execution (especially during heavy migration windows), the system could enter a "reap storm" loop, prematurely killing legitimate flights.

### [gates/authz]
- **Description:** Enhancements to capability-based access control. Added support for re-gate paths specifically for review tasks (`0113_gate_owner_reassignments.sql`) and reconciled `isOrgAdmin` logic to properly handle capability grants alongside legacy roles.
- **Risk/Observation:** The "re-gate" functionality, while necessary for workflow continuity, expands the surface area for privilege escalation. If the identity/role check that authorizes a "re-gate" is compromised or misconfigured, an attacker could bypass initial gate constraints.

### [security]
- **Description:** Critical remediation of a high-severity timing attack in the `torivers` addon authentication. Conducted credential audits (GitHub/Mac-local) and fixed a vulnerability in the `/credentials/match` endpoint that was overly permissive with scopes.
- **Risk/Observation:** The timing attack in the addon suggests that the security boundary between the core Mupot kernel and its addons is currently a weak link. Addon security maturity appears to lag behind the core, necessitating stricter sandboxing or validation for third-party modules.

### [presence/onboarding]
- **Description:** Introduced "seat activity" telemetry (`0108_module_seat_activity.sql`) to monitor seat state beyond simple reachability. Implemented "onboarding doors" (`src/onboarding/doors.ts`) to provide a structured, reversible OAuth-based signup flow.
- **Risk/Observation:** Granular seat activity tracking is a "double-edged sword." While excellent for debugging and operational visibility, it introduces significant telemetry volume and potential privacy/audit concerns if not strictly limited to technical metadata.

### [budget policy]
- **Description:** Alignment of dispatch logic with metering via PR 1179. The current implementation defaults to "unlimited" budget when no cap is set, intended to accommodate fleet members on rationed subscription capacities rather than per-token metering.
- **Risk/Observation:** **HIGH RISK.** The "default to unlimited" posture is a classic "fail-open" design. Any configuration error or missing cap in a metered environment could lead to uncontrolled resource consumption or cost spikes.

## 2. Unfinished or Risky

- **Fail-Open Budgeting:** The decision to treat unset budgets as unlimited (PR 1179) is the most significant operational risk. A "fail-closed" or "small sandbox default" approach would be more robust.
- **Watchdog Sensitivity:** The watchdog's ability to distinguish between a "stalled" flight and a "slow" flight is still being tuned through tests; stability in high-latency scenarios is not yet proven.
- **Addon Security Perimeter:** The presence of a high-severity timing attack in an addon indicates that the current vetting/runtime-isolation for addons is insufficient for a production-grade ecosystem.

