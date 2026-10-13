// The consent screen's first question: "How will this app connect?" This module holds the ONE place that decides which
// answer to SUGGEST. It is wording/ordering only: nothing here grants anything, and the human still has to choose
// explicitly (the radio is never pre-checked: tests/agent-bound-oauth-consent.test.ts "zero silent welds").
//
//   many : "Many chats: each chat picks its agent"  -> the harness path (HARNESS_CONSENT_VALUE)
//   one  : "One agent: this whole app is one agent" -> the bound path (e.g. Muse, a single bot)
//
// Multi-thread clients (a chat app / coding tool with many simultaneous threads) default to `many`; everything else
// defaults to `one`. The client NAME and redirect host are attacker-chosen at DCR time, so this is a suggestion that
// can only steer which tab opens first, never what is granted.

export type ConnectMode = 'many' | 'one'

/** Client-name patterns of apps that run many threads through one connection. Extend here and nowhere else. */
export const MULTI_CHAT_NAME_PATTERNS: readonly RegExp[] = [/chatgpt/i, /openai/i, /claude/i, /anthropic/i, /cursor/i, /grok/i, /\bxai\b/i]

/** Redirect hosts (exact or any subdomain) of the same apps. */
export const MULTI_CHAT_REDIRECT_HOSTS: readonly string[] = ['chatgpt.com', 'chat.openai.com', 'openai.com', 'claude.ai', 'claude.com', 'cursor.com', 'cursor.sh', 'grok.com', 'x.ai']

function hostOf(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  try {
    return new URL(uri).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function suggestedConnectMode(c: { clientName?: unknown; redirectUri?: unknown }): ConnectMode {
  const host = hostOf(c.redirectUri)
  if (host && MULTI_CHAT_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'many'
  const name = typeof c.clientName === 'string' ? c.clientName : ''
  if (name && MULTI_CHAT_NAME_PATTERNS.some((re) => re.test(name))) return 'many'
  return 'one'
}
