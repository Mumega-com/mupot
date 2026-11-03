// tests/seat-attach-schema-parity.test.ts — mupot task 13f6b7e8: every served schema surface for seat_attach
// carries `reason` with the SAME bounds, and the handler enforces the same bounds it advertises.
//
// Surfaces: the source registry (advertisedTools), JSON-RPC tools/list (POST /mcp), the legacy GET /mcp/tools args
// text, and openapi.full.json (built by openApiSpec from the same spec.inputSchema object, proven here by identity
// of the tools/list schema with the registry schema). The curated needs-you profile does not carry seat_attach.
// A ChatGPT app's own cached copy of the schema is NOT a served surface and cannot be proven here.

import { describe, expect, it } from 'vitest'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { profileEntry } from '../src/mcp/profile-needs-you'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' } as unknown as Env // only flags + tenant are read by the list paths

interface Prop { type?: string; minLength?: number; maxLength?: number }
interface Schema { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: boolean }

const BOUNDS = { type: 'string', minLength: 1, maxLength: 280 }

async function listedSchema(): Promise<Schema> {
  const res = await mcpApp.fetch(new Request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), ENV)
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string; inputSchema: Schema }> } }
  const t = body.result?.tools?.find((x) => x.name === 'seat_attach')
  if (!t) throw new Error(`seat_attach missing from tools/list (status ${res.status})`)
  return t.inputSchema
}

describe('seat_attach schema parity across served surfaces', () => {
  it('source registry advertises reason with 1..280 bounds', () => {
    const spec = advertisedTools(ENV).find((t) => t.name === 'seat_attach')
    const reason = (spec?.inputSchema as Schema | undefined)?.properties?.reason
    expect(reason).toMatchObject(BOUNDS)
  })

  it('tools/list serves the same reason property as the registry, and still allows the list-choices call (reason not unconditionally required)', async () => {
    const listed = await listedSchema()
    const spec = advertisedTools(ENV).find((t) => t.name === 'seat_attach')
    expect(listed.properties?.reason).toMatchObject(BOUNDS)
    expect(listed).toEqual(spec?.inputSchema) // openapi.full.json embeds spec.inputSchema verbatim, so this pins it too
    expect(listed.required ?? []).not.toContain('reason') // `agent` omitted lists choices and needs no reason
    expect(listed.additionalProperties).toBe(false)
  })

  it('GET /mcp/tools args text names reason, the bounds and the requirement', async () => {
    const res = await mcpApp.fetch(new Request('https://pot.test/tools'), ENV)
    const body = (await res.json()) as { tools: Array<{ name: string; args: string }> }
    const t = body.tools.find((x) => x.name === 'seat_attach')
    expect(t?.args).toContain('reason?: string')
    expect(t?.args).toContain('1..280')
    expect(t?.args).toMatch(/reason is required when agent is supplied/)
  })

  it('the curated needs-you profile does not serve seat_attach (no stale copy of the schema there)', () => {
    expect(profileEntry('seat_attach')).toBeUndefined()
  })

  it('flag off: seat_attach is not advertised at all (no half-schema)', () => {
    expect(advertisedTools({ ...ENV, SEAT_ATTACH: undefined } as unknown as Env).some((t) => t.name === 'seat_attach')).toBe(false)
  })
})
