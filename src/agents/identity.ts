// Maps an opaque Durable Object instance to Mupot's stable logical agent id.
// Cloudflare's ctx.id is intentionally opaque and cannot be reversed to the
// name supplied to idFromName(), so callers must provide the logical id once.

export type AgentIdentityResolution =
  | { ok: true; agentId: string; bind: boolean }
  | { ok: false; error: 'agent_identity_required' | 'agent_identity_mismatch' }

export function resolveAgentIdentity(
  boundAgentId: string | null,
  suppliedAgentId: unknown,
): AgentIdentityResolution {
  const supplied = typeof suppliedAgentId === 'string' ? suppliedAgentId.trim() : ''

  if (boundAgentId) {
    if (supplied && supplied !== boundAgentId) {
      return { ok: false, error: 'agent_identity_mismatch' }
    }
    return { ok: true, agentId: boundAgentId, bind: false }
  }

  if (!supplied) return { ok: false, error: 'agent_identity_required' }
  return { ok: true, agentId: supplied, bind: true }
}
