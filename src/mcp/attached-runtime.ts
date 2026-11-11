// attached-runtime — the store behind "an attached chat may say what it is running" (migration 0273).
//
// agent_reported_runtime: a LIVE, self-reported runtime fact, one row per attachment. It is not the agent's configured profile and not
// presence (presence feeds liveness and assignment; an attached chat is not the agent's host). Nothing in routing, liveness or assignment
// reads it. It is shown to squad peers as a per-attachment, self-reported list (`attached_runtime`), never as the agent's `live_model`.
import type { Env } from '../types'
import { MODEL_RE } from '../fleet/boot-self-report'
import { normalizeEffort } from '../fleet/presence'

export interface ReportedRuntime {
  harness: string | null
  machine: string | null
  model: string | null
  provider: string | null
  effort: string | null
}

const HARNESS_RE = /^[A-Za-z0-9_.-]{1,64}$/
// Host names: letters, digits, space and . _ : @ - only. No markup, quotes, control or bidi characters.
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:@-]{0,119}$/

export const RUNTIME_FIELDS = ['harness', 'machine', 'model', 'provider', 'effort'] as const
export type RuntimeField = (typeof RUNTIME_FIELDS)[number]

/**
 * What a caller said, validated for STORAGE. A field the caller omitted is null (it keeps its earlier stored value); a field that is
 * present but does not pass is dropped and named in `rejected` (never stored, never normalised into something else).
 * Nothing here is ever a default: an omitted harness is null, not 'unknown'.
 */
export function cleanAttachedRuntime(args: Record<string, unknown>): { values: ReportedRuntime; rejected: RuntimeField[] } {
  const rejected: RuntimeField[] = []
  const pick = (field: RuntimeField, ok: (s: string) => boolean): string | null => {
    const raw = args[field]
    if (raw === undefined || raw === null) return null
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (s.length > 0 && ok(s)) return s
    rejected.push(field)
    return null
  }
  const values: ReportedRuntime = {
    harness: pick('harness', (s) => HARNESS_RE.test(s)),
    machine: pick('machine', (s) => MACHINE_RE.test(s)),
    model: pick('model', (s) => MODEL_RE.test(s)),
    provider: pick('provider', (s) => MODEL_RE.test(s)),
    effort: pick('effort', (s) => normalizeEffort(s) !== null),
  }
  return { values, rejected }
}

/** Upsert this attachment's report. Axes the caller left out (null) keep their earlier stored value. */
export async function recordAttachedRuntime(
  env: Env,
  who: { agentId: string; attachmentId: string; memberId: string },
  r: ReportedRuntime,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_reported_runtime (tenant, agent_id, attachment_id, reported_by_member_id, harness, machine, model, provider, effort)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(tenant, agent_id, attachment_id) DO UPDATE SET
       reported_by_member_id = excluded.reported_by_member_id,
       harness  = COALESCE(excluded.harness, agent_reported_runtime.harness),
       machine  = COALESCE(excluded.machine, agent_reported_runtime.machine),
       model    = COALESCE(excluded.model, agent_reported_runtime.model),
       provider = COALESCE(excluded.provider, agent_reported_runtime.provider),
       effort   = COALESCE(excluded.effort, agent_reported_runtime.effort),
       reported_at = datetime('now')`,
  ).bind(env.TENANT_SLUG, who.agentId, who.attachmentId, who.memberId, r.harness, r.machine, r.model, r.provider, r.effort).run()
}

export interface AttachedRuntimeRow extends ReportedRuntime { agent_id: string; reported_at: string }

export const ATTACHED_RUNTIME_WINDOW_MS = 24 * 60 * 60 * 1000
export const ATTACHED_RUNTIME_PER_AGENT = 3

/** The oldest report still shown, as SQLite UTC text. */
export const attachedRuntimeSince = (nowMs: number): string => new Date(nowMs - ATTACHED_RUNTIME_WINDOW_MS).toISOString().slice(0, 19).replace('T', ' ')

/** Reports since `sinceSqlite` (SQLite UTC text) for the given agents, newest first, at most ATTACHED_RUNTIME_PER_AGENT each.
 *  Ids travel as ONE json parameter. The attachment id is never returned. */
export async function loadAttachedRuntime(env: Env, agentIds: ReadonlyArray<string>, sinceSqlite: string): Promise<Map<string, AttachedRuntimeRow[]>> {
  const out = new Map<string, AttachedRuntimeRow[]>()
  if (agentIds.length === 0) return out
  const res = await env.DB.prepare(
    `SELECT agent_id, harness, machine, model, provider, effort, reported_at FROM agent_reported_runtime
      WHERE tenant = ?1 AND reported_at >= ?3 AND agent_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
      ORDER BY reported_at DESC, rowid DESC LIMIT 2000`,
  ).bind(env.TENANT_SLUG, JSON.stringify(agentIds), sinceSqlite).all<AttachedRuntimeRow>()
  for (const r of res.results ?? []) {
    const list = out.get(r.agent_id) ?? []
    if (list.length < ATTACHED_RUNTIME_PER_AGENT) out.set(r.agent_id, [...list, r])
  }
  return out
}

/** Has THIS attachment reported anything (any field)? Keyed by tenant + agent + attachment, never by agent alone. */
export async function attachmentHasReported(env: Env, agentId: string, attachmentId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 AS one FROM agent_reported_runtime WHERE tenant = ?1 AND agent_id = ?2 AND attachment_id = ?3 LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId, attachmentId).first<{ one: number }>()
  return r !== null && r !== undefined
}
