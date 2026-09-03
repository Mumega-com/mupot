// src/fleet/runtimes.ts — the ONE vocabulary for "what harness is this agent running on".
//
// WHY THIS FILE EXISTS. The set was declared twice — `VALID_RUNTIMES` in
// src/fleet/attach-routes.ts and `RUNTIMES` in src/fleet/registry.ts — and the two
// copies had ALREADY diverged: the registry list carried `''` and the attach list did
// not. Two definitions of one vocabulary, drifting silently, on the field that says what
// a thing IS.
//
// It cost something real on 2026-09-03. Athena's harness moved from Codex to grok, and
// `grok` was not in either list. The registry offered her two options: report a false
// runtime, or report nothing. She reported nothing, so her row kept saying `pi` while
// presence kept `last_reported_at` fresh — the timestamp vouching for a field it had
// never checked. Nobody reading mupot could tell which model was gating their PRs, which
// is a bad property for an audit trail.
//
// A closed vocabulary on a fast-moving field will always lag reality. The lag is
// acceptable; being unable to SAY you lag is not. So: one list, and a refusal that names
// the whole vocabulary so a caller who cannot describe itself learns why immediately
// instead of going quiet.

/** Canonical harness/runtime values. Extend HERE, once, when a new harness appears. */
export const RUNTIME_VALUES = [
  'codex',
  'claude-code',
  'grok',        // added 2026-09-03: Athena's harness moved to grok and could not say so
  'nous',
  'hermes',
  'hermes-cron',
  'systemd-user',
  'tmux',
  'python',
  'pi',
  'prime-agent',
  'herdr',
] as const

export type RuntimeValue = (typeof RUNTIME_VALUES)[number]

/** The same vocabulary as a Set, for consumers that take one (signed-attach verifier).
 *  Exported so the signed path validates against the SAME list as the bearer path —
 *  a signed request must not be able to claim a runtime a bearer request cannot. */
export const RUNTIME_SET: ReadonlySet<string> = new Set<string>(RUNTIME_VALUES)

/** Attach paths: a runtime must be named, and named from the vocabulary. */
export function isValidRuntime(v: unknown): v is RuntimeValue {
  return typeof v === 'string' && RUNTIME_SET.has(v)
}

/** Daemon-report path additionally accepts '' — a report that declines to claim a
 *  runtime, which is different from claiming a wrong one. Kept as an explicit,
 *  named difference rather than as a divergent copy of the list. */
export function isValidRuntimeOrUnset(v: unknown): v is RuntimeValue | '' {
  return v === '' || isValidRuntime(v)
}

/** For refusals: the vocabulary, so the caller is told what it MAY say. A 400 that
 *  withholds the valid values teaches the caller nothing and invites silence. */
export function runtimeVocabulary(): string {
  return RUNTIME_VALUES.join('|')
}
