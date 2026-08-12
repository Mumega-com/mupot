// tests/checkin-attach-model.test.ts — harness-native-mupot lane A (mupot side):
// runtime='pi' + runtime-reported model on /api/fleet/attach.
import { describe, it, expect } from 'vitest'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import type { Env } from '../src/types'

interface TokenRow { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}
const tokMap = async () => ({ [await sha256('tok-loom')]: TOK })

function makeDb(tokens: Record<string, TokenRow> = {}, memberStatuses: Record<string, string> = {}) {
  const fleet = new Map<string, Record<string, unknown>>()
  const agents = new Map<string, Record<string, unknown>>()
  function first(sql: string, b: unknown[]) {
    if (sql.includes('FROM agent_keys WHERE tenant')) return null           // no signed keys registered
    if (sql.includes('FROM member_tokens t')) {
      const tok = tokens[b[0] as string]
      if (!tok || memberStatuses[tok.member_id] === 'inactive') return null
      return tok
    }
    if (sql.includes('FROM members WHERE id')) return null
    return null
  }
  function all(sql: string) {
    if (sql.includes('LEFT JOIN members m ON m.id')) {
      return [...fleet.values()].map((r) => ({
        agent_id: r.agent_id, agent_type: r.agent_type, runtime: r.runtime, status: r.status,
        lifecycle: r.lifecycle, last_reported_at: r.last_reported_at, member_id: r.member_id,
        host: r.host, model: r.model ?? null,
      }))
    }
    return []
  }
  function run(sql: string, bs: unknown[]) {
    if (sql.includes('INSERT INTO fleet_agents')) {
      fleet.set(`${bs[0]}`, { agent_id: bs[0], tenant: bs[1], runtime: bs[2], lifecycle: bs[3], agent_type: bs[5], member_id: bs[6], host: bs[7], model: bs[8] ?? null, status: 'running' })
    } else if (sql.includes('UPDATE agents')) {
      agents.set(bs[1] as string, { model: bs[0] })
    }
  }
  return {
    fleet, agents,
    prepare(sql: string) {
      const bs: unknown[] = []
      const self: any = {
        bind: (...args: unknown[]) => { bs.push(...args); return self },
        async run() { run(sql, bs); return { meta: { changes: 1 }, results: [] } },
        async first<T>() { return first(sql, bs) as T },
        async all<T>() { return { results: all(sql) as T[] } },
      }
      return self
    },
  }
}
const makeEnv = (db: ReturnType<typeof makeDb>): Env => ({ TENANT_SLUG: 'saas-test', DB: db as any } as unknown as Env)
const post = async (env: Env, body: unknown, token: string) => {
  const r = await fleetAttachApp.request('/attach', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
  return r
}

const TOK = { member_id: 'm1', display_name: 'Loom', email: null, status: 'active', bound_agent_id: 'loom' }

describe('lane A: runtime=pi + model on /attach', () => {
  it('accepts runtime pi + valid model, stores on fleet_agents AND agents', async () => {
    const db = makeDb(await tokMap())
    const env = makeEnv(db)
    const res = await post(env, { agent_id: 'loom', runtime: 'pi', type: 'weaver', host: 'muvps1', model: 'hetzner/Kimi-K2.7-Code' }, 'tok-loom')
    expect(res.status).toBe(200)
    const row = [...db.fleet.values()][0]
    expect(row.runtime).toBe('pi')
    expect(row.model).toBe('hetzner/Kimi-K2.7-Code')
    expect([...db.agents.values()][0].model).toBe('hetzner/Kimi-K2.7-Code')
  })
  it('rejects an invalid model (bad chars)', async () => {
    const db = makeDb(await tokMap())
    const res = await post(makeEnv(db), { agent_id: 'loom', runtime: 'pi', type: 'weaver', model: 'bad model \" quote' }, 'tok-loom')
    expect(res.status).toBe(400)
  })
  it('enforces token-bound identity (BLOCK-1): loom token cannot attach river', async () => {
    const db = makeDb(await tokMap())
    const res = await post(makeEnv(db), { agent_id: 'river', runtime: 'pi', type: 'reviewer' }, 'tok-loom')
    expect(res.status).toBe(403)
  })
  it('accepts runtime pi with no model (optional)', async () => {
    const db = makeDb(await tokMap())
    const res = await post(makeEnv(db), { agent_id: 'loom', runtime: 'pi', type: 'weaver' }, 'tok-loom')
    expect(res.status).toBe(200)
  })
})