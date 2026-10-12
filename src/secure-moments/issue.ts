// mupot — the one place the request tools turn a pending request into a secure-moment link. Flag off or
// host misconfigured => null and NOTHING is written (the tools then return no link).
import type { Env } from '../types'
import { momentUrl, secureMomentsStatus } from './config'
import { createMoment, type MomentKind } from './store'

export interface IssuedLink {
  url: string
  momentId: string
  expiresAt: string
}

export async function issueMomentLink(
  env: Env,
  input: { kind: MomentKind; subjectId: string; requesterAgentId: string | null; subjectExpiresAtIso: string },
): Promise<IssuedLink | null> {
  if (secureMomentsStatus(env).state !== 'on') return null
  try {
    const m = await createMoment(env, input)
    if (!m) return null
    const url = momentUrl(env, m.id, m.token)
    return url ? { url, momentId: m.id, expiresAt: m.expiresAt } : null
  } catch {
    // The request itself is already filed; a link that could not be minted is simply absent (the agent can ask again).
    return null
  }
}
