import { describe, expect, it } from 'vitest'
import {
  mcpEndpoint,
  canonicalOrigin,
  claudeCodeSnippet,
  codexSnippet,
  mcpServerKey,
  wakeContractForAgent,
} from '../src/dashboard/connect'

describe('canonicalOrigin', () => {
  it('prefers the env-pinned PUBLIC_ORIGIN over the request origin', () => {
    expect(canonicalOrigin({ PUBLIC_ORIGIN: 'https://agents.digid.ca' }, 'https://evil.example')).toBe(
      'https://agents.digid.ca',
    )
  })
  it('falls back to the request origin when PUBLIC_ORIGIN is unset', () => {
    expect(canonicalOrigin({}, 'https://pot.example.com')).toBe('https://pot.example.com')
  })
  it('falls back (never throws) when PUBLIC_ORIGIN is malformed', () => {
    expect(canonicalOrigin({ PUBLIC_ORIGIN: 'not a url' }, 'https://pot.example.com')).toBe(
      'https://pot.example.com',
    )
  })
})

describe('mcpEndpoint', () => {
  it('appends /mcp to the origin', () => {
    expect(mcpEndpoint('https://pot.example.com')).toBe('https://pot.example.com/mcp')
  })

  it('does not double-slash when the origin has a trailing slash', () => {
    expect(mcpEndpoint('https://pot.example.com/')).toBe('https://pot.example.com/mcp')
  })
})

describe('mcpServerKey', () => {
  it('keeps a clean slug', () => {
    expect(mcpServerKey('acme')).toBe('acme')
  })

  it('sanitizes non-alphanumerics and falls back when empty', () => {
    expect(mcpServerKey('Acme Ops!')).toBe('acme-ops')
    expect(mcpServerKey('___')).toBe('mupot')
  })
})

describe('claudeCodeSnippet', () => {
  it('produces valid JSON with streamable-http transport and a placeholder token (never a real one)', () => {
    const snippet = claudeCodeSnippet('acme', 'https://pot.example.com')
    const parsed = JSON.parse(snippet) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    const server = parsed.mcpServers.acme
    // MUST be 'http' — the pot is POST/streamable-http; 'sse' does a GET that 302s to login.
    expect(server.type).toBe('http')
    expect(server.url).toBe('https://pot.example.com/mcp')
    expect(server.headers.Authorization).toBe('Bearer <MEMBER_TOKEN>')
    // Defense-in-depth: no `mupot_`-prefixed real token ever leaks into a snippet.
    expect(snippet).not.toContain('mupot_')
  })
})

describe('codexSnippet', () => {
  it('emits the [mcp_servers.<slug>] block with an env-var bearer (no transport=sse, no inline token)', () => {
    const snippet = codexSnippet('acme', 'https://pot.example.com')
    expect(snippet).toContain('[mcp_servers.acme]')
    expect(snippet).toContain('url = "https://pot.example.com/mcp"')
    expect(snippet).toContain('bearer_token_env_var = "ACME_MCP_TOKEN"')
    expect(snippet).not.toContain('transport = "sse"') // Codex uses streamable-http
    expect(snippet).not.toContain('mupot_')
  })
})

describe('wakeContractForAgent', () => {
  const contract = wakeContractForAgent('agent-1', 'squad-1', 'digid', 'https://agents.digid.ca')

  it('emit_url is <origin>/bus/emit (not /mcp — the bus endpoint, not the MCP endpoint)', () => {
    expect(contract.emit_url).toBe('https://agents.digid.ca/bus/emit')
  })

  it('strips a trailing slash from the origin before joining', () => {
    const c = wakeContractForAgent('a', 's', 't', 'https://agents.digid.ca/')
    expect(c.emit_url).toBe('https://agents.digid.ca/bus/emit')
  })

  it('auth_header is the literal string "Authorization" (never a header value)', () => {
    expect(contract.auth_header).toBe('Authorization')
  })

  it('body_shape.type is exactly "agent.wake" — matching the BusEventType', () => {
    expect(contract.body_shape.type).toBe('agent.wake')
  })

  it('body_shape pre-fills agent_id, squad_id, tenant from the provided args', () => {
    expect(contract.body_shape.agent_id).toBe('agent-1')
    expect(contract.body_shape.squad_id).toBe('squad-1')
    expect(contract.body_shape.tenant).toBe('digid')
  })

  it('note is a non-empty string with the S175 cross-tenant caveat', () => {
    expect(typeof contract.note).toBe('string')
    expect(contract.note.length).toBeGreaterThan(0)
    expect(contract.note).toContain('S175')
  })
})
