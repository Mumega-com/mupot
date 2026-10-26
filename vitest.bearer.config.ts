import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
const migrations = (await readD1Migrations('./migrations')).map(m => ({ ...m, queries: m.queries.filter(q => q.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()) }))

export default defineConfig({
  plugins: [cloudflareTest({
    main: './tests/helpers/seat-events-worker.ts',
    miniflare: {
      compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { SEAT_EVENTS: { className: 'SeatEventsDO', useSQLite: true } },
      d1Databases: { DB: 'bearer-test' },
      bindings: { TENANT_SLUG: 'test', REALTIME_SEAT_EVENTS: '1', TEST_MIGRATIONS: migrations },
    },
  })],
  test: { include: ['tests/composition/seat-events-bearer.test.ts'], testTimeout: 20_000 },
})
