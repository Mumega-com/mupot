// tests/signed-doors-live-2345.test.ts — mupot#2345: key-SIGNED doors apply the same live verdict as the bearer / MCP doors.
// Real SQL (whole migration chain). Every door is driven with a VALID signature, so a refusal can only come from the verdict.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { appErrorHandler } from '../src/app-error'
import { BoundAgentCheckUnavailableError } from '../src/auth/bound-agent-live'
import { loadSignerKey, loadLiveSignerKey } from '../src/fleet/agent-keys'
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
-- Replace 'mumega' with the tenant slug. An empty result = nothing newly refused.
WITH keyed AS (
  SELECT k.agent_id AS keyed_id, k.member_id AS key_member,
         (SELECT COUNT(*) FROM agents a
           WHERE a.id = k.agent_id
              OR (a.slug = k.agent_id AND NOT EXISTS (SELECT 1 FROM agents x WHERE x.id = k.agent_id))) AS n_agents
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
        AND (a.id = kd.keyed_id OR (a.slug = kd.keyed_id AND NOT EXISTS (SELECT 1 FROM agents x WHERE x.id = kd.keyed_id)))
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

  it('a key registered by SLUG resolves to its one agent; an ambiguous slug is refused', async () => {
    h.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-1', 's1', 'slugged', 'S', 'member', 'm', 'active', 'm-owner');
      INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('${TENANT}', 'slugged', 'k', 'Ed25519', 'm-key', 1);`)
    expect((await loadSignerKey(env, 'slugged')).state).toBe('live')
    h.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('s2', 'd1', 's2', 'S2');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES ('uuid-2', 's2', 'slugged', 'S', 'member', 'm', 'active', 'm-owner');`)
    expect((await loadSignerKey(env, 'slugged')).state).toBe('refused')
  })

  it('a failed liveness read is unavailable: HTTP doors throw the retryable error, never a pass or a 401', async () => {
    const down = liveReadThrows()
    expect((await loadSignerKey(down, AGENT)).state).toBe('unavailable')
    await expect(loadLiveSignerKey(down, AGENT)).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    await expect(verifySignedInboxRead(down, await inboxBody())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    await expect(verifyRunnerReceiptSig(down, AGENT, 'n', 't', 'running', await receipt())).rejects.toBeInstanceOf(BoundAgentCheckUnavailableError)
    expect(await authorizeSeatDelivery(down, HOST, SEAT)).not.toBe('granted')
  })

  it('POST /api/inbox/signed answers 503 + Retry-After when the check cannot run, 401 when it refuses', async () => {
    const app = new Hono<{ Bindings: Env }>().route('/api/inbox', inboxApp)
    app.onError(appErrorHandler)
    const post = async (e: Env): Promise<Response> => app.request('/api/inbox/signed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await inboxBody()) }, e)
    const down = await post(liveReadThrows())
    expect(down.status).toBe(503)
    expect(down.headers.get('retry-after')).toBe('2')
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
