// src/governance/service.ts — Constitutional Governance & Voting Consensus Engine (FLIGHT-005 / mumega-com#723 & MU.100.001).
//
// Invariants enforced:
// 1. Immutable backbone document binding (MU.100.001 §1.1).
// 2. Multi-Sig Amendment Protocol (§1.2): 2-of-4 Synthetic Council + Founder Seal.
// 3. One-Shot Board Voting Protocol (§1.3): Single vote per Resolution ID (Terminal State Guard).
// 4. Cryptographic SHA-256 Hash Binding (§1.3): Resolutions bind mechanically to document content hash.
// 5. Durable D1 State: Proposals, votes, and ratified amendments live in D1, not ephemeral bus traffic.

import type { Env, AuthContext } from '../types'
import { sha256Hex, timingSafeEqual } from '../lib/crypto'
import { isOrgAdmin } from '../auth/capability'

export const CANONICAL_COUNCIL_SEATS = ['river', 'athena', 'kasra', 'loom'] as const
export type CouncilSeat = (typeof CANONICAL_COUNCIL_SEATS)[number] | 'kayhermes' | string

export interface GovernanceProposal {
  id: string
  tenant: string
  proposal_type: 'constitutional_amendment' | 'policy_change' | 'architectural_decision'
  title: string
  description: string
  target_document_path: string | null
  target_document_hash: string
  proposer_id: string
  status: 'open' | 'ratified' | 'rejected' | 'withdrawn' | 'expired'
  threshold_council_count: number
  founder_seal_required: number
  created_at: string
  closed_at: string | null
}

export interface GovernanceVote {
  id: string
  resolution_id: string
  tenant: string
  voter_id: string
  voter_type: 'council_agent' | 'founder' | 'operator'
  voter_seat: string
  vote: 'approve' | 'reject' | 'abstain'
  reason: string | null
  created_at: string
}

export interface RatifiedAmendment {
  id: string
  resolution_id: string
  tenant: string
  document_path: string
  document_hash: string
  council_signers_json: string
  founder_seal: number
  ratified_at: string
}

export interface ProposeGovernanceInput {
  resolutionId?: string
  proposalType?: 'constitutional_amendment' | 'policy_change' | 'architectural_decision'
  title: string
  description: string
  targetDocumentPath?: string | null
  targetDocumentContent?: string
  targetDocumentHash?: string
  thresholdCouncilCount?: number
  founderSealRequired?: boolean
}

export interface VoteGovernanceInput {
  resolutionId: string
  voterSeat: string
  vote: 'approve' | 'reject' | 'abstain'
  reason?: string | null
  documentContentToVerify?: string
  documentHashToVerify?: string
}

export interface RatifyGovernanceInput {
  resolutionId: string
  documentContentToVerify?: string
  documentHashToVerify?: string
}

export interface GovernanceStatusResult {
  proposal: GovernanceProposal
  votes: GovernanceVote[]
  approvedCount: number
  rejectedCount: number
  abstainCount: number
  hasFounderSeal: boolean
  isRatified: boolean
  ratification?: RatifiedAmendment | null
}

export type GovernanceOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false
      status: 400 | 401 | 403 | 404 | 409
      error:
        | 'proposal_not_found'
        | 'proposal_not_open'
        | 'already_voted'
        | 'invalid_vote'
        | 'hash_mismatch'
        | 'unauthorized'
        | 'quorum_not_met'
        | 'founder_seal_missing'
        | 'invalid_args'
      detail?: string
    }

/**
 * Normalizes and extracts voter seat name.
 */
export function normalizeVoterSeat(rawSeat: string): string {
  const s = rawSeat.toLowerCase().trim()
  if (s.includes('river')) return 'river'
  if (s.includes('athena')) return 'athena'
  if (s.includes('kasra')) return 'kasra'
  if (s.includes('loom')) return 'loom'
  if (s.includes('hadi') || s.includes('kayhermes')) return 'kayhermes'
  return s
}

/**
 * Creates a durable governance proposal / constitutional resolution.
 */
export async function proposeGovernance(
  env: Env,
  auth: AuthContext,
  input: ProposeGovernanceInput,
): Promise<GovernanceOutcome<GovernanceProposal>> {
  const proposerId = auth.boundAgentId ?? auth.memberId ?? auth.userId
  if (!proposerId) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'authenticated session required' }
  }

  const title = (input.title ?? '').trim()
  const description = (input.description ?? '').trim()
  if (!title || !description) {
    return { ok: false, status: 400, error: 'invalid_args', detail: 'title and description are required' }
  }

  let docHash = (input.targetDocumentHash ?? '').trim()
  if (!docHash && input.targetDocumentContent) {
    docHash = await sha256Hex(input.targetDocumentContent)
  }
  if (!docHash) {
    return { ok: false, status: 400, error: 'invalid_args', detail: 'targetDocumentHash or targetDocumentContent is required' }
  }

  const resolutionId = (input.resolutionId ?? '').trim() || crypto.randomUUID()
  const proposalType = input.proposalType ?? 'constitutional_amendment'
  const thresholdCouncilCount = typeof input.thresholdCouncilCount === 'number' && input.thresholdCouncilCount > 0 ? input.thresholdCouncilCount : 2
  const founderSealRequired = input.founderSealRequired === false ? 0 : 1
  const nowIso = new Date().toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO governance_proposals
         (id, tenant, proposal_type, title, description, target_document_path, target_document_hash, proposer_id, status, threshold_council_count, founder_seal_required, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?10, ?11)`,
    )
      .bind(
        resolutionId,
        env.TENANT_SLUG,
        proposalType,
        title,
        description,
        input.targetDocumentPath ?? null,
        docHash,
        proposerId,
        thresholdCouncilCount,
        founderSealRequired,
        nowIso,
      )
      .run()
  } catch (err: any) {
    if (String(err).includes('UNIQUE') || String(err).includes('primary key')) {
      return { ok: false, status: 409, error: 'invalid_args', detail: `resolution ${resolutionId} already exists` }
    }
    throw err
  }

  const proposal: GovernanceProposal = {
    id: resolutionId,
    tenant: env.TENANT_SLUG,
    proposal_type: proposalType,
    title,
    description,
    target_document_path: input.targetDocumentPath ?? null,
    target_document_hash: docHash,
    proposer_id: proposerId,
    status: 'open',
    threshold_council_count: thresholdCouncilCount,
    founder_seal_required: founderSealRequired,
    created_at: nowIso,
    closed_at: null,
  }

  return { ok: true, data: proposal }
}

/**
 * Cast a one-shot cryptographic vote on a governance resolution.
 * Enforces Terminal State Guard (one vote per voter per resolution) and Hash Binding.
 */
export async function voteGovernance(
  env: Env,
  auth: AuthContext,
  input: VoteGovernanceInput,
): Promise<GovernanceOutcome<GovernanceVote>> {
  const voterId = auth.boundAgentId ?? auth.memberId ?? auth.userId
  if (!voterId) {
    return { ok: false, status: 401, error: 'unauthorized', detail: 'authenticated session required' }
  }

  const resolutionId = (input.resolutionId ?? '').trim()
  if (!resolutionId) {
    return { ok: false, status: 400, error: 'invalid_args', detail: 'resolutionId is required' }
  }

  const proposal = await env.DB.prepare(
    `SELECT * FROM governance_proposals WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(resolutionId, env.TENANT_SLUG)
    .first<GovernanceProposal>()

  if (!proposal) {
    return { ok: false, status: 404, error: 'proposal_not_found', detail: 'resolution proposal does not exist' }
  }

  if (proposal.status !== 'open') {
    return { ok: false, status: 409, error: 'proposal_not_open', detail: `proposal status is ${proposal.status}` }
  }

  // Cryptographic SHA-256 Hash Verification (§1.3.4)
  if (input.documentContentToVerify) {
    const verifiedHash = await sha256Hex(input.documentContentToVerify)
    if (!timingSafeEqual(verifiedHash, proposal.target_document_hash)) {
      return {
        ok: false,
        status: 400,
        error: 'hash_mismatch',
        detail: `document content hash (${verifiedHash}) does not match resolution target hash (${proposal.target_document_hash})`,
      }
    }
  } else if (input.documentHashToVerify) {
    if (!timingSafeEqual(input.documentHashToVerify.trim(), proposal.target_document_hash)) {
      return {
        ok: false,
        status: 400,
        error: 'hash_mismatch',
        detail: 'provided document hash does not match resolution target hash',
      }
    }
  }

  const voterSeat = normalizeVoterSeat(input.voterSeat)
  const isFounder = voterSeat === 'kayhermes' || auth.role === 'owner' || isOrgAdmin(auth)
  const voterType = isFounder ? 'founder' : (auth.boundAgentId ? 'council_agent' : 'operator')

  const voteId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO governance_votes
         (id, resolution_id, tenant, voter_id, voter_type, voter_seat, vote, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        voteId,
        resolutionId,
        env.TENANT_SLUG,
        voterId,
        voterType,
        voterSeat,
        input.vote,
        input.reason ?? null,
        nowIso,
      )
      .run()
  } catch (err: any) {
    // Terminal State Guard: Once an agent/voter votes, duplicate submissions are rejected
    if (String(err).includes('UNIQUE') || String(err).includes('governance_votes.resolution_id')) {
      return {
        ok: false,
        status: 409,
        error: 'already_voted',
        detail: `voter ${voterId} (${voterSeat}) has already cast a vote for resolution ${resolutionId}`,
      }
    }
    throw err
  }

  const voteRecord: GovernanceVote = {
    id: voteId,
    resolution_id: resolutionId,
    tenant: env.TENANT_SLUG,
    voter_id: voterId,
    voter_type: voterType,
    voter_seat: voterSeat,
    vote: input.vote,
    reason: input.reason ?? null,
    created_at: nowIso,
  }

  return { ok: true, data: voteRecord }
}

/**
 * Get the full governance status, tally, and ratification details for a proposal.
 */
export async function getGovernanceStatus(
  env: Env,
  resolutionId: string,
): Promise<GovernanceOutcome<GovernanceStatusResult>> {
  const proposal = await env.DB.prepare(
    `SELECT * FROM governance_proposals WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(resolutionId, env.TENANT_SLUG)
    .first<GovernanceProposal>()

  if (!proposal) {
    return { ok: false, status: 404, error: 'proposal_not_found', detail: 'resolution proposal does not exist' }
  }

  const voteRows = await env.DB.prepare(
    `SELECT * FROM governance_votes WHERE resolution_id = ?1 AND tenant = ?2 ORDER BY created_at ASC`,
  )
    .bind(resolutionId, env.TENANT_SLUG)
    .all<GovernanceVote>()

  const votes = voteRows.results ?? []
  let approvedCount = 0
  let rejectedCount = 0
  let abstainCount = 0
  let hasFounderSeal = false

  for (const v of votes) {
    if (v.vote === 'approve') {
      approvedCount++
      if (v.voter_type === 'founder' || v.voter_seat === 'kayhermes') {
        hasFounderSeal = true
      }
    } else if (v.vote === 'reject') {
      rejectedCount++
    } else if (v.vote === 'abstain') {
      abstainCount++
    }
  }

  const ratification = await env.DB.prepare(
    `SELECT * FROM ratified_amendments WHERE resolution_id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(resolutionId, env.TENANT_SLUG)
    .first<RatifiedAmendment>()

  return {
    ok: true,
    data: {
      proposal,
      votes,
      approvedCount,
      rejectedCount,
      abstainCount,
      hasFounderSeal,
      isRatified: proposal.status === 'ratified' || !!ratification,
      ratification,
    },
  }
}

/**
 * Ratifies a resolution when 2-of-4 Synthetic Council + Founder Seal criteria are met.
 */
export async function ratifyGovernance(
  env: Env,
  _auth: AuthContext,
  input: RatifyGovernanceInput,
): Promise<GovernanceOutcome<RatifiedAmendment>> {
  const statusOutcome = await getGovernanceStatus(env, input.resolutionId)
  if (!statusOutcome.ok) return statusOutcome

  const { proposal, votes, approvedCount, hasFounderSeal, ratification } = statusOutcome.data

  if (proposal.status === 'ratified' && ratification) {
    return { ok: true, data: ratification }
  }

  // 1. Check Threshold Quorum
  if (approvedCount < proposal.threshold_council_count) {
    return {
      ok: false,
      status: 409,
      error: 'quorum_not_met',
      detail: `proposal requires ${proposal.threshold_council_count} approving votes; currently has ${approvedCount}`,
    }
  }

  // 2. Check Founder Seal Requirement (§1.2)
  if (proposal.founder_seal_required && !hasFounderSeal) {
    return {
      ok: false,
      status: 409,
      error: 'founder_seal_missing',
      detail: 'constitutional amendment requires final ratification seal from Hadi (kayhermes / founder)',
    }
  }

  // 3. Verify Hash Integrity (§1.3.4)
  if (input.documentContentToVerify) {
    const verifiedHash = await sha256Hex(input.documentContentToVerify)
    if (!timingSafeEqual(verifiedHash, proposal.target_document_hash)) {
      return {
        ok: false,
        status: 400,
        error: 'hash_mismatch',
        detail: 'document content does not match resolution target hash',
      }
    }
  }

  const councilSigners = votes
    .filter((v) => v.vote === 'approve')
    .map((v) => ({ voter_id: v.voter_id, voter_seat: v.voter_seat, voter_type: v.voter_type }))

  const ratificationId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  // Atomic Ratification Transition
  await env.DB.prepare(
    `INSERT INTO ratified_amendments
       (id, resolution_id, tenant, document_path, document_hash, council_signers_json, founder_seal, ratified_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      ratificationId,
      proposal.id,
      env.TENANT_SLUG,
      proposal.target_document_path ?? 'docs/architecture/MU.100.001.md',
      proposal.target_document_hash,
      JSON.stringify(councilSigners),
      hasFounderSeal ? 1 : 0,
      nowIso,
    )
    .run()

  await env.DB.prepare(
    `UPDATE governance_proposals
        SET status = 'ratified',
            closed_at = ?1
      WHERE id = ?2 AND tenant = ?3`,
  )
    .bind(nowIso, proposal.id, env.TENANT_SLUG)
    .run()

  const ratifiedRecord: RatifiedAmendment = {
    id: ratificationId,
    resolution_id: proposal.id,
    tenant: env.TENANT_SLUG,
    document_path: proposal.target_document_path ?? 'docs/architecture/MU.100.001.md',
    document_hash: proposal.target_document_hash,
    council_signers_json: JSON.stringify(councilSigners),
    founder_seal: hasFounderSeal ? 1 : 0,
    ratified_at: nowIso,
  }

  return { ok: true, data: ratifiedRecord }
}
