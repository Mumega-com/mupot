import type { Env } from '../types'

/** The one definition of "are workspaces on". Strict '1': unset or anything else is off, so a typo'd
 *  or empty var can never enable an auth-adjacent write path. */
export function workspacesEnabled(env: Pick<Env, 'WORKSPACES'>): boolean {
  return env.WORKSPACES === '1'
}
