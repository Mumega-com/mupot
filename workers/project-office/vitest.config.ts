// Runs the office inside real workerd via @cloudflare/vitest-pool-workers (Vitest 4 plugin form; see the
// header of ../../vitest.composition.config.ts for why it is not defineWorkersConfig).

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

// The COMMITTED migration chain of the main repo, split into queries and handed to the workerd side as a
// binding: the office reads the real schema, never a hand-written one.
// Comment-only fragments are dropped (D1 rejects "SQL code did not contain a statement"); nothing else is touched.
const migrations = (await readD1Migrations(fileURLToPath(new URL('../../migrations', import.meta.url)))).map((m) => ({
  ...m,
  queries: m.queries.filter((q) => q.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0),
}))

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-06-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { PROJECT_OFFICE_DO: { className: 'ProjectOffice', useSQLite: true } },
        d1Databases: { DB: 'mupot-db' },
        bindings: { TEST_MIGRATIONS: migrations, PROJECT_OFFICE: '1', TENANT_SLUG: 'pot-a' },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
