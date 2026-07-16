import { defineConfig, configDefaults } from 'vitest/config'

// fleet-runtime/ is the sterile, forkable HOST runtime — plain Node ESM with its own
// `node --test` suite (no vitest dependency, so a forker can run it standalone). Exclude it
// from the pot's vitest run so vitest doesn't try to load its node:test files (which it
// reports as "No test suite found"). The rest of the default discovery is preserved.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'fleet-runtime/**'],
    testTimeout: 15_000,
  },
})
