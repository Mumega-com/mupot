// tests/dashboard-motherboard.test.ts — Vitest unit suite for /dashboard/motherboard and migrations.

import { describe, it, expect, beforeEach } from 'vitest'
import { loadMotherboardData, motherboardPageBody, SUPPORTED_TENANTS } from '../src/dashboard/motherboard'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations, migrationFiles } from './helpers/migrations'
import type { Env } from '../src/types'

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega',
  } as Env

  // Seed test subagent usage into real D1 table
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Core Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'core', 'Core Squad');

    INSERT INTO agents (id, squad_id, slug, name, status, parent_agent_id)
    VALUES ('river', 'squad-core', 'river', 'River', 'active', NULL),
           ('ag-river-code', 'squad-core', 'river-code', 'River Code', 'active', 'river'),
           ('ag-river-copywriter', 'squad-core', 'river-copywriter', 'River Copywriter', 'active', 'river'),
           ('ag-river-reviewer', 'squad-core', 'river-reviewer', 'River Reviewer', 'active', 'river'),
           ('ag-river-frc', 'squad-core', 'river-frc', 'River FRC', 'active', 'river');

    INSERT INTO subagent_token_usage (id, subagent_id, parent_agent_id, model_substrate, prompt_tokens, completion_tokens, task_id, timestamp)
    VALUES ('st-001', 'river-code', 'river', 'claude-sonnet-4.6', 1000, 500, 'task-1', datetime('now'));
  `)
})

describe('Dashboard Motherboard View Layer', () => {
  it('loads motherboard data with supported tenants and statistics', async () => {
    const data = await loadMotherboardData(env, 'mumega.com')
    expect(data.tenant).toBe('mumega.com')
    expect(data.tenants).toEqual(SUPPORTED_TENANTS)
    expect(data.stats.departmentCount).toBeGreaterThanOrEqual(1)
    expect(data.stats.squadCount).toBeGreaterThanOrEqual(1)
    expect(data.stats.agentCount).toBeGreaterThanOrEqual(5)

    // Verify subagent tentacle tree under agent:river
    expect(data.tentacleTree.parent).toBe('agent:river')
    const slugs = data.tentacleTree.tentacles.map((t) => t.slug)
    expect(slugs).toContain('river-code')
    expect(slugs).toContain('river-copywriter')
    expect(slugs).toContain('river-reviewer')
    expect(slugs).toContain('river-frc')
  })

  it('renders Hono HTML template containing motherboard components', async () => {
    const data = await loadMotherboardData(env, 'fractalresonance.com')
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

describe('Migration 0083 Tentacles Registration', () => {
  it('includes migration 0083_subagent_tentacles_registration.sql in migration files list', () => {
    const filenames = migrationFiles()
    expect(filenames).toContain('0083_subagent_tentacles_registration.sql')
  })
})
