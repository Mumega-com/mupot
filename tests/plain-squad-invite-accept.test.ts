// mupot#1436 A3 — plain squad invites accept on the web.
//
// pairing_hash / pairing_expires_at stay hard 409 (Telegram door).
// squad_id-only invites (0156) mint the member and grant scope_type='squad'
// through acceptInvite's existing capabilities writer — not a hand-rolled
// memberships insert (#1161 is the agent-plane writer and needs an agent_id).
// telegram_chat_id stays NULL. JSON body telegram_chat_id rejection is
// unchanged (covered in telegram-project-onboarding.test.ts).
//
// MUTATION LEDGER (break → fail → restore), observed 2026-09-20:
//   1. pairing_hash / pairing_expires_at / project_id short-circuit removed
//      → acceptInvite('inv-telegram') returned ok:true + minted a token
//      (web form still 409s via loadInviteLanding; the function-level
//      guard is what this file's direct call proves)
//   2. squad scope removed (fell back to org/dept)
//      → capability landed as { scope_type: 'org', scope_id: null }
//   3. telegram_chat_id stays a literal null on the member mint; JSON
//      body-field rejection telegram_identity_requires_authenticated_webhook
//      is unchanged (telegram-project-onboarding.test.ts)

import { afterEach, describe, expect, it } from 'vitest'
import { acceptInvite, isTelegramDoorInvite } from '../src/members'
import { inviteApp } from '../src/dashboard/invite'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project Atlas');
    INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-a', 'squad-web');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squad', 'squaduser@example.com', 'squad-web', 'member', 'member-admin');
    INSERT INTO invites (id, email, project_id, squad_id, pairing_hash, pairing_expires_at, capability, invited_by)
      VALUES ('inv-telegram', 'tguser@example.com', 'proj-a', 'squad-web',
        '${'a'.repeat(64)}', datetime('now', '+1 day'), 'member', 'member-admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as Env
}

function postForm(path: string, values: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

describe('A3 — plain squad invite accept', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('accepts a squad-only invite and grants scope_type=squad (not memberships)', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const result = await acceptInvite(env, 'inv-squad', 'Squad User', { mintToken: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.capability).toEqual({
      scope_type: 'squad',
      scope_id: 'squad-web',
      capability: 'member',
    })

    const member = harness.sqlite
      .prepare(`SELECT id, telegram_chat_id FROM members WHERE id = ?`)
      .get(result.value.member_id) as { id: string; telegram_chat_id: string | null }
    expect(member.telegram_chat_id).toBeNull()

    const cap = harness.sqlite
      .prepare(`SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = ?`)
      .get(result.value.member_id) as { scope_type: string; scope_id: string; capability: string }
    expect(cap).toEqual({ scope_type: 'squad', scope_id: 'squad-web', capability: 'member' })

    const memberships = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM memberships`)
      .get() as { n: number }
    expect(memberships.n).toBe(0)

    const stamped = harness.sqlite
      .prepare(`SELECT member_id, accepted_at FROM invites WHERE id = 'inv-squad'`)
      .get() as { member_id: string; accepted_at: string | null }
    expect(stamped.member_id).toBe(result.value.member_id)
    expect(stamped.accepted_at).not.toBeNull()
  })

  it('web form accepts a plain squad invite and still 409s a pairing invite', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const ok = await inviteApp.fetch(postForm('/inv-squad', { display_name: 'Squad User' }), env)
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe('/auth/login')

    const tg = await inviteApp.fetch(postForm('/inv-telegram', { display_name: 'TG User' }), env)
    expect(tg.status).toBe(409)
    expect(await tg.text()).toMatch(/redeemed in Telegram/i)

    const direct = await acceptInvite(env, 'inv-telegram', 'TG User')
    expect(direct).toEqual({ ok: false, error: 'project_invite_requires_telegram' })
  })

  it('GET /invite/:id shows a plain squad invite as ready, pairing as telegram-only', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const ready = await inviteApp.fetch(new Request(`${ORIGIN}/inv-squad`), env)
    expect(ready.status).toBe(200)
    const readyHtml = await ready.text()
    expect(readyHtml).toContain('Web Squad')
    expect(readyHtml).toMatch(/Accept invite/i)

    const tg = await inviteApp.fetch(new Request(`${ORIGIN}/inv-telegram`), env)
    expect(tg.status).toBe(200)
    expect(await tg.text()).toMatch(/redeemed in Telegram/i)
  })

  it('P1-A: acceptInvite rollback clears member_id with accepted_at', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-dup', 'squaduser@example.com', 'Already Here', 'active', '${TENANT}');
    `)
    const result = await acceptInvite(env, 'inv-squad', 'Squad User', { mintToken: false })
    expect(result).toEqual({ ok: false, error: 'member_already_exists' })
    const row = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-squad'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
  })
})

describe('WARN-D — Telegram door conjuncts (each red alone)', () => {
  it.each([
    ['pairing_hash', { pairing_hash: 'a'.repeat(64), pairing_expires_at: null, project_id: null }],
    ['pairing_expires_at', { pairing_hash: null, pairing_expires_at: '2026-09-21T00:00:00Z', project_id: null }],
    ['project_id', { pairing_hash: null, pairing_expires_at: null, project_id: 'proj-a' }],
  ] as const)('isTelegramDoorInvite is true for %s alone', (_name, invite) => {
    expect(isTelegramDoorInvite(invite)).toBe(true)
  })

  it('isTelegramDoorInvite is false when every conjunct is null (plain squad / legacy)', () => {
    expect(isTelegramDoorInvite({
      pairing_hash: null,
      pairing_expires_at: null,
      project_id: null,
    })).toBe(false)
  })
})

describe('P1-B — 0156 UPDATE trigger refused shapes', () => {
  const PAIRING = 'a'.repeat(64)
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  function seed(): SqliteD1Harness {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name)
        VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
      INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project Atlas');
      INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-a', 'squad-web');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}'),
               ('member-other', 'other@pot.test', 'Other', 'active', '${TENANT}');
    `)
    return h
  }

  it('allows the three legal INSERT shapes (org/dept, plain squad, full project/pairing)', () => {
    harness = seed()
    expect(() => harness!.sqlite.exec(`
      INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-org', 'org@example.com', NULL, 'member', 'member-admin')
    `)).not.toThrow()
    expect(() => harness!.sqlite.exec(`
      INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-dept', 'dept@example.com', 'dept-a', 'member', 'member-admin')
    `)).not.toThrow()
    expect(() => harness!.sqlite.exec(`
      INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squad-shape', 'squad@example.com', 'squad-web', 'member', 'member-admin')
    `)).not.toThrow()
    expect(() => harness!.sqlite.prepare(`
      INSERT INTO invites (id, email, project_id, squad_id, pairing_hash, pairing_expires_at, capability, invited_by)
      VALUES ('inv-tg-shape', 'tg@example.com', 'proj-a', 'squad-web', ?, '2026-09-21T00:00:00Z', 'member', 'member-admin')
    `).run(PAIRING)).not.toThrow()
  })

  it('keeps accept-time member_id stamp on a pairing-NULL row', () => {
    harness = seed()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, squad_id, capability, invited_by, accepted_at)
      VALUES ('inv-stamp', 'stamp@example.com', 'squad-web', 'member', 'member-admin',
              '2026-09-21T00:00:00Z')
    `)
    expect(() => harness!.sqlite.exec(`
      UPDATE invites SET member_id = 'member-admin' WHERE id = 'inv-stamp'
    `)).not.toThrow()
    expect(
      harness.sqlite.prepare(`SELECT member_id FROM invites WHERE id = 'inv-stamp'`).get(),
    ).toEqual({ member_id: 'member-admin' })
  })

  it('refuses member_id stamp while pairing columns are non-NULL', () => {
    harness = seed()
    harness.sqlite.prepare(`
      INSERT INTO invites (id, email, project_id, squad_id, pairing_hash, pairing_expires_at, capability, invited_by)
      VALUES ('inv-paired', 'paired@example.com', 'proj-a', 'squad-web', ?, '2026-09-21T00:00:00Z', 'member', 'member-admin')
    `).run(PAIRING)
    expect(() => harness!.sqlite.exec(`
      UPDATE invites SET member_id = 'member-admin' WHERE id = 'inv-paired'
    `)).toThrow(/project invite member bind/)
  })

  it('refuses incomplete shape conversion in one UPDATE', () => {
    harness = seed()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-convert', 'convert@example.com', 'squad-web', 'member', 'member-admin')
    `)
    expect(() => harness!.sqlite.prepare(`
      UPDATE invites SET pairing_hash = ? WHERE id = 'inv-convert'
    `).run(PAIRING)).toThrow(/project invite fields/)
  })

  it('refuses write-once re-stamp to a different member', () => {
    harness = seed()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, squad_id, capability, invited_by, accepted_at)
      VALUES ('inv-once', 'once@example.com', 'squad-web', 'member', 'member-admin',
              '2026-09-21T00:00:00Z')
    `)
    harness.sqlite.exec(`UPDATE invites SET member_id = 'member-admin' WHERE id = 'inv-once'`)
    expect(() => harness!.sqlite.exec(`
      UPDATE invites SET member_id = 'member-other' WHERE id = 'inv-once'
    `)).toThrow(/invite member_id is write-once/)
  })
})
