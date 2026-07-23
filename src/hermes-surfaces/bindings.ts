// Member ↔ Hermes agent binding + Hermes API endpoint resolution (BYOA surfaces).
//
// Binding table: member_hermes_bindings (migration 0072).
// Endpoint: connector type hermes_api scoped to the agent (secret = API key,
// meta JSON = { "api_url": "https://..." }).

import type { Env } from '../types'
import { assertPublicHttpsUrl } from '../lib/ssrf'
import { canOnSquad, resolveCapabilities } from '../auth/capability'
import { resolveConnectorWithMeta } from '../connectors/service'

export interface MemberHermesBinding {
  member_id: string
  agent_id: string
  created_at: string
  updated_at: string
}

export interface HermesApiEndpoint {
  baseUrl: string
  apiKey: string
  agentId: string
}

export class HermesSurfacesError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HermesSurfacesError'
    this.code = code
  }
}

const MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_ID_RE = MEMBER_ID_RE

export function assertUuid(raw: string, label: string): string {
  const id = raw.trim()
  if (!MEMBER_ID_RE.test(id)) {
    throw new HermesSurfacesError('invalid_id', `${label} must be a UUID`)
  }
  return id
}

export async function getMemberHermesBinding(
  env: Env,
  memberId: string,
): Promise<MemberHermesBinding | null> {
  const id = assertUuid(memberId, 'member_id')
  const row = await env.DB.prepare(
    `SELECT member_id, agent_id, created_at, updated_at
       FROM member_hermes_bindings
      WHERE member_id = ?1
      LIMIT 1`,
  )
    .bind(id)
    .first<MemberHermesBinding>()
  return row ?? null
}

export async function bindMemberHermesAgent(
  env: Env,
  input: { memberId: string; agentId: string },
): Promise<MemberHermesBinding> {
  const memberId = assertUuid(input.memberId, 'member_id')
  const agentId = assertUuid(input.agentId, 'agent_id')

  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND tenant = ?2 AND status = 'active' LIMIT 1`,
  )
    .bind(memberId, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (!member) throw new HermesSurfacesError('member_not_found', 'active member not found')

  // Join through squads so a dangling agent row (no squad in this pot's D1) cannot bind.
  // Agents are pot-local (no tenant column); the squad join is the tenant fence.
  const agent = await env.DB.prepare(
    `SELECT a.id AS id, a.squad_id AS squad_id
       FROM agents a
       INNER JOIN squads s ON s.id = a.squad_id
      WHERE a.id = ?1
      LIMIT 1`,
  )
    .bind(agentId)
    .first<{ id: string; squad_id: string }>()
  if (!agent) throw new HermesSurfacesError('agent_not_found', 'agent not found')

  const grants = await resolveCapabilities(env, memberId)
  if (!(await canOnSquad(env, grants, agent.squad_id, 'member'))) {
    throw new HermesSurfacesError(
      'member_not_on_squad',
      'member must hold member+ on the agent squad before binding',
    )
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO member_hermes_bindings (member_id, agent_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(member_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       updated_at = excluded.updated_at`,
  )
    .bind(memberId, agentId, now)
    .run()

  const binding = await getMemberHermesBinding(env, memberId)
  if (!binding) throw new HermesSurfacesError('bind_failed', 'binding write returned no row')
  return binding
}

function parseApiUrl(meta: string | null): string {
  if (!meta) throw new HermesSurfacesError('hermes_api_unconfigured', 'hermes_api connector meta missing api_url')
  let parsed: unknown
  try {
    parsed = JSON.parse(meta)
  } catch {
    throw new HermesSurfacesError('hermes_api_bad_meta', 'hermes_api connector meta is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HermesSurfacesError('hermes_api_bad_meta', 'hermes_api connector meta must be an object')
  }
  const apiUrl = (parsed as { api_url?: unknown }).api_url
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    throw new HermesSurfacesError('hermes_api_unconfigured', 'hermes_api connector meta.api_url required')
  }
  try {
    const u = assertPublicHttpsUrl(apiUrl.trim())
    return u.toString().replace(/\/$/, '')
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_invalid'
    throw new HermesSurfacesError(code, `invalid hermes api_url: ${code}`)
  }
}

/** Resolve Hermes API endpoint for a member via binding → agent-scoped hermes_api connector. */
export async function resolveMemberHermesEndpoint(
  env: Env,
  memberId: string,
): Promise<HermesApiEndpoint> {
  const binding = await getMemberHermesBinding(env, memberId)
  if (!binding) {
    throw new HermesSurfacesError('not_bound', 'member has no Hermes agent binding')
  }
  const cred = await resolveConnectorWithMeta(env, binding.agent_id, 'hermes_api')
  if (!cred) {
    throw new HermesSurfacesError(
      'hermes_api_unconfigured',
      'no active hermes_api connector for the bound agent',
    )
  }
  return {
    baseUrl: parseApiUrl(cred.meta),
    apiKey: cred.secret,
    agentId: binding.agent_id,
  }
}

export function hermesSessionKeyForMember(memberId: string): string {
  return `mupot-member:${assertUuid(memberId, 'member_id')}`
}

// Silence unused lint if AGENT_ID_RE kept for future
void AGENT_ID_RE
