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
  const skippedLegacy = legacy.map((p) => p.slug)
  if (target !== '--all' && !all.some((p) => p.slug === target) && skippedLegacy.includes(target)) {
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
