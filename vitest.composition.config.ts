// vitest.composition.config.ts — a SECOND Vitest project, for tests that must run inside
// the real Workers runtime (mupot#704).
//
// WHY A SEPARATE CONFIG AND NOT A CHANGE TO vitest.config.ts
//
// 298 test files pass under the default Node pool today. Switching all of them to workerd
// to fix one blind spot would risk the entire suite to gain one test. So the default pool
// is untouched and composition tests opt in here. Existing behaviour cannot regress,
// because nothing existing runs through this file.
//
// WHY IT IS NEEDED AT ALL
//
// src/index.ts — the DEPLOYED composition, the Hono app wrapped in OAuthProvider — could
// not be imported by any test. It transitively pulls DurableObject / WorkerEntrypoint /
// WorkflowEntrypoint from 'cloudflare:workers', a module only the runtime provides.
//
// Aliasing it does not work, and that is PROVEN rather than assumed: an instrumented Vite
// resolver plugin logged every specifier it was asked to resolve and saw
// '@cloudflare/workers-oauth-provider' but NEVER 'cloudflare:workers'. A scheme-prefixed
// bare specifier is handled upstream of Vite's resolver and handed to Node's ESM loader,
// which rejects the protocol. Nothing downstream can intercept it.
//
// So the module has to be genuinely present, which means running in workerd.
//
// WHAT THIS BUYS
//
// GET /auth/login returned 500 in production while ~20 auth tests stayed green. Every one
// imported a SUB-APP and hand-built an env; the wrapper injects a binding named
// OAUTH_PROVIDER that a hand-built env never carries. The defect lived in the seam between
// the app and its wrapper — the one place nothing could reach.

// NOTE: pool-workers 0.20.x does NOT export './config' (that was the older API surface —
// `defineWorkersConfig` lived there). This version is wired by pointing `pool` at the
// package root and passing poolOptions.workers directly, which is what the helper did.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: '@cloudflare/vitest-pool-workers',
    include: ['tests/composition/**/*.test.ts'],
    testTimeout: 20_000,
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityDate: '2026-06-01',
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
})
