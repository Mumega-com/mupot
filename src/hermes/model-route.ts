// mupot — Hermes model-route (Port 3: Luna heartbeat → Sol reasoning → Opus wake).
//
// ECC model-route adapted to Mumega naming:
//   Luna ≈ cheap heartbeat / triage (Haiku-class)
//   Sol  ≈ frontier reasoning (Sonnet/GPT-5.6-sol)
//   Opus ≈ hard-call decider — we WAKE the live Kasra agent; we do not spend
//          Opus tokens from the Worker on every chat turn.
//
// Pure functions only. No I/O. The constant agent (src/hermes/constant.ts) owns
// when to call ModelPort vs wake.

export type HermesTier = 'luna' | 'sol' | 'opus'

/** Model ids passed to ModelPort when a tier actually chats. */
export const HERMES_TIER_MODELS: Readonly<Record<'luna' | 'sol', string>> = {
  luna: 'gpt-5.6-luna',
  sol: 'gpt-5.6-sol',
}

export interface HermesRouteDecision {
  tier: HermesTier
  /** Why this tier was chosen — audited into chat receipts / replies. */
  reason: string
  /** True when the constant agent must wake the Opus (Kasra) agent. */
  wakeOpus: boolean
}

const LUNA_PATTERNS: readonly RegExp[] = [
  /^(hi|hello|hey|yo|ping|pong)\b/i,
  /^(status|help|\?|thanks|thank you|ok|okay|gm|gn)\b/i,
  /^(good\s+(morning|afternoon|evening|night))\b/i,
]

const OPUS_PATTERNS: readonly RegExp[] = [
  /\b(architect|architecture|merge\s+to\s+main|force[\s-]?push|security\s+review|adversarial\s+gate|break[\s-]?glass|production\s+incident|hard\s+call)\b/i,
  /\b(wake\s+(kasra|opus)|escalate\s+to\s+(kasra|opus|me))\b/i,
  /\b(ship\s+to\s+prod|deploy\s+to\s+production|rotate\s+secrets?)\b/i,
]

/**
 * classifyHermesTurn — Luna-class triage with ZERO model spend.
 * Cheap patterns stay on Luna; hard-call patterns escalate to Opus wake;
 * everything else goes to Sol for real reasoning.
 */
export function classifyHermesTurn(text: string): HermesRouteDecision {
  const trimmed = text.trim()
  if (!trimmed) {
    return { tier: 'luna', reason: 'empty_message', wakeOpus: false }
  }
  if (trimmed.length <= 24 && LUNA_PATTERNS.some((re) => re.test(trimmed))) {
    return { tier: 'luna', reason: 'heartbeat_or_greeting', wakeOpus: false }
  }
  if (OPUS_PATTERNS.some((re) => re.test(trimmed))) {
    return { tier: 'opus', reason: 'hard_call_pattern', wakeOpus: true }
  }
  return { tier: 'sol', reason: 'needs_reasoning', wakeOpus: false }
}

/**
 * parseSolAction — Sol may emit a single structured trailer the constant agent
 * acts on. Fail-closed: unknown/malformed trailers are ignored (reply-only).
 *
 * Recognized trailers (last non-empty line):
 *   TASK: <title>
 *   WAKE_OPUS: <reason>
 */
export type SolAction =
  | { kind: 'none' }
  | { kind: 'task'; title: string }
  | { kind: 'wake_opus'; reason: string }

export function parseSolAction(solReply: string): SolAction {
  const lines = solReply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines[lines.length - 1]
  if (!last) return { kind: 'none' }

  const taskMatch = /^TASK:\s*(.+)$/i.exec(last)
  if (taskMatch) {
    const title = taskMatch[1].trim()
    if (!title || title.length > 200) return { kind: 'none' }
    return { kind: 'task', title }
  }

  const wakeMatch = /^WAKE_OPUS:\s*(.+)$/i.exec(last)
  if (wakeMatch) {
    const reason = wakeMatch[1].trim()
    if (!reason || reason.length > 300) return { kind: 'none' }
    return { kind: 'wake_opus', reason }
  }

  return { kind: 'none' }
}

/** Strip the structured trailer so the user-visible reply stays clean. */
export function stripSolActionTrailer(solReply: string): string {
  const action = parseSolAction(solReply)
  if (action.kind === 'none') return solReply.trim()
  const lines = solReply.split('\n')
  // Drop trailing blank lines, then the trailer line.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > 0) lines.pop()
  return lines.join('\n').trim()
}
