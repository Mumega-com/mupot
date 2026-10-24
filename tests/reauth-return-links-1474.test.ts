// #1474 — every "Confirm it is you first" link must carry ?return= so a re-auth lands the member back on the page they
// were on (not on "/"), keeping the click inside the five-minute window. Scans the dashboard sources as raw text.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, '..', 'src', 'dashboard')

describe('#1474 reauth links carry a return path', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))
  it('no dashboard source links to a bare /auth/reauth', () => {
    const bare: string[] = []
    for (const f of files) {
      readFileSync(join(DIR, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\/auth\/reauth(?![?A-Za-z0-9_/-])/.test(line)) bare.push(`${f}:${i + 1}`)
      })
    }
    expect(bare).toEqual([])
  })
  it('the expected pages are pinned to their own path (list pinned outside the scan)', () => {
    const want: Array<[string, string]> = [
      ['board-cleanup.ts', '/auth/reauth?return=/board/cleanup'],
      ['account.ts', '/auth/reauth?return=/account'],
      ['connections.ts', '/auth/reauth?return=/connections'],
      ['operators.ts', '/auth/reauth?return=/operators'],
      ['doorbells.ts', '/auth/reauth?return=/doorbells'],
      ['elevation.ts', '/auth/reauth?return=/elevation/'],
      ['index.ts', '/auth/reauth?return=/agents/'],
    ]
    for (const [f, needle] of want) expect(readFileSync(join(DIR, f), 'utf8')).toContain(needle)
  })
})
