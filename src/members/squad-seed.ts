// mupot — S196 squad-seed (Slice A).
//
// Idempotent mechanism that creates mupot `members` + `capabilities` rows for
// the Mumega squad (S196 confirmed map, Hadi-direct 2026-06-28):
//   hadi → owner @ org · kasra → admin · loom → lead · river → lead ·
//   codex → member · mumega-brain → member (all squad-scope except hadi).
// All writes use INSERT OR IGNORE so re-running is a safe no-op.
//
// DISCIPLINE (same as the rest of the sovereign core):
//   - This module has NO side-effects on import. seedSquadMembers() is called
//     explicitly by an apply-gated script or a test — never on startup.
//   - No prod D1 is touched by default. Pass a local/test DB; the caller owns
//     the lifecycle (see scripts/seed-squad.ts for the apply-gated entry point).
//   - Capabilities are server-prescribed (hardcoded to the squad definition) —
//     never taken from request input.
//   - The seed NEVER writes member_tokens (tokens are minted at dock time by the
//     pot's own /admin/members flow — dogfooding the existing surface).
//
// Capability map (S196 confirmed, Hadi-direct 2026-06-28):
//   hadi         → owner  @ org    (unchanged; pre-existing mem-hadi)
//   kasra        → admin  @ squad  (build arm — squad-admin, bounded; NOT org-admin)
//   loom         → lead   @ squad  (weaver / CFO, runs the ledger)
//   river        → lead   @ squad  (editor / creative)
//   codex        → member @ squad  (adversarial review arm)
//   mumega-brain → member @ squad  (the prioritizer / ATC)
//
// The squadId is optional. When provided, the agents are granted at squad scope.
// When absent they fall back to org scope (same caps) so the grants are still
// useful without a squad pre-existing.

import type { Env, CapabilityScopeType, Capability } from '../types'

// ── seed definitions ──────────────────────────────────────────────────────────

/** A single squad-member definition to seed. */
export interface SquadMemberDef {
  /** Stable slug — used as the member id deterministically so re-seeds are idempotent
   *  even if the DB is wiped and re-seeded (the same slug → same UUID via namespacing). */
  slug: string
  display_name: string
  email: string
  capability: Capability
  scope_type: CapabilityScopeType
  /** null for org-scope grants, the squadId arg for squad-scope grants. */
  scope_id: string | null
}

/** Deterministic UUID v5-like: sha256 of "mupot-squad-seed:<slug>", first 32 hex chars
 *  formatted as 8-4-4-4-12. Stable across re-seeds so INSERT OR IGNORE is correct. */
export async function deterministicMemberId(slug: string): Promise<string> {
  const raw = new TextEncoder().encode(`mupot-squad-seed:${slug}`)
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  // format as UUID (8-4-4-4-12) from first 32 hex chars
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Capability grant ID: deterministic from memberId + scope. */
async function deterministicGrantId(memberId: string, scopeType: CapabilityScopeType, scopeId: string | null): Promise<string> {
  const raw = new TextEncoder().encode(`mupot-squad-grant:${memberId}:${scopeType}:${scopeId ?? 'org'}`)
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Build the full squad definition. squadId is REQUIRED: squad agents are granted
 *  at squad scope only. There is deliberately NO org-scope fallback — an org-scope
 *  fallback would silently make kasra=admin@org (org-admin), an escalation past the
 *  "bounded squad-admin" intent. hadi alone is org-scoped (the org owner). */
export function buildSquadDefs(squadId: string): SquadMemberDef[] {
  const agentScope: { scope_type: CapabilityScopeType; scope_id: string | null } = {
    scope_type: 'squad',
    scope_id: squadId,
  }

  return [
    // hadi is the org owner — ALWAYS org scope, unchanged (pre-existing mem-hadi).
    {
      slug: 'hadi',
      display_name: 'Hadi Servat',
      email: 'hadi@mumega.com',
      capability: 'owner',
      scope_type: 'org',
      scope_id: null,
    },
    // Squad agents (S196 confirmed map, Hadi-direct 2026-06-28): squad-scope when a
    // squadId is provided, org fallback (same caps) when absent.
    {
      slug: 'kasra',
      display_name: 'Kasra',
      email: 'kasra@agents.mumega.com',
      capability: 'admin',
      ...agentScope,
    },
    {
      slug: 'loom',
      display_name: 'Loom',
      email: 'loom@agents.mumega.com',
      capability: 'lead',
      ...agentScope,
    },
    {
      slug: 'river',
      display_name: 'River',
      email: 'river@agents.mumega.com',
      capability: 'lead',
      ...agentScope,
    },
    {
      slug: 'codex',
      display_name: 'Codex',
      email: 'codex@agents.mumega.com',
      capability: 'member',
      ...agentScope,
    },
    {
      slug: 'mumega-brain',
      display_name: 'Mumega Brain',
      email: 'mumega-brain@agents.mumega.com',
      capability: 'member',
      ...agentScope,
    },
  ]
}

// ── result type ────────────────────────────────────────────────────────────────

export interface SeedResult {
  ok: true
  seeded: Array<{ slug: string; memberId: string; inserted: boolean; grantInserted: boolean }>
}

export interface SeedFailure {
  ok: false
  reason: 'db_error' | 'squad_required'
  detail: string
}

// ── seed function (idempotent) ─────────────────────────────────────────────────

/**
 * seedSquadMembers — idempotent seed of the Mumega squad onto this pot.
 *
 * @param env      the Cloudflare Worker environment (must have env.DB)
 * @param squadId  REQUIRED squad UUID — all squad agents are granted at squad scope.
 *                 There is NO org-scope fallback (that would escalate kasra to
 *                 org-admin). An empty squadId fails closed ('squad_required').
 *
 * All writes are INSERT OR IGNORE — safe to re-run at any time. The function
 * NEVER writes member_tokens (tokens are minted at dock time via the admin UI).
 *
 * APPLY-GATED: this function must only be called from an explicit operator script
 * or a test against a local/test D1. It is NOT called on startup.
 *
 * EXISTING-MEMBER SAFETY (BLOCK-1 fix): the seed uses a deterministic synthetic
 * UUID for fresh members. If a member already exists in the DB with the same
 * email (e.g. hadi@mumega.com was onboarded earlier with a different UUID), the
 * member INSERT OR IGNORE no-ops correctly — but we MUST look up the real
 * existing member_id by email and bind that to the capability insert. Using the
 * synthetic UUID for the capability would create an orphan (member_id that has
 * no matching members.id row) because capabilities.member_id FK-references
 * members.id. We resolve this by always reading back the true member id when
 * the INSERT is a no-op.
 */
export async function seedSquadMembers(
  env: Env,
  squadId: string,
): Promise<SeedResult | SeedFailure> {
  // Fail closed: squad-scoped grants require a squad. Never fall back to org
  // scope (that would make kasra=admin@org — an escalation past squad-admin).
  if (!squadId) {
    return {
      ok: false,
      reason: 'squad_required',
      detail: 'seedSquadMembers requires a squadId — no org-scope fallback for squad agents',
    }
  }
  const defs = buildSquadDefs(squadId)
  const now = new Date().toISOString()
  const results: SeedResult['seeded'] = []

  for (const def of defs) {
    try {
      const syntheticId = await deterministicMemberId(def.slug)

      // Step 1: INSERT OR IGNORE the member row using the deterministic id.
      // If the email already exists (prior onboarding with a different UUID), the
      // insert is silently ignored — the existing row is preserved.
      const memberResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO members (id, email, display_name, status, created_at, tenant)
         VALUES (?1, ?2, ?3, 'active', ?4, ?5)`,
      )
        .bind(syntheticId, def.email, def.display_name, now, env.TENANT_SLUG)
        .run()

      const memberInserted = (memberResult.meta?.changes ?? 0) > 0

      // Step 2: Resolve the AUTHORITATIVE member_id for the capability grant.
      // If the INSERT was a no-op, look up the real existing id by email so the
      // capability row references a real members.id (not an orphaned synthetic id).
      let effectiveMemberId = syntheticId
      if (!memberInserted) {
        const existing = await env.DB.prepare(
          `SELECT id FROM members WHERE email = ?1 LIMIT 1`,
        )
          .bind(def.email)
          .first<{ id: string }>()

        if (!existing) {
          // INSERT was no-op but lookup failed — concurrent delete or DB error.
          return {
            ok: false,
            reason: 'db_error',
            detail: `member ${def.slug} (${def.email}) exists but id lookup failed after no-op insert`,
          }
        }
        effectiveMemberId = existing.id
      }

      // Step 3: INSERT OR IGNORE the capability grant using the authoritative id.
      // UNIQUE(member_id, scope_type, scope_id) ensures an existing grant is
      // preserved; the existing capability level is NOT overwritten on re-seed.
      const grantId = await deterministicGrantId(effectiveMemberId, def.scope_type, def.scope_id)
      const grantResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(grantId, effectiveMemberId, def.scope_type, def.scope_id, def.capability, now)
        .run()

      const grantInserted = (grantResult.meta?.changes ?? 0) > 0

      results.push({ slug: def.slug, memberId: effectiveMemberId, inserted: memberInserted, grantInserted })
    } catch (err) {
      return {
        ok: false,
        reason: 'db_error',
        detail: `seed failed for ${def.slug}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return { ok: true, seeded: results }
}
