import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { unstable_splitSqlQuery } from 'wrangler'

const migration = readFileSync(
  new URL('../migrations/0128_fenced_deliveries.sql', import.meta.url),
  'utf8',
)
const repairMigrationUrl = new URL(
  '../migrations/0133_source_ack_trigger_d1_compat.sql',
  import.meta.url,
)

describe('0128 fenced-delivery local D1 compatibility', () => {
  it('does not synthesize required evidence with a compound SELECT', () => {
    const trigger = unstable_splitSqlQuery(migration).find((statement) =>
      statement.includes('CREATE TRIGGER fenced_deliveries_source_ack_requires_chain'),
    )

    expect(trigger).toBeDefined()
    expect(trigger).not.toMatch(/\bUNION\s+ALL\b/i)
  })

  it('repairs databases that already recorded migration 0128', () => {
    expect(existsSync(repairMigrationUrl)).toBe(true)

    const repair = readFileSync(repairMigrationUrl, 'utf8')
    expect(repair).toContain(
      'DROP TRIGGER IF EXISTS fenced_deliveries_source_ack_requires_chain',
    )
    expect(repair).toContain(
      'CREATE TRIGGER fenced_deliveries_source_ack_requires_chain',
    )
    const repairedTrigger = unstable_splitSqlQuery(repair).find((statement) =>
      statement.includes('CREATE TRIGGER fenced_deliveries_source_ack_requires_chain'),
    )
    expect(repairedTrigger).toBeDefined()
    expect(repairedTrigger).not.toMatch(/\bUNION\s+ALL\b/i)
  })
})
