// mupot#1794 W4 — a member-scoped TOKEN as a harness credential.
//
// WHY: one credential is often shared by many actors (Codex cloud env secret, CI, a shared .env, one
// MCP config inside Cursor / Grok bots). Minting the credential AS a harness makes every thread behind
// it call seat_select and get its own seat agent, instead of all collapsing into one identity.
//
// SHAPE: a normal member_tokens row — channel 'directory', agent_id NULL, harness_kind set (the row
// ITSELF says it is a harness credential, for life: migration 0202 makes harness_kind immutable and
// refuses any agent_id write on it) — plus a harnesses row (credential_kind 'token') in the SAME batch.
//
// ZERO STANDING is a property of that row, enforced at the doors from the very read that authenticates
// the bearer (src/members/harness-credential.ts): zero capabilities, zero latent capabilities. And ONE
// chokepoint (invokeTool) confines a harness session that has no applied seat handle to exactly:
// `seat_select` and `boot_context` (plus initialize / tools/list); every other tool, /actions/:tool, the
// legacy {tool,args} body, events/* and the profile door answer `harness_session_seat_required`. With a
// valid seat handle the request is the SEAT AGENT's (capped at member and at the human's own live rank).
// It cannot be used on the REST API and can never be welded to an agent.
//
// AUTHORITY: this module does NO authz. The ONLY caller is POST /members/:id/tokens
// (src/members/index.ts), which has already enforced requireCapability(org, 'admin') and
// exceedsTargetRankCeiling for the target member — the same gates every other member-token mint
// passes. There is deliberately no second, weaker mint door.

import type { Env } from '../types'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { assertBatchWritten } from '../lib/receipt'
import { mintRawToken, sha256Hex } from './service'
import { sanitizeLabel, type HarnessTokenKind } from './harness'

export interface MintedHarnessToken {
  token: {
    id: string
    member_id: string
    label: string
    channel: 'directory'
    created_at: string
    expires_at: string | null
    /** The raw token — returned EXACTLY ONCE. Never persisted, never logged. */
    raw: string
  }
  harness: { id: string; kind: HarnessTokenKind; label: string; credential_kind: 'token' }
}

export async function mintHarnessToken(
  env: Env,
  p: { memberId: string; kind: HarnessTokenKind; label: string; expiresAt: string | null },
): Promise<MintedHarnessToken> {
  const label = sanitizeLabel(p.label, 64)
  const raw = mintRawToken()
  const tokenHash = await sha256Hex(raw)
  const tokenId = crypto.randomUUID()
  const harnessId = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, harness_kind)
       VALUES (?1, ?2, ?3, ?4, 'directory', ?5, NULL, ?6, ?7, ?8)`,
    ).bind(tokenId, p.memberId, tokenHash, `harness:${label}`.slice(0, 64), createdAt, env.TENANT_SLUG, p.expiresAt, p.kind),
    // The harness row follows its token (the shape trigger in 0202 re-reads it). A trigger refusal
    // rolls the WHOLE batch back, so a token is never left without its harness.
    env.DB.prepare(
      `INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind, credential_kind, token_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'token', ?7)`,
    ).bind(harnessId, env.TENANT_SLUG, p.memberId, `token:${tokenId}`, label, p.kind, tokenId),
  ]
  const writes = await env.DB.batch(statements)
  assertBatchWritten(writes, 'harness_token', 1)

  return {
    token: {
      id: tokenId,
      member_id: p.memberId,
      label: `harness:${label}`.slice(0, 64),
      channel: 'directory',
      created_at: createdAt,
      expires_at: p.expiresAt,
      raw,
    },
    harness: { id: harnessId, kind: p.kind, label, credential_kind: 'token' },
  }
}
