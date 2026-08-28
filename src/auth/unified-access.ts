// src/auth/unified-access.ts — Unified Principals & Token-Scoped Access Keys (FLIGHT IDENTITY-UNIFIED / #584).
//
// Unifies the four divergent mint paths into one single service that:
// 1. Accepts a principal (human or agent) and an array of token-scoped capability grants.
// 2. Enforces least-privilege ceiling: effective authority = intersect(principal, token_grants).
// 3. Bundles show-once token, MCP endpoint, and paste-ready configs for Claude Code, Cursor, Codex, and curl.

import type { Env, Capability, CapabilityScopeType, CapabilityGrant } from '../types'
import { sha256Hex } from '../lib/crypto'
import { nowSqlUtc, calculateExpiryTimestamp, DEFAULT_TOKEN_EXPIRY_DAYS } from './token-lifecycle'
import { resolveCapabilities, resolveTokenGrants, intersectCapabilities } from './capability'
import { mcpEndpoint, claudeCodeSnippet, codexSnippet, cursorSnippet, canonicalOrigin } from '../dashboard/connect'

export interface TokenScopeGrantInput {
  scope_type: CapabilityScopeType
  scope_id?: string | null
  capability: Capability
  resource?: string | null
}

export interface CreateAccessKeyInput {
  principalId: string // member_id or agent_id
  label: string
  channel?: 'workspace' | 'im' | 'dashboard' | 'directory'
  expiryDays?: number | null
  grants?: TokenScopeGrantInput[]
  agentId?: string | null
}

export interface CreateAccessKeyResult {
  tokenId: string
  rawToken: string
  principalId: string
  label: string
  expiresAt: string | null
  mcpEndpoint: string
  configs: {
    claudeCodeJson: string
    cursorJson: string
    codexToml: string
    curlHeader: string
  }
  effectiveGrants: CapabilityGrant[]
}

/**
 * Creates a unified access key with token-scoped grants and bundled client configs.
 */
export async function createAccessKey(
  env: Env,
  input: CreateAccessKeyInput,
): Promise<CreateAccessKeyResult> {
  const tokenId = crypto.randomUUID()
  const rawBytes = new Uint8Array(32)
  crypto.getRandomValues(rawBytes)
  const rawToken = Array.from(rawBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const tokenHash = await sha256Hex(rawToken)

  const now = nowSqlUtc()
  const expiryDays = input.expiryDays !== undefined ? input.expiryDays : DEFAULT_TOKEN_EXPIRY_DAYS
  const expiresAt = calculateExpiryTimestamp(expiryDays)
  const channel = input.channel ?? 'workspace'

  // 1. Insert member_tokens record
  await env.DB.prepare(
    `INSERT INTO member_tokens
       (id, member_id, token_hash, label, channel, agent_id, expires_at, created_at, tenant)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      tokenId,
      input.principalId,
      tokenHash,
      input.label.trim(),
      channel,
      input.agentId ?? null,
      expiresAt,
      now,
      env.TENANT_SLUG,
    )
    .run()

  // 2. Insert token_grants if supplied
  if (input.grants && input.grants.length > 0) {
    for (const g of input.grants) {
      const grantId = crypto.randomUUID()
      await env.DB.prepare(
        `INSERT INTO token_grants
           (id, token_id, tenant, scope_type, scope_id, capability, resource, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
        .bind(
          grantId,
          tokenId,
          env.TENANT_SLUG,
          g.scope_type,
          g.scope_id ?? null,
          g.capability,
          g.resource ?? null,
          now,
        )
        .run()
    }
  }

  // 3. Compute effective authority intersection
  const principalGrants = await resolveCapabilities(env, input.principalId)
  const tokenGrants = await resolveTokenGrants(env, tokenId)
  const effectiveGrants = intersectCapabilities(principalGrants, tokenGrants)

  // 4. Bundle endpoints & paste-ready configs
  const origin = canonicalOrigin(env, 'https://mupot.mumega.com')
  const endpoint = mcpEndpoint(origin)
  const slug = env.TENANT_SLUG

  const claudeConfig = claudeCodeSnippet(slug, origin).replace('<MEMBER_TOKEN>', rawToken)
  const cursorConfig = cursorSnippet(slug, origin).replace('<MEMBER_TOKEN>', rawToken)
  const codexConfig = codexSnippet(slug, origin).replace('<MEMBER_TOKEN>', rawToken)
  const curlHeader = `Authorization: Bearer ${rawToken}`

  return {
    tokenId,
    rawToken,
    principalId: input.principalId,
    label: input.label,
    expiresAt,
    mcpEndpoint: endpoint,
    configs: {
      claudeCodeJson: claudeConfig,
      cursorJson: cursorConfig,
      codexToml: codexConfig,
      curlHeader,
    },
    effectiveGrants,
  }
}
