// Client-only fallback for the consent screen when no eligible agent hint or unique pending request exists.
// `many` suggests "A chat you drive"; `one` suggests "Background agent". This function only
// chooses the first tab; background-agent-consent.ts owns agent defaults and the POST validates consent.
// Client names and redirect hosts are presentation hints, never authority.

export const CHAT_CONSENT_LABEL = 'A chat you drive'
export const BACKGROUND_CONSENT_LABEL = 'Background agent'

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
