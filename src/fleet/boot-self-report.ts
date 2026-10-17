// src/fleet/boot-self-report.ts — an agent tells the registry what it IS, at boot.
//
// THE PROBLEM THIS CLOSES (2026-09-03). `fleet_agents.runtime` and `.model` only ever
// moved via POST /api/fleet/attach{,-signed} — an HTTP call a HOST daemon makes. An agent
// that boots over MCP never touched it. So when Athena's harness moved from Codex to grok,
// her row kept saying `pi` while presence kept `last_reported_at` fresh: the timestamp
// vouching for a field nothing had rechecked. Reading mupot, you could not tell which
// model was gating your pull requests.
//
// Freshness and correctness are separate properties, and a fresh timestamp beside a stale
// field is worse than an obviously old row — it reads as confirmed.
//
// TRUST POSTURE. A self-reported runtime is a CLAIM, not an attestation. That is the same
// posture attach-routes already takes for its runtime-reported `model` ("mupot labels it
// runtime-reported, never canonical"), and this path is no stronger: it is bearer-
// authenticated, so it can say what it loaded and nothing more. Two consequences, both
// enforced below:
//
//   1. The agent id is ALWAYS the caller's own bound agent, never an argument. There is
//      no shape of this call that writes somebody else's row.
//   2. An agent with a REGISTERED SIGNING KEY is refused. attach-routes closes the bearer
//      /attach path for keyed agents on purpose ("no auth downgrade"); if this path did
//      not honour the same rule it would be a way around the signature requirement, and
//      the weaker door would win simply by being newer.

import type { Env } from '../types'
import { hasRegisteredKey } from './agent-keys'
import { canonicalHarness, cleanReported, isNonAdoptedRuntime, NON_ADOPTED_DETAIL, MAX_REPORTED, MAX_REPORTED_MODEL } from './reported-values'

// INTAKE IS GRACEFUL (Hadi 2026-10-16): an unknown runtime/model/host is never a reason to
// refuse a boot. Any bounded string is kept as reported (trimmed, control chars stripped,
// truncated); `runtime_canonical` is a hint ('other' when unrecognised), never a gate. The
// only refusal is a non-string value. Authority never derives from these strings.

/** How the caller connected — derived by the SERVER from authentication, never from args. */
export type ConnectionKind = 'agent_bound' | 'seat' | 'attached' | 'member'

export interface FleetBelief {
  runtime: string
  model: string | null
  status: string
  reported_by: string
  last_reported_at: string
  /** Observed facts (migration 0235). Additive. */
  runtime_canonical: string
  host: string
  connection_kind: string
  last_boot_at: string | null
}

export type BootSelfReport =
  /** Nothing was claimed, so no runtime/model/host was written (connection kind + boot time still are). */
  | { outcome: 'nothing_reported'; belief: FleetBelief | null }
  /** Written. `changed` names the fields whose value actually moved. */
  | { outcome: 'recorded'; belief: FleetBelief | null; changed: string[]; notes?: string[] }
  /** Keyed agent: must use /api/fleet/attach-signed. */
  | { outcome: 'refused_signed_attach_required'; belief: FleetBelief | null; detail: string }
  /** The runtime is a formally non-adopted one (shared check). Nothing written. */
  | { outcome: 'refused_not_adopted'; belief: FleetBelief | null; detail: string }
  /** A reported value was not a string. Nothing written. */
  | { outcome: 'refused_not_a_string'; belief: FleetBelief | null; detail: string }

export const MODEL_RE = /^[A-Za-z0-9_./@-]{1,128}$/

export async function readFleetBelief(env: Env, agentId: string): Promise<FleetBelief | null> {
  const r = await env.DB.prepare(
    `SELECT runtime, model, status, reported_by, last_reported_at,
            runtime_canonical, host, connection_kind, last_boot_at
       FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(env.TENANT_SLUG, agentId).first<FleetBelief>()
  // Canonical is a pure function of the raw runtime, so compute it at read: daemon /report and the
  // harness backfill write runtime without it, and a stored hint could go stale.
  return r ? { ...r, runtime_canonical: r.runtime ? canonicalHarness(r.runtime) : '' } : null
}

type Claimed = { present: boolean; value: string | null; bad: boolean }
function claimed(v: unknown, max: number): Claimed {
  if (v === undefined || v === null) return { present: false, value: null, bad: false }
  if (typeof v !== 'string') return { present: true, value: null, bad: true }
  const value = cleanReported(v, max)
  return { present: value !== null, value, bad: false }
}

/** Record what a booting agent says it is. Own row only; keyed agents refused.
 *
 *  Only the fields actually claimed are written — an agent that reports a runtime but no
 *  model must not blank its model. A blanket upsert would make a partial report look like
 *  a complete one, which is the defect class this whole change is about.
 *
 *  `connectionKind` is passed by the caller from authentication (never from tool args). */
export async function selfReportAtBoot(
  env: Env,
  agentId: string,
  claim: { runtime?: unknown; model?: unknown; host?: unknown },
  connectionKind: ConnectionKind = 'agent_bound',
): Promise<BootSelfReport> {
  const belief = await readFleetBelief(env, agentId)

  const rt = claimed(claim.runtime, MAX_REPORTED)
  const md = claimed(claim.model, MAX_REPORTED_MODEL)
  const hs = claimed(claim.host, MAX_REPORTED)
  const badField = rt.bad ? 'runtime' : md.bad ? 'model' : hs.bad ? 'host' : null
  if (badField) {
    return { outcome: 'refused_not_a_string', belief, detail: `${badField}: must be a string` }
  }

  if (rt.value !== null && isNonAdoptedRuntime(rt.value)) {
    return { outcome: 'refused_not_adopted', belief, detail: `runtime: ${NON_ADOPTED_DETAIL}` }
  }

  if (await hasRegisteredKey(env, agentId)) {
    if (!rt.present && !md.present && !hs.present) return { outcome: 'nothing_reported', belief }
    return {
      outcome: 'refused_signed_attach_required',
      belief,
      detail:
        'this agent has a registered signing key, so its fleet row moves by signature only — '
        + 'report via POST /api/fleet/attach-signed. Boot-time self-report is bearer-authenticated '
        + 'and must not be a way around that.',
    }
  }

  if (!rt.present && !md.present && !hs.present) {
    // Nothing to claim: still stamp the two facts the SERVER observed (how it connected, when).
    // Existing row only — boot alone never creates a registry row or flips status.
    if (belief) {
      await env.DB.prepare(
        `UPDATE fleet_agents SET connection_kind = ?3, last_boot_at = datetime('now')
          WHERE tenant = ?1 AND agent_id = ?2`,
      ).bind(env.TENANT_SLUG, agentId, connectionKind).run()
    }
    return { outcome: 'nothing_reported', belief: belief ? await readFleetBelief(env, agentId) : null }
  }

  const runtime = rt.value
  const model = md.value
  const host = hs.value
  const runtimeCanonical = runtime === null ? null : canonicalHarness(runtime)

  const changed: string[] = []
  if (runtime !== null && runtime !== (belief?.runtime ?? '')) changed.push('runtime')
  if (model !== null && model !== (belief?.model ?? null)) changed.push('model')
  if (host !== null && host !== (belief?.host ?? '')) changed.push('host')

  if (belief === null) {
    await env.DB.prepare(
      `INSERT INTO fleet_agents
             (agent_id, tenant, runtime, runtime_canonical, status, reported_by, model, host,
              connection_kind, last_boot_at, last_reported_at, updated_at)
       VALUES (?1, ?2, COALESCE(?3, ''), COALESCE(?4, ''), 'running', ?1, ?5, COALESCE(?6, ''),
               ?7, datetime('now'), datetime('now'), datetime('now'))
       ON CONFLICT(tenant, agent_id) DO NOTHING`,
    ).bind(agentId, env.TENANT_SLUG, runtime, runtimeCanonical, model, host, connectionKind).run()
  } else {
    // COALESCE so an unclaimed field keeps its stored value rather than being blanked.
    await env.DB.prepare(
      `UPDATE fleet_agents
          SET runtime           = COALESCE(?3, runtime),
              runtime_canonical = COALESCE(?4, runtime_canonical),
              model             = COALESCE(?5, model),
              host              = COALESCE(?6, host),
              connection_kind   = ?7,
              last_boot_at      = datetime('now'),
              status            = 'running',
              reported_by       = ?1,
              last_reported_at  = datetime('now'),
              updated_at        = datetime('now')
        WHERE tenant = ?2 AND agent_id = ?1`,
    ).bind(agentId, env.TENANT_SLUG, runtime, runtimeCanonical, model, host, connectionKind).run()
  }

  // The identity record is what the dashboard reads, so a truthful runtime report must
  // reach it too — same rule attach-routes follows, labelled runtime-reported downstream.
  // agents.model can reach an LLM URL, so it only takes the strict charset. The raw value is kept in
  // fleet_agents.model; a value outside the charset leaves agents.model unchanged and says so.
  const notes: string[] = []
  if (model !== null) {
    if (MODEL_RE.test(model)) {
      await env.DB.prepare(`UPDATE agents SET model = ?1 WHERE id = ?2`).bind(model, agentId).run()
    } else {
      notes.push('model recorded in the fleet registry as reported; agents.model unchanged (it only accepts [A-Za-z0-9_./@-], 1-128 chars)')
    }
  }

  return { outcome: 'recorded', belief: await readFleetBelief(env, agentId), changed, ...(notes.length ? { notes } : {}) }
}
