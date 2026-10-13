// mupot#1889: the ONLY place HUMAN_ORIGIN_ATTESTOR_AGENT_IDS is read.
//
// `task_verdict.human_origin` is the HARNESS's attestation that a human typed a decision in a private
// chat. A workspace-channel agent token has the same shape whether a real harness runtime (the
// KayHermes gateway) or a prompt-injectable coding/chat session (Claude Code, Cursor, Custom GPT
// Actions) holds it, so the shape cannot tell them apart. The operator therefore names the agent
// ids that ARE attesting harness runtimes. Empty or absent = no agent may attest (fail closed).
// A deployment-level allowlist, not a database column, so no migration and no in-band way for any
// agent or member to extend it.

import type { Env } from '../types'

export function humanOriginAttestorAgentIds(env: Pick<Env, 'HUMAN_ORIGIN_ATTESTOR_AGENT_IDS'>): ReadonlySet<string> {
  const raw = env.HUMAN_ORIGIN_ATTESTOR_AGENT_IDS
  if (typeof raw !== 'string') return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
}

export function isHumanOriginAttestorAgent(env: Pick<Env, 'HUMAN_ORIGIN_ATTESTOR_AGENT_IDS'>, agentId: string | null | undefined): boolean {
  return typeof agentId === 'string' && agentId.length > 0 && humanOriginAttestorAgentIds(env).has(agentId)
}
