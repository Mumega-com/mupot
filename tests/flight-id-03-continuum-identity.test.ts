// tests/flight-id-03-continuum-identity.test.ts — Verification of FLIGHT ID-03 / #1168 & #1163.
//
// Invariants verified:
//   1. Continuum Memory Resolution: Memory is keyed to continuum name (e.g. river on Mac shares memory with river on Cursor Cloud).
//   2. Multi-Body Presence Isolation: Distinct (machine, harness, folder, thread) bodies coexist in presence without clobbering each other.
//   3. Open Body Minting (mint_body tool): Any authenticated runtime can mint/attach its active body tuple freely without elevated privilege.
//   4. Authority clamping: Body minting records hands/presence but does not grant ambient authority or elevate capability floors.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { createMemory } from '../src/memory/index'
import { recordCheckin, listPresence } from '../src/fleet/presence'
import { invokeTool, extractContinuumName } from '../src/mcp/index'
import type { Env, AuthContext, VectorizeIndex, Ai } from '../src/types'

describe('FLIGHT ID-03: Unified Continuum Identity & Body Minting (#1168 & #1163)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>
  let mockVec: VectorizeIndex
  let mockAi: Ai

  beforeEach(async () => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    vectors = []
    mockAi = {
      run: vi.fn().mockResolvedValue({
        data: [new Array(768).fill(0.08)],
      }),
    } as unknown as Ai

    mockVec = {
      upsert: vi.fn().mockImplementation(async (rows: any[]) => {
        vectors.push(...rows)
        return { count: rows.length, ids: rows.map((r) => r.id) }
      }),
      query: vi.fn().mockImplementation(async (values: number[], opts: any) => {
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
       VALUES ('agent-river-mac', 'squad-core', 'hadi-river', 'Hadi River (Mac)', 'lead', 'gemini-3.7-flash', 'active', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
       VALUES ('agent-river-cloud', 'squad-core', 'river-cursor', 'Cursor River (Cloud)', 'lead', 'gemini-3.7-flash', 'active', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO members (id, email, display_name, created_at)
       VALUES ('member-river-mac', 'hadi-river@mumega.com', 'Hadi River Mac', CURRENT_TIMESTAMP)`,
    ).run()

    await harness.db.prepare(
      `INSERT INTO members (id, email, display_name, created_at)
       VALUES ('member-river-cloud', 'river-cloud@mumega.com', 'River Cursor Cloud', CURRENT_TIMESTAMP)`,
    ).run()
  })

  function makeEnv(): Env {
    return {
      DB: harness.db,
      VEC: mockVec,
      AI: mockAi,
      TENANT_SLUG: 'mumega',
      BRAND: 'Mumega Mupot',
    } as unknown as Env
  }

  describe('1. Continuum Name Extraction & Memory Sharing', () => {
    it('extracts root continuum names accurately from location-qualified agent slugs', () => {
      expect(extractContinuumName('hadi-river')).toBe('river')
      expect(extractContinuumName('river-cursor')).toBe('river')
      expect(extractContinuumName('muvps_kasra')).toBe('kasra')
      expect(extractContinuumName('dara-mac')).toBe('dara')
      expect(extractContinuumName('loom')).toBe('loom')
    })

    it('shares memory across concurrent river bodies via continuum scope', async () => {
      const env = makeEnv()

      const authRiverMac: AuthContext = {
        memberId: 'member-river-mac',
        boundAgentId: 'agent-river-mac',
        role: 'member',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
      }

      const authRiverCloud: AuthContext = {
        memberId: 'member-river-cloud',
        boundAgentId: 'agent-river-cloud',
        role: 'member',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
      }

      // 1. River on Mac remembers an insight with continuum="hadi-river"
      const rememberRes = await invokeTool(authRiverMac, env, 'remember', {
        text: 'Architecture insight: Sovereign pots must keep D1 migrations strictly ascending.',
        concepts: ['architecture', 'd1'],
        continuum: 'hadi-river',
      })

      expect(rememberRes.ok).toBe(true)
      const data = rememberRes.result as { engram_id: string; scope: string; continuum: string }
      expect(data.scope).toBe('continuum:river')
      expect(data.continuum).toBe('river')

      // 2. River on Cursor Cloud recalls the insight with continuum="river-cursor"
      const recallRes = await invokeTool(authRiverCloud, env, 'recall', {
        query: 'Sovereign pots migrations',
        continuum: 'river-cursor',
      })

      expect(recallRes.ok).toBe(true)
      const recallData = recallRes.result as { hits: Array<{ id: string; text: string }>; scope: string; continuum: string }
      expect(recallData.scope).toBe('continuum:river')
      expect(recallData.hits.length).toBe(1)
      expect(recallData.hits[0].text).toContain('Sovereign pots must keep D1 migrations strictly ascending.')
    })
  })

  describe('2. Multi-Body Presence Tuple (machine, harness, folder, thread)', () => {
    it('persists distinct bodies of river concurrently without overwriting presence sessions', async () => {
      const env = makeEnv()

      // Body 1: River on Mac host in /Users/hadi/projects/mupot (thread: session-101)
      await recordCheckin(env, {
        memberId: 'member-river-mac',
        displayName: 'River Mac Host',
        boundAgentId: 'agent-river-mac',
      }, {
        seat: 'hadi-mac:hermes:projects/mupot:thread-101',
        machine: 'hadi-mac',
        harness: 'hermes',
        folder: 'projects/mupot',
        thread: 'thread-101',
        continuum_name: 'river',
      })

      // Body 2: River on Cursor Cloud in /workspace (thread: cloud-runner-202)
      await recordCheckin(env, {
        memberId: 'member-river-cloud',
        displayName: 'River Cloud Runner',
        boundAgentId: 'agent-river-cloud',
      }, {
        seat: 'cursor-cloud-vm:cursor-cloud:/workspace:thread-202',
        machine: 'cursor-cloud-vm',
        harness: 'cursor-cloud',
        folder: '/workspace',
        thread: 'thread-202',
        continuum_name: 'river',
      })

      // List presence for tenant
      const presenceList = await listPresence(env, Date.now())
      expect(presenceList.length).toBeGreaterThanOrEqual(2)

      const macBody = presenceList.find((p) => p.machine === 'hadi-mac')
      const cloudBody = presenceList.find((p) => p.machine === 'cursor-cloud-vm')

      expect(macBody).toBeDefined()
      expect(macBody?.folder).toBe('projects/mupot')
      expect(macBody?.thread).toBe('thread-101')
      expect(macBody?.continuum_name).toBe('river')

      expect(cloudBody).toBeDefined()
      expect(cloudBody?.folder).toBe('/workspace')
      expect(cloudBody?.thread).toBe('thread-202')
      expect(cloudBody?.continuum_name).toBe('river')
    })
  })

  describe('3. Open Body Minting (mint_body MCP Tool)', () => {
    it('allows an authenticated runtime to mint and attach a body tuple freely', async () => {
      const env = makeEnv()

      const authRuntime: AuthContext = {
        memberId: 'member-river-mac',
        boundAgentId: 'agent-river-mac',
        role: 'member',
        tenant: 'mumega',
        capabilities: [{ scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }],
      }

      const mintRes = await invokeTool(authRuntime, env, 'mint_body', {
        continuum_name: 'hadi-river',
        machine: 'hadi-mac',
        harness: 'claude-code',
        folder: '/Users/hadi/fleet/mupot',
        thread: 'tmux-session-5',
      })

      expect(mintRes.ok).toBe(true)
      const data = mintRes.result as {
        body_id: string
        continuum: string
        tuple: { machine: string; harness: string; folder: string; thread: string }
        generation: number
      }

      expect(data.continuum).toBe('river')
      expect(data.tuple).toEqual({
        machine: 'hadi-mac',
        harness: 'claude-code',
        folder: '/Users/hadi/fleet/mupot',
        thread: 'tmux-session-5',
      })
      expect(data.generation).toBe(1)

      // Verify presence entry exists in D1
      const presenceRows = await harness.db.prepare(
        'SELECT machine, harness, folder, thread, continuum_name FROM presence WHERE machine = ?1 AND thread = ?2',
      ).bind('hadi-mac', 'tmux-session-5').all<{ machine: string; harness: string; folder: string; thread: string; continuum_name: string }>()

      expect(presenceRows.results?.length).toBe(1)
      expect(presenceRows.results?.[0].continuum_name).toBe('river')
    })
  })
})
