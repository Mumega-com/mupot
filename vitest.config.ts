import { defineConfig, configDefaults } from 'vitest/config'

// fleet-runtime/ is the sterile, forkable HOST runtime — plain Node ESM with its own
// `node --test` suite (no vitest dependency, so a forker can run it standalone). Exclude it
// from the pot's vitest run so vitest doesn't try to load its node:test files (which it
// reports as "No test suite found"). The rest of the default discovery is preserved.
// `**/*.test.mjs` is the same situation, and is excluded AS A CLASS rather than file by
// file. Every one of them gates part of the toolchain (the dependency audit, the schema
// ratchet, the migration-numbering guard) and is deliberately written against node:test with
// zero test-framework dependency, so it still runs when the toolchain itself is what is
// broken. CI runs each via `node --test`. Naming them individually was a list that had to be
// appended to every time — and the third append is the signal the rule, not the list, was
// the thing to write down. Verified at the time of the change: no `.test.mjs` in this repo
// imports vitest.
//
// The hole this opens, and where it is closed: a NEW tests/*.test.mjs that nobody wires to a
// `node --test` step now runs NOWHERE, silently. tests/migration-numbering.test.mjs asserts
// that every tests/*.test.mjs appears in .github/workflows/ci.yml, so that hole is red
// rather than quiet.
//
// tests/composition/ runs inside workerd via @cloudflare/vitest-pool-workers
// (vitest.composition.config.ts) — its `cloudflare:test` imports cannot load under the
// default Node ESM runner, so it is excluded here and CI runs it as its own step.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'fleet-runtime/**',
      '**/*.test.mjs',
      'tests/composition/**',
    ],
    testTimeout: 15_000,
  },
})
