// tests/mcp-instructions.test.ts — Unit and mutation tests for MCP initialize onboarding instructions

import { describe, expect, it } from 'vitest'
import { SEVEN_AXIS_HARNESSES } from '../src/fleet/presence'
import { MUPOT_MCP_INITIALIZE_INSTRUCTIONS } from '../src/mcp/instructions'
import { TOOLS } from '../src/mcp/index'

function extractQuotedHarnesses(text: string, pattern: RegExp, surface: string): string[] {
  const match = text.match(pattern)
  if (!match) throw new Error(`could not extract check_in harnesses from ${surface}`)
  return match[1].split('|').map((value) => JSON.parse(value.trim()) as string)
}

describe('MUPOT_MCP_INITIALIZE_INSTRUCTIONS', () => {
  it('is a non-empty string with substantive onboarding guidance', () => {
    expect(typeof MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toBe('string')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS.length).toBeGreaterThan(500)
  })

  it('instructs agent to call boot_context or orient as first action', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('boot_context')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('orient')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/FIRST ACTION/i)
  })

  it('truthfully documents zero-capability B1 ceiling for unbound directory sessions', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('B1 security ceiling')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/ZERO elevated capabilities/i)
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/NOT a server failure.*firewall block/i)
  })

  it('documents new agent onboarding via bootstrap_self', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('bootstrap_self')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('agent_name')
  })

  it('documents existing agent connector reconnection and consent screen selection', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('grant_agent_capability')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('RECONNECT THE MCP CONNECTOR')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('consent screen')
  })

  it('distinguishes minted agent-bound bearer tokens from interactive connector sessions', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('mint_agent_token')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('mupot_')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/headless/i)
  })

  it('provides an error decoding guide covering 403, 401, 400, and 429', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('403 forbidden need=<cap>')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain("Client Error 'mcp_request_blocked'")
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('401 unauthenticated / dead credential')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('400 invalid_args')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('429 rate_limited')
  })

  it('documents the Synthetic Council bus request/response ACK protocol', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('[request_id:<uuid>]')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('{ack_for: <uuid>, ok: true}')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('30s')
  })

  it('documents that an ACK is terminal — an ack reply never itself needs acknowledging', () => {
    // mumega.com#1179 discussion, 2026-09-02/03: ACK chains had no stop condition, so an ACK
    // of an ACK triggered a further ACK indefinitely. The stop condition is structural (send
    // refuses request_id on kind:"ack" — see ack_cannot_request_ack in src/agents/messages.ts),
    // not prose in a message body a receive path would have to parse. This instruction tells a
    // connecting agent the RULE so it never manufactures the case the server already forbids
    // (e.g. by hand-composing a bus envelope outside the `send` tool).
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/ack.{0,40}never.{0,20}(itself )?(require|need|carr(y|ies))s? (a |an )?(further |another )?ack/i)
  })

  it('instructs connecting clients to declare 7-axis identity on turn 1 via check_in', () => {
    const toolCheckIn = TOOLS.find((tool) => tool.name === 'check_in')

    expect(toolCheckIn).toBeDefined()
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('7-AXIS SEAT DECLARATION')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('check_in')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('harness')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('cursor-cloud')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('extended-thinking-64k')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('flight_id')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('"codex-cli"')
    expect(toolCheckIn?.inputSchema.properties.harness).toMatchObject({
      enum: expect.arrayContaining(['codex-cli']),
    })
  })

  it('keeps every check_in harness surface exactly aligned with the canonical enum', () => {
    const toolCheckIn = TOOLS.find((tool) => tool.name === 'check_in')
    if (!toolCheckIn) throw new Error('check_in tool is missing from the public catalog')

    const schemaHarnesses = (toolCheckIn.inputSchema.properties.harness as { enum: string[] }).enum
    const catalogHarnesses = extractQuotedHarnesses(
      toolCheckIn.args,
      /harness\?:\s*((?:"[^"]+"\|?)+), machine\?:/,
      'public check_in catalog args',
    )
    const instructionHarnesses = extractQuotedHarnesses(
      MUPOT_MCP_INITIALIZE_INSTRUCTIONS,
      /harness:\s+"<harness>",\s+\/\/\s+(.+)\n/,
      'static initialize instructions',
    )

    expect(schemaHarnesses).toEqual(SEVEN_AXIS_HARNESSES)
    expect(catalogHarnesses).toEqual(SEVEN_AXIS_HARNESSES)
    expect(instructionHarnesses).toEqual(SEVEN_AXIS_HARNESSES)
  })
})
