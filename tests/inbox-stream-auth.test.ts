import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { validateInboxStreamIdentity } from '../src/agents/inbox-stream-auth'

let h: SqliteD1Harness
let env: Env
const identity = { tokenId: 'stream-token', memberId: 'reader', agentId: 'reader-agent', seat: 'seat-one' }
beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES('stream-dept','stream','Stream');
    INSERT INTO squads(id,department_id,slug,name) VALUES('stream-squad','stream-dept','stream','Stream');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES
      ('reader-agent','stream-squad','reader','Reader','member','m','active'),
      ('other-agent','stream-squad','other','Other','member','m','active'),
      ('host-agent','stream-squad','host','Host','member','m','active');
    INSERT INTO members(id,display_name,status,tenant) VALUES('reader','Reader','active','test'),('other-member','Other','active','test'),('host-member','Host','active','test');
    INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('test','reader-agent','reader',datetime('now'));
    INSERT INTO member_tokens(id,member_id,token_hash,label,channel,tenant,agent_id)
      VALUES('stream-token','reader','fixture-hash','seat-one','workspace','test','reader-agent');
  `)
  env = { DB: h.db, TENANT_SLUG: 'test' } as unknown as Env
})
afterEach(() => h.close())

describe('stream reference authorization', () => {
  it('accepts only the original active member, agent and seat', async () => {
    expect(await validateInboxStreamIdentity(env, identity)).toBe('valid')
    expect(await validateInboxStreamIdentity(env, { ...identity, memberId: 'other-member' })).toBe('invalid')
    expect(await validateInboxStreamIdentity(env, { ...identity, agentId: 'other-agent' })).toBe('invalid')
    expect(await validateInboxStreamIdentity(env, { ...identity, seat: null })).toBe('invalid')
    expect(await validateInboxStreamIdentity({ ...env, TENANT_SLUG: 'foreign' }, identity)).toBe('invalid')
  })
  it.each([
    ['revoked', "UPDATE member_tokens SET revoked_at=datetime('now')"],
    ['expired', "UPDATE member_tokens SET expires_at=datetime('now','-1 second')"],
    ['changed seat', "UPDATE member_tokens SET label='seat-two'"],
    ['suspended member', "UPDATE members SET status='suspended' WHERE id='reader'"],
    ['inactive agent', "UPDATE agents SET status='inactive' WHERE id='reader-agent'"],
    ['paused agent', "UPDATE agents SET status='paused' WHERE id='reader-agent'"],
    ['directory credential', "UPDATE member_tokens SET channel='directory'"],
  ])('rejects %s instead of renewing the stream', async (_name, sql) => {
    h.sqlite.exec(sql)
    expect(await validateInboxStreamIdentity(env, identity)).toBe('invalid')
  })
  it('rejects a same-member credential reference now bound to another agent', async () => {
    // Respect immutable binding triggers: replace the fixture identity rather than disabling them.
    h.sqlite.exec(`DELETE FROM member_tokens; DELETE FROM agent_member_bindings;
      INSERT INTO agent_member_bindings VALUES('test','other-agent','reader',datetime('now'));
      INSERT INTO member_tokens(id,member_id,token_hash,label,channel,tenant,agent_id)
      VALUES('stream-token','reader','fixture-hash','seat-one','workspace','test','other-agent');`)
    expect(await validateInboxStreamIdentity(env, identity)).toBe('invalid')
  })
  it.each(['observed', 'held'])('rejects a %s seat while the VIP floor is enabled', async (status) => {
    h.sqlite.exec(`INSERT INTO harnesses(id,tenant,member_id,oauth_client_id) VALUES('test-harness','test','reader','client');
      INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,max_live,admission_status)
      VALUES('test-seat','test','reader','test-harness','${'a'.repeat(64)}','reader-agent',16,'${status}');`)
    expect(await validateInboxStreamIdentity({ ...env, VIP_LANE: '1' }, identity)).toBe('invalid')
    expect(await validateInboxStreamIdentity(env, identity)).toBe('valid')
  })
  it('normalizes an absent seat without treating it as a failed lookup', async () => {
    h.sqlite.exec("UPDATE member_tokens SET label='   '")
    expect(await validateInboxStreamIdentity(env, { ...identity, seat: null })).toBe('valid')
    expect(await validateInboxStreamIdentity(env, { ...identity, tokenId: 'missing', seat: null })).toBe('invalid')
  })
  it('distinguishes database failure from invalid credentials', async () => {
    const broken = { ...env, DB: { prepare() { throw new Error('offline') } } } as unknown as Env
    expect(await validateInboxStreamIdentity(broken, identity)).toBe('error')
  })
  it('fences an eligible fleet host, but not a revoked grant or inactive host member', async () => {
    h.sqlite.exec(`
      INSERT INTO agent_keys(tenant,agent_id,pubkey,algo,member_id,created_at) VALUES('test','host-agent','fixture-public-key','Ed25519','host-member',1);
      INSERT INTO seat_event_grants(id,tenant,host_agent_id,agent_id,granted_by_member_id,reason,created_at) VALUES('stream-grant','test','host-agent','reader-agent','host-member','test',datetime('now'));
    `)
    expect(await validateInboxStreamIdentity(env, identity)).toBe('invalid')
    h.sqlite.exec("UPDATE members SET status='suspended' WHERE id='host-member'")
    expect(await validateInboxStreamIdentity(env, identity)).toBe('valid')
    h.sqlite.exec("UPDATE members SET status='active' WHERE id='host-member'; UPDATE seat_event_grants SET revoked_at=datetime('now'), revoked_by_member_id='host-member'")
    expect(await validateInboxStreamIdentity(env, identity)).toBe('valid')
  })
})
