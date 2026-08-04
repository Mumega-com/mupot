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
// The allowlist entry is therefore a TUPLE — ghsa + package + severity + nodes +
// isDirect + ancestry — and every field is load-bearing. Anything that differs from
// what was accepted is treated as a new, unreviewed finding.
//
// The gate fails in BOTH directions:
//   NEW    a high/critical advisory whose tuple is not in the allowlist
//   STALE  an allowlist entry that no longer appears in the audit
//
// The STALE direction is what `|| true` could never do, and it is what makes #670
// self-closing: the day wrangler ships a fixed miniflare, undici drops out, the entry
// goes stale, and CI tells us to delete it rather than waiting for someone to check.
//
// Production dependencies are NOT handled here — they get a plain blocking
// `npm audit --omit=dev --audit-level=moderate` in ci.yml, with no allowlist and no
// exceptions. Nothing that ships is tolerated at any severity.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ALLOWLIST = join(repoRoot, '.github/audit-allowlist.json')
const BLOCKING = new Set(['high', 'critical'])

/** npm audit's documented exit codes: 0 = nothing found, 1 = vulnerabilities found. */
const AUDIT_FINDINGS_EXIT = 1

export class AuditGateError extends Error {}

function normalizeNodes(nodes) {
  return [...(nodes ?? [])].map(String).sort()
}

/**
 * Transitive ancestry of a vulnerable package: which packages pull it in.
 *
 * `nodes` is the INSTALL LOCATION and says nothing about how a package was reached —
 * that gap was bypass 4. npm's `effects` gives the immediate dependents, so walking it
 * transitively reconstructs the declared chain. For the accepted finding this yields
 * ["miniflare", "wrangler"], which is the actual reason it is exempt.
 */
export function ancestryOf(report, pkg) {
  const out = new Set()
  const stack = [...(report.vulnerabilities?.[pkg]?.effects ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()
    if (out.has(next)) continue
    out.add(next)
    for (const e of report.vulnerabilities?.[next]?.effects ?? []) {
      if (!out.has(e)) stack.push(e)
    }
  }
  return [...out].sort()
}

/** Identity of an accepted finding. Every component is compared; none is decoration. */
function tupleKey({ ghsa, pkg, severity, nodes, isDirect, ancestry }) {
  return JSON.stringify([ghsa, pkg, severity, normalizeNodes(nodes), Boolean(isDirect), normalizeNodes(ancestry)])
}

export function loadAllowlist(path = DEFAULT_ALLOWLIST) {
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
    for (const field of ['ghsa', 'package', 'severity', 'nodes', 'isDirect', 'ancestry', 'why', 'accepted_on']) {
      if (entry?.[field] === undefined) {
        throw new AuditGateError(`${path}: allowed[${i}] is missing required field "${field}"`)
      }
    }
    if (!Array.isArray(entry.nodes) || entry.nodes.length === 0) {
      throw new AuditGateError(`${path}: allowed[${i}].nodes must be a non-empty array`)
    }
    if (!Array.isArray(entry.ancestry)) {
      throw new AuditGateError(`${path}: allowed[${i}].ancestry must be an array`)
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
    if (!BLOCKING.has(String(entry.severity).toLowerCase())) {
      // Only high/critical block, so allowlisting anything else is dead config that
      // silently pre-forgives a future re-rating. Reject it rather than ignore it.
      throw new AuditGateError(
        `${path}: allowed[${i}].severity is "${entry.severity}" — only high/critical block, ` +
        `so this entry does nothing except pre-forgive a re-rating. Remove it.`,
      )
    }
    const key = tupleKey({
      ghsa: entry.ghsa, pkg: entry.package, severity: String(entry.severity).toLowerCase(),
      nodes: entry.nodes, isDirect: entry.isDirect, ancestry: entry.ancestry,
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
export function runAudit(cwd = repoRoot, exec = execFileSync) {
  try {
    return JSON.parse(exec('npm', ['audit', '--json'], {
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
export function evaluate(report, allowed) {
  if (!report || typeof report !== 'object' || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw new AuditGateError('audit output has no `vulnerabilities` object — refusing to interpret silence as safety')
  }

  const allowedKeys = new Map(allowed.map((a) => [
    tupleKey({
      ghsa: a.ghsa, pkg: a.package, severity: String(a.severity).toLowerCase(),
      nodes: a.nodes, isDirect: a.isDirect, ancestry: a.ancestry,
    }),
    a,
  ]))
  const matched = new Set()
  const violations = []

  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue
      const severity = String(via.severity ?? vuln.severity ?? '').toLowerCase()
      if (!BLOCKING.has(severity)) continue

      const ghsa = String(via.url ?? '').split('/').filter(Boolean).pop()
      if (!ghsa || !ghsa.startsWith('GHSA-')) {
        // No stable identity means it can never match an allowlist entry. Fail closed.
        violations.push(`${pkg}: ${severity} advisory with no resolvable GHSA id (${via.title ?? 'untitled'})`)
        continue
      }

      const ancestry = ancestryOf(report, pkg)
      const key = tupleKey({ ghsa, pkg, severity, nodes: vuln.nodes, isDirect: vuln.isDirect, ancestry })
      if (allowedKeys.has(key)) {
        matched.add(key)
        continue
      }

      // Explain WHY it did not match — an allowlisted GHSA that moved package, path,
      // or severity is the interesting case and must not look like a generic miss.
      const sameGhsa = allowed.find((a) => a.ghsa === ghsa)
      const detail = sameGhsa
        ? ` (${ghsa} IS allowlisted, but as ${sameGhsa.package}/${sameGhsa.severity}` +
          ` at ${normalizeNodes(sameGhsa.nodes).join(', ')}, direct=${Boolean(sameGhsa.isDirect)},` +
          ` via [${normalizeNodes(sameGhsa.ancestry).join(' > ')}] — found here as ${pkg}/${severity}` +
          ` at ${normalizeNodes(vuln.nodes).join(', ')}, direct=${Boolean(vuln.isDirect)},` +
          ` via [${ancestry.join(' > ')}]. An exemption is bound to HOW the advisory is` +
          ` reached, not just which package it is; this is a different finding.)`
        : ''
      violations.push(`${pkg}: ${severity} — ${ghsa} — ${via.title ?? ''}${detail}`)
    }
  }

  // STALE, classified. An unmatched entry has two very different meanings and the
  // remedies are opposite, so the gate must not report them the same way.
  //
  //   GONE   the GHSA does not appear at a blocking severity anywhere in the audit.
  //          A fix shipped. Deleting the entry is correct.
  //   MOVED  the GHSA is still here, but as a different package/severity/ancestry.
  //          It is ALSO in `violations` above. Deleting the entry would remove a
  //          still-live exemption to make the build green — which turns this gate
  //          into a footgun. Say so explicitly instead of advising deletion.
  //
  // This is the false-negative direction I flagged against my own design: if the walk
  // ever misses a present advisory, the cheapest way to green the build must not be
  // "delete the exemption".
  const seenGhsaAtBlockingSeverity = new Set(
    [...matched].map((k) => JSON.parse(k)[0]).concat(
      violations.map((v) => (v.match(/GHSA-[\w-]+/) ?? [])[0]).filter(Boolean),
    ),
  )
  const stale = allowed
    .filter((a) => !matched.has(tupleKey({
      ghsa: a.ghsa, pkg: a.package, severity: String(a.severity).toLowerCase(),
      nodes: a.nodes, isDirect: a.isDirect, ancestry: a.ancestry,
    })))
    .map((a) => ({ ...a, reason: seenGhsaAtBlockingSeverity.has(a.ghsa) ? 'moved' : 'gone' }))

  return { violations, stale }
}

function main() {
  let allowed
  let result
  try {
    allowed = loadAllowlist()
    result = evaluate(runAudit(), allowed)
  } catch (err) {
    console.error(`\n✗ audit-gate: ${err.message}\n`)
    process.exit(1)
  }

  if (result.violations.length > 0) {
    console.error('\n✗ audit-gate: high/critical dev advisories not accepted in .github/audit-allowlist.json\n')
    for (const v of result.violations) console.error(`    ${v}`)
    console.error(
      '\n  Fix the advisory if a fixed version exists. Only add it to the allowlist if it is' +
      '\n  genuinely unfixable AND dev-only, with the reason written in the entry.\n',
    )
    process.exit(1)
  }

  if (result.stale.length > 0) {
    const gone = result.stale.filter((s) => s.reason === 'gone')
    const moved = result.stale.filter((s) => s.reason === 'moved')

    console.error('\n✗ audit-gate: allowlist entries that no longer match the audit\n')

    if (gone.length > 0) {
      console.error('  GONE — the advisory is no longer reported. A fix shipped.')
      for (const s of gone) console.error(`    ${s.ghsa} (${s.package}, ${s.severity}) — accepted ${s.accepted_on}`)
      console.error(
        '\n    Delete these from .github/audit-allowlist.json. If the list becomes empty,' +
        '\n    the carve-out has no reason to exist — close' +
        '\n    https://github.com/Mumega-com/mupot/issues/670 and fold this step back into' +
        '\n    the blocking production audit.\n',
      )
    }

    if (moved.length > 0) {
      console.error('  MOVED — the advisory is STILL PRESENT, reached a different way.')
      for (const s of moved) console.error(`    ${s.ghsa} (${s.package}, ${s.severity}) — accepted ${s.accepted_on}`)
      console.error(
        '\n    DO NOT delete these to make the build green. The finding is live; only the' +
        '\n    route to it changed, and it is reported above as an unaccepted advisory.' +
        '\n    Decide whether the NEW shape is acceptable, and if it is, update the entry' +
        '\n    to match it. Deleting the entry removes a real exemption and hides a real' +
        '\n    finding at the same time.\n',
      )
    }
    process.exit(1)
  }

  console.log(
    `✓ audit-gate: no unaccepted high/critical dev advisories ` +
    `(${allowed.length} accepted, all still present — see .github/audit-allowlist.json)`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
