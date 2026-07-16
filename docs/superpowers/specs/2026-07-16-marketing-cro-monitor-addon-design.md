# Marketing/CRO Monitor Addon Design

**Status:** Approved direction; written review pending
**Date:** 2026-07-16
**Depends on:** `docs/superpowers/specs/2026-07-15-addon-framework-design.md`
**First tenant:** Mumega
**Second tenant:** Digital Marketing Experts (DME)

## 1. Goal

Make Marketing/CRO the first commercially useful Mupot addon by turning existing
marketing activity, website, analytics, and conversion signals into one governed,
tenant-local operating view. The first release is read-only: it monitors outcomes,
identifies one bounded opportunity at a time, and prepares governed work without
changing a website or external system.

The delivery order is deliberate:

1. prove the complete addon experience with deterministic fixture data;
2. activate the same addon on Mumega with read-only internal and vault-backed sources;
3. activate the unchanged addon on DME with DME-owned bindings;
4. add separately reviewed, approval-gated execution after the monitor is trusted.

## 2. Product Boundary

The addon composes existing Mupot capabilities rather than creating a second marketing
platform. It uses:

- Growth for demand, SEO/AEO, and pipeline metrics;
- Agency Services for delivery squads;
- Web Operations for website ownership and QA;
- the connector vault for tenant-owned external access;
- metric points and CRO events for normalized evidence;
- tasks, flights, approvals, audit, and receipts for governed work.

The first release may read WordPress, Inkwell, first-party analytics, PostHog, and Search
Console. It cannot publish content, change website configuration, send outreach, mutate a
CRM, or widen its own authority. A future execution release must use the existing approval
and executor rails and receive a separate governance review.

## 3. Approaches Considered

### 3.1 Hard-code a Mumega marketing dashboard

This is fast but tenant-specific. It would couple the dashboard to Mumega credentials and
make DME a rewrite instead of an activation. It also bypasses the addon lifecycle and
would not prove Mupot as a reusable product.

### 3.2 Build a parallel marketing subsystem

This could provide a clean-looking feature boundary, but it would duplicate departments,
metrics, CRO sources, tasks, and approvals that already exist. Duplicate sources of truth
would make receipts and ownership ambiguous.

### 3.3 Compose existing primitives through a native addon

This is the selected approach. A declarative native addon owns connector slots, source
selection, outcome definitions, one monitor program, and one pre-registered console
renderer. It reuses existing department and governance contracts and remains portable
between pots through configuration only.

## 4. Addon Manifest

The native addon key is `marketing-cro-monitor`, version `1.0.0`. It declares:

- departments: `growth`, `agency`, and `web-ops`;
- one pre-registered console renderer at `/addons/marketing-cro-monitor`;
- one disabled `website-opportunity-review` loop template;
- one approval policy for promoting a recommendation into executable work;
- read-only connector slots and no rank or surface-capability grants.

Connector slots:

| Slot | Accepted adapters | Required | Capability |
| --- | --- | --- | --- |
| `web_analytics` | `first_party`, `posthog` | yes | read |
| `content_surface` | `inkwell`, `mcpwp` | no | read |
| `search_performance` | `google_search_console` | no | read |
| `crm` | `ghl`, `crm` | no | read |
| `ai_visibility` | future registered AI-visibility adapter | no | read |

The required analytics slot has a zero-credential internal adapter (`first_party`), so a
fresh pot can activate the monitor without inventing an external credential. Optional
slots improve the evidence but never block the monitor.

## 5. Binding Model

Addon configuration stores slot bindings separately from connector credentials. A binding
contains the tenant, installation, slot, adapter type, binding kind, capability, optional
connector ID, actor, and timestamps. It never stores a raw or encrypted secret.

Configuration validates every binding against the installed immutable manifest:

- the slot exists and the adapter appears in its `accepts` list;
- required slots are present exactly once;
- `internal_adapter` bindings reference a pre-registered internal adapter;
- `vault_connector` bindings reference an active connector in the same tenant;
- the connector type matches the selected adapter;
- the granted capability equals the manifest capability and cannot be widened;
- read-only addon bindings cannot reach a write method;
- revoked or cross-tenant connectors fail preflight closed.

Reconfiguration is allowed only while the addon is installed, configured, or disabled;
an active addon must be disabled first. The initial configuration advances `installed` to
`configured`. Later binding changes keep the current configured or disabled state, append
a new configuration-preflight receipt, and must pass current-manifest preflight before
activation. Disable preserves bindings for inspection but prevents source runs. Archive
revokes addon-owned bindings while preserving receipts.

## 6. Source Contract

Each source adapter implements one narrow read interface:

```ts
interface MarketingMonitorSource {
  key: string
  slot: string
  read(env: Env, binding: ResolvedAddonBinding, window: MonitorWindow): Promise<SourceSnapshot>
}
```

`SourceSnapshot` contains normalized observations plus source status. Every observation
has a metric key, finite numeric value, unit, observed time, and source authority. Source
status is one of `available`, `unavailable`, or `failed` with a stable, non-secret reason.

The aggregator isolates sources, caps observations per source, rejects malformed values,
and never turns absence or failure into numeric zero. It returns a complete snapshot even
when optional sources are unavailable.

## 7. Fixture-First Proof

Fixture data lives in test and local-evidence helpers, not in production seed paths. The
fixture supplies deterministic observations for:

- `seo.ai_citations`;
- `seo.organic_sessions`;
- `growth.leads`;
- `growth.replies`;
- `seo.conversion_rate`.

At least one declared outcome is intentionally unavailable. This proves that the UI and
receipt distinguish unavailable from a real zero. Fixture timestamps and IDs are injected
so reruns produce stable evidence and deduplication can be asserted.

The fixture lifecycle must prove install, configure with `first_party`, activate, read,
identify one opportunity, disable, archive, reinstall, and repeat without duplicate
bindings, tasks, flights, or receipts.

## 8. Outcome Read Model

The monitor exposes five outcome groups:

- visibility;
- qualified traffic;
- leads;
- conversion;
- attributable revenue.

Each outcome is represented as a discriminated value:

```ts
type OutcomeValue =
  | { status: 'available'; value: number; unit: string; source: string; observedAt: string }
  | { status: 'unavailable'; reason: string }
```

Attributable revenue remains unavailable until an authoritative CRM or commerce source is
bound. No outcome renderer may display zero when status is unavailable. Derived values
must cite their input metrics and calculation in the evidence receipt.

## 9. Opportunity Review

`website-opportunity-review` runs only while the addon is active and the loop is enabled.
It ranks bounded candidates from the normalized snapshot, chooses at most one candidate,
and creates a deduplicated recommendation. The first release can create a task and flight
for human review, but its terminal action is `recommendation_ready`; it has no external
write executor.

The deduplication key binds tenant, addon installation, program version, target, evidence
window, and recommendation kind. The same evidence window cannot create a second open
recommendation. A changed source window or a terminal prior task may create a new one.

Every recommendation records:

- target URL or resource ID;
- observed problem and source evidence;
- proposed measurable hypothesis;
- primary KPI and baseline;
- unavailable evidence that limits confidence;
- approval requirement;
- task, flight, and receipt IDs.

Promoting a recommendation into a website change is explicitly outside this release.

## 10. Console Experience

The addon console is a quiet operational surface, not a marketing landing page. It has:

- an outcome strip for visibility, traffic, leads, conversion, and revenue;
- source-health rows showing bound, unavailable, failed, or stale status;
- one opportunity queue with evidence, KPI baseline, and approval state;
- recent monitor runs and receipts;
- links to the composed Growth, Agency, and Web Operations departments.

Desktop and mobile layouts must show unavailable states without clipping or horizontal
overflow. The renderer uses pre-registered server-rendered code; no manifest-provided HTML
or script is executed.

## 11. Mumega and DME Activation

Mumega starts with `first_party` analytics and may add read-only Inkwell, PostHog, and
Search Console bindings. One real Mumega opportunity must progress from signal to a
reviewable recommendation with a verified receipt.

DME receives a separate pot and binds DME-owned MCPWP, analytics, Search Console, and CRM
connectors. No Mumega credential, observation, task, flight, recommendation, or receipt is
copied into DME. The manifest digest must be identical between the two deployments.

## 12. Error and Security Handling

- Missing required bindings leave the addon installed but not configured.
- Optional source failures render unavailable and do not abort healthy sources.
- Raw and encrypted connector secrets never appear in bindings, APIs, receipts, logs, or
  rendered HTML.
- A disabled or archived addon cannot run sources or create recommendations.
- Connector revocation makes the source unavailable immediately and blocks the next run.
- Cross-tenant connector IDs, unknown adapters, capability widening, and manifest drift
  fail closed with stable reason codes.
- External reads use existing SSRF protection, bounded responses, timeouts, and redirect
  refusal.
- No monitor path calls a CMS, CRM, analytics, or connector write operation.

## 13. Test Strategy

Contract tests prove the manifest, registered references, read-only slots, and immutable
digest. Binding tests prove tenant isolation, required-slot completeness, adapter/type
matching, revocation, idempotency, and no-secret responses. Source tests prove isolation,
caps, malformed-value rejection, and unavailable-not-zero behavior.

Program tests prove one bounded recommendation, deterministic deduplication, task/flight
linkage, disabled guards, and no executor call. Lifecycle tests repeat the complete fixture
flow through reinstall. Browser tests cover configuration, activation, monitor rendering,
source failures, receipts, and mobile overflow.

Live proof is complete only when Mumega produces a real read-only opportunity receipt and
the same addon manifest can be configured for DME without cross-pot data.

## 14. Delivery Slices

1. Register the read-only manifest and pre-registered renderer contract.
2. Add tenant-scoped addon connector bindings and configuration preflight.
3. Add normalized source snapshots and deterministic fixture evidence.
4. Render outcome, source-health, opportunity, and receipt views.
5. Add the disabled opportunity-review program and fixture lifecycle receipt.
6. Bind Mumega first-party data, then read-only Inkwell/PostHog/Search Console.
7. Bind DME read-only MCPWP/analytics sources using DME-owned credentials.
8. Design approval-gated execution as a separate release.

## 15. Non-Goals

- publishing or editing WordPress or Inkwell content;
- sending outreach or mutating GHL/CRM state;
- automatically enabling the opportunity loop;
- fabricating missing outcomes;
- copying data or credentials between pots;
- arbitrary third-party code inside the Mupot Worker;
- addon upgrades, marketplace billing, or Accounting;
- replacing the existing CRO, department, task, flight, approval, or receipt systems.

## 16. Acceptance Criteria

- `marketing-cro-monitor` registers without addon-key branching in the kernel.
- An owner can configure it with `first_party` and activate it without external secrets.
- Every connector binding is tenant-bound, manifest-bound, read-only, and redacted.
- Fixture evidence proves one unavailable outcome is not rendered as zero.
- One fixture snapshot creates at most one reviewable task and flight.
- Disabled and archived installations cannot read sources or create work.
- Reinstall produces a fresh installation without duplicate live bindings or work.
- Desktop and 390px mobile views expose outcomes, source health, opportunity, and receipts.
- Mumega produces one real read-only opportunity receipt.
- DME can use the identical manifest with DME-owned read-only bindings.
