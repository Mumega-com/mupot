// scripts/lib/wrangler-config-arg.mjs — the ONE place that recognizes wrangler's `--config`
// flag, in every spelling wrangler itself accepts: `--config <path>`, `--config=<path>`,
// and the short form `-c <path>` (confirmed live via `npx wrangler r2 object put --help`,
// which lists `-c, --config  Path to Wrangler configuration file`).
//
// Kasra-core round-2 adversarial finding (2026-09-22, P1-2): scripts/deploy.mjs's own
// config-detection matched ONLY the first spelling (`extra.indexOf('--config')`). A real
// deploy run with `-c wrangler.acme.toml` or `--config=wrangler.acme.toml` would silently
// forward that flag to `wrangler deploy` unchanged (which deploys the RIGHT config) while
// the post-deploy bundle-publish step detected NO config at all — building and publishing
// the DEFAULT config's bundle under the RELEASE_SHA the RIGHT config's deploy just
// stamped. Self-consistent digest, wrong bytes, no error anywhere. Used by BOTH
// scripts/deploy.mjs (which only PEEKS the value — it must forward argv to `wrangler
// deploy` byte-for-byte, unstripped) and scripts/build-pot-worker-bundle.mjs (which
// ALLOWLISTS its own argv against this shape, refusing anything else — see that script's
// own header for why an unrestricted argv-forward is itself a defect class).

/**
 * If `argv[i]` is one of the three recognized `--config`/`-c` spellings, returns
 * `{ value, consumed }` — `value` is the config path, `consumed` is how many argv entries
 * this flag occupies (1 for the `--config=<path>` single-token form, 2 for the two
 * space-separated forms). Returns `null` for anything else, INCLUDING:
 *   - a bare trailing `--config`/`-c` with no following value, and
 *   - a value that itself starts with `-` (`--config --dry-run=false`, `--config=--x`) —
 *     mupot#1524 round-2 P2-2: a caller can never smuggle a second flag in as if it were a
 *     config path this way. `build-pot-worker-bundle.mjs`'s ALLOWLIST is only as strong as
 *     this shared matcher — before this fix, `--config --help` matched `--help` as the
 *     config VALUE, forwarding `--config --help` to `wrangler deploy --dry-run`, which
 *     printed wrangler's own help text and exited 0 (looked like a successful dry-run
 *     build; built no bundle at all).
 * In every `null` case, the caller's own "unrecognized/incomplete argument" handling
 * applies instead of silently consuming (or misinterpreting) the token.
 */
export function matchConfigFlag(argv, i) {
  const a = argv[i]
  if (a === '--config' || a === '-c') {
    const value = argv[i + 1]
    if (typeof value !== 'string' || value.startsWith('-')) return null
    return { value, consumed: 2 }
  }
  if (typeof a === 'string' && a.startsWith('--config=')) {
    const value = a.slice('--config='.length)
    if (value.startsWith('-')) return null
    return { value, consumed: 1 }
  }
  return null
}

/**
 * Read-only scan: finds the config path anywhere in `argv` in any of the three spellings,
 * WITHOUT mutating or requiring the array to be stripped — for a caller that must forward
 * `argv` to `wrangler` unchanged and only needs to know WHICH config was requested. Last
 * occurrence wins (matches how a repeated CLI flag is conventionally resolved). Returns
 * `null` if no config flag is present.
 */
export function peekConfigArg(argv) {
  let found = null
  for (let i = 0; i < argv.length; i++) {
    const m = matchConfigFlag(argv, i)
    if (m) {
      found = m.value
      i += m.consumed - 1
    }
  }
  return found
}
