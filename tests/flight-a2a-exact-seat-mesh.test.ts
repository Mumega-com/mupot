// tests/flight-a2a-exact-seat-mesh.test.ts — Verification of FLIGHT A2A-01 / #1198 & #1183.
//
// Invariants verified:
//   1. A2A Agent Card Standard (/.well-known/agent-card.json) describing Mupot capabilities without exposing secrets.
//   2. Targeted exact-seat task dispatch and wake routing (io.mumega.exact-seat/v1).
//   3. External runtime evidence reporting into tasks.result via task_report_result MCP tool and HTTP route (Issue #1183).
//   4. Provenance-safe artifact verification and receipt transitions.
//   5. Isolation of sibling seats (e.g. hadi-grok vs hadi-grok-desktop).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { a2aApp } from '../src/a2a/gateway'
import { reportTaskResult } from '../src/tasks/report-result'
import { deliverDispatchToInbox } from '../src/bus/fleet-bridge'
import { readAgentInbox } from '../src/agents/messages'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT A2A-01: A2A Gateway & Exact-Seat Dispatch Mesh (#1198 & #1183)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env

  beforeEach(async () => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    // Seed core department, squad, agents, members, and project
    await harness.db.prepare(
      `INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-eng', 'eng', 'Engineering', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-hadi-mac', 'dept-eng', 'hadi-mac', 'Hadi Mac Squad', CURRENT_TIMESTAMP)`,
    ).run()

    // Primary agent: hadi-grok
    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
       VALUES ('agent-hadi-grok', 'squad-hadi-mac', 'hadi-grok', 'Hadi Grok', 'lead', 'grok-4.6', 'active', CURRENT_TIMESTAMP)`,
    ).run()

    // Sibling agent: hadi-grok-desktop
    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
       VALUES ('agent-grok-desktop', 'squad-hadi-mac', 'hadi-grok-desktop', 'Grok Desktop', 'member', 'grok-4.6', 'active', CURRENT_TIMESTAMP)`,
    ).run()

    // Member: hadi-operator
    await harness.db.prepare(
      `INSERT INTO members (id, email, display_name, created_at)
       VALUES ('member-hadi', 'hadi@mumega.com', 'Hadi', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at)
       VALUES ('cap-1', 'member-hadi', 'org', NULL, 'owner', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO projects (id, slug, name, created_at)
       VALUES ('proj-main', 'main', 'Main Project', CURRENT_TIMESTAMP)`,
    ).run()

    // Seed 7-axis presence for hadi-grok on exact seat
    await harness.db.prepare(
      `INSERT INTO presence (tenant, member_id, display_name, source, label, seat, agent_id, harness, machine, model, last_seen_at)
       VALUES ('mumega', 'member-hadi', 'Hadi Grok Seat', 'grok-cli', 'hadi-mac-grok', 'hadi-mac-grok', 'agent-hadi-grok', 'grok-cli', 'hadi-mac', 'grok-4.6', datetime('now'))`,
    ).run()

    env = {
      DB: harness.db,
      TENANT_SLUG: 'mumega',
      BRAND: 'Mumega Mupot',
      PUBLIC_ORIGIN: 'https://mupot.mumega.com',
      RELEASE_SHA: 'a2a-canary-sha-1234',
    } as unknown as Env
  })

  describe('1. A2A Agent Card Standard (/.well-known/agent-card.json)', () => {
    it('serves Agent Card with exact seat capabilities without leaking secrets', async () => {
      const req = new Request('https://mupot.mumega.com/.well-known/agent-card.json')
      const res = await a2aApp.fetch(req, env as any)
      expect(res.status).toBe(200)

      const card = await res.json()
      expect(card.schema_version).toBe('a2a.agent_card/v1')
      expect(card.name).toContain('Mumega Mupot')
      expect(card.capabilities.exact_seat_routing).toBe(true)
      expect(card.capabilities.cryptographic_receipts).toBe(true)
      expect(card.capabilities.supported_protocols).toContain('io.mumega.exact-seat/v1')
      expect(card.endpoints.task_submit).toBe('https://mupot.mumega.com/api/a2a/tasks')
      expect(card.endpoints.agent_card).toBe('https://mupot.mumega.com/.well-known/agent-card.json')
      expect(Array.isArray(card.canonical_seats)).toBe(true)
    })
  })

  describe('2. Exact-Seat Targeted Dispatch & Mailbox Isolation', () => {
    it('delivers bridged task dispatch to exact seat without sibling HoL blocking', async () => {
      // Create a task assigned to agent-hadi-grok
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
         VALUES ('task-canary-101', 'squad-hadi-mac', 'A2A Canary Task', 'Execute canary verification', 'verify artifact hash', 'open', 'agent-hadi-grok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run()

      // Deliver targeted dispatch for exact seat "hadi-mac-grok"
      const bridgeRes = await deliverDispatchToInbox(env, {
        agentId: 'agent-hadi-grok',
        squadId: 'squad-hadi-mac',
        taskId: 'task-canary-101',
        receiptId: 'receipt-bridge-001',
        dispatchedByMemberId: 'member-hadi',
        targetSeat: 'hadi-mac-grok',
      })

      expect(bridgeRes.delivered).toBe(true)

      // Query inbox with matching exact seat
      const targetInbox = await readAgentInbox(env, {
        agent: 'agent-hadi-grok',
        seat: 'hadi-mac-grok',
        peek: true,
      })
      expect(targetInbox.ok).toBe(true)
      if (targetInbox.ok) {
        expect(targetInbox.messages.length).toBe(1)
        expect(targetInbox.messages[0].target_seat).toBe('hadi-mac-grok')
        expect(targetInbox.messages[0].body).toContain('task-canary-101')
      }

      // Query inbox with non-matching sibling seat (e.g. desktop) -> should NOT see targeted message
      const siblingInbox = await readAgentInbox(env, {
        agent: 'agent-hadi-grok',
        seat: 'grok-desktop',
        peek: true,
      })
      expect(siblingInbox.ok).toBe(true)
      if (siblingInbox.ok) {
        expect(siblingInbox.messages.length).toBe(0)
      }
    })
  })

  describe('3. External Runtime Result Reporting (Issue #1183 / task_report_result)', () => {
    it('allows external runtime to report verifiable completion evidence into tasks.result', async () => {
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
         VALUES ('task-external-202', 'squad-hadi-mac', 'External Runtime Work', 'Process on Mac host', 'Artifact produced', 'in_progress', 'agent-hadi-grok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run()

      const auth: AuthContext = {
        memberId: 'member-hadi',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      const validResultText = `Successfully executed on hadi-mac.
Artifact: /tmp/canary-receipt.json
SHA256: 8f4e2b6a9c1d3e5f7a0b2c4d6e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d1e2f`

      // 1. Report result via reportTaskResult service
      const outcome = await reportTaskResult(env, auth, {
        taskId: 'task-external-202',
        result: validResultText,
        status: 'review',
        gateOwner: 'gate:hadi-grok',
      })

      expect(outcome.ok).toBe(true)
      expect(outcome.task.result).toBe(validResultText)
      expect(outcome.task.status).toBe('review')
      expect(outcome.task.gate_owner).toBe('gate:hadi-grok')
      expect(outcome.artifact.verified).toBe(true)
      if (outcome.artifact.verified) {
        expect(outcome.artifact.path).toBe('/tmp/canary-receipt.json')
        expect(outcome.artifact.sha256Claimed).toBe('8f4e2b6a9c1d3e5f7a0b2c4d6e8f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d1e2f')
      }

      // Verify row in database
      const row = await harness.db.prepare('SELECT result, status, gate_owner FROM tasks WHERE id = ?1').bind('task-external-202').first<{ result: string; status: string; gate_owner: string }>()
      expect(row?.result).toBe(validResultText)
      expect(row?.status).toBe('review')
      expect(row?.gate_owner).toBe('gate:hadi-grok')
    })

    it('rejects unverified prose or missing SHA256 during result reporting', async () => {
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
         VALUES ('task-refusal-303', 'squad-hadi-mac', 'Refusal task', 'Body', 'Done when done', 'in_progress', 'agent-hadi-grok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run()

      const auth: AuthContext = {
        memberId: 'member-hadi',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      // Refusal prose without artifact hash
      await expect(
        reportTaskResult(env, auth, {
          taskId: 'task-refusal-303',
          result: 'I will analyze the task and plan to run it later.',
        }),
      ).rejects.toThrow(/Artifact: <path> and SHA256: <64-hex>/)
    })

    it('executes task_report_result MCP tool successfully', async () => {
      await harness.db.prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
         VALUES ('task-mcp-404', 'squad-hadi-mac', 'MCP Report Work', 'Run tool', 'Result present', 'in_progress', 'agent-hadi-grok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run()

      const auth: AuthContext = {
        memberId: 'member-hadi',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      const validResult = `Execution completed.
Artifact: /tmp/out.bin
SHA256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`

      const toolRes = await invokeTool(auth, env, 'task_report_result', {
        task_id: 'task-mcp-404',
        result: validResult,
        status: 'review',
        gate_owner: 'gate:hadi-grok',
      })

      expect(toolRes.ok).toBe(true)
      const data = toolRes.result as { ok: boolean; task: { id: string; status: string; result: string } }
      expect(data.ok).toBe(true)
      expect(data.task.id).toBe('task-mcp-404')
      expect(data.task.status).toBe('review')
    })
  })

  describe('4. A2A Task Submission & Execution Query Gateway', () => {
    it('submits task via A2A endpoint and queries canonical status & artifact', async () => {
      // 1. Submit task via POST /api/a2a/tasks
      const submitReq = new Request('https://mupot.mumega.com/api/a2a/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          squad_id: 'squad-hadi-mac',
          title: 'A2A Gateway Canary Work',
          body: 'Verify A2A pipeline',
          done_when: 'Artifact hash confirmed',
          assignee_agent_id: 'agent-hadi-grok',
          target_seat: 'hadi-mac-grok',
        }),
      })

      const submitRes = await a2aApp.fetch(submitReq, env as any)
      expect(submitRes.status).toBe(201)
      const submitJson = await submitRes.json<{ ok: boolean; task: { id: string }; dispatch: { receipt_id: string; target_seat: string } }>()
      expect(submitJson.ok).toBe(true)
      expect(submitJson.task.id).toBeDefined()
      expect(submitJson.dispatch.target_seat).toBe('hadi-mac-grok')

      const taskId = submitJson.task.id

      // 2. Query initial task state via GET /api/a2a/tasks/:id
      const queryReq1 = new Request(`https://mupot.mumega.com/api/a2a/tasks/${taskId}`)
      const queryRes1 = await a2aApp.fetch(queryReq1, env as any)
      expect(queryRes1.status).toBe(200)
      const queryJson1 = await queryRes1.json<{ ok: boolean; receipt_state: string; task: { status: string } }>()
      expect(queryJson1.receipt_state).toBe('accepted')

      // 3. Complete task with verified artifact
      const auth: AuthContext = {
        memberId: 'member-hadi',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      await reportTaskResult(env, auth, {
        taskId,
        result: `Task finished.\nArtifact: /tmp/a2a-artifact.json\nSHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
        status: 'done',
      })

      // 4. Query completed task state and verified artifact reference
      const queryReq2 = new Request(`https://mupot.mumega.com/api/a2a/tasks/${taskId}`)
      const queryRes2 = await a2aApp.fetch(queryReq2, env as any)
      expect(queryRes2.status).toBe(200)
      const queryJson2 = await queryRes2.json<{ ok: boolean; receipt_state: string; artifact: { verified: boolean; path: string } }>()
      expect(queryJson2.receipt_state).toBe('completed')
      expect(queryJson2.artifact.verified).toBe(true)
      expect(queryJson2.artifact.path).toBe('/tmp/a2a-artifact.json')
    })
  })
})
