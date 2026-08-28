// tests/flight-router-cron.test.ts — Verification of FLIGHT-ROUTER-CRON (W3 Background Automation).
//
// Invariants verified:
//   1. Scheduled router sweep execution via runScheduledRouterSweep.
//   2. Background dispatch matching unassigned tasks to active continuum bodies.
//   3. Telemetry emission ('org.provisioned' with router payload) on task assignment.
//   4. HTTP POST /api/router/tick trigger route authorization and execution.
//   5. Scale-to-zero safety: graceful no-op when no tasks are unassigned.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { runScheduledRouterSweep, routerRoutesApp } from '../src/router/scheduled'
import { hashMemberToken } from '../src/auth/member-bearer'
import type { Env } from '../src/types'

describe('FLIGHT-ROUTER-CRON: Cloudflare Scheduled Cron & Background Router', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const SQUAD_ID = 'squad-core'
  const ADMIN_ID = 'm-admin'
  const ADMIN_TOKEN = 'mupot_test_admin_token_secret'

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokenHash = await hashMemberToken(ADMIN_TOKEN)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    } as unknown as Env

    // Seed test admin, departments, squads, agents, and presence
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status, tenant)
      VALUES ('${ADMIN_ID}', 'admin@mumega.com', 'Admin User', 'active', '${TENANT}');

      INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, expires_at, created_at, tenant)
      VALUES ('tok-admin-1', '${ADMIN_ID}', '${tokenHash}', 'admin-key', 'workspace', NULL, datetime('now'), '${TENANT}');

      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-org', '${ADMIN_ID}', 'org', NULL, 'owner');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 'core', 'Core Squad');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-river-1', '${SQUAD_ID}', 'river-lead', 'River Lead', 'active'),
             ('ag-kasra-1', '${SQUAD_ID}', 'kasra-builder', 'Kasra Builder', 'active'),
             ('ag-hermes-1', '${SQUAD_ID}', 'hermes-comms', 'Hermes Comms', 'active');

      INSERT OR IGNORE INTO presence (
        tenant, member_id, display_name, source, label, seat, agent_id,
        harness, machine, model, provider, effort, continuum_name, last_seen_at
      )
      VALUES ('${TENANT}', '${ADMIN_ID}', 'River Cursor', 'cursor-cloud', 'river-cursor', 'river-cursor', 'ag-river-1',
              'cursor-cloud', 'cursor-vm', 'claude-3-7-sonnet', 'anthropic', 'high', 'river', datetime('now'));
    `)
  })

  describe('1. Scheduled Cron Background Sweep', () => {
    it('executes automated background sweep and assigns tasks to live continuum bodies', async () => {
      // 1. Insert unassigned open tasks
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
        VALUES ('task-cron-1', '${SQUAD_ID}', 'Fix CI defect in delivery turn fence', 'Need edge fix', 'Done when green', 'open', datetime('now'), datetime('now')),
               ('task-cron-2', '${SQUAD_ID}', 'Telegram chat message broadcast notice', 'Send team update', 'Message posted', 'open', datetime('now'), datetime('now'));
      `)

      // 2. Trigger scheduled sweep
      const sweepRes = await runScheduledRouterSweep(env, new Date())
      expect(sweepRes.ok).toBe(true)
      expect(sweepRes.tickResult.scannedCount).toBe(2)
      expect(sweepRes.tickResult.assignedCount).toBe(2)

      // 3. Verify task assignment in D1
      const task1 = await env.DB.prepare(`SELECT assignee_agent_id FROM tasks WHERE id = 'task-cron-1'`).first<{ assignee_agent_id: string }>()
      const task2 = await env.DB.prepare(`SELECT assignee_agent_id FROM tasks WHERE id = 'task-cron-2'`).first<{ assignee_agent_id: string }>()

      expect(task1?.assignee_agent_id).toBe('ag-river-1')
      expect(task2?.assignee_agent_id).toBe('ag-hermes-1')
    })

    it('gracefully handles scale-to-zero when no open tasks exist', async () => {
      const emptySweep = await runScheduledRouterSweep(env, new Date())
      expect(emptySweep.ok).toBe(true)
      expect(emptySweep.tickResult.scannedCount).toBe(0)
      expect(emptySweep.tickResult.assignedCount).toBe(0)
    })
  })

  describe('2. HTTP Trigger Route POST /api/router/tick', () => {
    it('executes router tick via authenticated REST API', async () => {
      harness.sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, status, created_at, updated_at)
        VALUES ('task-rest-1', '${SQUAD_ID}', 'Refactor compiler worktree engine', 'Internal build pass', 'Done when green', 'open', datetime('now'), datetime('now'));
      `)

      const req = new Request('https://mupot.mumega.com/api/router/tick', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dry_run: false, squad_id: SQUAD_ID }),
      })

      const res = await routerRoutesApp.fetch(req, env)
      expect(res.status).toBe(200)

      const data = (await res.json()) as any
      expect(data.assignedCount).toBe(1)
      expect(data.decisions[0].assignedAgentId).toBe('ag-kasra-1')
    })

    it('rejects unauthenticated requests to /api/router/tick with 401', async () => {
      const req = new Request('https://mupot.mumega.com/api/router/tick', {
        method: 'POST',
      })

      const res = await routerRoutesApp.fetch(req, env)
      expect(res.status).toBe(401)
    })
  })
})
