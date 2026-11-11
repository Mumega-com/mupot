// mupot — who may become the pot's OWNER on a first Google web sign-in.
//
// The old rule was "first row in `users`" (a global COUNT). That is wrong: pot provisioning
// (src/pots/service.ts) writes the real owner's `members` row + an org `owner` capability and NO `users`
// row, and MCP OAuth connects write `members` only. A provisioned pot therefore has zero `users` rows
// until the owner's first web sign-in, and the first stranger to arrive became owner.
//
// Two ways to become `owner` on the Google web door, nothing else:
//  1. The provisioned owner: the verified email matches an ACTIVE, non-archived, non-superseded member of THIS
//     tenant that holds a live org-scope `owner` capability.
//  2. A truly empty pot, claimed atomically (see claimFirstOwner).
// Everyone else is a `member` here (what upsertUserByEmail did for any non-first user before).

import type { Env } from '../types'
import { CAPABILITY_LIVE_PREDICATE, nowCapabilitySql } from './capability'
import { notSupersededSql } from '../members/exclusive-control'
import { resolveHumanMemberForAttach } from '../members/resolve-human-member'

/**
 * "Empty" = ALL of: no `users` row (users has no tenant column; one D1 per deployment), no HUMAN member (a member row with no agent_member_bindings row)
 * in THIS tenant, no org-scope owner/admin capability held by any member of THIS tenant, no owner_bootstrap_claim
 * (migration 0044, the singleton the token bootstrap route also uses). ?1 = tenant.
 */
export const POT_IS_EMPTY_SQL = `
  NOT EXISTS (SELECT 1 FROM users)
  AND NOT EXISTS (
    SELECT 1 FROM members hm WHERE hm.tenant = ?1
       AND NOT EXISTS (SELECT 1 FROM agent_member_bindings ab WHERE ab.member_id = hm.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM capabilities c JOIN members cm ON cm.id = c.member_id
     WHERE cm.tenant = ?1 AND c.scope_type = 'org' AND c.capability IN ('owner', 'admin')
  )
  AND NOT EXISTS (SELECT 1 FROM owner_bootstrap_claim)`

/**
 * Atomic first-owner claim. ONE D1 batch (a transaction; D1 serialises writes per database):
 *   1. INSERT the owner users row only WHERE the pot is empty.
 *   2. INSERT the singleton claim row only WHERE that user row now exists as owner and no claim exists.
 * Two simultaneous first sign-ins: whichever batch runs second sees a non-empty pot, so its INSERT writes 0 rows and it
 * is NOT owner. No read-then-write window: the emptiness test and the write are the same statement.
 * Returns true only when THIS call's user row was written as owner.
 */
export async function claimFirstOwner(env: Env, userId: string, email: string | null): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, role) SELECT ?2, ?3, 'owner' WHERE ${POT_IS_EMPTY_SQL}`,
    ).bind(env.TENANT_SLUG, userId, email),
    env.DB.prepare(
      `INSERT INTO owner_bootstrap_claim (singleton, user_id, claimed_at)
       SELECT 1, ?1, datetime('now')
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND role = 'owner')
          AND NOT EXISTS (SELECT 1 FROM owner_bootstrap_claim)`,
    ).bind(userId),
  ])
  return Number(results[0]?.meta?.changes ?? 0) === 1
}

/**
 * True when this verified email is the provisioned owner: the SHARED resolver (never a raw email read, mupot#1578/#1583)
 * resolves it to an ACTIVE member of this tenant, and that member holds a live org-scope `owner` capability and is not archived
 * or superseded. `denied`/`ambiguous` (a competing credential, an email collision) is NOT owner here.
 */
export async function isProvisionedOwnerEmail(env: Env, email: string | null): Promise<boolean> {
  if (!email) return false
  const resolved = await resolveHumanMemberForAttach(env, { tenant: env.TENANT_SLUG, email: email.trim().toLowerCase() }, true)
  if (resolved.kind !== 'resolved') return false
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM members m JOIN capabilities c ON c.member_id = m.id
      WHERE m.id = ?1 AND m.tenant = ?2 AND m.status = 'active' AND m.archived_at IS NULL
        AND ${notSupersededSql('m')}
        AND c.scope_type = 'org' AND c.capability = 'owner' AND ${CAPABILITY_LIVE_PREDICATE('c', '?3')}
      LIMIT 1`,
  )
    .bind(resolved.member.id, env.TENANT_SLUG, nowCapabilitySql())
    .first<{ present: number }>()
  return row !== null
}
