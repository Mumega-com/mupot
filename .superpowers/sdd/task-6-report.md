# Task 6: Addons Console Report

## Delivered

- Added the authenticated `/addons` operational console using the existing server-rendered dashboard shell.
- Joined registered addon manifests to tenant-scoped installation state, showing state, digest tail, connector and authority requests, and receipt access.
- Rendered only valid lifecycle commands: Install, Configure, Activate, Disable, and disabled-state Activate plus Uninstall. Archived addons have no mutation control.
- Bound action buttons to `data-addon-key` and `data-addon-action`; the browser constructs fixed encoded API paths, disables the command while pending, renders stable error codes inline, and refreshes on success.
- Added owner/admin protection for the page and navigation: the shell reveals the Addons entry for owner/admin sessions only, while members receive `403` and the entry stays hidden.

## Changed Files

- `src/dashboard/addons.ts`
- `src/dashboard/index.ts`
- `tests/dashboard-addons.test.ts`

## TDD Evidence

1. Added dashboard rendering tests before the module existed.
   - `npx vitest run tests/dashboard-addons.test.ts` failed as expected with `Cannot find module '../src/dashboard/addons'`.
2. Implemented the renderer.
   - Focused test passed: 8 tests.
3. Added `/addons` route authorization and nav tests before route wiring.
   - Focused test failed as expected: owners/admins and members received `404`.
4. Wired the guarded route and console nav entry.
   - Focused test passed: 11 tests.
5. Added the shell-wide hidden-nav/reveal regression before implementation.
   - Focused test failed as expected because `nav-addons` was absent on member shells.
6. Reused the existing `/auth/me` role resolution to reveal the nav entry for owner/admin sessions only.
   - Focused test passed: 11 tests.

## Verification

- `npx vitest run tests/dashboard-addons.test.ts tests/dashboard-auth-shell.test.ts tests/dashboard-header-chips.test.ts tests/addon-routes.test.ts`
  - Passed: 4 files, 41 tests.
- `npx vitest run tests/addon-contract.test.ts tests/addon-registry.test.ts tests/addon-service.test.ts tests/addon-routes.test.ts tests/dashboard-addons.test.ts`
  - Passed: 5 files, 146 tests.
- `npm run typecheck`
  - Passed.
- `git diff --check`
  - Passed with no whitespace errors.

## Self-Review

- Lifecycle URLs are never interpolated into action markup. Commands carry only the addon key and allowlisted action as data; client code uses `encodeURIComponent(key)` against the fixed `/api/addons/` base path.
- The server denies members before addon catalog reads. The lifecycle API remains the sole write path and independently enforces the same owner/admin boundary.
- The renderer uses compact 8px cards, existing CSS variables, stable command dimensions, a puzzle icon, responsive fact layout, no nested cards, and no marketing content.
- Archived selections follow the API's latest-installation rule, preferring live installations over archives and the most recent archive when no live installation remains.

## Concerns

None.
