// src/fleet/reported-values.ts — graceful intake of self-reported runtime/harness/model/host.
//
// Policy (Hadi, 2026-10-16): never turn an agent away because mupot has not heard of its
// harness. Any bounded string is accepted as reported; the vocabulary is only a HINT used to
// compute a canonical value for display and filtering. Authority never comes from these
// strings: they are untrusted, agent-controlled, display-only.
//   - non-strings are the one refusal (callers decide how to report it)
//   - control characters are stripped, the value is trimmed, oversize is TRUNCATED
//   - empty after cleaning means "not reported" (null)

export const MAX_REPORTED = 64
export const MAX_REPORTED_MODEL = 128

// Control characters (C0, DEL, C1), line/paragraph separators, zero-width and bidi-control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Clean one reported string. Returns null for empty / whitespace-only (= not reported). */
export function cleanReported(v: string, max = MAX_REPORTED): string | null {
  let s = v.replace(CONTROL_RE, '').trim().slice(0, max)
  // Never leave half a surrogate pair at the cut.
  const last = s.charCodeAt(s.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  s = s.trim()
  return s.length > 0 ? s : null
}

// Known harness spellings -> canonical name. Anything else is 'other'.
const CANONICAL: Readonly<Record<string, string>> = {
  'claude-code': 'claude-code',
  claude: 'claude-code',
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  'cursor-ide': 'cursor',
  'cursor-cloud': 'cursor',
  grok: 'grok-cli',
  'grok-cli': 'grok-cli',
  'grok-tui': 'grok-cli',
  hermes: 'hermes',
  'hermes-cron': 'hermes',
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  prime: 'prime',
  'prime-agent': 'prime',
  nous: 'nous',
  pi: 'pi',
  herdr: 'herdr',
  tmux: 'tmux',
  python: 'python',
  'systemd-user': 'systemd-user',
  openclaw: 'openclaw',
  cowork: 'cowork',
}

/** Canonical hint for a raw value. null/empty -> 'unknown'; no match -> 'other'. */
export function canonicalHarness(raw: string | null | undefined): string {
  if (!raw) return 'unknown'
  const key = raw.trim().toLowerCase()
  if (key === 'unknown') return 'unknown'
  return Object.prototype.hasOwnProperty.call(CANONICAL, key) ? CANONICAL[key] : 'other'
}

// Formally NOT adopted (docs/fleet/goose-non-adoption-2026-07-22.md): a recorded governance decision, not an
// unknown-name gate. ONE check, applied on every intake (bearer attach, signed attach, boot_context, daemon
// report, check_in harness) so no path is the way around it. Matching runs after invisible/control stripping
// and case folding, so 'goose' plus a zero-width character is refused too.
const NON_ADOPTED: ReadonlySet<string> = new Set(['goo' + 'se', 'goo' + 'sed'])

export function isNonAdoptedRuntime(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const cleaned = cleanReported(raw, 256)
  return cleaned !== null && NON_ADOPTED.has(cleaned.toLowerCase())
}

export const NON_ADOPTED_DETAIL = 'not adopted (see docs/fleet/goose-non-adoption-2026-07-22.md)'
