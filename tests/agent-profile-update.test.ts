import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAgent, getAgentProfile, updateAgentProfile } from '../src/org/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// updateAgentProfile — the repair path for registry drift. Real SQLite, ALL
// migrations applied in order, so these exercise the production write against the
// actual `agents` schema (which notably has NO updated_at column — 0049 rebuilt
// the table without one; a write that assumed it would fail only at runtime).

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-1', 'sqa', 'Squad A');
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
  `)
}

describe('updateAgentProfile — registry drift repair', () => {
  let harness: SqliteD1Harness
  let env: Env
  let agentId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    seed(harness.sqlite)
    env = { DB: harness.db } as unknown as Env

    // The real-world case this exists for: a seat created under one name and
    // model, later re-harnessed, with the row still asserting the old truth.
    const created = await createAgent(env, 'sq-a', {
      slug: 'prime',
      name: 'Prime',
      role: 'member',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    })
    if (!created.ok) throw new Error(`fixture create failed: ${created.error}`)
    agentId = created.value.id
  })

  it('corrects slug, name, role and model in one patch', async () => {
    const result = await updateAgentProfile(env, agentId, {
      slug: 'asha',
      name: 'Asha',
      role: 'First-Pass Gate',
      model: 'deepseek-v4-flash',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.slug).toBe('asha')
    expect(result.value.name).toBe('Asha')
    expect(result.value.role).toBe('First-Pass Gate')
    expect(result.value.model).toBe('deepseek-v4-flash')

    // Read back through the production read path, not the return value.
    const reread = await getAgentProfile(env, agentId)
    expect(reread?.slug).toBe('asha')
    expect(reread?.model).toBe('deepseek-v4-flash')
  })

  it('is partial: untouched fields keep their values', async () => {
    await updateAgentProfile(env, agentId, { purpose: 'evidence detection' })
    await updateAgentProfile(env, agentId, { model: 'deepseek-v4-flash' })

    const profile = await getAgentProfile(env, agentId)
    // The second patch must not have blanked what the first one set.
    expect(profile?.purpose).toBe('evidence detection')
    expect(profile?.model).toBe('deepseek-v4-flash')
    expect(profile?.name).toBe('Prime')
  })

  it('round-trips array columns and clears them with an explicit null', async () => {
    const set = await updateAgentProfile(env, agentId, {
      capabilities: ['gate', 'research'],
      skills: ['verify'],
    })
    expect(set.ok).toBe(true)
    expect((await getAgentProfile(env, agentId))?.capabilities).toEqual(['gate', 'research'])

    const cleared = await updateAgentProfile(env, agentId, { capabilities: null })
    expect(cleared.ok).toBe(true)
    expect((await getAgentProfile(env, agentId))?.capabilities).toBeNull()
    // clearing one array column must not disturb the other
    expect((await getAgentProfile(env, agentId))?.skills).toEqual(['verify'])
  })

  it('sets the qnft_ref an identity mint left null', async () => {
    await updateAgentProfile(env, agentId, { qnft_ref: '375a9d13' })
    expect((await getAgentProfile(env, agentId))?.qnft_ref).toBe('375a9d13')
  })

  it('refuses an empty patch rather than issuing a no-op UPDATE', async () => {
    const result = await updateAgentProfile(env, agentId, {})
    expect(result).toEqual({ ok: false, error: 'no_fields' })
  })

  it('refuses to null slug or name — the schema requires them', async () => {
    expect(await updateAgentProfile(env, agentId, { slug: null })).toEqual({
      ok: false,
      error: 'invalid_field',
    })
    expect(await updateAgentProfile(env, agentId, { name: null })).toEqual({
      ok: false,
      error: 'invalid_field',
    })
    // and the row is untouched after a rejected patch
    expect((await getAgentProfile(env, agentId))?.slug).toBe('prime')
  })

  it('refuses a whitespace-only required field', async () => {
    expect(await updateAgentProfile(env, agentId, { model: '   ' })).toEqual({
      ok: false,
      error: 'invalid_field',
    })
  })

  it('refuses a non-string where a string column is expected', async () => {
    expect(await updateAgentProfile(env, agentId, { model: 42 })).toEqual({
      ok: false,
      error: 'invalid_field',
    })
    expect(await updateAgentProfile(env, agentId, { capabilities: 'gate' })).toEqual({
      ok: false,
      error: 'invalid_field',
    })
  })

  it('refuses a column outside the allow-list — no status or squad moves', async () => {
    // status has its own transition (setAgentStatus/deactivate_agent, which also
    // revokes tokens and clears presence); squad_id changes capability scope.
    expect(
      await updateAgentProfile(env, agentId, { status: 'inactive' } as Record<string, unknown>),
    ).toEqual({ ok: false, error: 'invalid_field' })
    expect(
      await updateAgentProfile(env, agentId, { squad_id: 'sq-b' } as Record<string, unknown>),
    ).toEqual({ ok: false, error: 'invalid_field' })
    expect((await getAgentProfile(env, agentId))?.status).toBe('active')
  })

  it('reports slug_taken instead of throwing on the UNIQUE(squad_id, slug) collision', async () => {
    const other = await createAgent(env, 'sq-a', { slug: 'taken', name: 'Taken' })
    expect(other.ok).toBe(true)

    const result = await updateAgentProfile(env, agentId, { slug: 'taken' })
    expect(result).toEqual({ ok: false, error: 'slug_taken' })
    expect((await getAgentProfile(env, agentId))?.slug).toBe('prime')
  })

  it('returns not_found for an id that does not exist', async () => {
    const result = await updateAgentProfile(env, 'no-such-agent', { name: 'Ghost' })
    expect(result).toEqual({ ok: false, error: 'not_found' })
  })

  // The audit trail is the ONLY provenance a correction has: `agents` has no
  // updated_at column (0049 rebuilt it without one, #846). #842 shipped with the
  // audit riding on a bus event that was caught and swallowed on failure, so a
  // correction could land with nothing recording that it happened or what it was
  // before — an unrecorded mutation the design tells operators to trust (#857).
  //
  // These pin the trail to the transaction.
  describe('audit trail is written atomically with the update', () => {
    async function auditRows(agent: string) {
      const res = await env.DB.prepare(
        'SELECT seq, id, actor_id, actor_type, action, fields_changed, before_state, after_state FROM agent_audit WHERE agent_id = ? ORDER BY seq',
      )
        .bind(agent)
        .all<{
          seq: number
          id: string
          actor_id: string
          actor_type: string
          action: string
          fields_changed: string
          before_state: string
          after_state: string
        }>()
      return res.results ?? []
    }

    it('records before and after for exactly the fields touched', async () => {
      const result = await updateAgentProfile(
        env,
        agentId,
        { model: 'claude-opus-5', role: 'gatekeeper' },
        { id: 'member-42', type: 'user' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const rows = await auditRows(agentId)
      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.id).toBe(result.auditId)
      expect(row.actor_id).toBe('member-42')
      expect(row.actor_type).toBe('user')
      expect(row.action).toBe('update_agent')
      expect(JSON.parse(row.fields_changed).sort()).toEqual(['model', 'role'])

      const before = JSON.parse(row.before_state)
      const after = JSON.parse(row.after_state)
      expect(after.model).toBe('claude-opus-5')
      expect(after.role).toBe('gatekeeper')
      expect(before.model).not.toBe('claude-opus-5')
      // Reversibility is the point: the untouched fields must also be captured,
      // or the trail cannot reconstruct the row.
      expect(before.slug).toBe('prime')
      expect(after.slug).toBe('prime')
    })

    it('writes NO audit row when the update fails — one transaction, not two', async () => {
      // This is the atomicity proof. slug_taken throws inside the batch, so the
      // audit INSERT that already ran must roll back with it. A non-atomic
      // implementation leaves an audit row describing a change that never landed.
      const other = await createAgent(env, 'sq-a', { slug: 'occupied', name: 'Occupied' })
      expect(other.ok).toBe(true)

      const result = await updateAgentProfile(env, agentId, { slug: 'occupied' })
      expect(result).toEqual({ ok: false, error: 'slug_taken' })

      expect(await auditRows(agentId)).toHaveLength(0)
      expect((await getAgentProfile(env, agentId))?.slug).toBe('prime')
    })

    it('writes NO audit row for an agent that does not exist', async () => {
      const result = await updateAgentProfile(env, 'no-such-agent', { name: 'Ghost' })
      expect(result).toEqual({ ok: false, error: 'not_found' })

      const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_audit').first<{ n: number }>()
      expect(all?.n).toBe(0)
    })

    it('attributes a call with no explicit actor to the system', async () => {
      const result = await updateAgentProfile(env, agentId, { purpose: 'reconciled by job' })
      expect(result.ok).toBe(true)

      const rows = await auditRows(agentId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.actor_id).toBe('system')
      expect(rows[0]!.actor_type).toBe('system')
    })

    it('appends one row per correction rather than overwriting', async () => {
      await updateAgentProfile(env, agentId, { model: 'first' })
      await updateAgentProfile(env, agentId, { model: 'second' })

      const rows = await auditRows(agentId)
      expect(rows).toHaveLength(2)
      expect(JSON.parse(rows[0]!.after_state).model).toBe('first')
      expect(JSON.parse(rows[1]!.before_state).model).toBe('first')
      expect(JSON.parse(rows[1]!.after_state).model).toBe('second')
    })
  })

  // parent_agent_id shipped on the updatable allow-list and reached the SET clause
  // through the generic text path, with none of createAgent's validation. The column
  // is a soft self-reference with no foreign key, so D1 catches nothing: the governed
  // repair path was the only way to write the corruption it exists to prevent.
  //
  // These pin the exclusion. Each is a write that previously SUCCEEDED.
  describe('parent_agent_id is not patchable — placement is structural', () => {
    it('refuses a phantom parent that was never an agent', async () => {
      expect(
        await updateAgentProfile(env, agentId, {
          parent_agent_id: 'no-such-agent',
        } as Record<string, unknown>),
      ).toEqual({ ok: false, error: 'invalid_field' })
      expect((await getAgentProfile(env, agentId))?.parent_agent_id).toBeNull()
    })

    it('refuses an agent as its own parent', async () => {
      expect(
        await updateAgentProfile(env, agentId, {
          parent_agent_id: agentId,
        } as Record<string, unknown>),
      ).toEqual({ ok: false, error: 'invalid_field' })
      expect((await getAgentProfile(env, agentId))?.parent_agent_id).toBeNull()
    })

    it('refuses the two-write cycle that makes a tree walk loop forever', async () => {
      const other = await createAgent(env, 'sq-a', { slug: 'sibling', name: 'Sibling' })
      expect(other.ok).toBe(true)
      if (!other.ok) return
      const otherId = other.value.id

      // A -> B, then B -> A. Neither write is individually suspicious; together
      // they close a loop with no root, and every consumer that climbs the
      // placement tree hangs.
      expect(
        await updateAgentProfile(env, agentId, {
          parent_agent_id: otherId,
        } as Record<string, unknown>),
      ).toEqual({ ok: false, error: 'invalid_field' })
      expect(
        await updateAgentProfile(env, otherId, {
          parent_agent_id: agentId,
        } as Record<string, unknown>),
      ).toEqual({ ok: false, error: 'invalid_field' })

      expect((await getAgentProfile(env, agentId))?.parent_agent_id).toBeNull()
      expect((await getAgentProfile(env, otherId))?.parent_agent_id).toBeNull()
    })

    it('refuses even a legitimate re-parent, and leaves the rest of the patch unwritten', async () => {
      // The exclusion is not "reject bad values" — it is "this column is not a
      // profile edit". A valid parent is refused too, and because validation
      // happens before any write, the sibling field in the same patch must not
      // land. Re-parenting goes through re-provisioning, like squad_id.
      const parent = await createAgent(env, 'sq-a', { slug: 'overseer', name: 'Overseer' })
      expect(parent.ok).toBe(true)
      if (!parent.ok) return

      expect(
        await updateAgentProfile(env, agentId, {
          name: 'Renamed By Smuggled Patch',
          parent_agent_id: parent.value.id,
        } as Record<string, unknown>),
      ).toEqual({ ok: false, error: 'invalid_field' })

      const after = await getAgentProfile(env, agentId)
      expect(after?.parent_agent_id).toBeNull()
      expect(after?.name).not.toBe('Renamed By Smuggled Patch')
    })

    it('still accepts a parent at CREATE time, where cycles are unreachable', async () => {
      // createAgent keeps the column: it validates the parent row exists, and the
      // new id is crypto.randomUUID() generated server-side, so a caller cannot
      // name it. A fresh agent can be neither its own parent nor an ancestor of
      // anything. The create path is not the hole and is not narrowed here.
      const parent = await createAgent(env, 'sq-a', { slug: 'root-seat', name: 'Root' })
      expect(parent.ok).toBe(true)
      if (!parent.ok) return

      const child = await createAgent(env, 'sq-a', {
        slug: 'child-seat',
        name: 'Child',
        parent_agent_id: parent.value.id,
      })
      expect(child.ok).toBe(true)
      if (!child.ok) return
      expect(child.value.parent_agent_id).toBe(parent.value.id)
    })
  })
})
