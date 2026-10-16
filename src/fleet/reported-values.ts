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

// Control characters (C0, DEL, C1) and line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** Clean one reported string. Returns null for empty / whitespace-only (= not reported). */
export function cleanReported(v: string, max = MAX_REPORTED): string | null {
  const s = v.replace(CONTROL_RE, '').trim().slice(0, max).trim()
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
