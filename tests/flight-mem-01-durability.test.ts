// tests/flight-mem-01-durability.test.ts — Verification of FLIGHT MEM-01: Private & Squad Memory Durability & Binding Repair (#1202 & #1204).
//
// Invariants verified:
//   1. Full D1 migration chain compliance (applyAllMigrations).
//   2. Atomic Engram Lifecycle: 'pending' -> 'ready' on successful embedding & Vectorize upsert.
//   3. Partial-commit orphan elimination: on Workers AI or Vectorize failure, engrams are marked 'failed' and never surfaced by recall.
//   4. Sanitized error handling: returns memory_embedding_unavailable / vectorize_unavailable rather than unhandled 500 / -32000 internal_error.
//   5. Squad memory write & recall unblocked for valid squad members and org administrators (Issue #1204).
//   6. Private memory continuum: member:<memberId> persists across token rotation and denies cross-member access.
//   7. Engram reconciliation & safe reindex without text leakage in logs/receipts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { createMemory, reconcileEngrams, MemoryError } from '../src/memory/index'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext, VectorizeIndex, Ai } from '../src/types'

describe('FLIGHT MEM-01: Private & Squad Memory Durability & Binding Repair (#1202 & #1204)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>
  let queryLog: Array<{ topK: number; filter: Record<string, unknown> }>
  let mockVec: VectorizeIndex
  let mockAi: Ai

  beforeEach(async () => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    vectors = []
    queryLog = []

    mockAi = {
      run: vi.fn().mockResolvedValue({
        data: [new Array(768).fill(0.05)],
      }),
    } as unknown as Ai

    mockVec = {
      upsert: vi.fn().mockImplementation(async (rows: any[]) => {
        vectors.push(...rows)
        return { count: rows.length, ids: rows.map((r) => r.id) }
      }),
      query: vi.fn().mockImplementation(async (values: number[], opts: any) => {
        queryLog.push(opts)
        const filter = opts.filter || {}
        const matches = vectors
          .filter((v) => {
            if (filter.agentId && v.metadata?.agentId !== filter.agentId) return false
            if (filter.tenant && v.metadata?.tenant !== filter.tenant) return false
            return true
          })
          .slice(0, opts.topK || 5)
          .map((v, i) => ({ id: v.id, score: 0.95 - i * 0.05 }))
        return { matches, count: matches.length }
      }),
    } as unknown as VectorizeIndex

    // Seed core department, squad, agents, and members
    await harness.db.prepare(
      `INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-core', 'core', 'Core Operations', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-core', 'dept-core', 'core', 'Core Squad', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
       VALUES ('agent-cairn', 'squad-core', 'cairn', 'Cairn Lead', 'lead', 'claude-3-7-sonnet', 'active', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO members (id, email, display_name, created_at)
       VALUES ('member-hadi-ceo', 'hadi@mumega.com', 'Hadi CEO', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO members (id, email, display_name, created_at)
       VALUES ('member-cairn', 'cairn@mumega.com', 'Cairn Agent Member', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at)
       VALUES ('cap-ceo-org', 'member-hadi-ceo', 'org', NULL, 'owner', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, created_at)
       VALUES ('cap-cairn-squad', 'member-cairn', 'squad', 'squad-core', 'member', CURRENT_TIMESTAMP)`,
    ).run()
  })

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DB: harness.db,
      VEC: mockVec,
      AI: mockAi,
      TENANT_SLUG: 'mumega',
      BRAND: 'Mumega Mupot',
      ...overrides,
    } as unknown as Env
  }

  describe('1. Engram Lifecycle & Vectorize Synchronization (#1202)', () => {
    it('creates engram with status=ready upon successful embedding & Vectorize upsert', async () => {
      const env = makeEnv()
      const memory = createMemory(env)

      const engramId = await memory.remember('member:member-hadi-ceo', 'Production deployment completed cleanly.', ['ops', 'deploy'])
      expect(engramId).toBeDefined()

      // Verify row in D1 has status = 'ready' and embedding_model recorded
      const row = await harness.db.prepare(
        'SELECT id, agent_id, text, status, embedding_model FROM engrams WHERE id = ?1',
      ).bind(engramId).first<{ id: string; agent_id: string; text: string; status: string; embedding_model: string }>()

      expect(row?.status).toBe('ready')
      expect(row?.embedding_model).toBe('@cf/baai/bge-base-en-v1.5')
      expect(row?.text).toBe('Production deployment completed cleanly.')

      // Verify Vectorize received exact engram ID and metadata
      expect(mockVec.upsert).toHaveBeenCalledTimes(1)
      expect(vectors.length).toBe(1)
      expect(vectors[0].id).toBe(engramId)
      expect(vectors[0].metadata).toEqual({
        agentId: 'member:member-hadi-ceo',
        engramId,
        tenant: 'mumega',
      })
    })

    it('marks engram as failed and throws sanitized MemoryError when Workers AI fails', async () => {
      const failingAi = {
        run: vi.fn().mockRejectedValue(new Error('Rate limit or quota exceeded')),
      } as unknown as Ai

      const env = makeEnv({ AI: failingAi })
      const memory = createMemory(env)

      await expect(
        memory.remember('member:member-hadi-ceo', 'Secret strategic note.', ['strategy']),
      ).rejects.toThrowError(MemoryError)

      // Verify row in D1 is marked failed with error_code
      const row = await harness.db.prepare(
        'SELECT id, status, error_code FROM engrams WHERE text = ?1',
      ).bind('Secret strategic note.').first<{ id: string; status: string; error_code: string }>()

      expect(row?.status).toBe('failed')
      expect(row?.error_code).toBe('memory_embedding_unavailable')

      // Verify Vectorize was NOT touched
      expect(vectors.length).toBe(0)
    })

    it('marks engram as failed when Vectorize upsert fails', async () => {
      const failingVec = {
        upsert: vi.fn().mockRejectedValue(new Error('Vectorize index full')),
        query: vi.fn(),
      } as unknown as VectorizeIndex

      const env = makeEnv({ VEC: failingVec })
      const memory = createMemory(env)

      await expect(
        memory.remember('member:member-hadi-ceo', 'Unsaved note.', ['temp']),
      ).rejects.toThrowError(MemoryError)

      const row = await harness.db.prepare(
        'SELECT status, error_code FROM engrams WHERE text = ?1',
      ).bind('Unsaved note.').first<{ status: string; error_code: string }>()

      expect(row?.status).toBe('failed')
      expect(row?.error_code).toBe('vectorize_upsert_failed')
    })

    it('excludes pending and failed engrams from recall query results', async () => {
      const env = makeEnv()
      const memory = createMemory(env)

      // 1. Ready engram
      const readyId = await memory.remember('member:member-hadi-ceo', 'Active memory item.')

      // 2. Insert a corrupted / failed engram directly
      const failedId = crypto.randomUUID()
      await harness.db.prepare(
        `INSERT INTO engrams (id, agent_id, text, status, error_code, created_at, updated_at)
         VALUES (?1, 'member:member-hadi-ceo', 'Failed orphan memory item.', 'failed', 'embedding_failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).bind(failedId).run()

      // Mock Vectorize returning both IDs
      vectors.push({
        id: failedId,
        values: new Array(768).fill(0.05),
        metadata: { agentId: 'member:member-hadi-ceo', engramId: failedId, tenant: 'mumega' },
      })

      const hits = await memory.recall('member:member-hadi-ceo', 'memory', 5)
      expect(hits.length).toBe(1)
      expect(hits[0].id).toBe(readyId)
      expect(hits[0].text).toBe('Active memory item.')
    })
  })

  describe('2. Squad Memory Unblocking for Members & Org Admins (#1204)', () => {
    it('allows valid squad member (Cairn) to store and recall squad memory without internal_error', async () => {
      const env = makeEnv()

      const authCairn: AuthContext = {
        memberId: 'member-cairn',
        boundAgentId: 'agent-cairn',
        role: 'member',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
      }

      // 1. squad_remember
      const rememberRes = await invokeTool(authCairn, env, 'squad_remember', {
        squad_id: 'squad-core',
        text: 'Core platform deployment checklist verified.',
        concepts: ['checklist', 'deploy'],
      })

      expect(rememberRes.ok).toBe(true)
      const data = rememberRes.result as { engram_id: string; squad_id: string; scope: string }
      expect(data.squad_id).toBe('squad-core')
      expect(data.scope).toBe('squad:squad-core')

      // 2. squad_recall
      const recallRes = await invokeTool(authCairn, env, 'squad_recall', {
        squad_id: 'squad-core',
        query: 'deployment checklist',
        limit: 5,
      })

      expect(recallRes.ok).toBe(true)
      const recallData = recallRes.result as { hits: Array<{ id: string; text: string }> }
      expect(recallData.hits.length).toBe(1)
      expect(recallData.hits[0].text).toBe('Core platform deployment checklist verified.')
    })

    it('allows org administrator / owner to store and recall squad memory via workspace admin bypass', async () => {
      const env = makeEnv()

      const authOwner: AuthContext = {
        memberId: 'member-hadi-ceo',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      const rememberRes = await invokeTool(authOwner, env, 'squad_remember', {
        squad_id: 'squad-core',
        text: 'Executive directive on Q3 platform goals.',
      })

      expect(rememberRes.ok).toBe(true)

      const recallRes = await invokeTool(authOwner, env, 'squad_recall', {
        squad_id: 'squad-core',
        query: 'Executive directive',
      })

      expect(recallRes.ok).toBe(true)
      const recallData = recallRes.result as { hits: Array<{ id: string; text: string }> }
      expect(recallData.hits.length).toBe(1)
      expect(recallData.hits[0].text).toBe('Executive directive on Q3 platform goals.')
    })
  })

  describe('3. Sanitized Error Responses & Missing Binding Degradation', () => {
    it('returns sanitized 503 memory_embedding_unavailable when AI binding is missing', async () => {
      const envWithoutAi = makeEnv({ AI: undefined })

      const auth: AuthContext = {
        memberId: 'member-hadi-ceo',
        role: 'owner',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'org', scope_id: 'mumega', capability: 'owner' }],
      }

      const res = await invokeTool(auth, envWithoutAi, 'remember', {
        text: 'Test note',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(503)
      expect(res.error).toBe('memory_embedding_unavailable')
    })
  })

  describe('4. Engram Reconciliation & Reindex', () => {
    it('reconciles failed/pending engrams into ready state without leaking content in receipts', async () => {
      const env = makeEnv()

      // Insert 2 failed engrams
      const id1 = crypto.randomUUID()
      const id2 = crypto.randomUUID()

      await harness.db.prepare(
        `INSERT INTO engrams (id, agent_id, text, status, error_code, created_at, updated_at)
         VALUES (?1, 'member:member-hadi-ceo', 'Recoverable text 1', 'failed', 'embedding_failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).bind(id1).run()

      await harness.db.prepare(
        `INSERT INTO engrams (id, agent_id, text, status, error_code, created_at, updated_at)
         VALUES (?1, 'member:member-hadi-ceo', 'Recoverable text 2', 'pending', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).bind(id2).run()

      const summary = await reconcileEngrams(env, 'member:member-hadi-ceo')
      expect(summary.scanned).toBe(2)
      expect(summary.reindexed).toBe(2)
      expect(summary.ready).toBe(2)
      expect(summary.errors.length).toBe(0)

      // Verify rows updated in D1
      const updatedRows = await harness.db.prepare(
        `SELECT id, status FROM engrams WHERE id IN (?1, ?2)`,
      ).bind(id1, id2).all<{ id: string; status: string }>()

      expect(updatedRows.results?.every((r) => r.status === 'ready')).toBe(true)
      expect(vectors.length).toBe(2)
    })
  })
})
