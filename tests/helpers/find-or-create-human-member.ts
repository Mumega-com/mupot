// Test-only wrapper: findOrCreateHumanMemberDetailed with an explicit "no limit" guard. It lives under tests/ on purpose so
// production code cannot get unmetered member creation from this module by accident (door PR C, mupot task 920df5e9).
import type { Env } from '../../src/types'
import { findOrCreateHumanMemberDetailed, type BeforeCreateGuard } from '../../src/members/human-identity'

export const ALLOW_NEW_MEMBER: BeforeCreateGuard = async () => ({ allowed: true, retryAfter: 0 })

export async function findOrCreateHumanMember(
  env: Env,
  email: string,
  displayName: string,
  loginIdentity?: { provider: string; subject: string },
): Promise<string> {
  return (await findOrCreateHumanMemberDetailed(env, email, displayName, ALLOW_NEW_MEMBER, loginIdentity)).id
}
