// tests/mcp-instructions.test.ts — Unit and mutation tests for MCP initialize onboarding instructions

import { describe, expect, it } from 'vitest'
import { MUPOT_MCP_INITIALIZE_INSTRUCTIONS } from '../src/mcp/instructions'

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
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/reconnect.*select/i)
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/current.*session.*unbound/i)
  })

  it('documents existing agent connector reconnection and consent screen selection', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/existing agent/i)
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

  it('instructs connecting clients to declare 7-axis identity on turn 1 via check_in', () => {
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('7-AXIS SEAT DECLARATION')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('check_in')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('harness')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('cursor-cloud')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('extended-thinking-64k')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('flight_id')
  })
})
