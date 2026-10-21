// scripts/lib/pots-manifest.mjs — pure helpers over pots.manifest.json.
//
// mupot#2107 M1: the manifest has two lists.
//   - `pots`   — DEPLOYMENT entries: what this core deploys to and what the
//                staleness check enforces (drift fails the run).
//   - `legacy` — FROZEN entries: probed for information only. Never deployed
//                by scripts/mupot-update.mjs and never able to fail the
//                staleness check. There is deliberately no way to promote a
//                legacy entry to a deploy target from the CLI.
// `legacy` is optional; when absent everything behaves as before.

/** Deployment entries (the only ones mupot-update may touch / staleness enforces). */
export function deploymentPots(manifest) {
  return Array.isArray(manifest?.pots) ? manifest.pots : []
}

/** Frozen, informational-only entries. Empty when the manifest has no `legacy` key. */
export function legacyPots(manifest) {
  return Array.isArray(manifest?.legacy) ? manifest.legacy : []
}

export const DEFAULT_REQUIRED_SLUG = 'mumega'

/**
 * The deployment slug the staleness check requires in `pots`.
 * Precedence: env `STALENESS_REQUIRED_SLUG` (non-empty) > manifest top-level
 * `required_slug` > 'mumega'. Self-hosted forks whose primary pot is not
 * `mumega` set one of the first two instead of failing every run (#2109).
 * An invalid manifest `required_slug` is NOT resolved here: validateManifest
 * reports it and the run fails closed.
 */
export function resolveRequiredSlug(manifest, env = {}) {
  const fromEnv = typeof env?.STALENESS_REQUIRED_SLUG === 'string' ? env.STALENESS_REQUIRED_SLUG.trim() : ''
  if (fromEnv) return fromEnv
  const fromManifest = manifest?.required_slug
  if (typeof fromManifest === 'string' && fromManifest.trim()) return fromManifest.trim()
  return DEFAULT_REQUIRED_SLUG
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasSlug = (v) => isPlainObject(v) && typeof v.slug === 'string' && v.slug.length > 0

/**
 * Structural validation, one rule for every consumer. Returns a list of
 * human-readable errors (empty = valid). Consumers FAIL CLOSED on any error:
 * staleness-check exits 1, mupot-update refuses.
 *
 * `requiredSlug` (default 'mumega'; see resolveRequiredSlug): the deployment that must be in `pots`.
 * Pass `null` to skip that check (mupot-update only needs structural sanity).
 */
export function validateManifest(manifest, { requiredSlug = 'mumega' } = {}) {
  const errors = []
  if (manifest?.required_slug !== undefined && (typeof manifest.required_slug !== 'string' || !manifest.required_slug.trim())) {
    errors.push('manifest: required_slug must be a non-empty string')
  }
  const pots = manifest?.pots
  if (!Array.isArray(pots) || pots.length === 0) {
    errors.push('manifest: no deployment pots — refusing to report green')
  } else {
    pots.forEach((p, i) => {
      if (!hasSlug(p)) errors.push(`manifest: pots[${i}] is malformed (no slug)`)
    })
    if (requiredSlug && !pots.some((p) => hasSlug(p) && p.slug === requiredSlug)) {
      errors.push(`manifest: deployment pots do not include '${requiredSlug}' — refusing to report green`)
    }
  }
  const legacy = manifest?.legacy
  if (legacy !== undefined) {
    if (!Array.isArray(legacy)) {
      errors.push('manifest: legacy is not an array')
    } else {
      const deploySlugs = new Set((Array.isArray(pots) ? pots : []).filter(hasSlug).map((p) => p.slug))
      legacy.forEach((p, i) => {
        if (!hasSlug(p)) {
          errors.push(`manifest: legacy[${i}] is malformed (no slug)`)
          return
        }
        if (p.status !== 'frozen') errors.push(`manifest: legacy '${p.slug}' must have status "frozen"`)
        if (deploySlugs.has(p.slug)) errors.push(`manifest: slug '${p.slug}' is in both pots and legacy`)
      })
    }
  }
  return errors
}

/**
 * Resolve a mupot-update target (`--all` or a slug) against DEPLOYMENT entries
 * only. Legacy entries are never targets: `--all` skips them (named in
 * `skippedLegacy`), and naming one explicitly is an error.
 *
 * @returns {{ targets: object[], skippedLegacy: string[], error: string|null }}
 */
export function resolveUpdateTargets(manifest, target) {
  const all = deploymentPots(manifest)
  const legacy = legacyPots(manifest)
  const legacySlugs = legacy.map((p) => p?.slug)
  // Only `--all` silently passes over legacy entries, so only `--all` reports skips.
  const skippedLegacy = target === '--all' ? legacySlugs : []
  // Fail closed on structural problems (slug in both lists, malformed/unfrozen legacy).
  const invalid = validateManifest(manifest, { requiredSlug: null }).filter((e) => !e.startsWith('manifest: no deployment pots'))
  if (invalid.length > 0) {
    return { targets: [], skippedLegacy, error: invalid.join('; ') }
  }
  if (target !== '--all' && legacySlugs.includes(target)) {
    return {
      targets: [],
      skippedLegacy,
      error: `'${target}' is a frozen legacy pot (#2107) — mupot-update does not deploy legacy pots.`,
    }
  }
  const targets = target === '--all' ? all : all.filter((p) => p.slug === target)
  if (targets.length === 0) {
    return {
      targets,
      skippedLegacy,
      error: `unknown pot '${target}'. Known: ${all.map((p) => p.slug).join(', ')}`,
    }
  }
  return { targets, skippedLegacy, error: null }
}
