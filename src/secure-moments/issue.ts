// mupot — the one place the request tools turn a pending request into a secure-moment link. Flag off or
// host misconfigured => null and NOTHING is written (the tools then return no link).
import type { Env } from '../types'
import { momentUrl, secureMomentsStatus } from './config'
import { createMoment, rotatePendingMomentToken, type MomentKind } from './store'

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

/** Re-issue the link of an EXISTING pending moment (guarded rotation by id; never creates a moment). */
export async function reissueMomentLink(env: Env, momentId: string): Promise<IssuedLink | null> {
  if (secureMomentsStatus(env).state !== 'on') return null
  try {
    const m = await rotatePendingMomentToken(env, momentId)
    if (!m) return null
    const url = momentUrl(env, m.id, m.token)
    return url ? { url, momentId: m.id, expiresAt: m.expiresAt } : null
  } catch {
    return null
  }
}
