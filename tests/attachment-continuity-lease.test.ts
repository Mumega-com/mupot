import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { resolveAttachmentContinuity } from '../src/members/attachment-continuity'
import { attachedInboxContext, attachmentContinuityRequest } from '../src/members/attachment-inbox'

const TENANT = 'attachment-lease'
const NOW = '2026-11-18 12:00:00'
let harness: SqliteD1Harness

type Attachment = { auth: AuthContext; id: string; physicalSeat: string; token: string }

function env(): Env { return { DB: harness.db, TENANT_SLUG: TENANT, SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1' } as Env }

function attachment(id: 'one' | 'two'): Attachment {
  const physicalSeat = `physical-label-${id}` // deliberately not an agent_seats.id
  const token = `attachment-token-${id}`
  const auth: AuthContext = {
    userId: 'agent-member', memberId: 'agent-member', email: null, role: 'member', tenant: TENANT,
    channel: 'directory', tokenId: token, boundAgentId: 'rava',
    capabilities: [{ member_id: 'agent-member', scope_type: 'squad', scope_id: 'squad', capability: 'member' }],
    consentedByMemberId: 'human',
    seatBinding: {
      seatId: `seat-${id}`, label: physicalSeat, harnessId: 'harness', grantTokenId: 'grant',
      humanMemberId: 'human', source: 'handle',
      attached: { attachmentId: `attachment-${id}`, admissionId: 'admission', agentId: 'rava', seatAgentId: 'rava', ceiling: 'member' },
    },
  }
  return { auth, id: `attachment-${id}`, physicalSeat, token }
}

function call(actor: Attachment, tool: string, args: Record<string, unknown>, bindings = env()) {
  return invokeTool(actor.auth, bindings, tool, args, { sideEffectFree: true })
}

function rows() {
  return harness.sqlite.prepare(`SELECT id, read_at, delivery_attempts, lease_attempt_id, lease_expires_at
    FROM agent_messages ORDER BY id`).all()
}

function revokeScopeBeforeBatch() {
  const bindings = env()
  let ran = false
  const db = new Proxy(bindings.DB, {
    get(target, key) {
      if (key === 'batch') return (statements: Parameters<Env['DB']['batch']>[0]) => {
        if (!ran) {
          ran = true
          harness.sqlite.prepare(`UPDATE attachment_continuity_scopes SET revoked_at = ? WHERE id = 'scope'`).run(NOW)
        }
        return target.batch(statements)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { bindings: { ...bindings, DB: db }, ran: () => ran }
}

function attempts() {
  return harness.sqlite.prepare(`SELECT target_seat_key, attempt_id, state, message_id
    FROM agent_inbox_lease_attempts ORDER BY target_seat_key, attempt_id`).all()
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES ('dept','dept','Dept');
    INSERT INTO squads(id,department_id,slug,name) VALUES ('squad','dept','squad','Squad');
    INSERT INTO members(id,tenant,display_name,status) VALUES
      ('human','${TENANT}','Human','active'), ('agent-member','${TENANT}','Rava member','active');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES
      ('rava','squad','rava','Rava','worker','test','active'),
      ('seat-agent-one','squad','seat-agent-one','Seat one','worker','test','active'),
      ('seat-agent-two','squad','seat-agent-two','Seat two','worker','test','active');
    INSERT INTO memberships(id,agent_id,squad_id,capability) VALUES ('rava-squad','rava','squad','member');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at)
      VALUES ('${TENANT}','rava','agent-member','${NOW}');
    INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability)
      VALUES ('member-cap','agent-member','squad','squad','member');
    INSERT INTO member_tokens(id,tenant,member_id,token_hash,label,channel,created_at,agent_id,expires_at) VALUES
      ('grant','${TENANT}','human','grant-hash','human grant','directory','${NOW}',NULL,'2099-01-01 00:00:00'),
      ('attachment-token-one','${TENANT}','agent-member','token-one','physical-label-one','directory','${NOW}','rava','2099-01-01 00:00:00'),
      ('attachment-token-two','${TENANT}','agent-member','token-two','physical-label-two','directory','${NOW}','rava','2099-01-01 00:00:00');
    INSERT INTO harnesses(id,tenant,member_id,oauth_client_id,client_name,kind,grant_id,credential_kind)
      VALUES ('harness','${TENANT}','human','client','Harness','chatgpt','oauth:grant','oauth');
    INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,label_basename,max_live,created_at) VALUES
      ('seat-one','${TENANT}','human','harness','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','seat-agent-one','one',2,'${NOW}'),
      ('seat-two','${TENANT}','human','harness','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','seat-agent-two','two',2,'${NOW}');
    INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,gates,gate_authority,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via,scope,authority_level,authority_expires_at)
      VALUES ('admission','${TENANT}','rava','human','harness','live',0,0,'member','tool','seat-one','${NOW}','${NOW}','human','webauthn','harness','helper','2099-01-01 00:00:00');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at) VALUES
      ('attachment-one','${TENANT}','seat-one','human','harness','rava','admission','attachment-token-one','${NOW}'),
      ('attachment-two','${TENANT}','seat-two','human','harness','rava','admission','attachment-token-two','${NOW}');
    INSERT INTO agent_seat_authority_decisions(id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via,continuity_approved) VALUES
      ('decision-one','${TENANT}','admission','attachment-one','seat-one','rava','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn',1),
      ('decision-two','${TENANT}','admission','attachment-two','seat-two','rava','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn',1);
    INSERT INTO attachment_continuity_scopes(id,tenant,admission_id,agent_id,human_member_id,harness_id,source_grant_token_id,authority_decision_id,created_at)
      VALUES ('scope','${TENANT}','admission','rava','human','harness','grant','decision-one','${NOW}');
    INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body,created_at,target_seat,target_continuity_scope_id) VALUES
      ('broadcast','${TENANT}','rava','sender','agent-member','message','broadcast','${NOW}',NULL,NULL),
      ('scoped','${TENANT}','rava','sender','agent-member','message','shared scope','${NOW}','continuity:scope','scope'),
      ('physical-one','${TENANT}','rava','sender','agent-member','message','one only','${NOW}','physical-label-one',NULL);
  `)
})

afterEach(() => harness.close())

describe('attachment continuity durable lease custody', () => {
  it('shares only the scope target, keeps physical attempts private, and checks current authority before every write', async () => {
    const one = attachment('one')
    const two = attachment('two')
    expect(await resolveAttachmentContinuity(env(), attachmentContinuityRequest(attachedInboxContext(one.auth)!))).toMatchObject({ kind: 'scope' })

    // A genuine broadcast is visible to peers through ordinary inbox views, never a leaseable
    // attached target. The logical target is shared by current attachments, but only one active
    // durable lease can hold it.
    expect(await call(one, 'inbox_lease', { limit: 1, attempt_id: 'scope_attempt_00001' }))
      .toMatchObject({ ok: true, result: { effective_inbox_seat: one.physicalSeat, messages: [{ id: 'scoped' }] } })
    expect(await call(one, 'inbox_lease_reconcile', { attempt_id: 'scope_attempt_00001' }))
      .toMatchObject({ ok: true, result: { state: 'leased', messages: [{ id: 'scoped' }] } })
    const held = rows()
    expect(await call(two, 'inbox_lease', { limit: 1, attempt_id: 'competing_scope_00001' }))
      .toMatchObject({ ok: true, result: { messages: [] } })
    expect(await call(two, 'inbox_lease_reconcile', { attempt_id: 'scope_attempt_00001' }))
      .not.toMatchObject({ ok: true, result: { messages: [{ id: 'scoped' }] } })
    expect(await call(two, 'inbox_lease_ack', { attempt_id: 'scope_attempt_00001' }))
      .not.toMatchObject({ ok: true, result: { consumed: true } })
    expect(rows()).toEqual(held)
    expect(await call(one, 'inbox_lease_ack', { attempt_id: 'scope_attempt_00001' }))
      .toMatchObject({ ok: true, result: { consumed: true } })

    expect(await call(one, 'inbox_lease', { limit: 1, attempt_id: 'physical_attempt_00001' }))
      .toMatchObject({ ok: true, result: { messages: [{ id: 'physical-one' }] } })
    const physicalHeld = rows()
    for (const tool of ['inbox_lease_reconcile', 'inbox_lease_ack']) {
      expect(await call(two, tool, { attempt_id: 'physical_attempt_00001' }))
        .not.toMatchObject({ ok: true, result: { messages: [{ id: 'physical-one' }] } })
      expect(rows()).toEqual(physicalHeld)
    }
    expect(await call(one, 'inbox_lease_ack', { attempt_id: 'physical_attempt_00001' }))
      .toMatchObject({ ok: true, result: { consumed: true } })

    const beforeBroadcastAttempt = rows()
    expect(await call(two, 'inbox_lease', { limit: 1, attempt_id: 'broadcast_attempt_00001' }))
      .toMatchObject({ ok: true, result: { messages: [] } })
    expect(rows()).toEqual(beforeBroadcastAttempt)

    harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(NOW, one.token)
    const beforeRevokedWrite = rows()
    expect(await call(one, 'inbox_lease', { limit: 1, attempt_id: 'revoked_attempt_00001' }))
      .toMatchObject({ ok: false })
    expect(rows()).toEqual(beforeRevokedWrite)
  })

  it('does not claim a message or create an opening receipt after scope loss at the batch boundary', async () => {
    const race = revokeScopeBeforeBatch()
    const before = rows()
    expect(await call(attachment('one'), 'inbox_lease', { limit: 1, attempt_id: 'scope_attempt_00001' }, race.bindings))
      .toMatchObject({ ok: false })
    expect(race.ran()).toBe(true)
    expect(rows()).toEqual(before)
    expect(attempts()).toEqual([])
  })

  it.each(['inbox_lease_reconcile', 'inbox_lease_ack'])('%s cannot expose or settle a held message after scope loss at the batch boundary', async (tool) => {
    const one = attachment('one')
    const id = 'scope_attempt_00001'
    expect(await call(one, 'inbox_lease', { limit: 1, attempt_id: id })).toMatchObject({ ok: true, result: { state: 'leased' } })
    const before = rows()
    const held = attempts()
    const race = revokeScopeBeforeBatch()
    expect(await call(one, tool, { attempt_id: id }, race.bindings)).toMatchObject({ ok: false })
    expect(race.ran()).toBe(true)
    expect(rows()).toEqual(before)
    expect(attempts()).toEqual(held)
  })

  it('restores an exact lease when scope authority is lost before ACK terminalization', async () => {
    const one = attachment('one')
    const id = 'scope_attempt_00001'
    expect(await call(one, 'inbox_lease', { limit: 1, attempt_id: id })).toMatchObject({ ok: true, result: { state: 'leased' } })
    const before = rows()
    const held = attempts()
    // A database-side transition between the message UPDATE and receipt UPDATE.
    harness.sqlite.exec(`CREATE TRIGGER revoke_scope_during_ack
      AFTER UPDATE OF read_at ON agent_messages
      WHEN NEW.id = 'scoped' AND OLD.read_at IS NULL AND NEW.read_at IS NOT NULL
      BEGIN
        UPDATE attachment_continuity_scopes SET revoked_at = datetime('now') WHERE id = 'scope';
      END`)
    expect(await call(one, 'inbox_lease_ack', { attempt_id: id })).toMatchObject({ ok: false })
    expect(harness.sqlite.prepare(`SELECT revoked_at FROM attachment_continuity_scopes WHERE id = 'scope'`).get())
      .toMatchObject({ revoked_at: expect.any(String) })
    expect(rows()).toEqual(before)
    expect(attempts()).toEqual(held)
  })

  it('refuses the attached dead-letter body view while keeping the host view', async () => {
    const one = attachment('one')
    harness.sqlite.exec(`UPDATE agent_messages SET dead_lettered_at = datetime('now'),
      dead_letter_reason = 'fixture' WHERE id = 'scoped'`)
    expect(await call(one, 'inbox_dead_letters', {}))
      .toMatchObject({ ok: false, status: 403, error: 'attached_seat_peek_only' })
    const host = { ...one, auth: { ...one.auth, seatBinding: undefined, consentedByMemberId: undefined } }
    expect(await call(host, 'inbox_dead_letters', {}))
      .toMatchObject({ ok: true, result: { messages: [{ id: 'scoped' }] } })
  })
})
