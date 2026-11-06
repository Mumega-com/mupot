import type { Env } from '../types'
import { resolveDispatchDeliveryMode } from '../bus/consumer'
import { executionPausedSql } from './execution-brake-sql'
import { PRESENCE_STALE_SECONDS } from '../registry/service'
import { deriveFleetAgentRoute, deriveReceiverLiveness, presenceTtlSec, resolveFleetPresenceTtlSec, type FleetAgentRowIdentity } from '../fleet/registry'

/** Server-written by attach endpoints only. Boot/report runtime labels do not establish a heartbeat obligation. */
export const RESIDENT_CONNECTION_KIND = 'fleet_attach'
export const AGENT_LIVENESS_TTLS = {
  resident: { freshSeconds: resolveFleetPresenceTtlSec, deadMultiplier: 2 },
  poll: { freshSeconds: resolveFleetPresenceTtlSec, deadMultiplier: null },
  interactive: { freshSeconds: resolveFleetPresenceTtlSec, deadMultiplier: null },
  in_worker: { freshSeconds: null, deadMultiplier: null },
  presence: { freshSeconds: 600, deadMultiplier: 2 },
  module: { freshSeconds: PRESENCE_STALE_SECONDS, deadMultiplier: 2 },
  seat: { freshSeconds: presenceTtlSec, deadMultiplier: 2 },
} as const
export const LIVENESS_BATCH_SIZE = 200
export interface AgentLiveness {
  agentId: string
  state: 'live' | 'stale' | 'dead' | 'paused'
  mode: 'resident' | 'poll' | 'interactive' | 'in_worker'
  fresh: boolean
  operatorPaused: boolean
  deliveryMode: 'inbox' | 'in_worker'
  executionEligible: boolean
  assignmentEligible: boolean
  lastSeenAt: string | null
  deadSinceMs: number | null
  ttlSeconds: number | null
  ownerMemberId: string | null
  snapshot: string | null
}
const stampMs = (expr: string) => `(CASE WHEN typeof(${expr}) = 'text'
  AND ${expr} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
  AND (length(${expr}) = 10 OR (length(${expr}) >= 19 AND substr(${expr},11,1) IN ('T',' ')
    AND substr(${expr},14,1) = ':' AND substr(${expr},17,1) = ':'))
  THEN CAST(ROUND((julianday(${expr}) - 2440587.5) * 86400000.0) AS INTEGER) ELSE NULL END)`
const nowMsSql = (expr: string) => `(CASE WHEN typeof(${expr}) IN ('integer','real') THEN ${expr} ELSE ${stampMs(expr)} END)`
function aliasSql(column: string): string {
  return `(${column} = la.id OR (${column} = la.slug
    AND (SELECT COUNT(*) FROM agents siblings WHERE siblings.slug = la.slug) = 1
    AND NOT EXISTS (SELECT 1 FROM agents canonical WHERE canonical.id = la.slug)))`
}
/** All values are trusted SQL expressions or bind positions, never caller text. */
function factsSql(tenant: string, filter: string): string {
  const p = `p.tenant = ${tenant} AND ${aliasSql('p.agent_id')}`
  const m = `m.tenant = ${tenant} AND ${aliasSql('m.identity')}`
  const session = `s.tenant = ${tenant} AND s.agent_id = la.id`
  const validSession = `FROM agent_sessions s
    JOIN member_tokens t ON t.id = s.credential_id AND t.tenant = s.tenant AND t.agent_id = s.agent_id AND t.member_id = s.member_id
    JOIN members member ON member.id = s.member_id AND member.tenant = s.tenant AND member.status = 'active' AND member.archived_at IS NULL
    WHERE ${session} AND s.revoked_at IS NULL AND t.revoked_at IS NULL`
  const seat = `rs.tenant = ${tenant} AND rs.agent_id = la.id`
  return `SELECT la.id, la.status, la.archived_at, la.squad_id, la.owner_member_id,
    CASE WHEN ${executionPausedSql('la.id')} THEN 1 ELSE 0 END AS paused,
    lf.agent_id AS fleet_id,lf.runtime,lf.status AS fleet_status,lf.last_reported_at,lf.presence_mode,lf.presence_ttl_sec,lf.connection_kind,
    ${stampMs('lf.last_reported_at')} AS fleet_ms,
    (SELECT MAX(${stampMs('p.last_seen_at')}) FROM presence p WHERE ${p}) AS presence_ms,
    (SELECT MAX(${stampMs('m.last_heartbeat')}) FROM module_registry m WHERE ${m}) AS module_ms,
    (SELECT MAX(${stampMs('m.last_heartbeat')}) FROM module_registry m WHERE ${m} AND m.status = 'online') AS module_online_ms,
    (SELECT MAX(${stampMs('s.last_seen_at')}) FROM agent_sessions s WHERE ${session}) AS session_ms,
    (SELECT MAX(MIN(${stampMs('s.idle_expires_at')},${stampMs('s.absolute_expires_at')},
      CASE WHEN t.expires_at IS NULL THEN 253402300799000 ELSE ${stampMs('t.expires_at')} END)) ${validSession}) AS session_until_ms,
    (SELECT MAX(${stampMs('rs.last_heartbeat_at')}) FROM runtime_seats rs WHERE ${seat}) AS seat_ms,
    (SELECT MAX(${stampMs('rs.last_heartbeat_at')}) FROM runtime_seats rs WHERE ${seat} AND rs.state = 'active' AND rs.revoked_at IS NULL) AS seat_active_ms,
    (EXISTS (SELECT 1 FROM presence p WHERE ${p} AND ${stampMs('p.last_seen_at')} IS NULL)
      OR EXISTS (SELECT 1 FROM module_registry m WHERE ${m} AND ${stampMs('m.last_heartbeat')} IS NULL)
      OR EXISTS (SELECT 1 FROM runtime_seats rs WHERE ${seat} AND rs.state = 'active' AND rs.revoked_at IS NULL AND ${stampMs('rs.last_heartbeat_at')} IS NULL)
      OR EXISTS (SELECT 1 ${validSession} AND (${stampMs('s.last_seen_at')} IS NULL OR ${stampMs('s.idle_expires_at')} IS NULL
        OR ${stampMs('s.absolute_expires_at')} IS NULL OR (t.expires_at IS NOT NULL AND ${stampMs('t.expires_at')} IS NULL)))) AS invalid_evidence
    FROM agents la LEFT JOIN fleet_agents lf ON lf.tenant = ${tenant} AND (
      lf.agent_id = la.id OR (
        NOT EXISTS (SELECT 1 FROM fleet_agents exact_fleet WHERE exact_fleet.tenant = ${tenant} AND exact_fleet.agent_id = la.id)
        AND lf.agent_id = la.slug
        AND (SELECT COUNT(*) FROM agents siblings WHERE siblings.slug = la.slug) = 1
        AND NOT EXISTS (SELECT 1 FROM agents canonical WHERE canonical.id = la.slug)
      )) WHERE ${filter}`
}
function fleetTtlSql(env: Env): string {
  return `(CASE WHEN typeof(f.presence_ttl_sec) IN ('integer','real') AND f.presence_ttl_sec > 0
    THEN f.presence_ttl_sec ELSE ${AGENT_LIVENESS_TTLS.resident.freshSeconds(env,null)} END)`
}
/** One freshness predicate, consumed by the reader and both assignment UPDATEs. */
function freshSql(env: Env, now: string): string {
  const n = nowMsSql(now)
  return `COALESCE(((f.fleet_status <> 'stopped' AND f.fleet_ms + ${fleetTtlSql(env)} * 1000 >= ${n})
    OR f.presence_ms + ${AGENT_LIVENESS_TTLS.presence.freshSeconds * 1000} >= ${n}
    OR f.module_online_ms + ${AGENT_LIVENESS_TTLS.module.freshSeconds * 1000} >= ${n}
    OR f.session_until_ms > ${n}
    OR f.seat_active_ms + ${AGENT_LIVENESS_TTLS.seat.freshSeconds(env) * 1000} >= ${n}),0)`
}
function autoSql(env: Env, now: string): string {
  return `(f.status = 'active' AND f.archived_at IS NULL AND f.paused = 0 AND COALESCE(f.fleet_status,'') <> 'stopped'
    AND (${freshSql(env,now)} OR (f.presence_mode = 'poll' AND f.fleet_status <> 'stopped')))`
}
function snapshotSql(env: Env, now: string): string {
  return `json_array(f.id,f.status,f.archived_at,f.squad_id,f.owner_member_id,f.fleet_id,f.runtime,f.fleet_status,
    f.last_reported_at,f.presence_mode,f.presence_ttl_sec,f.connection_kind,f.presence_ms,f.module_ms,f.module_online_ms,
    f.session_ms,f.session_until_ms,f.seat_ms,f.seat_active_ms,f.invalid_evidence,${freshSql(env,now)})`
}
/** Reclaim uses the exact read-time aggregate snapshot; a new activity source defeats it atomically. */
export function livenessSnapshotMatchesSql(env: Env, p: { tenant: string; agentId: string; snapshot: string; now: string }): string {
  return `EXISTS (WITH liveness_facts AS (${factsSql(p.tenant,`la.id = ${p.agentId}`)})
    SELECT 1 FROM liveness_facts f WHERE ${snapshotSql(env,p.now)} = ${p.snapshot} AND f.paused = 0)`
}
/** Assignment checks the current contract, allowing renewed activity rather than requiring an old heartbeat value. */
export function assignmentLivenessProofSql(env: Env, p: { tenant: string; agentId: string; now: string }): string {
  return `EXISTS (WITH liveness_facts AS (${factsSql(p.tenant,`la.id = ${p.agentId}`)})
    SELECT 1 FROM liveness_facts f WHERE ${autoSql(env,p.now)})`
}
interface SourceRow {
  id:string;status:string;archived_at:string|null;owner_member_id:string|null;paused:number;snapshot:string
  fleet_id:string|null;runtime:string|null;fleet_status:string|null;last_reported_at:string|null;presence_mode:string|null;presence_ttl_sec:number|null;connection_kind:string|null
  fleet_ms:number|null;presence_ms:number|null;module_ms:number|null;module_online_ms:number|null;session_ms:number|null;session_until_ms:number|null;seat_ms:number|null;seat_active_ms:number|null;invalid_evidence:number;any_fresh:number;auto_eligible:number
}
export async function agentLiveness(env: Env, ids: readonly string[], nowMs = Date.now()): Promise<Map<string,AgentLiveness>> {
  const result=new Map<string,AgentLiveness>(),unique=[...new Set(ids)]
  for(let offset=0;offset<unique.length;offset+=LIVENESS_BATCH_SIZE){
    const batch=unique.slice(offset,offset+LIVENESS_BATCH_SIZE)
    const rows=await env.DB.prepare(`WITH liveness_facts AS (${factsSql('?1','la.id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))')})
      SELECT f.*,${freshSql(env,'?3')} AS any_fresh,${autoSql(env,'?3')} AS auto_eligible,${snapshotSql(env,'?3')} AS snapshot FROM liveness_facts f`)
      .bind(env.TENANT_SLUG,JSON.stringify(batch),nowMs).all<SourceRow>()
    const byId=new Map((rows.results??[]).map(row=>[row.id,row]))
    for(const id of batch){
      const row=byId.get(id)
      const fleet: FleetAgentRowIdentity|null=row?.fleet_id?{agent_id:row.fleet_id,runtime:row.runtime,status:row.fleet_status,last_reported_at:row.last_reported_at,presence_mode:row.presence_mode,presence_ttl_sec:row.presence_ttl_sec}:null
      const route=deriveFleetAgentRoute(env,fleet,nowMs),receiver=deriveReceiverLiveness(env,fleet,nowMs)
      const mode:AgentLiveness['mode']=route.presenceMode==='poll'?'poll':row?.connection_kind===RESIDENT_CONNECTION_KIND?'resident':route.runtime?'interactive':'in_worker'
      const ttl=AGENT_LIVENESS_TTLS[mode].freshSeconds?.(env,fleet)??null
      const fresh=row?.any_fresh===1
      const deadlines:number[]=[]
      if(row?.fleet_ms!==null&&row?.fleet_ms!==undefined)deadlines.push(row.fleet_ms+(ttl??presenceTtlSec(env))*AGENT_LIVENESS_TTLS.resident.deadMultiplier*1000)
      if(row?.presence_ms!=null)deadlines.push(row.presence_ms+AGENT_LIVENESS_TTLS.presence.freshSeconds*AGENT_LIVENESS_TTLS.presence.deadMultiplier*1000)
      if(row?.module_ms!=null)deadlines.push(row.module_ms+AGENT_LIVENESS_TTLS.module.freshSeconds*AGENT_LIVENESS_TTLS.module.deadMultiplier*1000)
      if(row?.session_ms!=null)deadlines.push(row.session_ms+AGENT_LIVENESS_TTLS.presence.freshSeconds*AGENT_LIVENESS_TTLS.presence.deadMultiplier*1000)
      if(row?.session_until_ms!=null)deadlines.push(row.session_until_ms)
      if(row?.seat_ms!=null)deadlines.push(row.seat_ms+AGENT_LIVENESS_TTLS.seat.freshSeconds(env)*AGENT_LIVENESS_TTLS.seat.deadMultiplier*1000)
      const deadline=Math.max(...deadlines)
      const timeDead=mode==='resident'&&row?.fleet_ms!=null&&row.invalid_evidence===0&&!fresh&&Number.isFinite(deadline)&&nowMs>deadline
      const paused=row?.status==='paused'||row?.paused===1||receiver.reason==='stopped'
      const active=row?.status==='active'&&row.archived_at===null
      const state:AgentLiveness['state']=paused?'paused':!row?'stale':!active?'dead':fresh?'live':timeDead?'dead':'stale'
      const executionEligible=!!active&&!paused&&receiver.ok
      const seen=[row?.fleet_ms,row?.presence_ms,row?.module_ms,row?.session_ms,row?.seat_ms].filter((v):v is number=>v!=null&&Number.isFinite(v))
      result.set(id,{agentId:id,state,mode,fresh,operatorPaused:paused,deliveryMode:resolveDispatchDeliveryMode(route,false),executionEligible,
        assignmentEligible:executionEligible&&row?.auto_eligible===1,lastSeenAt:seen.length?new Date(Math.max(...seen)).toISOString():null,
        deadSinceMs:!paused&&timeDead?deadline:null,ttlSeconds:ttl,ownerMemberId:row?.owner_member_id??null,snapshot:row?.snapshot??null})
    }
  }
  return result
}
