// tests/agent-self-update.test.ts — mupot#1288: update_agent's SELF LANE.
//
// Before this fix, update_agent unconditionally refused every agent-bound
// caller (`operator_principal_required`), then required org/squad admin for
// everyone else — so an agent that drifted (re-harnessed onto a different
// model, re-purposed) could only be repaired by an org admin. Athena ruled
// (2026-08) that a self-row registry write is inside an agent's own
// authority: an agent-bound caller whose resolved target IS its own row may
// now patch model/model_fallback/purpose/skills without admin.
//
// REWORKED after Kasra's adversarial gate BLOCKED the first version (PR
// #1289, https://github.com/Mumega-com/mupot/pull/1289#issuecomment-5533523658):
//
//   F1 — `min: 'admin'` on the tool is enforced centrally in invokeTool
//        (src/mcp/index.ts's AAGATE floor) BEFORE run() is ever entered, so
//        every non-admin agent-bound caller still got 403 forbidden before
//        this rework, identical to base — the lane was unreachable for the
//        population it exists for. Fixed by lowering `min` to 'authenticated'
//        and moving the FULL admin check into the tool's own non-self branch.
//        Proven here by going through `invokeTool` (the real seam), not
//        `.run()` directly, on every test in this file.
//   F2/F5 — name/role are operator-authored identity interpolated RAW into
//        the agent's own system turn (src/agents/execute.ts, loop.ts,
//        agent-do.ts); a self-lane that could touch them was a durable
//        prompt-self-poisoning path, and `name` also squats `resolve_agent`.
//        Fixed by removing both from SELF_PATCHABLE_FIELDS and adding them to
//        SELF_FORBIDDEN_FIELDS — closed by construction, not by filtering.
//   F3 — no shape caps on the self fields (checked in updateAgentProfile so
//        the admin path gets them too).
//   F4 — `role: null` / `model: null` threw a raw NOT NULL constraint
//        violation up as an opaque 500 instead of failing closed.
//   N3 — no test proving SELF_PATCHABLE_FIELDS/SELF_FORBIDDEN_FIELDS actually
//        partition the admin patch surface.
//
// Real SQLite, all migrations applied, tool invoked via `invokeTool` (the
// production dispatch seam: capability floor -> schema validation -> run()),
// same pattern as tests/boot-self-report.test.ts.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { ADMIN_PATCHABLE_FIELDS, SELF_FORBIDDEN_FIELDS, SELF_PATCHABLE_FIELDS } from '../src/mcp/provision'
import { createAgent } from '../src/org/service'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const ORIGIN = 'https://pot.test'

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

interface AuthOpts {
  boundAgentId?: string | null
  memberId?: string
  capabilities?: CapabilityGrant[]
}

function auth(opts: AuthOpts = {}): AuthContext {
  return {
    userId: opts.boundAgentId ? `agent:${opts.boundAgentId}` : 'operator-caller',
    email: opts.boundAgentId ? null : 'operator@example.com',
    role: 'member',
    tenant: 'test',
    channel: 'workspace',
    memberId: opts.memberId ?? 'member-operator',
    capabilities: opts.capabilities ?? [],
    boundAgentId: opts.boundAgentId ?? null,
  } as AuthContext
}

interface UpdateAgentResult {
  agent?: { model: string; purpose: string | null; slug: string; capabilities: string[] | null }
  changed?: Record<string, { from: unknown; to: unknown }>
  audit_id?: string
}

describe('update_agent — self lane (mupot#1288, reworked post-gate PR #1289)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let events: unknown[]
  let selfAgentId: string
  let otherAgentId: string
  const squadId = 'sq-a'

  const invoke = (a: AuthContext, args: Record<string, unknown>) => invokeTool(a, env, 'update_agent', args, ORIGIN)

  async function auditRows(agentId: string) {
    const { results } = await env.DB.prepare(
      'SELECT actor_id, actor_type, action, fields_changed FROM agent_audit WHERE agent_id = ? ORDER BY seq ASC',
    )
      .bind(agentId)
      .all<{ actor_id: string; actor_type: string; action: string; fields_changed: string }>()
    return results
  }

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${squadId}', 'dept-1', 'sqa', 'Squad A');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    `)
    events = []
    env = {
      DB: harness.db,
      TENANT_SLUG: 'test',
      BUS: { send: async (event: unknown) => { events.push(event) } },
    } as unknown as Env

    const self = await createAgent(env, squadId, {
      slug: 'kasra',
      name: 'Kasra',
      role: 'member',
      model: 'gpt-5.6-terra',
    })
    if (!self.ok) throw new Error(`fixture create failed: ${self.error}`)
    selfAgentId = self.value.id

    const other = await createAgent(env, squadId, {
      slug: 'athena',
      name: 'Athena',
      role: 'member',
      model: 'claude-opus',
    })
    if (!other.ok) throw new Error(`fixture create failed: ${other.error}`)
    otherAgentId = other.value.id
  })

  // ── N3: partition invariant ──────────────────────────────────────────────
  it('SELF_PATCHABLE_FIELDS and SELF_FORBIDDEN_FIELDS partition ADMIN_PATCHABLE_FIELDS exactly', () => {
    const selfPatchable = new Set<string>(SELF_PATCHABLE_FIELDS)
    const selfForbidden = new Set<string>(SELF_FORBIDDEN_FIELDS)
    const admin = new Set<string>(ADMIN_PATCHABLE_FIELDS)

    // No field is in both — a self-forbidden field cannot also be self-patchable.
    for (const f of selfPatchable) expect(selfForbidden.has(f)).toBe(false)

    // Every admin-patchable field lands in EXACTLY one of the two sets — a future
    // field added to ADMIN_PATCHABLE_FIELDS without a decision on which side of
    // the self lane it belongs to fails this test instead of silently landing
    // in neither (swallowed) or both (contradictory).
    const union = new Set<string>([...selfPatchable, ...selfForbidden])
    expect(union).toEqual(admin)
    expect(selfPatchable.size + selfForbidden.size).toBe(admin.size)

    // The two fields this rework specifically moved OUT of the self lane.
    expect(selfForbidden.has('name')).toBe(true)
    expect(selfForbidden.has('role')).toBe(true)
    expect(selfPatchable.has('name')).toBe(false)
    expect(selfPatchable.has('role')).toBe(false)
  })

  // ── F1: the decisive A/B — the lane must be reachable through the REAL seam ──
  it('F1 — an agent-bound caller holding only a squad "member" grant patches its OWN model through invokeTool: ok:true (was 403 need=admin on base)', async () => {
    const memberGrant: CapabilityGrant[] = [
      { member_id: 'member-agent-kasra', scope_type: 'squad', scope_id: squadId, capability: 'member' },
    ]
    const result = await invoke(
      auth({ boundAgentId: selfAgentId, memberId: 'member-agent-kasra', capabilities: memberGrant }),
      { agent: selfAgentId, model: 'claude-fable-5-1' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as UpdateAgentResult
    expect(output.agent?.model).toBe('claude-fable-5-1')
  })

  it('F1 — the same caller with NO capabilities at all (bare authenticated) still reaches the self lane', async () => {
    const result = await invoke(
      auth({ boundAgentId: selfAgentId, memberId: 'member-agent-kasra', capabilities: [] }),
      { agent: selfAgentId, purpose: 'bare-authenticated self-correction' },
    )
    expect(result.ok).toBe(true)
  })

  it('a workspace-admin member (org admin grant, no squad-specific grant) still passes the admin path — the population the floor used to cover alone', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await invoke(auth({ capabilities: orgAdmin }), { agent: otherAgentId, slug: 'athena-renamed' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as UpdateAgentResult
    expect(output.agent?.slug).toBe('athena-renamed')
  })

  it('a non-bound member WITHOUT admin anywhere is still refused (unchanged admin gate, now enforced by the tool itself)', async () => {
    const result = await invoke(auth({ capabilities: [] }), { agent: selfAgentId, model: 'x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', scope: 'squad' })
  })

  // ── positive self-patch + audit + self_report ────────────────────────────
  it('self-patches model + purpose without admin, audited to the agent itself, self_report:true on the event', async () => {
    const result = await invoke(
      auth({ boundAgentId: selfAgentId, memberId: 'member-agent-kasra' }),
      { agent: selfAgentId, model: 'claude-fable-5-1', purpose: 'via Claude Code CLI' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as UpdateAgentResult
    expect(output.agent?.model).toBe('claude-fable-5-1')
    expect(output.agent?.purpose).toBe('via Claude Code CLI')
    expect(output.changed?.model).toEqual({ from: 'gpt-5.6-terra', to: 'claude-fable-5-1' })

    const rows = await auditRows(selfAgentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(selfAgentId)
    expect(rows[0].actor_type).toBe('agent')
    expect(rows[0].action).toBe('update_agent')

    expect(events).toHaveLength(1)
    const payload = (events[0] as { payload: { self_report?: boolean; kind: string } }).payload
    expect(payload.kind).toBe('agent_updated')
    expect(payload.self_report).toBe(true)
  })

  it('self-patches every self-patchable field in one call: model, model_fallback, purpose, skills', async () => {
    const result = await invoke(auth({ boundAgentId: selfAgentId }), {
      agent: selfAgentId,
      model: 'claude-fable-5-1',
      model_fallback: 'claude-3-7-sonnet',
      purpose: 'shared-tool surfaces',
      skills: ['typescript', 'd1'],
    })
    expect(result.ok).toBe(true)
  })

  // ── F2/F5: name/role left the self lane ──────────────────────────────────
  it.each([
    ['slug', 'stolen-slug'],
    ['name', 'Renamed By Self'],
    ['role', 'org-admin-impersonator'],
    ['owner', 'someone-else'],
    ['qnft_ref', 'qnft:forged'],
    ['capabilities', ['admin']],
    ['budget_cap_cents', 999999],
    ['budget_window', 'day'],
  ] as const)('self + %s is refused (403 forbidden, need=admin, field=%s), no write', async (field, value) => {
    const before = await auditRows(selfAgentId)
    const result = await invoke(auth({ boundAgentId: selfAgentId }), { agent: selfAgentId, [field]: value })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('forbidden')
    expect(result.detail).toEqual({ need: 'admin', field })

    const after = await auditRows(selfAgentId)
    expect(after).toHaveLength(before.length)
    expect(events).toHaveLength(0)
  })

  it('names the FIRST offending field in canonical order (slug before name before role) when several forbidden fields are sent together', async () => {
    const result = await invoke(auth({ boundAgentId: selfAgentId }), {
      agent: selfAgentId,
      role: 'impersonator',
      name: 'renamed',
      budget_cap_cents: 5000,
      slug: 'renamed-slug',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toEqual({ need: 'admin', field: 'slug' })
  })

  it('a self-forbidden field (name) mixed with self-patchable fields still refuses the whole call, writing nothing', async () => {
    const before = await auditRows(selfAgentId)
    const result = await invoke(auth({ boundAgentId: selfAgentId }), {
      agent: selfAgentId,
      model: 'claude-fable-5-1',
      name: 'Renamed',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toEqual({ need: 'admin', field: 'name' })

    const after = await auditRows(selfAgentId)
    expect(after).toHaveLength(before.length)
    const row = await env.DB.prepare('SELECT model, name FROM agents WHERE id = ?').bind(selfAgentId)
      .first<{ model: string; name: string }>()
    expect(row?.model).toBe('gpt-5.6-terra') // untouched
    expect(row?.name).toBe('Kasra') // untouched
  })

  // ── cross-agent still refused ─────────────────────────────────────────────
  it('an agent-bound caller targeting a DIFFERENT agent still gets operator_principal_required', async () => {
    const result = await invoke(auth({ boundAgentId: selfAgentId }), { agent: otherAgentId, model: 'claude-fable-5-1' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
    expect(result.error).toBe('operator_principal_required')

    const rows = await auditRows(otherAgentId)
    expect(rows).toHaveLength(0)
  })

  it('an agent-bound caller targeting a different agent by SLUG still gets operator_principal_required', async () => {
    const result = await invoke(auth({ boundAgentId: selfAgentId }), { agent: 'athena', purpose: 'reassigned' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('operator_principal_required')
  })

  // ── admin path unchanged (including the fields self cannot touch) ────────
  it('the admin path is unchanged: a non-bound member with squad admin can still set every field, including name/role/slug/capabilities/budget', async () => {
    const squadAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
    ]
    const result = await invoke(auth({ capabilities: squadAdmin }), {
      agent: selfAgentId,
      slug: 'kasra-renamed',
      name: 'Kasra Prime',
      role: 'lead-builder',
      capabilities: ['admin'],
      budget_cap_cents: 5000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as UpdateAgentResult
    expect(output.agent?.slug).toBe('kasra-renamed')

    const rows = await auditRows(selfAgentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe('member-operator')
    expect(rows[0].actor_type).toBe('user')

    const payload = (events[0] as { payload: { self_report?: boolean } }).payload
    expect(payload.self_report).toBeUndefined()
  })

  // ── F3: shape caps (admin path — proves the cap lives in the service layer, not just the tool) ──
  describe('F3 — shape caps on model / model_fallback / purpose / skills', () => {
    const squadAdmin = (): CapabilityGrant[] => [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
    ]

    it('accepts a model at the 128-char boundary', async () => {
      const model = 'a'.repeat(128)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, model })
      expect(result.ok).toBe(true)
    })

    it('refuses a model one char over the 128-char boundary', async () => {
      const model = 'a'.repeat(129)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, model })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('refuses a model containing a character outside the shape (space)', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, model: 'not a valid model' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('applies the same shape to model_fallback', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), {
        agent: selfAgentId,
        model_fallback: 'not a valid model either',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('accepts a purpose at the 2000-char boundary', async () => {
      const purpose = 'x'.repeat(2000)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, purpose })
      expect(result.ok).toBe(true)
    })

    it('refuses a purpose one char over the 2000-char boundary', async () => {
      const purpose = 'x'.repeat(2001)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, purpose })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('F3 named scenario — a 100,000-char purpose is refused, not silently truncated or accepted', async () => {
      const purpose = 'x'.repeat(100_000)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, purpose })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('refuses a purpose containing a control character other than newline', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), {
        agent: selfAgentId,
        purpose: 'looks fine\x01but has a NUL-adjacent control byte',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('accepts a purpose containing a newline', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), {
        agent: selfAgentId,
        purpose: 'line one\nline two',
      })
      expect(result.ok).toBe(true)
    })

    it('accepts skills at the 32-item boundary', async () => {
      const skills = Array.from({ length: 32 }, (_, i) => `skill-${i}`)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, skills })
      expect(result.ok).toBe(true)
    })

    it('refuses skills one item over the 32-item boundary', async () => {
      const skills = Array.from({ length: 33 }, (_, i) => `skill-${i}`)
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, skills })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('refuses a skill entry with an uppercase letter (outside the shape)', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, skills: ['TypeScript'] })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('accepts a well-shaped skill tag', async () => {
      const result = await invoke(auth({ capabilities: squadAdmin() }), { agent: selfAgentId, skills: ['typescript', 'd1-migrations', 'gate:adversarial'] })
      expect(result.ok).toBe(true)
    })

    it('the self lane inherits the same caps — a self-caller cannot bypass them by using its own authority', async () => {
      const result = await invoke(auth({ boundAgentId: selfAgentId }), { agent: selfAgentId, model: 'not a valid model' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })
  })

  // ── F4: null on a NOT NULL column fails closed, not 500 ──────────────────
  describe('F4 — role:null / model:null fail closed with invalid_field, not a 500', () => {
    it('self + model:null -> 400 invalid_field (self lane; model is self-patchable)', async () => {
      const result = await invoke(auth({ boundAgentId: selfAgentId }), { agent: selfAgentId, model: null })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.error).toBe('invalid_args')
      expect(result.detail).toEqual({ reason: 'invalid_field' })

      // Row survives untouched — no partial write, no crash.
      const row = await env.DB.prepare('SELECT model FROM agents WHERE id = ?').bind(selfAgentId)
        .first<{ model: string }>()
      expect(row?.model).toBe('gpt-5.6-terra')
    })

    it('admin + role:null -> 400 invalid_field (role is admin-only; proves updateAgentProfile itself rejects it, not just the self-lane blocklist)', async () => {
      const squadAdmin: CapabilityGrant[] = [
        { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
      ]
      const result = await invoke(auth({ capabilities: squadAdmin }), { agent: selfAgentId, role: null })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
      expect(result.error).toBe('invalid_args')
      expect(result.detail).toEqual({ reason: 'invalid_field' })
    })

    it('admin + model:null -> 400 invalid_field, not 500', async () => {
      const squadAdmin: CapabilityGrant[] = [
        { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
      ]
      const result = await invoke(auth({ capabilities: squadAdmin }), { agent: selfAgentId, model: null })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(400)
    })

    it('model_fallback:null is still ALLOWED (clears a nullable column) — only slug/name/role/model reject null', async () => {
      const squadAdmin: CapabilityGrant[] = [
        { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'admin' },
      ]
      // Set a fallback, then clear it.
      await invoke(auth({ capabilities: squadAdmin }), { agent: selfAgentId, model_fallback: 'claude-3-7-sonnet' })
      const result = await invoke(auth({ capabilities: squadAdmin }), { agent: selfAgentId, model_fallback: null })
      expect(result.ok).toBe(true)
    })
  })
})
