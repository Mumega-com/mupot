#!/usr/bin/env node
// scripts/check-bare-squad-id-authz.mjs — a squad-scope capability check must never be
// forced to accept a bare string id in place of a real SquadScope.
//
// WHY THIS EXISTS
//
// mupot#1452 round 2 (2026-09-21): a kind='home' exclusion was added as an OPTIONAL
// `squadKind?: OrgKind` parameter on hasCapability/canOnSquad/canOnSquadAuth. An optional
// parameter on an authz predicate is the opposite of a chokepoint — every one of the ~25
// existing call sites that did not know about it silently kept the OLD, kind-blind
// behaviour. See MEMORY feedback_optional_parameter_on_authz_predicate_is_not_a_chokepoint.md.
//
// The successor design (this PR, G-FP1b point 1) makes `hasCapability`/`canOnSquad`/
// `canOnSquadAuth` OVERLOADED so a 'squad' scope check REQUIRES a real `SquadScope`
// (id + department_id + kind, from `loadSquadScope` or a full `Squad` row) — passing a bare
// `string` there is a TYPE ERROR, not a silent under-check. The TYPECHECKER is the primary
// enforcement (`npm run typecheck`); this ratchet is the second belt: it catches the one way
// a caller could still force a bare id through — suppressing the typechecker itself
// (`@ts-ignore`, `@ts-expect-error`, or an `as any` / `as SquadScope` cast) on the same call.
// A `SquadScope` should only ever come from `loadSquadScope`/`resolveSquadRef`/a full `Squad`
// row — a raw `as SquadScope` cast conjures one out of nothing and is exactly the class this
// exists to catch.
//
// THE RULE
//
//   A call to hasCapability / canOnSquad / canOnSquadAuth / memberCanOnSquad /
//   memberCanOnSquadAuth / actorRankOnScopeFor must not be typechecker-suppressed
//   (`@ts-ignore`, `@ts-expect-error` on the line above or the call line itself) or use an
//   `as any` / `as SquadScope` / `as unknown as SquadScope` cast anywhere on the call line.
//
// SCANS RAW TEXT (same convention as this repo's other ratchets — see
// reference_mupot_ci_ratchets_scan_raw_text.md) rather than building a full type-flow
// analysis: the escape hatches this checks for are lexical and local to the call site, so a
// line-based scan is sufficient and does not need a second type checker.
//
// ON THE BASELINE — same contract as check-mcp-tool-seam.mjs / check-test-schema-source.mjs:
//   - it can only SHRINK. Removing a file is a normal PR; adding one fails the check.
//   - the count is PRINTED on every run, so it cannot quietly grow.
//   - a baselined file that has since stopped violating is ALSO an error, so the list cannot
//     rot into a permanent exemption for files that no longer need it.
//
// ESCAPE HATCH: a `// bare-squad-id-exempt: <reason>` comment on the same line as the flagged
// call, or on the line directly above it, exempts that one call — every exemption is printed
// on every run.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'src')
const TESTS_DIR = join(ROOT, 'tests')
const BASELINE_PATH = join(ROOT, 'scripts', 'bare-squad-id-authz-baseline.json')

const CLASSES = ['files']
const baselineFile = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const baselines = Object.fromEntries(CLASSES.map((c) => [c, new Set(baselineFile[c] ?? [])]))

const GATE_FUNCTIONS = [
  'hasCapability',
  'canOnSquad',
  'canOnSquadAuth',
  'memberCanOnSquad',
  'memberCanOnSquadAuth',
  'actorRankOnScopeFor',
]
// Any call `<name>(` where <name> is one of the gate functions above (possibly qualified,
// e.g. `capability.hasCapability(` or preceded by `await `).
const GATE_CALL_RE = new RegExp(`(?:^|[^A-Za-z0-9_.])(?:${GATE_FUNCTIONS.join('|')})\\s*\\(`)

const TS_SUPPRESSION_RE = /@ts-ignore|@ts-expect-error/
const UNSAFE_CAST_RE = /\bas\s+any\b|\bas\s+SquadScope\b|\bas\s+unknown\s+as\s+SquadScope\b/

// Adversarial round 1 on G-FP1b (P1, Athena): a 1-of-9-escapes ratchet is not a belt.
// The 9 escapes named, and how each is now caught:
//   1. same-line `as any` / `as SquadScope`                -> UNSAFE_CAST_RE, same line
//   2. same-line `@ts-ignore`/`@ts-expect-error`            -> TS_SUPPRESSION_RE, same line
//   3. suppression comment ONE line above                  -> TS_SUPPRESSION_RE, SUPPRESSION_LOOKBACK
//   4. suppression comment TWO lines above                 -> TS_SUPPRESSION_RE, SUPPRESSION_LOOKBACK
//   5. multi-line cast (the `as any` on a continuation line
//      of a call that wraps across lines)                  -> UNSAFE_CAST_RE, CAST_LOOKBACK
//   6. a HOISTED cast (`const x = squadId as any` a few
//      lines above, then `hasCapability(..., x, ...)`)      -> UNSAFE_CAST_RE, CAST_LOOKBACK
//   7. a fabricated `{id, department_id, kind: 'work'}`
//      literal typed directly as SquadScope                -> the BRAND makes this a compile
//      error on its own (SquadScope is unconstructable outside brandSquadScope); this ratchet
//      additionally flags an unbranded object literal sitting on a gate-call line as
//      defense-in-depth (LITERAL_SCOPE_RE)
//   8. kind lifted straight off a request body               -> same brand protection, plus
//      REQUEST_BODY_KIND_RE flags `<something>.kind` piped into brandSquadScope on a line
//      where the object being read from looks like a parsed body (`body`/`args`/`input`/`req`)
//   9. a reintroduced optional `squadKind?` parameter        -> SQUAD_KIND_OPTIONAL_RE, scanned
//      over the WHOLE file, not just near a gate call — this is banned outright, anywhere
//  10. a bare id smuggled through hasCapabilityOnDynamicScope
//      by hardcoding scopeType to the literal 'squad'        -> DYNAMIC_SCOPE_LITERAL_SQUAD_RE
//
// LOOKBACK windows are wider for a cast (which can legitimately sit a few lines above a call
// that spans multiple arguments) than for a suppression comment (which conventionally sits
// immediately above, but round 1 wants two lines honored too).
const SUPPRESSION_LOOKBACK = 2
const CAST_LOOKBACK = 5

const LITERAL_SCOPE_RE = /\{\s*id\s*:.*department_id\s*:.*kind\s*:/
const REQUEST_BODY_KIND_RE = /\b(?:body|args|input|req|request)\.[A-Za-z0-9_.]*kind\b/
const SQUAD_KIND_OPTIONAL_RE = /\bsquadKind\s*\?\s*:/
const DYNAMIC_SCOPE_LITERAL_SQUAD_RE = /hasCapabilityOnDynamicScope\s*\([^)]*'squad'/

const EXEMPT_RE = /bare-squad-id-exempt:\s*(.+?)\s*$/

function baselineSizeOnTarget() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return { state: 'unreadable' }
  }
  try {
    const raw = execFileSync('git', ['show', `${ref}:scripts/bare-squad-id-authz-baseline.json`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw)
    return {
      state: 'compared',
      sizes: Object.fromEntries(CLASSES.map((c) => [c, Array.isArray(parsed[c]) ? parsed[c].length : null])),
    }
  } catch {
    return { state: 'bootstrap' }
  }
}

function targetFileSet() {
  const ref = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, 'src/', 'tests/'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(raw.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Join lines [i - back, i] into one string for a multi-line regex test, and return
 *  the matching line's own text (for the exemption-comment lookup) alongside it. */
function windowAbove(lines, i, back) {
  const start = Math.max(0, i - back)
  return lines.slice(start, i)
}

function findExemptIn(candidateLines) {
  for (const l of candidateLines) {
    const m = l.match(EXEMPT_RE)
    if (m) return m[1]
  }
  return null
}

/**
 * Scan one file's source for a gate-function call whose line (or a nearby line) suppresses
 * the typechecker, casts into SquadScope, or otherwise smuggles a bare id/fabricated scope
 * past the SquadScope requirement — plus two checks that are NOT gate-call-anchored at all
 * (a reintroduced `squadKind?` parameter, banned anywhere in the file; a fabricated scope
 * literal or request-body-derived kind sitting on the gate-call line itself). Pure — no I/O —
 * so tests can drive it with synthetic source. Returns
 * { violations: [{ line, snippet }], exemptions: [{ line, reason }] }.
 */
export function scanSource(source) {
  const lines = source.split('\n')
  const violations = []
  const exemptions = []
  const flaggedLines = new Set()

  function flag(i, reasonLines) {
    if (flaggedLines.has(i)) return
    const exempt = findExemptIn(reasonLines)
    if (exempt) {
      exemptions.push({ line: i + 1, reason: exempt })
    } else {
      violations.push({ line: i + 1, snippet: lines[i].trim() })
    }
    flaggedLines.add(i)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Escape 9: a reintroduced optional `squadKind?` parameter — banned
    // anywhere in the file, not only near a gate call (mupot#1452 round 2's
    // exact defect shape).
    if (SQUAD_KIND_OPTIONAL_RE.test(line)) {
      flag(i, [line])
      continue
    }

    // Escape 10 is anchored on hasCapabilityOnDynamicScope, which is
    // deliberately NOT in GATE_FUNCTIONS (it is the sanctioned escape hatch
    // for hasCapability's own overloads) — checked independently of the
    // GATE_CALL_RE filter below.
    if (DYNAMIC_SCOPE_LITERAL_SQUAD_RE.test(line)) {
      flag(i, [line])
      continue
    }

    if (!GATE_CALL_RE.test(line)) continue

    // Escapes 3/4: a suppression comment up to SUPPRESSION_LOOKBACK lines above.
    const suppressionWindow = windowAbove(lines, i, SUPPRESSION_LOOKBACK)
    const suppressionLine = suppressionWindow.find((l) => TS_SUPPRESSION_RE.test(l))

    // Escapes 1/5/6: an unsafe cast on the call line itself, or up to
    // CAST_LOOKBACK lines above (a multi-line call, or a hoisted
    // `const x = squadId as any` a few lines before its use).
    const castWindow = windowAbove(lines, i, CAST_LOOKBACK)
    const castLine = UNSAFE_CAST_RE.test(line) ? line : castWindow.find((l) => UNSAFE_CAST_RE.test(l))

    // Escape 2 (same-line suppression) is covered by suppressionLine === line
    // when SUPPRESSION_LOOKBACK's window includes the call line itself — it
    // does not (windowAbove excludes index i), so check the call line directly too.
    const sameLineSuppressed = TS_SUPPRESSION_RE.test(line)

    // Escape 10: hasCapabilityOnDynamicScope hardcoded to scopeType 'squad' —
    // the dynamic dispatcher exists ONLY for a genuinely runtime-determined
    // scope type; a literal 'squad' argument means the caller already knows
    // the scope statically and should be forced through hasCapability's
    // overloads instead.
    const dynamicScopeEscape = DYNAMIC_SCOPE_LITERAL_SQUAD_RE.test(line)

    // Escapes 7/8: a fabricated inline scope literal, or a request-body-shaped
    // `.kind` read, sitting on the gate-call line itself. (The branded
    // SquadScope type already makes a bare literal a TYPE ERROR on its own —
    // this is defense-in-depth for the case where brandSquadScope itself is
    // fed body-shaped fields.)
    const fabricatedLiteral = LITERAL_SCOPE_RE.test(line) && REQUEST_BODY_KIND_RE.test(line)

    if (!sameLineSuppressed && !suppressionLine && !castLine && !dynamicScopeEscape && !fabricatedLiteral) continue

    const reasonLines = [line, ...suppressionWindow, ...castWindow]
    flag(i, reasonLines)
  }

  return { violations, exemptions }
}

const RUN_AS_SCRIPT = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (RUN_AS_SCRIPT) main()

function main() {
  const offenders = { files: [] }
  const violating = { files: new Set() }
  const allExemptions = []

  for (const dir of [SRC_DIR, TESTS_DIR]) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file)
      const { violations, exemptions } = scanSource(readFileSync(file, 'utf8'))
      for (const ex of exemptions) allExemptions.push({ file: rel, ...ex })
      if (violations.length === 0) continue
      violating.files.add(rel)
      if (!baselines.files.has(rel)) offenders.files.push({ file: rel, violations })
    }
  }

  const staleBaseline = Object.fromEntries(
    CLASSES.map((c) => [c, [...baselines[c]].filter((rel) => !violating[c].has(rel)).sort()]),
  )

  const target = baselineSizeOnTarget()
  for (const c of CLASSES) {
    const remaining = baselines[c].size - staleBaseline[c].length
    const note =
      target.state === 'compared' && target.sizes[c] !== null ? `, target ${target.sizes[c]}`
      : target.state === 'compared' ? ', target none (new class, seeding)'
      : target.state === 'bootstrap' ? ', target none (bootstrap)'
      : ''
    console.log(
      `bare-squad-id-authz [${c}]: ${remaining} file(s) with a typechecker-suppressed squad-scope ` +
      `capability check (baseline ${baselines[c].size}${note}).`,
    )
  }

  console.log(`bare-squad-id-authz: ${allExemptions.length} exempted call(s) in the tree.`)
  for (const ex of allExemptions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${ex.file}:${ex.line} — ${ex.reason}`)
  }

  let failed = false

  if (target.state === 'unreadable') {
    failed = true
    console.error('\nCANNOT VERIFY THE RATCHET — the merge target is unreadable.')
    console.error('Fetch the base ref (CI: actions/checkout with fetch-depth: 0) and re-run.\n')
  } else if (target.state === 'compared') {
    for (const c of CLASSES) {
      if (target.sizes[c] !== null && baselines[c].size > target.sizes[c]) {
        failed = true
        console.error(`\nBASELINE [${c}] GREW: ${target.sizes[c]} -> ${baselines[c].size}. It may only shrink.`)
        console.error('Appending a file here is not a fix. Load a real SquadScope (loadSquadScope /')
        console.error('resolveSquadRef / a full Squad row) instead of suppressing the typechecker.\n')
      }
    }
  }

  for (const c of CLASSES) {
    if (offenders[c].length === 0) continue
    failed = true
    console.error(`\nNEW VIOLATION [${c}] — a squad-scope capability check must never be forced to`)
    console.error('accept a bare id via a typechecker suppression or an `as SquadScope`/`as any` cast:\n')
    for (const { file, violations } of offenders[c]) {
      for (const v of violations) console.error(`  ${file}:${v.line}  ${v.snippet}`)
    }
    console.error('')
    console.error('Load a real SquadScope with loadSquadScope(env, squadId), or pass a full Squad row —')
    console.error('never force a bare string past the compiler (mupot#1452 round 2 defect class).')
    console.error('If this genuinely cannot be avoided, add a same-line or line-above comment')
    console.error('`// bare-squad-id-exempt: <reason>` — it will be printed on every run, not hidden.')
    console.error('The baseline is a ratchet: it may shrink, never grow.\n')
  }

  const onTarget = targetFileSet()
  if (onTarget !== null) {
    for (const c of CLASSES) {
      const smuggled = [...baselines[c]].filter((rel) => !onTarget.has(rel)).sort()
      if (smuggled.length === 0) continue
      failed = true
      console.error(`\nBASELINED FILE IS NEW [${c}] — these are not on the merge target, so they`)
      console.error('are not pre-existing debt and cannot be baselined:\n')
      for (const f of smuggled) console.error(`  ${f}`)
      console.error('')
    }
  }

  for (const c of CLASSES) {
    if (staleBaseline[c].length === 0) continue
    failed = true
    console.error(`\nSTALE BASELINE [${c}] — these files no longer violate and must be removed from`)
    console.error('the baseline (a fixed file staying baselined would become a permanent exemption):\n')
    for (const f of staleBaseline[c]) console.error(`  ${f}`)
    console.error('')
  }

  if (failed) process.exit(1)
}
