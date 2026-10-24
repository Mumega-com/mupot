// tests/no-replace-on-seat-tables.test.ts — ratchet: no REPLACE write against the admission / attachment / dot key tables.
//
// REPLACE deletes the conflicting row WITHOUT firing the no-delete triggers (recursive_triggers is off), which would un-revoke
// a key or rewrite an admission. Migration 0255 adds BEFORE INSERT guards as the net; this keeps the application from ever
// relying on it. Scans the raw text of src/ (SQL lives in template strings), so a statement split across lines still matches.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PROTECTED = String.raw`(?:agent_seat_\w+|agent_dot_keys)`
export const REPLACE_RE = new RegExp(String.raw`(?:INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO)\s+["'\x60\[]?${PROTECTED}\b`, 'i')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('no REPLACE against agent_seat_* / agent_dot_keys', () => {
  it('the matcher catches the spellings it must (self-test)', () => {
    for (const bad of [
      'INSERT OR REPLACE INTO agent_dot_keys (id) VALUES (1)',
      'insert  or\n  replace into agent_seat_admissions',
      'REPLACE INTO agent_seat_attachments',
      'INSERT OR REPLACE INTO "agent_dot_keys"',
      'INSERT OR REPLACE INTO agent_seat_thread_labels',
    ]) expect(REPLACE_RE.test(bad), bad).toBe(true)
    for (const ok of [
      'INSERT INTO agent_dot_keys (id) VALUES (1)',
      'INSERT OR IGNORE INTO agent_seat_admissions',
      'INSERT OR REPLACE INTO kv_cache',
      "SELECT replace(label, 'a', 'b') FROM agent_seat_thread_labels",
    ]) expect(REPLACE_RE.test(ok), ok).toBe(false)
  })

  it('src/ contains no such statement', () => {
    const offenders = walk(SRC).filter((f) => REPLACE_RE.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
