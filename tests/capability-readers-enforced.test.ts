// tests/capability-readers-enforced.test.ts — migration 0149.
//
// THE PREDICATE IS NOT THE HARD PART. THE CENSUS IS.
//
// `capabilities` is read 43 times across 25 files. A first cut of 0149 applied
// the liveness predicate to exactly ONE of them (resolveCapabilities) and an
// adversarial pass blocked it, correctly: the moment a writer existed, an
// expired grant would be dead in one reader and fully alive in forty-two — and
// the surface that DISPLAYS "expired" would disagree with every surface that
// ENFORCES. That is worse than no expiry at all, because it looks fixed.
//
// So this file is the guard that makes the census enforceable rather than
// one-time. Every read of the table must either consume CAPABILITY_LIVE_PREDICATE
// or be exempted BY QUERY FINGERPRINT with a stated reason. A 44th reader added
// tomorrow fails this test until someone classifies it.
//
// Same discipline, and the same reason, as the member_tokens guard in
// tests/token-lifecycle-real-schema.test.ts. That one was FIRST written against
// a hardcoded file list and let two live bypass doors through; then against
// whole-FILE exemptions and let a bearer lookup appended to an exempt file
// through. Fingerprints are where that argument ended, so this starts there.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CAPABILITY_LIVE_PREDICATE } from '../src/auth/capability'

const SRC_DIR = join(__dirname, '..', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    // Only the GENERATED file is skipped — `schema-chain.ts` is real source.
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts')) out.push(full)
  }
  return out
}

/** String literals in any of TypeScript's three quote forms. */
function stringLiterals(src: string): string[] {
  const re = /`([^`\\]*(?:\\[\s\S][^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

function fingerprint(sql: string): string {
  return createHash('sha256').update(sql.split(/\s+/).filter(Boolean).join(' ')).digest('hex').slice(0, 12)
}

/** Reads that must NOT filter on expiry, each with the reason. Pinned to the
 *  query, never the file — a file is not the unit of authority, a query is. */
const NON_AUTHORIZING_READS: ReadonlyArray<{ fingerprint: string; why: string }> = [
  {
    fingerprint: '5c3990573907',
    why: "onboarding/doors.ts — reads the PRIOR grant row before writing, to reuse its id. Its own comment: 'Read the prior grant BEFORE writing. This is the only moment it is knowable.' Filtering expiry here would MISS an expired row and insert a duplicate, violating UNIQUE(member_id, scope_type, scope_id). This read is about row identity, not authority.",
  },
  {
    fingerprint: 'b308c248293c',
    why: "bootstrap-self founder-grant pre-check — asks about ROW EXISTENCE, not authority, exactly like the doors.ts reads. Its own comment records that an unconditional INSERT once threw UNIQUE inside the atomic batch and every retry failed identically. Filtering it hides an EXPIRED row, the INSERT (no ON CONFLICT) collides, and the comment's 'a retry now sees the row and succeeds' escape becomes false — a permanent bootstrap lockout. I filtered it once and a gate reproduced exactly that.",
  },
  {
    fingerprint: '085f85ef3659',
    why: "agent-connection-status — LEFT JOIN for a status panel. Renders member_capability for display; grants nothing. Same classification as the other status read in that file.",
  },
  {
    fingerprint: '91112a9eb905',
    why: "members/service token-rotation handoff metadata — reads binding_capability to describe a completed rotation in a receipt. Historical description of a past act, not an authorization decision about a present one.",
  },
  {
    fingerprint: '6132983cd114',
    why: "sweepExpiredCapabilities — the sweep's entire job is to FIND lapsed grants, so it selects on `expires_at <= now`, the exact inverse of the liveness predicate. Applying the predicate here would make it return nothing, forever, silently. This is the one read whose correctness requires seeing expired rows.",
  },
  {
    fingerprint: '89571898c6e3',
    why: "dashboard/index.ts loadGrants — feeds divisionsAdminBody and the members console for RENDERING, never an authorization decision (verified at :1768 and :1795). It must show EXPIRED grants: an operator who cannot see that a grant lapsed cannot reason about why an agent stopped working. Filtering here would hide exactly the state this migration exists to make visible.",
  },
  {
    fingerprint: 'a31f93752b25',
    why: "onboarding/doors.ts — the provisional-door grant refuses to clobber ANY existing row, expired or not. Its own comment: 'Never clobber access someone already has, however they got it.' Filtering would silently overwrite an expired grant's row and destroy its history.",
  },
]

describe('every capabilities reader consumes the liveness predicate', () => {
  function reads(): Array<{ file: string; line: number; sql: string; fp: string; live: boolean }> {
    const out: Array<{ file: string; line: number; sql: string; fp: string; live: boolean }> = []
    for (const file of tsFiles(SRC_DIR)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('capabilities')) continue
      for (const lit of stringLiterals(src)) {
        // FROM and JOIN, schema-qualified or not. The first version matched only
        // /FROM\s+capabilities/ and a gate drove four REAL unfiltered reads
        // through it — every one a `JOIN capabilities c ON ...`.
        //
        // A bare comma alternative is NOT included, and that is deliberate:
        // `agents` has a `capabilities` COLUMN, so `, capabilities,` appears in
        // ordinary column lists and snapshot json_object() calls all over the
        // tree. Matching it produced six false positives on first try. The
        // comma-JOIN shape is covered by its own tripwire below instead.
        if (!/(?:FROM|JOIN)\s+(?:\w+\.)?capabilities\b/i.test(lit)) continue
        // DELETE/INSERT are writes, not authorization reads.
        if (/^\s*(DELETE|INSERT)\b/i.test(lit.trim())) continue
        const idx = src.indexOf(lit)
        out.push({
          file: file.slice(file.indexOf('src/')),
          line: idx >= 0 ? src.slice(0, idx).split('\n').length : 0,
          sql: lit.split(/\s+/).filter(Boolean).join(' ').slice(0, 120),
          fp: fingerprint(lit),
          // PRESENCE IS NOT ENFORCEMENT. The first version asserted only that
          // the substring appeared, so a gate neutered it with
          // `(capability = 'owner' OR ${CAPABILITY_LIVE_PREDICATE(...)})` and the
          // census still reported the read as compliant. The predicate has to be
          // AND-joined to count: require `AND ${CAPABILITY_LIVE_PREDICATE`, and
          // refuse any occurrence preceded by OR.
          // The predicate must be present AND conjunctive. `WHERE ${p} AND ...`
          // and `... AND ${p}` both count; `... OR ${p}` does not, because an
          // OR-joined liveness check is satisfied by the other arm and enforces
          // nothing. A gate neutered the first version exactly that way and the
          // census still called the read compliant.
          live:
            lit.includes('CAPABILITY_LIVE_PREDICATE(')
            && !/\bOR\s*\$\{CAPABILITY_LIVE_PREDICATE\(/i.test(lit),
        })
      }
    }
    return out
  }

  it('the walker actually finds the readers (anti-vacuity)', () => {
    expect(reads().length).toBeGreaterThanOrEqual(25)
  })

  it('the predicate keeps both load-bearing halves', () => {
    const p = CAPABILITY_LIVE_PREDICATE('c', '?2')
    expect(p).toContain('c.expires_at IS NULL')  // non-expiring arm
    expect(p).toContain('julianday')             // not a text compare
  })

  it('no comma-JOIN over capabilities exists — the walker would not see one', () => {
    // `FROM members m, capabilities c` is a legal join the FROM/JOIN matcher
    // above cannot see, and it cannot be added to that matcher without also
    // matching every column list containing the word `capabilities` (the agents
    // table has such a column). So it gets a tripwire: none exist today, and if
    // someone writes one this fails and asks them to use an explicit JOIN.
    const offenders: string[] = []
    for (const file of tsFiles(SRC_DIR)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('capabilities')) continue
      for (const lit of stringLiterals(src)) {
        if (!/\bFROM\b/i.test(lit)) continue
        // a comma-join names a table then an alias: `, capabilities c`
        // `capabilities` is also a COLUMN on agents, so a column list ending
        // `, capabilities FROM agents` looks identical to a comma-join followed
        // by an alias. A real alias is never a SQL keyword.
        if (/,\s*(?:\w+\.)?capabilities\s+(?!(?:FROM|WHERE|ORDER|GROUP|LIMIT|UNION|JOIN|ON|AND|OR|IN|AS)\b)\w+/i.test(lit)) {
          offenders.push(`${file.slice(file.indexOf('src/'))}: ${lit.trim().slice(0, 80)}…`)
        }
      }
    }
    expect(offenders, 'use an explicit JOIN so the census can see this read').toEqual([])
  })

  it('EVERY capabilities read consumes the predicate or is fingerprint-exempt', () => {
    const exempt = new Map(NON_AUTHORIZING_READS.map((e) => [e.fingerprint, e.why]))
    const offenders = reads()
      .filter((r) => !r.live && !exempt.has(r.fp))
      .map((r) => `${r.file}:${r.line} [${r.fp}]`)
    expect(offenders, `${offenders.length} capabilities reads do not gate on expiry`).toEqual([])
  })
})
