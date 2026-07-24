import { canOnSquad, resolveCapabilities } from '../auth/capability'
import type { AuthContext, Env } from '../types'
import type { AgentConnectionReceipt } from './agent-connection'

interface CurrentAccessRow {
  squad_id: string
  membership_capability: string
  member_capability: string | null
}

export interface AgentConnectionPublicStatus {
  receipt_id: string
  request_id: string
  issuance: {
    agent: {
      id: string
      slug: string
      status_at_issue: string
      disposition: 'created' | 'reused'
    }
    credential_action: 'issue_if_missing' | 'add' | 'replace'
    home_squad_id: string
    home_capability: 'observer' | 'member'
    additional_access: Array<{ squadId: string; capability: string }>
    token_label: string
    token_id_suffix: string
    endpoint: string
    transport: 'streamable_http'
    credential_issued_at: string
  }
  verification: {
    status: 'pending' | 'pass' | 'fail' | 'expired'
    attempts: number
    client_connected_at: string | null
    messaging_verified_at: string | null
    error_code: string | null
    checks: Record<string, {
      status: 'pass' | 'fail'
      error?: string
    }>
  }
  current: {
    agent_status: string | null
    token_revoked: boolean
    access: Array<{
      squad_id: string
      membership_capability: string
      member_capability: string | null
      synchronized: boolean
    }>
  }
  updated_at: string
}

const SAFE_CHECK_ERRORS = new Set([
  'challenge_mismatch',
  'challenge_expired',
  'canonical_origin_unavailable',
  'orient_failed',
  'send_failed',
  'inbox_failed',
  'message_not_observed',
  'cleanup_failed',
])

function publicVerificationError(error: string | null): string | null {
  return error && SAFE_CHECK_ERRORS.has(error) ? error : null
}

function parseAdditionalAccess(
  raw: string,
): Array<{ squadId: string; capability: string }> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const value = entry as Record<string, unknown>
      return typeof value.squadId === 'string' && typeof value.capability === 'string'
        ? [{ squadId: value.squadId, capability: value.capability }]
        : []
    })
  } catch {
    return []
  }
}

function parseChecks(
  raw: string,
): AgentConnectionPublicStatus['verification']['checks'] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const checks: AgentConnectionPublicStatus['verification']['checks'] = {}
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || !/^[a-z_]{1,32}$/.test(name)
      ) continue
      const value = entry as Record<string, unknown>
      if (value.status !== 'pass' && value.status !== 'fail') continue
      const error = typeof value.error === 'string' && SAFE_CHECK_ERRORS.has(value.error)
        ? value.error
        : undefined
      checks[name] = {
        status: value.status,
        ...(error ? { error } : {}),
      }
    }
    return checks
  } catch {
    return {}
  }
}

async function callerMayPoll(
  env: Env,
  auth: AuthContext,
  receipt: AgentConnectionReceipt,
): Promise<boolean> {
  const issuedByCaller =
    (receipt.actor_kind === 'user' && auth.userId === receipt.actor_id)
    || (
      receipt.actor_kind === 'member'
      && auth.memberId === receipt.actor_id
    )
  if (issuedByCaller) return true

  // Legacy owner/admin web sessions remain org-admin principals. Everyone else
  // must hold CURRENT effective admin on the immutable home squad; department
  // and org inheritance are resolved by the canonical capability primitive.
  if (auth.role === 'owner' || auth.role === 'admin') return true
  if (!auth.memberId) return false
  const grants = auth.capabilities
    ?? await resolveCapabilities(env, auth.memberId)
  return canOnSquad(env, grants, receipt.home_squad_id, 'admin')
}

export async function loadAgentConnectionStatus(
  env: Env,
  auth: AuthContext,
  receiptId: string,
): Promise<
  | { ok: true; value: AgentConnectionPublicStatus }
  | { ok: false; error: 'not_found' }
> {
  if (
    auth.tenant !== env.TENANT_SLUG
    || typeof receiptId !== 'string'
    || receiptId.length < 1
  ) {
    return { ok: false, error: 'not_found' }
  }

  const receipt = await env.DB.prepare(
    `SELECT *
       FROM agent_connection_receipts
      WHERE tenant = ?
        AND id = ?
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, receiptId).first<AgentConnectionReceipt>()
  if (!receipt || !(await callerMayPoll(env, auth, receipt))) {
    return { ok: false, error: 'not_found' }
  }

  const [agent, token, accessResult] = await Promise.all([
    env.DB.prepare(
      'SELECT status FROM agents WHERE id = ? LIMIT 1',
    ).bind(receipt.agent_id).first<{ status: string }>(),
    env.DB.prepare(
      `SELECT revoked_at
         FROM member_tokens
        WHERE tenant = ?
          AND id = ?
          AND member_id = ?
          AND agent_id = ?
        LIMIT 1`,
    ).bind(
      env.TENANT_SLUG,
      receipt.token_id,
      receipt.member_id,
      receipt.agent_id,
    ).first<{ revoked_at: string | null }>(),
    env.DB.prepare(
      `SELECT m.squad_id AS squad_id,
              m.capability AS membership_capability,
              c.capability AS member_capability
         FROM memberships m
         LEFT JOIN capabilities c
           ON c.member_id = ?
          AND c.scope_type = 'squad'
          AND c.scope_id = m.squad_id
        WHERE m.agent_id = ?
        ORDER BY m.squad_id ASC`,
    ).bind(receipt.member_id, receipt.agent_id).all<CurrentAccessRow>(),
  ])

  return {
    ok: true,
    value: {
      receipt_id: receipt.id,
      request_id: receipt.request_id,
      issuance: {
        agent: {
          id: receipt.agent_id,
          slug: receipt.agent_slug,
          status_at_issue: receipt.agent_status_at_issue,
          disposition: receipt.agent_disposition,
        },
        credential_action: receipt.credential_action,
        home_squad_id: receipt.home_squad_id,
        home_capability: receipt.home_capability,
        additional_access: parseAdditionalAccess(receipt.additional_access_json),
        token_label: receipt.token_label,
        token_id_suffix: receipt.token_id.slice(-4),
        endpoint: receipt.endpoint,
        transport: receipt.transport,
        credential_issued_at: receipt.credential_issued_at,
      },
      verification: {
        status: receipt.verification_status,
        attempts: Number(receipt.verification_attempts),
        client_connected_at: receipt.client_connected_at,
        messaging_verified_at: receipt.messaging_verified_at,
        error_code: publicVerificationError(receipt.verification_error_code),
        checks: parseChecks(receipt.checks_json),
      },
      current: {
        agent_status: agent?.status ?? null,
        token_revoked: !token || token.revoked_at !== null,
        access: (accessResult.results ?? []).map((row) => ({
          squad_id: row.squad_id,
          membership_capability: row.membership_capability,
          member_capability: row.member_capability ?? null,
          synchronized: row.membership_capability === row.member_capability,
        })),
      },
      updated_at: receipt.updated_at,
    },
  }
}
