// tests/mcp-warm-restart.test.ts — Port 4 MCP tools (session_save / session_resume /
// instinct_upsert / instinct_promote). Real D1 via sqlite-d1 harness.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { STALE_REPLAY_BEGIN } from '../src/memory/warm-restart'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const WORKTREE = '/home/mumega/mupot-worktrees/cursor-efed841a'

const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO projects (id, slug, name) VALUES ('proj-a', 'proj-a', 'Project A');
    INSERT INTO projects (id, slug, name) VALUES ('proj-b', 'proj-b', 'Project B');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-b', 'squad-a', 'write');
  `)
  return { env: { DB: harness.db, TENANT_SLUG: TENANT } as Env }
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
  'member-a',
  [grant('member', 'squad', 'squad-a')],
  'agent-cursor-1',
)

describe('warm-restart tools — registered in TOOLS', () => {
  it('registers all four Port 4 tools', () => {
    for (const name of ['session_save', 'session_resume', 'instinct_upsert', 'instinct_promote']) {
      expect(TOOLS.find((t) => t.name === name), `${name} should be registered`).toBeDefined()
    }
  })
})

describe('session_save → session_resume — post-compaction warm restart', () => {
  it('resumes warm with fine-grain context behind the stale-replay guard', async () => {
    const { env } = makeDb()

    const save = await invokeTool(weldedBuilder, env, 'session_save', {
      session_id: 'sess-compact-1',
      reason: 'pre_compact',
      project_id: 'proj-a',
      worktree: WORKTREE,
      branch: 'cursor/task-efed841a',
      summary: 'Mid Port 4 build, about to compact.',
      user_messages: ['Keep fine-grain files and decisions'],
      files_modified: ['src/memory/warm-restart.ts', 'src/mcp/warm-restart.ts'],
      tools_used: ['Write', 'Shell'],
      decisions: ['D1-backed handoff, not client-only files'],
      open_threads: ['Commit after tsc+vitest green'],
    }, ORIGIN)
    expect(save.ok).toBe(true)
    if (!save.ok) return
    const saveResult = save.result as { fine_grain: boolean; handoff_id: string }
    expect(saveResult.fine_grain).toBe(true)

    await invokeTool(weldedBuilder, env, 'instinct_upsert', {
      id: 'prefer-vitest-first',
      trigger: 'writing tests for a new module',
      action: 'Add vitest coverage before wiring MCP.',
      confidence: 0.85,
      scope: 'project',
      domain: 'testing',
      project_id: 'proj-a',
      evidence: ['Port 4 TDD'],
    }, ORIGIN)

    const resume = await invokeTool(weldedBuilder, env, 'session_resume', {
      project_id: 'proj-a',
      worktree: WORKTREE,
    }, ORIGIN)
    expect(resume.ok).toBe(true)
    if (!resume.ok) return
    const result = resume.result as {
      warm: boolean
      stale_replay_guarded: boolean
      fine_grain_preserved: boolean
      context: string
      instincts: Array<{ id: string }>
    }
    expect(result.warm).toBe(true)
    expect(result.stale_replay_guarded).toBe(true)
    expect(result.fine_grain_preserved).toBe(true)
    expect(result.context).toContain(STALE_REPLAY_BEGIN)
    expect(result.context).toContain('src/memory/warm-restart.ts')
    expect(result.context).toContain('D1-backed handoff, not client-only files')
    expect(result.context).toContain('Commit after tsc+vitest green')
    expect(result.instincts.map((i) => i.id)).toContain('prefer-vitest-first')
  })

  it('refuses project-scoped save when the caller cannot read the project', async () => {
    const { env } = makeDb()
    const outsider = auth('outsider', [grant('observer', 'squad', 'squad-other')])
    const save = await invokeTool(outsider, env, 'session_save', {
      session_id: 'sess-x',
      reason: 'stop',
      project_id: 'proj-a',
    }, ORIGIN)
    expect(save.ok).toBe(false)
    if (save.ok) return
    expect(save.error).toBe('project_not_found')
  })
})

describe('instinct_promote — FRC no-silent-promotion gate', () => {
  it('blocks promote until ≥2 projects pass the confidence bar', async () => {
    const { env } = makeDb()

    await invokeTool(weldedBuilder, env, 'instinct_upsert', {
      id: 'always-validate-input',
      trigger: 'accepting user input',
      action: 'Validate before use.',
      confidence: 0.85,
      scope: 'project',
      project_id: 'proj-a',
    }, ORIGIN)

    const blocked = await invokeTool(orgAdmin, env, 'instinct_promote', {
      id: 'always-validate-input',
    }, ORIGIN)
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toBe('promotion_gate_failed')

    await invokeTool(weldedBuilder, env, 'instinct_upsert', {
      id: 'always-validate-input',
      trigger: 'accepting user input',
      action: 'Validate before use.',
      confidence: 0.85,
      scope: 'project',
      project_id: 'proj-b',
    }, ORIGIN)

    const promoted = await invokeTool(orgAdmin, env, 'instinct_promote', {
      id: 'always-validate-input',
    }, ORIGIN)
    expect(promoted.ok).toBe(true)
    if (!promoted.ok) return
    const result = promoted.result as { promoted: boolean; instinct: { scope: string } }
    expect(result.promoted).toBe(true)
    expect(result.instinct.scope).toBe('global')
  })
})
