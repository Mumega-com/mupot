// src/mcp/refusal-next-step.ts — a teaching line for the generic MCP tool refusals.
//
// WHY. The two refusals every new agent hits first, on every door, are the capability floor
// (`forbidden { need }`, src/mcp/index.ts invokeTool) and `not_agent_bound`. Both arrived as a bare
// code: the agent learned WHAT it lacked and nothing about the route that would give it to it, and
// the route differs per door (a chat attaches with a passkey, a CLI agent needs a minted token, a
// directory session never gains access from a grant). boot_context already holds that map; this line
// only points at it, so there is one source of truth and the line cannot drift from it.
//
// PRESENTATION ONLY. This module never decides anything: the status, the error code and the refused
// set are untouched, and the text is static (no tenant, agent, scope or target is interpolated), so a
// refusal teaches a stranger nothing about what exists. The field is added to the MCP envelope only
// (mcpToolRefusalResult); REST /actions keeps its plain body.

const BOOT_MAP = 'Call boot_context and follow its next_step, available_doors and channel_limits: they name the route that applies to THIS session.'

/** A refusal whose detail already teaches (a hint, a reason, its own next_step) is never overwritten. */
function alreadyTeaches(detail: unknown): boolean {
  if (typeof detail !== 'object' || detail === null) return false
  return 'next_step' in detail || 'hint' in detail || 'reason' in detail
}

/**
 * The next step for a generic refusal, or undefined when the refusal has no universal one (the
 * tool's own detail is then the teaching surface).
 */
export function refusalNextStep(error: string, status: number, detail: unknown): string | undefined {
  if (alreadyTeaches(detail)) return undefined
  if (status === 403 && error === 'forbidden' && typeof detail === 'object' && detail !== null && 'need' in detail) {
    return `This session does not hold the capability this needs on that target (need). ${BOOT_MAP} Getting a capability is a human act: an org admin for a workspace token, your human's passkey tap for an attached chat. A squad grant does not help a directory (chat connector) session.`
  }
  if (status === 403 && (error === 'not_agent_bound' || error === 'agent_bound_credential_required')) {
    return `This tool needs an agent-bound credential and this session is not one. ${BOOT_MAP} A CLI or daemon agent needs an org admin to mint it an agent-bound workspace token.`
  }
  if (status === 403 && error === 'seat_required') {
    return `seat_attach is only for a chat thread that has a seat, and this session has none. ${BOOT_MAP} A workspace bearer (CLI or daemon) does not attach: it acts as the agent its token is bound to, or an org admin must mint it one. A connector chat consented to ONE agent already is that agent. Do not call seat_select to get around this.`
  }
  if (status === 403 && (error === 'seat_attach_disabled' || error === 'seat_auto_enroll_disabled')) {
    return `This pot has not enabled that feature, so retrying will not help. ${BOOT_MAP}`
  }
  if (status === 429 && error === 'rate_limited') {
    return 'You hit a rate or budget limit. Stop retrying in a loop: wait, then try again once.'
  }
  return undefined
}
