#!/usr/bin/env node
// scripts/check-refusal-next-step.mjs — every refusal code in src/ must name who acts
// next and which tool to call, or sit on a shrink-only allowlist.
//
// WHY THIS EXISTS (mupot board task 4213349b)
//
// src/mcp/refusal-next-step.ts ships a GUIDANCE_TABLE that turns a bare code into
// `{ who_acts, next_step, next_tool? }`. Codes with no row used to fall through
// defaultWhoActs(), which guessed `admin` for 403/forbidden and `self` otherwise —
// a refusal that taught the wrong actor. The guess is gone; this ratchet is the
// replacement. A NEW refusal literal in src/ without a real table row (who_acts +
// next_tool) fails CI. Pre-existing debt lives in
// scripts/refusal-next-step-allowlist.json and may only shrink.
//
// WHAT COUNTS AS A "REAL" ROW
//
// At least one GUIDANCE_TABLE entry for that error code with both `who_acts` and
// `next_tool`. A prose-only next_step without a next_tool is not enough — the task
// asks for who acts AND the next tool.
//
// SCANNER (conservative)
//
// Same two literal shapes as tests/helpers/refusal-codes.ts / the Security Bar
// policy guard:
//   MCP:  fail(4xx|5xx, 'code'
//   REST: { error: 'code' ... }, 4xx|5xx
// Variable forms (fail(409, res.reason), fail(400, error.code)) are intentionally
// invisible — false negatives on those cost a missed row; inventing a broader
// extractor would invent codes that never ship.
//
// ALLOWLIST
//
// scripts/refusal-next-step-allowlist.json — dated, sorted, unique. Compared against
// the merge target (origin/main or BASE_REF): the set may only shrink. A code that
// now has a real row must leave the list (stale). A code on the list that the
// scanner no longer sees must leave the list (dead). A missing allowlist file is a
// hard failure after the initial seeding window (file absent on the merge target).
//
// Do NOT reuse src/policy/refusal-codes.allowlist.json — that file grandfathered
// Security Bar registry adoption, a different gate.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const GUIDANCE_FILE = join(ROOT, 'src', 'mcp', 'refusal-next-step.ts')
const ALLOWLIST_PATH = join(ROOT, 'scripts', 'refusal-next-step-allowlist.json')
const ALLOWLIST_REL = 'scripts/refusal-next-step-allowlist.json'

const SKIP_FILES = new Set(['schema-chain.generated.ts', 'bundle.generated.ts', 'build-info.ts'])
const MCP_RE = /\bfail\(\s*[45]\d\d\s*,\s*['"]([a-z][a-z0-9_]*)['"]/g
const REST_RE = /\berror:\s*['"]([a-z][a-z0-9_]*)['"]((?:(?!\berror:)[^;]){0,300}?)\}\s*,\s*(?:[45]\d\d)\b/g

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !SKIP_FILES.has(name)) out.push(p)
  }
}

/**
 * Scan src (or a fixture dir) for literal refusal codes. Pure over a directory so
 * self-tests can drive a scratch tree. Returns Map<code, Set<relativePath>>.
 */
export function scanRefusalCodes(srcDir) {
  const files = []
  walk(srcDir, files)
  const found = new Map()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const re of [MCP_RE, REST_RE]) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        const code = m[1]
        if (!code) continue
        let set = found.get(code)
        if (!set) {
          set = new Set()
          found.set(code, set)
        }
        set.add(relative(srcDir, f))
      }
    }
  }
  return found
}

/**
 * Parse GUIDANCE_TABLE entries from refusal-next-step.ts source. A code is "real"
 * when at least one entry has both who_acts and next_tool.
 */
export function extractRealNextStepCodes(source) {
  const start = source.indexOf('export const GUIDANCE_TABLE')
  if (start < 0) return { real: new Set(), all: new Set(), error: 'GUIDANCE_TABLE export not found' }
  const end = source.indexOf('\n]', start)
  if (end < 0) return { real: new Set(), all: new Set(), error: 'GUIDANCE_TABLE array end not found' }
  const table = source.slice(start, end)
  const all = new Set()
  const real = new Set()
  let i = 0
  while (i < table.length) {
    const open = table.indexOf('{', i)
    if (open < 0) break
    let depth = 0
    let j = open
    for (; j < table.length; j++) {
      if (table[j] === '{') depth++
      else if (table[j] === '}') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    const body = table.slice(open, j)
    const em = body.match(/error:\s*['"]([a-z][a-z0-9_]*)['"]/)
    if (em) {
      const code = em[1]
      all.add(code)
      if (/\bwho_acts\s*:/.test(body) && /\bnext_tool\s*:/.test(body)) real.add(code)
    }
    i = j
  }
  return { real, all, error: null }
}

export function loadAllowlist(raw) {
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.codes)) {
    throw new Error('allowlist must be a JSON object with a "codes" string array')
  }
  const codes = parsed.codes.map((c) => {
    if (typeof c !== 'string' || !/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`invalid allowlist code: ${JSON.stringify(c)}`)
    }
    return c
  })
  return { dated: typeof parsed.dated === 'string' ? parsed.dated : null, codes }
}

function mergeTargetRef() {
  return process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
}

function allowlistOnTarget() {
  const ref = mergeTargetRef()
  try {
    const raw = execFileSync('git', ['show', `${ref}:${ALLOWLIST_REL}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { state: 'compared', codes: new Set(loadAllowlist(raw).codes) }
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err)
    if (/does not exist|exists on disk|path not in|Not a valid object|fatal:/.test(msg) || /exit code 128/.test(String(err))) {
      // Distinguish "file missing on target" (bootstrap/seed) from "git unreadable".
      try {
        execFileSync('git', ['rev-parse', '--verify', ref], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { state: 'bootstrap', codes: null }
      } catch {
        return { state: 'unreadable', codes: null }
      }
    }
    return { state: 'unreadable', codes: null }
  }
}

/**
 * Core validation. Pure enough for fixture tests: pass srcDir / guidanceSource /
 * allowlistRaw / targetCodes explicitly; omit to use the repo defaults.
 *
 * @returns {{ ok: boolean, messages: string[], covered: string[], allowlisted: string[], missing: string[] }}
 */
export function validateRefusalNextStep(opts = {}) {
  const srcDir = opts.srcDir ?? SRC_DIR
  const guidanceSource = opts.guidanceSource ?? readFileSync(GUIDANCE_FILE, 'utf8')
  const allowlistRaw = opts.allowlistRaw ?? (existsSync(ALLOWLIST_PATH) ? readFileSync(ALLOWLIST_PATH, 'utf8') : null)
  const target = opts.target ?? allowlistOnTarget()
  const messages = []
  let ok = true

  if (allowlistRaw === null) {
    ok = false
    messages.push(`MISSING ALLOWLIST — ${ALLOWLIST_REL} is required.`)
    return { ok, messages, covered: [], allowlisted: [], missing: [] }
  }

  let allowlist
  try {
    allowlist = loadAllowlist(allowlistRaw)
  } catch (err) {
    ok = false
    messages.push(`ALLOWLIST UNPARSEABLE — ${err.message}`)
    return { ok, messages, covered: [], allowlisted: [], missing: [] }
  }

  const { real, error: parseErr } = extractRealNextStepCodes(guidanceSource)
  if (parseErr) {
    ok = false
    messages.push(`GUIDANCE TABLE UNPARSEABLE — ${parseErr}`)
    return { ok, messages, covered: [], allowlisted: [], missing: [] }
  }

  const found = scanRefusalCodes(srcDir)
  const allowSet = new Set(allowlist.codes)
  const sortedAllow = [...allowSet].sort()
  if (allowlist.codes.length !== allowSet.size || allowlist.codes.join('\0') !== sortedAllow.join('\0')) {
    ok = false
    messages.push('ALLOWLIST MUST BE SORTED AND UNIQUE — rewrite codes[] sorted A→Z with no duplicates.')
  }
  if (!allowlist.dated) {
    ok = false
    messages.push('ALLOWLIST MUST BE DATED — set a top-level "dated" ISO date string (when this debt was measured).')
  }

  const covered = [...found.keys()].filter((c) => real.has(c)).sort()
  const allowlisted = [...found.keys()].filter((c) => !real.has(c) && allowSet.has(c)).sort()
  const missing = [...found.entries()]
    .filter(([c]) => !real.has(c) && !allowSet.has(c))
    .map(([c, files]) => `${c}  (${[...files].join(', ')})`)
    .sort()

  if (missing.length) {
    ok = false
    messages.push(
      'NEW REFUSAL WITHOUT A NEXT STEP — add a GUIDANCE_TABLE row in src/mcp/refusal-next-step.ts',
      'with who_acts and next_tool, or (legacy debt only) an entry in the shrink-only allowlist.',
      'The allowlist may not grow to cover a code this PR introduced.',
      '',
      ...missing.map((line) => `  ${line}`),
      '',
    )
  }

  const stale = sortedAllow.filter((c) => real.has(c))
  if (stale.length) {
    ok = false
    messages.push(
      'STALE ALLOWLIST — these codes now have a real GUIDANCE_TABLE row (who_acts + next_tool)',
      'and must leave the allowlist:',
      '',
      ...stale.map((c) => `  ${c}`),
      '',
    )
  }

  // Codes on the allowlist that the scanner never sees must leave the list (a list that
  // retains gone codes is an exemption, not a ratchet). Stale (real-row) codes that are
  // also unscanned are reported here too — either way they must be removed.
  const dead = sortedAllow.filter((c) => !found.has(c))
  if (dead.length) {
    ok = false
    messages.push(
      'DEAD ALLOWLIST ENTRIES — the scanner no longer sees these codes in src/. Remove them',
      '(a list that retains gone codes is an exemption, not a ratchet):',
      '',
      ...dead.map((c) => `  ${c}`),
      '',
    )
  }

  if (target.state === 'unreadable') {
    ok = false
    messages.push(
      'CANNOT VERIFY THE RATCHET — the merge target is unreadable.',
      'Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.',
      'Failing rather than passing: a ratchet that disengages when it cannot read git',
      'is exactly the silent-exemption defect it exists to prevent.',
    )
  } else if (target.state === 'compared') {
    if (allowSet.size > target.codes.size) {
      ok = false
      const added = sortedAllow.filter((c) => !target.codes.has(c))
      messages.push(
        `ALLOWLIST GREW: ${target.codes.size} → ${allowSet.size}. It may only shrink.`,
        'Appending a code here is not a fix. Add a GUIDANCE_TABLE row with who_acts and',
        'next_tool instead.',
        '',
        ...added.map((c) => `  + ${c}`),
        '',
      )
    }
    // Also catch same-size swaps (remove one, add another) — membership growth of any new code.
    const added = sortedAllow.filter((c) => !target.codes.has(c))
    if (added.length && allowSet.size <= target.codes.size) {
      ok = false
      messages.push(
        'ALLOWLIST MEMBERSHIP GREW — new codes appeared even though the count did not.',
        'The set may only shrink; swapping one code for another is growth.',
        '',
        ...added.map((c) => `  + ${c}`),
        '',
      )
    }
  }
  // bootstrap: file absent on merge target — seeding once is allowed.

  return { ok, messages, covered, allowlisted, missing, realCount: real.size, scannedCount: found.size }
}

function main() {
  const result = validateRefusalNextStep()
  console.log(
    `refusal-next-step: ${result.scannedCount} scanned code(s); ` +
      `${result.covered.length} with a real row (who_acts + next_tool); ` +
      `${result.allowlisted.length} on the shrink-only allowlist.`,
  )
  if (!result.ok) {
    console.error('')
    for (const line of result.messages) console.error(line)
    process.exit(1)
  }
  console.log('ok')
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) main()
