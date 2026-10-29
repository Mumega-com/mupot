import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fleetAttachApp } from '../src/fleet/attach-routes'
import { canonicalAttachMessage } from '../src/fleet/signed-attach'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

// Independent protocol encoder: omission must remain byte-identical to the v1 message.
function message(body: Record<string, unknown>) {
  const fields = ['fleet-attach:v1', 'model-test', body.agent_id, body.type, body.runtime,
    body.lifecycle, String(body.ts), body.nonce]
  if (body.model !== undefined) fields.push('model', JSON.stringify(body.model))
  return new TextEncoder().encode(fields.join('\n'))
}

describe('signed attach model (real migration chain)', () => {
  let h: ReturnType<typeof createSqliteD1>
  let env: Env
  let key: CryptoKey

  beforeEach(async () => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    key = pair.privateKey
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d-model', 'd-model', 'Model');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('s-model', 'd-model', 's-model', 'Model');
      INSERT INTO agents (id, squad_id, slug, name, model, status)
        VALUES ('agent-model-uuid', 's-model', 'model-runner', 'Model runner', 'identity-old', 'active');
      INSERT INTO members (id, display_name, tenant, status) VALUES ('m-model', 'Model member', 'model-test', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('model-test', 'agent-model-uuid', 'm-model', datetime('now'));
    `)
    h.sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
      VALUES (?, ?, ?, 'Ed25519', ?, ?)`).run('model-test', 'model-runner', jwk.x!, 'm-model', Math.floor(Date.now() / 1000))
    env = { DB: h.db, TENANT_SLUG: 'model-test' } as unknown as Env
  })
  afterEach(() => h.close())

  async function signed(model?: unknown) {
    const body: Record<string, unknown> = {
      agent_id: 'model-runner', type: 'builder', runtime: 'claude-code', lifecycle: 'on_demand',
      ts: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
      ...(model !== undefined ? { model } : {}),
    }
    body.sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, message(body))).toString('base64url')
    return body
  }
  const post = (body: Record<string, unknown>) => fleetAttachApp.request('/attach-signed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env)
  const row = () => h.sqlite.prepare(`SELECT model, reported_by, member_id FROM fleet_agents
    WHERE tenant = 'model-test' AND agent_id = 'agent-model-uuid'`).get()
  const identityModel = () => h.sqlite.prepare(`SELECT model FROM agents WHERE id = 'agent-model-uuid'`).get()?.model

  it('writes model under the canonical agent id with key-derived reporter and signed receipt', async () => {
    const body = await signed('claude-opus-4-6')
    body.reported_by = 'forged'
    body.member_id = 'forged'
    body.signed = false
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(row()).toMatchObject({ model: 'claude-opus-4-6', reported_by: 'm-model', member_id: 'm-model' })
    expect(identityModel()).toBe('claude-opus-4-6')
    expect(await res.json()).toMatchObject({ report: { model: 'claude-opus-4-6', reported_by: 'm-model', signed: true } })
  })

  it.each(['changed', 'added', 'removed', 'same-cleaned'])('refuses %s model before writing or burning the nonce', async (kind) => {
    const body = await signed(kind === 'added' ? undefined : 'model-a')
    const original = { ...body }
    if (kind === 'removed') delete body.model
    else body.model = kind === 'same-cleaned' ? 'model-a\u0000' : 'model-b'
    expect((await post(body)).status).toBe(401)
    expect(row()).toBeUndefined()
    expect(identityModel()).toBe('identity-old')
    expect((await post(original)).status).toBe(200)
  })

  it('accepts legacy bytes and preserves model when an old client omits it', async () => {
    expect((await post(await signed('model-existing'))).status).toBe(200)
    const legacy = await signed()
    expect(new TextDecoder().decode(canonicalAttachMessage({
      tenant: 'model-test', agent_id: 'model-runner', type: 'builder', runtime: 'claude-code',
      lifecycle: 'on_demand', ts: legacy.ts as number, nonce: legacy.nonce as string,
    }))).toBe(new TextDecoder().decode(message(legacy)))
    expect((await post(legacy)).status).toBe(200)
    expect(row()?.model).toBe('model-existing')
    expect(identityModel()).toBe('model-existing')
  })

  it('an initial legacy attach leaves the model unknown; a later report updates an existing row', async () => {
    expect((await post(await signed())).status).toBe(200)
    expect(row()?.model).toBeNull()
    expect((await post(await signed('a'.repeat(128)))).status).toBe(200)
    expect(row()?.model).toBe('a'.repeat(128))
    expect((await post(await signed('model-new'))).status).toBe(200)
    expect(row()?.model).toBe('model-new')
  })

  it.each(['', ' \u0000\u200b '])('treats cleaned-empty model %j as unreported and preserves the prior value', async (value) => {
    expect((await post(await signed('model-existing'))).status).toBe(200)
    expect((await post(await signed(value))).status).toBe(200)
    expect(row()?.model).toBe('model-existing')
  })

  it('cleans controls and truncates overlong values only AFTER verifying the raw signed bytes', async () => {
    const body = await signed(' \u0000\u200b' + 'a'.repeat(127) + '😀tail\n')
    expect((await post(body)).status).toBe(200)
    expect(row()?.model).toBe('a'.repeat(127)) // no half surrogate at 128
  })

  it('keeps display-only model strings out of the strict identity model field', async () => {
    expect((await post(await signed('my model "preview"'))).status).toBe(200)
    expect(row()?.model).toBe('my model "preview"')
    expect(identityModel()).toBe('identity-old')
  })

  it.each([null, 42, {}, []].map(value => ({ value })))('refuses a non-string model $value', async ({ value }) => {
    expect((await post(await signed(value))).status).toBe(400)
    expect(row()).toBeUndefined()
  })

  it('still refuses replay when a verified signed payload contains model', async () => {
    const body = await signed('model-once')
    expect((await post(body)).status).toBe(200)
    expect((await post(body)).status).toBe(409)
    body.model = 'different-model'
    body.sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, message(body))).toString('base64url')
    expect((await post(body)).status).toBe(409)
    expect(row()?.model).toBe('model-once')
  })

  it('bounds the raw model by the existing request body cap', async () => {
    expect((await post(await signed('x'.repeat(8192)))).status).toBe(413)
    expect(row()).toBeUndefined()
  })
})
