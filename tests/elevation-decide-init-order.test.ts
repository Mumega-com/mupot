// S13 (Codex P1-C1): src/mcp/elevation-decide.ts must be importable FIRST, in isolation, with its
// input schema defined at module init. It once imported HUMAN_ORIGIN_SCHEMA at runtime from
// src/mcp/index.ts, which imports ELEVATION_DECIDE_TOOLS back: in an esbuild bundle the cycle can
// initialise this module before index.ts and read `undefined`. The schema now lives in a leaf module.
import { describe, expect, it } from 'vitest'

describe('elevation-decide module init order', () => {
  it('importing elevation-decide first yields a tool whose human_origin schema is defined', async () => {
    const mod = await import('../src/mcp/elevation-decide')
    const [tool] = mod.ELEVATION_DECIDE_TOOLS
    const props = (tool.inputSchema as { properties: Record<string, { type?: string; required?: string[] }> }).properties
    expect(props.human_origin).toBeDefined()
    expect(props.human_origin.type).toBe('object')
    expect(props.human_origin.required).toContain('message_at')
  })

  it('the leaf schema module is shared with index.ts (same object)', async () => {
    const leaf = await import('../src/im/origin-schema')
    const idx = await import('../src/mcp')
    expect(idx.HUMAN_ORIGIN_SCHEMA).toBe(leaf.HUMAN_ORIGIN_SCHEMA)
  })

  it('elevation-decide has no RUNTIME import of ./index (type-only), so no cycle can form', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/mcp/elevation-decide.ts', import.meta.url), 'utf8')
    const runtimeImports = [...src.matchAll(/^import\s+(?!type\b)[^\n]*from\s+'\.\/index'/gm)]
    expect(runtimeImports).toEqual([])
  })
})
