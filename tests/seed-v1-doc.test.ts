// tests/seed-v1-doc.test.ts — the contract doc must not drift from the validator constants.
// Parses the "Enums and limits" table of docs/architecture/seed-v1.md.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SEED_CAPS, SEED_MAX_LIST, SEED_MAX_SEATS, SEED_ROUTINE_APPROVALS, SEED_SEAT_CAPABILITIES,
} from '../src/seeds/contract'

const doc = readFileSync(join(__dirname, '..', 'docs', 'architecture', 'seed-v1.md'), 'utf8')
const section = doc.split('## Enums and limits')[1]?.split('\n## ')[0] ?? ''
const row = (label: string): string => {
  const line = section.split('\n').find((l) => l.startsWith(`| ${label}`))
  if (!line) throw new Error(`doc row missing: ${label}`)
  return line.split('|')[2] ?? ''
}
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])
const num = (cell: string): number => Number(/at most (\d+)/.exec(cell)?.[1])

describe('seed-v1 doc matches validator constants', () => {
  it('seat capability enum', () => {
    expect(ticks(row('`wants.seats.capability`')).slice(0, SEED_SEAT_CAPABILITIES.length)).toEqual([...SEED_SEAT_CAPABILITIES])
  })
  it('routine approval enum', () => {
    expect(ticks(row('`wants.routines[].approval`')).slice(0, SEED_ROUTINE_APPROVALS.length)).toEqual([...SEED_ROUTINE_APPROVALS])
  })
  it('seat max', () => expect(/1 to (\d+)/.exec(row('`wants.seats.max`'))?.[1]).toBe(String(SEED_MAX_SEATS)))
  it('list length', () => expect(num(row('List length'))).toBe(SEED_MAX_LIST))
  it('field caps', () => {
    expect(num(row('`name`'))).toBe(SEED_CAPS.name)
    expect(num(row('`goal`'))).toBe(SEED_CAPS.goal)
    expect(num(row('`repo`, `live`, `deploy.cmd`'))).toBe(SEED_CAPS.repo)
    expect(SEED_CAPS.repo).toBe(SEED_CAPS.live)
    expect(SEED_CAPS.repo).toBe(SEED_CAPS.cmd)
    expect(num(row('`wants.routines[].cron`'))).toBe(SEED_CAPS.cron)
  })
  it('documents cron format, squad slug and the control-character ban', () => {
    expect(row('`wants.routines[].cron`')).toMatch(/five/)
    expect(row('`wants.seats.squad`')).toMatch(/slug/)
    expect(row('Any text value')).toMatch(/control characters/)
  })
})
