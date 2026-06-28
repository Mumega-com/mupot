// mupot — S196 squad-seed (Slice A).
//
// Idempotent mechanism that creates mupot `members` + `capabilities` rows for
// the Mumega squad: hadi (owner), loom (lead), kasra/river/codex (member),
// and a +1 colleague placeholder (observer). All writes use INSERT OR IGNORE so
// re-running is a safe no-op.
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
// Capability map (§2A S196):
//   hadi      → owner    @ org
//   loom      → lead     @ org     (weaver / CFO, runs the ledger)
//   kasra     → member   @ squad   (build arm — squad-scoped; falls back to org)
//   river     → member   @ squad   (editor / creative)
//   codex     → member   @ squad   (adversarial review arm)
//   colleague → observer @ org     (placeholder; elevated at dock by admin)
//
// The squadId is optional. When provided, agent members (kasra/river/codex) are
// granted at squad scope. When absent they fall back to org scope so the grants
// are still useful without a squad pre-existing.

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

/** Build the full squad definition for the given optional squadId. */
export function buildSquadDefs(squadId: string | null): SquadMemberDef[] {
  // Agent-scoped members default to squad scope when squadId is provided, else org.
  const agentScope: { scope_type: CapabilityScopeType; scope_id: string | null } =
    squadId
      ? { scope_type: 'squad', scope_id: squadId }
      : { scope_type: 'org', scope_id: null }

  return [
    {
      slug: 'hadi',
      display_name: 'Hadi Servat',
      email: 'hadi@mumega.com',
      capability: 'owner',
      scope_type: 'org',
      scope_id: null,
    },
    {
      slug: 'loom',
      display_name: 'Loom',
      email: 'loom@agents.mumega.com',
      capability: 'lead',
      scope_type: 'org',
      scope_id: null,
    },
    {
      slug: 'kasra',
      display_name: 'Kasra',
      email: 'kasra@agents.mumega.com',
      capability: 'member',
      ...agentScope,
    },
    {
      slug: 'river',
      display_name: 'River',
      email: 'river@agents.mumega.com',
      capability: 'member',
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
      slug: 'colleague',
      display_name: 'Colleague (placeholder)',
      email: 'colleague@mumega.com',
      capability: 'observer',
      scope_type: 'org',
      scope_id: null,
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
  reason: 'db_error'
  detail: string
}

// ── seed function (idempotent) ─────────────────────────────────────────────────

/**
 * seedSquadMembers — idempotent seed of the Mumega squad onto this pot.
 *
 * @param env      the Cloudflare Worker environment (must have env.DB)
 * @param squadId  optional squad UUID: when provided, kasra/river/codex are
 *                 granted at squad scope; when absent they fall back to org scope.
 *
 * All writes are INSERT OR IGNORE — safe to re-run at any time. The function
 * NEVER writes member_tokens (tokens are minted at dock time via the admin UI).
 *
 * APPLY-GATED: this function must only be called from an explicit operator script
 * or a test against a local/test D1. It is NOT called on startup.
 */
export async function seedSquadMembers(
  env: Env,
  squadId: string | null = null,
): Promise<SeedResult | SeedFailure> {
  const defs = buildSquadDefs(squadId)
  const now = new Date().toISOString()
  const results: SeedResult['seeded'] = []

  for (const def of defs) {
    try {
      const memberId = await deterministicMemberId(def.slug)
      const grantId = await deterministicGrantId(memberId, def.scope_type, def.scope_id)

      // INSERT OR IGNORE: idempotent member creation.
      // email UNIQUE constraint: if the member row already exists (same email or same id),
      // this is a safe no-op — the existing row is preserved.
      const memberResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO members (id, email, display_name, status, created_at)
         VALUES (?1, ?2, ?3, 'active', ?4)`,
      )
        .bind(memberId, def.email, def.display_name, now)
        .run()

      const memberInserted = (memberResult.meta?.changes ?? 0) > 0

      // INSERT OR IGNORE: idempotent capability grant.
      // The UNIQUE(member_id, scope_type, scope_id) constraint ensures an existing
      // grant is preserved (the existing capability level is NOT overwritten, preventing
      // an accidental downgrade on re-seed).
      const grantResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(grantId, memberId, def.scope_type, def.scope_id, def.capability, now)
        .run()

      const grantInserted = (grantResult.meta?.changes ?? 0) > 0

      results.push({ slug: def.slug, memberId, inserted: memberInserted, grantInserted })
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
