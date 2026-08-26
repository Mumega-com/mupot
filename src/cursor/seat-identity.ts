// Exact 7-axis seat declaration injected into Cursor Cloud starting prompts.
// Leaf module on purpose: dashboard/studio and MCP tools import this without
// pulling the control-plane write path (src/cursor/dispatch.ts).

export const CURSOR_CLOUD_SEAT = 'cursor-builder'
export const CURSOR_CLOUD_HARNESS = 'cursor-cloud'
export const CURSOR_CLOUD_MODEL = 'claude-3-7-sonnet'
export const CURSOR_CLOUD_PROVIDER = 'anthropic'
export const CURSOR_CLOUD_EFFORT = 'high'
export const CURSOR_CLOUD_MACHINE = 'cursor-cloud-vm'

const SEAT_IDENTITY_MARKER = 'Identity: You are Cursor Cloud Flight Agent.'

export function sevenAxisCheckInDeclaration(flightId: string, seat = CURSOR_CLOUD_SEAT): string {
  return `${SEAT_IDENTITY_MARKER} On start, invoke check_in({ seat: "${seat}", harness: "${CURSOR_CLOUD_HARNESS}", machine: "${CURSOR_CLOUD_MACHINE}", model: "${CURSOR_CLOUD_MODEL}", provider: "${CURSOR_CLOUD_PROVIDER}", effort: "${CURSOR_CLOUD_EFFORT}", flight_id: "${flightId}" })`
}

/** Prepend the exact 7-axis seat declaration. Idempotent if already injected. */
export function injectSevenAxisSeatDeclaration(prompt: string, flightId: string): string {
  const trimmed = prompt.trim()
  const identity = sevenAxisCheckInDeclaration(flightId)
  if (trimmed.includes(SEAT_IDENTITY_MARKER)) return trimmed
  return `${identity}\n\n${trimmed}`
}
