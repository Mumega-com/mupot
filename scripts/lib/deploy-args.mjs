// scripts/lib/deploy-args.mjs — parses scripts/deploy.mjs's OWN two flags
// (`--skip-bundle-publish` and `--skip-reason <reason>`) out of argv, leaving
// everything else untouched for byte-identical forwarding to `wrangler deploy`.
//
// Extracted (mupot#1524 round-2 P0, successor PR) so this specific piece of argv-walking
// logic can be unit-tested directly, in isolation from spawning wrangler at all.
//
// THE BUG THIS REPLACES: the inline version in scripts/deploy.mjs computed
//   `const skipReasonFlagIndex = rawArgs.indexOf('--skip-reason')`
// and then filtered `extra` with
//   `i !== skipReasonFlagIndex + 1`
// When `--skip-reason` is ABSENT (the common case), `indexOf` returns `-1`, so the
// filter condition becomes `i !== 0` — silently dropping `rawArgs[0]` on EVERY deploy
// that doesn't pass `--skip-reason`. A deploy invoked as
//   `npm run deploy -- --config=wrangler.acme.toml`
// forwarded NOTHING to `wrangler deploy` — wrangler fell back to reading the repo-default
// `wrangler.toml` instead of the acme colony's config, deployed successfully, exit 0,
// with no error anywhere. Confirmed present at mupot#1524 commit 8d8d7af2 / 1dc9a0b5.
//
// THE FIX: walk `rawArgs` once with an explicit, single-pass index. The "skip the next
// token" behavior for `--skip-reason <value>` only ever triggers INSIDE the loop, the one
// time the loop actually sees the `--skip-reason` token — never derived from a search
// result that can come back `-1`.
//
// A `--skip-reason` value that itself looks like a flag (starts with `-`) is refused as a
// likely-missing-value rather than silently absorbed as the reason text (mupot#1524
// round-2 Low: `--skip-reason --flag` must not accept `--flag` as the reason) — the token
// is left in place for `extra` and `skipReason` stays `null`, which
// `scripts/deploy.mjs`'s own `--skip-bundle-publish requires --skip-reason` check then
// refuses with its existing message.

/**
 * @param {string[]} rawArgs — `process.argv.slice(2)`.
 * @returns {{ skipBundlePublish: boolean, skipReason: string | null, extra: string[] }}
 *   `extra` is every OTHER argv entry, in original order, completely unchanged — this is
 *   what gets forwarded to `wrangler deploy` byte-for-byte.
 */
export function parseDeployArgs(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : []
  let skipBundlePublish = false
  let skipReason = null
  const extra = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--skip-bundle-publish') {
      skipBundlePublish = true
      continue
    }
    if (arg === '--skip-reason') {
      const value = args[i + 1]
      if (typeof value === 'string' && !value.startsWith('-')) {
        skipReason = value
        i++ // consume the value token too — it belongs to THIS flag, never to `extra`.
      }
      // else: no value, or the next token looks like a flag — leave skipReason as null
      // (refused downstream) and do NOT consume the next token, so a flag masquerading
      // as a reason is never silently absorbed into this flag's value.
      continue
    }
    extra.push(arg)
  }

  return { skipBundlePublish, skipReason, extra }
}
