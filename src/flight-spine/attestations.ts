import type { AuthContext } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import {
  deriveSafeMemberTokenFingerprint,
  MemberTokenFingerprintError,
  type MemberTokenFingerprintEnv,
} from '../members/service'

export interface TokenBindingAttestation {
  id: string
  tenant: string
  tokenId: string
  memberId: string
  agentId: string
  channel: 'workspace'
  credentialFingerprint: string
  issuedAt: string
  expiresAt: string | null
  createdAt: string
}

export type AttestationErrorCode =
  | 'fingerprint_not_configured'
  | 'workspace_token_required'
  | 'attestation_conflict'

export class AttestationError extends Error {
  readonly name = 'AttestationError'

  constructor(readonly code: AttestationErrorCode) {
    super(code)
  }
}

interface LiveTokenBindingRow {
  token_id: string
  member_id: string
  agent_id: string
  token_hash: string
  expires_at: string | null
  squad_id: string
  department_id: string
}

interface TokenBindingAttestationRow {
  id: string
  tenant: string
  token_id: string
  member_id: string
  agent_id: string
  channel: 'workspace'
  credential_fingerprint: string
  issued_at: string
  expires_at: string | null
  created_at: string
}

interface AuthorizedTokenBindingAttestationRow extends TokenBindingAttestationRow {
  authority_ok: number
}

function mapAttestation(row: TokenBindingAttestationRow): TokenBindingAttestation {
  return {
    id: row.id,
    tenant: row.tenant,
    tokenId: row.token_id,
    memberId: row.member_id,
    agentId: row.agent_id,
    channel: row.channel,
    credentialFingerprint: row.credential_fingerprint,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function authenticatedWorkspaceFacts(
  env: MemberTokenFingerprintEnv,
  auth: AuthContext,
): { tokenId: string; memberId: string; agentId: string } {
  const tokenId = auth.tokenId?.trim() ?? ''
  const memberId = (auth.memberId ?? auth.userId).trim()
  const agentId = auth.boundAgentId?.trim() ?? ''
  if (
    auth.tenant !== env.TENANT_SLUG
    || auth.channel !== 'workspace'
    || tokenId === ''
    || memberId === ''
    || agentId === ''
  ) {
    throw new AttestationError('workspace_token_required')
  }
  return { tokenId, memberId, agentId }
}

async function readLiveTokenBinding(
  env: MemberTokenFingerprintEnv,
  auth: AuthContext,
): Promise<LiveTokenBindingRow> {
  const identity = authenticatedWorkspaceFacts(env, auth)
  const row = await env.DB.prepare(`
    SELECT token.id AS token_id, token.member_id, token.agent_id,
           token.token_hash, token.expires_at, agent.squad_id,
           squad.department_id
      FROM member_tokens token
      JOIN members member
        ON member.id = token.member_id
       AND member.tenant = token.tenant
      JOIN agents agent ON agent.id = token.agent_id
      JOIN squads squad ON squad.id = agent.squad_id
      JOIN memberships membership
        ON membership.agent_id = agent.id
       AND membership.squad_id = squad.id
      JOIN agent_member_bindings binding
        ON binding.tenant = token.tenant
       AND binding.agent_id = token.agent_id
       AND binding.member_id = token.member_id
     WHERE token.id = ?1
       AND token.tenant = ?2
       AND token.member_id = ?3
       AND token.agent_id = ?4
       AND token.channel = 'workspace'
       AND member.status = 'active'
       AND agent.status = 'active'
       AND CASE membership.capability
         WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
         WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
       AND ${TOKEN_LIVE_PREDICATE('?5').replaceAll('t.', 'token.')}
       AND julianday(token.created_at) <= julianday(?5)
     LIMIT 1
  `).bind(
    identity.tokenId,
    env.TENANT_SLUG,
    identity.memberId,
    identity.agentId,
    nowSqlUtc(),
  ).first<LiveTokenBindingRow>()
  if (!row) throw new AttestationError('workspace_token_required')

  // `auth.capabilities` is the request's ambient authority ceiling. When it is
  // present, an empty/observer view must stay denied even if D1 still contains a
  // stronger grant. A second live read is the revocation check and never widens
  // that ceiling.
  const effectiveGrants = auth.capabilities
    ?? (await resolveCapabilities(env, identity.memberId))
  if (!hasCapability(
    effectiveGrants,
    'squad',
    row.squad_id,
    'member',
    row.department_id,
  )) {
    throw new AttestationError('workspace_token_required')
  }
  const liveGrants = await resolveCapabilities(env, identity.memberId)
  if (!hasCapability(
    liveGrants,
    'squad',
    row.squad_id,
    'member',
    row.department_id,
  )) {
    throw new AttestationError('workspace_token_required')
  }
  return row
}

/**
 * Linearization point for immutable-attestation replay and insert-conflict
 * recovery. The row and its current authority verdict come from one SQLite
 * statement, so a preflight result can never authorize a later plain read.
 */
async function readExistingWithCurrentAuthority(
  env: MemberTokenFingerprintEnv,
  token: LiveTokenBindingRow,
  fingerprint: string,
): Promise<TokenBindingAttestationRow | null> {
  const row = await env.DB.prepare(`
    SELECT attestation.id, attestation.tenant, attestation.token_id,
           attestation.member_id, attestation.agent_id, attestation.channel,
           attestation.credential_fingerprint, attestation.issued_at,
           attestation.expires_at, attestation.created_at,
           CASE WHEN
             attestation.member_id = ?3
             AND attestation.agent_id = ?4
             AND attestation.credential_fingerprint = ?5
             AND (attestation.expires_at IS NULL
                  OR julianday(attestation.expires_at) > julianday('now'))
             AND EXISTS (
               SELECT 1
                 FROM member_tokens token
                 JOIN members member
                   ON member.id = token.member_id
                  AND member.tenant = token.tenant
                 JOIN agents agent ON agent.id = token.agent_id
                 JOIN squads squad ON squad.id = agent.squad_id
                 JOIN memberships membership
                   ON membership.agent_id = agent.id
                  AND membership.squad_id = squad.id
                 JOIN agent_member_bindings binding
                   ON binding.tenant = token.tenant
                  AND binding.agent_id = token.agent_id
                  AND binding.member_id = token.member_id
                WHERE token.id = attestation.token_id
                  AND token.tenant = attestation.tenant
                  AND token.member_id = attestation.member_id
                  AND token.agent_id = attestation.agent_id
                  AND token.channel = attestation.channel
                  AND token.id = ?2
                  AND token.tenant = ?1
                  AND token.member_id = ?3
                  AND token.agent_id = ?4
                  AND token.channel = 'workspace'
                  AND token.token_hash = ?6
                  AND member.status = 'active'
                  AND agent.status = 'active'
                  AND agent.squad_id = ?7
                  AND squad.id = ?7
                  AND squad.department_id = ?8
                  AND CASE membership.capability
                    WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                    WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
                  AND ${TOKEN_LIVE_PREDICATE("datetime('now')").replaceAll('t.', 'token.')}
                  AND julianday(token.created_at) <= julianday('now')
                  AND (
                    EXISTS (
                      SELECT 1 FROM capabilities capability
                       WHERE capability.member_id = member.id
                         AND (
                           capability.scope_type = 'org'
                           OR (capability.scope_type = 'department'
                             AND capability.scope_id = squad.department_id)
                           OR (capability.scope_type = 'squad'
                             AND capability.scope_id = squad.id)
                         )
                         AND CASE capability.capability
                           WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                           WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
                    )
                    OR EXISTS (
                      SELECT 1 FROM channel_capability_grants capability
                       WHERE capability.member_id = member.id
                         AND capability.squad_id = squad.id
                         AND CASE capability.capability
                           WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                           WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
                    )
                  )
             )
             THEN 1 ELSE 0 END AS authority_ok
      FROM token_binding_attestations attestation
     WHERE attestation.tenant = ?1
       AND attestation.token_id = ?2
       AND attestation.channel = 'workspace'
     LIMIT 1
  `).bind(
    env.TENANT_SLUG,
    token.token_id,
    token.member_id,
    token.agent_id,
    fingerprint,
    token.token_hash,
    token.squad_id,
    token.department_id,
  ).first<AuthorizedTokenBindingAttestationRow>()
  if (!row) return null
  if (
    row.member_id !== token.member_id
    || row.agent_id !== token.agent_id
    || row.credential_fingerprint !== fingerprint
  ) {
    throw new AttestationError('attestation_conflict')
  }
  if (Number(row.authority_ok) !== 1) {
    throw new AttestationError('workspace_token_required')
  }
  return row
}

/**
 * Issue or replay the immutable public attestation for the exact live workspace
 * token that authenticated this request. Identity fields are server-derived and
 * reread from D1; the token hash is used only inside the HMAC helper.
 */
export async function issueTokenBindingAttestation(
  env: MemberTokenFingerprintEnv,
  auth: AuthContext,
): Promise<TokenBindingAttestation> {
  const token = await readLiveTokenBinding(env, auth)
  let fingerprint: string
  try {
    fingerprint = await deriveSafeMemberTokenFingerprint(env, token.token_hash)
  } catch (error) {
    if (error instanceof MemberTokenFingerprintError) {
      throw new AttestationError('fingerprint_not_configured')
    }
    throw error
  }

  const existing = await readExistingWithCurrentAuthority(env, token, fingerprint)
  if (existing) {
    return mapAttestation(existing)
  }

  const id = crypto.randomUUID()
  const issuedAt = new Date().toISOString()
  try {
    const written = await env.DB.prepare(`
      INSERT INTO token_binding_attestations (
        id, tenant, token_id, member_id, agent_id, channel,
        credential_fingerprint, issued_at, expires_at, created_at
      )
      SELECT ?1, token.tenant, token.id, token.member_id, token.agent_id,
             'workspace', ?2, ?3, token.expires_at, ?3
        FROM member_tokens token
        JOIN members member
          ON member.id = token.member_id
         AND member.tenant = token.tenant
        JOIN agents agent ON agent.id = token.agent_id
        JOIN squads squad ON squad.id = agent.squad_id
        JOIN memberships membership
          ON membership.agent_id = agent.id
         AND membership.squad_id = squad.id
        JOIN agent_member_bindings binding
          ON binding.tenant = token.tenant
         AND binding.agent_id = token.agent_id
         AND binding.member_id = token.member_id
       WHERE token.id = ?4
         AND token.tenant = ?5
         AND token.member_id = ?6
         AND token.agent_id = ?7
         AND token.channel = 'workspace'
         AND member.status = 'active'
         AND agent.status = 'active'
         AND squad.id = ?9
         AND squad.department_id = ?10
         AND CASE membership.capability
           WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
           WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         AND (
           EXISTS (
             SELECT 1 FROM capabilities capability
              WHERE capability.member_id = member.id
                AND (
                  capability.scope_type = 'org'
                  OR (capability.scope_type = 'department'
                    AND capability.scope_id = squad.department_id)
                  OR (capability.scope_type = 'squad'
                    AND capability.scope_id = squad.id)
                )
                AND CASE capability.capability
                  WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                  WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
           )
           OR EXISTS (
             SELECT 1 FROM channel_capability_grants capability
              WHERE capability.member_id = member.id
                AND capability.squad_id = squad.id
                AND CASE capability.capability
                  WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                  WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
           )
         )
         AND ${TOKEN_LIVE_PREDICATE("datetime('now')").replaceAll('t.', 'token.')}
         AND julianday(token.created_at) <= julianday('now')
         AND token.token_hash = ?8
      RETURNING id, tenant, token_id, member_id, agent_id, channel,
                credential_fingerprint, issued_at, expires_at, created_at
    `).bind(
      id,
      fingerprint,
      issuedAt,
      token.token_id,
      env.TENANT_SLUG,
      token.member_id,
      token.agent_id,
      token.token_hash,
      token.squad_id,
      token.department_id,
    ).all<TokenBindingAttestationRow>()
    const rows = written.results ?? []
    if (rows.length !== 1) throw new AttestationError('workspace_token_required')
    return mapAttestation(rows[0])
  } catch (error) {
    if (error instanceof AttestationError) throw error
    const raced = await readExistingWithCurrentAuthority(env, token, fingerprint)
    if (raced) {
      return mapAttestation(raced)
    }
    throw new AttestationError('attestation_conflict')
  }
}
