// tests/checkin-attach-model.test.ts — harness-native-mupot lane A (pot side):
// runtime='pi' + runtime-reported model on /api/fleet/attach. Runs against the REAL
// sqlite D1 harness + the full migration chain (incl. 0097) — no mock debt.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import type { Env } from '../src/types'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('lane A: runtime=pi + model on /attach (real D1)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const h = await sha256('tok-loom')
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept1', 'fleet', 'Fleet', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-core', 'dept1', 'squad-core', 'Core', datetime('now'));
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('m1', 'saas-test', 'Loom', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('a-loom', 'squad-core', 'loom', 'Loom', 'weaver', 'old-model', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('saas-test', 'a-loom', 'm1', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('t1', 'm1', 'saas-test', '${h}', 'a-loom', 'test', 'workspace', datetime('now'));
    `)
    env = { TENANT_SLUG: 'saas-test', DB: harness.db } as unknown as Env
  })
  afterAll(() => { harness.close() })

  it('accepts runtime pi + valid model, stores on fleet_agents AND agents (by id)', async () => {
    const res = await fleetAttachApp.request('/attach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-loom', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'a-loom', runtime: 'pi', type: 'weaver', host: 'muvps1', model: 'hetzner/Kimi-K2.7-Code' }),
    }, env)
    expect(res.status).toBe(200)
    const fleet = harness.sqlite.prepare(`SELECT model FROM fleet_agents WHERE agent_id = 'a-loom'`).get() as any
    expect(fleet.model).toBe('hetzner/Kimi-K2.7-Code')
    const ag = harness.sqlite.prepare(`SELECT model FROM agents WHERE id = 'a-loom'`).get() as any
    expect(ag.model).toBe('hetzner/Kimi-K2.7-Code')
  })

  it('rejects an invalid model (bad chars)', async () => {
    const res = await fleetAttachApp.request('/attach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-loom', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'a-loom', runtime: 'pi', type: 'weaver', model: 'bad model " quote' }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('enforces token-bound identity (BLOCK-1): loom token cannot attach river', async () => {
    const res = await fleetAttachApp.request('/attach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-loom', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'river', runtime: 'pi', type: 'reviewer' }),
    }, env)
    expect(res.status).toBe(403)
  })

  it('accepts runtime grok-cli (shared vocabulary with check_in)', async () => {
    const res = await fleetAttachApp.request('/attach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-loom', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'a-loom', runtime: 'grok-cli', type: 'weaver' }),
    }, env)
    expect(res.status).toBe(200)
    const fleet = harness.sqlite.prepare(`SELECT runtime FROM fleet_agents WHERE agent_id = 'a-loom'`).get() as { runtime: string }
    expect(fleet.runtime).toBe('grok-cli')
  })

  it('accepts runtime pi with no model (optional)', async () => {
    const res = await fleetAttachApp.request('/attach', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-loom', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'a-loom', runtime: 'pi', type: 'weaver' }),
    }, env)
    expect(res.status).toBe(200)
  })
})
