import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BYOA_HARNESSES,
  findHarness,
  getHarnessPack,
  listShippableHarnesses,
} from '../src/byoa/catalog'

const packsRoot = join(__dirname, '..', 'packs')

describe('BYOA harness catalog', () => {
  it('ships packs for every topology A/C harness and marks Claude Desktop docs-only', () => {
    const shippable = listShippableHarnesses()
    expect(shippable.map((h) => h.id).sort()).toEqual([
      'claude-code',
      'claude-managed',
      'codex',
      'cursor',
      'cursor-background',
    ].sort())
    expect(shippable.every((h) => h.topology === 'A' || h.topology === 'C')).toBe(true)
    expect(findHarness('claude-desktop')?.shipPack).toBe(false)
    expect(findHarness('claude-desktop')?.topology).toBe('B')
  })

  it('refuses getHarnessPack for docs-only and unknown ids', () => {
    expect(getHarnessPack('claude-desktop')).toEqual({ ok: false, error: 'docs_only' })
    expect(getHarnessPack('codex-cloud')).toEqual({ ok: false, error: 'not_found' })
    expect(getHarnessPack('codex').ok).toBe(true)
  })

  it('keeps a packs/<harness>/ directory with README for every shippable harness', () => {
    for (const harness of listShippableHarnesses()) {
      const dir = join(packsRoot, harness.packDir)
      expect(existsSync(dir), `missing ${dir}`).toBe(true)
      expect(existsSync(join(dir, 'README.md')), `missing README in ${dir}`).toBe(true)
      expect(harness.files.length).toBeGreaterThan(0)
      expect(harness.files.every((f) => f.path && f.content.length > 0)).toBe(true)
    }
  })

  it('embeds pack file names that exist on disk for newly added A/C packs', () => {
    for (const id of ['codex', 'cursor-background', 'claude-managed'] as const) {
      const harness = BYOA_HARNESSES.find((h) => h.id === id)
      expect(harness).toBeTruthy()
      const dir = join(packsRoot, harness!.packDir)
      const onDisk = new Set(readdirSync(dir))
      for (const file of harness!.files) {
        expect(onDisk.has(file.path), `${id} missing ${file.path}`).toBe(true)
        const disk = readFileSync(join(dir, file.path), 'utf8')
        expect(disk).toBe(file.content)
      }
    }
  })

  it('never embeds a real mupot_ token in pack templates', () => {
    for (const harness of listShippableHarnesses()) {
      const blob = harness.files.map((f) => f.content).join('\n')
      expect(blob).not.toMatch(/mupot_[0-9a-f]{64}/)
    }
  })
})
