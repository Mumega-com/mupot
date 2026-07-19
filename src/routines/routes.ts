import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { csrf } from 'hono/csrf'
import { requireAuth } from '../auth'
import { resolveCapabilities } from '../auth/capability'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import type { AuthContext, Env } from '../types'
import { cancelRoutineRun, submitRoutineProposal } from './actions'
import { routinePrincipal } from './access'
import { publicRoutineRun, type PublicRoutineRun } from './public'
import {
  archiveRoutine,
  createManualRoutineRun,
  createRoutine,
  enableRoutine,
  getRoutine,
  getRoutineRun,
  listRoutineRuns,
  listRoutines,
  pauseRoutine,
  updateRoutine,
  type CreateRoutineInput,
  type RoutineCursor,
  type RoutineRunCreationResult,
  type UpdateRoutineInput,
} from './service'
import type { Routine } from './types'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
type JsonObject = Record<string, unknown>

const MAX_BODY_BYTES = 8192
const MAX_ID_LENGTH = 200
const sessionCsrf = csrf()
function sameOrigin(c: Context<AppEnv>): boolean {
  const origin = c.req.header('origin')
  return origin === new URL(c.req.url).origin
}

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
}

/** Accept the established browser session or a member bearer without trusting request identity. */
export const routineAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.req.header('authorization')) return requireAuth(c, next)
  try {
    const identity = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
    if (!identity) return c.json({ error: 'unauthenticated' }, 401)
    const capabilities = await resolveCapabilities(c.env, identity.memberId)
    c.set('auth', {
      userId: identity.memberId,
      memberId: identity.memberId,
      email: identity.email,
      role: 'member',
      tenant: c.env.TENANT_SLUG,
      channel: 'workspace',
      boundAgentId: identity.boundAgentId,
      capabilities,
    })
  } catch {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  await next()
}

/** Auth is selected once per exact REST endpoint; Authorization always wins. */
export const routineEndpoint: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header('Cache-Control', 'no-store')
  return routineAuth(c, next)
}

/** Runs only after routineEndpoint selected session auth; bearer callers are exempt. */
export const routineSessionCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('authorization')) return next()
  if (['POST', 'PATCH'].includes(c.req.method) && !sameOrigin(c)) {
    return c.json({ error: 'forbidden', reason: 'csrf' }, 403)
  }
  return sessionCsrf(c, next)
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value)
}

function exactInstant(value: unknown): value is string {
  return typeof value === 'string' && new Date(value).toISOString() === value
}

function cursorEncode(value: RoutineCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: value.timestamp, i: value.id }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function cursorDecode(value: string | undefined): RoutineCursor | null | undefined {
  if (value === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0)))) as JsonObject
    if (decoded.v !== 1 || !exactInstant(decoded.t) || typeof decoded.i !== 'string' || !validId(decoded.i)) return null
    return { timestamp: decoded.t, id: decoded.i }
  } catch {
    return null
  }
}

function page(c: Context<AppEnv>): { limit?: number; after?: RoutineCursor } | null {
  const rawLimit = c.req.query('limit')
  if (rawLimit !== undefined && !/^[1-9]\d{0,2}$/.test(rawLimit)) return null
  const limit = rawLimit === undefined ? undefined : Number(rawLimit)
  if (limit !== undefined && (limit < 1 || limit > 100)) return null
  const after = cursorDecode(c.req.query('cursor'))
  return after === null ? null : { ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) }
}

async function readObject(c: Context<AppEnv>): Promise<{ ok: true; body: JsonObject } | { ok: false; error: 'payload_too_large' | 'invalid_body' }> {
  const declared = c.req.header('content-length')
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return { ok: false, error: 'payload_too_large' }
  }
  let bytes: ArrayBuffer
  try {
    bytes = await c.req.raw.arrayBuffer()
  } catch {
    return { ok: false, error: 'invalid_body' }
  }
  if (bytes.byteLength > MAX_BODY_BYTES) return { ok: false, error: 'payload_too_large' }
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return { ok: false, error: 'invalid_body' }
  }
  if (!raw) return { ok: true, body: {} }
  try {
    const value = JSON.parse(raw)
    if (value === null || Array.isArray(value) || typeof value !== 'object') return { ok: false, error: 'invalid_body' }
    return { ok: true, body: value as JsonObject }
  } catch {
    return { ok: false, error: 'invalid_body' }
  }
}

function only(body: JsonObject, fields: readonly string[]): boolean {
  return Object.keys(body).every(key => fields.includes(key))
}

const POLICY_FIELDS = [
  'name', 'objective', 'trigger_kind', 'run_once_at', 'cron_expression', 'timezone', 'overlap_policy',
  'execution_mode', 'responsible_squad_id', 'preferred_agent_id', 'budget_micro_usd', 'max_attempts',
  'retry_backoff_seconds', 'max_occurrences', 'stop_at',
] as const

function policyShape(body: JsonObject, create: boolean): 'unknown_field' | 'invalid_body' | null {
  if (!only(body, POLICY_FIELDS)) return 'unknown_field'
  if (create && ['name', 'objective', 'trigger_kind', 'responsible_squad_id', 'budget_micro_usd'].some(field => body[field] === undefined)) return 'invalid_body'
  const strings: Array<[string, number]> = [
    ['name', 120], ['objective', 4000], ['timezone', 100], ['responsible_squad_id', MAX_ID_LENGTH], ['preferred_agent_id', MAX_ID_LENGTH],
    ['run_once_at', 100], ['cron_expression', 200], ['overlap_policy', 20], ['execution_mode', 20], ['stop_at', 100],
  ]
  for (const [field, max] of strings) {
    const value = body[field]
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) return 'invalid_body'
  }
  for (const field of ['budget_micro_usd', 'max_attempts', 'retry_backoff_seconds', 'max_occurrences']) {
    const value = body[field]
    if (value !== undefined && !(field === 'max_occurrences' && value === null)
      && (!Number.isSafeInteger(value) || Number(value) < 0)) return 'invalid_body'
  }
  if (body.max_attempts !== undefined && (Number(body.max_attempts) < 1 || Number(body.max_attempts) > 5)) return 'invalid_body'
  if (body.retry_backoff_seconds !== undefined && (Number(body.retry_backoff_seconds) < 30 || Number(body.retry_backoff_seconds) > 86400)) return 'invalid_body'
  if (body.max_occurrences !== undefined && body.max_occurrences !== null && Number(body.max_occurrences) < 1) return 'invalid_body'
  return null
}

function idempotencyKey(c: Context<AppEnv>): string | null {
  const value = c.req.header('idempotency-key')
  return value && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null
}

function safeRoutine(routine: Routine): Omit<Routine, 'tenant'> {
  const { tenant: _tenant, ...safe } = routine
  return safe
}

const safeRun = (run: Parameters<typeof publicRoutineRun>[0]): PublicRoutineRun => publicRoutineRun(run)

function errorStatus(error: string): 400 | 403 | 404 | 409 | 413 {
  if (error === 'payload_too_large') return 413
  if (['project_not_found', 'routine_not_found', 'run_not_found'].includes(error)) return 404
  if (error === 'forbidden') return 403
  if (['receipt_failed', 'invalid_state', 'routine_archived', 'routine_not_enabled', 'schedule_exhausted', 'run_terminal',
    'run_not_accepting_proposal', 'action_key_conflict', 'proposal_already_submitted', 'stale_situation'].includes(error)) return 409
  return 400
}

function failure(c: Context<AppEnv>, error: string): Response {
  return c.json({ error }, errorStatus(error))
}

async function readableRoutine(c: Context<AppEnv>, projectId: string, routineId: string): Promise<Routine | null> {
  const routine = await getRoutine(c.env, routinePrincipal(c.get('auth')), routineId)
  return routine?.project_id === projectId ? routine : null
}

export const routinesApp = new Hono<AppEnv>()

routinesApp.get('/projects/:projectId/routines', routineEndpoint, routineSessionCsrf, async (c) => {
  const projectId = c.req.param('projectId')
  const pagination = page(c)
  if (!validId(projectId)) return failure(c, 'project_not_found')
  if (!pagination) return failure(c, 'invalid_pagination')
  const status = c.req.query('status')
  if (status !== undefined && !['draft', 'enabled', 'paused', 'archived'].includes(status)) return failure(c, 'invalid_pagination')
  const result = await listRoutines(c.env, routinePrincipal(c.get('auth')), { project_id: projectId, ...pagination, ...(status ? { status: status as Routine['status'] } : {}) })
  if (!result.ok) return failure(c, result.error)
  return c.json({ routines: result.items.map(safeRoutine), next_cursor: result.next_cursor ? cursorEncode(result.next_cursor) : null })
})

routinesApp.post('/projects/:projectId/routines', routineEndpoint, routineSessionCsrf, async (c) => {
  const projectId = c.req.param('projectId')
  if (!validId(projectId)) return failure(c, 'project_not_found')
  const parsed = await readObject(c)
  if (!parsed.ok) return failure(c, parsed.error)
  const shape = policyShape(parsed.body, true)
  if (shape) return failure(c, shape)
  const result = await createRoutine(c.env, routinePrincipal(c.get('auth')), { ...parsed.body, project_id: projectId } as CreateRoutineInput)
  if (!result.ok) return failure(c, result.error)
  return c.json({ routine: safeRoutine(result.value) }, 201)
})

routinesApp.get('/projects/:projectId/routines/:routineId', routineEndpoint, routineSessionCsrf, async (c) => {
  const { projectId, routineId } = c.req.param()
  if (!validId(projectId) || !validId(routineId)) return failure(c, 'routine_not_found')
  const routine = await readableRoutine(c, projectId, routineId)
  return routine ? c.json({ routine: safeRoutine(routine) }) : failure(c, 'routine_not_found')
})

routinesApp.patch('/projects/:projectId/routines/:routineId', routineEndpoint, routineSessionCsrf, async (c) => {
  const { projectId, routineId } = c.req.param()
  if (!validId(projectId) || !validId(routineId)) return failure(c, 'routine_not_found')
  if (!await readableRoutine(c, projectId, routineId)) return failure(c, 'routine_not_found')
  const parsed = await readObject(c)
  if (!parsed.ok) return failure(c, parsed.error)
  const shape = policyShape(parsed.body, false)
  if (shape) return failure(c, shape)
  const result = await updateRoutine(c.env, routinePrincipal(c.get('auth')), routineId, parsed.body as UpdateRoutineInput)
  return result.ok ? c.json({ routine: safeRoutine(result.value) }) : failure(c, result.error)
})

for (const [action, operation] of [
  ['enable', enableRoutine], ['pause', pauseRoutine], ['archive', archiveRoutine],
] as const) {
  routinesApp.post(`/projects/:projectId/routines/:routineId/${action}`, routineEndpoint, routineSessionCsrf, async (c) => {
    const { projectId, routineId } = c.req.param()
    if (!validId(projectId) || !validId(routineId) || !await readableRoutine(c, projectId, routineId)) return failure(c, 'routine_not_found')
    const parsed = await readObject(c)
    if (!parsed.ok) return failure(c, parsed.error)
    if (Object.keys(parsed.body).length) return failure(c, 'unknown_field')
    const result = await operation(c.env, routinePrincipal(c.get('auth')), routineId)
    return result.ok ? c.json({ routine: safeRoutine(result.value) }) : failure(c, result.error)
  })
}

routinesApp.post('/projects/:projectId/routines/:routineId/run', routineEndpoint, routineSessionCsrf, async (c) => {
  const { projectId, routineId } = c.req.param()
  if (!validId(projectId) || !validId(routineId) || !await readableRoutine(c, projectId, routineId)) return failure(c, 'routine_not_found')
  const parsed = await readObject(c)
  if (!parsed.ok) return failure(c, parsed.error)
  if (Object.keys(parsed.body).length) return failure(c, 'unknown_field')
  const key = idempotencyKey(c)
  if (!key) return failure(c, 'invalid_idempotency_key')
  const result: RoutineRunCreationResult = await createManualRoutineRun(c.env, routinePrincipal(c.get('auth')), routineId, key)
  if (!result.ok) return failure(c, result.error)
  return c.json({ run: safeRun(result.value), duplicate: result.duplicate }, result.duplicate ? 200 : 201)
})

routinesApp.get('/projects/:projectId/routine-runs', routineEndpoint, routineSessionCsrf, async (c) => {
  const projectId = c.req.param('projectId')
  const pagination = page(c)
  const routineId = c.req.query('routine_id')
  if (!validId(projectId)) return failure(c, 'project_not_found')
  if (!pagination || (routineId !== undefined && !validId(routineId))) return failure(c, 'invalid_pagination')
  const result = await listRoutineRuns(c.env, routinePrincipal(c.get('auth')), { project_id: projectId, ...pagination, ...(routineId ? { routine_id: routineId } : {}) })
  if (!result.ok) return failure(c, result.error)
  return c.json({ runs: result.items.map(safeRun), next_cursor: result.next_cursor ? cursorEncode(result.next_cursor) : null })
})

routinesApp.get('/routine-runs/:runId', routineEndpoint, routineSessionCsrf, async (c) => {
  const runId = c.req.param('runId')
  if (!validId(runId)) return failure(c, 'run_not_found')
  const run = await getRoutineRun(c.env, routinePrincipal(c.get('auth')), runId)
  return run ? c.json({ run: safeRun(run) }) : failure(c, 'run_not_found')
})

routinesApp.post('/routine-runs/:runId/cancel', routineEndpoint, routineSessionCsrf, async (c) => {
  const runId = c.req.param('runId')
  if (!validId(runId)) return failure(c, 'run_not_found')
  const parsed = await readObject(c)
  if (!parsed.ok) return failure(c, parsed.error)
  if (Object.keys(parsed.body).length) return failure(c, 'unknown_field')
  const result = await cancelRoutineRun(c.env, routinePrincipal(c.get('auth')), runId)
  return result.ok ? c.json(result) : failure(c, result.error)
})

routinesApp.post('/routine-runs/:runId/proposal', routineEndpoint, routineSessionCsrf, async (c) => {
  const runId = c.req.param('runId')
  if (!validId(runId)) return failure(c, 'run_not_found')
  const parsed = await readObject(c)
  if (!parsed.ok) return failure(c, parsed.error)
  if ('agent_id' in parsed.body) return failure(c, 'unknown_field')
  const key = idempotencyKey(c)
  if (!key) return failure(c, 'invalid_idempotency_key')
  if (parsed.body.run_id !== runId) return failure(c, 'run_mismatch')
  const action = parsed.body.action
  if (action !== null && typeof action === 'object' && !Array.isArray(action)
    && typeof (action as JsonObject).key === 'string' && (action as JsonObject).key !== key) {
    return failure(c, 'idempotency_key_mismatch')
  }
  const result = await submitRoutineProposal(c.env, routinePrincipal(c.get('auth')), parsed.body)
  return result.ok ? c.json(result) : failure(c, result.error)
})
