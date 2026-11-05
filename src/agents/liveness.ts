import type { Env } from '../types'
import { resolveDispatchDeliveryMode } from '../bus/consumer'
import { executionPausedSql } from './execution-brake-sql'
import { deriveFleetAgentRoute, deriveReceiverLiveness, parseStamp, resolveFleetPresenceTtlSec, type FleetAgentRowIdentity } from '../fleet/registry'

/** Registry TTL resolution is authoritative for both registered modes; Worker execution has no heartbeat requirement. */
export const AGENT_LIVENESS_TTLS = {
  resident: { freshSeconds: resolveFleetPresenceTtlSec, deadMultiplier: 2 },
  poll: { freshSeconds: resolveFleetPresenceTtlSec, deadMultiplier: null },
  in_worker: { freshSeconds: null, deadMultiplier: null },
} as const
export const LIVENESS_BATCH_SIZE = 200
export interface AgentLiveness {
  agentId: string
  state: 'live' | 'stale' | 'dead' | 'paused'
  mode: keyof typeof AGENT_LIVENESS_TTLS
  fresh: boolean
  operatorPaused: boolean
  deliveryMode: 'inbox' | 'in_worker'
  executionEligible: boolean
  assignmentEligible: boolean
  lastSeenAt: string | null
  deadSinceMs: number | null
  ttlSeconds: number | null
  ownerMemberId: string | null
  /** Exact read-time source tuple, reasserted by reclaim inside its UPDATE. Not a credential. */
  snapshot: string | null
}

/** Same exact-ID-first / unambiguous, unreserved-slug fallback as readFleetAgentRow. Trusted SQL only. */
function sourceSql(tenant: string): string {
  return `FROM agents la LEFT JOIN fleet_agents lf ON lf.tenant = ${tenant} AND (
    lf.agent_id = la.id OR (
      NOT EXISTS (SELECT 1 FROM fleet_agents exact_fleet WHERE exact_fleet.tenant = ${tenant} AND exact_fleet.agent_id = la.id)
      AND lf.agent_id = la.slug
      AND (SELECT COUNT(*) FROM agents siblings WHERE siblings.slug = la.slug) = 1
      AND NOT EXISTS (SELECT 1 FROM agents canonical WHERE canonical.id = la.slug)
    ))`
}
const SNAPSHOT_SQL = `json_array(la.id, la.status, la.archived_at, la.squad_id, la.owner_member_id,
  lf.agent_id, lf.runtime, lf.status, lf.last_reported_at, lf.presence_mode, lf.presence_ttl_sec)`

/** A revival, detach, reassignment of identity, ownership change or pause after the read must win. */
export function livenessSnapshotMatchesSql(p: { tenant: string; agentId: string; snapshot: string }): string {
  return `EXISTS (SELECT 1 ${sourceSql(p.tenant)} WHERE la.id = ${p.agentId}
    AND ${SNAPSHOT_SQL} = ${p.snapshot}
    AND NOT ${executionPausedSql('la.id')})`
}
interface SourceRow {
  id: string; status: string; archived_at: string | null; owner_member_id: string | null; paused: number; snapshot: string
  fleet_id: string | null; runtime: string | null; fleet_status: string | null; last_reported_at: string | null
  presence_mode: string | null; presence_ttl_sec: number | null
}

/** Batch read contract. Freshness never substitutes for operator intent, delivery mode or execution eligibility. */
export async function agentLiveness(env: Env, ids: readonly string[], nowMs = Date.now()): Promise<Map<string, AgentLiveness>> {
  const result = new Map<string, AgentLiveness>(), unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += LIVENESS_BATCH_SIZE) {
    const batch = unique.slice(offset, offset + LIVENESS_BATCH_SIZE)
    const rows = await env.DB.prepare(`SELECT la.id, la.status, la.archived_at, la.owner_member_id,
      CASE WHEN ${executionPausedSql('la.id')} THEN 1 ELSE 0 END AS paused, ${SNAPSHOT_SQL} AS snapshot,
      lf.agent_id AS fleet_id, lf.runtime, lf.status AS fleet_status, lf.last_reported_at, lf.presence_mode, lf.presence_ttl_sec
      ${sourceSql('?1')} WHERE la.id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))`)
      .bind(env.TENANT_SLUG, JSON.stringify(batch)).all<SourceRow>()
    const byId = new Map((rows.results ?? []).map(row => [row.id, row]))
    for (const id of batch) {
      const row = byId.get(id)
      const fleet: FleetAgentRowIdentity | null = row?.fleet_id ? {
        agent_id: row.fleet_id, runtime: row.runtime ?? '', status: row.fleet_status ?? 'unknown',
        last_reported_at: row.last_reported_at ?? '', presence_mode: row.presence_mode ?? '', presence_ttl_sec: row.presence_ttl_sec,
      } : null
      const route = deriveFleetAgentRoute(env, fleet, nowMs)
      const receiver = deriveReceiverLiveness(env, fleet, nowMs)
      const mode = route.presenceMode === 'poll' ? 'poll' : route.runtime ? 'resident' : 'in_worker'
      const policy = AGENT_LIVENESS_TTLS[mode]
      const ttl = policy.freshSeconds ? policy.freshSeconds(env, fleet) : null
      const stamp = row?.last_reported_at ? parseStamp(row.last_reported_at) : NaN
      const hasStamp = Number.isFinite(stamp)
      const timeDead = mode === 'resident' && hasStamp && nowMs > stamp + ttl! * policy.deadMultiplier! * 1000
      const paused = row?.status === 'paused' || row?.paused === 1 || receiver.reason === 'stopped'
      const active = row?.status === 'active' && row.archived_at === null
      const state: AgentLiveness['state'] = paused ? 'paused' : !row ? 'stale' : !active ? 'dead'
        : mode === 'in_worker' ? 'live' : route.live ? 'live' : timeDead ? 'dead' : 'stale'
      const executionEligible = !!active && !paused && receiver.ok
      result.set(id, { agentId: id, state, mode, fresh: route.live, operatorPaused: paused,
        deliveryMode: resolveDispatchDeliveryMode(route, false),
        executionEligible, assignmentEligible: executionEligible && state !== 'dead',
        lastSeenAt: row?.last_reported_at ?? null, deadSinceMs: !paused && timeDead ? stamp + ttl! * policy.deadMultiplier! * 1000 : null,
        ttlSeconds: ttl, ownerMemberId: row?.owner_member_id ?? null, snapshot: row?.snapshot ?? null })
    }
  }
  return result
}
