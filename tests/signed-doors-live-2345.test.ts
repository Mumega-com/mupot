// tests/signed-doors-live-2345.test.ts — mupot#2345: key-SIGNED doors apply the same live verdict as the bearer / MCP doors.
// Real SQL (whole migration chain). Every door is driven with a VALID signature, so a refusal can only come from the verdict.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { appErrorHandler } from '../src/app-error'
import { BoundAgentCheckUnavailableError } from '../src/auth/bound-agent-live'
import { loadSignerKey } from '../src/fleet/agent-keys'
import { canonicalInboxMessage, verifySignedInboxRead } from '../src/fleet/signed-inbox'
import { canonicalAttachMessage, verifySignedAttach } from '../src/fleet/signed-attach'
import { canonicalDetachMessage, verifySignedDetach } from '../src/fleet/signed-detach'
import { canonicalRunnerReceiptMessage, verifyRunnerReceiptSig } from '../src/runners/signature'
import { authorizeSeatDelivery, canonicalTicketMessage, createSeatEventGrant, verifyTicketRequest } from '../src/agents/seat-events'
import { inboxApp } from '../src/agents/inbox-routes'

const TENANT = 'mumega'
const AGENT = 'keyed-agent' // agents.id AND the agent_keys.agent_id
const HOST = 'keyed-host'
const SEAT = 'seat-agent'

// The read-only pre-deploy query quoted in the PR body: agents with an active registered key the signed-door check would newly refuse.
const PRE_DEPLOY_SQL = `-- READ-ONLY. Agents with an active registered key that the key-signed-door check (#2345) would newly refuse.
-- A slug key resolves through the key's own member (binding or owner), so a same-slug agent in another squad does not count.
-- Replace 'mumega' with the tenant slug. An empty result = nothing newly refused.
WITH keyed AS (
  SELECT k.agent_id AS keyed_id, k.member_id AS key_member,
         (SELECT COUNT(*) FROM agents a
           WHERE a.id = k.agent_id
              OR (a.slug = k.agent_id AND NOT EXISTS (SELECT 1 FROM agents x WHERE x.id = k.agent_id)
                  AND (EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = k.tenant AND b.agent_id = a.id AND b.member_id = k.member_id)
                       OR a.owner_member_id = k.member_id))) AS n_agents
    FROM agent_keys k
    JOIN members km ON km.id = k.member_id AND km.tenant = k.tenant AND km.status = 'active'
   WHERE k.tenant = 'mumega' AND k.member_id IS NOT NULL
)
SELECT kd.keyed_id, kd.key_member, a.id AS agent_id, a.status AS agent_status, a.owner_member_id,
       CASE WHEN kd.n_agents <> 1 THEN 'agent_unresolved_or_ambiguous'
            WHEN a.status NOT IN ('active', 'paused') THEN 'agent_not_live'
            WHEN a.owner_member_id IS NOT NULL AND COALESCE(om.status, '') <> 'active' THEN 'owner_not_active_in_tenant'
            ELSE 'key_member_zero_capabilities' END AS reason
  FROM keyed kd
  LEFT JOIN agents a ON kd.n_agents = 1
        AND (a.id = kd.keyed_id
             OR (a.slug = kd.keyed_id AND NOT EXISTS (SELECT 1 FROM agents x WHERE x.id = kd.keyed_id)
                 AND (EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = 'mumega' AND b.agent_id = a.id AND b.member_id = kd.key_member)
                      OR a.owner_member_id = kd.key_member)))
  LEFT JOIN members om ON om.id = a.owner_member_id AND om.tenant = 'mumega'
 WHERE kd.n_agents <> 1
    OR a.status NOT IN ('active', 'paused')
    OR (a.owner_member_id IS NOT NULL AND COALESCE(om.status, '') <> 'active')
    OR NOT (EXISTS (SELECT 1 FROM capabilities c
                     WHERE c.member_id = kd.key_member AND (c.expires_at IS NULL OR julianday(c.expires_at) > julianday('now')))
            OR EXISTS (SELECT 1 FROM channel_capability_grants g JOIN squads s ON s.id = g.squad_id
                        WHERE g.member_id = kd.key_member AND s.kind <> 'home'))
 ORDER BY reason, kd.keyed_id;
`

let h: SqliteD1Harness
let priv: CryptoKey
let env: Env

const b64 = (b: ArrayBuffer): string => Buffer.from(b).toString('base64url')
const nonce = (): string => crypto.randomUUID().replace(/-/g, '')
const nowSec = (): number => Math.floor(Date.now() / 1000)
async function sign(msg: Uint8Array): Promise<string> {
  return b64(await crypto.subtle.sign('Ed25519', priv, msg))
}

/** A DB whose agent-liveness statement (the shared verdict) throws; every other statement passes through. */
function liveReadThrows(): Env {
  const db = { prepare: (sql: string) => { if (sql.includes('has_caps')) throw new Error('d1 down'); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) }
  return { DB: db, TENANT_SLUG: TENANT } as unknown as Env
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  priv = pair.privateKey
  const x = (await crypto.subtle.exportKey('jwk', pair.publicKey)).x as string
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S1');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('m-owner', 'Owner', 'active', '${TENANT}'), ('m-key', 'Key member', 'active', '${TENANT}'), ('m-grantor', 'Grantor', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
      ('${AGENT}', 's1', '${AGENT}', 'Keyed', 'member', 'm', 'active', 'm-owner'),
      ('${HOST}', 's1', '${HOST}', 'Host', 'member', 'm', 'active', 'm-owner'),
      ('${SEAT}', 's1', '${SEAT}', 'Seat', 'member', 'm', 'active', NULL);
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-key', 'm-key', 'squad', 's1', 'member');
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT}', '${x}', 'Ed25519', 'm-key', ${nowSec()}),
      ('${TENANT}', '${HOST}', '${x}', 'Ed25519', 'm-key', ${nowSec()});
  `)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`INSERT INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
    VALUES ('g1', '${TENANT}', '${HOST}', '${SEAT}', NULL, 'm-grantor', 'x', '2026-11-05T00:00:00Z')`)
})
afterEach(() => h.close())

async function inboxBody(): Promise<Record<string, unknown>> {
  const b = { agent_id: AGENT, peek: true, limit: 5, ts: nowSec(), nonce: nonce() }
  return { ...b, sig: await sign(canonicalInboxMessage({ tenant: TENANT, ...b })) }
}
async function attachBody(): Promise<Record<string, unknown>> {
  const b = { agent_id: AGENT, type: 'builder', runtime: 'rt', lifecycle: 'on_demand', ts: nowSec(), nonce: nonce() }
  return { ...b, sig: await sign(canonicalAttachMessage({ tenant: TENANT, ...b })) }
}
async function detachBody(): Promise<Record<string, unknown>> {
  const b = { agent_id: AGENT, ts: nowSec(), nonce: nonce() }
  return { ...b, sig: await sign(canonicalDetachMessage({ tenant: TENANT, ...b })) }
}
async function receipt(): Promise<{ sig: string; sig_ts: number; sig_nonce: string }> {
  const sig_ts = nowSec(), sig_nonce = nonce()
  return { sig: await sign(canonicalRunnerReceiptMessage({ tenant: TENANT, seat_agent_id: AGENT, name: 'n', task: 't', status: 'running', ts: sig_ts, nonce: sig_nonce })), sig_ts, sig_nonce }
}
async function ticketBody(): Promise<Record<string, unknown>> {
  const b = { host_agent_id: HOST, agents: [SEAT], ts: nowSec(), nonce: nonce() }
  return { ...b, sig: await sign(canonicalTicketMessage({ tenant: TENANT, ...b })) }
}

const BREAKERS: Array<[string, string]> = [
  ['owner suspended', `UPDATE members SET status = 'suspended' WHERE id = 'm-owner'`],
  ['owner in another tenant', `UPDATE members SET tenant = 'other' WHERE id = 'm-owner'`],
  ['agent deactivated', `UPDATE agents SET status = 'inactive' WHERE id IN ('${AGENT}', '${HOST}')`],
  ['key member has zero capabilities', `DELETE FROM capabilities WHERE member_id = 'm-key'`],
  ['agent row gone (key resolves to no agent)', `PRAGMA foreign_keys = OFF; DELETE FROM agents WHERE id IN ('${AGENT}', '${HOST}')`],
]

describe('#2345 the verdict is applied to the agent a signing key belongs to', () => {
  it('control: a live agent passes every signed door', async () => {
    expect((await verifySignedInboxRead(env, await inboxBody())).ok).toBe(true)
    expect((await verifySignedAttach(env, await attachBody(), new Set(['builder']), new Set(['on_demand']))).ok).toBe(true)
    expect((await verifySignedDetach(env, await detachBody())).ok).toBe(true)
    await expect(verifyRunnerReceiptSig(env, AGENT, 'n', 't', 'running', await receipt())).resolves.toBeUndefined()
    expect(await authorizeSeatDelivery(env, HOST, SEAT)).toBe('granted')
    h.sqlite.exec(`DELETE FROM seat_event_grants`)
    expect(await createSeatEventGrant(env, { hostAgentId: HOST, agentId: SEAT, memberId: 'm-grantor', reason: 'x' })).toMatchObject({ ok: true })
    const t = await verifyTicketRequest(env, await ticketBody())
    expect(t, JSON.stringify(t)).toMatchObject({ ok: true })
  })

  for (const [label, sql] of BREAKERS) {
    describe(label, () => {
      beforeEach(() => { h.sqlite.exec(sql) })
      it('signed inbox -> 401 unauthorized (same body as a bad signature)', async () => {
        const r = await verifySignedInboxRead(env, await inboxBody())
        expect(r).toMatchObject({ ok: false, status: 401, error: 'unauthorized', detail: 'signature verification failed' })
      })
      it('signed attach -> 401', async () => {
        expect(await verifySignedAttach(env, await attachBody(), new Set(['builder']), new Set(['on_demand']))).toMatchObject({ ok: false, status: 401 })
      })
      it('runner receipt signature -> refused like a missing key', async () => {
        await expect(verifyRunnerReceiptSig(env, AGENT, 'n', 't', 'running', await receipt())).rejects.toThrow(/no active Ed25519 key/)
      })
      it('host-signed ticket -> 401', async () => {
        expect(await verifyTicketRequest(env, await ticketBody())).toMatchObject({ ok: false, status: 401 })
      })
      it('grant creation refuses the host; delivery is not granted', async () => {
        h.sqlite.exec(`DELETE FROM seat_event_grants`) // so a refusal can only come from the host verdict, not from "agent already granted"
        const g = await createSeatEventGrant(env, { hostAgentId: HOST, agentId: SEAT, memberId: 'm-grantor', reason: 'x' })
        expect(g.ok).toBe(false)
        h.sqlite.exec(`INSERT INTO seat_event_grants (id, tenant, host_agent_id, agent_id, project_id, granted_by_member_id, reason, created_at)
          VALUES ('g2', '${TENANT}', '${HOST}', '${SEAT}', NULL, 'm-grantor', 'x', '2026-11-05T00:00:00Z')`)
        expect(await authorizeSeatDelivery(env, HOST, SEAT)).toBe('not_granted')
      })
    })
  }

  it('detach stays allowed for a refused agent (it only relinquishes), still needs a valid signature', async () => {
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'm-owner'; DELETE FROM capabilities WHERE member_id = 'm-key'`)
    expect((await verifySignedDetach(env, await detachBody())).ok).toBe(true)
    const bad = { ...(await detachBody()), sig: 'A'.repeat(86) }
    expect(await verifySignedDetach(env, bad)).toMatchObject({ ok: false, status: 401 })
  })

  it('paused agent is admitted (brake semantics unchanged)', async () => {
    h.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = '${AGENT}'`)
    expect((await verifySignedInboxRead(env, await inboxBody())).ok).toBe(true)
  })

  describe('a key registered by SLUG resolves through the key\'s own member', () => {
    beforeEach(() => {
      h.sqlite.exec(`
        INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-1', 's1', 'slugged', 'S', 'member', 'm', 'active', 'm-owner');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'uuid-1', 'm-key', '2026-08-01T00:00:00Z');
        INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('${TENANT}', 'slugged', 'k', 'Ed25519', 'm-key', 1);
        INSERT INTO squads (id, department_id, slug, name) VALUES ('s2', 'd1', 's2', 'S2');`)
    })
    it('the real agent is live', async () => {
      expect((await loadSignerKey(env, 'slugged')).state).toBe('live')
    })
    it('a squatter reusing the slug in another squad does NOT change the verdict (live stays live)', async () => {
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-squat', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-grantor')`)
      expect((await loadSignerKey(env, 'slugged')).state).toBe('live')
    })
    it('the squatter cannot make a REFUSED agent live either: judgement follows the bound agent', async () => {
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-squat', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-grantor');
        UPDATE members SET status = 'suspended' WHERE id = 'm-owner'`)
      expect((await loadSignerKey(env, 'slugged')).state).toBe('refused')
    })
    it('a hard-deleted agent\'s leftover slug key is not judged against an unrelated newcomer', async () => {
      h.sqlite.exec(`PRAGMA foreign_keys = OFF; DELETE FROM agents WHERE id = 'uuid-1';
        INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-new', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-owner')`)
      expect((await loadSignerKey(env, 'slugged')).state).toBe('refused')
    })
    it('still more than one agent bound to the key member after the filter = refused', async () => {
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-2', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-key')`)
      expect((await loadSignerKey(env, 'slugged')).state).toBe('refused')
    })
    it('the pre-deploy SQL agrees: it reports 0 rows for the real agent with and without a squatter', () => {
      const rows = (): unknown[] => h.sqlite.prepare(PRE_DEPLOY_SQL).all().filter((r) => (r as { keyed_id: string }).keyed_id === 'slugged')
      expect(rows()).toEqual([])
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-squat', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-grantor')`)
      expect(rows()).toEqual([])
    })
  })

  /** A DB whose statements containing `needle` throw. */
  function throwingOn(needle: string): Env {
    const db = { prepare: (sql: string) => { if (sql.includes(needle)) throw new Error('d1 down'); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) }
    return { DB: db, TENANT_SLUG: TENANT } as unknown as Env
  }
  const READS: Array<[string, string]> = [
    ['the verdict read', 'has_caps'],
    ['the slug/agent resolution read', 'FROM agents a\n      WHERE a.id = ?1'],
    ['the key load', 'FROM agent_keys k'],
  ]

  describe.each(READS)('%s failing', (_n, needle) => {
    it('every door that loads or judges a key answers unavailable, never a pass, a 401 or a 500', async () => {
      const down = throwingOn(needle)
      await expect(verifySignedInboxRead(down, await inboxBody())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
      await expect(verifySignedAttach(down, await attachBody(), new Set(['builder']), new Set(['on_demand']))).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
      await expect(verifyRunnerReceiptSig(down, AGENT, 'n', 't', 'running', await receipt())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
      await expect(verifyTicketRequest(down, await ticketBody())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
      expect((await loadSignerKey(down, AGENT)).state).toBe('unavailable')
      await expect(createSeatEventGrant(down, { hostAgentId: HOST, agentId: SEAT, memberId: 'm-grantor', reason: 'x' })).resolves.toMatchObject({ ok: false })
    })
    it('seat delivery is exactly "error" (not "not_granted") so a blip is never read as a revocation', async () => {
      if (needle === 'FROM agent_keys k') return // the delivery query itself joins agent_keys k and would error first: same answer
      expect(await authorizeSeatDelivery(throwingOn(needle), HOST, SEAT)).toBe('error')
    })
  })
  it('seat delivery: the host-key load failing is also exactly "error"', async () => {
    expect(await authorizeSeatDelivery(throwingOn('FROM agent_keys k'), HOST, SEAT)).toBe('error')
  })

  it('the signature is checked BEFORE any liveness read: a bad signature is a 401 even with the verdict down, and reads nothing', async () => {
    let verdictReads = 0
    const db = { prepare: (sql: string) => { if (sql.includes('has_caps') || sql.includes('FROM agents a\n      WHERE a.id = ?1')) { verdictReads++; throw new Error('d1 down') } return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) }
    const e = { DB: db, TENANT_SLUG: TENANT } as unknown as Env
    const bad = { ...(await inboxBody()), sig: 'A'.repeat(86) }
    expect(await verifySignedInboxRead(e, bad)).toMatchObject({ ok: false, status: 401 })
    expect(await verifySignedAttach(e, { ...(await attachBody()), sig: 'A'.repeat(86) }, new Set(['builder']), new Set(['on_demand']))).toMatchObject({ ok: false, status: 401 })
    expect(await verifyTicketRequest(e, { ...(await ticketBody()), sig: 'A'.repeat(86) })).toMatchObject({ ok: false, status: 401 })
    await expect(verifyRunnerReceiptSig(e, AGENT, 'n', 't', 'running', { ...(await receipt()), sig: 'A'.repeat(86) })).rejects.toThrow(/invalid_signature/)
    expect(verdictReads).toBe(0)
  })

  it('a 503 does not burn the nonce: the same signed request succeeds on retry', async () => {
    const body = await inboxBody()
    await expect(verifySignedInboxRead(liveReadThrows(), body)).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    expect((await verifySignedInboxRead(env, body)).ok).toBe(true)
    expect(await verifySignedInboxRead(env, body)).toMatchObject({ ok: false, status: 409 }) // and now it is spent
  })

  it('a failed liveness read is unavailable: HTTP doors throw the retryable error, never a pass or a 401', async () => {
    const down = liveReadThrows()
    expect((await loadSignerKey(down, AGENT)).state).toBe('unavailable')
    await expect(verifySignedInboxRead(down, await inboxBody())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    await expect(verifyRunnerReceiptSig(down, AGENT, 'n', 't', 'running', await receipt())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    expect(await authorizeSeatDelivery(down, HOST, SEAT)).toBe('error')
  })

  it('POST /api/inbox/signed answers 503 + Retry-After when the check cannot run, 401 when it refuses', async () => {
    const app = new Hono<{ Bindings: Env }>().route('/api/inbox', inboxApp)
    app.onError(appErrorHandler)
    const post = async (e: Env): Promise<Response> => app.request('/api/inbox/signed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await inboxBody()) }, e)
    const down = await post(liveReadThrows())
    expect(down.status).toBe(503)
    expect(down.headers.get('retry-after')).toBe('2')
    expect(down.headers.get('cache-control')).toBe('no-store')
    expect(await down.json()).toEqual({ error: 'agent_check_unavailable' })
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'm-owner'`)
    expect((await post(env)).status).toBe(401)
  })

  it('the pre-deploy SQL lists exactly the agents the doors now refuse (and nothing for a live one)', () => {
    const rows = (): Array<{ keyed_id: string; reason: string }> => h.sqlite.prepare(PRE_DEPLOY_SQL).all() as Array<{ keyed_id: string; reason: string }>
    expect(rows()).toEqual([])
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'm-owner'; DELETE FROM capabilities WHERE member_id = 'm-key'`)
    expect(rows().map((r) => [r.keyed_id, r.reason])).toEqual([[AGENT, 'owner_not_active_in_tenant'], [HOST, 'owner_not_active_in_tenant']])
    h.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = 'm-owner'`)
    expect(rows().map((r) => r.reason)).toEqual(['key_member_zero_capabilities', 'key_member_zero_capabilities'])
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${AGENT}'`)
    expect(rows().find((r) => r.keyed_id === AGENT)?.reason).toBe('agent_not_live')
  })
})
