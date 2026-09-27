#!/usr/bin/env node
// scripts/check-member-email-authority-lookup.mjs — a `members` row must never be resolved
// by a raw, hand-rolled email match outside the one shared identity resolver.
//
// WHY THIS EXISTS (mupot#1578)
//
// src/projects/index.ts's memberIdFor used to run its OWN copy of "find the member by
// email": `SELECT id FROM members WHERE email = ? AND tenant = ? AND status = 'active'`.
// That query has no idea about mupot#1551's exclusive-control predicate
// (src/members/exclusive-control.ts, decideIdentitylessAttach) — a members row with a LIVE
// unbound bearer token or a bound Telegram chat (a "squatted" row) is exactly the shape
// decideIdentitylessAttach exists to refuse, but a raw email match finds it anyway and
// happily hands out its existing capability grants (an org-owner grant on a squatted row,
// in the reported case) to whoever completes a login with that email — even though the
// SAME login's own identity attach was correctly refused by the resolver moments earlier.
// The fix (this PR) routes memberIdFor through resolveHumanMemberId, the ONE function that
// consults decideIdentitylessAttach.
//
// THE RULE
//
// A `... FROM members ... WHERE ...` query whose WHERE clause filters on `email` or
// `lower(email)` is authority-shaped: whatever member id it returns is one hop away from
// being handed capabilities. Every such query must live in one of the two files that ARE
// the shared resolver (src/members/resolve-human-member.ts, the identity-first resolver;
// src/members/exclusive-control.ts, the exclusive-control predicate it calls) — or in a
// file explicitly ALLOWED below because it was already using the raw pattern for a
// non-authority purpose (a pre-existing collision/dedup guard, a status/suspension check
// that never assigns identity) before this ratchet existed. A NEW file adding this pattern
// fails outright; an allowed file is still printed on every run so the exemption is never
// silent.
//
// SCANS RAW TEXT (same convention as this repo's other ratchets — see
// reference_mupot_ci_ratchets_scan_raw_text.md): SQL here is almost always a short
// `FROM members ... WHERE ...` spanning at most 1-2 lines, so a per-line lookahead window
// is sufficient and needs no SQL parser.
//
// ON THE ALLOWLIST — same shrink-only contract as the other file-baseline ratchets
// (check-bare-squad-id-authz.mjs, check-mcp-tool-seam.mjs): it is measured against the
// state of the tree AT THE TIME THIS RATCHET WAS ADDED and may only shrink from there — a
// file leaving the list (because the pattern was cleaned up) is fine; a file being ADDED to
// it is not (open an issue and route through the resolver instead). A listed file that no
// longer contains the pattern is ALSO an error — a stale entry would become a standing
// exemption for a file that no longer needs one.
//
// The two canonical files (exclusive-control.ts, resolve-human-member.ts) are hardcoded
// ALWAYS-allowed, never counted against the shrinkable allowlist — they are the resolver
// this ratchet exists to funnel every other site through.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'member-email-authority-lookup-allowlist.json')

const CANONICAL_FILES = new Set([
  'src/members/exclusive-control.ts',
  'src/members/resolve-human-member.ts',
])

const allowlistFile = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
const allowlist = new Set(allowlistFile.files ?? [])

const FROM_MEMBERS_RE = /\bFROM\s+members\b/i
const EMAIL_FILTER_RE = /\bWHERE\b[\s\S]*?(?:lower\(\s*email\s*\)|\bemail\s*(?:=|!=))/i
// How many lines past a `FROM members` line to look for its own `WHERE ... email` clause —
// every real site in this codebase keeps them on the same or the very next line.
const LOOKAHEAD = 2

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
 * Scan one file's source for a `FROM members ... WHERE ... email` shape. Pure — no I/O — so
 * tests can drive it with synthetic source. Returns [{ line, snippet }].
 */
export function scanSource(source) {
  const lines = source.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const match = FROM_MEMBERS_RE.exec(lines[i])
    if (!match) continue
    // Only look at text FROM this "FROM members" match onward — text earlier on the
    // same line (e.g. an outer query's own unrelated WHERE clause, or an unrelated
    // "email" column read before this "FROM members") must never count toward IT.
    const tail = lines[i].slice(match.index) + '\n' +
      lines.slice(i + 1, Math.min(lines.length, i + 1 + LOOKAHEAD)).join('\n')
    if (EMAIL_FILTER_RE.test(tail)) {
      violations.push({ line: i + 1, snippet: lines[i].trim() })
    }
  }
  return violations
}

function baselineOnTarget() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return { state: 'unreadable' }
  }
  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/member-email-authority-lookup-allowlist.json`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    return { state: 'compared', size: Array.isArray(parsed.files) ? parsed.files.length : null }
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
  const newOffenders = []
  const violatingFiles = new Set()

  for (const file of walk(SRC_DIR)) {
    const rel = relative(ROOT, file).split('\\').join('/')
    const violations = scanSource(readFileSync(file, 'utf8'))
    if (violations.length === 0) continue
    if (CANONICAL_FILES.has(rel)) continue
    violatingFiles.add(rel)
    if (!allowlist.has(rel)) newOffenders.push({ file: rel, violations })
  }

  const staleAllowlist = [...allowlist].filter((rel) => !violatingFiles.has(rel)).sort()
  const target = baselineOnTarget()
  const note =
    target.state === 'compared' && target.size !== null ? `, target ${target.size}`
    : target.state === 'compared' ? ', target none (new class, seeding)'
    : target.state === 'bootstrap' ? ', target none (bootstrap)'
    : ''
  console.log(
    `member-email-authority-lookup: ${allowlist.size} allowed file(s) with a raw ` +
    `email-keyed members lookup outside the resolver (baseline${note}); ` +
    `${CANONICAL_FILES.size} canonical resolver file(s) exempt unconditionally.`,
  )
  for (const rel of [...allowlist].sort()) console.log(`  allowed: ${rel}`)

  let failed = false

  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.\n')
  } else if (target.state === 'compared' && target.size !== null && allowlist.size > target.size) {
    failed = true
    console.error(`\nALLOWLIST GREW: ${target.size} -> ${allowlist.size}. It may only shrink.`)
    console.error('Adding a file here is not a fix — route the lookup through')
    console.error('resolveHumanMemberId (src/members/resolve-human-member.ts) instead.\n')
  }

  if (newOffenders.length > 0) {
    failed = true
    console.error('\nNEW VIOLATION — a `members` row must never be resolved by a raw email')
    console.error('match outside the shared resolver (mupot#1578 defect class):\n')
    for (const { file, violations } of newOffenders) {
      for (const v of violations) console.error(`  ${file}:${v.line}  ${v.snippet}`)
    }
    console.error('')
    console.error('Use resolveHumanMemberId(env, { tenant, email }) — src/members/resolve-human-member.ts —')
    console.error('which consults decideIdentitylessAttach (src/members/exclusive-control.ts) instead of')
    console.error('trusting a bare email match. If this genuinely is not an authority lookup, add the')
    console.error('file to scripts/member-email-authority-lookup-allowlist.json — it will be printed on')
    console.error('every run, not hidden.\n')
  }

  const onTarget = targetFileSet()
  if (onTarget !== null) {
    const smuggled = [...allowlist].filter((rel) => !onTarget.has(rel)).sort()
    if (smuggled.length > 0) {
      failed = true
      console.error('\nALLOWLISTED FILE IS NEW — these are not on the merge target, so they are not')
      console.error('pre-existing and cannot be allowlisted:\n')
      for (const f of smuggled) console.error(`  ${f}`)
      console.error('')
    }
  }

  if (staleAllowlist.length > 0) {
    failed = true
    console.error('\nSTALE ALLOWLIST ENTRY — these files no longer contain the raw pattern and must')
    console.error('be removed from scripts/member-email-authority-lookup-allowlist.json (a cleaned-up')
    console.error('file staying listed would become a permanent, silent exemption):\n')
    for (const f of staleAllowlist) console.error(`  ${f}`)
    console.error('')
  }

  if (failed) process.exit(1)
}
