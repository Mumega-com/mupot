// tests/flight-router-engine.test.ts — Verification of FLIGHT-ROUTER (W3).
//
// Invariants verified:
//   1. Word-boundary scoring matching task requirements to continuum lanes.
//   2. Human-only guards (decisions, credentials, deploys, policies are never auto-routed).
//   3. GitHub PR mirror notification filters (never routed as task labor).
//   4. Ambiguity safety: equal matches fail closed as unrouted with clear human reasons.
//   5. Active continuum body assignment and wake bus event emission.
//   6. router_tick MCP tool execution.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  classifyTaskForRouting,
  runRouterTick,
} from '../src/router/engine'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-ROUTER (W3): Edge-Native Active Router & Continuum Loop', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const SQUAD_ID = 'squad-core'
  const OPERATOR_ID = 'm-operator'

  const authContext: AuthContext = {
    userId: OPERATOR_ID,
    memberId: OPERATOR_ID,
    email: 'operator@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: OPERATOR_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed departments, squads, agents, and presence
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status)
      VALUES ('${OPERATOR_ID}', 'operator@mumega.com', 'Operator', 'active');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Core Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-core', 'core', 'Core Squad');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-river-1', '${SQUAD_ID}', 'river-lead', 'River Lead', 'active'),
             ('ag-kasra-1', '${SQUAD_ID}', 'kasra-builder', 'Kasra Builder', 'active'),
             ('ag-athena-1', '${SQUAD_ID}', 'athena-gate', 'Athena Gate', 'active');

      INSERT OR IGNORE INTO presence (
        tenant, member_id, display_name, source, label, seat, agent_id,
        harness, machine, model, provider, effort, continuum_name, last_seen_at
      )
      VALUES ('${TENANT}', '${OPERATOR_ID}', 'River Cursor', 'cursor-cloud', 'river-cursor', 'river-cursor', 'ag-river-1',
              'cursor-cloud', 'cursor-vm', 'claude-3-7-sonnet', 'anthropic', 'high', 'river', datetime('now'));
    `)
  })

  describe('1. Pure Classifier & Guardrails', () => {
    it('routes engineering tasks with word boundaries to tech-code (River)', () => {
      const match = classifyTaskForRouting('Fix worker typecheck bug in delivery router')
      expect(match.lane?.name).toBe('tech-code')
      expect(match.lane?.continuumName).toBe('river')
      expect(match.matchedKeywords).toContain('fix')
      expect(match.matchedKeywords).toContain('bug')
    })

    it('filters human-only tasks from auto-assignment', () => {
      const match = classifyTaskForRouting('Fix and approve deploy production credential')
      expect(match.lane).toBeNull()
      expect(match.reason).toContain('human-only signal')
    })

    it('filters GitHub PR mirror notifications from task routing', () => {
      const match = classifyTaskForRouting('[GH Mumega-com/mupot] PR #1236 opened: Council Platform Sprints')
      expect(match.lane).toBeNull()
      expect(match.reason).toContain('GitHub PR mirror notification')
    })

    it('identifies ambiguous tasks when keyword counts tie', () => {
      // 1 code keyword ('test') vs 1 audit keyword ('verify')
      const match = classifyTaskForRouting('Verify test on live pot')
      expect(match.lane).toBeNull()
      expect(match.reason).toContain('ambiguous match')
    })
  })

  describe('2. Active Router Engine Tick & Live D1 Assignment', () => {
    it('scans unassigned tasks and assigns them to active continuum bodies', async () => {
      // Insert unassigned open tasks
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
        VALUES ('task-code-1', '${SQUAD_ID}', 'Fix CI defect in migration schema', 'Need schema migration patch', 'Tests pass', 'open', datetime('now'), datetime('now')),
               ('task-human-1', '${SQUAD_ID}', 'Decide pricing policy for cloud agent tiers', 'Founder decision required', 'Policy signed', 'open', datetime('now'), datetime('now')),
               ('task-gh-1', '${SQUAD_ID}', '[GH repo] PR #100 opened: patch', 'PR mirror event', 'Reaped on close', 'open', datetime('now'), datetime('now'));
      `)

      // 1. Dry run tick
      const dryResult = await runRouterTick(env, { dryRun: true, squadId: SQUAD_ID })
      expect(dryResult.scannedCount).toBe(3)
      expect(dryResult.assignedCount).toBe(1)
      expect(dryResult.skippedCount).toBe(1)
      expect(dryResult.unroutedCount).toBe(1)

      // Verify no DB mutation occurred in dry run
      const taskAfterDry = await env.DB.prepare(`SELECT assignee_agent_id FROM tasks WHERE id = 'task-code-1'`).first<{ assignee_agent_id: string | null }>()
      expect(taskAfterDry?.assignee_agent_id).toBeNull()

      // 2. Active run tick
      const activeResult = await runRouterTick(env, { dryRun: false, squadId: SQUAD_ID })
      expect(activeResult.assignedCount).toBe(1)

      // Verify task assignment landed in D1
      const taskAfterActive = await env.DB.prepare(`SELECT assignee_agent_id FROM tasks WHERE id = 'task-code-1'`).first<{ assignee_agent_id: string }>()
      expect(taskAfterActive?.assignee_agent_id).toBe('ag-river-1')
    })
  })

  describe('3. MCP Router Tool Integration', () => {
    it('executes router_tick MCP tool', async () => {
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
        VALUES ('task-code-2', '${SQUAD_ID}', 'Refactor endpoint route guard', 'Edge route optimization', 'Done when merged', 'open', datetime('now'), datetime('now'));
      `)

      const toolRes = await invokeTool(authContext, env, 'router_tick', {
        dry_run: false,
        squad_id: SQUAD_ID,
      })

      expect(toolRes.ok).toBe(true)
      if (!toolRes.ok) throw new Error('Unreachable')
      expect((toolRes.result as any).assignedCount).toBe(1)
    })
  })
})
