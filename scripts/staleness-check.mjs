#!/usr/bin/env node
// scripts/staleness-check.mjs — closes mupot#443 Part B.
//
// CI has no real auto-deploy step, and until now there was no way to even
// SEE that drift without SSHing nowhere (this is Workers — there's no SSH)
// and manually diffing a `wrangler deploy --message` history against `git
// log`. This script makes drift visible instead: for every pot listed in
// pots.manifest.json, it compares the live `GET /health` `commit` (see
// src/health.ts, stamped by scripts/deploy.mjs / scripts/mupot-update.mjs via
// scripts/lib/release-sha.mjs) against the current `main` HEAD sha.
//
// Read-only. Never deploys, never writes, never touches a customer pot's
// config or secrets — it only issues a GET to each pot's public /health URL.
//
//   node scripts/staleness-check.mjs           # human-readable report
//   node scripts/staleness-check.mjs --json    # machine-readable (used by CI)
//
// mupot#2107 M1: pots.manifest.json `legacy` entries (frozen) are probed and
// reported as INFORMATIONAL only. They never affect the exit code; only `pots`
// (deployment entries) can fail the run.
//
// Exit code 1 when ANY deployment pot is not exactly current with HEAD (drift, unstamped,
// unreachable, or errored). Exit code 0 only when every pot's live commit
// equals HEAD exactly. Wired into .github/workflows/staleness-check.yml on a
// schedule, so a divergence shows up as a failed scheduled run (GitHub emails
// the workflow's last editor on scheduled-workflow failure) plus a step
// summary — a visible signal, without auto-deploying anything.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { deploymentPots, legacyPots, resolveRequiredSlug, validateManifest } from './lib/pots-manifest.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Current `main`-checkout HEAD sha (the CI checkout IS main when this runs on schedule). */
export function headSha(repo = REPO) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  return (r.stdout || '').trim()
}

/**
 * Check one pot's live /health against `head`. Injectable `fetchImpl` so this
 * is unit-testable without a network call.
 *
 * mupot#571: a 2xx HTTP response is NOT enough on its own. This also requires
 * the app-level `ok:true` AND that the response actually names the tenant
 * this pot expects (`pot.tenant`, falling back to `pot.slug` when a manifest
 * entry predates the `tenant` field). Comparing only the commit would let a
 * healthy-looking WRONG-tenant response (misrouted DNS/route, a copy-pasted
 * config pointed at the wrong pot, etc.) — or an explicit `ok:false` — report
 * as "current" just because the commit happened to match.
 */
export async function checkPot(pot, head, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let res
  try {
    res = await fetchImpl(pot.health, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    return { slug: pot.slug, status: 'error', head, error: String(err?.message ?? err) }
  }
  if (!res.ok) {
    return { slug: pot.slug, status: 'unreachable', head, http: res.status }
  }
  const body = await res.json().catch(() => ({}))
  // A 2xx whose JSON is null / a scalar / an array is a malformed health body: report it
  // as a pot error (exit 1 WITH a report) instead of a TypeError on `body.ok`.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { slug: pot.slug, status: 'error', head, error: 'health body is not a JSON object' }
  }
  if (body.ok !== true) {
    return { slug: pot.slug, status: 'unhealthy', head, ok: body.ok ?? null }
  }
  const expectedTenant = pot.tenant ?? pot.slug
  if (body.tenant !== expectedTenant) {
    return { slug: pot.slug, status: 'wrong_tenant', head, tenant: body.tenant ?? null, expected: expectedTenant }
  }
  const commit = typeof body.commit === 'string' ? body.commit : null
  if (!commit) {
    return { slug: pot.slug, status: 'unstamped', head }
  }
  if (commit.toLowerCase() !== head.toLowerCase()) {
    return { slug: pot.slug, status: 'drift', head, live: commit }
  }
  if (body.clean !== true) {
    return { slug: pot.slug, status: 'unverified', head, live: commit, clean: body.clean === false ? false : null }
  }
  return { slug: pot.slug, status: 'current', head, live: commit }
}

function readManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/** Checks DEPLOYMENT entries (`pots`) only. Legacy entries are never included here. */
export async function checkAllPots({
  manifestPath = join(REPO, 'pots.manifest.json'),
  head = headSha(),
  ...opts
} = {}) {
  const manifest = readManifest(manifestPath)
  const results = []
  for (const pot of deploymentPots(manifest)) {
    results.push(await checkPot(pot, head, opts))
  }
  return results
}

/**
 * Probe one frozen legacy pot. Informational only: reports whether it answers
 * and what commit it claims, with NO judgement against HEAD/tenant. Never
 * throws (a legacy pot being down is expected, not an error).
 */
export async function probeLegacyPot(pot, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  // Never throws: a malformed entry is reported (runCheck separately fails the
  // run on it via validateManifest — one rule, manifest errors exit 1).
  if (typeof pot !== 'object' || pot === null || typeof pot.slug !== 'string') {
    return { slug: String(pot?.slug ?? '?'), kind: 'legacy', status: 'unreachable', error: 'malformed legacy entry' }
  }
  const base = { slug: pot.slug, kind: 'legacy' }
  if (typeof pot.health !== 'string' || !pot.health) {
    return { ...base, status: 'unreachable', error: 'no health url' }
  }
  try {
    const res = await fetchImpl(pot.health, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ...base, status: 'unreachable', http: res.status }
    const body = await res.json().catch(() => ({}))
    const live = typeof body?.commit === 'string' && body.commit ? body.commit : null
    const tenant = typeof body?.tenant === 'string' && body.tenant ? body.tenant : null
    return { ...base, status: 'reachable', live, tenant }
  } catch (err) {
    return { ...base, status: 'unreachable', error: String(err?.message ?? err) }
  }
}

/** Probes `legacy` entries (absent => []). Results are informational; callers must not use them for the exit code. */
export async function checkLegacyPots({
  manifestPath = join(REPO, 'pots.manifest.json'),
  ...opts
} = {}) {
  const manifest = readManifest(manifestPath)
  const results = []
  for (const pot of legacyPots(manifest)) {
    results.push(await probeLegacyPot(pot, opts))
  }
  return results
}

/**
 * Exit code for a run: 1 iff there are NO deployment results (nothing verified
 * is never green) or any DEPLOYMENT result is not `current`. Legacy results are
 * deliberately not an input.
 */
export function exitCodeFor(deploymentResults) {
  return deploymentResults.length === 0 || deploymentResults.some((r) => r.status !== 'current') ? 1 : 0
}

/**
 * `ref` is the actual ref this run built/checked out — NOT assumed. mupot#571:
 * the report used to hardcode the label "main HEAD" regardless of what
 * actually triggered the run. A `workflow_dispatch` can be run against any
 * branch/ref picked in the GitHub UI, and a scheduled run's default checkout
 * ref can change if the repo's default branch ever changes — printing "main"
 * unconditionally would misreport what was actually built. `head` itself
 * (from `headSha()`) is already the exact resolved commit sha of whatever was
 * checked out, so it is always pinned; only the human-facing REF LABEL was
 * dishonest. Pass `ref` from `GITHUB_REF_NAME` (set automatically by GitHub
 * Actions for every event, including `workflow_dispatch`) — omit it and the
 * report says plain `HEAD`, never a guessed branch name.
 */
export function formatReport(head, results, { ref, legacy = [] } = {}) {
  const refLabel = ref ? `ref '${ref}' @ ${head}` : `HEAD ${head}`
  const lines = [`mupot staleness check — ${refLabel}`, '']
  for (const r of results) {
    const label =
      r.status === 'current'
        ? '✓ current'
        : r.status === 'drift'
          ? `⚠ DRIFT (live=${r.live?.slice(0, 12)})`
          : r.status === 'unstamped'
            ? '✘ UNSTAMPED (commit: null)'
            : r.status === 'unhealthy'
              ? `✘ UNHEALTHY (ok=${r.ok})`
              : r.status === 'wrong_tenant'
                ? `✘ WRONG TENANT (got '${r.tenant}', expected '${r.expected}')`
                : r.status === 'unverified'
                  ? `✘ UNVERIFIED BUILD (clean=${r.clean})`
                  : r.status === 'unreachable'
                    ? `✘ UNREACHABLE (http ${r.http})`
                    : `✘ ERROR (${r.error})`
    lines.push(`  ${r.slug.padEnd(10)} ${label}`)
  }
  if (legacy.length > 0) {
    lines.push('', 'legacy pots (frozen, informational only — not counted, see #2107)')
    for (const r of legacy) {
      const detail =
        r.status === 'reachable'
          ? `reachable — NOT verified (live=${r.live ? r.live.slice(0, 12) : 'none'}, tenant=${r.tenant ?? 'none'}), informational only`
          : r.http !== undefined
            ? `unreachable (http ${r.http})`
            : `unreachable (${r.error})`
      lines.push(`  ${r.slug.padEnd(10)} ${detail}`)
    }
  }
  return lines.join('\n')
}

/** Read + validate; an unreadable/unparseable manifest is an error, never a throw or a pass. */
function manifestErrors(manifestPath, requiredSlug, env) {
  let manifest
  try {
    manifest = readManifest(manifestPath)
  } catch (err) {
    return [`manifest: cannot read or parse ${manifestPath} (${String(err?.message ?? err)})`]
  }
  return validateManifest(manifest, { requiredSlug: requiredSlug === undefined ? resolveRequiredSlug(manifest, env) : requiredSlug })
}

/**
 * Whole run as a pure-ish function so the exact output + exit code are
 * testable. Deployment results alone decide `exitCode`; `legacy` is report-only.
 */
export async function runCheck({ manifestPath = join(REPO, 'pots.manifest.json'), head = headSha(), ref = null, json = false, requiredSlug, env = process.env, ...opts } = {}) {
  // Fail closed: an unreadable/unparseable manifest, or a malformed one (no/empty/
  // non-array `pots`, missing the required deployment, slug in both lists,
  // unfrozen/malformed legacy) is never green. `requiredSlug` left undefined =>
  // resolved from env / manifest `required_slug` / 'mumega' (#2109). An explicit
  // `null` skips the required-slug check (tests only; the CLI never passes it).
  const errors = manifestErrors(manifestPath, requiredSlug, env)
  if (errors.length > 0) {
    const output = json
      ? JSON.stringify({ head, ref, manifest_errors: errors }, null, 2)
      : [`mupot staleness check — ${ref ? `ref '${ref}' @ ${head}` : `HEAD ${head}`}`, '', ...errors.map((e) => `  ✘ ${e}`)].join('\n')
    return { output, exitCode: 1, results: [], legacy: [], errors }
  }
  const results = await checkAllPots({ manifestPath, head, ...opts })
  const legacy = await checkLegacyPots({ manifestPath, ...opts })
  const output = json
    ? JSON.stringify({ head, ref, pots: results, ...(legacy.length ? { legacy } : {}) }, null, 2)
    : formatReport(head, results, { ref, legacy })
  return { output, exitCode: exitCodeFor(results), results, legacy, errors: [] }
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // `--manifest=<path>` overrides the manifest (used by the CLI exit-code tests);
  // the scheduled workflow passes nothing and gets the repo's pots.manifest.json.
  const manifestArg = process.argv.find((a) => a.startsWith('--manifest='))
  // The space form would be silently ignored (and the repo manifest checked instead): reject it.
  if (process.argv.some((a) => a === '--manifest' || (a.startsWith('--manifest') && !a.startsWith('--manifest=')))) {
    console.error('use --manifest=<path> (with an equals sign); the space form is not supported.')
    process.exit(1)
  }
  const { output, exitCode } = await runCheck({
    ...(manifestArg ? { manifestPath: resolve(manifestArg.slice('--manifest='.length)) } : {}),
    head: headSha(),
    ref: process.env.GITHUB_REF_NAME || null,
    json: process.argv.includes('--json'),
  })
  console.log(output)
  process.exit(exitCode)
}
