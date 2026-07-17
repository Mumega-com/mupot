# Task 3 Report: Normalized Source Snapshots and Deterministic Fixtures

## Scope

Implemented normalized Marketing/CRO source contracts, bounded sequential collection,
deterministic fixture evidence, and pure outcome derivation. This task adds no persistence,
routes, real connectors, or UI.

## RED Evidence

Initial command:

```sh
npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts
```

Result: 2 failed suites, 0 tests. Both imports failed as expected because
`src/addons/marketing/sources.ts` and `src/addons/marketing/outcomes.ts` did not exist.

Boundary regressions were then added and run before their fixes. Result: 2 failed tests:

- adapter-supplied unavailable text exposed `Authorization: Bearer top-secret` instead of a
  stable non-secret reason;
- `growth.revenue` with `first_party` authority was incorrectly available.

Accepted review findings were addressed in seven additional RED/GREEN cycles:

1. Authority derivation and `finance.revenue`: 3 failed, 17 passed. The collector returned
   generic invalid evidence for forged authority and outcomes did not recognize supported CRM
   revenue.
2. Post-read isolation: 1 failed, 20 passed. A throwing snapshot getter escaped the collector
   and prevented later sources from running.
3. Cap precedence and non-available evidence: 3 failed, 21 passed. Failed/unavailable status
   was inspected before source/run caps, and non-available snapshots could carry observations.
4. Collection identity: 3 failed, 24 passed. Collections had no run ID and did not reject
   duplicate observation IDs or mixed run IDs.
5. Immutable evidence: 1 failed, 27 passed. Mutating a source observation after collection
   changed the accepted evidence.
6. Outcome ordering: 2 failed, 28 passed. Last input won instead of latest timestamp with a
   deterministic observation-ID tie-break.
7. Canonical timestamps: 2 failed, 31 passed. Windows and observations without millisecond
   precision were accepted.

The accepted re-review findings were addressed in eight further test-first cycles:

1. Raw run budget: 2 failed, 26 passed. Rejected failed/unavailable arrays did not consume the
   raw 200-observation budget, and an over-cap source did not charge its full array length.
2. Exact metric units: 2 failed, 28 passed. The metric contract had no canonical units and a
   nonempty but incorrect unit was accepted.
3. Source metadata isolation: 1 failed, 30 passed. A throwing key getter escaped collection and
   stopped later sources.
4. Canonical and unique source identity: 2 failed, 31 passed. Invalid identifiers and duplicate
   source declarations were not rejected before reads.
5. Immutable binding manifest: 6 failed, 33 passed. The approved slot/adapter manifest was not
   enforced, allowing invalid binding metadata and a `web_analytics` plus `ghl` mismatch.
6. Outcome provenance: 9 failed, 0 passed. Outcome derivation accepted raw observations and
   forged collection objects instead of requiring collector-produced evidence.
7. Raw-cap latch precedence: 1 failed, 39 passed. Once the raw run budget was exceeded, a later
   unbound source reported its binding state instead of the stable run-limit failure.
8. Synthetic identity namespace: 1 failed, 40 passed. A declared `source_config_0` key collided
   with the deterministic metadata-failure identity.

The final accepted review findings were addressed with two recorded RED runs:

1. Untrusted arrays and canonical windows: 5 failed, 41 passed. Source-owned `map` methods
   forged invalid revenue and 201 accepted observations from a zero-length array; fractional
   and out-of-bounds lengths polluted the raw counter; and window getters were read repeatedly.
2. Effective bindings and connector re-resolution: 13 failed, 40 passed. `ai_visibility`
   remained reachable, vault bindings were trusted without tenant-local active connector
   metadata, connector type/ID mismatches reached source reads, and post-read drift was accepted.

After production enforcement, the outcomes suite recorded 1 failed, 8 passed because its GHL
fixture had no D1 connector metadata. A safe metadata-only D1 fixture was added; production
continues to call `resolveConnectorByIdWithMeta` directly with no injectable bypass.

The parent self-review findings were addressed with a final test-first cycle. The first RED run
recorded 6 failed, 54 passed; the 17-binding test already failed closed through duplicate-slot
validation, so it was tightened to throw on index access. After adding direct non-array and
fractional-length repros, the authoritative RED run recorded 11 failed, 53 passed. It proved:

- caller-owned `sources.map` and the `bindings` iterator were invoked;
- a function-owned `read.call` override replaced the captured read body;
- inputs above 16 entries were processed;
- non-array and non-integer-length inputs escaped stable configuration handling; and
- source/binding index getter failures escaped collection instead of remaining isolated.

The final two findings were addressed with one additional RED run: 3 failed, 64 passed. A
stateful `Symbol.toPrimitive` adapter was coerced twice and widened the normalized authority;
an observation index getter could change connector type after the final check; and an observation
property getter could revoke the connector after that check while evidence was still accepted.

The final intrinsic-mutation findings were addressed with one additional RED run: 3 failed,
76 passed. Replacing `WeakSet.prototype.has` made a genuine collection fail provenance;
replacing `Array.prototype[Symbol.iterator]` stopped outcome traversal; and replacing
`Array.prototype.includes`, `Object.freeze`, and `WeakSet.prototype.add` during source execution
allowed invalid first-party revenue and mutable, unbranded evidence.

The mutable Env verification finding was addressed with one additional RED run: 2 failed,
79 passed. A source could revoke the real connector and redirect final verification either by
replacing `env.DB` plus `env.TENANT_SLUG` or by replacing the original DB object's `prepare`
property, causing revoked GHL revenue evidence to be accepted.

## GREEN Evidence

```sh
npx vitest run tests/marketing-monitor-sources.test.ts tests/marketing-monitor-outcomes.test.ts
```

Result after the final fixes: 2 passed files, 76 passed tests.

```sh
npm run typecheck
git diff --check
```

Result: both commands exited successfully.

The final focused checkpoint was run from implementation commit
`10625866b409329425ea5ef24502ddb1afaa0446` and completed with
the same 50 passing tests and a successful `tsc --noEmit`.

The final review implementation checkpoint completed with 62 passing focused tests, successful
`tsc --noEmit`, and a clean `git diff --check`.

The parent self-review checkpoint completed with 73 passing focused tests, successful
`tsc --noEmit`, and a source audit finding no caller/source-owned array method, iterator, spread,
or function `.call` invocation in the collector.

The final checkpoint completed with 76 passing focused Task 3 tests, 21 passing addon binding
tests, successful `tsc --noEmit`, and an acceptance-order audit confirming no source-controlled
callback or accessor runs after the final vault safe-metadata resolution.

The intrinsic-mutation checkpoint completed with 79 passing focused Task 3 tests, 21 passing
addon binding tests, successful `tsc --noEmit`, and `git diff --check`. A static audit found no
dynamic calls to the reviewed mutable intrinsics or array iterators in `sources.ts` or
`outcomes.ts`; all such operations route through module-load captures.

The mutable Env checkpoint completed with 81 passing focused Task 3 tests, 21 passing addon
binding tests, successful `tsc --noEmit`, and `git diff --check`. An Env-access audit confirmed
that tenant, DB receiver, and `prepare` capability are captured before source execution and that
both vault resolutions use the private frozen verification wrapper.

## Changed Files

- `src/addons/marketing/types.ts`
- `src/addons/marketing/sources.ts`
- `src/addons/marketing/outcomes.ts`
- `tests/fixtures/marketing-monitor.ts`
- `tests/marketing-monitor-sources.test.ts`
- `tests/marketing-monitor-outcomes.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Implementation Commits

`9f031c72724e247745d99e52323315eff8abe552` (`feat(marketing): normalize monitor evidence`)

`1fec0c676ba7b3382788b2ea7b26a3b8842f7741` (`fix(marketing): harden monitor evidence`)

`10625866b409329425ea5ef24502ddb1afaa0446` (`fix(marketing): close monitor normalization boundary`)

`2a0b59495a863438f109c97d863a9777bce44745` (`fix(marketing): secure source collection boundary`)

`bfd865b9ed5e5e342acf284afba8980b0ce1d7a0` (`fix(marketing): bound collector inputs`)

`42528e440b61d8bbe4035650fe0195ce97009dd0` (`fix(marketing): finalize trusted binding acceptance`)

`49356f9c8bc10c5889bab723e227f8cd12557721` (`fix(marketing): capture trusted intrinsics`)

`a1a4d970bfb51d7f0b08b5c8a1d334654287b5d8` (`fix(marketing): pin vault verification environment`)

## Re-review Changed Files

- `src/addons/marketing/types.ts`
- `src/addons/marketing/sources.ts`
- `src/addons/marketing/outcomes.ts`
- `tests/marketing-monitor-sources.test.ts`
- `tests/marketing-monitor-outcomes.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Final Review Changed Files

- `src/addons/marketing/types.ts`
- `src/addons/marketing/sources.ts`
- `tests/marketing-monitor-sources.test.ts`
- `tests/marketing-monitor-outcomes.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Parent Self-review Changed Files

- `src/addons/marketing/sources.ts`
- `tests/marketing-monitor-sources.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Final Binding Review Changed Files

- `src/addons/marketing/sources.ts`
- `tests/marketing-monitor-sources.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Final Intrinsic Review Changed Files

- `src/addons/marketing/intrinsics.ts`
- `src/addons/marketing/sources.ts`
- `src/addons/marketing/outcomes.ts`
- `tests/marketing-monitor-sources.test.ts`
- `tests/marketing-monitor-outcomes.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Mutable Env Review Changed Files

- `src/addons/marketing/sources.ts`
- `tests/marketing-monitor-sources.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Residual Risks

- Task 4 must bind these in-memory snapshots to immutable, tenant-scoped runs and API redaction.
- Task 6 must resolve actual connector credentials behind its adapter boundary; this task only
  accepts safe binding metadata and deterministic test evidence.
- `finance.revenue` is limited to `ghl` and `crm`. Task 6 must prove those adapters derive the
  same canonical authorities from configured bindings before real revenue evidence is enabled.
- Task 4 must persist `rawObservationCount` and pass the branded collection directly to outcome
  derivation; a plain reconstructed object is intentionally rejected.
- Task 6 adapters must normalize upstream micro-USD values to canonical `usd` before returning
  observations to this boundary.
- The collector provenance brand is local to this module instance. Any future persistence
  rehydration path must re-enter a trusted normalization boundary rather than forge a collection.
- `ai_visibility` remains a future optional manifest and metric authority but is intentionally
  absent from the effective Task 3 binding contract until a supported `ConnectorType` exists.
- Accepted vault sources perform two safe-metadata D1 resolutions per run. This is deliberate to
  close source-execution drift; Task 6 should account for that bounded read cost.
- The collector intentionally caps one run configuration at 16 bindings and 16 sources. A future
  increase must preserve indexed intrinsic-only capture and receive a separate boundedness review.
- Vault evidence acceptance intentionally incurs a final safe-metadata lookup after all source
  accessors and local validation. Future source processing must not add untrusted work after it.
