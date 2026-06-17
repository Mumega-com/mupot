// mupot — department microkernel: Null/Fixture department.
//
// THIS MODULE HAS NO PRODUCT VALUE. Its sole purpose is to prove the microkernel
// litmus test (§3.5 of console-department-microkernel.md) BEFORE any real
// department (Growth, Finance, …) is built.
//
// Why a fixture first?
//   Growth is semantically rich — it would hide contract mistakes behind product
//   complexity. A semantically empty fixture lets the conformance harness catch
//   seam defects cheaply.
//
// Litmus discipline:
//   - Adding this file + one register() call is ALL that is required.
//   - Nav, metric selector, capability resolver, audit writer, bus, schema, and
//     sibling departments are NOT edited.
//   - Removing this file + its register() call leaves all other tests green.
//
// When the real departments (Growth, Finance, …) are built, they follow this
// pattern exactly: one module file + one register() call.

import type { DepartmentModule } from '../contract'
import { register } from '../registry'

export const FixtureModule: DepartmentModule = {
  key: 'fixture',
  name: 'Fixture (Test Department)',
  version: '0.1.0',

  // ── defaultSquads: minimal — fixture proves idempotent seeding, not org design.
  defaultSquads: [
    {
      slug: 'fixture-core',
      name: 'Fixture Core',
      charter: 'Test squad for conformance harness. No real work.',
      okr: 'Prove the microkernel litmus.',
    },
  ],

  // ── metricsEmitted: two descriptors to exercise the honesty guard.
  //
  //   fixture.pings: realtime count, ohlcEligible=true (multiple per day possible).
  //     → when there are ≥2 readings in a day, seriesShape() returns 'candle'.
  //
  //   fixture.scalar: daily scalar, ohlcEligible=false (one per day).
  //     → seriesShape() MUST return 'bar' — never fabricate O/H/L/C.
  //
  metricsEmitted: [
    {
      key: 'fixture.pings',
      unit: 'count',
      direction: 'neutral',
      cadence: 'realtime',
      aggregation: 'sum',
      ohlcEligible: true,
      sourceAuthority: ['fixture-harness', 'manual'],
      retention: '30d',
      display: { precision: 0 },
    },
    {
      key: 'fixture.scalar',
      unit: 'count',
      direction: 'neutral',
      cadence: 'daily',
      aggregation: 'last',
      ohlcEligible: false,
      sourceAuthority: ['fixture-harness'],
      retention: '30d',
      display: { precision: 0, suffix: ' units' },
    },
  ],

  // ── consoleSection: a render reference, NOT a shell import.
  consoleSection: {
    id: 'fixture',
    title: 'Fixture',
    navIcon: 'beaker',
    path: '/departments/fixture',
  },

  // ── requiredCapabilities: minimal — 'member' is sufficient to emit metrics.
  requiredCapabilities: ['member'],

  // ── connectors: none — the fixture has no external integrations.
  connectors: [],
}

// Auto-register when this module is imported.
// This is the ONE registry call that must exist per department (§3.5 "registry plumbing").
// It does NOT edit the registry file — it calls the open registration function.
//
// replace: true is safe here for the module's own initial registration because this
// file is imported once at test harness setup (after _clearRegistry) and once at
// production boot. The duplicate-key guard in register() would fire on double-import
// in a long-lived process; `replace: true` makes re-registration idempotent.
register(FixtureModule, { replace: true })
