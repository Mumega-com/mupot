// member-bearer — resolve a pot member-token (bearer) to its identity.
//
// Shared agent/member bearer resolution for non-MCP surfaces (e.g. fleet check-in).
// Mirrors the MCP auth path in src/mcp/index.ts (sha256 the token → look up a live,
// non-revoked member_token joined to an ACTIVE member). Tenant is environment-
// derived, never client-supplied.
//
// NOTE: src/mcp/index.ts has its own inline copy of this lookup. Once the in-flight
// #41 work lands, dedupe MCP's authenticateMember onto this helper. Kept separate
// for now to avoid editing that file mid-change.

import type { Env } from '../types'
import { resolveCapabilities, hasCapability } from './capability'

export interface AgentIdentity {
  memberId: string
  displayName: string
  email: string | null
  // The agent this token is BOUND to (member_tokens.agent_id), or null for a pure
  // human/operator principal. The weld between the member plane and the agent plane:
  // an agent-scoped token's holder IS that agent (orient/presence/attribution use it).
  boundAgentId: string | null
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Parse "Bearer <token>" → raw token, or null. Same shape as the MCP extractor.
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const tok = m[1].trim()
  return tok.length > 0 ? tok : null
}

// Resolve a raw bearer token to an identity, or null on any failure (no oracle —
// a missing token and a bad token are indistinguishable to the caller).
export async function resolveMemberByToken(env: Env, raw: string | null): Promise<AgentIdentity | null> {
  if (!raw) return null
  const tokenHash = await sha256Hex(raw)
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.display_name AS display_name, m.email AS email, m.status AS status,
            t.agent_id AS bound_agent_id, a.status AS bound_agent_status
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
       LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.token_hash = ?1
        AND t.tenant = ?2
        AND m.tenant = ?2
        AND t.revoked_at IS NULL
        AND (t.agent_id IS NULL OR (a.id IS NOT NULL AND a.status = 'active'))
      LIMIT 1`,
  )
    .bind(tokenHash, env.TENANT_SLUG)
    .first<{ member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null; bound_agent_status: string | null }>()
  if (!row || row.status !== 'active') return null
  return { memberId: row.member_id, displayName: row.display_name, email: row.email, boundAgentId: row.bound_agent_id ?? null }
}

// Resolve a bearer token to an ORG-ADMIN identity, or a refusal. Shared by the
// money/field-spending inbound surfaces (the #70 flight connector + the orient
// field-push) — the mind calls these as an org-admin service principal. 401 =
// missing/bad token (no auth oracle); 403 = valid token, not org-admin.
export async function resolveOrgAdmin(
  env: Env,
  authHeader: string | null | undefined,
): Promise<{ ok: true; id: AgentIdentity } | { ok: false; status: 401 | 403 }> {
  const id = await resolveMemberByToken(env, bearerToken(authHeader))
  if (!id) return { ok: false, status: 401 }
  const caps = await resolveCapabilities(env, id.memberId)
  if (!hasCapability(caps, 'org', null, 'admin')) return { ok: false, status: 403 }
  return { ok: true, id }
}
