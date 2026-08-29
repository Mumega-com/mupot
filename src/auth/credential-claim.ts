// mupot — one-time credential claim (mupot#987).
//
// The problem: every tool that mints a fresh credential (mint_agent_token,
// bootstrap_self, provision_agent_connection) used to put the raw secret directly
// in its MCP tool result — `{ token: { ..., raw: "mupot_<64 hex>" } }`. The
// "shown once" note was true of the D1 row (hashed at rest, raw never stored) and
// false of the CALLER: every MCP client that persists a conversation (all of
// them) appends the tool result verbatim to a transcript file on disk. #987 found
// two copies of a rotated token in a session .jsonl within seconds of minting it.
//
// Regex-scrubbing an already-emitted secret out of a transcript after the fact is
// not a fix — the file is already written, possibly already copied/archived/
// shipped for analysis (#987's stated threat model). The only real fix is
// STRUCTURAL: never place the raw value in a field a tool result can carry.
//
// So the mint tools no longer return `raw` at all. They call
// `createCredentialClaim` and return a claim handle — `claim_id` (opaque,
// unguessable), `fingerprint` (sha256 prefix — safe to log, useless to an
// attacker), and `expires_at`. The raw value is redeemable EXACTLY ONCE, within a
// short TTL, through the separate `reveal_credential_claim` tool — and only by
// the same member who minted it.
//
// Honest scope (read this before assuming the hole is fully closed): a Cloudflare
// Worker has no filesystem access to the machine running the MCP client, so it
// cannot deliver the raw value out-of-band the way a local process could
// (issue #987's own "option 1"). If the calling agent itself needs the raw value
// (to write it into its own client config), the reveal call's OWN result will
// still transit that same session once. What this DOES fix, unconditionally: the
// window of exposure. Today, a copied/archived/summarized transcript carries a
// permanently-live credential forever. After this change, a transcript can only
// ever carry a claim_id — which is single-use and dead within CLAIM_TTL_SECONDS.
// By the time anyone reads an archived transcript back, in the overwhelming
// common case the claim has already been consumed or has expired. That is a real
// reduction in blast radius, not a cosmetic one — but it is not a claim that raw
// secrets can never appear in a live, in-progress session. A protocol/client-side
// fix (MCP "roots"-style out-of-band delivery) would be required to close that
// remaining gap, and is out of scope for this server-side change.
//
// Storage: reuses the existing SESSIONS KV binding — the same short-lived-state
// seam already used for OAuth `state` (src/mcp/oauth-authorize.ts), the
// dashboard's routine-run nonce (src/dashboard/routines.ts), and the flight-list
// cursor (src/mcp/index.ts). get-then-delete is the SAME single-use pattern
// already in production for OAuth state — this is not a new risk class, it is the
// established one, applied to a value that was previously not gated at all.

import type { Env } from '../types'
import { sha256Hex } from '../members/service'

/** How long an unclaimed credential can sit in KV before it expires unread.
 *  Short enough that a leaked/archived transcript is very unlikely to still
 *  find it live; long enough for the calling agent's very next tool call. */
export const CLAIM_TTL_SECONDS = 600 // 10 minutes

const CLAIM_KEY_PREFIX = 'cred-claim:'

interface CredentialClaimRecord {
  raw: string
  /** auth.memberId of the caller who minted this credential — the ONLY
   *  identity allowed to redeem it. Never trusted from tool args. */
  mintedBy: string
  tenant: string
  createdAt: string
}

export interface CredentialClaimHandle {
  claim_id: string
  /** sha256(raw) truncated to 16 hex chars. Safe to log/persist/compare —
   *  useless for reconstructing or replaying the credential. */
  fingerprint: string
  expires_at: string
  reveal_tool: 'reveal_credential_claim'
}

/** Store a freshly-minted raw secret behind a one-time claim and return the
 *  transcript-safe handle. Callers MUST NOT put `raw` anywhere in a tool
 *  result themselves — this is the only sanctioned path from a fresh secret
 *  to an MCP response. */
export async function createCredentialClaim(
  env: Env,
  raw: string,
  mintedBy: string,
): Promise<CredentialClaimHandle> {
  const claimId = crypto.randomUUID()
  const fingerprint = (await sha256Hex(raw)).slice(0, 16)
  const nowMs = Date.now()
  const record: CredentialClaimRecord = {
    raw,
    mintedBy,
    tenant: env.TENANT_SLUG,
    createdAt: new Date(nowMs).toISOString(),
  }
  await env.SESSIONS.put(CLAIM_KEY_PREFIX + claimId, JSON.stringify(record), {
    expirationTtl: CLAIM_TTL_SECONDS,
  })
  return {
    claim_id: claimId,
    fingerprint,
    expires_at: new Date(nowMs + CLAIM_TTL_SECONDS * 1000).toISOString(),
    reveal_tool: 'reveal_credential_claim',
  }
}

/** Check that a staged handoff can still be activated without reading or consuming its raw value. */
export async function credentialClaimIsAvailable(
  env: Env,
  claimId: string,
  mintedBy: string,
): Promise<boolean> {
  const stored = await env.SESSIONS.get(CLAIM_KEY_PREFIX + claimId)
  if (!stored) return false
  try {
    const record = JSON.parse(stored) as CredentialClaimRecord
    return record.mintedBy === mintedBy && record.tenant === env.TENANT_SLUG && typeof record.raw === 'string'
  } catch {
    return false
  }
}

export type RevealClaimResult =
  | { ok: true; raw: string }
  | { ok: false; reason: 'not_found_or_consumed' | 'wrong_owner' }

/** Redeem a claim EXACTLY ONCE. Burns the KV entry before returning — a second
 *  reveal (whether the legitimate caller double-clicking, or a claim_id replayed
 *  out of a copied transcript) finds nothing, matching the single-use guarantee
 *  the tool result promises. The entry is deleted BEFORE the owner check so a
 *  wrong-owner attempt still consumes it rather than leaving it live for retry —
 *  fail-closed: raw is returned if and only if the caller is the minter, but
 *  the claim never survives a first read either way. */
export async function revealCredentialClaim(
  env: Env,
  claimId: string,
  revealedBy: string,
): Promise<RevealClaimResult> {
  const key = CLAIM_KEY_PREFIX + claimId
  // Read as plain text and parse manually (rather than KV's `'json'` type arg) —
  // matches src/dashboard/brain.ts's SESSIONS pattern and stays correct against
  // simplified in-memory KV test doubles that don't implement KV's type-coercing
  // get() overload.
  const rawStored = await env.SESSIONS.get(key)
  if (!rawStored) return { ok: false, reason: 'not_found_or_consumed' }
  await env.SESSIONS.delete(key)
  let stored: CredentialClaimRecord
  try {
    stored = JSON.parse(rawStored) as CredentialClaimRecord
  } catch {
    return { ok: false, reason: 'not_found_or_consumed' }
  }
  if (stored.mintedBy !== revealedBy || stored.tenant !== env.TENANT_SLUG) {
    return { ok: false, reason: 'wrong_owner' }
  }
  return { ok: true, raw: stored.raw }
}
