import { describe, expect, it } from 'vitest'
import {
  mcpEndpoint,
  claudeCodeSnippet,
  codexSnippet,
  mcpServerKey,
} from '../src/dashboard/connect'

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
  it('produces valid JSON with the SSE transport and a placeholder token (never a real one)', () => {
    const snippet = claudeCodeSnippet('acme', 'https://pot.example.com')
    const parsed = JSON.parse(snippet) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    const server = parsed.mcpServers.acme
    expect(server.type).toBe('sse')
    expect(server.url).toBe('https://pot.example.com/mcp')
    expect(server.headers.Authorization).toBe('Bearer <MEMBER_TOKEN>')
    // Defense-in-depth: no `mupot_`-prefixed real token ever leaks into a snippet.
    expect(snippet).not.toContain('mupot_')
  })
})

describe('codexSnippet', () => {
  it('emits the [mcp_servers.<slug>] block with a placeholder token', () => {
    const snippet = codexSnippet('acme', 'https://pot.example.com')
    expect(snippet).toContain('[mcp_servers.acme]')
    expect(snippet).toContain('url = "https://pot.example.com/mcp"')
    expect(snippet).toContain('Authorization = "Bearer <MEMBER_TOKEN>"')
    expect(snippet).not.toContain('mupot_')
  })
})
