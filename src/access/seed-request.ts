// mupot — pending seed-attach requests (migration 0211). An agent files one (MCP seed_attach_request);
// only the Access approve page decides it. Single-use: the claim is ONE guarded
// UPDATE ... WHERE status = 'pending' AND expires_at > now, so replay, a second tab and a double tap all
// lose. Nothing here applies a seed; routes.ts does, through the existing applySeed.
import type { Env } from '../types'
import type { ValidatedSeed } from '../seeds/apply'

export const SEED_REQUEST_TTL_MS = 24 * 60 * 60 * 1000
/** Live pending requests one requester may hold: a flood cap, so an agent cannot bury the real ask. */
export const SEED_REQUEST_MAX_PENDING = 10

export interface SeedRequestRow {
  id: string
  tenant: string
  requester_member_id: string
  requester_agent_id: string | null
  seed_sha256: string
  canonical_json: string
  requests_json: string
  status: 'pending' | 'applying' | 'applied' | 'denied' | 'failed' | 'expired'
  created_at: string
  expires_at: string
  decided_at: string | null
  decided_by_member_id: string | null
  decided_via: string | null
  decision_error: string | null
}

const COLUMNS = `id, tenant, requester_member_id, requester_agent_id, seed_sha256, canonical_json, requests_json,
  status, created_at, expires_at, decided_at, decided_by_member_id, decided_via, decision_error`

export interface StoredRequest { key: string; kind: string; fields: Record<string, string> }

export type CreateSeedRequestResult =
  | { ok: true; id: string; expiresAt: string; reused: boolean }
  | { ok: false; reason: 'too_many_pending' }

export async function createSeedRequest(
  env: Env,
  input: { requesterMemberId: string; requesterAgentId: string | null; validated: ValidatedSeed },
  nowMs: number = Date.now(),
): Promise<CreateSeedRequestResult> {
  const tenant = env.TENANT_SLUG
  const nowIso = new Date(nowMs).toISOString()
  // A pending row past its expiry must not hold the single pending slot for this (requester, seed).
  await env.DB.prepare(
    `UPDATE seed_attach_requests SET status = 'expired'
      WHERE tenant = ?1 AND requester_member_id = ?2 AND seed_sha256 = ?3 AND status = 'pending' AND expires_at <= ?4`,
  ).bind(tenant, input.requesterMemberId, input.validated.seedSha256, nowIso).run()

  const id = crypto.randomUUID()
  const expiresAt = new Date(nowMs + SEED_REQUEST_TTL_MS).toISOString()
  const stored: StoredRequest[] = input.validated.requests.map((r) => ({ key: r.key, kind: r.kind, fields: r.fields }))
  // One statement: the partial UNIQUE index (tenant, requester, seed digest WHERE pending) makes a concurrent
  // duplicate filing lose with DO NOTHING; the cap is the SELECT's WHERE. 0 rows = duplicate OR over the cap.
  const res = await env.DB.prepare(
    `INSERT INTO seed_attach_requests
       (id, tenant, requester_member_id, requester_agent_id, seed_sha256, canonical_json, requests_json,
        status, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9
      WHERE (SELECT COUNT(*) FROM seed_attach_requests
              WHERE tenant = ?2 AND requester_member_id = ?3 AND status = 'pending' AND expires_at > ?8) < ?10
     ON CONFLICT DO NOTHING`,
  ).bind(
    id, tenant, input.requesterMemberId, input.requesterAgentId, input.validated.seedSha256,
    input.validated.canonical, JSON.stringify(stored), nowIso, expiresAt, SEED_REQUEST_MAX_PENDING,
  ).run()
  if (res.meta.changes === 1) return { ok: true, id, expiresAt, reused: false }
  // Not inserted: the existing live pending row for the same identity wins (idempotent), else the cap refused.
  const existing = await env.DB.prepare(
    `SELECT id, expires_at FROM seed_attach_requests
      WHERE tenant = ?1 AND requester_member_id = ?2 AND seed_sha256 = ?3 AND status = 'pending' AND expires_at > ?4
      LIMIT 1`,
  ).bind(tenant, input.requesterMemberId, input.validated.seedSha256, nowIso).first<{ id: string; expires_at: string }>()
  if (existing) return { ok: true, id: existing.id, expiresAt: existing.expires_at, reused: true }
  return { ok: false, reason: 'too_many_pending' }
}

export async function loadSeedRequest(env: Env, id: string): Promise<SeedRequestRow | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM seed_attach_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
    .bind(id, env.TENANT_SLUG).first<SeedRequestRow>()
  return row ?? null
}

export function seedRequestIsLive(row: SeedRequestRow, nowMs: number): boolean {
  return row.status === 'pending' && Date.parse(row.expires_at) > nowMs
}

/** The ONLY transition into 'applying'. True iff THIS call won it. */
export async function claimSeedRequest(env: Env, id: string, memberId: string, nowMs: number): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const r = await env.DB.prepare(
    `UPDATE seed_attach_requests
        SET status = 'applying', decided_at = ?3, decided_by_member_id = ?4, decided_via = 'access_passkey'
      WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND expires_at > ?3`,
  ).bind(id, env.TENANT_SLUG, nowIso, memberId).run()
  return r.meta.changes === 1
}

export async function finishSeedRequest(env: Env, id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  await env.DB.prepare(
    `UPDATE seed_attach_requests SET status = ?3, decision_error = ?4 WHERE id = ?1 AND tenant = ?2 AND status = 'applying'`,
  ).bind(id, env.TENANT_SLUG, outcome.ok ? 'applied' : 'failed', outcome.ok ? null : outcome.error.slice(0, 200)).run()
}

/** Deny: one guarded flip + its receipt in one batch (the receipt lands only if the flip did). */
export async function denySeedRequest(env: Env, row: SeedRequestRow, memberId: string, accessSub: string, nowMs: number): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const evidence = JSON.stringify({ via: 'access_passkey', seed_sha256: row.seed_sha256, access_request_id: row.id, decision: 'deny', access_sub: accessSub })
  const out = await env.DB.batch([
    env.DB.prepare(
      `UPDATE seed_attach_requests
          SET status = 'denied', decided_at = ?3, decided_by_member_id = ?4, decided_via = 'access_passkey'
        WHERE id = ?1 AND tenant = ?2 AND status = 'pending' AND expires_at > ?3`,
    ).bind(row.id, env.TENANT_SLUG, nowIso, memberId),
    env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       SELECT ?1, ?2, 'member', ?3, ?3, 'admin_ui', 'access_approve', 'seed_request_deny', 'seed_attach_request', ?4, ?5, ?6, ?7, ?8
        WHERE changes() = 1
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, memberId, row.id, `access-seed-deny:${row.id}`, row.seed_sha256, evidence, nowIso),
  ])
  return out[0].meta.changes === 1
}
