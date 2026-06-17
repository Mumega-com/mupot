// mupot — department microkernel: declarative contract.
//
// A DepartmentModule is a MANIFEST, not a behavior carrier. It declares what a
// department emits, what it needs, and where it appears in the console. Runtime
// behavior is expressed by calling the kernel ports through DepartmentCtx — never
// via bespoke lifecycle hooks on this contract.
//
// Key invariants (§3.2, §3.4, §4.1 of console-department-microkernel.md):
//   - DepartmentModule carries NO bespoke lifecycle functions.
//   - MetricDescriptor.ohlcEligible is the honesty guard (§4.2): false → bar, never candle.
//   - MetricDescriptor.sourceAuthority is the anti-pollution guard (§4.1): emitting
//     from an unlisted source is rejected at the ctx facade.
//   - ConsoleSectionRef is a render reference — NOT a shell import or direct UI access.
//   - ConnectorRef and SquadSeed are declarative seeds; instantiation is kernel work.
//
// Microkernel litmus discipline (§3.5): adding a new department module must NOT
// require editing this file, the registry, the nav, the metric selector, the
// capability resolver, the audit writer, the bus routing, the DB schema, or any
// sibling department. A module registers itself; the kernel's dynamic lists do the rest.

import type { Capability } from '../types'

// ── MetricDescriptor ─────────────────────────────────────────────────────────
//
// Every metric key a department emits must declare a descriptor. The descriptor
// is the typed contract between the department and the pulse spine (§4.1). Without
// it, metric_points pollutes: 'growth.revenue' from Stripe, manual entry, and brain
// inference would collapse into one meaningless series.

export interface MetricDescriptor {
  /** Stable dotted key: 'fixture.pings'. Must match [a-z0-9._]+, max 64 chars. */
  key: string
  /** Unit label: 'count' | 'usd' | 'ratio' | 'ms' | … */
  unit: string
  /** Directional semantics for display: 'up_good' | 'down_good' | 'neutral'. */
  direction: 'up_good' | 'down_good' | 'neutral'
  /**
   * How frequently readings are expected. Controls honest empty-state messaging:
   * 'realtime' = multiple per day possible → candle eligible IF ohlcEligible=true
   * 'daily'    = one reading/day → bar always (O==H==L==C, fabrication risk)
   * 'weekly'   = one reading/week
   */
  cadence: 'realtime' | 'daily' | 'weekly'
  /**
   * How multiple readings for the same metric_key combine when displayed as a
   * scalar (KPI card). Does not affect OHLC aggregation (which is always open/
   * high/low/close by occurred_at within the day).
   */
  aggregation: 'sum' | 'last' | 'avg' | 'max'
  /**
   * Honesty guard (§4.2): true ONLY when intraday range is meaningful for this
   * metric (multiple readings/day expected). false → the UI MUST render as bar,
   * never candle. Propagated to the metric registry so the candlestick selector
   * can filter without knowing which department emitted the metric.
   */
  ohlcEligible: boolean
  /**
   * Anti-pollution guard (§4.1): the set of `source` values that may write this
   * key. Any emit() call whose source is not in this list is rejected by the ctx
   * facade BEFORE touching D1.
   *
   * Declared as readonly string[] so deep-frozen descriptors (ctx internals) are
   * assignable here without widening — callers may pass mutable arrays, the ctx
   * will freeze them.
   */
  sourceAuthority: readonly string[]
  /** How long readings are kept. Informational for now; future cleanup job uses this. */
  retention: string
  /** Display hints for the console: how many decimal places, optional prefix/suffix. */
  display: {
    precision: number
    prefix?: string
    suffix?: string
  }
}

// ── SquadSeed ─────────────────────────────────────────────────────────────────
//
// Declarative seed for squads the kernel should create on first activation.
// The registry uses these to call the existing createSquad path — no bespoke
// squad-creation logic lives in department modules.

export interface SquadSeed {
  /** Stable slug for the squad — used for idempotency guard. */
  slug: string
  name: string
  /** Optional culture/mandate text. */
  charter?: string
  /** Optional accountability OKR. */
  okr?: string
}

// ── ConsoleSectionRef ────────────────────────────────────────────────────────
//
// A render reference — NOT a direct import of a shell component. The console
// shell iterates getActiveConsoleSections(tenantId) and maps each id to a
// pre-registered renderer (a separate plugin table, future work). For now the
// id and icon let the shell build a nav entry without any per-department branch.

export interface ConsoleSectionRef {
  /** Stable id (matches the module key). Used by nav to build the section link. */
  id: string
  /** Display title in the nav. */
  title: string
  /** Nav icon name (from the icon set in use — a string reference, NOT a component). */
  navIcon: string
  /** The route path the nav link points to (e.g. '/departments/fixture'). */
  path: string
}

// ── ConnectorRef ─────────────────────────────────────────────────────────────
//
// A reference to an optional connector (GHL, Stripe, ad platforms, PostHog…).
// Connectors are gated — secrets require Hadi-go. This is the declaration of
// *intent*, not the wiring itself.

export interface ConnectorRef {
  /** Connector key matching the connectors registry (e.g. 'stripe', 'ghl'). */
  key: string
  /** Whether the connector is required for basic functionality or optional. */
  required: boolean
}

// ── DepartmentModule ─────────────────────────────────────────────────────────
//
// The seam a module must satisfy. This is a MANIFEST: it declares capabilities,
// metrics, squads, and console presence. It does NOT carry lifecycle hooks.
// All runtime behavior flows through DepartmentCtx (ctx.ts).
//
// Conformance rule (§3.5): a new module satisfies this interface and registers
// itself. No other file is edited.

export interface DepartmentModule {
  /**
   * Stable unique key. Used as the `template_key` column in the departments table.
   * Must be lowercase alphanumeric + hyphens: [a-z0-9-]+.
   */
  key: string
  /** Human-readable display name. */
  name: string
  /**
   * Template version string (semver recommended). Stored as `template_version` on
   * the departments row (§3.4b). Used to detect when a registered template has
   * evolved beyond the activated instance's version.
   */
  version: string
  /**
   * Squads the kernel seeds on first activation. Re-activation is idempotent —
   * the registry guards via seed receipts and never double-seeds.
   */
  defaultSquads: SquadSeed[]
  /**
   * Metric keys this department may emit. Registered in the metric descriptor
   * registry on activation so the candlestick selector and metric validators
   * see them without any per-department switch.
   */
  metricsEmitted: MetricDescriptor[]
  /**
   * Console section reference — what the nav renders for this department.
   * The shell iterates getActiveConsoleSections() and builds entries from these.
   * No shell code is edited when a new department is added.
   */
  consoleSection: ConsoleSectionRef
  /**
   * Capabilities required for the module to function. The ctx facade uses these
   * for deny-by-default checks — a ctx without the required capability cannot
   * call the facade's privileged methods.
   */
  requiredCapabilities: Capability[]
  /**
   * Optional connectors this department can use. Declarative; wiring is kernel work.
   * Empty array for departments with no external connectors.
   */
  connectors: ConnectorRef[]
}
