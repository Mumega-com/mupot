// tests/capability-readers-enforced.test.ts — migration 0228.
//
// THE PREDICATE IS NOT THE HARD PART. THE CENSUS IS.
//
// `capabilities` is read 43 times across 25 files. A first cut of 0228 applied
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
import ts from 'typescript'
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

interface Literal { text: string; line: number; fnText: string }

/** Every string / template literal in a file, taken from the TypeScript AST.
 *
 *  The first version of this census tokenised with a regex. A single unbalanced
 *  backtick in a COMMENT (`scope_id` in prose) flips the pairing parity for the
 *  rest of the file, and it silently stopped seeing every query after line ~1130
 *  of src/auth/capability.ts — including the four `EXISTS (SELECT 1 FROM
 *  capabilities c ...)` fragments that decide the grant rank ceiling. The AST has
 *  no such failure: comments are trivia, and a template with substitutions is one
 *  node. Nested templates are NOT descended into; their text is part of the parent
 *  literal, which is what a reader of the query sees. */
function literalsOf(file: string, src: string): Literal[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const out: Literal[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      // The nearest enclosing function-like body (or the whole file): the unit a write's
      // revoke context must live in. A per-FILE check passes when ANY writer in the file
      // has one, which is how a dropped or swapped context survived.
      let fn: ts.Node = sf
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isFunctionLike(up)) { fn = up; break }
      }
      out.push({
        text: node.getText(sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        fnText: fn.getText(sf),
      })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function fingerprint(sql: string): string {
  return createHash('sha256').update(sql.split(/\s+/).filter(Boolean).join(' ')).digest('hex').slice(0, 12)
}

/** Reads that must NOT filter on expiry, each with the reason. Pinned to the
 *  query, never the file — a file is not the unit of authority, a query is. */
const NON_AUTHORIZING_READS: ReadonlyArray<{ fingerprint: string; why: string }> = [
  {
    fingerprint: 'aa4c890eaf7d',
    why: "auth/grant-events capabilityReviewedEvents — snapshots the row being reviewed into grant_events. A history write must record the stored row whether or not it has lapsed.",
  },
  {
    fingerprint: 'fb3ba028cbd1',
    why: "hygiene/archive archive-squad UPDATE guard — refuses to archive a squad that still has grant rows on it. A lapsed row is still a row the archive would orphan; counting it only makes the refusal more conservative until the sweeper removes it. Not an access decision.",
  },
  {
    fingerprint: 'b3f8b54f22cf',
    why: "members/index acceptInvite existing-member INSERT — the `NOT EXISTS (SELECT … FROM capabilities …)` is the UNIQUE(member_id, scope_type, scope_id) guard of the INSERT it sits in. Filtering it would hide a lapsed row and the INSERT would collide. The AUTHORITY check in the same statement (inviter rank) goes through currentMemberRankAtLeastSql, which is predicate-filtered and pinned by tests.",
  },
  {
    fingerprint: 'f5623e35078b',
    why: "members/index acceptInvite (existing-member path) prior-grant read — ROW EXISTENCE for a UNIQUE(member_id, scope_type, scope_id) insert that follows. Filtering would hide a lapsed row and the INSERT would collide. Follow-up: a lapsed row currently blocks redemption of an invite on that scope until the sweeper (next PR) removes it.",
  },
  {
    fingerprint: '0a38e13368bb',
    why: "members/index acceptInvite race read — after a 0-row batch, asks whether a grant row exists to name the refusal (member_already_holds_grant). Existence for an error message, not an authority decision.",
  },
  {
    fingerprint: 'ad9b6465d248',
    why: "dashboard/agent-access-panel capRow() — the compare-and-swap leaf of the Access receipt guard: 'this table still holds the level the admin SAW'. The admin saw stored rows (the panel lists lapsed grants on purpose), so the CAS must compare stored state. Filtering it would make a lapsed grant impossible to revoke from the panel (stale_state forever).",
  },
  {
    fingerprint: 'fed0e2b19dc5',
    why: "dashboard/agent-access-panel currentCapability() — the same CAS read in JS (live vs the admin's expectedCapability). Same reason: it must see the stored row the admin saw. The AUTHORITY facts in that guard (actor rank, target ceiling) are all predicate-filtered.",
  },
  {
    fingerprint: '331e3525c7f4',
    why: "dashboard/agent-access-panel list read — renders the per-squad access table for an org admin. It is the ONE surface meant to show lapsed grants (an operator who cannot see that a grant lapsed cannot reason about why an agent stopped working, and cannot clear it). Display only; grants nothing.",
  },
  {
    fingerprint: 'fb86df533fec',
    why: "fleet/presence home-squad exclusion — hides a member from the PRESENCE roster when they hold ANY grant on a home squad. Unfiltered is the fail-safe direction: a lapsed home grant hides one more person, never exposes one. Privacy filter, not an authority decision.",
  },
  {
    fingerprint: 'cc8e31edbba5',
    why: "hygiene/archive squadActiveDependentCounts — counts stored grant rows that would be orphaned by archiving a squad. A lapsed row is still a row the archive would leave behind; counting it only makes the refusal more conservative until the sweeper removes it. Not an access decision.",
  },
  {
    fingerprint: 'bba397cbb56b',
    why: "members/agent-connection-status — LEFT JOIN for a status panel. Renders member_capability for display; grants nothing.",
  },
  {
    fingerprint: 'd94e0e854788',
    why: "bootstrap-self founder-grant pre-check — asks about ROW EXISTENCE, not authority. Its own comment records that an unconditional INSERT once threw UNIQUE inside the atomic batch and every retry failed identically. Filtering it hides an EXPIRED row, the INSERT (no ON CONFLICT) collides, and the comment's 'a retry now sees the row and succeeds' escape becomes false — a permanent bootstrap lockout. A gate reproduced exactly that.",
  },
  {
    fingerprint: 'eea2db16ab03',
    why: "members/service loadAgentTokenReplacementMetadata — reads binding_capability to describe a completed token rotation in a receipt. A historical description of a past act, not an authorization decision about a present one.",
  },
  {
    fingerprint: 'a3f8d2b395f7',
    why: "onboarding/doors selfGrant prior-row read — reads the PRIOR grant before writing, to reuse its id and record capability_before. Its own comment: 'This is the only moment it is knowable.' Filtering would MISS an expired row and insert a duplicate, violating UNIQUE(member_id, scope_type, scope_id). Row identity, not authority.",
  },
  {
    fingerprint: 'ad047cbef9cb',
    why: "onboarding/doors grantSignupDefault — refuses to clobber ANY existing org row, expired or not ('Never clobber access someone already has, however they got it'). Filtering would silently overwrite a lapsed grant's row and its provenance.",
  },
  {
    fingerprint: '5bb8aa058a26',
    why: "org/service findExistingHomeSquad — adopts a member's own home squad by the member's grant row as proof of provenance. Row identity: filtering would fail to find a home whose grant lapsed and provision a SECOND home squad for the same member.",
  },
  {
    fingerprint: 'f221ab81586e',
    why: "org/service findMemberCapabilityOnSquad — detects the 'squad exists but this member's own grant row is missing' repair case. Row existence: a lapsed row exists, and a repair INSERT over it would collide on UNIQUE.",
  },
  {
    fingerprint: '497533d79c6a',
    why: "org/service listMoveGrantImpact — lists what a squad move REMOVES, for the receipt. The move's DELETE removes the stored row whether or not it had lapsed, so the impact list must too.",
  },
  {
    fingerprint: '09946cbda392',
    why: "org/service moveAgentSquad read-back — verifies the destination grant LANDED after the batch. A write receipt must see the row it wrote regardless of its horizon.",
  },
  {
    fingerprint: 'fbd7eb240eba',
    why: "org/team-bootstrap listSquadCapabilityHolders — informational detail in a squad_slug_taken refusal; its own header says holding a capability no longer factors into the adoptability decision.",
  },
  {
    fingerprint: '97e88a0a9665',
    why: "pots/service full-seed identity probe — owner_count answers 'was this pot already seeded' for an idempotent provisioning re-run. Row existence, run against a freshly provisioned pot DB; an expiry never applies to the seed owner row.",
  },
]

const READ_RE = /(?:FROM|JOIN)\s+(?:\w+\.)?capabilities\b/gi

interface Read { file: string; line: number; fp: string; sql: string; reads: number; live: number; orJoined: boolean }

function reads(): Read[] {
  const out: Read[] = []
  for (const file of tsFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('capabilities')) continue
    for (const lit of literalsOf(file, src)) {
      // Writes are classified too. A guarded write (`UPDATE tasks ... WHERE EXISTS
      // (SELECT 1 FROM capabilities ...)`, `INSERT ... SELECT ... WHERE EXISTS (...)`)
      // re-asserts AUTHORITY at write time, which is exactly where an expired grant
      // must not count. Only the write's own target (`INSERT INTO capabilities`,
      // `DELETE FROM capabilities`) is not a read; READ_RE below matches FROM/JOIN, and
      // `DELETE FROM capabilities` is filtered here.
      if (/^[`'"]\s*DELETE\s+FROM\s+capabilities\b/i.test(lit.text)) continue
      const reads = (lit.text.match(READ_RE) ?? []).length
      if (reads === 0) continue
      out.push({
        file: file.slice(file.indexOf('src/')),
        line: lit.line,
        fp: fingerprint(lit.text),
        sql: lit.text.split(/\s+/).filter(Boolean).join(' ').slice(0, 120),
        reads,
        // One predicate per read. A literal that reads capabilities twice and
        // filters one of them is half-enforced.
        live: (lit.text.match(/CAPABILITY_LIVE_PREDICATE\(/g) ?? []).length,
        // PRESENCE IS NOT ENFORCEMENT: `... OR ${CAPABILITY_LIVE_PREDICATE(...)}` is
        // satisfied by the other arm and enforces nothing. A gate neutered the
        // first version of this census exactly that way.
        orJoined: /\bOR\s*\$\{CAPABILITY_LIVE_PREDICATE\(/i.test(lit.text),
      })
    }
  }
  return out
}

describe('every capabilities reader consumes the liveness predicate', () => {
  it('the walker actually finds the readers (anti-vacuity)', () => {
    const all = reads()
    expect(all.length).toBeGreaterThanOrEqual(40)
    // The files the regex tokeniser went blind in must be seen.
    const capabilityTs = all.filter((r) => r.file === 'src/auth/capability.ts')
    expect(capabilityTs.length).toBeGreaterThanOrEqual(5)
  })

  it('the predicate refuses an anonymous `?` now (it names now twice and would misalign binds)', () => {
    expect(() => CAPABILITY_LIVE_PREDICATE('c', '?')).toThrow(/numbered/)
    expect(CAPABILITY_LIVE_PREDICATE('c', '?7')).toContain('?7')
    expect(CAPABILITY_LIVE_PREDICATE('c', "datetime('now')")).toContain("datetime('now')")
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
      for (const lit of literalsOf(file, src)) {
        if (!/\bFROM\b/i.test(lit.text)) continue
        // a comma-join names a table then an alias: `, capabilities c`
        // `capabilities` is also a COLUMN on agents, so a column list ending
        // `, capabilities FROM agents` looks identical to a comma-join followed
        // by an alias. A real alias is never a SQL keyword.
        if (/,\s*(?:\w+\.)?capabilities\s+(?!(?:FROM|WHERE|ORDER|GROUP|LIMIT|UNION|JOIN|ON|AND|OR|IN|AS)\b)\w+/i.test(lit.text)) {
          offenders.push(`${file.slice(file.indexOf('src/'))}: ${lit.text.trim().slice(0, 80)}…`)
        }
      }
    }
    expect(offenders, 'use an explicit JOIN so the census can see this read').toEqual([])
  })

  it('EVERY capabilities read consumes the predicate (once per read, AND-joined) or is fingerprint-exempt', () => {
    const exempt = new Map(NON_AUTHORIZING_READS.map((e) => [e.fingerprint, e.why]))
    const offenders = reads()
      .filter((r) => (r.live < r.reads || r.orJoined) && !exempt.has(r.fp))
      .map((r) => `${r.file}:${r.line} [${r.fp}] reads=${r.reads} live=${r.live}${r.orJoined ? ' OR-JOINED' : ''}`)
    expect(offenders, `${offenders.length} capabilities reads do not gate on expiry`).toEqual([])
  })

  it('every exemption still matches a real read (no stale fingerprints hiding a future one)', () => {
    const seen = new Set(reads().map((r) => r.fp))
    const stale = NON_AUTHORIZING_READS.filter((e) => !seen.has(e.fingerprint)).map((e) => e.fingerprint)
    expect(stale).toEqual([])
  })
})

// ── writers ────────────────────────────────────────────────────────────────────
//
// The reader census keeps an expired grant dead everywhere it is read. This is its
// twin for the audit half (migration 0228): every statement that CREATES a grant
// must say who granted it and through which surface, and every DELETE must be
// attributable. History itself is written by trigger, so a writer cannot forget the
// EVENT — but it can still forget the PROVENANCE the event is built from.

interface Write { file: string; line: number; kind: 'insert' | 'update' | 'delete'; text: string; fp: string; fnText: string }

function writes(): Write[] {
  const out: Write[] = []
  for (const file of tsFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf8')
    if (!src.includes('capabilities')) continue
    for (const lit of literalsOf(file, src)) {
      const m = /^[`'"]\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+capabilities\b/i.exec(lit.text)
      if (!m) continue
      const head = (m[1] ?? '').toUpperCase()
      out.push({
        file: file.slice(file.indexOf('src/')),
        line: lit.line,
        kind: head.startsWith('INSERT') ? 'insert' : head.startsWith('UPDATE') ? 'update' : 'delete',
        text: lit.text,
        fp: fingerprint(lit.text),
        fnText: lit.fnText,
      })
    }
  }
  return out
}

/** Writers that legitimately carry no provenance, each with the reason. By fingerprint. */
const PROVENANCE_EXEMPT: ReadonlyArray<{ fingerprint: string; why: string }> = [
  {
    fingerprint: '8a84024b1364',
    why: "onboarding/doors applyDisposition(crystallized) — clears provisional_door_id only. It changes no capability, expiry or attribution; the human review decision is recorded as an explicit 'reviewed' grant_events row written in the same batch.",
  },
]

describe('every capabilities writer records provenance', () => {
  it('the walker finds the writers (anti-vacuity)', () => {
    expect(writes().length).toBeGreaterThanOrEqual(20)
  })

  it('every INSERT and re-attributing UPDATE names granted_via', () => {
    const exempt = new Set(PROVENANCE_EXEMPT.map((e) => e.fingerprint))
    const offenders = writes()
      .filter((w) => {
        if (w.kind === 'delete' || exempt.has(w.fp)) return false
        // An INSERT must name the column in ITS COLUMN LIST — a mention in the
        // ON CONFLICT clause alone would leave a fresh row unattributed.
        const scoped = w.kind === 'insert' ? w.text.split(/\b(?:VALUES|SELECT)\b/i)[0] ?? '' : w.text
        return !/\bgranted_via\b/.test(scoped)
      })
      .map((w) => `${w.file}:${w.line} [${w.fp}] ${w.kind}`)
    expect(offenders).toEqual([])
  })

  it('every DELETE is bracketed by a revoke context in its OWN function: set before, clear after', () => {
    const exempt = new Set(PROVENANCE_EXEMPT.map((e) => e.fingerprint))
    const offenders: string[] = []
    for (const w of writes()) {
      if (w.kind !== 'delete' || exempt.has(w.fp)) continue
      const m = /const \[(\w+), (\w+)\] = revokeContextStatements\(/.exec(w.fnText)
      if (!m) { offenders.push(`${w.file}:${w.line} [${w.fp}] no revokeContextStatements destructure in the enclosing function`); continue }
      const setName = m[1] ?? ''
      const clearName = m[2] ?? ''
      const uses = (name: string): number => (w.fnText.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      // declaration + at least one use each, and the clear is placed AFTER the set in the batch
      if (uses(setName) < 2 || uses(clearName) < 2 || w.fnText.lastIndexOf(setName) > w.fnText.lastIndexOf(clearName)) {
        offenders.push(`${w.file}:${w.line} [${w.fp}] revoke context not placed set->clear around the DELETE`)
      }
    }
    expect(offenders).toEqual([])
  })
})
