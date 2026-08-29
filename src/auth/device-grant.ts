// mupot — RFC 8628-shaped device grant.
//
// The harness shows a short user_code. The human opens /device, TYPES that
// code, then clicks Allow or Deny on that one request. Pending grants are
// never listed. device_code is stored hashed. The minted token has a TTL.
// Poll redeems the raw once via a separate redeem key.

import type { AuthContext, Env } from '../types'
import { memberMayConsentToAgent } from '../mcp/oauth-authorize'
import { mintAgentBoundToken, sha256Hex, type AgentForMint } from '../members/service'

export const DEVICE_GRANT_TTL_SECONDS = 600
export const DEVICE_TOKEN_TTL_SECONDS = 3600
export const DEVICE_PENDING_CAP = 8
export const DEVICE_POLL_INTERVAL_SECONDS = 5

const GRANT_PREFIX = 'device-grant:'
const USER_PREFIX = 'device-user:'
const PENDING_PREFIX = 'device-pending:'
const CSRF_PREFIX = 'device-csrf:'
const REDEEM_PREFIX = 'device-redeem:'

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export type DeviceGrantStatus = 'pending' | 'approved' | 'denied' | 'consumed'

export interface DeviceGrantRecord {
  user_code: string
  tenant: string
  agent_id: string
  agent_slug: string
  agent_name: string
  status: DeviceGrantStatus
  created_at: string
  expires_at: string
  approved_by_member_id: string | null
  token_id: string | null
}

export interface DeviceGrantPublic {
  user_code: string
  agent_id: string
  agent_slug: string
  agent_name: string
  status: DeviceGrantStatus
  expires_at: string
}

export interface CreateDeviceGrantResult {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface PollDeviceGrantResult {
  status: 'authorization_pending' | 'access_denied' | 'expired_token' | 'ok'
  access_token?: string
  token_type?: 'Bearer'
  expires_in?: number
  agent_id?: string
  agent_slug?: string
}

function randomAlphabet(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]
  return out
}

function randomDeviceCode(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function formatUserCode(): string {
  const raw = randomAlphabet(8)
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

export function normalizeUserCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function grantKey(codeHash: string): string {
  return `${GRANT_PREFIX}${codeHash}`
}

function userKey(tenant: string, userCode: string): string {
  return `${USER_PREFIX}${tenant}:${normalizeUserCode(userCode)}`
}

function pendingKey(tenant: string): string {
  return `${PENDING_PREFIX}${tenant}`
}

function redeemKey(codeHash: string): string {
  return `${REDEEM_PREFIX}${codeHash}`
}

async function hashDeviceCode(deviceCode: string): Promise<string> {
  return sha256Hex(deviceCode)
}

async function readGrantByHash(env: Env, codeHash: string): Promise<DeviceGrantRecord | null> {
  const row = await env.SESSIONS.get<DeviceGrantRecord>(grantKey(codeHash), 'json')
  return row ?? null
}

async function writeGrant(env: Env, codeHash: string, grant: DeviceGrantRecord): Promise<void> {
  const ttl = Math.max(60, Math.floor((Date.parse(grant.expires_at) - Date.now()) / 1000))
  await env.SESSIONS.put(grantKey(codeHash), JSON.stringify(grant), { expirationTtl: ttl })
}

function publicGrant(grant: DeviceGrantRecord): DeviceGrantPublic {
  return {
    user_code: grant.user_code,
    agent_id: grant.agent_id,
    agent_slug: grant.agent_slug,
    agent_name: grant.agent_name,
    status: grant.status,
    expires_at: grant.expires_at,
  }
}

async function readPending(env: Env, tenant: string): Promise<string[]> {
  const list = await env.SESSIONS.get<string[]>(pendingKey(tenant), 'json')
  return Array.isArray(list) ? list : []
}

async function writePending(env: Env, tenant: string, hashes: string[]): Promise<void> {
  await env.SESSIONS.put(pendingKey(tenant), JSON.stringify(hashes), {
    expirationTtl: DEVICE_GRANT_TTL_SECONDS,
  })
}

async function livePendingHashes(env: Env): Promise<string[]> {
  const pending = await readPending(env, env.TENANT_SLUG)
  const live: string[] = []
  for (const codeHash of pending) {
    const g = await readGrantByHash(env, codeHash)
    if (g && g.status === 'pending' && Date.parse(g.expires_at) > Date.now()) live.push(codeHash)
  }
  return live
}

export async function createDeviceGrant(
  env: Env,
  input: { agent: string; origin: string },
): Promise<{ ok: true; value: CreateDeviceGrantResult } | { ok: false; error: 'invalid_agent' | 'pending_cap' }> {
  const ref = input.agent.trim()
  if (!ref || ref.length > 80) return { ok: false, error: 'invalid_agent' }

  const agent = await env.DB.prepare(
    `SELECT id, slug, name, squad_id, status
       FROM agents
      WHERE id = ?1 OR slug = ?1
      LIMIT 1`,
  )
    .bind(ref)
    .first<AgentForMint & { status: string }>()

  if (!agent || agent.status !== 'active') return { ok: false, error: 'invalid_agent' }

  const live = await livePendingHashes(env)
  if (live.length >= DEVICE_PENDING_CAP) return { ok: false, error: 'pending_cap' }

  const deviceCode = randomDeviceCode()
  const codeHash = await hashDeviceCode(deviceCode)
  const userCode = formatUserCode()
  const now = new Date()
  const expires = new Date(now.getTime() + DEVICE_GRANT_TTL_SECONDS * 1000)
  const grant: DeviceGrantRecord = {
    user_code: userCode,
    tenant: env.TENANT_SLUG,
    agent_id: agent.id,
    agent_slug: agent.slug,
    agent_name: agent.name,
    status: 'pending',
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    approved_by_member_id: null,
    token_id: null,
  }

  await writeGrant(env, codeHash, grant)
  await env.SESSIONS.put(userKey(env.TENANT_SLUG, userCode), codeHash, {
    expirationTtl: DEVICE_GRANT_TTL_SECONDS,
  })
  live.push(codeHash)
  await writePending(env, env.TENANT_SLUG, live)

  return {
    ok: true,
    value: {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${input.origin.replace(/\/$/, '')}/device`,
      expires_in: DEVICE_GRANT_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    },
  }
}

export async function lookupDeviceGrant(
  env: Env,
  userCode: string,
): Promise<DeviceGrantPublic | null> {
  const codeHash = await env.SESSIONS.get(userKey(env.TENANT_SLUG, userCode))
  if (!codeHash) return null
  const grant = await readGrantByHash(env, codeHash)
  if (!grant || grant.tenant !== env.TENANT_SLUG) return null
  if (Date.parse(grant.expires_at) <= Date.now()) return null
  if (grant.status !== 'pending') return null
  return publicGrant(grant)
}

export async function issueDeviceCsrf(env: Env): Promise<string> {
  const nonce = crypto.randomUUID()
  await env.SESSIONS.put(`${CSRF_PREFIX}${nonce}`, '1', { expirationTtl: DEVICE_GRANT_TTL_SECONDS })
  return nonce
}

export async function consumeDeviceCsrf(env: Env, nonce: string): Promise<boolean> {
  if (!nonce || nonce.length > 80) return false
  const key = `${CSRF_PREFIX}${nonce}`
  const hit = await env.SESSIONS.get(key)
  if (!hit) return false
  await env.SESSIONS.delete(key)
  return true
}

async function humanMayAllow(env: Env, auth: AuthContext, agentId: string): Promise<boolean> {
  if (auth.role === 'owner' || auth.role === 'admin') return true
  if (!auth.memberId) return false
  return memberMayConsentToAgent(env, auth.memberId, agentId)
}

export async function decideDeviceGrant(
  env: Env,
  input: { user_code: string; action: 'allow' | 'deny'; auth: AuthContext },
): Promise<{ ok: true; status: 'approved' | 'denied' } | { ok: false; error: 'not_found' | 'forbidden' | 'expired' | 'already_decided' }> {
  const codeHash = await env.SESSIONS.get(userKey(env.TENANT_SLUG, input.user_code))
  if (!codeHash) return { ok: false, error: 'not_found' }
  const grant = await readGrantByHash(env, codeHash)
  if (!grant || grant.tenant !== env.TENANT_SLUG) return { ok: false, error: 'not_found' }
  if (Date.parse(grant.expires_at) <= Date.now()) return { ok: false, error: 'expired' }
  if (grant.status !== 'pending') return { ok: false, error: 'already_decided' }

  if (input.action === 'deny') {
    grant.status = 'denied'
    await writeGrant(env, codeHash, grant)
    return { ok: true, status: 'denied' }
  }

  const allowed = await humanMayAllow(env, input.auth, grant.agent_id)
  if (!allowed) return { ok: false, error: 'forbidden' }

  const agent = await env.DB.prepare(
    `SELECT id, slug, name, squad_id, status
       FROM agents
      WHERE id = ?1
      LIMIT 1`,
  )
    .bind(grant.agent_id)
    .first<AgentForMint & { status: string }>()
  if (!agent || agent.status !== 'active') return { ok: false, error: 'forbidden' }

  if (input.auth.role !== 'owner' && input.auth.role !== 'admin') {
    const eligible = await memberMayConsentToAgent(env, input.auth.memberId ?? '', grant.agent_id)
    if (!eligible) return { ok: false, error: 'forbidden' }
  }

  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_SECONDS * 1000).toISOString()
  const minted = await mintAgentBoundToken(
    env,
    { id: agent.id, slug: agent.slug, name: agent.name, squad_id: agent.squad_id },
    `device:${grant.user_code}`,
    { grantCapability: 'member', expiresAt },
  )

  grant.status = 'approved'
  grant.approved_by_member_id = input.auth.memberId ?? input.auth.userId
  grant.token_id = minted.tokenId
  await writeGrant(env, codeHash, grant)
  await env.SESSIONS.put(redeemKey(codeHash), minted.raw, {
    expirationTtl: DEVICE_GRANT_TTL_SECONDS,
  })
  return { ok: true, status: 'approved' }
}

export async function pollDeviceGrant(
  env: Env,
  deviceCode: string,
): Promise<PollDeviceGrantResult> {
  if (!deviceCode || deviceCode.length > 128) return { status: 'expired_token' }
  const codeHash = await hashDeviceCode(deviceCode)
  const grant = await readGrantByHash(env, codeHash)
  if (!grant || grant.tenant !== env.TENANT_SLUG) return { status: 'expired_token' }
  if (Date.parse(grant.expires_at) <= Date.now()) return { status: 'expired_token' }
  if (grant.status === 'pending') return { status: 'authorization_pending' }
  if (grant.status === 'denied' || grant.status === 'consumed') return { status: 'expired_token' }
  if (grant.status !== 'approved') return { status: 'expired_token' }

  const raw = await env.SESSIONS.get(redeemKey(codeHash))
  await env.SESSIONS.delete(redeemKey(codeHash))
  if (!raw) return { status: 'expired_token' }

  grant.status = 'consumed'
  await writeGrant(env, codeHash, grant)
  return {
    status: 'ok',
    access_token: raw,
    token_type: 'Bearer',
    expires_in: DEVICE_TOKEN_TTL_SECONDS,
    agent_id: grant.agent_id,
    agent_slug: grant.agent_slug,
  }
}
