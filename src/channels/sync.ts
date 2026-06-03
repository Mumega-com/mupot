// mupot — channels membership SYNC (the microkernel's reconcile loop). Keeps the
// squad's capability grants in step with who is actually IN each bound channel:
// the platform's scoped channel IS the squad, so channel membership ⇒ squad
// 'member' capability (bounded by the per-binding ceiling).
//
// MICROKERNEL DISCIPLINE: zero platform specifics. We call only the adapter's
// listChannelMembers (and optional roleCapability) through the registry; the
// adapter owns every platform call.
//
// SOVEREIGN-CORE DISCIPLINE
//   - Identity is the platform→member MAPPING (member_identities). A channel
//     member with NO identity row is simply not a known member yet — we never
//     fabricate one here (binding happens via '/link' or Google auto-bind on a
//     real inbound message, where the claim is proven).
//   - CEILING: a sync grant NEVER exceeds binding.max_capability. The default
//     ceiling is 'member'; an admin may raise it per binding. roleCapability (when
//     the adapter maps platform roles) is still clamped to the ceiling.
//   - We ONLY manage the 'member'-tier sync grant on the squad. A MANUAL grant
//     above member (lead/admin/owner) — set by an admin via the members API — is
//     left untouched on both grant and revoke. Sync owns the floor, not the
//     hand-curated leadership.

import type { Env, Capability, ChannelBinding } from '../types'
import { capabilityRank } from '../auth/capability'
import { getAdapter } from './registry'

// The capability sync grants/revokes by default. Channel membership ⇒ squad
// membership. Anything ABOVE this on a squad is a manual grant we never disturb.
const SYNC_BASE: Capability = 'member'

// ── reconcile one binding ─────────────────────────────────────────────────────
// For a single channel↔squad binding:
//   1. List the channel's current platform user ids (adapter).
//   2. Map each to a member via member_identities (this platform).
//   3. Ensure every mapped member has >= the target capability on the squad, where
//      target = min(ceiling, roleCapability ?? SYNC_BASE). Grant if missing/lower.
//   4. Revoke the squad sync grant for any member who holds a sync-tier squad
//      grant but is NO LONGER in the channel — but ONLY at the sync tier; a manual
//      higher grant (lead+) is preserved.
async function reconcileBinding(env: Env, binding: ChannelBinding): Promise<void> {
  const adapter = getAdapter(binding.platform)
  if (!adapter) return // unknown platform → nothing this core can reconcile

  const ceilingRank = capabilityRank(binding.max_capability)

  // 1) Who is in the channel right now (external user ids).
  let externalIds: string[]
  try {
    externalIds = await adapter.listChannelMembers(env, binding.external_channel_id)
  } catch (err) {
    // A platform we cannot list, we cannot safely reconcile — skip (do NOT revoke
    // everyone on a transient API error; that would strip access on every blip).
    console.error('channels.sync: listChannelMembers failed', {
      platform: binding.platform,
      channel: binding.external_channel_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // 2) Map external ids → member ids (only those already bound to a member).
  const presentMemberIds = new Set<string>()
  for (const extId of externalIds) {
    const memberId = await memberIdForExternal(env, binding.platform, extId)
    if (!memberId) continue // unbound platform user — not a known member yet
    presentMemberIds.add(memberId)

    // Determine the target capability for this member: a platform role mapping
    // (when the adapter provides one), clamped to the binding ceiling, never below
    // the SYNC_BASE. Then ensure the squad grant meets it.
    let targetRank = capabilityRank(SYNC_BASE)
    if (adapter.roleCapability) {
      try {
        const role = await adapter.roleCapability(env, binding.external_channel_id, extId)
        if (role) targetRank = Math.max(targetRank, capabilityRank(role))
      } catch {
        // Role lookup failed → fall back to the base sync tier; do not block.
      }
    }
    // CEILING: never above max_capability for this binding.
    targetRank = Math.min(targetRank, ceilingRank)

    await ensureSquadGrant(env, memberId, binding.squad_id, targetRank)
  }

  // 3) Revoke the sync-tier grant for members who left the channel. We only ever
  // remove a grant whose capability is AT OR BELOW the ceiling AND at/below the
  // sync base+ceiling band — i.e. a grant this sync loop itself could have made.
  // Manual grants above the ceiling are preserved (sync owns the floor only).
  await revokeDepartedMembers(env, binding, presentMemberIds, ceilingRank)
}

// member_identities: platform user id → member id (or null when unbound).
async function memberIdForExternal(
  env: Env,
  platform: string,
  externalUserId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT member_id FROM member_identities
      WHERE platform = ?1 AND external_user_id = ?2
      LIMIT 1`,
  )
    .bind(platform, externalUserId)
    .first<{ member_id: string }>()
  return row?.member_id ?? null
}

// Ensure the member holds AT LEAST `targetRank` capability on the squad. If they
// already hold an equal-or-higher squad grant, leave it (never downgrade a manual
// higher grant). Otherwise upsert the grant at exactly the target capability. The
// target is always already clamped to the binding ceiling by the caller.
async function ensureSquadGrant(
  env: Env,
  memberId: string,
  squadId: string,
  targetRank: number,
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT capability FROM capabilities
      WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2
      LIMIT 1`,
  )
    .bind(memberId, squadId)
    .first<{ capability: Capability }>()

  if (existing && capabilityRank(existing.capability) >= targetRank) {
    return // already at/above target — preserve (could be a manual higher grant)
  }

  const targetCap = capabilityForRank(targetRank)

  // Upsert: delete any lower squad grant for this member, insert the target. The
  // schema's UNIQUE(member_id, scope_type, scope_id) makes (squad, id) unique, but
  // SQLite treats two NULLs as distinct — scope_id here is a real squad id, so the
  // delete-then-insert is exact. D1 is single-writer per DB → serialized.
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM capabilities WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2`,
    ).bind(memberId, squadId),
    env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES (?1, ?2, 'squad', ?3, ?4)`,
    ).bind(crypto.randomUUID(), memberId, squadId, targetCap),
  ])
}

// Revoke the squad grant for members who hold a sync-tier squad grant but are no
// longer present in the channel. We DELETE only when the existing grant's rank is
// AT OR BELOW the binding ceiling — i.e. a grant sync could have produced. A
// manual grant ABOVE the ceiling (admin-curated leadership) is left intact.
async function revokeDepartedMembers(
  env: Env,
  binding: ChannelBinding,
  presentMemberIds: Set<string>,
  ceilingRank: number,
): Promise<void> {
  // All members currently holding a squad-scoped grant on this binding's squad.
  const rows = await env.DB.prepare(
    `SELECT member_id, capability FROM capabilities
      WHERE scope_type = 'squad' AND scope_id = ?1`,
  )
    .bind(binding.squad_id)
    .all<{ member_id: string; capability: Capability }>()

  for (const row of rows.results ?? []) {
    if (presentMemberIds.has(row.member_id)) continue // still in the channel

    // Only revoke grants at/below the ceiling — never strip a manual higher grant.
    if (capabilityRank(row.capability) > ceilingRank) continue

    await env.DB.prepare(
      `DELETE FROM capabilities
        WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2`,
    )
      .bind(row.member_id, binding.squad_id)
      .run()
  }
}

// ── rank → capability (inverse of capabilityRank) ─────────────────────────────
// The ladder is fixed (owner 5 … observer 1). We resolve a numeric target back to
// its capability name for the grant write. Clamped defensively to the valid band.
const RANK_TO_CAP: Record<number, Capability> = {
  5: 'owner',
  4: 'admin',
  3: 'lead',
  2: 'member',
  1: 'observer',
}
function capabilityForRank(rank: number): Capability {
  const clamped = Math.max(1, Math.min(5, Math.round(rank)))
  return RANK_TO_CAP[clamped]
}

// ── reconcileMembership — the public entry (cron / admin trigger) ─────────────
// Walk EVERY channel binding in this pot and reconcile its squad membership. One
// failing binding is isolated so the rest still reconcile. Returns a small report
// the caller (cron log / admin response) can surface.
export async function reconcileMembership(
  env: Env,
): Promise<{ bindings: number; reconciled: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id, platform, external_channel_id, squad_id, max_capability, created_at
       FROM channel_bindings`,
  ).all<ChannelBinding>()
  const bindings = rows.results ?? []

  let reconciled = 0
  let failed = 0
  for (const binding of bindings) {
    try {
      await reconcileBinding(env, binding)
      reconciled += 1
    } catch (err) {
      failed += 1
      console.error('channels.sync: binding reconcile failed', {
        binding: binding.id,
        platform: binding.platform,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { bindings: bindings.length, reconciled, failed }
}
