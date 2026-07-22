// tests/mcp-instincts.test.ts — MCP instinct_* tools (Port 4 instinct-memory).
// Real D1 via sqlite-d1 harness. Covers: observe → distill → recall, promotion
// gate, and member-on-write-mapped-squad authz (Codex P1 from PR #480).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import * as distillMod from '../src/memory/instinct-distill'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept', 'b', 'B');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A');
    INSERT INTO projects (id, slug, name) VALUES ('proj-b', 'proj-b', 'Project B');
    INSERT INTO projects (id, slug, name) VALUES ('proj-hidden', 'proj-hidden', 'Hidden');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('proj-a', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('proj-b', 'squad-a', 'write');
  `)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    sqlite: harness.sqlite,
  }
}

function grant(
  capability: CapabilityGrant['capability'],
  scope_type = 'org',
  scope_id: string | null = null,
): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(
  memberId: string,
  capabilities: CapabilityGrant[],
  boundAgentId: string | null = null,
): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId,
  }
}

const orgAdmin = auth('admin-member', [grant('admin', 'org', null)])
const weldedBuilder = auth(
  'member-welded',
  [grant('member', 'squad', 'squad-a')],
  'agent-builder-1',
)
const observerOnWriteSquad = auth(
  'member-obs',
  [grant('observer', 'squad', 'squad-a')],
  'agent-obs-1',
)
const outsider = auth('member-out', [grant('member', 'squad', 'squad-b')])

describe('instinct tools — registered in TOOLS', () => {
  it('registers observe/distill/recall/promote', () => {
    for (const name of [
      'instinct_observe',
      'instinct_distill',
      'instinct_recall',
      'instinct_promote',
    ]) {
      expect(TOOLS.find((t) => t.name === name), `${name} should be registered`).toBeDefined()
    }
  })
})

describe('instinct_observe → distill → recall', () => {
  it('captures observations, distills with injectable cheap model, recalls with confidence', async () => {
    const { env } = makeDb()

    const observe = await invokeTool(weldedBuilder, env, 'instinct_observe', {
      project_id: 'proj-a',
      event: 'correction',
      payload: { note: 'prefer vitest over jest' },
      session_id: 'sess-1',
    })
    expect(observe.ok).toBe(true)

    vi.spyOn(distillMod, 'defaultInstinctChat').mockReturnValue(async () => JSON.stringify([
      {
        id: 'prefer-vitest-first',
        trigger: 'when writing tests',
        action: 'use vitest',
        confidence: 0.75,
        domain: 'testing',
        evidence: ['correction: prefer vitest'],
      },
    ]))

    const distilled = await invokeTool(weldedBuilder, env, 'instinct_distill', {
      project_id: 'proj-a',
      force: true,
    })
    expect(distilled.ok).toBe(true)
    const distillResult = distilled.result as {
      skipped: boolean
      upserted: Array<{ id: string; confidence: number }>
    }
    expect(distillResult.skipped).toBe(false)
    expect(distillResult.upserted.map((u) => u.id)).toContain('prefer-vitest-first')

    const recalled = await invokeTool(weldedBuilder, env, 'instinct_recall', {
      project_id: 'proj-a',
      min_confidence: 0.5,
    })
    expect(recalled.ok).toBe(true)
    const recallResult = recalled.result as {
      instincts: Array<{ id: string; trigger: string; confidence: number }>
    }
    expect(recallResult.instincts.map((i) => i.id)).toContain('prefer-vitest-first')
  })

  it('refuses observe for a project the caller cannot read', async () => {
    const { env } = makeDb()
    const denied = await invokeTool(outsider, env, 'instinct_observe', {
      project_id: 'proj-a',
      event: 'note',
      payload: { note: 'x' },
    })
    expect(denied.ok).toBe(false)
    expect(denied.error).toBe('project_not_found')
  })

  it('refuses distill when caller is only observer on a write-mapped squad', async () => {
    const { env } = makeDb()
    const denied = await invokeTool(observerOnWriteSquad, env, 'instinct_distill', {
      project_id: 'proj-a',
      force: true,
    })
    expect(denied.ok).toBe(false)
    // Floor is member — observer fails at the capability chokepoint.
    expect(denied.status).toBe(403)
  })
})

describe('instinct_promote — FRC no-silent-promotion gate', () => {
  it('blocks until ≥2 projects pass the confidence bar, then promotes global', async () => {
    const { env } = makeDb()

    vi.spyOn(distillMod, 'defaultInstinctChat').mockReturnValue(async () => JSON.stringify([
      {
        id: 'always-validate-input',
        trigger: 'when accepting user input',
        action: 'validate before use',
        confidence: 0.85,
        domain: 'security',
        evidence: ['obs'],
      },
    ]))

    await invokeTool(weldedBuilder, env, 'instinct_observe', {
      project_id: 'proj-a',
      event: 'note',
      payload: { n: 1 },
    })
    await invokeTool(weldedBuilder, env, 'instinct_distill', {
      project_id: 'proj-a',
      force: true,
    })

    const blocked = await invokeTool(orgAdmin, env, 'instinct_promote', {
      id: 'always-validate-input',
    })
    expect(blocked.ok).toBe(true)
    expect((blocked.result as { promoted: boolean }).promoted).toBe(false)

    await invokeTool(weldedBuilder, env, 'instinct_observe', {
      project_id: 'proj-b',
      event: 'note',
      payload: { n: 2 },
    })
    await invokeTool(weldedBuilder, env, 'instinct_distill', {
      project_id: 'proj-b',
      force: true,
    })

    const promoted = await invokeTool(orgAdmin, env, 'instinct_promote', {
      id: 'always-validate-input',
    })
    expect(promoted.ok).toBe(true)
    const result = promoted.result as { promoted: boolean; instinct: { scope: string } }
    expect(result.promoted).toBe(true)
    expect(result.instinct.scope).toBe('global')

    const recalled = await invokeTool(weldedBuilder, env, 'instinct_recall', {
      project_id: 'proj-a',
      min_confidence: 0.5,
    })
    const instincts = (recalled.result as { instincts: Array<{ id: string; scope: string }> }).instincts
    // Project scope shadows global for the same id when both exist.
    const prefer = instincts.find((i) => i.id === 'always-validate-input')
    expect(prefer?.scope).toBe('project')
  })
})
