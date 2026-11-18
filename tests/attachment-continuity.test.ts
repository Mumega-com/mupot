import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  continuityTarget,
  findLiveRecipientContinuityScope,
  prepareContinuityEnrollmentStatements,
  resolveAttachmentContinuity,
} from '../src/members/attachment-continuity'
import type { Env } from '../src/types'

const TENANT = 'tenant-a'
const NOW = '2026-11-18 12:00:00'
let h: SqliteD1Harness

function env(): Env {
  return { DB: h.db, TENANT_SLUG: TENANT, SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1' } as unknown as Env
}

function one<T>(sql: string, ...values: unknown[]): T | undefined {
  return h.sqlite.prepare(sql).get(...values) as T | undefined
}

function seed(o: { grant?: string; admission?: string; attachment?: string; agent?: string } = {}) {
  const grant = o.grant ?? 'grant-a'
  const admission = o.admission ?? 'admission-a'
  const attachment = o.attachment ?? 'attachment-a'
  const agent = o.agent ?? 'agent-rava'
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES ('dept','dept','Dept');
    INSERT INTO squads(id,department_id,slug,name) VALUES ('squad','dept','squad','Squad');
    INSERT INTO members(id,display_name,status,tenant) VALUES ('human','Human','active','${TENANT}'), ('agent-member','Agent','active','${TENANT}');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES ('${agent}','squad','${agent}','${agent}','r','m','active');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES ('seat-agent','squad','seat-agent','seat-agent','r','m','active');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES ('${TENANT}','${agent}','agent-member','${NOW}');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,tenant) VALUES ('${grant}','human','hash-${grant}','oauth','directory','${NOW}','${TENANT}');
    INSERT INTO harnesses(id,tenant,member_id,oauth_client_id,client_name,kind,grant_id,credential_kind) VALUES ('harness','${TENANT}','human','client','Client','chatgpt','oauth:${grant}','oauth');
    INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,label_basename,max_live,created_at) VALUES ('seat','${TENANT}','human','harness','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','seat-agent','seat',4,'${NOW}');
  `)
  // The seat's backing agent is immaterial to attachment authority, but agent_seats requires it first.
  h.sqlite.exec(`
    INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,gates,gate_authority,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via,scope,authority_level,authority_expires_at)
    VALUES ('${admission}','${TENANT}','${agent}','human','harness','live',0,0,'member','tool','seat','${NOW}','${NOW}','human','webauthn','harness','helper','2099-01-01 00:00:00');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,agent_id,tenant) VALUES ('seat-token','agent-member','seat-hash','seat','directory','${NOW}','${agent}','${TENANT}');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at)
    VALUES ('${attachment}','${TENANT}','seat','human','harness','${agent}','${admission}','seat-token','${NOW}');
  `)
  return { grant, admission, attachment, agent }
}

function request(x: ReturnType<typeof seed>) {
  return { attachmentId: x.attachment, seatId: 'seat', agentId: x.agent, humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, nowIso: NOW }
}

async function enroll(x: ReturnType<typeof seed>, scopeId = 'scope-a') {
  await h.db.batch(prepareContinuityEnrollmentStatements(env(), {
    scopeId, attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
    humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant,
    promotedAt: NOW, nowIso: NOW,
  }))
}

function attachLater(x: ReturnType<typeof seed>) {
  h.sqlite.exec(`
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES ('seat-agent-later','squad','seat-agent-later','seat-agent-later','r','m','active');
    INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,label_basename,max_live,created_at)
    VALUES ('seat-later','${TENANT}','human','harness','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','seat-agent-later','later',4,'${NOW}');
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,agent_id,tenant)
    VALUES ('seat-token-later','agent-member','seat-hash-later','seat-later','directory','${NOW}','${x.agent}','${TENANT}');
    INSERT INTO agent_seat_attachments(id,tenant,seat_id,human_member_id,harness_id,agent_id,admission_id,seat_token_id,created_at)
    VALUES ('attachment-later','${TENANT}','seat-later','human','harness','${x.agent}','${x.admission}','seat-token-later','${NOW}');
  `)
  return { ...x, attachment: 'attachment-later' }
}

beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite) })
afterEach(() => h.close())

describe('attachment continuity scopes', () => {
  it('enrolls only the exact fresh WebAuthn R1 promotion and resolves later physical attachments to its stable target', async () => {
    const x = seed()
    await h.db.batch(prepareContinuityEnrollmentStatements(env(), {
      scopeId: 'wrong-promotion', attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
      humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, promotedAt: 'wrong', nowIso: NOW,
    }))
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM attachment_continuity_scopes`)?.n).toBe(0)
    await enroll(x)
    expect(one(`SELECT id, admission_id, source_grant_token_id FROM attachment_continuity_scopes`)).toEqual({ id: 'scope-a', admission_id: x.admission, source_grant_token_id: x.grant })
    expect(continuityTarget('scope-a')).toBe('continuity:scope-a')
    // The immutable scope outlives one physical chat.  It is still a recipient
    // destination while no chat is attached, but access requires a later attach.
    h.sqlite.prepare(`UPDATE agent_seat_attachments SET detached_at = ? WHERE id = ?`).run(NOW, x.attachment)
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', NOW)).resolves.toMatchObject({ agent_id: x.agent })
    const later = attachLater(x)
    await expect(resolveAttachmentContinuity(env(), { ...request(later), seatId: 'seat-later' })).resolves.toMatchObject({ kind: 'scope', target: 'continuity:scope-a' })
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', NOW)).resolves.toMatchObject({ agent_id: x.agent })
  })

  it('keeps old physical attachments legacy and refuses scope lookup when tuple, grant, or liveness changes', async () => {
    const x = seed()
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toEqual({ kind: 'legacy' })
    await enroll(x)
    await expect(resolveAttachmentContinuity(env(), { ...request(x), humanMemberId: 'other' })).resolves.toMatchObject({ kind: 'refused' })
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(NOW, x.grant)
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toMatchObject({ kind: 'refused' })
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', NOW)).resolves.toBeNull()
  })

  it('never revives an immutable epoch and refuses racing live scope collisions', async () => {
    const x = seed()
    await enroll(x)
    expect(() => h.sqlite.prepare(`UPDATE attachment_continuity_scopes SET source_grant_token_id = 'other' WHERE id = 'scope-a'`).run()).toThrow(/immutable/)
    await expect(h.db.batch(prepareContinuityEnrollmentStatements(env(), {
      scopeId: 'scope-race', attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
      humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, promotedAt: NOW, nowIso: NOW,
    }))).resolves.toBeTruthy()
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM attachment_continuity_scopes`)?.n).toBe(1)
  })

  it('keeps legacy message scope null and enforces scoped handled tuple and foreign-recipient invariants in SQLite', () => {
    const x = seed()
    h.sqlite.exec(`INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,body,created_at) VALUES ('legacy','${TENANT}','${x.agent}','${x.agent}','agent-member','body','${NOW}')`)
    expect(one<{ target_continuity_scope_id: string | null }>(`SELECT target_continuity_scope_id FROM agent_messages WHERE id = 'legacy'`)?.target_continuity_scope_id).toBeNull()
    expect(() => h.sqlite.exec(`INSERT INTO agent_continuity_handled(scope_id,message_id,tenant,handled_at,source_attachment_id) VALUES ('foreign','legacy','${TENANT}','${NOW}','${x.attachment}')`)).toThrow()
  })
})
