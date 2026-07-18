import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationsDir = join(import.meta.dirname, '..', 'migrations')

describe('remote D1 migration compatibility', () => {
  it('does not put RAISE inside a SELECT CASE expression', () => {
    const incompatible: string[] = []

    for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      if (/SELECT\s+CASE\s+WHEN[\s\S]*?THEN\s+RAISE\s*\(/i.test(sql)) incompatible.push(file)
    }

    expect(incompatible, 'Cloudflare D1 remote queries reject this trigger form as incomplete input').toEqual([])
  })
})
