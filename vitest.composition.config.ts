// vitest.composition.config.ts — a SECOND Vitest project, for tests that must run inside
// the real Workers runtime (mupot#704).
//
// WHY A SEPARATE CONFIG
//
// 298 test files pass under the default Node pool. Switching all of them to workerd to fix
// one blind spot would risk the whole suite to gain one test. The default pool is
// untouched; composition tests opt in here.
//
// WHY THE RUNTIME POOL IS THE ONLY OPTION
//
// src/index.ts — the DEPLOYED composition, the Hono app wrapped in OAuthProvider — could
// not be imported by any test. It transitively pulls DurableObject / WorkerEntrypoint /
// WorkflowEntrypoint from 'cloudflare:workers', a module only the runtime provides.
//
// Aliasing it CANNOT work, and that is proven rather than assumed: an instrumented Vite
// resolver plugin logged every specifier it was asked to resolve — it saw
// '@cloudflare/workers-oauth-provider' and NEVER saw 'cloudflare:workers'. Scheme-prefixed
// bare specifiers are handled upstream of Vite's resolver and handed to Node's ESM loader,
// which rejects the protocol. alias / resolveId / ssr.noExternal / server.deps.inline were
// all tried. Nothing downstream can intercept what never arrives.
//
// WHY THIS DOES NOT LOOK LIKE THE DOCUMENTED SHAPE
//
// The published docs say `defineWorkersConfig` from '@cloudflare/vitest-pool-workers/config'.
// That export does not exist in 0.20.2 — the API changed in 0.13.0 ("Support Vitest 4",
// workers-sdk#11632) and the helper was replaced by a Vite PLUGIN, `cloudflareTest()`,
// exported from the package root. It registers the pool through Vitest 4's new
// `configureVitest` hook:
//
//     configureVitest(context) {
//       context.project.config.poolRunner = cloudflarePool(options)
//       context.project.config.pool = 'cloudflare-pool'
//     }
//
// which is also why `test.pool = '@cloudflare/vitest-pool-workers'` fails with
// "Runner ... is not supported" — v4 no longer resolves third-party pools by package name.
//
// Verified on disk, not from docs: `cloudflareTest` and `cloudflarePool` are both live
// exports of the package root, and `configureVitest` appears in dist/pool/index.mjs.
//
// NOTE: `singleWorker` and `isolatedStorage` were REMOVED in the same change. They are
// stripped silently by the options schema rather than erroring, so passing them looks like
// it works and does nothing. Use `--max-workers=1 --no-isolate` if isolation matters.

import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-06-01',
        compatibilityFlags: ['nodejs_compat'],
        // mupot#919 — a scratch D1 binding, unused by src/index.ts and not backed by this
        // repo's migrations. It exists solely so tests/composition/d1-batch-visibility.test.ts
        // can exercise the OFFICIAL LOCAL workerd/Miniflare D1 simulator (NOT remote,
        // deployed D1 — see the header of d1-batch-visibility.test.ts) via `cloudflare:test`'s
        // `env`, as opposed to tests/helpers/sqlite-d1.ts (a hand-rolled node:sqlite stand-in
        // that #916/#943 already found is MORE transactional than the platform it models).
        // This is the closest thing to production D1 available without live Cloudflare
        // credentials — same D1 implementation class Wrangler/Miniflare ship, not a shim.
        d1Databases: { D1_BATCH_PROBE: 'd1-batch-probe' },
      },
    }),
  ],
  test: {
    include: ['tests/composition/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
