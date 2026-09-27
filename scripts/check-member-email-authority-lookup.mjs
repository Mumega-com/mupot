#!/usr/bin/env node
// scripts/check-member-email-authority-lookup.mjs — a `members` row must never be resolved
// by a raw, hand-rolled email match outside the one shared identity resolver.
//
// WHY THIS EXISTS (mupot#1578, hardened mupot#1583 round 1 P1)
//
// src/projects/index.ts's memberIdFor used to run its OWN copy of "find the member by
// email": `SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'`.
// That query has no idea about mupot#1551's exclusive-control predicate
// (src/members/exclusive-control.ts, decideIdentitylessAttach) — a members row with a LIVE
// unbound bearer token or a bound Telegram chat (a "squatted" row) is exactly the shape
// decideIdentitylessAttach exists to refuse, but a raw email match finds it anyway.
//
// THE RULE
//
// A SQL string that references the `members` table (`FROM members`, `JOIN members`,
// `UPDATE members`, with or without an alias like `members m`) AND compares an `email`
// column anywhere in that SAME string (or a run of string literals concatenated with `+`)
// — `=`, `!=`, `<>`, `IN (`, `LIKE`, `IS`, `COLLATE`, on EITHER side of the operator,
// optionally wrapped in `lower()`/`upper()`/`trim()`/`instr()`, optionally alias-qualified
// like `m.email` — is authority-shaped: whatever member id it returns is one hop away from
// being handed capabilities. Every such statement must live in one of the two files that
// ARE the shared resolver (src/members/resolve-human-member.ts, the identity-first
// resolver; src/members/exclusive-control.ts, the exclusive-control predicate it calls) —
// or in a file explicitly ALLOWED below, by exact MATCH COUNT, because it was already
// using the raw pattern for a non-authority purpose before this ratchet existed.
//
// DETECTION (round 2 hardening — round 1's version missed several equivalent shapes a
// gate reviewer found live on this same PR: `email != ?`, `m.email`, `IN (`, `LIKE`, `IS`,
// `COLLATE`, the operator on the LEFT of email, and a query split across concatenated
// string literals). The scan is LITERAL-AWARE, not a blind character-count window: it
// first walks the file once to find every string/template-literal span (respecting quote
// type, backslash escapes, and `${...}` interpolation depth in template literals — see
// computeStringSpans), then groups any run of literals joined only by `+` (with nothing
// else between them) into one detection unit, so a query split across
// `'SELECT id FROM ' + 'members WHERE ' + 'email = ?'` reads as one span. Within each
// unit's own text (internal whitespace collapsed so a multi-line `WHERE` clause still
// matches), a `FROM/JOIN/UPDATE members` reference followed anywhere in the SAME unit by
// an email-column comparison is a violation. Bounding to the literal's own boundary (round
// 1 used a flat 600-character window instead) is what fixes round 1's own false positive:
// `SELECT lower(email) AS email FROM members WHERE id = ?1 LIMIT 1').bind(x).first<{
// email: string | null }>()` — a fixed-width window bled straight through the closing
// quote into the TypeScript generic on the very next line and matched "email" there; this
// version never looks past the string literal's own close.
//
// Still a raw-text scan, not a full AST: it can false-positive on a comment, or on an
// `UPDATE members SET email = ?` that WRITES the column rather than filtering by it
// (indistinguishable from a WHERE comparison by regex alone) — the fix for either is an
// explicit allowlist entry with a reason, never widening the detector to "be smarter"
// about intent it cannot see.
//
// SCANS RAW TEXT (same convention as this repo's other ratchets — see
// reference_mupot_ci_ratchets_scan_raw_text.md).
//
// ON THE ALLOWLIST — PER-FILE MATCH COUNT, not mere presence (round 2 hardening; round 1's
// version only tracked "does this file contain the pattern at all", so a file could
// accumulate new violations forever once listed once). scripts/member-email-authority-
// lookup-allowlist.json maps `{ "path/to/file.ts": <exact count> }`. A file's actual match
// count must equal its allowlist entry EXACTLY — higher (new violation added) or lower
// (fixed but not removed from the list, a stale exemption) both fail this run. Comparing
// against the merge target (origin/main): a file's count may never be GREATER than that
// same file's count on the target — this is a PER-FILE comparison, not a sum, so moving
// matches from one already-clean file into a different file ("swapping files") fails even
// though the total count is unchanged. A missing or unparsable allowlist file is a hard
// FAILURE, never a silent bootstrap to "no exemptions needed" — see loadAllowlist().
//
// The two canonical files (exclusive-control.ts, resolve-human-member.ts) are hardcoded
// ALWAYS-allowed, never counted against the allowlist at all — they are the resolver this
// ratchet exists to funnel every other site through.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'member-email-authority-lookup-allowlist.json')
const ALLOWLIST_REL = 'scripts/member-email-authority-lookup-allowlist.json'

const CANONICAL_FILES = new Set([
  'src/members/exclusive-control.ts',
  'src/members/resolve-human-member.ts',
])

const MEMBERS_REF_RE = /\b(?:FROM|JOIN|UPDATE)\s+members\b/gi
const EMAIL_TOKEN = String.raw`\b(?:(?:lower|upper|trim|instr)\s*\(\s*)*(?:\w+\.)?email\b`
const OP = String.raw`(?:=|!=|<>|<|>|\bIS\b|\bLIKE\b|\bIN\s*\(|\bCOLLATE\b)`
// How far an operator may sit from the email token (either direction) inside one
// detection unit's (already whitespace-collapsed) text.
const OP_PROXIMITY = 40
const EMAIL_COMPARISON_RE = new RegExp(
  `${EMAIL_TOKEN}.{0,${OP_PROXIMITY}}?${OP}|${OP}.{0,${OP_PROXIMITY}}?${EMAIL_TOKEN}`,
  'i',
)
// How far past a `FROM/JOIN/UPDATE members` match to look for its OWN email comparison,
// bounded ADDITIONALLY by the detection unit's own end (a slice past the unit's length is
// simply clamped, never bleeds into a sibling literal or surrounding code). Needed on top
// of unit-boundary clipping alone: a single large template literal can hold several
// unrelated EXISTS(...) clauses back to back, each with its own `FROM members` — without
// this bound, an email comparison that belongs to a LATER, unrelated clause in the same
// literal would incorrectly attach to an EARLIER members reference it has nothing to do
// with. 300 chars comfortably covers every real single-clause WHERE in this codebase.
const MATCH_WINDOW = 300

/**
 * computeStringSpans — one pass over `source`, returning every top-level string/template
 * literal as `{ start, end }` (end EXCLUSIVE of the closing delimiter). Skips `//` and
 * `/* *\/` comments so text inside them never becomes part of a "literal". Respects
 * backslash escapes and, for template literals, `${...}` interpolation depth (so a brace
 * inside an interpolated expression does not end the literal early). This is intentionally
 * NOT a full JS tokenizer (no regex-literal handling, no distinguishing `/` division from
 * a comment start in every context) — sufficient for finding SQL string literals, which is
 * this script's only job.
 */
function computeStringSpans(source) {
  const spans = []
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      const start = i
      i++
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') i++
        i++
      }
      i = Math.min(n, i + 1)
      spans.push({ start, end: i })
      continue
    }
    if (ch === '`') {
      const start = i
      i++
      let depth = 0
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (depth === 0 && source[i] === '`') { i++; break }
        if (depth === 0 && source[i] === '$' && source[i + 1] === '{') { depth = 1; i += 2; continue }
        if (depth > 0) {
          if (source[i] === '{') depth++
          else if (source[i] === '}') depth--
          i++
          continue
        }
        i++
      }
      spans.push({ start, end: i })
      continue
    }
    i++
  }
  return spans
}

/** Text between two spans is "just concatenation glue" (`+`, plus whitespace) with
 *  nothing else — this is what lets adjacent literals be treated as one detection unit. */
function isPlusGlue(text) {
  return /^\s*\+\s*$/.test(text)
}

/** 1-indexed line number of `offset` in `source`. */
function lineOf(source, offset) {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

/**
 * scanSource — group every string/template literal into a "detection unit" (a lone
 * literal, or a run of literals joined only by `+`), then flag any unit whose
 * whitespace-collapsed text contains a `FROM/JOIN/UPDATE members` reference followed
 * (anywhere later in the SAME unit) by an email-column comparison. Pure — no I/O — so
 * tests can drive it with synthetic source. Returns [{ line, snippet }], one entry per
 * members-table reference matched, so the RESULT LENGTH is the match count the allowlist
 * tracks.
 */
export function scanSource(source) {
  const spans = computeStringSpans(source)
  const violations = []

  let k = 0
  while (k < spans.length) {
    let end = k
    while (end + 1 < spans.length && isPlusGlue(source.slice(spans[end].end, spans[end + 1].start))) {
      end++
    }
    // Unit = spans[k..end], possibly a single literal. Join each span's INNER content
    // (its delimiter quotes stripped) with a single space — the raw slice would keep the
    // closing/opening quotes and the `+` between adjacent literals sitting right where
    // "FROM" and "members" need to be contiguous, e.g. `'...FROM ' + 'members...'` never
    // reads as "FROM members" unless those glue characters are actually removed, not just
    // used to decide grouping.
    const unitStart = spans[k].start
    const parts = []
    for (let j = k; j <= end; j++) parts.push(source.slice(spans[j].start + 1, spans[j].end - 1))
    const collapsed = parts.join(' ').replace(/\s+/g, ' ')

    MEMBERS_REF_RE.lastIndex = 0
    let m
    while ((m = MEMBERS_REF_RE.exec(collapsed))) {
      const tail = collapsed.slice(m.index, m.index + MATCH_WINDOW)
      if (EMAIL_COMPARISON_RE.test(tail)) {
        violations.push({ line: lineOf(source, unitStart), snippet: tail.slice(0, 140).trim() })
      }
    }
    k = end + 1
  }

  return violations
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.ts$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * loadAllowlist — a missing file, unparsable JSON, or a `files` field that is not a
 * plain object of non-negative integers is a HARD FAILURE (mupot#1583 round 1 P1 (c)):
 * this ratchet must never silently bootstrap to "no exemptions needed" just because its
 * own configuration could not be read. Returns `{ ok: true, files }` or
 * `{ ok: false, error }`.
 */
export function loadAllowlist(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `cannot read ${ALLOWLIST_REL}: ${err instanceof Error ? err.message : String(err)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `cannot parse ${ALLOWLIST_REL} as JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const files = parsed && typeof parsed === 'object' ? parsed.files : undefined
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, error: `${ALLOWLIST_REL}: "files" must be a plain object of {path: count}` }
  }
  for (const [file, count] of Object.entries(files)) {
    if (!Number.isInteger(count) || count < 0) {
      return { ok: false, error: `${ALLOWLIST_REL}: "files"["${file}"] must be a non-negative integer, got ${JSON.stringify(count)}` }
    }
  }
  return { ok: true, files }
}

function targetAllowlist() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return { state: 'unreadable' }
  }
  try {
    const raw = execFileSync('git', ['show', `${ref}:${ALLOWLIST_REL}`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    const files = parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
    return { state: 'compared', files }
  } catch {
    return { state: 'bootstrap' }
  }
}

function targetFileSet() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(raw.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  const allowlistResult = loadAllowlist(ALLOWLIST_PATH)
  if (!allowlistResult.ok) {
    console.error(`\nCANNOT LOAD THE ALLOWLIST — ${allowlistResult.error}`)
    console.error('A missing or corrupt allowlist is a hard failure, never a silent bootstrap')
    console.error('to "no exemptions needed" — fix or restore the file.\n')
    process.exit(1)
  }
  const allowlist = allowlistResult.files

  const actualCounts = {}
  for (const file of walk(SRC_DIR)) {
    const rel = relative(ROOT, file).split('\\').join('/')
    if (CANONICAL_FILES.has(rel)) continue
    const violations = scanSource(readFileSync(file, 'utf8'))
    if (violations.length > 0) actualCounts[rel] = { count: violations.length, violations }
  }

  console.log(
    `member-email-authority-lookup: ${Object.keys(allowlist).length} allowed file(s), ` +
    `${Object.values(allowlist).reduce((a, b) => a + b, 0)} total allowed match(es); ` +
    `${CANONICAL_FILES.size} canonical resolver file(s) exempt unconditionally.`,
  )
  for (const rel of Object.keys(allowlist).sort()) console.log(`  allowed: ${rel} (${allowlist[rel]})`)

  let failed = false

  // Exact match required, per file: growth (new/more matches) AND staleness (fewer/zero
  // matches than declared) both fail — an allowlist entry is a claim about the CURRENT
  // tree, not a historical ceiling.
  const newOrGrown = []
  for (const [file, { count, violations }] of Object.entries(actualCounts)) {
    const declared = allowlist[file]
    if (declared === undefined) {
      newOrGrown.push({ file, declared: 0, actual: count, violations })
    } else if (count > declared) {
      newOrGrown.push({ file, declared, actual: count, violations })
    }
  }
  const stale = Object.keys(allowlist)
    .filter((file) => (actualCounts[file]?.count ?? 0) < allowlist[file])
    .map((file) => ({ file, declared: allowlist[file], actual: actualCounts[file]?.count ?? 0 }))

  if (newOrGrown.length > 0) {
    failed = true
    console.error('\nNEW OR GROWN VIOLATION — a `members` row must never be resolved by a raw email')
    console.error('match outside the shared resolver (mupot#1578/#1583 defect class):\n')
    for (const { file, declared, actual, violations } of newOrGrown) {
      console.error(`  ${file}: ${actual} match(es) found, ${declared} allowed`)
      for (const v of violations) console.error(`    line ${v.line}: ${v.snippet}`)
    }
    console.error('')
    console.error('Use resolveHumanMemberId(env, { tenant, email }) — src/members/resolve-human-member.ts —')
    console.error('which consults decideIdentitylessAttach (src/members/exclusive-control.ts) instead of')
    console.error('trusting a bare email match. If this genuinely is not an authority lookup, update the')
    console.error(`exact count in ${ALLOWLIST_REL} with a reason in its "_why" field — it will be`)
    console.error('printed on every run, not hidden.\n')
  }

  if (stale.length > 0) {
    failed = true
    console.error(`\nSTALE ALLOWLIST ENTRY — the actual match count no longer equals what's declared in`)
    console.error(`${ALLOWLIST_REL} (a cleaned-up file staying at its old, higher count would become a`)
    console.error('standing exemption for violations that no longer exist):\n')
    for (const { file, declared, actual } of stale) console.error(`  ${file}: declared ${declared}, actual ${actual}`)
    console.error('')
  }

  const target = targetAllowlist()
  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.\n')
  } else if (target.state === 'compared') {
    // Per-FILE comparison, not a sum — moving matches from one file to another
    // ("swapping files") must fail even though the total is unchanged.
    const grownVsTarget = Object.entries(allowlist).filter(
      ([file, count]) => count > (target.files[file] ?? 0),
    )
    if (grownVsTarget.length > 0) {
      failed = true
      console.error('\nALLOWLIST GREW (per file, vs the merge target) — a file\'s allowed count may')
      console.error('never exceed what it was on the target, even if some OTHER file\'s count shrank')
      console.error('by the same amount (that relocates the exemption, it does not close it):\n')
      for (const [file, count] of grownVsTarget) {
        console.error(`  ${file}: ${target.files[file] ?? 0} on target -> ${count} here`)
      }
      console.error('')
    }
  }

  const onTarget = targetFileSet()
  if (onTarget !== null) {
    const smuggled = Object.keys(allowlist).filter((file) => !onTarget.has(file))
    if (smuggled.length > 0) {
      failed = true
      console.error('\nALLOWLISTED FILE IS NEW — these are not on the merge target, so they are not')
      console.error('pre-existing and cannot be allowlisted:\n')
      for (const f of smuggled.sort()) console.error(`  ${f}`)
      console.error('')
    }
  }

  if (failed) process.exit(1)
}
