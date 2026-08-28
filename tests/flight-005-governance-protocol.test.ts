// tests/flight-005-governance-protocol.test.ts — Verification of FLIGHT-005 / mumega-com#723 & MU.100.001.
//
// Invariants verified:
//   1. Proposal Registration: Durable D1 proposal with document content / SHA-256 hash binding.
//   2. Terminal State Guard: One vote per council seat per resolution ID; re-acknowledgments / duplicate votes rejected with 409 already_voted.
//   3. Cryptographic SHA-256 Hash Binding: Votes and ratification fail closed with 400 hash_mismatch if document diff / hash disagrees.
//   4. Multi-Sig Consensus Threshold: 2-of-4 Synthetic Council + Founder Seal quorum requirement.
//   5. Ratification Immutability: Ratified amendment creates durable ratified_amendments record and seals proposal status to 'ratified'.
//   6. MCP Tools Integration: governance_propose, governance_vote, governance_ratify, governance_status.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  proposeGovernance,
  voteGovernance,
  getGovernanceStatus,
  ratifyGovernance,
} from '../src/governance/service'
import { sha256Hex } from '../src/lib/crypto'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-005: Governance Wiring & Constitutional Protocols (MU.100.001 / #723)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const FOUNDER_MEMBER_ID = 'm-hadi'
  const RIVER_AGENT_ID = 'ag-river-1'
  const ATHENA_AGENT_ID = 'ag-athena-1'
  const KASRA_AGENT_ID = 'ag-kasra-1'

  const founderAuth: AuthContext = {
    userId: FOUNDER_MEMBER_ID,
    memberId: FOUNDER_MEMBER_ID,
    email: 'hadi@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: FOUNDER_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  const riverAuth: AuthContext = {
    userId: RIVER_AGENT_ID,
    boundAgentId: RIVER_AGENT_ID,
    memberId: 'm-river',
    email: 'river@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-river', scope_type: 'org', scope_id: null, capability: 'lead' }],
  }

  const athenaAuth: AuthContext = {
    userId: ATHENA_AGENT_ID,
    boundAgentId: ATHENA_AGENT_ID,
    memberId: 'm-athena',
    email: 'athena@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-athena', scope_type: 'org', scope_id: null, capability: 'lead' }],
  }

  const kasraAuth: AuthContext = {
    userId: KASRA_AGENT_ID,
    boundAgentId: KASRA_AGENT_ID,
    memberId: 'm-kasra',
    email: 'kasra@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-kasra', scope_type: 'org', scope_id: null, capability: 'lead' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed founder and council agents
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status, tenant)
      VALUES ('${FOUNDER_MEMBER_ID}', 'hadi@mumega.com', 'Hadi', 'active', '${TENANT}'),
             ('m-river', 'river@mumega.com', 'River', 'active', '${TENANT}'),
             ('m-athena', 'athena@mumega.com', 'Athena', 'active', '${TENANT}'),
             ('m-kasra', 'kasra@mumega.com', 'Kasra', 'active', '${TENANT}');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-council', 'council', 'Synthetic Council');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-council', 'core', 'Core Squad');

      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('${RIVER_AGENT_ID}', 'squad-core', 'river', 'River Lead', 'active'),
             ('${ATHENA_AGENT_ID}', 'squad-core', 'athena', 'Athena Gate', 'active'),
             ('${KASRA_AGENT_ID}', 'squad-core', 'kasra', 'Kasra Builder', 'active');
    `)
  })

  describe('1. Proposal Creation & Hash Binding', () => {
    it('creates a constitutional proposal bound to target document SHA-256', async () => {
      const docContent = '# MU.100.001 v7 — Thermodynamic Coherence & Fenced Delivery Amendment'
      const docHash = await sha256Hex(docContent)

      const outcome = await proposeGovernance(env, riverAuth, {
        resolutionId: 'mu-100-001-v7',
        proposalType: 'constitutional_amendment',
        title: 'Ratify Master Constitution v7',
        description: 'Binds fenced delivery, multi-body presence, and 2FA approval engine into MU.100.001',
        targetDocumentPath: 'docs/architecture/MU.100.001.md',
        targetDocumentContent: docContent,
        thresholdCouncilCount: 2,
        founderSealRequired: true,
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('Unreachable')
      expect(outcome.data.id).toBe('mu-100-001-v7')
      expect(outcome.data.target_document_hash).toBe(docHash)
      expect(outcome.data.status).toBe('open')
    })
  })

  describe('2. One-Shot Voting & Terminal State Guard (§1.3)', () => {
    it('records votes and enforces Terminal State Guard against duplicate voting', async () => {
      const docContent = '# MU.100.001 v7'
      const resId = 'res-terminal-guard-1'

      await proposeGovernance(env, riverAuth, {
        resolutionId: resId,
        title: 'Amendment Title',
        description: 'Amendment Desc',
        targetDocumentContent: docContent,
      })

      // 1. River votes APPROVE
      const voteRiver = await voteGovernance(env, riverAuth, {
        resolutionId: resId,
        voterSeat: 'river',
        vote: 'approve',
        reason: 'Coherence density is preserved (dS + k* d ln C = 0)',
        documentContentToVerify: docContent,
      })

      expect(voteRiver.ok).toBe(true)
      if (!voteRiver.ok) throw new Error('Unreachable')
      expect(voteRiver.data.voter_seat).toBe('river')
      expect(voteRiver.data.vote).toBe('approve')

      // 2. Duplicate vote attempt by River fails closed with 409 already_voted
      const duplicateVote = await voteGovernance(env, riverAuth, {
        resolutionId: resId,
        voterSeat: 'river',
        vote: 'approve',
        reason: 'Duplicate chat message / re-ack',
      })

      expect(duplicateVote.ok).toBe(false)
      if (duplicateVote.ok) throw new Error('Unreachable')
      expect(duplicateVote.error).toBe('already_voted')
      expect(duplicateVote.status).toBe(409)
    })

    it('rejects votes with hash_mismatch if document content has been tampered with', async () => {
      const canonicalDoc = '# MU.100.001 Canonical Text'
      const tamperedDoc = '# MU.100.001 Tampered Text'
      const resId = 'res-hash-guard-1'

      await proposeGovernance(env, riverAuth, {
        resolutionId: resId,
        title: 'Hash Guard Test',
        description: 'Test hash verification',
        targetDocumentContent: canonicalDoc,
      })

      const voteAttempt = await voteGovernance(env, athenaAuth, {
        resolutionId: resId,
        voterSeat: 'athena',
        vote: 'approve',
        documentContentToVerify: tamperedDoc,
      })

      expect(voteAttempt.ok).toBe(false)
      if (voteAttempt.ok) throw new Error('Unreachable')
      expect(voteAttempt.error).toBe('hash_mismatch')
      expect(voteAttempt.status).toBe(400)
    })
  })

  describe('3. Multi-Sig Consensus & Ratification Flow (§1.2)', () => {
    it('ratifies amendment when 2-of-4 council + founder seal are met', async () => {
      const docContent = '# MU.100.001 Ratified v7'
      const resId = 'res-ratification-success'

      await proposeGovernance(env, riverAuth, {
        resolutionId: resId,
        title: 'Full Ratification Test',
        description: '2 council votes + 1 founder seal',
        targetDocumentContent: docContent,
        thresholdCouncilCount: 2,
        founderSealRequired: true,
      })

      // 1. River approves
      await voteGovernance(env, riverAuth, {
        resolutionId: resId,
        voterSeat: 'river',
        vote: 'approve',
        reason: 'FRC invariant verified',
      })

      // Try early ratify -> fails (quorum not met)
      const earlyRatify = await ratifyGovernance(env, founderAuth, {
        resolutionId: resId,
      })
      expect(earlyRatify.ok).toBe(false)
      if (earlyRatify.ok) throw new Error('Unreachable')
      expect(earlyRatify.error).toBe('quorum_not_met')

      // 2. Athena approves (completes 2-of-4 council quorum)
      await voteGovernance(env, athenaAuth, {
        resolutionId: resId,
        voterSeat: 'athena',
        vote: 'approve',
        reason: 'Architectural boundary verified',
      })

      // Try ratify without founder seal -> fails (founder_seal_missing)
      const unsealedRatify = await ratifyGovernance(env, riverAuth, {
        resolutionId: resId,
      })
      expect(unsealedRatify.ok).toBe(false)
      if (unsealedRatify.ok) throw new Error('Unreachable')
      expect(unsealedRatify.error).toBe('founder_seal_missing')

      // 3. Hadi (Founder) seals
      await voteGovernance(env, founderAuth, {
        resolutionId: resId,
        voterSeat: 'kayhermes',
        vote: 'approve',
        reason: 'Sealed by Hadi Servat, Founder per MU.100.001 §1.2',
      })

      // 4. Ratification succeeds
      const ratifyOutcome = await ratifyGovernance(env, founderAuth, {
        resolutionId: resId,
        documentContentToVerify: docContent,
      })

      expect(ratifyOutcome.ok).toBe(true)
      if (!ratifyOutcome.ok) throw new Error('Unreachable')
      expect(ratifyOutcome.data.founder_seal).toBe(1)
      expect(ratifyOutcome.data.resolution_id).toBe(resId)

      // 5. Inspect status
      const statusOutcome = await getGovernanceStatus(env, resId)
      expect(statusOutcome.ok).toBe(true)
      if (!statusOutcome.ok) throw new Error('Unreachable')
      expect(statusOutcome.data.isRatified).toBe(true)
      expect(statusOutcome.data.approvedCount).toBe(3)
      expect(statusOutcome.data.hasFounderSeal).toBe(true)
    })
  })

  describe('4. MCP Governance Tools Integration', () => {
    it('runs governance_propose, governance_vote, governance_status, and governance_ratify via MCP', async () => {
      const docContent = '# Governance MCP Test'
      const docHash = await sha256Hex(docContent)

      // 1. Propose via MCP
      const propRes = await invokeTool(riverAuth, env, 'governance_propose', {
        resolution_id: 'res-mcp-gov-1',
        title: 'MCP Resolution',
        description: 'Testing MCP governance tools',
        target_document_content: docContent,
        threshold_council_count: 2,
        founder_seal_required: true,
      })
      expect(propRes.ok).toBe(true)

      // 2. Votes via MCP
      const voteRiverRes = await invokeTool(riverAuth, env, 'governance_vote', {
        resolution_id: 'res-mcp-gov-1',
        voter_seat: 'river',
        vote: 'approve',
        reason: 'River approval',
        document_content: docContent,
      })
      expect(voteRiverRes.ok).toBe(true)

      const voteKasraRes = await invokeTool(kasraAuth, env, 'governance_vote', {
        resolution_id: 'res-mcp-gov-1',
        voter_seat: 'kasra',
        vote: 'approve',
        reason: 'Kasra approval',
        document_hash: docHash,
      })
      expect(voteKasraRes.ok).toBe(true)

      const voteFounderRes = await invokeTool(founderAuth, env, 'governance_vote', {
        resolution_id: 'res-mcp-gov-1',
        voter_seat: 'kayhermes',
        vote: 'approve',
        reason: 'Founder seal',
      })
      expect(voteFounderRes.ok).toBe(true)

      // 3. Status via MCP
      const statusRes = await invokeTool(riverAuth, env, 'governance_status', {
        resolution_id: 'res-mcp-gov-1',
      })
      expect(statusRes.ok).toBe(true)
      expect((statusRes.result as any).approvedCount).toBe(3)

      // 4. Ratify via MCP
      const ratifyRes = await invokeTool(founderAuth, env, 'governance_ratify', {
        resolution_id: 'res-mcp-gov-1',
        document_content: docContent,
      })
      expect(ratifyRes.ok).toBe(true)
      expect((ratifyRes.result as any).founder_seal).toBe(1)
    })
  })
})
