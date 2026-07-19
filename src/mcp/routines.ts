import { listNeedsYou } from '../attention/service'
import { cancelRoutineRun, submitRoutineProposal } from '../routines/actions'
import { principalCanReadProject, routinePrincipal } from '../routines/access'
import { publicRoutineRun } from '../routines/public'
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
  type UpdateRoutineInput,
} from '../routines/service'
import type { Routine } from '../routines/types'
import { done, fail, type ToolOutcome, type ToolSpec } from './index'

const ID = '^[A-Za-z0-9_-]{1,200}$'
const IDEMPOTENCY_KEY = '^[A-Za-z0-9_.:-]{1,200}$'
const CURSOR = '^[A-Za-z0-9_-]{1,2048}$'
const NEEDS_YOU_CURSOR = '^[A-Za-z0-9_-]{1,200}$'
const POLICY_FIELDS = [
  'name', 'objective', 'trigger_kind', 'run_once_at', 'cron_expression', 'timezone', 'overlap_policy',
  'execution_mode', 'responsible_squad_id', 'preferred_agent_id', 'budget_micro_usd', 'max_attempts',
  'retry_backoff_seconds', 'max_occurrences', 'stop_at',
] as const

const string = (maxLength = 4000, minLength = 1) => ({ type: 'string', minLength, maxLength })
const id = () => ({ type: 'string', pattern: ID, maxLength: 200 })
const nullableId = () => ({ type: ['string', 'null'], pattern: ID, maxLength: 200 })

function validId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(ID).test(value)
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && new Date(value).toISOString() === value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function boundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string'
    && value.trim().length >= min
    && new TextEncoder().encode(value).byteLength <= max
}

function routineCursor(value: unknown): RoutineCursor | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !new RegExp(CURSOR).test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), char => char.charCodeAt(0)))) as Record<string, unknown>
    if (decoded.v !== 1 || !validInstant(decoded.t) || !validId(decoded.i)) return null
    return { timestamp: decoded.t, id: decoded.i }
  } catch {
    return null
  }
}

function encodeCursor(value: RoutineCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, t: value.timestamp, i: value.id }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function page(args: Record<string, unknown>): { limit?: number; after?: RoutineCursor } | null {
  const limit = args.limit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100)) return null
  const after = routineCursor(args.cursor)
  if (after === null) return null
  return {
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(after === undefined ? {} : { after }),
  }
}

function policy(args: Record<string, unknown>, create: boolean): CreateRoutineInput | UpdateRoutineInput | null {
  if (!exactKeys(args, POLICY_FIELDS)) return null
  if (create && ['name', 'objective', 'trigger_kind', 'responsible_squad_id', 'budget_micro_usd'].some(field => args[field] === undefined)) return null
  const strings: Array<[keyof CreateRoutineInput, number]> = [
    ['name', 120], ['objective', 4000], ['timezone', 100], ['responsible_squad_id', 200], ['preferred_agent_id', 200],
    ['run_once_at', 100], ['cron_expression', 200], ['overlap_policy', 20], ['execution_mode', 20], ['stop_at', 100],
  ]
  for (const [field, max] of strings) {
    const value = args[field]
    if (value !== undefined && value !== null && !boundedString(value, max)) return null
  }
  for (const field of ['budget_micro_usd', 'max_attempts', 'retry_backoff_seconds', 'max_occurrences']) {
    const value = args[field]
    if (value !== undefined && !(field === 'max_occurrences' && value === null)
      && (!Number.isSafeInteger(value) || Number(value) < 0)) return null
  }
  if (args.max_attempts !== undefined && (Number(args.max_attempts) < 1 || Number(args.max_attempts) > 5)) return null
  if (args.retry_backoff_seconds !== undefined && (Number(args.retry_backoff_seconds) < 30 || Number(args.retry_backoff_seconds) > 86400)) return null
  if (args.max_occurrences !== undefined && args.max_occurrences !== null && Number(args.max_occurrences) < 1) return null
  return args
}

function safeRoutine(routine: Routine): Omit<Routine, 'tenant'> {
  const { tenant: _tenant, ...safe } = routine
  return safe
}

function errorStatus(error: string): 400 | 403 | 404 | 409 | 500 {
  if (['project_not_found', 'routine_not_found', 'run_not_found'].includes(error)) return 404
  if (error === 'forbidden') return 403
  if (['receipt_failed', 'invalid_state', 'routine_archived', 'routine_not_enabled', 'schedule_exhausted', 'run_terminal',
    'run_not_accepting_proposal', 'action_key_conflict', 'proposal_already_submitted', 'stale_situation'].includes(error)) return 409
  return 400
}

function sourceFailure(error: string): ToolOutcome {
  return fail(errorStatus(error), error)
}

const policyProperties = {
  name: string(120),
  objective: string(4000),
  trigger_kind: { type: 'string', enum: ['manual', 'once', 'cron'] },
  run_once_at: { type: ['string', 'null'], maxLength: 100 },
  cron_expression: { type: ['string', 'null'], maxLength: 200 },
  timezone: string(100),
  overlap_policy: { type: 'string', enum: ['skip', 'queue'] },
  execution_mode: { type: 'string', enum: ['propose', 'execute_internal'] },
  responsible_squad_id: id(),
  preferred_agent_id: nullableId(),
  budget_micro_usd: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  max_attempts: { type: 'integer', minimum: 1, maximum: 5 },
  retry_backoff_seconds: { type: 'integer', minimum: 30, maximum: 86400 },
  max_occurrences: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  stop_at: { type: ['string', 'null'], maxLength: 100 },
}

const proposalReference = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['task', 'flight', 'artifact'] },
    id: string(200),
  },
  required: ['type', 'id'],
  additionalProperties: false,
}

const proposalActionSchemas = [
  {
    type: 'object',
    properties: {
      key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
      kind: { const: 'create_task' },
      input: { type: 'object', properties: { title: string(240), description: string(4000), assignee_agent_id: string(200) }, required: ['title', 'description'], additionalProperties: false },
    },
    required: ['key', 'kind', 'input'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
      kind: { const: 'dispatch_flight' },
      input: { type: 'object', properties: { goal: string(4000), task_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: string(200) }, artifact_refs: { type: 'array', maxItems: 200, uniqueItems: true, items: string(2000) }, budget_micro_usd: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ['goal', 'task_ids', 'artifact_refs', 'budget_micro_usd'], additionalProperties: false },
    },
    required: ['key', 'kind', 'input'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
      kind: { const: 'request_review' },
      input: { type: 'object', properties: { source_type: { type: 'string', enum: ['task', 'flight', 'artifact'] }, source_id: string(200), summary: string(4000) }, required: ['source_type', 'source_id', 'summary'], additionalProperties: false },
    },
    required: ['key', 'kind', 'input'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
      kind: { const: 'ask_human' },
      input: { type: 'object', properties: { question: string(2000), choices: { type: 'array', minItems: 2, maxItems: 5, uniqueItems: true, items: string(500) }, references: { type: 'array', maxItems: 20, uniqueItems: true, items: proposalReference } }, required: ['question', 'references'], additionalProperties: false },
    },
    required: ['key', 'kind', 'input'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
      kind: { const: 'no_action' },
      input: { type: 'object', properties: { reason: string(4000), next_check_at: { type: 'string', format: 'date-time', maxLength: 100 } }, required: ['reason'], additionalProperties: false },
    },
    required: ['key', 'kind', 'input'],
    additionalProperties: false,
  },
]

const routineList: ToolSpec = {
  name: 'routine_list', scope: 'visible project routines', min: 'observer',
  args: '{ project_id: string, status?: "draft"|"enabled"|"paused"|"archived", limit?: 1..100, cursor?: string }',
  inputSchema: { type: 'object', properties: { project_id: id(), status: { type: 'string', enum: ['draft', 'enabled', 'paused', 'archived'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', pattern: CURSOR, maxLength: 2048 } }, required: ['project_id'], additionalProperties: false },
  async run(auth, env, args) {
    const pagination = page(args)
    if (!validId(args.project_id)) return fail(404, 'project_not_found')
    if (!pagination || (args.status !== undefined && !['draft', 'enabled', 'paused', 'archived'].includes(String(args.status)))) return fail(400, 'invalid_pagination')
    const result = await listRoutines(env, routinePrincipal(auth), { project_id: args.project_id, ...pagination, ...(args.status ? { status: args.status as Routine['status'] } : {}) })
    return result.ok ? done({ routines: result.items.map(safeRoutine), next_cursor: result.next_cursor ? encodeCursor(result.next_cursor) : null }) : sourceFailure(result.error)
  },
}

const routineGet: ToolSpec = {
  name: 'routine_get', scope: 'visible project routine', min: 'observer', args: '{ routine_id: string }',
  inputSchema: { type: 'object', properties: { routine_id: id() }, required: ['routine_id'], additionalProperties: false },
  async run(auth, env, args) {
    if (!validId(args.routine_id)) return fail(404, 'routine_not_found')
    const routine = await getRoutine(env, routinePrincipal(auth), args.routine_id)
    return routine ? done({ routine: safeRoutine(routine) }) : fail(404, 'routine_not_found')
  },
}

const routineCreate: ToolSpec = {
  name: 'routine_create', scope: 'workspace routine policy lifecycle', min: 'admin',
  args: '{ project_id: string, name: string, objective: string, trigger_kind: "manual"|"once"|"cron", responsible_squad_id: string, budget_micro_usd: number, ...policy }',
  inputSchema: { type: 'object', properties: { project_id: id(), ...policyProperties }, required: ['project_id', 'name', 'objective', 'trigger_kind', 'responsible_squad_id', 'budget_micro_usd'], additionalProperties: false },
  async run(auth, env, args) {
    const { project_id: projectId, ...rawPolicy } = args
    const input = policy(rawPolicy, true)
    if (!validId(projectId)) return fail(404, 'project_not_found')
    if (routinePrincipal(auth).actor_type !== 'member') return fail(403, 'forbidden')
    if (!input) return fail(400, 'invalid_args')
    const result = await createRoutine(env, routinePrincipal(auth), { ...input, project_id: projectId })
    return result.ok ? done({ routine: safeRoutine(result.value) }) : sourceFailure(result.error)
  },
}

const routineUpdate: ToolSpec = {
  name: 'routine_update', scope: 'workspace routine policy lifecycle', min: 'admin',
  args: '{ routine_id: string, ...policy fields }',
  inputSchema: { type: 'object', properties: { routine_id: id(), ...policyProperties }, required: ['routine_id'], additionalProperties: false },
  async run(auth, env, args) {
    const { routine_id: routineId, ...rawPolicy } = args
    const input = policy(rawPolicy, false)
    if (!validId(routineId)) return fail(404, 'routine_not_found')
    if (routinePrincipal(auth).actor_type !== 'member') return fail(403, 'forbidden')
    if (!input) return fail(400, 'invalid_args')
    const result = await updateRoutine(env, routinePrincipal(auth), routineId, input)
    return result.ok ? done({ routine: safeRoutine(result.value) }) : sourceFailure(result.error)
  },
}

function lifecycle(name: 'routine_enable' | 'routine_pause' | 'routine_archive', operation: typeof enableRoutine): ToolSpec {
  return {
    name, scope: 'workspace routine policy lifecycle', min: 'admin', args: '{ routine_id: string }',
    inputSchema: { type: 'object', properties: { routine_id: id() }, required: ['routine_id'], additionalProperties: false },
    async run(auth, env, args) {
      if (!validId(args.routine_id)) return fail(404, 'routine_not_found')
      if (routinePrincipal(auth).actor_type !== 'member') return fail(403, 'forbidden')
      const result = await operation(env, routinePrincipal(auth), args.routine_id)
      return result.ok ? done({ routine: safeRoutine(result.value) }) : sourceFailure(result.error)
    },
  }
}

const routineRunNow: ToolSpec = {
  name: 'routine_run_now', scope: 'responsible writable squad manual routine execution', min: 'member',
  args: '{ routine_id: string, idempotency_key: string }',
  inputSchema: { type: 'object', properties: { routine_id: id(), idempotency_key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 } }, required: ['routine_id', 'idempotency_key'], additionalProperties: false },
  async run(auth, env, args) {
    if (!validId(args.routine_id)) return fail(404, 'routine_not_found')
    if (typeof args.idempotency_key !== 'string' || !new RegExp(IDEMPOTENCY_KEY).test(args.idempotency_key)) return fail(400, 'invalid_idempotency_key')
    const result = await createManualRoutineRun(env, routinePrincipal(auth), args.routine_id, args.idempotency_key)
    return result.ok ? done({ run: publicRoutineRun(result.value), duplicate: result.duplicate }) : sourceFailure(result.error)
  },
}

const routineRunList: ToolSpec = {
  name: 'routine_run_list', scope: 'visible project routine runs', min: 'observer',
  args: '{ project_id: string, routine_id?: string, limit?: 1..100, cursor?: string }',
  inputSchema: { type: 'object', properties: { project_id: id(), routine_id: id(), limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', pattern: CURSOR, maxLength: 2048 } }, required: ['project_id'], additionalProperties: false },
  async run(auth, env, args) {
    const pagination = page(args)
    if (!validId(args.project_id)) return fail(404, 'project_not_found')
    if (!pagination || (args.routine_id !== undefined && !validId(args.routine_id))) return fail(400, 'invalid_pagination')
    const result = await listRoutineRuns(env, routinePrincipal(auth), { project_id: args.project_id, ...pagination, ...(args.routine_id ? { routine_id: args.routine_id } : {}) })
    return result.ok ? done({ runs: result.items.map(publicRoutineRun), next_cursor: result.next_cursor ? encodeCursor(result.next_cursor) : null }) : sourceFailure(result.error)
  },
}

const routineRunGet: ToolSpec = {
  name: 'routine_run_get', scope: 'visible routine run', min: 'observer', args: '{ run_id: string }',
  inputSchema: { type: 'object', properties: { run_id: id() }, required: ['run_id'], additionalProperties: false },
  async run(auth, env, args) {
    if (!validId(args.run_id)) return fail(404, 'run_not_found')
    const run = await getRoutineRun(env, routinePrincipal(auth), args.run_id)
    return run ? done({ run: publicRoutineRun(run) }) : fail(404, 'run_not_found')
  },
}

const routineRunCancel: ToolSpec = {
  name: 'routine_run_cancel', scope: 'workspace routine run cancellation', min: 'admin', args: '{ run_id: string }',
  inputSchema: { type: 'object', properties: { run_id: id() }, required: ['run_id'], additionalProperties: false },
  async run(auth, env, args) {
    if (!validId(args.run_id)) return fail(404, 'run_not_found')
    const result = await cancelRoutineRun(env, routinePrincipal(auth), args.run_id)
    return result.ok ? done(result) : sourceFailure(result.error)
  },
}

const routineProposalSubmit: ToolSpec = {
  name: 'routine_proposal_submit', scope: 'assigned agent routine proposal submission', min: 'member',
  args: '{ version: "routine.proposal/v1", run_id: string, project_id: string, situation_digest: string, summary: string, action: object }',
  inputSchema: {
    type: 'object',
    properties: {
      version: { type: 'string', enum: ['routine.proposal/v1'] }, run_id: id(), project_id: id(),
      situation_digest: { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 }, summary: string(4000),
      action: {
        type: 'object',
        properties: {
          key: { type: 'string', pattern: IDEMPOTENCY_KEY, maxLength: 200 },
          kind: { type: 'string', enum: ['create_task', 'dispatch_flight', 'request_review', 'ask_human', 'no_action'] },
          input: { type: 'object' },
        },
        required: ['key', 'kind', 'input'],
        additionalProperties: false,
        oneOf: proposalActionSchemas,
      },
    },
    required: ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'], additionalProperties: false,
  },
  async run(auth, env, args) {
    const result = await submitRoutineProposal(env, routinePrincipal(auth), args)
    return result.ok ? done(result) : sourceFailure(result.error)
  },
}

const needsYouList: ToolSpec = {
  name: 'needs_you_list', scope: 'visible project and workspace attention items', min: 'observer',
  args: '{ project_id?: string, limit?: 1..100, cursor?: string }',
  inputSchema: { type: 'object', properties: { project_id: id(), limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: { type: 'string', pattern: NEEDS_YOU_CURSOR, maxLength: 200 } }, additionalProperties: false },
  async run(auth, env, args) {
    if (args.project_id !== undefined && !validId(args.project_id)) return fail(404, 'project_not_found')
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) return fail(400, 'invalid_pagination')
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !new RegExp(NEEDS_YOU_CURSOR).test(args.cursor))) return fail(400, 'invalid_pagination')
    const principal = routinePrincipal(auth)
    if (args.project_id && !await principalCanReadProject(env, principal, args.project_id)) return fail(404, 'project_not_found')
    try {
      return done(await listNeedsYou(env, principal, {
        ...(args.project_id ? { project_id: args.project_id } : {}),
        ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
        ...(args.cursor === undefined ? {} : { after: args.cursor }),
      }))
    } catch {
      return fail(400, 'invalid_pagination')
    }
  },
}

export const ROUTINE_TOOLS: ToolSpec[] = [
  routineList, routineGet, routineCreate, routineUpdate,
  lifecycle('routine_enable', enableRoutine), lifecycle('routine_pause', pauseRoutine), lifecycle('routine_archive', archiveRoutine),
  routineRunNow, routineRunList, routineRunGet, routineRunCancel, routineProposalSubmit, needsYouList,
]
