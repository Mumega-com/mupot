// Fleet Control — emit a signed control-request (Deliverable 2, mupot side).
//
// Turns a {agent_id, verb} into a SIGNED control-request and drops it in the host consumer's inbox
// (0032), then records the audit row (0034). The host daemon reads the inbox, VERIFIES the
// signature (Ed25519 + freshness + nonce) and only then runs the verb. The signature is the
// authorization the host trusts — independent of the inbox transport (defense in depth: even a
// compromised inbox can't forge a control-request without FLEET_PANEL_SK).

import type { Env } from '../types'
import { signControlRequest, ControlRequestError } from './control-request'
import { sendAgentMessage } from '../agents/messages'

export interface ControlPrincipal {
  memberId: string
  boundAgentId: string | null
}

export type EmitResult =
  | { ok: true; nonce: string; agent_id: string; verb: string; seq: number | null }
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
