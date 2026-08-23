import type { AuthContext } from '../types'
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
           token.token_hash, token.expires_at
      FROM member_tokens token
      JOIN members member
        ON member.id = token.member_id
       AND member.tenant = token.tenant
      JOIN agents agent ON agent.id = token.agent_id
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
  return row
}

async function readExisting(
  env: MemberTokenFingerprintEnv,
  tokenId: string,
): Promise<TokenBindingAttestationRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, token_id, member_id, agent_id, channel,
           credential_fingerprint, issued_at, expires_at, created_at
      FROM token_binding_attestations
     WHERE tenant = ?1 AND token_id = ?2 AND channel = 'workspace'
     LIMIT 1
  `).bind(env.TENANT_SLUG, tokenId).first<TokenBindingAttestationRow>()
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

  const existing = await readExisting(env, token.token_id)
  if (existing) {
    if (
      existing.member_id !== token.member_id
      || existing.agent_id !== token.agent_id
      || existing.credential_fingerprint !== fingerprint
    ) {
      throw new AttestationError('attestation_conflict')
    }
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
         AND ${TOKEN_LIVE_PREDICATE('?8').replaceAll('t.', 'token.')}
         AND julianday(token.created_at) <= julianday(?8)
         AND token.token_hash = ?9
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
      nowSqlUtc(),
      token.token_hash,
    ).all<TokenBindingAttestationRow>()
    const rows = written.results ?? []
    if (rows.length !== 1) throw new AttestationError('workspace_token_required')
    return mapAttestation(rows[0])
  } catch (error) {
    if (error instanceof AttestationError) throw error
    const raced = await readExisting(env, token.token_id)
    if (
      raced
      && raced.member_id === token.member_id
      && raced.agent_id === token.agent_id
      && raced.credential_fingerprint === fingerprint
    ) {
      return mapAttestation(raced)
    }
    throw new AttestationError('attestation_conflict')
  }
}
