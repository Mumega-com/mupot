// tests/tenant-header-notice.test.ts — #2035 wall 4 / #1299: a client that sends x-mupot-tenant-slug is told when it is
// ignored. The header must NEVER select a tenant (no routing change); this only reports.

import { describe, expect, it } from 'vitest'
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
      expect(n.line).toBe("tenant header 'gaf' ignored; you are in tenant 'mumega'. To reach gaf use https://gaf.pot.test/mcp or /t/gaf/mcp")
      expect(n.known_tenant).toBe(true)
      expect(n.use_instead).toEqual({ tenant_host: 'https://gaf.pot.test/mcp', apex_path: 'https://pot.test/t/gaf/mcp' })
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
})
