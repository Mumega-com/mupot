// mupot — the outreach prospect queue (P4, #35).
//
// Tenant-scoped CRUD over the prospects table (0015). createProspect dedups by the
// (tenant,email) active-unique index — a duplicate active prospect is rejected, not
// inserted (the amplification guard, by construction). The loop's 'queue' source reads
// queued prospects; the reply tracker moves them to 'replied'/'opted_out'.
//
// CASL note: consent_basis is recorded but NOT trusted to auto-send — the loop gate
// (require_approval) + the act pipeline enforce that. 'unknown' here just flags a contact
// that must never be auto-fired even if a future autonomy tier is added.

import type { Env } from '../types'

export type ProspectSource = 'seed' | 'discovered'
export type ConsentBasis = 'existing_relationship' | 'consent' | 'unknown'
export type ProspectStatus = 'queued' | 'drafted' | 'sent' | 'replied' | 'opted_out' | 'bounced'

const SOURCES = new Set<ProspectSource>(['seed', 'discovered'])
const CONSENTS = new Set<ConsentBasis>(['existing_relationship', 'consent', 'unknown'])
const STATUSES = new Set<ProspectStatus>(['queued', 'drafted', 'sent', 'replied', 'opted_out', 'bounced'])

export interface Prospect {
  id: string
  tenant: string
  loop_id: string | null
  org: string | null
  contact_name: string | null
  email: string | null
  source: ProspectSource
  consent_basis: ConsentBasis
  status: ProspectStatus
  notes: string | null
  created_at: string
}

export interface NewProspect {
  loop_id?: string | null
  org?: string | null
  contact_name?: string | null
  email?: string | null
  source?: ProspectSource
  consent_basis?: ConsentBasis
  notes?: string | null
}

export type ProspectResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * createProspect — queue a prospect under this tenant. Dedups via the active-unique
 * index: a duplicate active (tenant,email) is reported as {ok:false, error:'duplicate_active'}
 * rather than inserted. email is required (the dedup + send key).
 */
export async function createProspect(env: Env, input: NewProspect): Promise<ProspectResult<Prospect>> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return { ok: false, error: 'invalid_email' }

  const source: ProspectSource = input.source && SOURCES.has(input.source) ? input.source : 'seed'
  const consent_basis: ConsentBasis =
    input.consent_basis && CONSENTS.has(input.consent_basis) ? input.consent_basis : 'unknown'

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const tenant = env.TENANT_SLUG
  const loop_id = input.loop_id ?? null
  const org = input.org ?? null
  const contact_name = input.contact_name ?? null
  const notes = input.notes ?? null

  try {
    await env.DB.prepare(
      `INSERT INTO prospects (id, tenant, loop_id, org, contact_name, email, source, consent_basis, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(id, tenant, loop_id, org, contact_name, email, source, consent_basis, notes, now, now)
      .run()
  } catch (err) {
    // The active-unique index rejects a duplicate in-flight prospect for this email.
    const msg = err instanceof Error ? err.message : ''
    if (/UNIQUE|constraint/i.test(msg)) return { ok: false, error: 'duplicate_active' }
    throw err
  }

  return {
    ok: true,
    value: { id, tenant, loop_id, org, contact_name, email, source, consent_basis, status: 'queued', notes, created_at: now },
  }
}

/** listQueued — the next queued prospects for the tenant (optionally one loop), oldest first. */
export async function listQueued(env: Env, opts: { loopId?: string | null; limit?: number } = {}): Promise<Prospect[]> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 5))
  const rows = opts.loopId
    ? await env.DB.prepare(
        `SELECT * FROM prospects WHERE tenant = ? AND status = 'queued' AND loop_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(env.TENANT_SLUG, opts.loopId, limit)
        .all<Prospect>()
    : await env.DB.prepare(
        `SELECT * FROM prospects WHERE tenant = ? AND status = 'queued' ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(env.TENANT_SLUG, limit)
        .all<Prospect>()
  return rows.results ?? []
}

/** setProspectStatus — tenant-scoped status transition. Returns false if no row changed. */
export async function setProspectStatus(env: Env, id: string, status: ProspectStatus): Promise<boolean> {
  if (!STATUSES.has(status)) return false
  const now = new Date().toISOString()
  const res = await env.DB.prepare(`UPDATE prospects SET status = ?, updated_at = ? WHERE id = ? AND tenant = ?`)
    .bind(status, now, id, env.TENANT_SLUG)
    .run()
  return (res.meta?.changes ?? 0) === 1
}

/** countByStatus — how many prospects are in a status (the outcome-KPI signal source). */
export async function countByStatus(env: Env, status: ProspectStatus): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM prospects WHERE tenant = ? AND status = ?`)
    .bind(env.TENANT_SLUG, status)
    .first<{ c: number }>()
  return row?.c ?? 0
}

/** findByEmail — tenant-scoped lookup (reply/opt-out routing from an inbound webhook). */
export async function findByEmail(env: Env, email: string): Promise<Prospect | null> {
  const norm = email.trim().toLowerCase()
  const row = await env.DB.prepare(
    `SELECT * FROM prospects WHERE tenant = ? AND email = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, norm)
    .first<Prospect>()
  return row ?? null
}
