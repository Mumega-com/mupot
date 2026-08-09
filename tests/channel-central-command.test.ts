// tests/channel-central-command.test.ts — Real-SQL integration test suite for mumega-com#722
//
// mupot P0 addressing fix (2026-08): central-command mention dispatch wrote
// `agent_messages.to_agent` as the raw @mention SLUG (e.g. 'mubot') while every
// inbox READ path queries `to_agent = auth.boundAgentId`, which is the agent's
// UUID. Every dispatched message was silently unreadable. Fixed by routing
// non-fenced dispatch through `sendToRef` (resolves slug -> uuid, ambiguity-safe).
//
// Adversarial review on the first draft of this fix found 4 BLOCKs, reflected here:
//   BLOCK-1: reject any @mention target shaped like a raw agent id (tombstone
//            bypass — resolveAgentRef's id path is status-unfiltered).
//   BLOCK-2: sendToRef authz must be the INGRESS MEMBER's real capability grants
//            ({isAdmin, grants}, computed the same way every other sendToRef
//            caller computes it) — NOT a hardcoded system/admin bypass. This is a
//            real NARROWING vs. the pre-fix F2 lookup (tenant-wide, no capability
//            check at all), so tests seed real grants rather than papering over it.
//   BLOCK-3: the F2 existence pre-check is deleted; unknown/invisible targets now
//            surface sendToRef's collapsed `send_target_not_visible`, not a
//            custom "no such active agent" string, for NON-fenced targets.
//   (BLOCK about the SOS-native fence: do NOT remove it. See the "fence stays"
//    tests below — that fence is an unrelated reachability policy, #845-B.)

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

describe('central-command ingress (mumega-com#722)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: 'mumega', TELEGRAM_BOT_TOKEN: 'test-bot-token' } as unknown as Env

    // Seed test member and identity via real SQL
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-hadi', 'hadi@mumega.com', 'Hadi', 'active');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-hadi', 'm-hadi', 'telegram', '765204057');

      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-user', 'user@mumega.com', 'User', 'active');

      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-user', 'm-user', 'telegram', '1111111');

      INSERT OR IGNORE INTO departments (id, slug, name)
      VALUES ('dept-core', 'core', 'Dept Core');

      INSERT OR IGNORE INTO squads (id, department_id, slug, name)
      VALUES ('squad-core', 'dept-core', 'core', 'Squad Core');

      INSERT OR IGNORE INTO channel_bindings (id, platform, external_channel_id, squad_id, max_capability)
      VALUES ('central-command-telegram', 'telegram', '-5317747241', 'squad-core', 'member');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-prime', 'squad-core', 'prime', 'Prime', 'active'),
             ('ag-river', 'squad-core', 'river', 'River', 'active'),
             ('ag-mubot', 'squad-core', 'mubot', 'Mubot', 'active');

      -- BLOCK-2: real capability grants for both linked members, matching what
      -- channel sync (src/channels/sync.ts, SYNC_BASE='member') would eventually
      -- populate at this binding's max_capability ceiling ('member', line above).
      -- Without these, sendToRef's Gate 1 squad-visibility check correctly
      -- refuses every dispatch below — see the "no capability grants" test, which
      -- proves that refusal deliberately.
      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-hadi-squad-core', 'm-hadi', 'squad', 'squad-core', 'member'),
             ('cap-user-squad-core', 'm-user', 'squad', 'squad-core', 'member');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  it('refuses an unbound group: no dispatch, no side effect', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-999999', '765204057', '@prime status')
    expect(res).toContain('not wired to a squad')
  })

  it('binds -5317747241 -> squad-core via channel_bindings seam and accepts mentions (B3)', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot status check')
    expect(res).toContain('Dispatched @mubot via mupot inbox')

    // ADDRESSING INVARIANT (mupot P0) — the regression test that matters most: to_agent
    // must be written as the agent's UUID (agents.id), never the raw @mention slug — the
    // inbox read path (src/mcp/index.ts:2269, src/agents/inbox-routes.ts:72) only ever
    // queries to_agent = auth.boundAgentId, which IS the uuid. A slug-addressed row is a
    // silently unreadable message. This assertion fails against the pre-fix code, which
    // wrote to_agent = 'mubot' (the slug) verbatim.
    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'ag-mubot'`
    ).first()
    expect(msg).not.toBeNull()
    expect(msg?.body).toBe('@mubot status check')

    // And, negatively: no row was EVER written keyed by the bare slug.
    const bySlug = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'mubot'`
    ).first()
    expect(bySlug).toBeNull()
  })

  it('tags non-Hadi mentions UNTRUSTED-INGRESS: body carries the tag', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '1111111', '@mubot execute order')
    expect(res).toContain('[UNTRUSTED-INGRESS]')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE from_member = 'm-user'`
    ).first()
    expect(msg).not.toBeNull()
    expect(msg?.body).toContain('[UNTRUSTED-INGRESS]')
  })

  it('treats a non-Hadi wake or task as data: returns directive-required, no side effect (W1)', async () => {
    const { runInbound } = await import('../src/channels/index')
    const resWake = await runInbound(env, 'telegram', '-5317747241', '1111111', 'wake codex')
    expect(resWake).toContain('Directive-required')

    const resTask = await runInbound(env, 'telegram', '-5317747241', '1111111', 'task: deploy feature')
    expect(resTask).toContain('Directive-required')
  })

  it('Hadi sender 765204057 is directive-capable: untagged body, wake allowed', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot full flight plan')
    expect(res).not.toContain('[UNTRUSTED-INGRESS]')
    expect(res).toContain('Dispatched @mubot')
  })

  // FENCE STAYS (adversarial review, binding correction from the original brief):
  // do NOT remove the hardcoded SOS-native branch or sosBusSend. Whether a Telegram
  // mention should ever reach kasra/athena/loom (seats with gate/merge/deploy
  // authority) is a reachability policy call (#845-B), not an addressing bug. These
  // two tests are UNCHANGED from before this fix and must stay pinned to the
  // fence's actual (non-)behavior — never assert relay/delivery (#845's lesson).

  it('B1: @river routes to the SOS-native path and is told plainly it was NOT reached', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@river review spec')

    expect(res).toContain('@river is SOS-native and NOT REACHED')
    expect(res).toContain('Nobody received it')
    // The old string named a courier who never got anything. Never reintroduce it.
    expect(res).not.toContain('relayed via Kasra')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'river'`
    ).first<{ body: string }>()
    expect(msg?.body).toContain('[sos-bus]')
    // The audit row is the ONLY effect. It is not evidence of delivery.
    expect(msg?.body).toContain('review spec')
  })

  it('B1b: @prime takes the same path — audit row written, delivery explicitly denied', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@prime status report')

    expect(res).toContain('@prime is SOS-native and NOT REACHED')
    expect(res).not.toContain('relayed via Kasra')
    expect(res).not.toContain('Dispatched @prime')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = 'prime'`
    ).first<{ body: string }>()
    expect(msg?.body).toContain('[sos-bus]')
    expect(msg?.body).toContain('status report')
  })

  it('BLOCK-1: a mention shaped like a raw agent id is rejected before it ever resolves (tombstone protection)', async () => {
    // resolveAgentRef's id-path lookup is deliberately status-unfiltered (only the
    // slug path excludes 'inactive' rows — src/org/resolve.ts). Seed a tombstoned
    // (inactive) agent with a real uuid-shaped id and mention it BY THAT ID — if
    // the id path were reachable from central-command, this would resolve straight
    // to a deactivated agent's inbox. It must not.
    const uuidId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('${uuidId}', 'squad-core', 'tombstoned-agent', 'Tombstoned', 'inactive');
    `)

    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', `@${uuidId} are you there`)

    expect(res).toBe(`no such active agent: @${uuidId}`)
    expect(res).not.toContain('Dispatched')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE to_agent = ?1`
    ).bind(uuidId).first()
    expect(msg).toBeNull()
  })

  it('BLOCK-2: a linked member with NO capability grants cannot dispatch to a real pot-native agent (send_target_not_visible)', async () => {
    // This is the regression test for the narrowing itself: before this fix, the
    // F2 lookup was tenant-wide with no capability check at all, so ANY linked
    // member could write into any pot-native agent's inbox. Prove that is no
    // longer true — a freshly-linked member with zero grants (e.g. before
    // reconcileMembership has ever synced them) is refused, not silently allowed.
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('m-nogrants', 'nogrants@mumega.com', 'NoGrants', 'active');
      INSERT OR IGNORE INTO member_identities (id, member_id, platform, external_user_id)
      VALUES ('id-nogrants', 'm-nogrants', 'telegram', '2222222');
    `)

    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '2222222', '@mubot do something')

    expect(res).toBe('refused: send_target_not_visible')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE from_member = 'm-nogrants'`
    ).first()
    expect(msg).toBeNull()
  })

  it('WARN-1: dispatch charges a per-(member, recipient) rate-wall bucket, not just the global per-slug one', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot ping')
    expect(res).toContain('Dispatched @mubot')

    const row = await env.DB.prepare(
      `SELECT from_member, agent_id, count FROM channel_mention_budget_v2
        WHERE tenant = 'mumega' AND from_member = 'm-hadi' AND agent_id = 'ag-mubot'`
    ).first<{ from_member: string; agent_id: string; count: number }>()
    expect(row).not.toBeNull()
    expect(row?.count).toBe(1)
  })

  it('ambiguous slug: two active agents sharing a slug fail closed, no write, no crash', async () => {
    // Mirrors prod's kasra shape structurally (agents.slug is UNIQUE(squad_id, slug),
    // not globally unique, so the same slug can legitimately exist in two squads) —
    // using a NON-fenced slug ('analyst') so the SOS-native fence doesn't shadow the
    // dynamic path this test is actually exercising.
    // Downgraded from the original brief: since these test members are non-admins
    // (no org:admin grant), sendToRef's non-admin path collapses BOTH ambiguous and
    // not-found into the same `send_target_not_visible` (see messages.ts's
    // existence-oracle-closure doc) — so the assertion here is "fails closed
    // cleanly", not the specific `recipient_ambiguous` reason.
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name)
      VALUES ('dept-other', 'other', 'Dept Other');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name)
      VALUES ('squad-other', 'dept-other', 'other', 'Squad Other');
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-analyst-a', 'squad-core', 'analyst', 'Analyst A', 'active'),
             ('ag-analyst-b', 'squad-other', 'analyst', 'Analyst B', 'active');
    `)

    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@analyst build the fix')

    expect(res).toBe('refused: send_target_not_visible')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE body LIKE '%build the fix%'`
    ).first()
    expect(msg).toBeNull()
  })

  it('round-trip: a central-command mention is actually readable via readAgentInbox with the bound UUID', async () => {
    const { runInbound } = await import('../src/channels/index')
    const { readAgentInbox } = await import('../src/agents/messages')

    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot deploy the release')
    expect(res).toContain('Dispatched @mubot via mupot inbox')

    // Read the inbox EXACTLY the way the real read path does (src/mcp/index.ts:2269,
    // src/agents/inbox-routes.ts:72): to_agent = the agent's bound UUID.
    const inbox = await readAgentInbox(env, { agent: 'ag-mubot' })
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) throw new Error('unreachable')
    expect(inbox.messages).toHaveLength(1)
    expect(inbox.messages[0].body).toBe('@mubot deploy the release')
  })

  it('B2: refuses mentions exceeding MAX_BODY_CHARS via sendAgentMessage primitive', async () => {
    const { runInbound } = await import('../src/channels/index')
    const longBody = '@mubot ' + 'x'.repeat(8200)
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', longBody)
    expect(res).toContain('refused: invalid_body')
  })

  it('unknown non-fenced mention refuses via the collapsed sendToRef reason (BLOCK-3: F2 pre-check deleted)', async () => {
    const { runInbound } = await import('../src/channels/index')
    const res = await runInbound(env, 'telegram', '-5317747241', '765204057', '@ghost test')
    // Pre-fix / pre-BLOCK-3 this was a bespoke "no such active agent: @ghost" from
    // a standalone existence pre-check. That pre-check was a full tenant-wide
    // agent-slug enumeration oracle available to any linked member and is deleted;
    // this refusal now comes from sendToRef itself, collapsed the same way an
    // invisible-but-real target would be (no oracle for a non-admin sender).
    expect(res).toBe('refused: send_target_not_visible')

    const msg = await env.DB.prepare(
      `SELECT * FROM agent_messages WHERE body LIKE '%test%' AND from_member = 'm-hadi'`
    ).first()
    expect(msg).toBeNull()
  })

  it('rate wall: 11th mention in the hour returns the cap message and records 11', async () => {
    const { runInbound } = await import('../src/channels/index')
    for (let i = 0; i < 10; i++) {
      const res = await runInbound(env, 'telegram', '-5317747241', '765204057', `@mubot ping ${i}`)
      expect(res).toContain('Dispatched @mubot')
    }

    const eleventh = await runInbound(env, 'telegram', '-5317747241', '765204057', '@mubot ping 11')
    expect(eleventh).toContain('10/hour mention wall')

    const budget = await env.DB.prepare(
      `SELECT count FROM channel_mention_budget WHERE agent_slug = 'mubot'`
    ).first<{ count: number }>()
    expect(budget?.count).toBe(11)
  })
})
