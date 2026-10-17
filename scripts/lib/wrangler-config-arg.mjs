// scripts/lib/wrangler-config-arg.mjs — the ONE place that recognizes wrangler's `--config`
// flag, in every spelling real wrangler 4.102.0 accepts: `--config <path>`,
// `--config=<path>`, `-c <path>`, `-c=<path>`, and the fused short form `-c<path>`
// (confirmed live against `npx wrangler deploy --dry-run`, mupot#1529 round-1 P1-1).
//
// mupot#1524 round-2 P1-2 (this file's first fix): scripts/deploy.mjs's own
// config-detection matched ONLY the first spelling. mupot#1529 round-1 P1-1 (this fix):
// the matcher STILL covered only 3 of the 5 spellings real wrangler accepts — `-c=X` and
// `-cX` both resolve real wrangler to a DIFFERENT config than repo-default, and this
// matcher returned null for both, so scripts/deploy.mjs's `peekConfigArg` never detected a
// config was requested at all: the post-deploy publish step built and published the
// REPO-DEFAULT config's bundle under the RIGHT config's just-stamped RELEASE_SHA —
// self-consistent digest, wrong bytes, no error anywhere. Third round of this exact class
// on this file; the durable fix (scripts/deploy.mjs) stops re-deriving wrangler's grammar
// piecemeal: it resolves the config path ONCE via `resolveAndStripConfigArg` below, strips
// whichever spelling was used, and re-emits a single canonical `--config <path>` downstream
// to wrangler/build/publish/verify alike — this matcher's job is only to correctly EXTRACT
// the intended value from any spelling, never to replicate wrangler's own parser quirks.
//
// FUSED-FORM CAVEAT (verified live, 2026-09-22): wrangler's own yargs parser only reliably
// accepts a fused `-c<path>` when `<path>` does not begin with an alphanumeric character
// (`-c/abs/path.toml` works; `-cwrangler.acme.toml` errors `Unknown arguments: w, r, a, n,
// g, l` — yargs treats the letters as bundled short flags). This matcher does NOT need to
// replicate that quirk: every consumer here (this file, scripts/build-pot-worker-bundle.mjs,
// scripts/publish-pot-bundle.mjs, and scripts/deploy.mjs's resolveAndStripConfigArg call)
// re-emits a canonical `--config <path>` downstream rather than forwarding the fused token
// raw — so recognizing `-cwrangler.acme.toml` here and rewriting it to `--config
// wrangler.acme.toml` downstream is strictly an improvement over the old byte-forward
// design, never a compatibility risk.
//
// `--` END-OF-OPTIONS (mupot#1529 round-1 P1-1): wrangler treats a bare `--` as
// end-of-options — anything after it is positional/passthrough, never one of wrangler's own
// flags. `['--', '--config', 'x']` must resolve to "no config flag", matching wrangler's own
// behavior (confirmed live: wrangler ignores a `--config` appearing after a bare `--`).
// `findLastConfigMatch` below stops scanning at the first bare `--` token; everything from
// there onward is left untouched by `resolveAndStripConfigArg`'s `rest`.

/**
 * If `argv[i]` is one of the five recognized `--config`/`-c` spellings, returns
 * `{ value, consumed }` — `value` is the config path, `consumed` is how many argv entries
 * this flag occupies (1 for every single-token form: `--config=<path>`, `-c=<path>`,
 * `-c<path>`; 2 for the two space-separated forms: `--config <path>`, `-c <path>`).
 * Returns `null` for anything else, INCLUDING:
 *   - a bare trailing `--config`/`-c` with no following value,
 *   - a bare trailing `-c=` or `-c` with nothing after the fused prefix, and
 *   - a value that itself starts with `-` in ANY spelling (`--config --dry-run=false`,
 *     `--config=--x`, `-c=--x`, `-c-x`) — mupot#1524 round-2 P2-2, extended to every
 *     spelling here: a caller can never smuggle a second flag in as if it were a config
 *     path, and a value re-emitted downstream as `--config <value>` must never itself look
 *     like a flag to whatever parses that downstream invocation.
 * In every `null` case, the caller's own "unrecognized/incomplete argument" handling
 * applies instead of silently consuming (or misinterpreting) the token.
 */
export function matchConfigFlag(argv, i) {
  const a = argv[i]
  if (typeof a !== 'string') return null

  if (a === '--config' || a === '-c') {
    return matchSeparateValue(argv[i + 1])
  }
  if (a.startsWith('--config=')) {
    return matchFusedValue(a.slice('--config='.length))
  }
  if (a.startsWith('-c=')) {
    return matchFusedValue(a.slice('-c='.length))
  }
  if (a.startsWith('-c') && a.length > 2) {
    return matchFusedValue(a.slice('-c'.length))
  }
  return null
}

/** Space-separated form: `--config <value>` / `-c <value>`. Consumes 2 argv entries. */
function matchSeparateValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) return null
  return { value, consumed: 2 }
}

/** Single-token form: `--config=<value>` / `-c=<value>` / `-c<value>`. Consumes 1. */
function matchFusedValue(value) {
  if (value.length === 0 || value.startsWith('-')) return null
  return { value, consumed: 1 }
}

/**
 * Scans `argv` for the config flag in any recognized spelling, respecting a bare `--`
 * end-of-options marker: nothing AT or AFTER the first bare `--` token is ever considered.
 * Last occurrence before any `--` wins (matches how a repeated CLI flag is conventionally
 * resolved). Returns `{ index, consumed, value }` for the winning match, or `null`.
 */
function findLastConfigMatch(argv) {
  const args = Array.isArray(argv) ? argv : []
  let found = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break
    const m = matchConfigFlag(args, i)
    if (m) {
      found = { index: i, ...m }
      i += m.consumed - 1
    }
  }
  return found
}

/**
 * Read-only scan: finds the config path anywhere in `argv` in any of the five spellings,
 * WITHOUT mutating or requiring the array to be stripped — for a caller that must forward
 * `argv` to `wrangler` unchanged and only needs to know WHICH config was requested. Never
 * matches at or after a bare `--`. Returns `null` if no config flag is present.
 */
export function peekConfigArg(argv) {
  const m = findLastConfigMatch(argv)
  return m ? m.value : null
}

/**
 * Resolves the config path ONCE and strips its tokens out of `argv`, returning
 * `{ configPath, rest }`. `rest` is `argv` with ONLY the winning config flag's token(s)
 * removed — everything else, including a bare `--` and anything after it, is preserved
 * byte-identical and in original order. `configPath` is `null` when no config flag is
 * present (or only one appears after a bare `--`, which is ignored per wrangler's own
 * end-of-options semantics).
 *
 * This is the durable fix for mupot#1529 round-1 P1-1: scripts/deploy.mjs previously
 * FORWARDED `extra` to `wrangler deploy` byte-for-byte while separately PEEKING a config
 * path for the downstream publish step — two independent readings of the same argv that
 * could (and did) disagree whenever the peek missed a spelling the forward-path's own
 * wrangler invocation still understood. Resolving once, stripping, and re-emitting a single
 * canonical `--config <path>` to EVERY downstream consumer (wrangler itself, build,
 * publish, verify) makes that class of disagreement structurally impossible: there is only
 * ever one resolved value and one spelling from here on.
 */
export function resolveAndStripConfigArg(argv) {
  const args = Array.isArray(argv) ? argv : []
  const m = findLastConfigMatch(args)
  if (!m) return { configPath: null, rest: args.slice() }
  const rest = [...args.slice(0, m.index), ...args.slice(m.index + m.consumed)]
  return { configPath: m.value, rest }
}
