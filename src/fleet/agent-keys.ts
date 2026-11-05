import type { Env } from '../types'
import { boundAgentVerdict, BoundAgentCheckUnavailableError, type BoundAgentVerdict } from '../auth/bound-agent-live'

const ED25519_PUBLIC_X_RE = /^[A-Za-z0-9_-]{43}$/

function canonicalPublicX(value: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}=`), (ch) => ch.charCodeAt(0))
    if (bytes.byteLength !== 32) return false
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value
  } catch {
    return false
  }
}

export async function isValidEd25519PublicX(value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || !ED25519_PUBLIC_X_RE.test(value) || !canonicalPublicX(value)) return false
  try {
    await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: value, ext: true },
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return true
  } catch {
    return false
  }
}

interface AgentKeyRow {
  pubkey: string
  algo: string
  member_id: string | null
}

export interface ActiveAgentKey {
  pubkey: string
  algo: string
  member_id: string
}

export async function agentKeyFingerprint(pubkey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubkey))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type RegisterAgentKeyResult =
  | { ok: true; status: 'registered' | 'bound' | 'already_registered'; memberId: string }
  | { ok: false; reason: 'identity_unminted' | 'identity_ambiguous' | 'key_conflict' }

async function loadKey(env: Env, agentId: string): Promise<AgentKeyRow | null> {
  return env.DB.prepare(
    `SELECT pubkey, algo, member_id
       FROM agent_keys
      WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(env.TENANT_SLUG, agentId).first<AgentKeyRow>()
}

/**
 * Resolve a runtime key only when its identity binding remains valid. Signed
 * endpoints must not authenticate legacy unbound keys, or keys whose member has
 * since been disabled. The key row and member row are tenant-bound in the join.
 */
export async function loadActiveAgentKey(env: Env, agentId: string): Promise<ActiveAgentKey | null> {
  return env.DB.prepare(
    `SELECT k.pubkey, k.algo, k.member_id
       FROM agent_keys k
       JOIN members m ON m.id = k.member_id AND m.tenant = k.tenant
      WHERE k.tenant = ?1
        AND k.agent_id = ?2
        AND k.member_id IS NOT NULL
        AND m.status = 'active'`,
  ).bind(env.TENANT_SLUG, agentId).first<ActiveAgentKey>()
}

/** Outcome of judging the agent a signing key belongs to (mupot#2345). */
export type SignerKey =
  | { state: 'live'; key: ActiveAgentKey }
  | { state: 'none' | 'refused' | 'unavailable' }

/**
 * The agent a key is registered for, resolved to agents.id. agent_keys.agent_id is an agents.id OR a slug
 * (see resolveFleetWriteAgentId). An id wins. A slug is NOT unique tenant-wide (agents.slug is unique per squad), so it
 * resolves through the key's own member: among the agents carrying that slug, the one bound to the key's member
 * (agent_member_bindings) or owned by it. A squatter reusing the slug in another squad is not bound to the key's member and
 * so changes nothing; zero matches (e.g. the real agent was hard-deleted and a newcomer took the slug) or still more than
 * one = null (refused).
 */
async function resolveKeyedAgentId(env: Env, keyedId: string, keyMemberId: string): Promise<string | null> {
  const found = await env.DB.prepare(
    `SELECT a.id AS id FROM agents a
      WHERE a.id = ?1
         OR (a.slug = ?1 AND NOT EXISTS (SELECT 1 FROM agents WHERE id = ?1)
             AND (EXISTS (SELECT 1 FROM agent_member_bindings b WHERE b.tenant = ?3 AND b.agent_id = a.id AND b.member_id = ?2)
                  OR a.owner_member_id = ?2))
      LIMIT 2`,
  ).bind(keyedId, keyMemberId, env.TENANT_SLUG).all<{ id: string }>()
  const rows = found.results ?? []
  return rows.length === 1 ? rows[0].id : null
}

/** Key load for the signed doors: a failed read is the retryable 503 (never a 500, never a pass). */
export async function loadKeyForDoor(env: Env, agentId: string): Promise<ActiveAgentKey | null> {
  try {
    return await loadActiveAgentKey(env, agentId)
  } catch {
    throw new BoundAgentCheckUnavailableError()
  }
}

/**
 * The shared live verdict for the agent a (already loaded) signing key belongs to: agent active/paused, owner an active
 * member of this tenant, and at least one live capability on the key's member. Doors call this AFTER the signature
 * verifies (cheap reject first, no live-vs-refused timing oracle) and BEFORE burning the nonce, so a 503 retry may reuse it.
 */
export async function signerVerdict(env: Env, agentId: string, key: ActiveAgentKey): Promise<BoundAgentVerdict> {
  try {
    const resolved = await resolveKeyedAgentId(env, agentId, key.member_id)
    if (resolved === null) return 'refused'
    return await boundAgentVerdict(env, { boundAgentId: resolved, consentedByMemberId: null, memberId: key.member_id })
  } catch {
    return 'unavailable'
  }
}

/** Door form of signerVerdict: true = live, false = refused (answer like a bad signature), throws the retryable 503 when unavailable. */
export async function signerIsLive(env: Env, agentId: string, key: ActiveAgentKey): Promise<boolean> {
  const v = await signerVerdict(env, agentId, key)
  if (v === 'unavailable') throw new BoundAgentCheckUnavailableError()
  return v === 'live'
}

/** Non-throwing form for callers that decide for themselves (seat events). */
export async function loadSignerKey(env: Env, agentId: string): Promise<SignerKey> {
  let key: ActiveAgentKey | null
  try {
    key = await loadActiveAgentKey(env, agentId)
  } catch {
    return { state: 'unavailable' }
  }
  if (!key) return { state: 'none' }
  const verdict = await signerVerdict(env, agentId, key)
  return verdict === 'live' ? { state: 'live', key } : { state: verdict }
}

/**
 * Register a host-held agent key against the agent's immutable member binding.
 * Existing different keys are never replaced implicitly; deliberate rotation needs
 * a separate owner ceremony.
 */
export async function registerAgentPublicKey(
  env: Env,
  runtimeAgentId: string,
  identityAgentId: string,
  publicKey: string,
  now = () => Math.floor(Date.now() / 1000),
): Promise<RegisterAgentKeyResult> {
  const identity = await env.DB.prepare(
    `SELECT b.member_id
       FROM agent_member_bindings b
       JOIN members m
         ON m.id = b.member_id
        AND m.tenant = b.tenant
      WHERE b.tenant = ?1
        AND b.agent_id = ?2
        AND m.status = 'active'
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, identityAgentId).first<{ member_id: string }>()

  if (!identity) return { ok: false, reason: 'identity_unminted' }
  const memberId = identity.member_id

  const existing = await loadKey(env, runtimeAgentId)
  if (existing) {
    if (existing.algo !== 'Ed25519' || existing.pubkey !== publicKey) {
      return { ok: false, reason: 'key_conflict' }
    }
    if (existing.member_id === memberId) {
      return { ok: true, status: 'already_registered', memberId }
    }
    if (existing.member_id !== null) return { ok: false, reason: 'key_conflict' }

    const bound = await env.DB.prepare(
      `UPDATE agent_keys
          SET member_id = ?3
        WHERE tenant = ?1 AND agent_id = ?2 AND member_id IS NULL`,
    ).bind(env.TENANT_SLUG, runtimeAgentId, memberId).run()
    if ((bound.meta?.changes ?? 0) > 0) return { ok: true, status: 'bound', memberId }

    const raced = await loadKey(env, runtimeAgentId)
    return raced?.algo === 'Ed25519' && raced.pubkey === publicKey && raced.member_id === memberId
      ? { ok: true, status: 'already_registered', memberId }
      : { ok: false, reason: 'key_conflict' }
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
     VALUES (?1, ?2, ?3, 'Ed25519', ?4, ?5)
     ON CONFLICT(tenant, agent_id) DO NOTHING`,
  ).bind(env.TENANT_SLUG, runtimeAgentId, publicKey, memberId, now()).run()
  if ((inserted.meta?.changes ?? 0) > 0) return { ok: true, status: 'registered', memberId }

  const raced = await loadKey(env, runtimeAgentId)
  return raced?.algo === 'Ed25519' && raced.pubkey === publicKey && raced.member_id === memberId
    ? { ok: true, status: 'already_registered', memberId }
    : { ok: false, reason: 'key_conflict' }
}

/** True if a signed-attach public key is registered for (tenant, agent_id). Such agents
 *  may only move their fleet row BY SIGNATURE.
 *
 *  Lives here, once, because two paths now depend on it and they must agree.
 *  src/fleet/attach-routes.ts closes the bearer /attach path for a keyed agent
 *  explicitly ("no auth downgrade"). Boot-time self-report over MCP is also
 *  bearer-authenticated, so it honours the SAME predicate — otherwise the new door is a
 *  way around the signature requirement that the attach route already bolted shut, and
 *  the weaker door wins by being newer.
 *
 *  Deliberately distinct from loadActiveAgentKey above: this asks whether ANY key is
 *  registered (including a revoked one), because the question is "is this agent required
 *  to use the signed path", not "can this signature be verified right now". An agent
 *  whose key was revoked must fix its key, not fall back to bearer. */
export async function hasRegisteredKey(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM agent_keys WHERE tenant = ?1 AND agent_id = ?2`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<{ x: number }>()
  return !!row
}
