#!/usr/bin/env node
// audit-gate — the dev/build-toolchain half of the dependency gate.
//
// WHY THIS EXISTS INSTEAD OF `npm audit ... || true`
//
// The first version of this split ran the dev audit with `|| true`. Review blocked it,
// correctly: `|| true` does not accept "the known unfixable undici chain", it accepts
// EVERY future high/critical dev advisory plus every audit-tool failure. It also made
// the close condition in issue #670 undetectable, because the step passes identically
// whether the known advisory is still there or ten new ones have joined it.
//
// The second version matched the allowlist on GHSA id alone. Review blocked that too,
// with three reproduced bypasses, all of which are now covered by tests/audit-gate.test.mjs:
//
//   1. npm emits parseable JSON but exits 2 (a TOOL failure, not a findings exit).
//      The catch block parsed stdout and returned 0. "I could not run the audit
//      properly" was being read as "nothing wrong" — the same fail-open shape this
//      codebase has been pulling defects out of all week. Now only exit 1 (the
//      documented findings exit) is tolerated; anything else fails.
//
//   2. The same allowed GHSA appearing under a DIFFERENT package or dependency path.
//      An advisory is accepted because of WHERE it sits — dev toolchain, not shippable
//      surface. The same CVE arriving through a production path is a different fact and
//      must not inherit the exemption.
//
//   3. The same GHSA re-rated high -> critical. Severity was prose in the allowlist
//      and never compared, so an escalation passed silently.
//
//   4. Installing undici as a DIRECT dev dependency. Same GHSA, same severity, same
//      `nodes` — because `nodes` is where a package is INSTALLED, not how it was
//      reached. The exemption's entire justification is the ancestry "we only have
//      this because wrangler needs miniflare"; a direct dependency destroys that
//      justification while matching the tuple exactly.
//
//   5. Installing miniflare as a DIRECT dev dependency. `effects` is a flattened
//      closure of dependent NAMES, not a causal path from the project root, so
//      ancestry stayed ["miniflare", "wrangler"] while the justification ("we carry
//      miniflare only because wrangler needs it") had become false. Reproduced under
//      npm 9.9.4 and 10.9.8. Fixing bypass 4 with a sorted name set was the same
//      mistake as fixing it with `nodes`, one level up.
//
//   6. `wrangler-alias@npm:wrangler@4.102.0` — a second, distinct root edge to the same
//      package. `npm audit --json` keys `vulnerabilities` by package NAME, so both root
//      edges collapsed into one "wrangler > miniflare > undici" chain and the gate
//      passed with zero violations. This is the point at which the audit summary stops
//      being fixable: its key space is names, so it CANNOT express node identity,
//      aliases, or version-distinct copies, no matter how carefully it is read.
//      Paths now come from package-lock.json (see scripts/lockfile-paths.mjs), which is
//      keyed by node path — the identity that actually exists on disk.
//
// The allowlist entry is therefore a TUPLE — ghsa + package + severity + nodes +
// isDirect + paths — where `paths` is the COMPLETE set of ordered root-to-node causal
// chains. Every field is load-bearing. Anything that differs from what was accepted is
// treated as a new, unreviewed finding.
//
// The gate fails in BOTH directions:
//   NEW    a high/critical advisory whose tuple is not in the allowlist
//   STALE  an allowlist entry that no longer appears in the audit
//
// The STALE direction is what `|| true` could never do, and it is what makes #670
// self-closing: the day wrangler ships a fixed miniflare, undici drops out, the entry
// goes stale, and CI tells us to delete it rather than waiting for someone to check.
//
// PRODUCTION MODE (--omit-dev). The root Worker's production audit is still a plain
// blocking `npm audit --omit=dev --audit-level=moderate` in ci.yml with no allowlist.
// workers/project-office runs THIS gate in production mode instead: moderate and above
// block, same tuple/NEW/STALE rules, and every entry MUST carry a capped expires_on.
// Its one entry (picomatch) is only acceptable because CI proves the built bundle does
// not contain picomatch (see the bundle check in the project-office job of ci.yml).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathsToNode, LockfileGraphError } from './lockfile-paths.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ALLOWLIST = join(repoRoot, '.github/audit-allowlist.json')
const DEFAULT_LOCKFILE = join(repoRoot, 'package-lock.json')
const BLOCKING = new Set(['high', 'critical'])
// Production mode (--omit-dev) keeps the bar the plain `npm audit --omit=dev
// --audit-level=moderate` step had: moderate and above block. Never lowered to high-only.
const BLOCKING_PROD = new Set(['moderate', 'high', 'critical'])

/** npm audit's documented exit codes: 0 = nothing found, 1 = vulnerabilities found. */
const AUDIT_FINDINGS_EXIT = 1

/** An exemption may not be granted for longer than this many days after accepted_on. */
const MAX_EXPIRY_DAYS = 90
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/** Strict YYYY-MM-DD -> epoch ms, or null. Rejects roll-overs such as 2027-02-31. */
function parseDay(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null
  const t = Date.parse(`${v}T00:00:00Z`)
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null
  return t
}

export class AuditGateError extends Error {}

function normalizeNodes(nodes) {
  return [...(nodes ?? [])].map(String).sort()
}

function normalizePaths(paths) {
  return [...(paths ?? [])]
    .map((chain) => [...chain].map(String))
    .map((chain) => JSON.stringify(chain))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .map((v) => JSON.parse(v))
}

/** Identity of an accepted finding. Every component is compared; none is decoration. */
function tupleKey({ ghsa, pkg, severity, nodes, isDirect, paths }) {
  return JSON.stringify([ghsa, pkg, severity, normalizeNodes(nodes), Boolean(isDirect), normalizePaths(paths)])
}

/**
 * `opts.prod` allows 'moderate' entries (prod mode blocks at moderate). `opts.now` is
 * injectable for tests. An entry with `expires_on` fails the gate once that date is
 * past, so a no-upstream-fix exemption cannot sit forever. In prod mode expires_on is
 * REQUIRED. Whenever present it must be a real YYYY-MM-DD date, >= accepted_on, and at
 * most MAX_EXPIRY_DAYS after accepted_on.
 */
export function loadAllowlist(path = DEFAULT_ALLOWLIST, { prod = false, now = new Date() } = {}) {
  const blocking = prod ? BLOCKING_PROD : BLOCKING
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    // A missing or malformed allowlist is not "nothing is allowed and nothing to
    // check" — it means the gate's own configuration is broken. Fail.
    throw new AuditGateError(`cannot read ${path}: ${err.message}`)
  }
  const allowed = parsed?.allowed
  if (!Array.isArray(allowed)) {
    throw new AuditGateError(`${path}: "allowed" must be an array`)
  }
  const seen = new Set()
  for (const [i, entry] of allowed.entries()) {
    for (const field of ['ghsa', 'package', 'severity', 'nodes', 'isDirect', 'paths', 'why', 'accepted_on']) {
      if (entry?.[field] === undefined) {
        throw new AuditGateError(`${path}: allowed[${i}] is missing required field "${field}"`)
      }
    }
    if (!Array.isArray(entry.nodes) || entry.nodes.length === 0) {
      throw new AuditGateError(`${path}: allowed[${i}].nodes must be a non-empty array`)
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0 || !entry.paths.every((c) => Array.isArray(c) && c.length > 0)) {
      throw new AuditGateError(`${path}: allowed[${i}].paths must be a non-empty array of non-empty chains`)
    }
    if (typeof entry.isDirect !== 'boolean') {
      throw new AuditGateError(`${path}: allowed[${i}].isDirect must be a boolean`)
    }
    if (entry.isDirect === true) {
      // A DIRECT dependency is one we chose to add. If it carries a high/critical
      // advisory, the answer is to change or drop it, never to allowlist it — the
      // dev-toolchain justification does not apply to something we depend on directly.
      throw new AuditGateError(
        `${path}: allowed[${i}] has isDirect true. A direct dependency's advisory must be ` +
        `fixed or the dependency dropped — it cannot inherit the transitive-toolchain exemption.`,
      )
    }
    if (prod && entry.expires_on === undefined) {
      throw new AuditGateError(`${path}: allowed[${i}] is missing required field "expires_on" (required in production mode)`)
    }
    if (entry.expires_on !== undefined) {
      const exp = parseDay(entry.expires_on)
      if (exp === null) {
        throw new AuditGateError(`${path}: allowed[${i}].expires_on must be a YYYY-MM-DD date`)
      }
      const acc = parseDay(entry.accepted_on)
      if (acc === null) {
        throw new AuditGateError(`${path}: allowed[${i}].accepted_on must be a YYYY-MM-DD date`)
      }
      if (exp < acc) {
        throw new AuditGateError(`${path}: allowed[${i}].expires_on ${entry.expires_on} is before accepted_on ${entry.accepted_on}`)
      }
      if ((exp - acc) / 86_400_000 > MAX_EXPIRY_DAYS) {
        throw new AuditGateError(
          `${path}: allowed[${i}].expires_on ${entry.expires_on} is more than ${MAX_EXPIRY_DAYS} days after accepted_on ${entry.accepted_on}`,
        )
      }
      if (now.toISOString().slice(0, 10) > entry.expires_on) {
        throw new AuditGateError(
          `${path}: allowed[${i}] (${entry.ghsa}) expired on ${entry.expires_on}. Re-review: fix the ` +
          `advisory if upstream shipped one, or extend expires_on with a fresh written justification.`,
        )
      }
    }
    if (!blocking.has(String(entry.severity).toLowerCase())) {
      // Only blocking severities matter, so allowlisting anything else is dead config that
      // silently pre-forgives a future re-rating. Reject it rather than ignore it.
      throw new AuditGateError(
        `${path}: allowed[${i}].severity is "${entry.severity}" — only ${prod ? 'moderate/high/critical' : 'high/critical'} block, ` +
        `so this entry does nothing except pre-forgive a re-rating. Remove it.`,
      )
    }
    const key = tupleKey({
      ghsa: entry.ghsa, pkg: entry.package, severity: String(entry.severity).toLowerCase(),
      nodes: entry.nodes, isDirect: entry.isDirect, paths: entry.paths,
    })
    if (seen.has(key)) throw new AuditGateError(`${path}: allowed[${i}] is a duplicate entry`)
    seen.add(key)
  }
  return allowed
}

/**
 * Run `npm audit --json`.
 *
 * npm exits 1 when it finds vulnerabilities — that is the normal path here, not an
 * error. Any OTHER non-zero status means the tool itself failed (network, registry,
 * bad lockfile, EACCES), and a gate must never read that as a clean bill of health,
 * even when the process happened to emit parseable JSON on the way down.
 */
export function runAudit(cwd = repoRoot, exec = execFileSync, { omitDev = false } = {}) {
  try {
    return JSON.parse(exec('npm', ['audit', ...(omitDev ? ['--omit=dev'] : []), '--json'], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch (err) {
    if (err?.status !== AUDIT_FINDINGS_EXIT) {
      throw new AuditGateError(
        `\`npm audit --json\` exited ${err?.status ?? 'with a signal'} ` +
        `(expected 0, or ${AUDIT_FINDINGS_EXIT} for findings). Refusing to interpret a ` +
        `failed audit as a clean one.${err?.stderr ? `\n  stderr: ${String(err.stderr).trim().slice(0, 500)}` : ''}`,
      )
    }
    try {
      return JSON.parse(err.stdout?.toString() ?? '')
    } catch {
      throw new AuditGateError(`could not parse \`npm audit --json\` output: ${err.message}`)
    }
  }
}

/** Pure core, so the bypasses above can be tested without a registry. */
/**
 * Paths to every install location the audit attributes to this finding, taken from the
 * LOCKFILE rather than from the audit summary. A finding with several `nodes` (two
 * copies of one package) contributes all of their paths.
 */
function pathsForFinding(lock, vuln) {
  const all = []
  for (const node of vuln.nodes ?? []) all.push(...pathsToNode(lock, node))
  if (all.length === 0) {
    throw new LockfileGraphError(`finding has no install nodes to locate in the lockfile`)
  }
  return normalizePaths(all)
}

/**
 * Malformed npm output must fail closed. npm's own summary (`metadata.vulnerabilities`)
 * counts packages per severity; the per-package map we evaluate must agree with it, and
 * every entry must carry a `via` array. A report that disagrees with itself (vuln with
 * no `via`, an emptied map) is a tool/format fault, not a clean audit.
 */
export function crossCheckMetadata(report) {
  const counts = report?.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object') {
    throw new AuditGateError('audit output has no `metadata.vulnerabilities` counts — refusing to interpret it')
  }
  const tally = Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
  let total = 0
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    if (!Array.isArray(vuln?.via)) {
      throw new AuditGateError(`audit output: ${pkg} has no \`via\` array — malformed, refusing to interpret it`)
    }
    const sev = String(vuln.severity ?? '').toLowerCase()
    if (!(sev in tally)) throw new AuditGateError(`audit output: ${pkg} has unknown severity "${vuln.severity}"`)
    tally[sev]++
    total++
  }
  for (const sev of SEVERITIES) {
    if (counts[sev] !== tally[sev]) {
      throw new AuditGateError(`audit output disagrees with itself: metadata says ${counts[sev]} ${sev}, vulnerabilities lists ${tally[sev]}`)
    }
  }
  if (counts.total !== total) {
    throw new AuditGateError(`audit output disagrees with itself: metadata total ${counts.total}, vulnerabilities lists ${total}`)
  }
}

export function evaluate(report, allowed, lock, { prod = false } = {}) {
  const blocking = prod ? BLOCKING_PROD : BLOCKING
  if (!report || typeof report !== 'object' || typeof report.vulnerabilities !== 'object' ||
      report.vulnerabilities === null || Array.isArray(report.vulnerabilities)) {
    throw new AuditGateError('audit output has no `vulnerabilities` object — refusing to interpret silence as safety')
  }

  const allowedKeys = new Map(allowed.map((a) => [
    tupleKey({
      ghsa: a.ghsa, pkg: a.package, severity: String(a.severity).toLowerCase(),
      nodes: a.nodes, isDirect: a.isDirect, paths: a.paths,
    }),
    a,
  ]))
  const matched = new Set()
  const violations = []
  // Structured record of what the audit actually showed, so classification below reads
  // DATA rather than recovering identities from rendered strings (review finding).
  const seenBlocking = []
  let unresolvedIdentity = false

  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue
      const severity = String(via.severity ?? vuln.severity ?? '').toLowerCase()
      if (!blocking.has(severity)) continue

      const ghsa = String(via.url ?? '').split('/').filter(Boolean).pop()
      if (!ghsa || !ghsa.startsWith('GHSA-')) {
        // No stable identity: it can never match an allowlist entry, AND it means we
        // cannot tell whether an existing exemption's advisory is still present.
        unresolvedIdentity = true
        violations.push(`${pkg}: ${severity} advisory with no resolvable GHSA id (${via.title ?? 'untitled'})`)
        continue
      }

      let paths
      try {
        paths = pathsForFinding(lock, vuln)
      } catch (err) {
        // Cannot locate the finding in the lockfile => cannot verify any exemption for
        // it. Fail closed and say why, rather than comparing against a guess.
        unresolvedIdentity = true
        violations.push(`${pkg}: ${severity} — ${ghsa} — cannot verify dependency path: ${err.message}`)
        continue
      }
      seenBlocking.push({ ghsa, pkg, severity, nodes: normalizeNodes(vuln.nodes), isDirect: Boolean(vuln.isDirect), paths })

      const key = tupleKey({ ghsa, pkg, severity, nodes: vuln.nodes, isDirect: vuln.isDirect, paths })
      if (allowedKeys.has(key)) {
        matched.add(key)
        continue
      }

      const sameGhsa = allowed.find((a) => a.ghsa === ghsa)
      const render = (chains) => chains.map((c) => c.join(' > ')).join('; ')
      const detail = sameGhsa
        ? ` (${ghsa} IS allowlisted, but as ${sameGhsa.package}/${sameGhsa.severity}` +
          ` at ${normalizeNodes(sameGhsa.nodes).join(', ')}, direct=${Boolean(sameGhsa.isDirect)},` +
          ` via [${render(normalizePaths(sameGhsa.paths))}] — found here as ${pkg}/${severity}` +
          ` at ${normalizeNodes(vuln.nodes).join(', ')}, direct=${Boolean(vuln.isDirect)},` +
          ` via [${render(paths)}]. An exemption is bound to HOW the advisory is reached,` +
          ` not just which package it is; this is a different finding.)`
        : ''
      violations.push(`${pkg}: ${severity} — ${ghsa} — ${via.title ?? ''}${detail}`)
    }
  }

  // STALE, classified. An unmatched entry has three meanings with different remedies,
  // and the gate must not assert one it cannot support.
  //
  //   GONE     the advisory is absent at a blocking severity AND every blocking finding
  //            had a resolvable identity. A fix shipped. Deleting the entry is correct.
  //   MOVED    the advisory is still here, reached differently. It is also in
  //            `violations`. Deleting it removes a live exemption and hides a live
  //            finding — the cheapest path to a green build must not be that.
  //   UNKNOWN  at least one blocking finding had NO resolvable advisory id, so we cannot
  //            tell whether this exemption's advisory is among them. Previously this was
  //            reported as GONE, which printed "a fix shipped" while a blocking finding
  //            was visibly present — the gate asserting something it could not know.
  const stale = allowed
    .filter((a) => !matched.has(tupleKey({
      ghsa: a.ghsa, pkg: a.package, severity: String(a.severity).toLowerCase(),
      nodes: a.nodes, isDirect: a.isDirect, paths: a.paths,
    })))
    .map((a) => ({
      ...a,
      reason: seenBlocking.some((f) => f.ghsa === a.ghsa) ? 'moved' : unresolvedIdentity ? 'unknown' : 'gone',
    }))

  return { violations, stale }
}

/**
 * Minimal CLI: --cwd DIR, --allowlist FILE, --omit-dev. Defaults = root dev gate.
 * There is deliberately NO --lockfile: the lockfile is always <cwd>/package-lock.json,
 * the one npm audits, so paths can never be taken from a different tree than the audit.
 */
export function parseArgs(argv) {
  const opts = { cwd: repoRoot, allowlist: undefined, omitDev: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--omit-dev') opts.omitDev = true
    else if (a === '--cwd' || a === '--allowlist') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new AuditGateError(`${a} needs a value`)
      opts[a.slice(2)] = resolve(v)
    } else throw new AuditGateError(`unknown argument ${a}`)
  }
  opts.allowlist ??= opts.cwd === repoRoot ? DEFAULT_ALLOWLIST : join(opts.cwd, '.audit-allowlist.json')
  opts.lockfile = join(opts.cwd, 'package-lock.json')
  return opts
}

/** Prod mode: root dev edges are not part of what ships, so they are not accepted paths. */
export function withoutDevRoot(lock) {
  const root = { ...(lock?.packages?.[''] ?? {}) }
  delete root.devDependencies
  return { ...lock, packages: { ...lock.packages, '': root } }
}

/**
 * The whole CLI as a function, so tests can drive it end to end with a fake `exec`.
 * Returns the process exit code; never calls process.exit itself.
 */
export function runGate(argv, { exec = execFileSync, now = new Date(), log = console.log, error = console.error } = {}) {
  let allowed
  let result
  let opts
  try {
    opts = parseArgs(argv)
    const prod = opts.omitDev
    allowed = loadAllowlist(opts.allowlist, { prod, now })
    let lock = JSON.parse(readFileSync(opts.lockfile, 'utf8'))
    if (prod) lock = withoutDevRoot(lock)
    const audit = runAudit(opts.cwd, exec, { omitDev: prod })
    crossCheckMetadata(audit)
    result = evaluate(audit, allowed, lock, { prod })
  } catch (err) {
    error(`\n✗ audit-gate: ${err.message}\n`)
    return 1
  }
  const label = opts.omitDev ? 'moderate/high/critical production' : 'high/critical dev'
  const listName = relative(repoRoot, opts.allowlist)

  if (result.violations.length > 0) {
    error(`\n✗ audit-gate: ${label} advisories not accepted in ${listName}\n`)
    for (const v of result.violations) error(`    ${v}`)
    error(
      '\n  Fix the advisory if a fixed version exists. Only add it to the allowlist if it is' +
      '\n  genuinely unfixable AND not shipped (dev toolchain, or proven absent from the built bundle),' +
      '\n  with the reason written in the entry.\n',
    )
    return 1
  }

  if (result.stale.length > 0) {
    const byReason = (r) => result.stale.filter((s) => s.reason === r)
    const line = (s) => `    ${s.ghsa} (${s.package}, ${s.severity}) — accepted ${s.accepted_on}`

    error('\n✗ audit-gate: allowlist entries that no longer match the audit\n')

    const gone = byReason('gone')
    if (gone.length > 0) {
      error('  GONE — the advisory is no longer reported. A fix shipped.')
      for (const s of gone) error(line(s))
      error(
        `\n    Delete these from ${listName}. If the list becomes empty,` +
        '\n    the carve-out has no reason to exist — close its review issue' +
        `\n    (${[...new Set(gone.map((s) => s.review ?? 'no review link in the entry'))].join(', ')}) and fold this step back into` +
        '\n    the plain blocking audit.\n',
      )
    }

    const moved = byReason('moved')
    if (moved.length > 0) {
      error('  MOVED — the advisory is STILL PRESENT, reached a different way.')
      for (const s of moved) error(line(s))
      error(
        '\n    DO NOT delete these to make the build green. The finding is live; only the' +
        '\n    route to it changed, and it is reported above as an unaccepted advisory.' +
        '\n    Decide whether the NEW shape is acceptable, and if it is, update the entry' +
        '\n    to match it. Deleting the entry removes a real exemption and hides a real' +
        '\n    finding at the same time.\n',
      )
    }

    const unknown = byReason('unknown')
    if (unknown.length > 0) {
      error('  UNKNOWN — cannot determine whether this advisory is still present.')
      for (const s of unknown) error(line(s))
      error(
        '\n    At least one blocking finding above has NO resolvable advisory id, so this' +
        '\n    exemption may or may not still apply. Verify by hand. Do NOT delete on the' +
        '\n    assumption that a fix shipped — this gate does not know that, and saying so' +
        '\n    would be the gate asserting something it cannot support.\n',
      )
    }
    return 1
  }

  log(
    `✓ audit-gate: no unaccepted ${label} advisories ` +
    `(${allowed.length} accepted, all still present — see ${listName})`,
  )
  return 0
}

function main() {
  process.exit(runGate(process.argv.slice(2)))
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
