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

  it('tells a connecting agent to decide on expects_reply, and how to close a chain', () => {
    // mumega-com#1179, 2026-09-02/03: ACK chains had no stop condition, so an ACK of an ACK
    // triggered a further ACK indefinitely. The instruction that produced the loop said "if it
    // carries request_id, ACK it" — no terminal case. The stop condition is now a server-computed
    // field an automated receive path can read, closed structurally by kind:"ack". A body marker
    // was tried and removed: anything readable out of a body can be reproduced by quoting it.
    const text = MUPOT_MCP_INITIALIZE_INSTRUCTIONS
    expect(text).toContain('expects_reply')
    expect(text).toContain('reply_basis')
    expect(text).toContain('kind:"ack"')
    // an ack must be named as terminal, and the reason the field survives on it must be stated
    expect(text).toMatch(/ack is terminal/i)
    expect(text).toMatch(/idempotency/i)
    // the weak signal must be flagged as weak, or an automated acker will act on a quote
    expect(text).toMatch(/body_token/)
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
