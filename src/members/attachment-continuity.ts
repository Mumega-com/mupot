// Explicit R1 inbox-continuity scopes.  These are opaque routing selectors,
// never credentials: every reader/writer must use the guarded SQL below.
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { authorityLiveSql } from '../auth/attached-authority'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import type { Env } from '../types'
import { attachDesignatedClause } from './attach-designated'
import { LIVE_ATTACHMENT_FROM_SQL, liveAttachmentConditionsSql, seatTokenLiveSql, type LivePh } from './attach-live-sql'

export interface ContinuityScopeRow {
  id: string
  tenant: string
  admission_id: string
  agent_id: string
  human_member_id: string
  harness_id: string
  source_grant_token_id: string
  authority_decision_id: string
  created_at: string
  revoked_at: string | null
  revoked_by_member_id: string | null
}

/** All fields are server-resolved from the current physical attachment/auth context. */
export interface ContinuityRequest {
  attachmentId: string
  seatId: string
  agentId: string
  humanMemberId: string
  harnessId: string
  sourceGrantTokenId: string
  nowIso?: string
}

export type AttachmentContinuityResolution =
  | { kind: 'legacy' }
  | { kind: 'scope'; scope: ContinuityScopeRow; target: string }
  | { kind: 'refused'; reason: 'attachment_not_live' | 'scope_not_live' }

export interface ContinuityEnrollment {
  scopeId: string
  attachmentId: string
  admissionId: string
  agentId: string
  humanMemberId: string
  harnessId: string
  sourceGrantTokenId: string
  /** The fresh, one-use authority-decision row carrying the human's continuity opt-in. */
  authorityDecisionId: string
  /** Exact `agent_seat_admissions.decided_at` from the just-completed WebAuthn promotion. */
  promotedAt: string
  nowIso?: string
}

export function continuityTarget(scopeId: string): string {
  if (!scopeId || scopeId.includes(':')) throw new Error('invalid_continuity_scope_id')
  return `continuity:${scopeId}`
}

/** Shared writer guard: a live dedicated continuity harness is reserved for its enrolled agent. */
export function continuityHarnessReservationSql(nowExpr: string, harnessExpr: string, agentExpr: string, tenantExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM attachment_continuity_scopes reserved
    JOIN agent_seat_admissions reserved_adm ON reserved_adm.id = reserved.admission_id AND reserved_adm.tenant = reserved.tenant
    JOIN member_tokens reserved_grant ON reserved_grant.id = reserved.source_grant_token_id
    WHERE reserved.tenant = ${tenantExpr} AND reserved.harness_id = ${harnessExpr}
      AND reserved.agent_id <> ${agentExpr} AND reserved.revoked_at IS NULL
      AND reserved_adm.status = 'live' AND ${authorityLiveSql('reserved_adm', nowExpr)}
      AND reserved_grant.tenant = reserved.tenant AND reserved_grant.member_id = reserved.human_member_id
      AND reserved_grant.channel = 'directory' AND reserved_grant.agent_id IS NULL AND ${TOKEN_LIVE_PREDICATE(nowExpr, 'reserved_grant')}
  )`
}

/** Historical seats are conservative separation evidence, never caller identity. */
export function continuityHistoricalSeatsClearSql(tenantExpr: string, harnessExpr: string, agentExpr: string, prospectiveSeatExpr?: string): string {
  const missingTarget = prospectiveSeatExpr
    ? `(s.id IS NOT ${prospectiveSeatExpr}
        AND NOT EXISTS (
          SELECT 1 FROM agent_seat_attachments target
           WHERE target.tenant = s.tenant AND target.seat_id = s.id AND target.agent_id = ${agentExpr}
        ))`
    : `NOT EXISTS (SELECT 1 FROM agent_seat_attachments target WHERE target.tenant=s.tenant AND target.seat_id=s.id AND target.agent_id=${agentExpr})`
  return `NOT EXISTS (
    SELECT 1 FROM agent_seats s
     WHERE s.tenant = ${tenantExpr} AND s.harness_id = ${harnessExpr}
       AND (
         ${missingTarget}
         OR EXISTS (
           SELECT 1 FROM agent_seat_attachments other
            WHERE other.tenant = s.tenant AND other.seat_id = s.id AND other.agent_id <> ${agentExpr}
         )
       )
  )`
}

/**
 * Shared liveness predicate for a scope AND the physical request context.  It
 * deliberately composes the attachment chokepoint instead of recopying its
 * admission, grant, token, designation, weld, or authority rules.
 */
export function continuityScopeAuthoritySql(env: Env, ph: LivePh, scopeAlias = 'cs'): string {
  return `${liveAttachmentConditionsSql(env, ph)}
    AND ${scopeAlias}.tenant = att.tenant
    AND ${scopeAlias}.admission_id = att.admission_id
    AND ${scopeAlias}.agent_id = att.agent_id
    AND ${scopeAlias}.human_member_id = att.human_member_id
    AND ${scopeAlias}.harness_id = att.harness_id
    AND ${scopeAlias}.source_grant_token_id = ${ph('grantToken')}
    AND ${scopeAlias}.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM harnesses scope_hr
      JOIN member_tokens scope_grant ON scope_grant.id = ${scopeAlias}.source_grant_token_id
       WHERE scope_hr.id = ${scopeAlias}.harness_id AND scope_hr.tenant = ${scopeAlias}.tenant
         AND scope_hr.member_id = ${scopeAlias}.human_member_id
         AND scope_hr.credential_kind = 'oauth'
         AND scope_hr.grant_id = 'oauth:' || ${scopeAlias}.source_grant_token_id
         AND scope_grant.tenant = ${scopeAlias}.tenant AND scope_grant.member_id = ${scopeAlias}.human_member_id
         AND scope_grant.channel = 'directory' AND scope_grant.agent_id IS NULL
         AND ${TOKEN_LIVE_PREDICATE(ph('now'), 'scope_grant')}
    )`
}

/**
 * Prepared statements for the only activation path.  Callers append these to
 * the successful WebAuthn promotion batch after the attachment statement.
 * A stale epoch for the same dedicated tuple is revoked first; no row is ever
 * updated/reused as the new epoch.
 */
export function prepareContinuityEnrollmentStatements(env: Env, p: ContinuityEnrollment): D1PreparedStatement[] {
  const now = p.nowIso ?? nowSqlUtc()
  return [
    env.DB.prepare(
      `UPDATE attachment_continuity_scopes AS old SET revoked_at = ?1, revoked_by_member_id = ?2
        WHERE old.tenant = ?3 AND old.harness_id = ?4 AND old.agent_id = ?5 AND old.human_member_id = ?2
          AND old.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM harnesses h JOIN member_tokens g ON g.id = old.source_grant_token_id
             WHERE h.id = old.harness_id AND h.tenant = old.tenant AND h.member_id = old.human_member_id
               AND h.credential_kind = 'oauth' AND h.grant_id = 'oauth:' || old.source_grant_token_id
               AND g.tenant = old.tenant AND g.member_id = old.human_member_id
               AND g.channel = 'directory' AND g.agent_id IS NULL AND ${TOKEN_LIVE_PREDICATE('?1', 'g')}
          )`,
    ).bind(now, p.humanMemberId, env.TENANT_SLUG, p.harnessId, p.agentId),
    env.DB.prepare(
      `INSERT INTO attachment_continuity_scopes
          (id, tenant, admission_id, agent_id, human_member_id, harness_id, source_grant_token_id, authority_decision_id, created_at)
       SELECT ?1, ?2, adm.id, adm.agent_id, adm.human_member_id, adm.harness_id, ?3, decision.id, ?4
         FROM agent_seat_attachments att
         JOIN agent_seat_admissions adm ON adm.id = att.admission_id AND adm.tenant = att.tenant
         JOIN agent_seat_authority_decisions decision ON decision.id = ?11 AND decision.tenant = att.tenant
         JOIN harnesses h ON h.id = adm.harness_id AND h.tenant = adm.tenant AND h.member_id = adm.human_member_id
         JOIN member_tokens g ON g.id = ?3
         JOIN agents a ON a.id = adm.agent_id AND a.status = 'active'
         JOIN agent_member_bindings b ON b.tenant = adm.tenant AND b.agent_id = a.id
         JOIN members am ON am.id = b.member_id AND am.tenant = adm.tenant AND am.status = 'active'
        WHERE att.id = ?5 AND att.tenant = ?2 AND att.detached_at IS NULL
          AND att.admission_id = ?6 AND att.agent_id = ?7 AND att.human_member_id = ?8 AND att.harness_id = ?9
          AND adm.status = 'live' AND adm.scope = 'harness' AND adm.decided_at = ?10
          AND adm.decided_by_member_id = ?8 AND adm.decided_via = 'webauthn'
          AND decision.admission_id = adm.id AND decision.attachment_id = att.id AND decision.seat_id = att.seat_id
          AND decision.agent_id = adm.agent_id AND decision.harness_id = adm.harness_id
          AND decision.decided_by_member_id = ?8 AND decision.decided_at = ?10
          AND decision.decided_via = 'webauthn' AND decision.continuity_approved = 1
          AND ${authorityLiveSql('adm', '?4')}
          AND h.credential_kind = 'oauth' AND h.grant_id = 'oauth:' || ?3
          AND g.tenant = ?2 AND g.member_id = ?8 AND g.channel = 'directory' AND g.agent_id IS NULL
          AND ${TOKEN_LIVE_PREDICATE('?4', 'g')}
          AND EXISTS (SELECT 1 FROM members hm WHERE hm.id = ?8 AND hm.tenant = ?2 AND hm.status = 'active')
          AND ${continuityHistoricalSeatsClearSql('?2', '?9', '?7')}
          AND NOT EXISTS (
            SELECT 1 FROM agent_seat_admissions other
             WHERE other.tenant = ?2 AND other.harness_id = ?9 AND other.status = 'live'
               AND other.agent_id <> ?7 AND ${authorityLiveSql('other', '?4')}
          )
          AND NOT EXISTS (
            SELECT 1 FROM attachment_continuity_scopes live
            JOIN agent_seat_admissions live_adm ON live_adm.id = live.admission_id AND live_adm.tenant = live.tenant
            JOIN harnesses live_h ON live_h.id = live.harness_id AND live_h.tenant = live.tenant
            JOIN member_tokens live_g ON live_g.id = live.source_grant_token_id
             WHERE live.tenant = ?2 AND live.harness_id = ?9 AND live.revoked_at IS NULL
               AND live_adm.status = 'live' AND ${authorityLiveSql('live_adm', '?4')}
               AND live_h.credential_kind = 'oauth' AND live_h.grant_id = 'oauth:' || live.source_grant_token_id
               AND live_g.tenant = live.tenant AND live_g.member_id = live.human_member_id
               AND live_g.channel = 'directory' AND live_g.agent_id IS NULL AND ${TOKEN_LIVE_PREDICATE('?4', 'live_g')}
          )`,
    ).bind(p.scopeId, env.TENANT_SLUG, p.sourceGrantTokenId, now, p.attachmentId, p.admissionId, p.agentId, p.humanMemberId, p.harnessId, p.promotedAt, p.authorityDecisionId),
  ]
}

const rowColumns = `cs.id, cs.tenant, cs.admission_id, cs.agent_id, cs.human_member_id, cs.harness_id,
  cs.source_grant_token_id, cs.authority_decision_id, cs.created_at, cs.revoked_at, cs.revoked_by_member_id`

export async function resolveAttachmentContinuity(env: Env, request: ContinuityRequest): Promise<AttachmentContinuityResolution> {
  const ph: LivePh = (key) => ({ tenant: '?1', seat: '?2', grantToken: '?3', human: '?4', now: '?5' })[key]
  const binds = [env.TENANT_SLUG, request.seatId, request.sourceGrantTokenId, request.humanMemberId, request.nowIso ?? nowSqlUtc()]
  const live = await env.DB.prepare(
    `SELECT att.id FROM ${LIVE_ATTACHMENT_FROM_SQL}
      JOIN member_tokens t ON ${seatTokenLiveSql(ph)}
      WHERE att.id = ?6 AND att.agent_id = ?7 AND att.harness_id = ?8 AND ${liveAttachmentConditionsSql(env, ph)} LIMIT 1`,
  ).bind(...binds, request.attachmentId, request.agentId, request.harnessId).first<{ id: string }>()
  if (!live) return { kind: 'refused', reason: 'attachment_not_live' }
  const scoped = await env.DB.prepare(
    `SELECT ${rowColumns} FROM attachment_continuity_scopes cs JOIN ${LIVE_ATTACHMENT_FROM_SQL}
      JOIN member_tokens t ON ${seatTokenLiveSql(ph)}
      WHERE att.id = ?6 AND att.agent_id = ?7 AND att.harness_id = ?8
        AND ${continuityScopeAuthoritySql(env, ph)} LIMIT 1`,
  ).bind(...binds, request.attachmentId, request.agentId, request.harnessId).first<ContinuityScopeRow>()
  if (scoped) return { kind: 'scope', scope: scoped, target: continuityTarget(scoped.id) }
  const knownScope = await env.DB.prepare(
    `SELECT 1 FROM attachment_continuity_scopes cs JOIN agent_seat_attachments att ON att.id = ?1
      WHERE cs.tenant = ?2 AND att.tenant = cs.tenant AND cs.admission_id = att.admission_id
        AND cs.agent_id = att.agent_id AND cs.human_member_id = att.human_member_id AND cs.harness_id = att.harness_id LIMIT 1`,
  ).bind(request.attachmentId, env.TENANT_SLUG).first()
  return knownScope ? { kind: 'refused', reason: 'scope_not_live' } : { kind: 'legacy' }
}

/** Shared recipient-side resource predicate. It does not authenticate a sender. */
export function liveRecipientContinuityScopeSql(env: Env, scope: string, tenant: string, now: string, recipient: string): string {
  return `cs.id = ${scope} AND cs.tenant = ${tenant} AND cs.revoked_at IS NULL AND cs.agent_id = ${recipient}
       AND adm.status = 'live' AND adm.scope = 'harness' AND adm.agent_id = cs.agent_id
       AND adm.human_member_id = cs.human_member_id AND adm.harness_id = cs.harness_id
       AND ${authorityLiveSql('adm', now)}
       AND h.credential_kind = 'oauth' AND h.grant_id = 'oauth:' || cs.source_grant_token_id
       AND g.tenant = cs.tenant AND g.member_id = cs.human_member_id AND g.channel = 'directory' AND g.agent_id IS NULL
       AND ${TOKEN_LIVE_PREDICATE(now, 'g')}
       AND EXISTS (SELECT 1 FROM members hm WHERE hm.id = cs.human_member_id AND hm.tenant = cs.tenant AND hm.status = 'active')
       ${attachDesignatedClause(env, 'a', 'cs.human_member_id')}`
}

/** Recipient routing lookup only: it does not authenticate a caller or choose a physical attachment. */
export async function findLiveRecipientContinuityScope(env: Env, scopeId: string, recipientAgentId: string, nowIso = nowSqlUtc()): Promise<ContinuityScopeRow | null> {
  return env.DB.prepare(
    `SELECT ${rowColumns} FROM attachment_continuity_scopes cs
      JOIN agent_seat_admissions adm ON adm.id = cs.admission_id AND adm.tenant = cs.tenant
      JOIN harnesses h ON h.id = cs.harness_id AND h.tenant = cs.tenant AND h.member_id = cs.human_member_id
      JOIN member_tokens g ON g.id = cs.source_grant_token_id
      JOIN agents a ON a.id = cs.agent_id AND a.status = 'active'
      JOIN agent_member_bindings b ON b.tenant = cs.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = cs.tenant AND am.status = 'active'
     WHERE ${liveRecipientContinuityScopeSql(env, '?1', '?2', '?3', '?4')}
     LIMIT 1`,
  ).bind(scopeId, env.TENANT_SLUG, nowIso, recipientAgentId).first<ContinuityScopeRow>()
}
