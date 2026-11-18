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

function tamperMemberToken(sql: string): void {
  const triggers = h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'member_tokens'`).all() as Array<{ name: string }>
  for (const trigger of triggers) h.sqlite.exec(`DROP TRIGGER ${trigger.name}`)
  h.sqlite.exec(sql)
}

function tamperHarness(sql: string): void {
  const triggers = h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'harnesses'`).all() as Array<{ name: string }>
  for (const trigger of triggers) h.sqlite.exec(`DROP TRIGGER ${trigger.name}`)
  h.sqlite.exec(sql)
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
    INSERT INTO agent_seat_authority_decisions(id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via)
    VALUES ('decision-${admission}','${TENANT}','${admission}','${attachment}','seat','${agent}','harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn');
  `)
  return { grant, admission, attachment, agent, decision: `decision-${admission}` }
}

function request(x: ReturnType<typeof seed>) {
  return { attachmentId: x.attachment, seatId: 'seat', agentId: x.agent, humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, nowIso: NOW }
}

async function enroll(x: ReturnType<typeof seed>, scopeId = 'scope-a') {
  await h.db.batch(prepareContinuityEnrollmentStatements(env(), {
    scopeId, attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
    humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant,
    authorityDecisionId: x.decision, promotedAt: NOW, nowIso: NOW,
  }))
}

function approveContinuity(x: ReturnType<typeof seed>) {
  const decision = `${x.decision}-continuity`
  h.sqlite.prepare(`INSERT INTO agent_seat_authority_decisions
    (id,tenant,admission_id,attachment_id,seat_id,agent_id,harness_id,decided_by_member_id,authority_level,authority_expires_at,decided_at,decided_via,continuity_approved)
    VALUES (?,'${TENANT}',? ,?,'seat',?,'harness','human','helper','2099-01-01 00:00:00','${NOW}','webauthn',1)`)
    .run(decision, x.admission, x.attachment, x.agent)
  return { ...x, decision }
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
    // An old WebAuthn decision is not continuity consent.  Task 2 will set this
    // bit only from the fresh, checkbox-bound passkey promotion.
    await enroll(x)
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM attachment_continuity_scopes`)?.n).toBe(0)
    const approved = approveContinuity(x)
    await h.db.batch(prepareContinuityEnrollmentStatements(env(), {
      scopeId: 'wrong-promotion', attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
      humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, authorityDecisionId: approved.decision, promotedAt: 'wrong', nowIso: NOW,
    }))
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM attachment_continuity_scopes`)?.n).toBe(0)
    await enroll(approved)
    expect(one(`SELECT id, admission_id, source_grant_token_id FROM attachment_continuity_scopes`)).toEqual({ id: 'scope-a', admission_id: x.admission, source_grant_token_id: x.grant })
    expect(continuityTarget('scope-a')).toBe('continuity:scope-a')
    // The immutable scope outlives one physical chat.  It is still a recipient
    // destination while no chat is attached, but access requires a later attach.
    h.sqlite.prepare(`UPDATE agent_seat_attachments SET detached_at = ? WHERE id = ?`).run(NOW, x.attachment)
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toMatchObject({ agent_id: x.agent })
    const later = attachLater(x)
    await expect(resolveAttachmentContinuity(env(), { ...request(later), seatId: 'seat-later' })).resolves.toMatchObject({ kind: 'scope', target: 'continuity:scope-a' })
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toMatchObject({ agent_id: x.agent })
  })

  it('keeps old physical attachments legacy and refuses scope lookup when tuple, grant, or liveness changes', async () => {
    const x = seed()
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toEqual({ kind: 'legacy' })
    const approved = approveContinuity(x)
    await enroll(approved)
    await expect(resolveAttachmentContinuity(env(), { ...request(x), humanMemberId: 'other' })).resolves.toMatchObject({ kind: 'refused' })
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`).run(NOW, x.grant)
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toMatchObject({ kind: 'refused' })
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toBeNull()
  })

  it('never revives an immutable epoch and refuses racing live scope collisions', async () => {
    const x = seed()
    const approved = approveContinuity(x)
    await enroll(approved)
    expect(() => h.sqlite.prepare(`UPDATE attachment_continuity_scopes SET source_grant_token_id = 'other' WHERE id = 'scope-a'`).run()).toThrow(/immutable/)
    await expect(h.db.batch(prepareContinuityEnrollmentStatements(env(), {
      scopeId: 'scope-race', attachmentId: x.attachment, admissionId: x.admission, agentId: x.agent,
      humanMemberId: 'human', harnessId: 'harness', sourceGrantTokenId: x.grant, authorityDecisionId: approved.decision, promotedAt: NOW, nowIso: NOW,
    }))).resolves.toBeTruthy()
    expect(one<{ n: number }>(`SELECT count(*) AS n FROM attachment_continuity_scopes`)?.n).toBe(1)
  })

  it('blocks REPLACE for both live and revoked immutable epochs', async () => {
    const x = seed()
    const approved = approveContinuity(x)
    await enroll(approved)
    const replace = () => h.sqlite.exec(`INSERT OR REPLACE INTO attachment_continuity_scopes
      (id,tenant,admission_id,agent_id,human_member_id,harness_id,source_grant_token_id,authority_decision_id,created_at)
      VALUES ('replacement','${TENANT}','${x.admission}','${x.agent}','human','harness','${x.grant}','${approved.decision}','${NOW}')`)
    expect(replace).toThrow(/immutable/)
    h.sqlite.prepare(`UPDATE attachment_continuity_scopes SET revoked_at = ? WHERE id = 'scope-a'`).run(NOW)
    expect(replace).toThrow(/immutable/)
  })

  it('refuses a physical request whose own seat token is revoked, expired, or bound to another weld', async () => {
    const x = seed()
    const approved = approveContinuity(x)
    await enroll(approved)
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = 'seat-token'`).run(NOW)
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toMatchObject({ kind: 'refused', reason: 'attachment_not_live' })
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = NULL, expires_at = ? WHERE id = 'seat-token'`).run('2000-01-01 00:00:00')
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toMatchObject({ kind: 'refused', reason: 'attachment_not_live' })
    tamperMemberToken(`UPDATE member_tokens SET expires_at = NULL, agent_id = 'seat-agent' WHERE id = 'seat-token'`)
    await expect(resolveAttachmentContinuity(env(), request(x))).resolves.toMatchObject({ kind: 'refused', reason: 'attachment_not_live' })
  })

  it('fails recipient lookup closed on authority expiry or an inactive recipient agent', async () => {
    const x = seed()
    await enroll(approveContinuity(x))
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, '2100-01-01 00:00:00')).resolves.toBeNull()
    h.sqlite.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(x.agent)
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toBeNull()
  })

  it('fails recipient lookup closed when the active human or harness grant anchor no longer matches', async () => {
    const x = seed()
    await enroll(approveContinuity(x))
    h.sqlite.prepare(`UPDATE members SET status = 'suspended' WHERE id = 'human'`).run()
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toBeNull()
    h.sqlite.prepare(`UPDATE members SET status = 'active' WHERE id = 'human'`).run()
    h.sqlite.prepare(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,created_at,tenant) VALUES ('other-grant','human','other','other','directory','${NOW}','${TENANT}')`).run()
    tamperHarness(`UPDATE harnesses SET grant_id = 'oauth:other-grant' WHERE id = 'harness'`)
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toBeNull()
  })

  it('recipient lookup is tenant-scoped (resource contract, not a forged cross-tenant MCP principal)', async () => {
    const x = seed()
    await enroll(approveContinuity(x))
    await expect(findLiveRecipientContinuityScope(env(), 'scope-a', x.agent, NOW)).resolves.toMatchObject({ id: 'scope-a' })
    const foreignEnv = { ...env(), TENANT_SLUG: 'tenant-foreign' } as Env
    await expect(findLiveRecipientContinuityScope(foreignEnv, 'scope-a', x.agent, NOW)).resolves.toBeNull()
  })

  it('keeps legacy message scope null and enforces scoped handled tuple and foreign-recipient invariants in SQLite', () => {
    const x = seed()
    h.sqlite.exec(`INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,body,created_at) VALUES ('legacy','${TENANT}','${x.agent}','${x.agent}','agent-member','body','${NOW}')`)
    expect(one<{ target_continuity_scope_id: string | null }>(`SELECT target_continuity_scope_id FROM agent_messages WHERE id = 'legacy'`)?.target_continuity_scope_id).toBeNull()
    expect(() => h.sqlite.exec(`INSERT INTO agent_continuity_handled(scope_id,message_id,tenant,handled_at,source_attachment_id) VALUES ('foreign','legacy','${TENANT}','${NOW}','${x.attachment}')`)).toThrow()
  })
})
