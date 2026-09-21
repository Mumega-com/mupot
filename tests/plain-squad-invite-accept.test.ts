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
import { acceptInvite } from '../src/members'
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
})
