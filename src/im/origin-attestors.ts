// mupot#1889: the ONLY place HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS is read.
//
// `task_verdict.human_origin` is the HARNESS's attestation that a human typed a decision in a private
// chat. A workspace-channel agent token has the same shape whether a real harness runtime (the
// KayHermes gateway) or a prompt-injectable coding/chat session (Claude Code, Cursor, Custom GPT
// Actions) holds it, and one agent may hold several live tokens (mintAgentBoundToken allows later
// mints). So neither the shape nor the agent can decide: the operator names the exact member_tokens
// ids that ARE installed in an attesting harness runtime. auth.tokenId is re-read from the live token
// row on every request (never accepted from the client). Empty or absent = nothing may attest.
// A deployment-level allowlist, not a database column, so no migration and no in-band way for any
// agent or member to extend it.

import type { Env } from '../types'

export function humanOriginAttestorTokenIds(env: Pick<Env, 'HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS'>): ReadonlySet<string> {
  const raw = env.HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS
  if (typeof raw !== 'string') return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
}

export function isHumanOriginAttestorToken(env: Pick<Env, 'HUMAN_ORIGIN_ATTESTOR_TOKEN_IDS'>, tokenId: string | null | undefined): boolean {
  return typeof tokenId === 'string' && tokenId.length > 0 && humanOriginAttestorTokenIds(env).has(tokenId)
}
