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
import { type ToolSpec, fail, done, str } from './index'

const STRING_SCHEMA = { type: 'string' }
const STRING_ARRAY_SCHEMA = { type: 'array', items: { type: 'string' } }
const MAX_KEYS_PER_REQUEST = 20

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
  scope: 'org (any authenticated principal proposes an env schema — no values, ever)',
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
    })
    if (!result.ok) return fail(400, result.error)

    return done({
      request_id: result.request.id,
      keys: result.request.keys.map((key) => key.name),
    })
  },
}

const toolSecretEnvStatus: ToolSpec = {
  name: 'secret_env_status',
  scope: 'org (any authenticated principal reads binding state — statuses only, never values)',
  min: 'authenticated',
  args: '{ names: string[] }',
  inputSchema: {
    type: 'object',
    properties: { names: STRING_ARRAY_SCHEMA },
    required: ['names'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
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
