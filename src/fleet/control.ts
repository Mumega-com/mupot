// Fleet Control — emit a signed control-request (Deliverable 2, mupot side).
//
// Turns a {agent_id, verb} into a SIGNED control-request and drops it in the host consumer's inbox
// (0032), then records the audit row (0034). The host daemon reads the inbox, VERIFIES the
// signature (Ed25519 + freshness + nonce) and only then runs the verb. The signature is the
// authorization the host trusts — independent of the inbox transport (defense in depth: even a
// compromised inbox can't forge a control-request without FLEET_PANEL_SK).

import type { Env } from '../types'
import { signControlRequest, signSquadControlRequest, ControlRequestError } from './control-request'
import { sendAgentMessage } from '../agents/messages'
import { listSquadMemberIds } from './registry'

export interface ControlPrincipal {
  memberId: string
  boundAgentId: string | null
}

export type EmitResult =
  | { ok: true; nonce: string; agent_id: string; verb: string; seq: number | null }
  | { ok: false; reason: 'unconfigured' | 'invalid_input' | 'send_failed'; detail?: string }

export type EmitSquadResult =
  | { ok: true; nonce: string; squad_id: string; verb: string; seq: number | null }
  | { ok: false; reason: 'unconfigured' | 'invalid_input' | 'send_failed'; detail?: string }

export async function emitControlRequest(
  env: Env,
  input: { agent_id: string; verb: string },
  principal: ControlPrincipal,
): Promise<EmitResult> {
  // Fail-closed: without the signing key or a target consumer there is no safe action.
  if (!env.FLEET_PANEL_SK) return { ok: false, reason: 'unconfigured', detail: 'FLEET_PANEL_SK not set' }
  if (!env.FLEET_CONSUMER_AGENT) return { ok: false, reason: 'unconfigured', detail: 'FLEET_CONSUMER_AGENT not set' }

  let req
  try {
    req = await signControlRequest(env.FLEET_PANEL_SK, input)
  } catch (e) {
    if (e instanceof ControlRequestError) return { ok: false, reason: 'invalid_input', detail: e.message }
    throw e
  }

  // from_agent is the welded agent when the token is agent-bound, else the operator panel.
  // from_member is ALWAYS the authenticated principal (accountability — never from body).
  const fromAgent = principal.boundAgentId ?? 'fleet-panel'
  const send = await sendAgentMessage(env, {
    fromAgent,
    fromMember: principal.memberId,
    toAgent: env.FLEET_CONSUMER_AGENT,
    kind: 'request',
    body: JSON.stringify(req),
    // nonce is unique per request, so this rid makes the inbox send idempotent too.
    requestId: `ctl-${req.nonce}`,
  }, {
    system: true,
    reason: 'target is env.FLEET_CONSUMER_AGENT, a fixed operator-configured binding, never attacker input',
  })
  const seq = send.ok ? send.seq : null

  // Audit row (best-effort — the signed request is the source of truth; a logging failure must
  // not block the control action, but we record before returning success).
  try {
    await env.DB.prepare(
      `INSERT INTO fleet_control_log (id, tenant, agent_id, verb, nonce, requested_by_member, requested_by_agent, message_seq)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(crypto.randomUUID(), env.TENANT_SLUG, req.agent_id, req.verb, req.nonce, principal.memberId, principal.boundAgentId, seq)
      .run()
  } catch {
    /* audit log is best-effort */
  }

  if (!send.ok) return { ok: false, reason: 'send_failed', detail: send.reason }
  return { ok: true, nonce: req.nonce, agent_id: req.agent_id, verb: req.verb, seq }
}

/**
 * Squad-targeted twin of emitControlRequest — signs a {squad_id, verb} request instead of
 * {agent_id, verb}. The host's engine.control_squad fans the verb out to every manifest whose
 * `squads` includes squad_id; a squad_id is only ever a SELECTOR for which already-declared
 * manifests run, same trust boundary as the single-agent path.
 *
 * MEMBERSHIP BINDING (kasra-review, PR #954/#957/#1004 BLOCK gate — closed here): the dashboard's
 * squad confirm() dialog names agents resolved from THIS pot's `fleet_agents` cache — a
 * SELF-REPORTED, agent-controlled source (src/fleet/registry.ts) that can be stale or wrong. The
 * host's engine.control_squad executes against a DIFFERENT source (its own live, version-
 * controlled manifest registry). Without binding them together, an operator's confirm could show
 * one blast radius while a different one actually runs. The fix: resolve the member set HERE,
 * server-side (never from the client/form — see listSquadMemberIds), and sign it into the
 * request. The host re-resolves membership live and REFUSES the whole action if the two sets
 * disagree (engine.control_squad's expected_members parameter) — so this function's ONLY job is
 * to sign an honest snapshot of what mupot currently believes; the host is what actually
 * enforces the match.
 *
 * owner_scope: this function still does NOT filter by the manifest's `owner_scope` (matches the
 * pre-existing single-agent emitControlRequest above) — not exploitable today (one scope,
 * "mumega", in the whole registry). Real enforcement lives on the HOST daemon (mumega-com PR
 * #957): it requires its own locally-configured FLEET_OWNER_SCOPE and never trusts anything this
 * mupot-signed payload carries, so a second tenant sharing this host could never be swept in via
 * either the agent- or squad-targeted path regardless of what mupot signs.
 */
export async function emitSquadControlRequest(
  env: Env,
  input: { squad_id: string; verb: string },
  principal: ControlPrincipal,
): Promise<EmitSquadResult> {
  if (!env.FLEET_PANEL_SK) return { ok: false, reason: 'unconfigured', detail: 'FLEET_PANEL_SK not set' }
  if (!env.FLEET_CONSUMER_AGENT) return { ok: false, reason: 'unconfigured', detail: 'FLEET_CONSUMER_AGENT not set' }

  // Resolve NOW, server-side, from mupot's own registry — never from the caller. This is the
  // exact set that gets signed (see the doc comment above); the caller only ever supplies
  // squad_id + verb.
  const members = await listSquadMemberIds(env, input.squad_id)
  if (members.length === 0) {
    return { ok: false, reason: 'invalid_input', detail: `squad "${input.squad_id}" has no known members in the fleet registry` }
  }

  let req
  try {
    req = await signSquadControlRequest(env.FLEET_PANEL_SK, { squad_id: input.squad_id, verb: input.verb, members })
  } catch (e) {
    if (e instanceof ControlRequestError) return { ok: false, reason: 'invalid_input', detail: e.message }
    throw e
  }

  const fromAgent = principal.boundAgentId ?? 'fleet-panel'
  const send = await sendAgentMessage(env, {
    fromAgent,
    fromMember: principal.memberId,
    toAgent: env.FLEET_CONSUMER_AGENT,
    kind: 'request',
    body: JSON.stringify(req),
    requestId: `ctl-squad-${req.nonce}`,
  }, {
    system: true,
    reason: 'target is env.FLEET_CONSUMER_AGENT, a fixed operator-configured binding, never attacker input',
  })
  const seq = send.ok ? send.seq : null

  // Audit row — same ledger as the single-agent path (fleet_control_log), distinguished by a
  // nullable squad_id column (0098) rather than a table recreate: agent_id stays '' (satisfies
  // its pre-existing NOT NULL) and squad_id carries the target. Best-effort, same as above.
  try {
    await env.DB.prepare(
      `INSERT INTO fleet_control_log (id, tenant, agent_id, verb, nonce, requested_by_member, requested_by_agent, message_seq, squad_id)
            VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(crypto.randomUUID(), env.TENANT_SLUG, req.verb, req.nonce, principal.memberId, principal.boundAgentId, seq, req.squad_id)
      .run()
  } catch {
    /* audit log is best-effort */
  }

  if (!send.ok) return { ok: false, reason: 'send_failed', detail: send.reason }
  return { ok: true, nonce: req.nonce, squad_id: req.squad_id, verb: req.verb, seq }
}
