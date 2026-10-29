// Storage projection, never an authority engine. The only registered source in slice 1 is the existing elevation ledger.
import type { ToolSpec } from '../mcp/index'
import { LIVE_ATTACHMENT_FROM_SQL, liveAttachmentConditionsSql, seatTokenLiveSql, type LivePh } from '../members/attach-live-sql'
import { canDecideElevationRequest, loadElevationRequestById } from '../auth/elevation'
import type { AuthContext, CapabilityGrant, Env } from '../types'
import { CAPABILITY_LIVE_PREDICATE, hasCapabilityOnDynamicScope, resolveCapabilities } from '../auth/capability'
import { resolveConsentedAgentCapabilities } from '../mcp/oauth-authorize'
import { resolveSeatCapabilities } from '../members/seat-handle'
import { findLiveAttachment } from '../members/seat-attach'
import { memberIsActiveHuman } from '../access/identity'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { sha256Hex } from '../members/service'

export const OWNER_CALL_SCHEMA: ToolSpec['inputSchema'] = {
  type: 'object', properties: {
    ask_key: { type: 'string', minLength: 1, maxLength: 96 },
    kind: { type: 'string', enum: ['access', 'credential', 'reauth', 'money'] },
    action_ref: { type: 'object', properties: { type: { type: 'string', enum: ['elevation_request', 'connection'] }, id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['type', 'id'], additionalProperties: false },
    reason_code: { type: 'string', enum: ['access_required', 'credential_required', 'reauth_required', 'payment_required'] },
  }, required: ['ask_key', 'kind', 'action_ref', 'reason_code'], additionalProperties: false,
}

type Refusal = { ok: false; error: string; retry_after?: number }
type Projection = { ask_id: string; state: string; delivery_state: string; next_step: string; retry: boolean }
export type OwnerCallResult = Refusal | { ok: true; result: Projection }
interface Input { ask_key: string; kind: string; action_ref: { type: string; id: string }; reason_code: string }
interface Identity { stamp: string; owner_id: string | null; owner_revision: number; squad_id: string; session_id: string }
interface Source { source_owner_revision: number; source_id: string; session_id: string; stamp: string; identity: string; status: string; expires_at: string; agent_id: string; scope_type: 'org' | 'department' | 'squad'; scope_id: string; delivery_id: string | null; delivery_owner: string | null; delivery_status: string | null }
interface Ask { id: string; state: string; owner_member_id: string; owner_revision: number; payload_digest?: string; requester_owner_revision?: number }

function input(value: Record<string, unknown>): Input | null {
  if (Object.keys(value).some(k => !['ask_key', 'kind', 'action_ref', 'reason_code'].includes(k))) return null
  const ref = value.action_ref
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null
  const r = ref as Record<string, unknown>
  if (Object.keys(r).some(k => !['type', 'id'].includes(k)) || typeof r.type !== 'string' || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.id)) return null
  if (typeof value.ask_key !== 'string' || value.ask_key.length < 1 || value.ask_key.length > 96 || typeof value.kind !== 'string' || typeof value.reason_code !== 'string') return null
  if (!['access', 'credential', 'reauth', 'money'].includes(value.kind)) return null
  return { ask_key: value.ask_key, kind: value.kind, action_ref: { type: r.type, id: r.id }, reason_code: value.reason_code }
}

// All snapshots exclude credential values and private source/requester prose. Kept in memory only, never returned/logged.
// The SAME predicates run at pre-read and in the conditional transaction; equality fences revocation, reconsent and ABA changes.
function identityQuery(env: Env, auth: AuthContext): { sql: string; values: unknown[] } {
  const human = auth.seatBinding?.humanMemberId ?? auth.consentedByMemberId ?? null
  const seat = auth.seatBinding
  const attached = seat?.attached
  const ph: LivePh = k => ({ tenant: '?1', seat: '?6', grantToken: '?7', human: '?5', now: '?10' })[k]
  const sql = `SELECT s.id session_id, a.owner_member_id owner_id, a.owner_call_owner_revision owner_revision, a.squad_id,
    json_object('agent',json_array(a.id,a.status,a.squad_id,a.owner_member_id,a.owner_call_owner_revision,a.attach_designated_member_id),
      'token',json_array(t.id,t.created_at,t.expires_at,t.revoked_at,t.channel),
      'session',json_array(s.id,s.created_at,s.revoked_at,s.absolute_expires_at,s.idle_expires_at),
      'human_roles',(SELECT json_group_array(json_array(li.id,li.revoked_at,u.id,u.role)) FROM human_login_identities li LEFT JOIN users u ON lower(u.email)=lower(li.verified_email) WHERE li.tenant=?1 AND li.member_id=?5 ORDER BY li.id,u.id),
      'human',(SELECT json_array(id,status,archived_at) FROM members WHERE id=?5 AND tenant=?1),
      'caps',(SELECT json_group_array(json_array(id,member_id,scope_type,scope_id,capability,expires_at)) FROM
        (SELECT * FROM capabilities WHERE member_id IN (?3,?5) AND ${CAPABILITY_LIVE_PREDICATE('', '?10')} ORDER BY id)),
      'channel_grants',(SELECT json_group_array(json_array(id,binding_id,member_id,squad_id,capability,updated_at)) FROM (SELECT * FROM channel_capability_grants WHERE member_id IN (?3,?5) ORDER BY id)),
      'scope',(SELECT json_array(sq.id,sq.kind,sq.department_id,d.kind) FROM squads sq JOIN departments d ON d.id=sq.department_id WHERE sq.id=a.squad_id),
      'admission',(SELECT json_array(ad.id,ad.status,ad.ceiling,ad.expires_at,ad.revoked_at,ad.decided_at,ad.requested_seat_id,ad.scope) FROM agent_seat_admissions ad WHERE ad.id=?8 AND ad.tenant=?1),
      'seat',(SELECT json_array(st.id,st.retired_at,st.admission_status,st.harness_id,st.member_id) FROM agent_seats st WHERE st.id=?6 AND st.tenant=?1)
    ) stamp
    FROM agents a JOIN agent_member_bindings b ON b.agent_id=a.id AND b.tenant=?1
    JOIN members m ON m.id=b.member_id AND m.tenant=?1
    JOIN member_tokens t ON t.id=?4 AND t.tenant=?1 AND t.member_id=m.id AND t.agent_id=a.id
    JOIN agent_sessions s ON s.tenant=?1 AND s.agent_id=a.id AND s.member_id=m.id AND s.credential_id=t.id
    WHERE a.id=?2 AND m.id=?3
      AND a.status='active' AND a.archived_at IS NULL AND m.status='active' AND m.archived_at IS NULL
      AND ${TOKEN_LIVE_PREDICATE('?10')}
      AND t.channel='${auth.channel === 'directory' ? 'directory' : 'workspace'}' AND s.auth_kind='${auth.channel === 'directory' ? 'oauth' : 'workspace_token'}'
      AND s.revoked_at IS NULL AND julianday(s.idle_expires_at)>julianday(?10) AND julianday(s.absolute_expires_at)>julianday(?10)
      AND (?5 IS NULL OR EXISTS(SELECT 1 FROM members hm WHERE hm.id=?5 AND hm.tenant=?1 AND hm.status='active' AND hm.archived_at IS NULL))
      ${attached ? `AND EXISTS(SELECT 1 FROM ${LIVE_ATTACHMENT_FROM_SQL} WHERE ${liveAttachmentConditionsSql(env, ph)}
        AND att.id=?9 AND adm.id=?8 AND a.id=?2 AND att.seat_token_id=?4
        AND EXISTS(SELECT 1 FROM member_tokens t WHERE ${seatTokenLiveSql(ph)}))` : ''}`
  return { sql, values: [auth.tenant, auth.boundAgentId, auth.memberId, auth.tokenId, human, seat?.seatId ?? null, seat?.grantTokenId ?? null, attached?.admissionId ?? null, attached?.attachmentId ?? null] }
}
const SOURCE_SQL = `SELECT sa.owner_call_owner_revision source_owner_revision,e.id source_id,e.agent_session_id session_id,e.agent_id,e.requested_scope_type scope_type,e.requested_scope_id scope_id,e.status,e.decision_expires_at expires_at,
  d.id delivery_id,d.member_id delivery_owner,d.status delivery_status,
  json_array(e.id,e.tenant,e.agent_id,e.member_id,e.agent_session_id,e.requested_actions_json,e.requested_scope_type,e.requested_scope_id,
    e.requested_duration_minutes,e.created_at,e.decision_expires_at,e.sudo_args_sha256) identity,
  json_array(e.id,e.tenant,e.agent_id,e.member_id,e.agent_session_id,e.requested_actions_json,e.requested_scope_type,e.requested_scope_id,
    e.requested_duration_minutes,e.created_at,e.decision_expires_at,e.sudo_args_sha256,e.status,d.id,d.member_id,d.status,cs.id,cs.revoked_at,cs.idle_expires_at,cs.absolute_expires_at,ct.id,ct.created_at,ct.revoked_at,ct.expires_at,ct.channel,
    sa.owner_member_id,sa.owner_call_owner_revision,sa.attach_designated_member_id,sm.id,sm.status,sm.archived_at,sm.tenant,sb.created_at,
    CASE WHEN e.status='pending' AND julianday(e.decision_expires_at)>julianday(?3) THEN 1 ELSE 0 END,
    (SELECT json_group_array(json_array(att.id,att.detached_at,att.human_member_id,att.admission_id,adm.status,adm.revoked_at,adm.ceiling,adm.scope,adm.requested_seat_id,
      st.id,st.retired_at,st.admission_status,st.member_id,st.harness_id,hr.member_id,hr.grant_id,hr.credential_kind,g.id,g.revoked_at,g.expires_at,g.member_id,g.agent_id,g.channel,hm.status,hm.archived_at,hm.tenant))
      FROM agent_seat_attachments att JOIN agent_seat_admissions adm ON adm.id=att.admission_id AND adm.tenant=att.tenant
      JOIN agent_seats st ON st.id=att.seat_id AND st.tenant=att.tenant JOIN harnesses hr ON hr.id=att.harness_id AND hr.tenant=att.tenant
      JOIN members hm ON hm.id=att.human_member_id LEFT JOIN member_tokens g ON g.id=substr(hr.grant_id,7) AND g.tenant=hr.tenant
      WHERE att.tenant=e.tenant AND att.seat_token_id=cs.credential_id),
    (SELECT json_array(id,kind,department_id) FROM squads WHERE id=e.requested_scope_id),
    (SELECT json_array(id,kind) FROM departments WHERE id=e.requested_scope_id)) stamp
  FROM elevation_requests e JOIN agent_sessions cs ON cs.id=e.agent_session_id AND cs.tenant=e.tenant
    AND cs.agent_id=e.agent_id AND cs.member_id=e.member_id AND cs.revoked_at IS NULL AND julianday(cs.idle_expires_at)>julianday(?3) AND julianday(cs.absolute_expires_at)>julianday(?3)
  JOIN member_tokens ct ON ct.id=cs.credential_id AND ct.tenant=e.tenant AND ct.agent_id=e.agent_id AND ct.member_id=e.member_id
    AND ${TOKEN_LIVE_PREDICATE('?3', 'ct')}
  JOIN agents sa ON sa.id=e.agent_id AND sa.status='active' AND sa.archived_at IS NULL
  JOIN agent_member_bindings sb ON sb.tenant=e.tenant AND sb.agent_id=e.agent_id AND sb.member_id=e.member_id
  JOIN members sm ON sm.id=sb.member_id AND sm.tenant=e.tenant AND sm.status='active' AND sm.archived_at IS NULL
  LEFT JOIN approval_bot_deliveries d ON d.request_id=e.id AND d.tenant=e.tenant
  WHERE e.id=?1 AND e.tenant=?2`

async function keys(env: Env, askKey: string): Promise<{ version: string; hmac: string; check: string }[] | null> {
  try {
    const raw: unknown = JSON.parse(env.OWNER_CALL_HMAC_KEYS ?? 'null')
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return null
    const out = []
    for (const k of raw) {
      if (!k || typeof k.version !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(k.version) || typeof k.key !== 'string' || k.key.length < 32) return null
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(k.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(['owner-call-v1', env.TENANT_SLUG, askKey])))
      const checkBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('mupot:owner-call:key-check:v1'))
      const check = Array.from(new Uint8Array(checkBytes), x => x.toString(16).padStart(2, '0')).join('')
      out.push({ version: k.version, check, hmac: Array.from(new Uint8Array(signature), x => x.toString(16).padStart(2, '0')).join('') })
    }
    if (new Set(out.map(k => k.version)).size !== out.length) return null
    return out
  } catch { return null }
}

async function mayRead(env: Env, auth: AuthContext, who: Identity, source: Source): Promise<boolean> {
  const own = source.session_id === who.session_id
  const scope = own ? ['squad', who.squad_id] as const : [source.scope_type, source.scope_id || null] as const
  const layers: CapabilityGrant[][] = [auth.capabilities ?? [], await resolveCapabilities(env, auth.memberId!)]
  const covers = (grants: CapabilityGrant[]) => hasCapabilityOnDynamicScope(env, grants, ...scope, 'member')
  if (!(await covers(layers[0])) || !(await covers(layers[1]))) return false
  if (auth.seatBinding) {
    const seat = auth.seatBinding
    if (!seat.attached) return false // Plain auto seats have no independently assigned owner/source association in this slice.
    const live = await findLiveAttachment(env, { memberId: seat.humanMemberId, tokenId: seat.grantTokenId }, seat.seatId)
    if (!live || live.attachment_id !== seat.attached.attachmentId || live.admission_id !== seat.attached.admissionId || live.agent_id !== auth.boundAgentId) return false
    const grants = await resolveSeatCapabilities(env, { humanMemberId: seat.humanMemberId, agentId: auth.boundAgentId!, agentSquadId: who.squad_id, agentMemberId: auth.memberId!, ceiling: live.ceiling })
    if (!(await covers(grants))) return false
    layers.push(grants)
  } else if (auth.channel === 'directory') {
    const grants = await resolveConsentedAgentCapabilities(env, auth.boundAgentId!, auth.consentedByMemberId ?? null, undefined, auth.backgroundAgentHumanRequired)
    if (!(await covers(grants))) return false
    layers.push(grants)
  }
  // Existing elevation visibility: exact originating session, or the canonical decision/list predicate on EVERY ceiling.
  // An ordinary peer does not gain visibility merely by sharing an owner or squad.
  if (!own) {
    const request = await loadElevationRequestById(env, env.TENANT_SLUG, source.source_id)
    if (!request) return false
    for (const grants of layers) if (!(await canDecideElevationRequest(env, { ...auth, role: 'member', capabilities: grants }, grants, request, auth.memberId))) return false
  }
  const sourceAgent = await env.DB.prepare(`SELECT 1 ok FROM agents a JOIN agent_member_bindings b ON b.agent_id=a.id AND b.tenant=?1
    WHERE a.id=?2 AND a.owner_member_id=?3 AND a.squad_id=?4 AND a.status='active'`).bind(env.TENANT_SLUG, source.agent_id, who.owner_id, who.squad_id).first()
  return sourceAgent !== null
}

export async function ownerCall(env: Env, auth: AuthContext, raw: Record<string, unknown>): Promise<OwnerCallResult> {
  if (env.OWNER_CALL !== '1') return { ok: false, error: 'owner_call_disabled' }
  if (!auth.boundAgentId || !auth.memberId || !auth.tokenId || auth.tenant !== env.TENANT_SLUG || !['workspace', 'directory'].includes(auth.channel ?? '')) return { ok: false, error: 'agent_binding_required' }
  const arg = input(raw)
  if (!arg) return { ok: false, error: 'invalid_args' }
  if (arg.kind === 'credential' || arg.kind === 'money') return { ok: false, error: 'owner_call_kind_disabled' }
  if (arg.kind !== 'access' || arg.action_ref.type !== 'elevation_request' || arg.reason_code !== 'access_required') return { ok: false, error: 'owner_call_source_unavailable' }
  const aliases = await keys(env, arg.ask_key)
  if (!aliases) return { ok: false, error: 'owner_call_setup_required' }
  const retained = await env.DB.prepare('SELECT key_version,key_check FROM owner_call_hmac_versions WHERE tenant=?').bind(env.TENANT_SLUG).all<{ key_version: string; key_check: string }>()
  if (retained.results?.some(old => !aliases.some(k => k.version === old.key_version && k.check === old.key_check))) return { ok: false, error: 'owner_call_setup_required' }
  const identity = identityQuery(env, auth)
  const now = new Date().toISOString()
  const who = await env.DB.prepare(identity.sql).bind(...identity.values, now).first<Identity>()
  if (!who) return { ok: false, error: 'agent_binding_required' }
  if (!who.owner_id || !(await memberIsActiveHuman(env, who.owner_id))) return { ok: false, error: 'owner_setup_required' }
  const source = await env.DB.prepare(SOURCE_SQL).bind(arg.action_ref.id, env.TENANT_SLUG, now).first<Source>()
  if (!source || !(await mayRead(env, auth, who, source)) || !source.delivery_id || source.delivery_owner !== who.owner_id) return { ok: false, error: 'owner_call_source_unavailable' }
  const version = await sha256Hex(source.identity)
  const digest = await sha256Hex(JSON.stringify([arg.kind, arg.action_ref.type, arg.action_ref.id, version, arg.reason_code]))
  const aliasWhere = aliases.map(() => '(key_version=? AND key_hmac=?)').join(' OR ')
  const aliasValues = aliases.flatMap(k => [k.version, k.hmac])
  const historical = await env.DB.prepare(`SELECT c.*,k.payload_digest,r.owner_revision requester_owner_revision FROM owner_call_key_aliases k JOIN owner_calls c ON c.id=k.ask_id AND c.tenant=k.tenant JOIN owner_call_requesters r ON r.tenant=k.tenant AND r.ask_id=k.ask_id AND r.agent_id=k.agent_id
    WHERE k.tenant=? AND k.agent_id=? AND (${aliasWhere})`).bind(env.TENANT_SLUG, auth.boundAgentId, ...aliasValues).all<Ask>()
  const prior = historical.results?.[0]
  if (historical.results?.some(r => r.payload_digest !== digest || r.id !== prior?.id)) return { ok: false, error: 'ask_key_conflict' }
  if (prior && (prior.owner_member_id !== who.owner_id || prior.requester_owner_revision !== who.owner_revision)) return { ok: false, error: 'owner_setup_required' }
  const liveSource = source.status === 'pending' && Date.parse(source.expires_at) > Date.now()
  if (!prior && !liveSource) return { ok: false, error: 'owner_call_source_unavailable' }
  const id = prior?.id ?? `oc-${crypto.randomUUID()}`
  const values: unknown[] = []
  const p = (value: unknown) => { values.push(value); return `?${values.length}` }
  const tenantP = p(env.TENANT_SLUG), agentP = p(auth.boundAgentId), ownerP = p(who.owner_id), revisionP = p(who.owner_revision)
  const idP = p(id), typeP = p(arg.action_ref.type), sourceP = p(arg.action_ref.id), versionP = p(version), digestP = p(digest)
  const dateP = p(new Date().toISOString()), reasonP = p(arg.reason_code), dispatchP = p(source.delivery_id)
  const sourceAgentP = p(source.agent_id), sourceRevisionP = p(source.source_owner_revision)
  // Renumber reusable subqueries rather than interpolate any caller-controlled SQL.
  const identityParams = [...identity.values, new Date().toISOString()].map(p)
  const actorSql = identity.sql.replace(/\?(\d+)/g, (_, n) => Number(n) === 10 ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : identityParams[Number(n) - 1])
  const sourceSql = SOURCE_SQL.replace(/\?1\b/g, sourceP).replace(/\?2\b/g, tenantP).replace(/\?3\b/g, "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  const stampP = p(who.stamp), sourceStampP = p(source.stamp)
  const ownerLive = `EXISTS(SELECT 1 FROM members om WHERE om.id=${ownerP} AND om.tenant=${tenantP} AND om.status='active' AND om.archived_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM agent_member_bindings ob WHERE ob.tenant=${tenantP} AND ob.member_id=om.id))`
  const sourceAgentLive = `EXISTS(SELECT 1 FROM agents sa JOIN agent_member_bindings sb ON sb.agent_id=sa.id AND sb.tenant=${tenantP}
    WHERE sa.id=${p(source.agent_id)} AND sa.owner_member_id=${ownerP} AND sa.squad_id=${p(who.squad_id)} AND sa.status='active')`
  const ring = aliases.map(k => `(key_version=${p(k.version)} AND key_check=${p(k.check)})`).join(' OR ')
  const guardConditions = `NOT EXISTS(SELECT 1 FROM owner_call_hmac_versions WHERE tenant=${tenantP} AND NOT (${ring})) AND (SELECT stamp FROM owner_call_actor)=${stampP} AND ${ownerLive} AND ${sourceAgentLive} AND (SELECT stamp FROM owner_call_source)=${sourceStampP}`
  // Materialized CTEs keep the canonical attachment predicate below D1's expression-depth ceiling.
  // These are statement-local snapshots inside the SAME transaction, not application-side cached authorization.
  const withGuard = `WITH owner_call_actor AS MATERIALIZED (${actorSql}), owner_call_source AS MATERIALIZED (${sourceSql}),
    owner_call_guard AS MATERIALIZED (SELECT 1 ok WHERE ${guardConditions}) `
  const commitP = p(crypto.randomUUID())
  const guard = `EXISTS(SELECT 1 FROM owner_call_commit_guards WHERE id=${commitP} AND tenant=${tenantP})`
  const retryP = p(prior?.id ?? null)
  const target = `(SELECT id FROM owner_calls WHERE tenant=${tenantP} AND owner_member_id=${ownerP} AND action_type=${typeP} AND action_id=${sourceP}
    AND action_version=${versionP} AND (id=${retryP} OR (state='pending' AND ${retryP} IS NULL)) LIMIT 1)`
  const statements: string[] = [withGuard + `INSERT INTO owner_call_commit_guards(id,tenant) SELECT ${commitP},${tenantP} WHERE EXISTS(SELECT 1 FROM owner_call_guard)`]
  for (const alias of aliases) {
    const version = p(alias.version), check = p(alias.check)
    statements.push(`INSERT INTO owner_call_hmac_versions(tenant,key_version,key_check) SELECT ${tenantP},${version},${check} WHERE ${guard}
      ON CONFLICT(tenant,key_version) DO UPDATE SET key_check=excluded.key_check`)
  }
  statements.push(
    `UPDATE owner_calls SET state='closed' WHERE tenant=${tenantP} AND owner_member_id=${ownerP} AND action_type=${typeP}
      AND action_id=${sourceP} AND (action_version<>${versionP} OR NOT EXISTS(SELECT 1 FROM agents anchor
        WHERE anchor.id=owner_calls.source_agent_id AND anchor.owner_member_id=owner_calls.owner_member_id
          AND anchor.owner_call_owner_revision=owner_calls.owner_revision)) AND state='pending' AND ${guard}`,
    `INSERT INTO owner_calls(id,tenant,owner_member_id,owner_revision,created_by_agent_id,source_agent_id,kind,action_type,action_id,action_version,reason_code,canonical_delivery_id,created_at)
      SELECT ${idP},${tenantP},${ownerP},${sourceRevisionP},${agentP},${sourceAgentP},'access',${typeP},${sourceP},${versionP},${reasonP},${dispatchP},${dateP}
      WHERE ${retryP} IS NULL AND ${guard} AND NOT EXISTS(SELECT 1 FROM owner_calls WHERE tenant=${tenantP} AND owner_member_id=${ownerP}
        AND action_type=${typeP} AND action_id=${sourceP} AND action_version=${versionP} AND state='pending')`,
    `INSERT INTO owner_call_requesters(tenant,ask_id,agent_id,owner_revision,created_at) SELECT ${tenantP},${target},${agentP},${revisionP},${dateP}
      WHERE ${guard} AND ${target} IS NOT NULL ON CONFLICT(tenant,ask_id,agent_id) DO NOTHING`,
  )
  for (const alias of aliases) {
    const keyVersion = p(alias.version), hmac = p(alias.hmac)
    statements.push(`INSERT INTO owner_call_key_aliases(tenant,agent_id,key_version,key_hmac,payload_digest,ask_id,created_at)
      SELECT ${tenantP},${agentP},${keyVersion},${hmac},${digestP},${target},${dateP}
      WHERE ${guard} AND ${target} IS NOT NULL
      ON CONFLICT(tenant,agent_id,key_version,key_hmac) DO UPDATE SET payload_digest=excluded.payload_digest,ask_id=excluded.ask_id`)
  }
  if (!liveSource) statements.push(`UPDATE owner_calls SET state='closed' WHERE id=${target} AND ${guard}`)
  statements.push(`SELECT id,state,owner_member_id,owner_revision FROM owner_calls WHERE id=${target} AND ${guard}
    AND EXISTS(SELECT 1 FROM owner_call_requesters WHERE tenant=${tenantP} AND ask_id=owner_calls.id AND agent_id=${agentP})`)
  const resultIndex = statements.length - 1
  statements.push(`DELETE FROM owner_call_commit_guards WHERE id=${commitP} AND tenant=${tenantP}`)
  // The first statement alone checks live authorization. Every following statement is gated on its transaction-local nonce;
  // D1 batch isolation prevents any concurrent revocation or source change between that check and these writes.
  // Each SQL string uses a subset of numbered binds. Bind exactly through its highest placeholder (D1 rejects excess binds).
  const prepare = (sql: string) => {
    const max = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1])))
    return env.DB.prepare(sql).bind(...values.slice(0, max))
  }
  try {
    const result = await env.DB.batch(statements.map(prepare))
    const ask = result[resultIndex]?.results?.[0] as Ask | undefined
    if (!ask) return { ok: false, error: 'owner_call_source_unavailable' }
    return { ok: true, result: { ask_id: ask.id, state: ask.state,
      delivery_state: source.delivery_status === 'sent' ? 'canonical_sent' : source.delivery_status === 'failed' ? 'canonical_failed' : 'canonical_pending',
      next_step: ask.state === 'closed' ? (Date.parse(source.expires_at) <= Date.now() || source.status === 'expired' ? 'renew_elevation_request' : source.status === 'pending' ? 'projection_closed' : 'source_terminal') : 'await_canonical_elevation', retry: !!prior } }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('owner_call_key_history')) return { ok: false, error: 'owner_call_setup_required' }
    if (message.includes('ask_key_conflict')) return { ok: false, error: 'ask_key_conflict' }
    if (/owner_call_(agent_rate|owner_rate|agent_pending|owner_pending|owner_total)/.test(message)) return { ok: false, error: 'owner_call_limit', retry_after: 900 }
    // Never echo SQL, bindings, provider errors or private source content.
    return { ok: false, error: 'owner_call_unavailable' }
  }
}
