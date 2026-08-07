/**
 * Internal Hello World Module
 * Built by river-code; Audited internally by river-reviewer (Claude Sonnet/Opus)
 */

export interface HelloResponse {
  ok: boolean
  message: string
  timestamp: string
}

export function generateHelloWorld(name: string = 'World'): HelloResponse {
  if (!name || name.trim() === '') {
    throw new Error('Name parameter must be non-empty')
  }
  return {
    ok: true,
    message: `Hello, ${name.trim()}! Sovereign internal execution verified.`,
    timestamp: new Date().toISOString(),
  }
}
