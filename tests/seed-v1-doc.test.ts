// tests/seed-v1-doc.test.ts — the contract doc must not drift from the validator constants,
// in EITHER direction. Parses the "Enums and limits" table of docs/architecture/seed-v1.md.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SEED_CAPS, SEED_DATA_TIERS, SEED_DEPLOY_VIA, SEED_KINDS, SEED_MAX_LIST, SEED_MAX_SEATS,
  SEED_REQUEST_KINDS, SEED_RISK_CLASSES, SEED_ROUTINE_APPROVALS, SEED_SEAT_CAPABILITIES, SEED_SURFACE_MODES,
} from '../src/seeds/contract'

const doc = readFileSync(join(__dirname, '..', 'docs', 'architecture', 'seed-v1.md'), 'utf8')
const section = doc.split('## Enums and limits')[1]?.split('\n## ')[0] ?? ''
const row = (label: string): string => {
  const line = section.split('\n').find((l) => l.startsWith(`| ${label} |`))
  if (!line) throw new Error(`doc row missing: ${label}`)
  return line.split('|')[2] ?? ''
}
// Enum members are the backticked tokens before any parenthetical note.
const members = (label: string): string[] => [...(row(label).split(' (')[0].matchAll(/`([^`]+)`/g))].map((m) => m[1]).sort()
const num = (cell: string): number => Number(/at most (\d+)/.exec(cell)?.[1])

describe('seed-v1 doc enums equal the validator constants exactly', () => {
  it.each([
    ['`kind`', SEED_KINDS],
    ['`deploy.via`', SEED_DEPLOY_VIA],
    ['`surfaces[].mode`', SEED_SURFACE_MODES],
    ['`data[].tier`', SEED_DATA_TIERS],
    ['`risk.class`', SEED_RISK_CLASSES],
    ['`wants.seats.capability`', SEED_SEAT_CAPABILITIES],
    ['`wants.routines[].approval`', SEED_ROUTINE_APPROVALS],
  ] as const)('%s', (label, constant) => {
    expect(members(label)).toEqual([...constant].sort())
  })
  it('seat max and list length', () => {
    expect(/1 to (\d+)/.exec(row('`wants.seats.max`'))?.[1]).toBe(String(SEED_MAX_SEATS))
    expect(num(row('List length'))).toBe(SEED_MAX_LIST)
  })
})

describe('seed-v1 doc caps equal SEED_CAPS', () => {
  it.each([
    ['`name`', SEED_CAPS.name], ['`goal`', SEED_CAPS.goal], ['`owner`', SEED_CAPS.owner],
    ['`repo`, `live`, `deploy.cmd`', SEED_CAPS.repo], ['`deploy.receipt`', SEED_CAPS.receipt],
    ['`surfaces[].path`', SEED_CAPS.surfacePath], ['`surfaces[].type`', SEED_CAPS.surfaceType],
    ['`data[].store`', SEED_CAPS.dataStore], ['`tools[].mcp`, `tools[].openapi`', SEED_CAPS.tool],
    ['`wants.gates[].action`, `wants.gates[].gate`', SEED_CAPS.gateField],
    ['`wants.routines[].id`', SEED_CAPS.routineId], ['String list items', SEED_CAPS.listItem],
    ['`wants.routines[].cron`', SEED_CAPS.cron],
  ] as const)('%s', (label, cap) => expect(num(row(label))).toBe(cap))
  it('grouped caps share one constant', () => {
    expect(SEED_CAPS.repo).toBe(SEED_CAPS.live)
    expect(SEED_CAPS.repo).toBe(SEED_CAPS.cmd)
  })
  it('documents cron format, squad slug, character bans and the canonical text rule', () => {
    expect(row('`wants.routines[].cron`')).toMatch(/five/)
    expect(row('`wants.seats.squad`')).toMatch(/slug/)
    const bans = row('Any text value or key')
    for (const needle of ['Cc', 'Cf', 'C1', 'U+2028', 'U+2029', 'U+061C', 'zero-width', 'bidirectional', 'tag characters']) expect(bans).toContain(needle)
    expect(section).toMatch(/NFC/)
    expect(section).toMatch(/leading whitespace is NOT trimmed/)
  })
  it('documents the request shape in the tool section', () => {
    expect(doc).toContain('{key, kind, fields, needs, text}')
  })
})

describe('attach protocol step 4 lists exactly the SeedRequest kinds', () => {
  it('doc request list equals SEED_REQUEST_KINDS', () => {
    const line = doc.split('\n').find((l) => l.startsWith('| 4 |')) ?? ''
    const inner = /\(([^)]*)\)/.exec(line)?.[1] ?? ''
    const norm = (w: string) => w.trim().toLowerCase().replace(/ /g, '_').replace(/s$/, '')
    expect(inner.split(',').map(norm).sort()).toEqual(SEED_REQUEST_KINDS.map(norm).sort())
  })
})
