// mupot — MCP secret-env tools (agent/member propose + inspect env bindings).
//
// Custody discipline (see src/secret-env/service.ts): these tools NEVER accept or
// return a secret VALUE. `secret_env_request` only takes names + purposes + a
// reason and returns the created request id + names. `secret_env_status` only
// ever returns the state enum ('bound'|'unbound'|'pending'|'revoked'|'unknown')
// per name. Binding values are pasted by an admin via /approvals (bindSecretEnv),
// never through MCP.

import type { Env } from '../types'
import { requestSecretEnv, getSecretEnvStatus } from '../secret-env/service'
import type { SecretEnvKeySpec } from '../secret-env/types'
import { holdsCapabilityFloor, loadSquadScope } from '../auth/capability'
import type { AuthContext } from '../types'
import { type ToolSpec, fail, done, str } from './index'

const STRING_SCHEMA = { type: 'string' }
const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const MAX_KEYS_PER_REQUEST = 20

/**
 * Caller gate for BOTH secret-env tools. `min: 'authenticated'` admits ANY verified
 * Google account (directory signup is self-serve), and `bootstrap_self` +
 * `reveal_credential_claim` then hand that stranger an agent-bound bearer AND
 * squad:admin on a fresh `kind='home'` squad. Neither "agent-bound" nor "member on some
 * scope" is therefore standing a stranger cannot mint. The required standing is:
 *   - at least one grant that is NOT on a `kind='home'` squad — an org grant, a
 *     department grant, or a grant on a `kind='work'` squad (home squads are written only
 *     by bootstrap_self/createHomeForMember; nothing a stranger self-mints lands anywhere
 *     else), at rank
 *   - `observer` or better for an agent-bound seat (legitimate observer seats on real work
 *     squads keep working), `member` or better for an unbound principal.
 * An agent-bound token whose agent holds NO qualifying grant (stripped agent, home-only
 * agent) is refused. Squad kind is read fresh from D1 via loadSquadScope (never trusted
 * from the token). Legacy web principals (capabilities undefined) fall back to the org
 * role floor via holdsCapabilityFloor. Not a registry `min`: min is scope-agnostic and
 * cannot express "not a home squad".
 */
async function secretEnvCallerAllowed(auth: AuthContext, env: Env): Promise<boolean> {
  const floor = auth.boundAgentId != null ? 'observer' : 'member'
  if (auth.capabilities === undefined) return holdsCapabilityFloor(auth, 'member')
  for (const grant of auth.capabilities) {
    if (!holdsCapabilityFloor({ ...auth, capabilities: [grant] }, floor)) continue
    if (grant.scope_type !== 'squad') return true
    if (grant.scope_id == null) continue
    const scope = await loadSquadScope(env, grant.scope_id)
    if (scope !== null && scope.kind !== 'home') return true
  }
  return false
}

type ToolFailure = Extract<ReturnType<typeof fail>, { ok: false }>

/** Parses+validates the `keys` arg into typed SecretEnvKeySpec[]. Returns a fail
 * outcome (never throws) on any shape violation — the service layer re-validates
 * names/lengths/duplicates, this just guards against non-object/missing-field entries. */
function parseKeySpecs(raw: unknown): SecretEnvKeySpec[] | ToolFailure {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, 'invalid_args', 'keys must be a non-empty array') as ToolFailure
  }
  if (raw.length > MAX_KEYS_PER_REQUEST) {
    return fail(400, 'invalid_args', `keys must not exceed ${MAX_KEYS_PER_REQUEST} entries`) as ToolFailure
  }
  const keys: SecretEnvKeySpec[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return fail(400, 'invalid_args', 'each key entry must be an object') as ToolFailure
    }
    const name = str((entry as Record<string, unknown>).name)
    const purpose = str((entry as Record<string, unknown>).purpose)
    if (!name) return fail(400, 'invalid_args', 'each key entry requires a name') as ToolFailure
    if (!purpose) return fail(400, 'invalid_args', 'each key entry requires a purpose') as ToolFailure
    keys.push({ name, purpose })
  }
  return keys
}

const toolSecretEnvRequest: ToolSpec = {
  name: 'secret_env_request',
  scope: 'org (agent-bound seat or member-on-some-scope proposes an env schema — no values, ever)',
  min: 'authenticated',
  args: '{ keys: [{ name: string, purpose: string }], reason: string, adapter_hint?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      keys: { type: 'array', items: { type: 'object' } },
      reason: STRING_SCHEMA,
      adapter_hint: STRING_SCHEMA,
    },
    required: ['keys', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    // The actor is always resolved from auth, never trusted from args (same
    // pattern as every other tool — see index.ts comment on the tool surface).
    if (!(await secretEnvCallerAllowed(auth, env as Env))) return fail(403, 'forbidden', { need: 'non_home_standing' })
    const requestedBy = auth.memberId ?? auth.userId
    if (!requestedBy) return fail(403, 'unauthenticated')

    const reason = str(args.reason)
    if (!reason) return fail(400, 'invalid_args', 'reason required')

    const keysOrFail = parseKeySpecs(args.keys)
    if (!Array.isArray(keysOrFail)) return keysOrFail

    const adapterHint = str(args.adapter_hint)

    const result = await requestSecretEnv(env as Env, {
      keys: keysOrFail,
      reason,
      adapterHint,
      requestedBy,
      requestedChannel: auth.channel ?? null,
    })
    if (!result.ok) return fail(result.error === 'too_many_pending_requests' || result.error === 'rate_limited' ? 409 : 400, result.error)

    return done({
      request_id: result.request.id,
      keys: result.request.keys.map((key) => key.name),
    })
  },
}

const toolSecretEnvStatus: ToolSpec = {
  name: 'secret_env_status',
  scope: 'org (agent-bound seat or member-on-some-scope reads binding state — statuses only, never values)',
  min: 'authenticated',
  args: '{ names: string[] }',
  inputSchema: {
    type: 'object',
    properties: { names: STRING_ARRAY_SCHEMA },
    required: ['names'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!(await secretEnvCallerAllowed(auth, env as Env))) return fail(403, 'forbidden', { need: 'non_home_standing' })
    const requestedBy = auth.memberId ?? auth.userId
    if (!requestedBy) return fail(403, 'unauthenticated')

    const namesRaw = args.names
    if (!Array.isArray(namesRaw) || namesRaw.length === 0) {
      return fail(400, 'invalid_args', 'names must be a non-empty array')
    }
    if (namesRaw.length > MAX_KEYS_PER_REQUEST) {
      return fail(400, 'invalid_args', `names must not exceed ${MAX_KEYS_PER_REQUEST} entries`)
    }
    const names = namesRaw.filter((name): name is string => typeof name === 'string' && name.length > 0)
    if (names.length === 0) return fail(400, 'invalid_args', 'names must be a non-empty array of strings')

    const statuses = await getSecretEnvStatus(env as Env, names)
    return done({ statuses })
  },
}

export const SECRET_ENV_TOOLS: ToolSpec[] = [
  toolSecretEnvRequest,
  toolSecretEnvStatus,
]
