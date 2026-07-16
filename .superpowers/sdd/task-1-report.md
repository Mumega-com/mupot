# Task 1 Report: Generic Addon Renderer Registry and Marketing Manifest

## Result

Implemented the generic addon console-renderer registry and registered the read-only
Marketing/CRO monitor addon manifest. Console-section runtime validation now resolves
registered addon renderers instead of department-owned console sections. The fixture
renderer remains available at `/departments/fixture`.

## RED Evidence

Added the tests before production implementation and ran:

```text
npx vitest run tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts
```

The command failed as expected with three missing-module failures:

- `Cannot find module '../src/addons/console-registry'`
- `Cannot find module '../src/addons/modules/marketing-cro-monitor'` from
  `tests/addon-contract.test.ts`
- `Cannot find module '../src/addons/modules/marketing-cro-monitor'` from
  `tests/addon-registry.test.ts`

No test bodies ran because the new Task 1 modules did not yet exist.

## Files Changed

- `src/addons/console-registry.ts`
- `src/addons/modules/marketing-cro-monitor.ts`
- `src/addons/modules/index.ts`
- `src/addons/modules/fixture.ts`
- `src/addons/registry.ts`
- `src/addons/routes.ts`
- `src/dashboard/addons.ts`
- `tests/addon-console-registry.test.ts`
- `tests/addon-registry.test.ts`
- `tests/addon-contract.test.ts`
- `.superpowers/sdd/task-1-report.md`

## Tests

```text
npx vitest run tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts tests/dashboard-addons.test.ts
```

Passed: 4 test files, 39 tests.

```text
npm run typecheck
```

Passed: `tsc --noEmit` exited successfully.

## Commit

`feat(addons): register marketing CRO console`

## Self-Review

- Renderer records are shallow-cloned and frozen before registration; duplicate renderer
  keys fail closed.
- The marketing manifest and nested manifest data are deeply frozen before registration.
- The marketing manifest declares only read connector capabilities and no rank or
  surface authority grants.
- Existing fixture URL, title, icon, and lifecycle manifest remain backward-compatible.
- Production dashboard and addon-route entry points load the side-effect-only addon
  module index.
- The change is limited to the Task 1-owned production and test files plus this report.

## Concerns

None.

## Review Follow-Up (July 16, 2026)

Addressed the two Important findings from review package `86386af..e9acb0c` without
touching unrelated Task 1 work.

### RED Evidence

Added the review regressions first and ran:

```text
npx vitest run tests/addon-console-registry.test.ts tests/addon-service.test.ts
```

The command failed for the intended reasons:

- `tests/addon-console-registry.test.ts`: expected accessor-backed/noncanonical
  renderer registration to throw, but the registry accepted it.
- `tests/addon-service.test.ts`: `getRegisteredAddon('marketing-cro-monitor')`
  was `undefined` on direct service import.

### GREEN Evidence

After fixing `src/addons/console-registry.ts` and `src/addons/service.ts`, ran:

```text
npx vitest run tests/addon-console-registry.test.ts tests/addon-registry.test.ts tests/addon-contract.test.ts tests/dashboard-addons.test.ts tests/addon-service.test.ts
```

Passed: 5 test files, 163 tests.

```text
npm run typecheck
```

Passed: `tsc --noEmit` exited successfully.

### Follow-Up Commit

`fix(addons): harden task 1 renderer registration`
