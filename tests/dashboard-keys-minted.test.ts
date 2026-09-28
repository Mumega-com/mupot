import { describe, expect, it } from 'vitest'
import { keysMintedBody } from '../src/dashboard/keys'
import { agentTokenMintedBody } from '../src/dashboard/agent-token'

describe('keysMintedBody MCP wiring card', () => {
  it('shows copyable MCP address and client snippets without embedding the raw key', () => {
    const raw = 'mupot_test_raw_token_never_in_snippet'
    const html = String(
      keysMintedBody('Ada', 'ops-key', 'Team member', raw, 'mumega', 'https://mupot.mumega.com'),
    )
    expect(html).toContain('https://mupot.mumega.com/mcp')
    expect(html).toContain('id="mcpEndpoint"')
    expect(html).toContain('Copy address')
    expect(html).toContain('Hermes')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Codex')
    expect(html).toContain('Bearer ${MUMEGA_MCP_TOKEN}')
    expect(html).toContain('id="rawToken"')
    expect(html).toContain(raw)
    // Snippet bodies must not re-embed the raw secret (token appears only in the reveal code block).
    const withoutReveal = html.replace(raw, '')
    expect(withoutReveal).not.toContain('mupot_test_raw_token_never_in_snippet')
  })
})

describe('agentTokenMintedBody MCP wiring card', () => {
  it('shows MCP endpoint and Hermes/Claude/Codex snippets', () => {
    const html = String(
      agentTokenMintedBody(
        'Hermes Runtime',
        'agent-hermes',
        'Core Platform',
        'mupot_agent_raw',
        'tok-1',
        'member',
        'mumega',
        'https://mupot.mumega.com',
      ),
    )
    expect(html).toContain('https://mupot.mumega.com/mcp')
    expect(html).toContain('Hermes')
    expect(html).toContain('transport <code class="inline">http</code>')
    expect(html).not.toMatch(/Bearer mupot_agent_raw/)
  })
})
