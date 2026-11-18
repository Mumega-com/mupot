import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { markMessagesHandledByAttachment } from '../src/members/attached-handled'
import { readAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'

const TENANT = 'tenant-a'
const NOW = '2026-11-18 12:00:00'
let h: SqliteD1Harness

function seed(): void {
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES ('dept','dept','Dept');
    INSERT INTO squads(id,department_id,slug,name) VALUES ('squad','dept','squad','Squad');
    INSERT INTO members(id,display_name,status,tenant) VALUES ('human','Human','active','${TENANT}'), ('agent-member','Agent','active','${TENANT}');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES ('rava','squad','rava','Rava','r','m','active'), ('seat-agent','squad','seat-agent','Seat','r','m','active');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES ('${TENANT}','rava','agent-member','${NOW}');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,tenant) VALUES ('grant','human','grant-hash','grant','directory','${NOW}','${TENANT}');
    INSERT INTO harnesses(id,tenant,member_id,oauth_client_id,client_name,kind,grant_id,credential_kind) VALUES ('harness','${TENANT}','human','client','Client','chatgpt','oauth:grant','oauth');
    INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,label_basename,max_live,created_at) VALUES ('seat','${TENANT}','human','harness','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','seat-agent','seat',1,'${NOW}');
    INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,gates,gate_authority,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via,scope,authority_level,authority_expires_at)
      VALUES ('admission','${TENANT}','rava','human','harness','live',0,0,'member','tool','seat','${NOW}','${NOW}','human','webauthn','harness','helper','2099-01-01 00:00:00');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,agent_id,tenant) VALUES ('seat-token','agent-member','seat-hash','physical-token-label','directory','${NOW}','rava','${TENANT}');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at) VALUES ('attachment','${TENANT}','seat','human','harness','rava','admission','seat-token','${NOW}');
    INSERT INTO agent_seat_authority_decisions(id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via)
      VALUES ('decision','${TENANT}','admission','attachment','seat','rava','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn');
    INSERT INTO attachment_continuity_scopes(id,tenant,admission_id,agent_id,human_member_id,harness_id,source_grant_token_id,authority_decision_id,created_at) VALUES ('scope','${TENANT}','admission','rava','human','harness','grant','decision','${NOW}');
    INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,body,created_at,target_continuity_scope_id,target_seat)
      VALUES ('scoped','${TENANT}','rava','sender','sender-member','body','${NOW}','scope','continuity:scope');
    INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,body,created_at,target_continuity_scope_id,target_seat)
      VALUES ('physical','${TENANT}','rava','sender','sender-member','body','${NOW}',NULL,'physical-token-label');
  `)
}

function env(): Env { return { DB: h.db, TENANT_SLUG: TENANT } as Env }

beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite); seed() })
afterEach(() => h.close())

describe('attached continuity inbox handled receipts', () => {
  it('records a scoped receipt only in the current live attachment scope', async () => {
    const result = await markMessagesHandledByAttachment(env(), {
      attachmentId: 'attachment', agentId: 'rava', seat: 'physical-token-label', ids: ['scoped', 'physical'],
      continuity: { attachmentId: 'attachment', seatId: 'seat', agentId: 'rava', humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: 'grant', nowIso: NOW },
    })
    expect(result).toEqual({ ok: true, handled: ['scoped', 'physical'], not_visible: [] })
    expect(h.sqlite.prepare('SELECT scope_id, message_id, source_attachment_id FROM agent_continuity_handled').all())
      .toEqual([{ scope_id: 'scope', message_id: 'scoped', source_attachment_id: 'attachment' }])
    expect(h.sqlite.prepare('SELECT attachment_id, message_id FROM agent_attachment_handled').all())
      .toEqual([{ attachment_id: 'attachment', message_id: 'physical' }])
    expect(h.sqlite.prepare('SELECT read_at FROM agent_messages WHERE id = ?').get('scoped')).toEqual({ read_at: null })
  })

  it('does not reveal an old group receipt after the current scope grant is revoked', async () => {
    const input = {
      attachmentId: 'attachment', agentId: 'rava', seat: 'physical-token-label', ids: ['scoped'],
      continuity: { attachmentId: 'attachment', seatId: 'seat', agentId: 'rava', humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: 'grant', nowIso: NOW },
    }
    expect(await markMessagesHandledByAttachment(env(), input)).toMatchObject({ handled: ['scoped'] })
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = 'grant'`).run(NOW)
    expect(await markMessagesHandledByAttachment(env(), input)).toEqual({ ok: true, handled: [], not_visible: ['scoped'] })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_continuity_handled').get()).toEqual({ n: 1 })
  })

  it('rechecks live scope authority in the page statement after preflight', async () => {
    let revoked = false
    const db = new Proxy(h.db, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (key !== 'prepare' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value
        return (sql: string) => {
          // resolveAttachmentContinuity has already run by the time the page
          // SELECT is prepared.  Revoke in that gap to prove the page's EXISTS
          // guard, rather than the preflight, controls body/count visibility.
          if (!revoked && sql.includes('SELECT seq, id, from_agent')) {
            revoked = true
            h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = 'grant'`).run(NOW)
          }
          return value.call(target, sql)
        }
      },
    })
    const result = await readAgentInbox({ ...env(), DB: db }, {
      agent: 'rava', peek: true, seat: 'physical-token-label', handledByAttachment: 'attachment',
      continuity: { attachmentId: 'attachment', seatId: 'seat', agentId: 'rava', humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: 'grant' },
    })
    expect(revoked).toBe(true)
    expect(result).toMatchObject({ ok: true, messages: [], remaining: 0, complete: true })
  })
})
