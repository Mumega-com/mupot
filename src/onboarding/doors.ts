// src/onboarding/doors.ts — self-service onboarding doors with a reviewable close.
//
// Hadi, 2026-08-17: "let them choose their access fine grain, then when we close the door
// we crystal the access after Athena approval."
//
// Migration 0107. The model in one line: OPEN lets a fresh login pick the access it needs
// and get it immediately; every pick writes an append-only receipt in the SAME batch as
// the grant; CLOSE freezes the door and seals the receipt count; Athena reviews; approved
// access CRYSTALLIZES into an ordinary permanent grant and rejected access is RESTORED to
// its prior value.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a grant and its receipt land together or not at
// all. The previous attempt at this door recorded provenance on a best-effort bus emit
// that silently dropped the field, so the audit it advertised did not exist. Provenance
// that can fail independently of the mutation is not provenance.

import type { Env } from '../types'

export type DoorStatus = 'open' | 'closed' | 'crystallized'
export type Disposition = 'pending' | 'crystallized' | 'revoked'

/**
 * Self-selectable capabilities, as an ALLOWLIST rather than a prefix test.
 *
 * 'admin' is absent deliberately: a self-granted admin can grant anything to anyone
 * (grant_agent_capability accepts admin-to-admin), so self-service admin is not
 * fine-grained access, it is an authority multiplier. 'owner' and every `gate:*` are
 * likewise unreachable here — gates live in a separate grant surface, and a gate that can
 * be self-issued was never a gate.
 *
 * Loom's review was explicit that an enum beats string-prefix rejection: a prefix test
 * fails open the moment someone invents a capability name it does not anticipate.
 */
export const SELF_SELECTABLE_CAPABILITIES = ['observer', 'member', 'lead'] as const
export type SelfSelectableCapability = (typeof SELF_SELECTABLE_CAPABILITIES)[number]

/**
 * Scopes a door may permit. 'squad' is the default and the only one enabled out of the box.
 *
 * 'department' is opt-in per door because a department grant covers EVERY squad in that
 * department INCLUDING FUTURE ONES (src/auth/capability.ts department→squad inheritance).
 * That is an authority generator, not fine-grained access, and it must be a conscious
 * choice by whoever opens the door rather than a synonym for squad self-grant.
 *
 * 'org' is never selectable by this surface at all.
 */
export const SELF_SELECTABLE_SCOPES = ['squad', 'department'] as const
export type SelfSelectableScope = (typeof SELF_SELECTABLE_SCOPES)[number]

const CAPABILITY_RANK: Record<string, number> = { observer: 0, member: 1, lead: 2, admin: 3, owner: 4 }

export interface OnboardingDoor {
  id: string
  status: DoorStatus
  max_capability: SelfSelectableCapability
  allowed_scopes: SelfSelectableScope[]
  opened_by: string
  opened_at: string
  sealed_receipt_count: number | null
}

export interface SelfGrantInput {
  actorMemberId: string
  actorAgentId?: string | null
  subjectMemberId: string
  scopeType: SelfSelectableScope
  scopeId: string
  capability: SelfSelectableCapability
}

export type DoorResult<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string }

interface DoorRow {
  id: string
  status: string
  max_capability: string
  allowed_scopes: string
  opened_by: string
  opened_at: string
  sealed_receipt_count: number | null
}

function hydrateDoor(row: DoorRow): OnboardingDoor {
  let scopes: SelfSelectableScope[] = ['squad']
  try {
    const parsed: unknown = JSON.parse(row.allowed_scopes)
    if (Array.isArray(parsed)) {
      scopes = parsed.filter((s): s is SelfSelectableScope =>
        (SELF_SELECTABLE_SCOPES as readonly string[]).includes(s as string))
    }
  } catch {
    // Corrupt JSON fails CLOSED to the narrowest scope rather than to the widest.
    scopes = ['squad']
  }
  return {
    id: row.id,
    status: row.status as DoorStatus,
    max_capability: row.max_capability as SelfSelectableCapability,
    allowed_scopes: scopes,
    opened_by: row.opened_by,
    opened_at: row.opened_at,
    sealed_receipt_count: row.sealed_receipt_count,
  }
}

/** The tenant's currently-open door, or null. A unique index guarantees at most one. */
export async function getOpenDoor(env: Env): Promise<OnboardingDoor | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, max_capability, allowed_scopes, opened_by, opened_at, sealed_receipt_count
       FROM onboarding_doors WHERE tenant = ?1 AND status = 'open' LIMIT 1`,
  ).bind(env.TENANT_SLUG).first<DoorRow>()
  return row ? hydrateDoor(row) : null
}

export async function openDoor(
  env: Env,
  openedBy: string,
  opts: { maxCapability?: SelfSelectableCapability; allowedScopes?: SelfSelectableScope[] } = {},
): Promise<DoorResult<OnboardingDoor>> {
  const existing = await getOpenDoor(env)
  // Refuse rather than silently reuse: two generations would make "which door did this come
  // through" ambiguous at exactly the moment it matters — review.
  if (existing) return { ok: false, error: 'door_already_open', detail: existing.id }

  const maxCapability = opts.maxCapability ?? 'lead'
  if (!(SELF_SELECTABLE_CAPABILITIES as readonly string[]).includes(maxCapability)) {
    return { ok: false, error: 'invalid_max_capability' }
  }
  const scopes = opts.allowedScopes ?? ['squad']
  if (!scopes.length || !scopes.every((s) => (SELF_SELECTABLE_SCOPES as readonly string[]).includes(s))) {
    return { ok: false, error: 'invalid_allowed_scopes' }
  }

  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO onboarding_doors (id, tenant, status, max_capability, allowed_scopes, opened_by)
     VALUES (?1, ?2, 'open', ?3, ?4, ?5)`,
  ).bind(id, env.TENANT_SLUG, maxCapability, JSON.stringify(scopes), openedBy).run()

  const door = await getOpenDoor(env)
  return door ? { ok: true, value: door } : { ok: false, error: 'open_failed' }
}

/**
 * Grant self-selected access through an open door.
 *
 * THE GRANT AND ITS RECEIPT GO IN ONE env.DB.batch(). Not two calls, not a best-effort
 * emit afterwards. If the receipt cannot be written the capability must not exist, because
 * an unrecorded grant is precisely what makes a door uncloseable.
 *
 * `capability_before` is read BEFORE the write and stored on the receipt. That is the
 * restore key: `capabilities` upserts ON CONFLICT, so a self-grant can overwrite a
 * legitimate pre-existing grant, and rejecting at review must put the old value back
 * rather than deleting the row.
 */
export async function selfGrant(env: Env, input: SelfGrantInput): Promise<DoorResult<{ receiptId: string }>> {
  const door = await getOpenDoor(env)
  if (!door) return { ok: false, error: 'door_closed', detail: 'no onboarding door is open' }

  if (!(SELF_SELECTABLE_CAPABILITIES as readonly string[]).includes(input.capability)) {
    return { ok: false, error: 'capability_not_self_selectable' }
  }
  if (!door.allowed_scopes.includes(input.scopeType)) {
    return { ok: false, error: 'scope_not_allowed', detail: `door allows: ${door.allowed_scopes.join(',')}` }
  }
  if ((CAPABILITY_RANK[input.capability] ?? 99) > (CAPABILITY_RANK[door.max_capability] ?? 0)) {
    return { ok: false, error: 'above_door_ceiling', detail: `max: ${door.max_capability}` }
  }

  // Read the prior grant BEFORE writing. This is the only moment it is knowable.
  const prior = await env.DB.prepare(
    `SELECT id, capability FROM capabilities
      WHERE member_id = ?1 AND scope_type = ?2 AND scope_id IS ?3 LIMIT 1`,
  ).bind(input.subjectMemberId, input.scopeType, input.scopeId).first<{ id: string; capability: string }>()

  const receiptId = crypto.randomUUID()
  const grantId = prior?.id ?? crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      // CONFLICT TARGET IS THE UNIQUE TRIPLE, NOT THE PRIMARY KEY.
      //
      // capabilities declares UNIQUE(member_id, scope_type, scope_id) (0002_members.sql).
      // The first version of this statement used ON CONFLICT (id), which is the wrong
      // target: a self-grant over an EXISTING grant generates a fresh id, so the id never
      // conflicts and the write dies on the unique triple instead of updating it. Caught
      // by the restore test failing on a FOREIGN KEY/constraint error rather than by
      // reading — the upsert would have thrown on precisely the overwrite case the whole
      // receipt mechanism exists to make reversible.
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, provisional_door_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (member_id, scope_type, scope_id)
       DO UPDATE SET capability = excluded.capability,
                     provisional_door_id = excluded.provisional_door_id`,
    ).bind(grantId, input.subjectMemberId, input.scopeType, input.scopeId, input.capability, door.id),
    env.DB.prepare(
      `INSERT INTO door_receipts
         (id, tenant, door_id, actor_member_id, actor_agent_id, subject_member_id,
          scope_type, scope_id, action, capability_before, capability_after)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'self_grant', ?9, ?10)`,
    ).bind(
      receiptId, env.TENANT_SLUG, door.id, input.actorMemberId, input.actorAgentId ?? null,
      input.subjectMemberId, input.scopeType, input.scopeId,
      prior?.capability ?? null, input.capability,
    ),
  ])

  return { ok: true, value: { receiptId } }
}

/**
 * Close the door. New self-grants fail immediately; existing provisional grants KEEP
 * WORKING until review rules on them.
 *
 * Closing deliberately does NOT revoke. Yanking access at close would break every person
 * onboarded through the door at the moment an admin happened to close it, which turns a
 * review step into an outage. Close freezes and produces the review set; crystallize
 * decides.
 *
 * The receipt count is SEALED here. A later review reading a different count knows the set
 * changed underneath it.
 */
export async function closeDoor(env: Env, doorId: string, closedBy: string): Promise<DoorResult<{ sealed: number }>> {
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM door_receipts WHERE door_id = ?1`,
  ).bind(doorId).first<{ n: number }>()
  const sealed = count?.n ?? 0

  const res = await env.DB.prepare(
    `UPDATE onboarding_doors
        SET status = 'closed', closed_by = ?2, closed_at = datetime('now'), sealed_receipt_count = ?3
      WHERE id = ?1 AND tenant = ?4 AND status = 'open'`,
  ).bind(doorId, closedBy, sealed, env.TENANT_SLUG).run()

  if ((res.meta?.changes ?? 0) === 0) return { ok: false, error: 'door_not_open' }
  return { ok: true, value: { sealed } }
}

/** One receipt awaiting Athena's ruling. */
export interface PendingReceipt {
  id: string
  actor_member_id: string
  actor_agent_id: string | null
  subject_member_id: string
  scope_type: string
  scope_id: string | null
  capability_before: string | null
  capability_after: string | null
}

export async function listPendingReceipts(env: Env, doorId: string): Promise<PendingReceipt[]> {
  const res = await env.DB.prepare(
    `SELECT id, actor_member_id, actor_agent_id, subject_member_id, scope_type, scope_id,
            capability_before, capability_after
       FROM door_receipts
      WHERE door_id = ?1 AND disposition = 'pending'
      ORDER BY created_at ASC`,
  ).bind(doorId).all<PendingReceipt>()
  return res.results ?? []
}

/**
 * Apply Athena's ruling to one receipt.
 *
 * CRYSTALLIZE — the grant stops being provisional and becomes an ordinary permanent
 * capability. That is literally all "crystal the access" means: clear the door marker.
 *
 * REVOKE — restore `capability_before`. If there was no prior grant the row is DELETED; if
 * there was one it is written back exactly. This is why the receipt carries the prior
 * value: blind deletion would destroy a legitimate grant that the self-grant overwrote.
 *
 * Both paths mutate the capability and stamp the receipt in ONE batch, for the same reason
 * the grant did — a disposition that records without applying (or applies without
 * recording) is worse than none.
 */
export async function applyDisposition(
  env: Env,
  receiptId: string,
  disposition: 'crystallized' | 'revoked',
  reviewedBy: string,
  note?: string,
): Promise<DoorResult<{ applied: 'crystallized' | 'revoked' }>> {
  const r = await env.DB.prepare(
    `SELECT id, door_id, subject_member_id, scope_type, scope_id, capability_before, disposition
       FROM door_receipts WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(receiptId, env.TENANT_SLUG).first<{
    id: string; door_id: string; subject_member_id: string; scope_type: string
    scope_id: string | null; capability_before: string | null; disposition: string
  }>()
  if (!r) return { ok: false, error: 'receipt_not_found' }
  if (r.disposition !== 'pending') return { ok: false, error: 'already_disposed', detail: r.disposition }

  const stamp = env.DB.prepare(
    `UPDATE door_receipts
        SET disposition = ?2, disposition_by = ?3, disposition_at = datetime('now'), disposition_note = ?4
      WHERE id = ?1`,
  ).bind(receiptId, disposition, reviewedBy, note ?? null)

  if (disposition === 'crystallized') {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE capabilities SET provisional_door_id = NULL
          WHERE member_id = ?1 AND scope_type = ?2 AND scope_id IS ?3 AND provisional_door_id = ?4`,
      ).bind(r.subject_member_id, r.scope_type, r.scope_id, r.door_id),
      stamp,
    ])
    return { ok: true, value: { applied: 'crystallized' } }
  }

  // Revoked: restore the prior value, or remove the row if there was nothing before.
  const restore = r.capability_before === null
    ? env.DB.prepare(
        `DELETE FROM capabilities
          WHERE member_id = ?1 AND scope_type = ?2 AND scope_id IS ?3 AND provisional_door_id = ?4`,
      ).bind(r.subject_member_id, r.scope_type, r.scope_id, r.door_id)
    : env.DB.prepare(
        `UPDATE capabilities SET capability = ?5, provisional_door_id = NULL
          WHERE member_id = ?1 AND scope_type = ?2 AND scope_id IS ?3 AND provisional_door_id = ?4`,
      ).bind(r.subject_member_id, r.scope_type, r.scope_id, r.door_id, r.capability_before)

  await env.DB.batch([restore, stamp])
  return { ok: true, value: { applied: 'revoked' } }
}

/**
 * Finalize a closed door once every receipt has a ruling. Refuses while any remain pending,
 * so "crystallized" cannot come to mean "we stopped looking".
 */
export async function crystallizeDoor(env: Env, doorId: string, reviewedBy: string): Promise<DoorResult<{ receipts: number }>> {
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM door_receipts WHERE door_id = ?1 AND disposition = 'pending'`,
  ).bind(doorId).first<{ n: number }>()
  if ((pending?.n ?? 0) > 0) {
    return { ok: false, error: 'receipts_pending', detail: `${pending?.n} awaiting review` }
  }

  const res = await env.DB.prepare(
    `UPDATE onboarding_doors
        SET status = 'crystallized', reviewed_by = ?2, crystallized_at = datetime('now')
      WHERE id = ?1 AND tenant = ?3 AND status = 'closed'`,
  ).bind(doorId, reviewedBy, env.TENANT_SLUG).run()
  if ((res.meta?.changes ?? 0) === 0) return { ok: false, error: 'door_not_closed' }

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM door_receipts WHERE door_id = ?1`,
  ).bind(doorId).first<{ n: number }>()
  return { ok: true, value: { receipts: total?.n ?? 0 } }
}
