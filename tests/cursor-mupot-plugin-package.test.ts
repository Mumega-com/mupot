import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = join(repoRoot, 'integrations', 'cursor-mupot-plugin')
const marketplacePath = join(repoRoot, '.cursor-plugin', 'marketplace.json')

const REQUIRED_SKILLS = [
  'mupot-check-in',
  'mupot-inbox',
  'mupot-letter-harness-doorbell',
  'mupot-draft-not-send',
] as const

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function collectPlaceholders(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) into.add(match[1])
    return into
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, into)
    return into
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPlaceholders(item, into)
  }
  return into
}

describe('cursor-mupot-plugin package', () => {
  const manifest = readJson(join(pluginRoot, '.cursor-plugin', 'plugin.json')) as {
    name: string
    displayName?: string
    version: string
    description: string
    author: { name: string }
    keywords: string[]
    logo: string
    mcpServers: string
    variables: {
      type: string
      required?: string[]
      properties: Record<string, { type?: string; default?: unknown }>
    }
  }
  const mcp = readJson(join(pluginRoot, 'mcp.json')) as {
    mcpServers: Record<string, { url?: string; command?: string; headers?: Record<string, string> }>
  }
  const marketplace = readJson(marketplacePath) as {
    plugins: Array<{ name: string; source: string }>
  }

  it('is a self-contained Cursor plugin tree', () => {
    expect(existsSync(join(pluginRoot, '.cursor-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(pluginRoot, 'mcp.json'))).toBe(true)
    expect(existsSync(join(pluginRoot, 'README.md'))).toBe(true)
    expect(existsSync(join(pluginRoot, 'assets', 'logo.svg'))).toBe(true)
    for (const skill of REQUIRED_SKILLS) {
      expect(existsSync(join(pluginRoot, 'skills', skill, 'SKILL.md'))).toBe(true)
    }
    expect(readdirSync(join(pluginRoot, 'skills')).sort()).toEqual([...REQUIRED_SKILLS].sort())
  })

  it('declares the Cursor plugin manifest Cursor and this brief asked for', () => {
    expect(manifest.name).toBe('mupot')
    expect(manifest.displayName).toMatch(/Mumega pot MCP/i)
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.author.name).toBe('Mumega')
    expect(manifest.keywords).toEqual(
      expect.arrayContaining(['mupot', 'mumega', 'mcp', 'grok-bot', 'agents']),
    )
    expect(manifest.description.toLowerCase()).toContain('not a chatbot host')
    expect(manifest.logo).toBe('assets/logo.svg')
    expect(manifest.mcpServers).toBe('./mcp.json')
    expect(manifest.variables.type).toBe('object')
    expect(manifest.variables.required).toEqual(['MUPOT_TOKEN'])
    expect(Object.keys(manifest.variables.properties).sort()).toEqual([
      'MUPOT_SEAT_LABEL',
      'MUPOT_SEAT_QUERY',
      'MUPOT_TOKEN',
    ])
    expect(manifest.variables.properties.MUPOT_TOKEN.type).toBe('string')
    expect(manifest.variables.properties.MUPOT_SEAT_LABEL.default).toBe('')
    expect(manifest.variables.properties.MUPOT_SEAT_QUERY.default).toBe('')
  })

  it('ships remote HTTP MCP only, with Cursor ${VAR} placeholders and no secrets', () => {
    const server = mcp.mcpServers.mupot
    expect(server).toBeDefined()
    expect(server.command).toBeUndefined()
    expect(server.url).toBe('https://mupot.mumega.com/mcp?seat=${MUPOT_SEAT_QUERY}')
    expect(server.headers?.Authorization).toBe('Bearer ${MUPOT_TOKEN}')
    expect(server.headers?.['x-mupot-seat']).toBe('${MUPOT_SEAT_LABEL}')

    const placeholders = collectPlaceholders(mcp)
    expect([...placeholders].sort()).toEqual([
      'MUPOT_SEAT_LABEL',
      'MUPOT_SEAT_QUERY',
      'MUPOT_TOKEN',
    ])
    for (const name of placeholders) {
      expect(manifest.variables.properties[name]).toBeDefined()
    }

    const treeText = [
      readFileSync(join(pluginRoot, '.cursor-plugin', 'plugin.json'), 'utf8'),
      readFileSync(join(pluginRoot, 'mcp.json'), 'utf8'),
      readFileSync(join(pluginRoot, 'README.md'), 'utf8'),
      ...REQUIRED_SKILLS.map((skill) =>
        readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8'),
      ),
    ].join('\n')
    expect(treeText).not.toMatch(/mupot_[A-Za-z0-9]{16,}/)
    expect(treeText).not.toMatch(/Bearer mupot_[A-Za-z0-9]{8,}/)
  })

  it('keeps skills generic and frontmatter-valid', () => {
    for (const skill of REQUIRED_SKILLS) {
      const body = readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8')
      expect(body.startsWith('---\n')).toBe(true)
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\n`, 'm'))
      expect(body).toMatch(/^description:/m)
    }
    const checkIn = readFileSync(join(pluginRoot, 'skills', 'mupot-check-in', 'SKILL.md'), 'utf8')
    expect(checkIn).toContain('bootstrap_self')
    expect(checkIn).toContain('cursor-ide')
    expect(checkIn).toContain('cursor-cloud')
    const inbox = readFileSync(join(pluginRoot, 'skills', 'mupot-inbox', 'SKILL.md'), 'utf8')
    expect(inbox).toContain('seat_mismatch')
    expect(inbox).toContain('bearer_only')
    const doorbell = readFileSync(
      join(pluginRoot, 'skills', 'mupot-letter-harness-doorbell', 'SKILL.md'),
      'utf8',
    )
    expect(doorbell.toLowerCase()).toContain('no retrieve')
    const draft = readFileSync(join(pluginRoot, 'skills', 'mupot-draft-not-send', 'SKILL.md'), 'utf8')
    expect(draft.toLowerCase()).toMatch(/customer pot/)
  })

  it('is listed from the repo-root marketplace manifest for nested discovery', () => {
    const entry = marketplace.plugins.find((plugin) => plugin.source === 'integrations/cursor-mupot-plugin')
    expect(entry?.name).toBe('mupot')
  })

  it('logo is a local SVG mark, not a remote asset', () => {
    const svg = readFileSync(join(pluginRoot, 'assets', 'logo.svg'), 'utf8')
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('mupot')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).not.toMatch(/https:\/\//)
  })
})
