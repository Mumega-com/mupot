// tests/squad-packs.test.ts — squad packs (#11): reproducible squad + agents.
//
// SQUAD_PACKS is pure data (validated for shape); seedSquadPack is driven through
// injected createSquad/createAgent seams — no D1. Covers: pack validity, lookup,
// seed happy path, unknown pack, squad-create failure aborts, agent slug collision
// is recorded but does not abort the rest.

import { describe, expect, it, vi } from 'vitest'
import {
  SQUAD_PACKS,
  getSquadPack,
  seedSquadPack,
} from '../src/org/squad-packs'
import { isEffort, isAutonomy } from '../src/types'
import type { Env, Squad, Agent } from '../src/types'
import type { CreateResult } from '../src/org/service'

const ENV = {} as Env

describe('SQUAD_PACKS — shape validity', () => {
  it('every pack + every agent uses valid effort/autonomy enums', () => {
    for (const pack of SQUAD_PACKS) {
      expect(isEffort(pack.effort)).toBe(true)
      expect(isAutonomy(pack.autonomy)).toBe(true)
      expect(pack.key.length).toBeGreaterThan(0)
      expect(pack.agents.length).toBeGreaterThan(0)
      const slugs = new Set<string>()
      for (const a of pack.agents) {
        expect(isEffort(a.effort)).toBe(true)
        expect(isAutonomy(a.autonomy)).toBe(true)
        // kpi_target should start with a leading integer (the loop parses it)
        expect(/^\d+/.test(a.kpi_target)).toBe(true)
        // agent slugs unique within a pack
        expect(slugs.has(a.slug)).toBe(false)
        slugs.add(a.slug)
      }
    }
  })

  it('ships the shabrang pack (#11)', () => {
    const p = getSquadPack('shabrang')
    expect(p).toBeDefined()
    expect(p?.name).toBe('Shabrang')
    expect(p?.agents.map((a) => a.slug)).toContain('oracle-keeper')
  })

  it('getSquadPack returns undefined for an unknown key', () => {
    expect(getSquadPack('nope')).toBeUndefined()
  })
})

describe('seedSquadPack', () => {
  const mkSquad = (id: string): Squad => ({ id } as unknown as Squad)
  const mkAgent = (id: string): Agent => ({ id } as unknown as Agent)

  it('unknown pack → ok:false, nothing created', async () => {
    const createSquad = vi.fn()
    const createAgent = vi.fn()
    const r = await seedSquadPack(ENV, 'dept-1', 'nope', { createSquad, createAgent })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unknown_pack')
    expect(createSquad).not.toHaveBeenCalled()
  })

  it('happy path → creates the squad then every agent', async () => {
    const createSquad = vi.fn(async (): Promise<CreateResult<Squad>> => ({ ok: true, value: mkSquad('sq-1') }))
    const createAgent = vi.fn(async (): Promise<CreateResult<Agent>> => ({ ok: true, value: mkAgent('ag') }))

    const r = await seedSquadPack(ENV, 'dept-1', 'shabrang', { createSquad, createAgent })

    const pack = getSquadPack('shabrang')!
    expect(r.ok).toBe(true)
    expect(r.squad?.id).toBe('sq-1')
    expect(createSquad).toHaveBeenCalledWith(ENV, 'dept-1', expect.objectContaining({ slug: 'shabrang' }))
    expect(createAgent).toHaveBeenCalledTimes(pack.agents.length)
    expect(r.agents.length).toBe(pack.agents.length)
    expect(r.agentErrors.length).toBe(0)
    // agents are created under the new squad id
    expect(createAgent).toHaveBeenCalledWith(ENV, 'sq-1', expect.objectContaining({ slug: 'oracle-keeper' }))
  })

  it('squad-create failure aborts before any agent', async () => {
    const createSquad = vi.fn(async (): Promise<CreateResult<Squad>> => ({ ok: false, error: 'slug_taken' }))
    const createAgent = vi.fn()

    const r = await seedSquadPack(ENV, 'dept-1', 'shabrang', { createSquad, createAgent })

    expect(r.ok).toBe(false)
    expect(r.error).toBe('slug_taken')
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('an agent slug collision is recorded but does not abort the rest', async () => {
    const createSquad = vi.fn(async (): Promise<CreateResult<Squad>> => ({ ok: true, value: mkSquad('sq-1') }))
    // First agent fails (slug_taken), the rest succeed.
    let call = 0
    const createAgent = vi.fn(async (): Promise<CreateResult<Agent>> => {
      call++
      return call === 1 ? { ok: false, error: 'slug_taken' } : { ok: true, value: mkAgent(`ag-${call}`) }
    })

    const r = await seedSquadPack(ENV, 'dept-1', 'shabrang', { createSquad, createAgent })

    const pack = getSquadPack('shabrang')!
    expect(r.ok).toBe(true)
    expect(r.agentErrors.length).toBe(1)
    expect(r.agents.length).toBe(pack.agents.length - 1)
    expect(createAgent).toHaveBeenCalledTimes(pack.agents.length) // all attempted
  })
})
