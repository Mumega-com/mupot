import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-a'
const NOW = '2026-11-18 12:00:00'
let h: SqliteD1Harness

function seedScope(): void {
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
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,agent_id,tenant) VALUES ('seat-token','agent-member','seat-hash','seat','directory','${NOW}','rava','${TENANT}');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at) VALUES ('attachment','${TENANT}','seat','human','harness','rava','admission','seat-token','${NOW}');
    INSERT INTO agent_seat_authority_decisions(id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via) VALUES ('decision','${TENANT}','admission','attachment','seat','rava','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn');
    INSERT INTO attachment_continuity_scopes(id,tenant,admission_id,agent_id,human_member_id,harness_id,source_grant_token_id,authority_decision_id,created_at) VALUES ('scope','${TENANT}','admission','rava','human','harness','grant','decision','${NOW}');
  `)
}

function message(id: string, targetScope: string | null, targetSeat: string | null): void {
  h.sqlite.prepare(`INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,body,created_at,target_continuity_scope_id,target_seat)
    VALUES (?, ?, 'rava', 'rava', 'agent-member', 'body', ?, ?, ?)`)
    .run(id, TENANT, NOW, targetScope, targetSeat)
}

beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite); seedScope() })
afterEach(() => h.close())

describe('attachment continuity schema contract', () => {
  it('records a handled receipt for an exact scoped target or a legacy null target, never a partial or foreign target', () => {
    message('scoped', 'scope', 'continuity:scope')
    message('legacy', null, null)
    message('partial', null, 'physical-seat')

    const handled = (messageId: string) => h.sqlite.prepare(`INSERT INTO agent_continuity_handled(scope_id,message_id,tenant,handled_at,source_attachment_id)
      VALUES ('scope', ?, ?, ?, 'attachment')`).run(messageId, TENANT, NOW)
    expect(() => handled('scoped')).not.toThrow()
    expect(() => handled('legacy')).not.toThrow()
    expect(() => handled('partial')).toThrow(/scope_message_invalid/)
  })

  it('does not allow a scope provenance decision to change', () => {
    h.sqlite.exec(`INSERT INTO agent_seat_authority_decisions(id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via)
      VALUES ('other-decision','${TENANT}','admission','attachment','seat','rava','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn')`)
    expect(() => h.sqlite.prepare(`UPDATE attachment_continuity_scopes SET authority_decision_id = 'other-decision' WHERE id = 'scope'`).run()).toThrow(/immutable/)
  })

  it('keeps existing scoped routing immutable while allowing unrelated delivery state updates and legacy routing changes', () => {
    message('scoped', 'scope', 'continuity:scope')
    message('legacy', null, null)
    expect(() => h.sqlite.prepare(`UPDATE agent_messages SET target_continuity_scope_id = NULL, target_seat = NULL WHERE id = 'scoped'`).run()).toThrow(/immutable/)
    expect(() => h.sqlite.prepare(`UPDATE agent_messages SET target_seat = 'continuity:other' WHERE id = 'scoped'`).run()).toThrow(/immutable/)
    expect(() => h.sqlite.prepare(`UPDATE agent_messages SET read_at = ? WHERE id = 'scoped'`).run(NOW)).not.toThrow()
    expect(() => h.sqlite.prepare(`UPDATE agent_messages SET target_seat = 'physical-seat' WHERE id = 'legacy'`).run()).not.toThrow()
  })
})
