// tests/dashboard-motherboard.test.ts — Vitest unit suite for /dashboard/motherboard and migration 0080.

import { describe, it, expect } from 'vitest'
import { loadMotherboardData, motherboardPageBody, SUPPORTED_TENANTS } from '../src/dashboard/motherboard'
import { migrationFiles } from './helpers/migrations'

describe('Dashboard Motherboard View Layer', () => {
  it('loads motherboard data with supported tenants and statistics', async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          all: async () => ({ results: [] }),
          first: async () => ({ total_prompt: 1000, total_comp: 500, cnt: 2 }),
        }),
      },
    } as any

    const data = await loadMotherboardData(mockEnv, 'mumega.com')
    expect(data.tenant).toBe('mumega.com')
    expect(data.tenants).toEqual(SUPPORTED_TENANTS)
    expect(data.stats.departmentCount).toBeGreaterThanOrEqual(5)
    expect(data.stats.squadCount).toBeGreaterThanOrEqual(32)
    expect(data.stats.agentCount).toBeGreaterThanOrEqual(1000)
    expect(data.stats.activeContextTokens).toBe('5.0M')

    // Verify subagent tentacle tree under agent:river
    expect(data.tentacleTree.parent).toBe('agent:river')
    const slugs = data.tentacleTree.tentacles.map((t) => t.slug)
    expect(slugs).toContain('river-code')
    expect(slugs).toContain('river-copywriter')
    expect(slugs).toContain('river-reviewer')
    expect(slugs).toContain('river-frc')
  })

  it('renders Hono HTML template containing motherboard components', async () => {
    const mockEnv = {
      DB: {
        prepare: () => ({
          all: async () => ({ results: [] }),
          first: async () => ({ total_prompt: 1000, total_comp: 500, cnt: 2 }),
        }),
      },
    } as any

    const data = await loadMotherboardData(mockEnv, 'fractalresonance.com')
    const renderedHtml = String(await motherboardPageBody(data))

    expect(renderedHtml).toContain('Fractal Motherboard — 1,000 Agent Map')
    expect(renderedHtml).toContain('Subagent Tentacle Tree')
    expect(renderedHtml).toContain('parent_agent_id')
    expect(renderedHtml).toContain('river-code')
    expect(renderedHtml).toContain('river-copywriter')
    expect(renderedHtml).toContain('river-reviewer')
    expect(renderedHtml).toContain('river-frc')
    expect(renderedHtml).toContain('fractalresonance.com')
    expect(renderedHtml).toContain('dS + k* d(ln C) = 0')
  })
})

describe('Migration 0080 Registration', () => {
  it('includes 0080_subagent_tentacles_registration.sql in committed migration list', () => {
    const files = migrationFiles()
    expect(files).toContain('0080_subagent_tentacles_registration.sql')
  })
})
