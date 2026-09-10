// tests/enroll-mint-owner-plane.test.ts
//
// THE ORG OWNER COULD NOT MINT A SEAT ON HIS OWN POT.
//
// Reported by hadi@mumega.com 2026-09-09 against prod 04586ef8: the enrollment
// page LISTS the existing Hadi Assistant seat, and minting it returns
// squad_admin_required. Visible seat, refused mint.
//
// Cause, one line: `const grants = auth.capabilities ?? []`, then a check that
// only reads grants. Org-owner authority lives on the LEGACY ROLE plane
// (auth.role === 'owner'), and the auth bridge deliberately leaves
// auth.capabilities UNDEFINED for an owner — assigning [] is what downgrades
// them. So `?? []` materialises an empty grant list for precisely the principal
// with the most authority in the pot, and no amount of additional authority
// fixes it, because none of it is visible to the check.
//
// BOTH doors that mint an agent credential had it, identically:
//   src/mcp/provision.ts    mint_agent_token
//   src/dashboard/enroll.ts authorizeEnrollMint
//
// which is why the repair is at the shared seam (canOnSquadAuth) and both
// consume it. src/dashboard/enroll.ts:128-136 records Athena's ruling on
// PR #1254: enroll matches the MCP primitive, and "if the intended policy is in
// fact org admin everywhere, the fix is to raise mint_agent_token — the
// primitive — and let both dashboard routes inherit it. Do not raise this route
// alone." Patching the dashboard route by itself would have re-created the
// divergence in the other direction.
//
// The BAR IS UNCHANGED: admin on the squad, org/department inheriting exactly as
// hasCapability already allowed. Only the blindness is removed. The refusal
// cases below exist to prove that.

import { describe, expect, it } from 'vitest'
import { canOnSquadAuth } from '../src/auth/capability'
import { authorizeEnrollMint } from '../src/dashboard/enroll'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-ownermint'
const SQUAD = 'squad-hadi-cc'
const OTHER_SQUAD = 'squad-elsewhere'
const DEPT = 'dept-eng'

function harnessEnv(): { h: SqliteD1Harness; env: Env } {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT}', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD}', '${DEPT}', 'hadi-cc', 'Hadi CC'),
      ('${OTHER_SQUAD}', '${DEPT}', 'elsewhere', 'Elsewhere');
  `)
  return { h, env: { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env }
}

/** The org owner as the bridge actually builds him: role on the legacy plane,
 *  capabilities UNDEFINED (never []), and zero rows in `capabilities`. */
function ownerAuth(): AuthContext {
  return {
    userId: 'owner-1',
    memberId: 'mem-hadi',
    email: 'hadi@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: undefined,
  } as unknown as AuthContext
}

function memberAuth(grants: Array<Record<string, unknown>> = []): AuthContext {
  return {
    userId: 'mem-2',
    memberId: 'mem-2',
    email: 'someone@x.test',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: grants,
  } as unknown as AuthContext
}

describe('the org owner can mint a seat on his own pot', () => {
  it('REGRESSION: authorizeEnrollMint accepts the role-plane owner', async () => {
    const { h, env } = harnessEnv()
    try {
      const rows = h.sqlite.prepare('SELECT COUNT(*) n FROM capabilities').all() as Array<{ n: number }>
      expect(rows[0].n).toBe(0) // the whole point: authority with no grant rows

      const out = await authorizeEnrollMint(env, ownerAuth(), SQUAD)
      expect(out.ok, out.ok ? '' : `refused: ${out.reason}`).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('REGRESSION: the shared seam accepts the owner on any squad', async () => {
    const { h, env } = harnessEnv()
    try {
      expect(await canOnSquadAuth(env, ownerAuth(), SQUAD, 'admin')).toBe(true)
      expect(await canOnSquadAuth(env, ownerAuth(), OTHER_SQUAD, 'admin')).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  // ── the bar is UNCHANGED — these prove it is not a widening ────────────────

  // ── the seam honours its own `min` on BOTH planes ─────────────────────────
  // Gate finding (kasra-review, 2026-09-10, WARN-1): the first draft answered the
  // role plane with isOrgAdmin(), which is hardcoded to an admin-rank question and
  // never consults `min`. Both call sites pass 'admin', so it was latent — but the
  // file's own header calls itself the FROZEN contract peers build against, and a
  // rank ceiling must guard the TARGET, not only the grant. These pin the ladder.

  it('a role-plane ADMIN does not satisfy min=owner', async () => {
    const { h, env } = harnessEnv()
    try {
      const adminRole = { ...ownerAuth(), role: 'admin' } as unknown as AuthContext
      expect(await canOnSquadAuth(env, adminRole, SQUAD, 'admin')).toBe(true)
      expect(await canOnSquadAuth(env, adminRole, SQUAD, 'owner')).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('a role-plane OWNER does satisfy min=owner', async () => {
    const { h, env } = harnessEnv()
    try {
      expect(await canOnSquadAuth(env, ownerAuth(), SQUAD, 'owner')).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('an ORG-GRANT admin does not satisfy min=owner either — parity with canOnSquad', async () => {
    const { h, env } = harnessEnv()
    try {
      const orgAdmin = memberAuth([
        { member_id: 'mem-2', scope_type: 'org', scope_id: null, capability: 'admin' },
      ])
      expect(await canOnSquadAuth(env, orgAdmin, SQUAD, 'admin')).toBe(true)
      expect(await canOnSquadAuth(env, orgAdmin, SQUAD, 'owner')).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('a plain member with NO grants is still refused', async () => {
    const { h, env } = harnessEnv()
    try {
      const out = await authorizeEnrollMint(env, memberAuth([]), SQUAD)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('squad_admin_required')
    } finally {
      h.sqlite.close()
    }
  })

  it('a squad LEAD is still refused — admin is the bar', async () => {
    const { h, env } = harnessEnv()
    try {
      const out = await authorizeEnrollMint(
        env,
        memberAuth([{ member_id: 'mem-2', scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }]),
        SQUAD,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it("a squad admin on ANOTHER squad is still refused for this one", async () => {
    const { h, env } = harnessEnv()
    try {
      const out = await authorizeEnrollMint(
        env,
        memberAuth([{ member_id: 'mem-2', scope_type: 'squad', scope_id: OTHER_SQUAD, capability: 'admin' }]),
        SQUAD,
      )
      expect(out.ok).toBe(false)
    } finally {
      h.sqlite.close()
    }
  })

  it('a squad admin on THIS squad is accepted, as before', async () => {
    const { h, env } = harnessEnv()
    try {
      const out = await authorizeEnrollMint(
        env,
        memberAuth([{ member_id: 'mem-2', scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }]),
        SQUAD,
      )
      expect(out.ok).toBe(true)
    } finally {
      h.sqlite.close()
    }
  })

  it('an AGENT-bound caller is still refused first, owner role or not', async () => {
    // operator_principal_required precedes the capability question and must not
    // be reachable past it — an agent-bound session carrying role 'owner' (which
    // the internal-header path can produce) must still be refused as an agent.
    const { h, env } = harnessEnv()
    try {
      const agentOwner = { ...ownerAuth(), boundAgentId: 'agent-1' } as unknown as AuthContext
      const out = await authorizeEnrollMint(env, agentOwner, SQUAD)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('operator_principal_required')
    } finally {
      h.sqlite.close()
    }
  })
})
