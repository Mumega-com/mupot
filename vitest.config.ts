import { defineConfig, configDefaults } from 'vitest/config'

// fleet-runtime/ is the sterile, forkable HOST runtime — plain Node ESM with its own
// `node --test` suite (no vitest dependency, so a forker can run it standalone). Exclude it
// from the pot's vitest run so vitest doesn't try to load its node:test files (which it
// reports as "No test suite found"). The rest of the default discovery is preserved.
// tests/audit-gate.test.mjs and tests/test-schema-source.test.mjs are the same situation: it gates the dependency audit and is
// deliberately written against node:test with zero test-framework dependency, so it still
// runs when the toolchain itself is what is broken. CI runs it via `node --test`.
// tests/composition/ runs inside workerd via @cloudflare/vitest-pool-workers
// (vitest.composition.config.ts) — its `cloudflare:test` imports cannot load under the
// default Node ESM runner, so it is excluded here and CI runs it as its own step.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'fleet-runtime/**',
      'tests/audit-gate.test.mjs',
      'tests/test-schema-source.test.mjs',
      'tests/composition/**',
    ],
    testTimeout: 15_000,
  },
})
