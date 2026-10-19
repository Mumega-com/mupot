// tests/tenant-header-notice.test.ts — #2035 wall 4 / #1299: a client that sends x-mupot-tenant-slug is told when it is
// ignored. The header must NEVER select a tenant (no routing change); this only reports.

import { describe, expect, it } from 'vitest'
import { JSONRPCErrorResponseSchema, JSONRPCResultResponseSchema } from '@modelcontextprotocol/sdk/types.js'
import { hermesClient, newWorld, rpc, type Json, type World, type Client } from './helpers/door-clients'
import { boundTenantHeaderValue, tenantHeaderNotice } from '../src/mcp/tenant-header-notice'

const META = 'mupot/tenant_header_notice'

async function setup(): Promise<{ w: World; c: Client }> {
  const w = newWorld()
  const c = await hermesClient(w)
  w.h.sqlite.exec(`INSERT INTO pots (id, slug, worker_script, status) VALUES ('pot-gaf', 'gaf', 'gaf', 'active'), ('pot-dead', 'dead', 'dead', 'suspended')`)
  return { w, c }
}

async function callWith(w: World, c: Client, tool: string, headers: Record<string, string>) {
  const res = await rpc(w, c, 'tools/call', { name: tool, arguments: {} }, headers)
  const body = (await res.json()) as { result?: { structuredContent?: Json; _meta?: Json } }
  return { res, result: body.result?.structuredContent ?? {}, meta: body.result?._meta }
}

describe('tenant header notice', () => {
  for (const tool of ['status', 'boot_context', 'orient']) {
    it(`mismatch: ${tool} carries the human line, the machine notice and the response header`, async () => {
      const { w, c } = await setup()
      const { res, result, meta } = await callWith(w, c, tool, { 'x-mupot-tenant-slug': 'gaf' })
      const n = result.tenant_header_notice as Json
      expect(n.line).toBe("tenant header 'gaf' ignored; you are in tenant 'mumega'. To reach gaf use https://pot.test/t/gaf/mcp")
      expect(n.known_tenant).toBe(true)
      expect(n.use_instead).toEqual({ apex_path: 'https://pot.test/t/gaf/mcp' })
      expect(JSON.stringify(n)).not.toContain('gaf.pot.test')
      expect(res.headers.get('x-mupot-tenant-header-ignored')).toBe('gaf')
      expect((meta?.[META] as Json).code).toBe('tenant_header_ignored')
    })
  }

  it('every response of the request carries the machine notice, not only the three tools', async () => {
    const { w, c } = await setup()
    const res = await rpc(w, c, 'tools/list', {}, { 'x-mupot-tenant-slug': 'gaf' })
    expect(res.headers.get('x-mupot-tenant-header-ignored')).toBe('gaf')
    const body = (await res.json()) as { result?: { _meta?: Json } }
    expect(body.result?._meta?.[META]).toBeTruthy()
  })

  it('the header never selects the tenant: the session stays in the resolved tenant', async () => {
    const { w, c } = await setup()
    const { result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': 'gaf' })
    expect(result.tenant).toBe('mumega')
  })

  it('equal header: no notice', async () => {
    const { w, c } = await setup()
    const { res, result, meta } = await callWith(w, c, 'boot_context', { 'x-mupot-tenant-slug': 'mumega' })
    expect(result.tenant_header_notice).toBeUndefined()
    expect(res.headers.get('x-mupot-tenant-header-ignored')).toBeNull()
    expect(meta?.[META]).toBeUndefined()
  })

  it('absent header: no notice', async () => {
    const { w, c } = await setup()
    const { res, result } = await callWith(w, c, 'boot_context', {})
    expect(result.tenant_header_notice).toBeUndefined()
    expect(res.headers.get('x-mupot-tenant-header-ignored')).toBeNull()
  })

  it('unknown or inactive slug: says unknown, suggests no URL', async () => {
    const { w, c } = await setup()
    for (const slug of ['nosuch', 'dead', 'admin']) {
      const { result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': slug })
      const n = result.tenant_header_notice as Json
      expect(n.known_tenant).toBe(false)
      expect(n.use_instead).toBeUndefined()
      expect(String(n.line)).toContain(`unknown tenant '${slug}'`)
      expect(String(n.line)).not.toMatch(/https?:|\/t\//)
    }
  })

  it('garbage header is bounded before it reaches text', async () => {
    const { w, c } = await setup()
    const evil = "gaf'}\n<script>alert(1)</script>" + 'x'.repeat(500)
    const { res, result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': evil.replace(/\n/g, ' ') })
    const n = result.tenant_header_notice as Json
    expect(String(n.header_value)).toMatch(/^[a-z0-9-]{1,40}$/)
    expect(String(n.line)).not.toMatch(/[<>{}\n]/)
    expect(String(n.line).length).toBeLessThan(250)
    expect(res.headers.get('x-mupot-tenant-header-ignored')).toMatch(/^[a-z0-9-]{1,40}$/)
  })

  it('pure: bounding and comparison', async () => {
    expect(boundTenantHeaderValue('GAF!!<b>')).toBe('gafb')
    const w = newWorld()
    expect(await tenantHeaderNotice(w.env, new Headers({ 'x-mupot-tenant-slug': 'MUMEGA' }))).toBeNull()
    expect(await tenantHeaderNotice(w.env, new Headers({ 'x-pot-tenant': 'other' }))).not.toBeNull()
    expect(await tenantHeaderNotice(w.env, new Headers({ 'x-mupot-tenant-slug': '   ' }))).toBeNull()
  })

  it('JSON-RPC errors stay valid against the SDK strict schema; the notice rides only in error.data', async () => {
    const { w, c } = await setup()
    const hdr = { 'x-mupot-tenant-slug': 'gaf' }
    const bodies: Json[] = []
    bodies.push((await (await rpc(w, c, 'tools/call', { name: 'no_such_tool', arguments: {} }, hdr)).json()) as Json)
    bodies.push((await (await rpc(w, c, 'tools/call', { name: 'status', arguments: { bogus: 1 } }, hdr)).json()) as Json)
    bodies.push((await (await rpc(w, c, 'no/such_method', {}, hdr)).json()) as Json)
    let errors = 0
    for (const b of bodies) {
      if (!b.error) continue
      errors++
      expect(JSONRPCErrorResponseSchema.safeParse(b).success, JSON.stringify(b)).toBe(true)
      expect('tenant_header_notice' in b).toBe(false)
    }
    expect(errors, JSON.stringify(bodies)).toBeGreaterThan(0)
    // String details are left byte-identical (the response header carries the notice); the merge path is pinned below.
    expect((bodies[0].error as Json).data).toBe('no_such_tool')
  })

  it('error data merge keeps the existing detail', async () => {
    const { stampErrorNoticeForTest } = await import('../src/mcp/index')
    const n = await tenantHeaderNotice(newWorld().env, new Headers({ 'x-mupot-tenant-slug': 'zzz' }))
    const out = stampErrorNoticeForTest({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'm', data: { keep: 1 } } }, n!)
    expect(((out.error as Json).data as Json).keep).toBe(1)
    expect(((out.error as Json).data as Json).tenant_header_notice).toBeTruthy()
    expect(JSONRPCErrorResponseSchema.safeParse(out).success).toBe(true)
  })

  it('a success result with the notice still validates', async () => {
    const { w, c } = await setup()
    const b = (await (await rpc(w, c, 'tools/call', { name: 'status', arguments: {} }, { 'x-mupot-tenant-slug': 'gaf' })).json()) as Json
    expect(JSONRPCResultResponseSchema.safeParse(b).success, JSON.stringify(b)).toBe(true)
  })

  it('a value that only equals the tenant after bounding is not the tenant (no URL even if a pot row exists)', async () => {
    const { w, c } = await setup()
    w.h.sqlite.exec(`INSERT INTO pots (id, slug, worker_script, status) VALUES ('pot-m', 'mumega', 'mumega', 'active')`)
    const { result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': 'mumega!!' })
    const n = result.tenant_header_notice as Json
    expect(n.known_tenant).toBe(false)
    expect(n.use_instead).toBeUndefined()
  })

  it('a reserved slug is unknown even with an active pot row', async () => {
    const { w, c } = await setup()
    w.h.sqlite.exec(`INSERT INTO pots (id, slug, worker_script, status) VALUES ('pot-a', 'admin', 'admin', 'active')`)
    const { result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': 'admin' })
    expect((result.tenant_header_notice as Json).known_tenant).toBe(false)
  })

  it('a value sanitizing altered is unknown: no lookup of the sanitized form, no URL', async () => {
    const { w, c } = await setup()
    for (const v of ['GAF!!', 'ga<f>', 'gaf' + 'x'.repeat(60), 'g af']) {
      const { result } = await callWith(w, c, 'status', { 'x-mupot-tenant-slug': v })
      const n = result.tenant_header_notice as Json
      expect(n.known_tenant, v).toBe(false)
      expect(n.use_instead).toBeUndefined()
      expect(String(n.line)).not.toMatch(/https?:/)
    }
  })
})
