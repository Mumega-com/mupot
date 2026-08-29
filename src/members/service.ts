// mupot — shared members service (token mint / revoke / list).
//
// This is the single token-lifecycle path. Both the JSON API (src/members) and the
// server-rendered dashboard (src/dashboard) call these instead of hand-writing the
// same SQL twice. Keeping mint/revoke here means the SECURITY DISCIPLINE lives in
// one place: tokens are stored HASHED, the raw is returned EXACTLY ONCE at mint and
// never logged or persisted, and revoke is idempotent (only flips live tokens).
//
// mintAgentBoundToken — the AGENT-BOUND mint path (shared between the MCP provision
// tool and the dashboard /admin/agent-token route). It is the ONLY place the first-
// mint atomic batch (member envelope + canonical binding + escalation-guard capability
// + agent-weld token) is written, so no logic lives in two places.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, MemberToken, ConnectionChannel, Capability, CapabilityGrant } from '../types'
import { assertBatchWritten, rowsWritten } from '../lib/receipt'
import {
  calculateExpiryTimestamp,
  DEFAULT_TOKEN_EXPIRY_DAYS,
  nowSqlUtc,
  TOKEN_LIVE_PREDICATE,
} from '../auth/token-lifecycle'

const CHANNELS: readonly ConnectionChannel[] = ['workspace', 'im', 'dashboard']
export function isChannel(v: unknown): v is ConnectionChannel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
}

const AGENT_TOKEN_CAPABILITIES = ['observer', 'member'] as const
export type AgentTokenCapability = (typeof AGENT_TOKEN_CAPABILITIES)[number]

export function isAgentTokenCapability(v: unknown): v is AgentTokenCapability {
  return typeof v === 'string' && (AGENT_TOKEN_CAPABILITIES as readonly string[]).includes(v)
}

/** SHA-256 hex of a raw token. Stored value; the raw is never persisted.
 *  Exported for the one flow that mints inside a larger atomic D1 batch
 *  (invite accept) — everything else goes through mintMemberToken(). */
export async function sha256Hex(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Dedicated secret binding for public, non-reversible member-token fingerprints.
 *  It is intentionally not optional and has no fallback to any other Worker secret. */
export interface MemberTokenFingerprintEnv extends Env {
  MEMBER_TOKEN_FINGERPRINT_SECRET: string
}

export class MemberTokenFingerprintError extends Error {
  readonly name = 'MemberTokenFingerprintError'
  readonly code = 'fingerprint_not_configured' as const
}

/**
 * Derive a versioned public fingerprint from the server-stored token hash.
 * The stored hash is HMAC input only: it is never returned or embedded verbatim.
 */
export async function deriveSafeMemberTokenFingerprint(
  env: MemberTokenFingerprintEnv,
  tokenHash: string,
): Promise<string> {
  const secret = env.MEMBER_TOKEN_FINGERPRINT_SECRET
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new MemberTokenFingerprintError('fingerprint_not_configured')
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`mupot:member-token-fingerprint:v1:${tokenHash}`),
  )
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `v1:${hex}`
}

/** Cryptographically-random opaque token (URL-safe hex). Shown once, never stored raw.
 *  Exported for the invite-accept atomic batch; everything else uses mintMemberToken(). */
export function mintRawToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return `mupot_${s}`
}

export interface MintedToken {
  id: string
  member_id: string
  label: string
  channel: ConnectionChannel
  created_at: string
  expires_at?: string | null
  /** The raw token — returned EXACTLY ONCE. Never persisted, never logged. */
  raw: string
}

/** Mint a scoped token for a member. Persists only the hash; returns the raw once.
 *  Caller MUST have already gated on admin (this layer does no authz). */
export async function mintMemberToken(
  env: Env,
  memberId: string,
  label: string,
  channel: ConnectionChannel,
  agentId: string | null = null,
  expiresAt: string | null = null,
): Promise<MintedToken> {
  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const token: Omit<MemberToken, 'token_hash'> = {
    id: crypto.randomUUID(),
    tenant: env.TENANT_SLUG,
    member_id: memberId,
    label: label.trim(),
    channel,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    revoked_at: null,
  }

  // agent_id binds this token to an agent (the weld). NULL = a human/operator principal.
  await env.DB.prepare(
    'INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(token.id, token.member_id, tokenHash, token.label, token.channel, token.created_at, agentId, token.tenant, token.expires_at ?? null)
    .run()

  return {
    id: token.id,
    member_id: token.member_id,
    label: token.label,
    channel: token.channel,
    created_at: token.created_at,
    expires_at: token.expires_at,
    raw: rawToken,
  }
}

/** Revoke a token, but only if it belongs to the member AND is still live.
 *  Returns true when a live token was revoked, false otherwise (idempotent). */
export async function revokeMemberToken(
  env: Env,
  memberId: string,
  tokenId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND tenant = ? AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), tokenId, memberId, env.TENANT_SLUG)
    .run()
  return Boolean(res.meta && res.meta.changes > 0)
}

/** A token row WITHOUT its hash — safe to render (id, label, channel, lifecycle). */
export interface PublicMemberToken {
  id: string
  member_id: string
  label: string
  channel: ConnectionChannel
  created_at: string
  revoked_at: string | null
}

// ── agent-bound mint (shared) ─────────────────────────────────────────────────

/** The agent row shape mintAgentBoundToken needs (resolved from agents table). */
export interface AgentForMint {
  id: string
  squad_id: string
  slug: string
  name: string
}

/** What the agent-bound mint returns. raw is the show-once plaintext. */
export interface AgentMintResult {
  raw: string
  tokenId: string
  memberId: string
  label: string
  createdAt: string
  grantCapability: AgentTokenCapability
  bindingDisposition: 'created' | 'reused'
}

export type AgentMemberBinding =
  | { kind: 'bound'; memberId: string }
  | { kind: 'unminted' }

export interface AgentBindingProof {
  agentId: string
  memberId: string
  homeSquadId: string
  disposition: 'creating' | 'existing'
}

export interface PreparedAgentTokenMint extends AgentMintResult {
  statements: D1PreparedStatement[]
  bindingProof: AgentBindingProof
  replacementTokenId: string | null
  label: string
  expiresAt: string | null
}

export interface PrepareAgentTokenMintOptions {
  grantCapability?: AgentTokenCapability
  expiresAt?: string | null
  revokePriorTokenId?: string | null
}

export interface AgentTokenReplacementClaim {
  claimId: string
  fingerprint: string
  expiresAt: string
  mintedByMemberId: string
}

export interface AgentTokenReplacementHandoff {
  id: string
  tenant: string
  agentId: string
  memberId: string
  priorTokenId: string
  replacementTokenId: string
  claim: AgentTokenReplacementClaim
  auditState: 'pending' | 'sent'
  state: 'pending' | 'active'
  createdAt: string
  activatedAt: string | null
}

export interface AgentTokenReplacementMetadata {
  label: string
  channel: ConnectionChannel
  capability: AgentTokenCapability
  createdAt: string
}

/** Intentionally opaque to callers: a replacement identifier is never an ownership oracle. */
export class AgentTokenReplacementError extends Error {
  readonly code = 'replacement_token_unavailable' as const

  constructor() {
    super('replacement_token_unavailable')
    this.name = 'AgentTokenReplacementError'
  }
}

function replacementLivePredicate(alias: string, nowParam: string): string {
  return TOKEN_LIVE_PREDICATE(nowParam).replaceAll('t.', `${alias}.`)
}

async function assertLiveReplacementToken(
  env: Env,
  agentId: string,
  memberId: string,
  tokenId: string,
): Promise<void> {
  const prior = await env.DB.prepare(
    `SELECT t.id FROM member_tokens t
      WHERE t.id = ? AND t.member_id = ? AND t.agent_id = ? AND t.tenant = ?
        AND ${replacementLivePredicate('t', '?')}
      LIMIT 1`,
  )
    .bind(tokenId, memberId, agentId, env.TENANT_SLUG, nowSqlUtc())
    .first<{ id: string }>()
  if (!prior) throw new AgentTokenReplacementError()
}

/** Revalidate the exact tenant/member/agent prior bound to a durable handoff. */
export async function assertAgentTokenReplacementPriorLive(
  env: Env,
  handoff: AgentTokenReplacementHandoff,
): Promise<void> {
  await assertLiveReplacementToken(env, handoff.agentId, handoff.memberId, handoff.priorTokenId)
}

/** Resume against the credential that must be live for the handoff's durable
 * state. Pending handoffs still depend on their prior; active handoffs have
 * intentionally revoked that prior and depend on the committed replacement. */
export async function assertAgentTokenReplacementResumeLive(
  env: Env,
  handoff: AgentTokenReplacementHandoff,
): Promise<void> {
  const tokenId = handoff.state === 'active'
    ? handoff.replacementTokenId
    : handoff.priorTokenId
  await assertLiveReplacementToken(env, handoff.agentId, handoff.memberId, tokenId)
}

/**
 * Prepare, but do not commit, an agent-bound token mint. Provisioning composes
 * these statements into its larger request/receipt transaction.
 */
export async function prepareAgentBoundTokenMint(
  env: Env,
  agent: AgentForMint,
  label: string,
  grantCapabilityOrOpts?: AgentTokenCapability | PrepareAgentTokenMintOptions,
): Promise<PreparedAgentTokenMint> {
  const opts: PrepareAgentTokenMintOptions = typeof grantCapabilityOrOpts === 'object' && grantCapabilityOrOpts !== null
    ? grantCapabilityOrOpts
    : { grantCapability: (grantCapabilityOrOpts as AgentTokenCapability) ?? 'member' }

  const grantCapability = opts.grantCapability ?? 'member'
  if (!isAgentTokenCapability(grantCapability)) {
    throw new Error('invalid agent token capability')
  }
  if (opts.revokePriorTokenId !== undefined && opts.revokePriorTokenId !== null && opts.revokePriorTokenId.trim().length === 0) {
    throw new AgentTokenReplacementError()
  }

  const binding = await resolveAgentMemberBinding(env, agent.id)
  return prepareAgentBoundTokenMintForBinding(env, agent, label, grantCapability, binding, opts.expiresAt, opts.revokePriorTokenId)
}

export async function prepareAgentBoundTokenMintForBinding(
  env: Env,
  agent: AgentForMint,
  label: string,
  requestedCapability: AgentTokenCapability,
  binding: AgentMemberBinding,
  expiresAt: string | null = calculateExpiryTimestamp(DEFAULT_TOKEN_EXPIRY_DAYS),
  revokePriorTokenId: string | null = null,
): Promise<PreparedAgentTokenMint> {
  const creating = binding.kind === 'unminted'
  const memberId = creating ? crypto.randomUUID() : binding.memberId
  let grantCapability = requestedCapability

  if (!creating) {
    // TWO SEPARATE QUESTIONS — do not merge them back together (mupot#890).
    //
    //   1. PRECONDITION: does the canonical member hold a home-squad grant at all?
    //      Any capability satisfies this. Its absence means the identity is
    //      incomplete and must not be issued a token.
    //
    //   2. CLAMP: what capability may this TOKEN record? Never above 'member'.
    //
    // Filtering the SELECT by IN ('observer','member') collapsed the two, and
    // `capabilities` is UNIQUE(member_id, scope_type, scope_id) — one row per
    // scope. So raising a member's home grant to lead/admin/owner REPLACES the
    // 'member' row, the SELECT returns nothing, and the mint throws. That made
    // every lead-holding agent permanently unmintable: recovery needed an
    // operator principal to downgrade first, so no agent could self-recover.
    // LIMIT 1 with no ORDER BY is deterministic ONLY because
    // migrations/0002_members.sql:36 declares UNIQUE(member_id, scope_type, scope_id)
    // — at most one row can match. If that constraint is ever relaxed this silently
    // becomes "whichever row SQLite reaches first"; add an explicit ordering then.
    // (Athena, gate on #891.)
    const committed = await env.DB.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ?
          AND scope_type = 'squad'
          AND scope_id = ?
        LIMIT 1`,
    )
      .bind(memberId, agent.squad_id)
      .first<{ capability: string }>()
    if (!committed) {
      throw new Error(
        'agent_home_capability_missing: canonical agent member has no home-squad grant',
      )
    }
    // The escalation guard is unchanged and still absolute: AGENT_TOKEN_CAPABILITIES
    // is ['observer','member'], so a higher home grant clamps DOWN to 'member' and
    // can never widen what the token carries.
    grantCapability = isAgentTokenCapability(committed.capability)
      ? committed.capability
      : 'member'
  }

  // Check the exact ownership/liveness predicate before creating any secret material.
  // The INSERT below repeats the same predicate inside the D1 batch so a concurrent
  // replacement has exactly one durable winner.
  if (revokePriorTokenId) {
    if (creating) throw new AgentTokenReplacementError()
    await assertLiveReplacementToken(env, agent.id, memberId, revokePriorTokenId)
  }

  const tokenId = crypto.randomUUID()
  const rawToken = mintRawToken()
  const tokenHash = await sha256Hex(rawToken)
  const createdAt = new Date().toISOString()
  const safeLabel = label.trim().slice(0, 64) || agent.slug
  const statements: D1PreparedStatement[] = []

  if (creating) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(memberId, null, agent.name, null, 'active', createdAt, env.TENANT_SLUG),
      env.DB.prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(env.TENANT_SLUG, agent.id, memberId, createdAt),
      env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES (?, ?, 'squad', ?, ?)`,
      ).bind(crypto.randomUUID(), memberId, agent.squad_id, grantCapability),
    )
  }

  // A rotation inserts the replacement only while the named prior token remains
  // live and welded to this exact agent/member. This predicate is deliberately in
  // the database transaction (not merely the preflight above): after one batch
  // revokes the prior token, every concurrent loser inserts zero rows and commits
  // no replacement credential or claim.
  if (revokePriorTokenId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
         SELECT ?, ?, ?, ?, 'workspace', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM member_tokens prior
             WHERE prior.id = ? AND prior.member_id = ? AND prior.agent_id = ? AND prior.tenant = ?
               AND ${replacementLivePredicate('prior', '?')}
          )`,
      ).bind(
        tokenId,
        memberId,
        tokenHash,
        safeLabel,
        createdAt,
        agent.id,
        env.TENANT_SLUG,
        expiresAt ?? null,
        revokePriorTokenId,
        memberId,
        agent.id,
        env.TENANT_SLUG,
        nowSqlUtc(),
      ),
      env.DB.prepare(
        `UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND member_id = ? AND agent_id = ? AND tenant = ?
          AND ${replacementLivePredicate('member_tokens', '?')}`,
      ).bind(createdAt, revokePriorTokenId, memberId, agent.id, env.TENANT_SLUG, nowSqlUtc()),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
         VALUES (?, ?, ?, ?, 'workspace', ?, ?, ?, ?)`,
      ).bind(tokenId, memberId, tokenHash, safeLabel, createdAt, agent.id, env.TENANT_SLUG, expiresAt ?? null),
    )
  }

  // D2 (2026-08-13, athena gate cluster map 247858f1; Hadi decision option A
  // "make it smooth now, tighten later"): the agent's OWN LANE gate is part of
  // the identity weld — one atomic batch, so the grant can never silently miss
  // a mint (BLOCK-4 re-baseline: this replaces the post-commit grant call that
  // broke the batch contract). Because this lives in the shared prepare, every
  // mint path gets it: mint_agent_token, provision_agent_connection, and
  // bootstrap_self (kasra-review P2). The upsert keeps re-mints idempotent
  // AND always reports a written row (assertBatchWritten contract); granted_by='system:mint'
  // marks it a system grant in the D3 audit trail. NOTE: gate:agent-self-completion is
  // deliberately NOT granted here — the verdict route treats that gate as assignee-or-org-admin only,
  // so a universal grant would be a dead authority surface (BLOCK-1, kasra-review).
  if (!revokePriorTokenId) {
    statements.push(
      env.DB.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, 'agent', ?, 'system:mint', ?)
       ON CONFLICT (capability, principal_type, principal_id) DO UPDATE SET created_at = created_at`,
      ).bind(crypto.randomUUID(), `gate:${agent.slug}`, agent.id, createdAt),
    )
  }

  return {
    raw: rawToken,
    tokenId,
    memberId,
    createdAt,
    grantCapability,
    statements,
    replacementTokenId: revokePriorTokenId,
    label: safeLabel,
    expiresAt,
    bindingDisposition: creating ? 'created' : 'reused',
    bindingProof: {
      agentId: agent.id,
      memberId,
      homeSquadId: agent.squad_id,
      disposition: creating ? 'creating' : 'existing',
    },
  }
}

export function agentIdentityConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('agent_identity_conflict')
    || (
      error.message.includes('UNIQUE constraint failed')
      && error.message.includes('agent_member_bindings')
    )
}

async function commitPreparedAgentTokenMint(
  env: Env,
  prepared: PreparedAgentTokenMint,
): Promise<AgentMintResult> {
  const writes = await env.DB.batch(prepared.statements)
  try {
    assertBatchWritten(writes, 'mint_agent_bound_token', 1)
  } catch (error) {
    if (prepared.replacementTokenId) throw new AgentTokenReplacementError()
    throw error
  }
  return {
    raw: prepared.raw,
    tokenId: prepared.tokenId,
    memberId: prepared.memberId,
    label: prepared.label,
    createdAt: prepared.createdAt,
    grantCapability: prepared.grantCapability,
    bindingDisposition: prepared.bindingDisposition,
  }
}

/**
 * Atomically mint a dedicated member envelope, immutable agent/member binding,
 * home-squad capability, and agent-weld token for `agent`.
 *
 * SECURITY INVARIANTS:
 *   - FIRST MINT: FOUR ROWS, ONE BATCH — all land or none do.
 *   - LATER MINTS: token only; the canonical member and home grant are reused.
 *   - THE ESCALATION GUARD: the grant is hard-coded to scope_type='squad',
 *     scope_id=agent.squad_id, and capability <= 'member'.  Callers may lower it
 *     to 'observer', but can never widen it to lead/admin/owner or another scope.
 *   - THE WELD: member_tokens.agent_id = agent.id (binds the token to the agent).
 *   - Raw shown once; only the hash is stored. Never logged, never re-derivable.
 *
 * Caller MUST have already gated on org-admin (this layer does no authz).
 * Caller MUST have already resolved and validated `agent` from the pot's own D1.
 */
export async function mintAgentBoundToken(
  env: Env,
  agent: AgentForMint,
  label: string,
  grantCapabilityOrOpts?: AgentTokenCapability | PrepareAgentTokenMintOptions,
): Promise<AgentMintResult> {
  const opts: PrepareAgentTokenMintOptions = typeof grantCapabilityOrOpts === 'object' && grantCapabilityOrOpts !== null
    ? grantCapabilityOrOpts
    : { grantCapability: (grantCapabilityOrOpts as AgentTokenCapability) ?? 'member' }

  const grantCapability = opts.grantCapability ?? 'member'
  const first = await prepareAgentBoundTokenMint(env, agent, label, opts)
  try {
    return await commitPreparedAgentTokenMint(env, first)
  } catch (error) {
    if (!agentIdentityConflict(error)) throw error

    // A concurrent first mint won the immutable binding. The losing raw token
    // is discarded and never returned. Read the winner once, mint a fresh raw,
    // and retry exactly once; any second conflict propagates.
    const winner = await resolveAgentMemberBinding(env, agent.id)
    if (winner.kind === 'unminted') throw error
    const retry = await prepareAgentBoundTokenMintForBinding(
      env,
      agent,
      label,
      grantCapability,
      winner,
      opts.expiresAt,
      opts.revokePriorTokenId,
    )
    return commitPreparedAgentTokenMint(env, retry)
  }
}

/**
 * Build a replacement token after ownership/liveness preflight, but do not make
 * either credential live. The MCP handoff stores its claim/outbox state before
 * calling stageAgentTokenReplacement, so a KV failure cannot revoke the prior.
 */
export async function prepareAgentTokenReplacement(
  env: Env,
  agent: AgentForMint,
  label: string,
  opts: Omit<PrepareAgentTokenMintOptions, 'revokePriorTokenId'> & { revokePriorTokenId: string },
): Promise<PreparedAgentTokenMint> {
  if (opts.revokePriorTokenId.trim().length === 0) throw new AgentTokenReplacementError()
  const grantCapability = opts.grantCapability ?? 'member'
  if (!isAgentTokenCapability(grantCapability)) throw new Error('invalid agent token capability')
  const binding = await resolveAgentMemberBinding(env, agent.id)
  if (binding.kind === 'unminted') throw new AgentTokenReplacementError()
  await assertLiveReplacementToken(env, agent.id, binding.memberId, opts.revokePriorTokenId)
  const prepared = await prepareAgentBoundTokenMintForBinding(
    env,
    agent,
    label,
    grantCapability,
    binding,
    opts.expiresAt,
  )
  return { ...prepared, replacementTokenId: opts.revokePriorTokenId }
}

function rowToReplacementHandoff(row: {
  id: string
  tenant: string
  agent_id: string
  member_id: string
  prior_token_id: string
  replacement_token_id: string
  claim_id: string
  claim_fingerprint: string
  claim_expires_at: string
  minted_by_member_id: string
  audit_state: 'pending' | 'sent'
  state: 'pending' | 'active'
  created_at: string
  activated_at: string | null
}): AgentTokenReplacementHandoff {
  return {
    id: row.id,
    tenant: row.tenant,
    agentId: row.agent_id,
    memberId: row.member_id,
    priorTokenId: row.prior_token_id,
    replacementTokenId: row.replacement_token_id,
    claim: {
      claimId: row.claim_id,
      fingerprint: row.claim_fingerprint,
      expiresAt: row.claim_expires_at,
      mintedByMemberId: row.minted_by_member_id,
    },
    auditState: row.audit_state,
    state: row.state,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  }
}

export async function findAgentTokenReplacementHandoff(
  env: Env,
  agentId: string,
  priorTokenId: string,
): Promise<AgentTokenReplacementHandoff | null> {
  const row = await env.DB.prepare(
    `SELECT id, tenant, agent_id, member_id, prior_token_id, replacement_token_id,
            claim_id, claim_fingerprint, claim_expires_at, minted_by_member_id,
            audit_state, state, created_at, activated_at
       FROM agent_token_rotation_handoffs
      WHERE tenant = ? AND agent_id = ? AND prior_token_id = ?
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId, priorTokenId).first<{
    id: string
    tenant: string
    agent_id: string
    member_id: string
    prior_token_id: string
    replacement_token_id: string
    claim_id: string
    claim_fingerprint: string
    claim_expires_at: string
    minted_by_member_id: string
    audit_state: 'pending' | 'sent'
    state: 'pending' | 'active'
    created_at: string
    activated_at: string | null
  }>()
  return row ? rowToReplacementHandoff(row) : null
}

export async function stageAgentTokenReplacement(
  env: Env,
  agent: AgentForMint,
  prepared: PreparedAgentTokenMint,
  claim: AgentTokenReplacementClaim,
): Promise<AgentTokenReplacementHandoff> {
  const priorTokenId = prepared.replacementTokenId
  if (!priorTokenId) throw new AgentTokenReplacementError()
  const handoffId = crypto.randomUUID()
  const now = nowSqlUtc()
  const livePrior = replacementLivePredicate('prior', '?')
  let writes
  try {
    writes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, revoked_at)
       SELECT ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM member_tokens prior
           WHERE prior.id = ? AND prior.member_id = ? AND prior.agent_id = ? AND prior.tenant = ?
             AND ${livePrior}
        )`,
    ).bind(
      prepared.tokenId,
      prepared.memberId,
      await sha256Hex(prepared.raw),
      prepared.label,
      prepared.createdAt,
      agent.id,
      env.TENANT_SLUG,
      prepared.expiresAt,
      prepared.createdAt,
      priorTokenId,
      prepared.memberId,
      agent.id,
      env.TENANT_SLUG,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO agent_token_rotation_handoffs (
        id, tenant, agent_id, member_id, prior_token_id, replacement_token_id,
        minted_by_member_id, claim_id, claim_fingerprint, claim_expires_at, created_at
      )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM member_tokens prior
           WHERE prior.id = ? AND prior.member_id = ? AND prior.agent_id = ? AND prior.tenant = ?
             AND ${livePrior}
        )`,
    ).bind(
      handoffId,
      env.TENANT_SLUG,
      agent.id,
      prepared.memberId,
      priorTokenId,
      prepared.tokenId,
      claim.mintedByMemberId,
      claim.claimId,
      claim.fingerprint,
      claim.expiresAt,
      prepared.createdAt,
      priorTokenId,
      prepared.memberId,
      agent.id,
      env.TENANT_SLUG,
      now,
    ),
    ])
  } catch (error) {
    if (
      error instanceof Error
      && /UNIQUE constraint failed:\s*agent_token_rotation_handoffs\./i.test(error.message)
    ) {
      throw new AgentTokenReplacementError()
    }
    throw error
  }
  if (writes.length === 2 && writes.every((write) => rowsWritten(write) === 0)) {
    throw new AgentTokenReplacementError()
  }
  assertBatchWritten(writes, 'stage_agent_token_replacement', 1)
  return {
    id: handoffId,
    tenant: env.TENANT_SLUG,
    agentId: agent.id,
    memberId: prepared.memberId,
    priorTokenId,
    replacementTokenId: prepared.tokenId,
    claim,
    auditState: 'pending',
    state: 'pending',
    createdAt: prepared.createdAt,
    activatedAt: null,
  }
}

/** Reload response metadata from the committed replacement row and canonical
 * home-squad capability. Retry request arguments are never response truth. */
export async function loadAgentTokenReplacementMetadata(
  env: Env,
  handoffId: string,
): Promise<AgentTokenReplacementMetadata> {
  const row = await env.DB.prepare(
    `SELECT t.label AS replacement_label,
            t.channel AS replacement_channel,
            t.created_at AS replacement_created_at,
            c.capability AS binding_capability
       FROM agent_token_rotation_handoffs h
       JOIN member_tokens t
         ON t.id = h.replacement_token_id
        AND t.tenant = h.tenant
        AND t.member_id = h.member_id
        AND t.agent_id = h.agent_id
       JOIN agents a ON a.id = h.agent_id
       JOIN capabilities c
         ON c.member_id = h.member_id
        AND c.scope_type = 'squad'
        AND c.scope_id = a.squad_id
      WHERE h.id = ? AND h.tenant = ?
      LIMIT 1`,
  ).bind(handoffId, env.TENANT_SLUG).first<{
    replacement_label: string
    replacement_channel: string
    replacement_created_at: string
    binding_capability: string
  }>()
  if (!row || !isChannel(row.replacement_channel)) {
    throw new Error('replacement_metadata_unavailable')
  }
  return {
    label: row.replacement_label,
    channel: row.replacement_channel,
    capability: isAgentTokenCapability(row.binding_capability) ? row.binding_capability : 'member',
    createdAt: row.replacement_created_at,
  }
}

/** Remove an inactive reservation after its KV claim is known unavailable.
 * The caller must burn the claim key first; D1 then removes the durable
 * reservation and inactive token atomically. Audit-sent is accepted so a
 * pre-fix handoff stranded after BUS delivery can also recover. */
export async function cancelAgentTokenReplacementReservation(
  env: Env,
  handoff: AgentTokenReplacementHandoff,
): Promise<void> {
  const writes = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM agent_token_rotation_handoffs
        WHERE id = ? AND tenant = ? AND state = 'pending' AND audit_state IN ('pending', 'sent')
          AND claim_state IN ('pending', 'ready')`,
    ).bind(handoff.id, env.TENANT_SLUG),
    env.DB.prepare(
      `DELETE FROM member_tokens
        WHERE id = ? AND tenant = ? AND member_id = ? AND agent_id = ? AND revoked_at = ?`,
    ).bind(
      handoff.replacementTokenId,
      env.TENANT_SLUG,
      handoff.memberId,
      handoff.agentId,
      handoff.createdAt,
    ),
  ])
  assertBatchWritten(writes, 'cancel_agent_token_replacement_reservation', 1)
}

export async function isAgentTokenReplacementClaimReady(env: Env, handoffId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT claim_state FROM agent_token_rotation_handoffs WHERE id = ? AND tenant = ? LIMIT 1`,
  ).bind(handoffId, env.TENANT_SLUG).first<{ claim_state: 'pending' | 'ready' }>()
  return row?.claim_state === 'ready'
}

export async function markAgentTokenReplacementClaimReady(
  env: Env,
  handoffId: string,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE agent_token_rotation_handoffs
        SET claim_state = 'ready'
      WHERE id = ? AND tenant = ? AND state = 'pending' AND audit_state = 'pending' AND claim_state = 'pending'`,
  ).bind(handoffId, env.TENANT_SLUG).run()
  if ((result.meta?.changes ?? 0) === 1) return
  if (await isAgentTokenReplacementClaimReady(env, handoffId)) return
  throw new AgentTokenReplacementError()
}

export async function markAgentTokenReplacementAuditSent(
  env: Env,
  handoffId: string,
): Promise<AgentTokenReplacementHandoff> {
  const result = await env.DB.prepare(
    `UPDATE agent_token_rotation_handoffs
        SET audit_state = 'sent'
      WHERE id = ? AND tenant = ? AND state = 'pending'
        AND audit_state = 'pending' AND claim_state = 'ready'`,
  ).bind(handoffId, env.TENANT_SLUG).run()
  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare(
      `SELECT id, tenant, agent_id, member_id, prior_token_id, replacement_token_id,
              claim_id, claim_fingerprint, claim_expires_at, minted_by_member_id,
              claim_state, audit_state, state, created_at, activated_at
         FROM agent_token_rotation_handoffs WHERE id = ? AND tenant = ? LIMIT 1`,
    ).bind(handoffId, env.TENANT_SLUG).first<{
      id: string; tenant: string; agent_id: string; member_id: string; prior_token_id: string; replacement_token_id: string
      claim_id: string; claim_fingerprint: string; claim_expires_at: string; minted_by_member_id: string
      claim_state: 'pending' | 'ready'
      audit_state: 'pending' | 'sent'; state: 'pending' | 'active'; created_at: string; activated_at: string | null
    }>()
    if (existing?.audit_state === 'sent' && existing.claim_state === 'ready') return rowToReplacementHandoff(existing)
    throw new AgentTokenReplacementError()
  }
  const row = await env.DB.prepare(
    `SELECT id, tenant, agent_id, member_id, prior_token_id, replacement_token_id,
            claim_id, claim_fingerprint, claim_expires_at, minted_by_member_id,
            claim_state, audit_state, state, created_at, activated_at
       FROM agent_token_rotation_handoffs WHERE id = ? AND tenant = ? LIMIT 1`,
  ).bind(handoffId, env.TENANT_SLUG).first<{
    id: string; tenant: string; agent_id: string; member_id: string; prior_token_id: string; replacement_token_id: string
    claim_id: string; claim_fingerprint: string; claim_expires_at: string; minted_by_member_id: string
    claim_state: 'pending' | 'ready'
    audit_state: 'pending' | 'sent'; state: 'pending' | 'active'; created_at: string; activated_at: string | null
  }>()
  if (!row) throw new AgentTokenReplacementError()
  return rowToReplacementHandoff(row)
}

export async function activateAgentTokenReplacement(
  env: Env,
  handoffId: string,
): Promise<AgentTokenReplacementHandoff> {
  const activatedAt = nowSqlUtc()
  const result = await env.DB.prepare(
    `UPDATE agent_token_rotation_handoffs
        SET state = 'active', activated_at = ?
      WHERE id = ? AND tenant = ? AND state = 'pending'
        AND audit_state = 'sent' AND claim_state = 'ready'`,
  ).bind(activatedAt, handoffId, env.TENANT_SLUG).run()
  if ((result.meta?.changes ?? 0) === 0) throw new AgentTokenReplacementError()
  const row = await env.DB.prepare(
    `SELECT id, tenant, agent_id, member_id, prior_token_id, replacement_token_id,
            claim_id, claim_fingerprint, claim_expires_at, minted_by_member_id,
            audit_state, state, created_at, activated_at
       FROM agent_token_rotation_handoffs WHERE id = ? AND tenant = ? LIMIT 1`,
  ).bind(handoffId, env.TENANT_SLUG).first<{
    id: string; tenant: string; agent_id: string; member_id: string; prior_token_id: string; replacement_token_id: string
    claim_id: string; claim_fingerprint: string; claim_expires_at: string; minted_by_member_id: string
    audit_state: 'pending' | 'sent'; state: 'pending' | 'active'; created_at: string; activated_at: string | null
  }>()
  if (!row) throw new AgentTokenReplacementError()
  return rowToReplacementHandoff(row)
}

/** Live (non-revoked) tokens for every member — for the dashboard roster. The
 *  hash is NEVER selected. */
export async function loadLiveTokens(env: Env): Promise<PublicMemberToken[]> {
  const rows = await env.DB.prepare(
    'SELECT id, member_id, label, channel, created_at, revoked_at FROM member_tokens WHERE tenant = ? AND revoked_at IS NULL ORDER BY created_at ASC',
  ).bind(env.TENANT_SLUG).all<PublicMemberToken>()
  return rows.results ?? []
}

/** Resolve the immutable member identity bound to an agent. */
export async function resolveAgentMemberBinding(
  env: Env,
  agentId: string,
): Promise<AgentMemberBinding> {
  const row = await env.DB.prepare(
    `SELECT b.member_id
       FROM agent_member_bindings b
       JOIN members m
         ON m.id = b.member_id
        AND m.tenant = b.tenant
      WHERE b.tenant = ?
        AND b.agent_id = ?
        AND m.status = 'active'
      LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<{ member_id: string }>()

  return row ? { kind: 'bound', memberId: row.member_id } : { kind: 'unminted' }
}

/**
 * Compatibility wrapper for callers not yet migrated to the structured result.
 * `ambiguous` remains in the return type until those interfaces are cut over,
 * but the canonical binding schema cannot produce a new ambiguous identity.
 */
export async function resolveActiveAgentMember(
  env: Env,
  agentId: string,
): Promise<string | 'unminted' | 'ambiguous'> {
  const binding = await resolveAgentMemberBinding(env, agentId)
  return binding.kind === 'bound' ? binding.memberId : 'unminted'
}

export interface CapabilityGrantUpsertOutcome {
  grant: CapabilityGrant
  result: 'created' | 'updated' | 'unchanged'
}

/** Replace a member's grant on one scope and report the transaction's actual prior state. */
export async function upsertCapabilityGrant(
  env: Env,
  grant: CapabilityGrant,
): Promise<CapabilityGrantUpsertOutcome> {
  const deleteStmt = grant.scope_id === null
    ? env.DB.prepare(
        `DELETE FROM capabilities
          WHERE member_id = ? AND scope_type = ? AND scope_id IS NULL
        RETURNING capability`,
      ).bind(grant.member_id, grant.scope_type)
    : env.DB.prepare(
        `DELETE FROM capabilities
          WHERE member_id = ? AND scope_type = ? AND scope_id = ?
        RETURNING capability`,
      ).bind(grant.member_id, grant.scope_type, grant.scope_id)

  const writes = await env.DB.batch<{ capability: Capability }>([
    deleteStmt,
    env.DB.prepare(
      'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), grant.member_id, grant.scope_type, grant.scope_id, grant.capability),
  ])
  assertBatchWritten([writes[1]], 'upsert_capability_grant', 1)

  const existing = writes[0].results ?? []
  const result = existing.length === 0
    ? 'created'
    : existing.length === 1 && existing[0].capability === grant.capability
      ? 'unchanged'
      : 'updated'

  return { grant, result }
}
