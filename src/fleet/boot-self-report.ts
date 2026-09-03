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
import { isValidRuntime, runtimeVocabulary } from './runtimes'

export interface FleetBelief {
  runtime: string
  model: string | null
  status: string
  reported_by: string
  last_reported_at: string
}

export type BootSelfReport =
  /** Nothing was claimed, so nothing was written. */
  | { outcome: 'nothing_reported'; belief: FleetBelief | null }
  /** Written. `changed` names the fields whose value actually moved. */
  | { outcome: 'recorded'; belief: FleetBelief | null; changed: string[] }
  /** Keyed agent: must use /api/fleet/attach-signed. */
  | { outcome: 'refused_signed_attach_required'; belief: FleetBelief | null; detail: string }
  /** Claimed a runtime outside the vocabulary — told which words exist. */
  | { outcome: 'refused_unknown_runtime'; belief: FleetBelief | null; detail: string }

const MODEL_RE = /^[A-Za-z0-9_./@-]{1,128}$/

export async function readFleetBelief(env: Env, agentId: string): Promise<FleetBelief | null> {
  return env.DB.prepare(
    `SELECT runtime, model, status, reported_by, last_reported_at
       FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(env.TENANT_SLUG, agentId).first<FleetBelief>()
}

/** Record what a booting agent says it is. Own row only; keyed agents refused.
 *
 *  Only the fields actually claimed are written — an agent that reports a runtime but no
 *  model must not blank its model. A blanket upsert would make a partial report look like
 *  a complete one, which is the defect class this whole change is about. */
export async function selfReportAtBoot(
  env: Env,
  agentId: string,
  claim: { runtime?: unknown; model?: unknown },
): Promise<BootSelfReport> {
  const belief = await readFleetBelief(env, agentId)

  const wantsRuntime = claim.runtime !== undefined && claim.runtime !== null
  const wantsModel = claim.model !== undefined && claim.model !== null
  if (!wantsRuntime && !wantsModel) return { outcome: 'nothing_reported', belief }

  if (wantsRuntime && !isValidRuntime(claim.runtime)) {
    return {
      outcome: 'refused_unknown_runtime',
      belief,
      // Name the whole vocabulary. A refusal that withholds the valid values is what
      // makes an agent give up and stay stale instead of correcting itself.
      detail: `runtime: must be one of ${runtimeVocabulary()}`,
    }
  }
  if (wantsModel && (typeof claim.model !== 'string' || !MODEL_RE.test(claim.model))) {
    return { outcome: 'refused_unknown_runtime', belief, detail: 'model: 1-128 chars of [A-Za-z0-9_./@-]' }
  }

  if (await hasRegisteredKey(env, agentId)) {
    return {
      outcome: 'refused_signed_attach_required',
      belief,
      detail:
        'this agent has a registered signing key, so its fleet row moves by signature only — '
        + 'report via POST /api/fleet/attach-signed. Boot-time self-report is bearer-authenticated '
        + 'and must not be a way around that.',
    }
  }

  const runtime = wantsRuntime ? (claim.runtime as string) : null
  const model = wantsModel ? (claim.model as string) : null

  const changed: string[] = []
  if (runtime !== null && runtime !== (belief?.runtime ?? '')) changed.push('runtime')
  if (model !== null && model !== (belief?.model ?? null)) changed.push('model')

  if (belief === null) {
    await env.DB.prepare(
      `INSERT INTO fleet_agents
             (agent_id, tenant, runtime, status, reported_by, model, last_reported_at, updated_at)
       VALUES (?1, ?2, COALESCE(?3, ''), 'running', ?1, ?4, datetime('now'), datetime('now'))
       ON CONFLICT(tenant, agent_id) DO NOTHING`,
    ).bind(agentId, env.TENANT_SLUG, runtime, model).run()
  } else {
    // COALESCE so an unclaimed field keeps its stored value rather than being blanked.
    await env.DB.prepare(
      `UPDATE fleet_agents
          SET runtime          = COALESCE(?3, runtime),
              model            = COALESCE(?4, model),
              status           = 'running',
              reported_by      = ?1,
              last_reported_at = datetime('now'),
              updated_at       = datetime('now')
        WHERE tenant = ?2 AND agent_id = ?1`,
    ).bind(agentId, env.TENANT_SLUG, runtime, model).run()
  }

  // The identity record is what the dashboard reads, so a truthful runtime report must
  // reach it too — same rule attach-routes follows, labelled runtime-reported downstream.
  if (model !== null) {
    await env.DB.prepare(`UPDATE agents SET model = ?1 WHERE id = ?2`).bind(model, agentId).run()
  }

  return { outcome: 'recorded', belief: await readFleetBelief(env, agentId), changed }
}
