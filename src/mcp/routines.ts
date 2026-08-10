import { listNeedsYou } from '../attention/service'
import { priceUsage } from '../economy/prices'
import { answerRoutineRun, cancelRoutineRun, submitRoutineProposal } from '../routines/actions'
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
  if (['project_not_found', 'routine_not_found', 'run_not_found', 'answer_not_found'].includes(error)) return 404
  if (error === 'forbidden') return 403
  if (['receipt_failed', 'invalid_state', 'routine_archived', 'routine_not_enabled', 'schedule_exhausted', 'run_terminal',
    'run_not_accepting_proposal', 'action_key_conflict', 'proposal_already_submitted', 'stale_situation',
    'answer_conflict', 'retry_exhausted'].includes(error)) return 409
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
  name: 'routine_run_get',
  scope: 'visible routine run; the assigned agent additionally reads situation_digest',
  min: 'observer', args: '{ run_id: string }',
  inputSchema: { type: 'object', properties: { run_id: id() }, required: ['run_id'], additionalProperties: false },
  async run(auth, env, args) {
    if (!validId(args.run_id)) return fail(404, 'run_not_found')
    const run = await getRoutineRun(env, routinePrincipal(auth), args.run_id)
    if (!run) return fail(404, 'run_not_found')
    // The assigned agent MUST echo situation_digest back on routine_proposal_submit
    // (proposal.ts:181-189 requires the field; actions.ts:1656 rejects a mismatch with
    // situation_mismatch). Today that value reaches the agent through exactly ONE channel:
    // the routine.run/v1 inbox envelope minted at dispatch.ts:554. And `inbox` has no
    // per-message consume — {limit, peek}, additionalProperties:false — so a non-peek read
    // marks the whole batch read (messages.ts:406) and no MCP tool can reach a consumed
    // row again. Any second reader of that inbox therefore strands the run permanently.
    // That is not hypothetical: flight 94e5195c sat unlanded from 2026-08-08 because a
    // watcher drained asha's inbox first, and flight-executor.py fail-closed rather than
    // fabricate the digest.
    //
    // Read-back is NOT an authorization weakening. submitRoutineProposal RECOMPUTES
    // currentSituationDigest server-side and compares (actions.ts:1673) before accepting
    // anything, so an echoed value cannot bypass the staleness gate — it can only prove
    // the agent saw the situation it acted on. And the gate is scoped to the ONE principal
    // that already received this exact digest by message, so no reach is added.
    //
    // Everyone else keeps the byte-identical public Run DTO: REST and the dashboard read
    // publicRoutineRun and are deliberately untouched.
    const assignedAgent = typeof auth.boundAgentId === 'string'
      && run.assigned_agent_id !== null
      && auth.boundAgentId === run.assigned_agent_id
    return done({
      run: assignedAgent
        ? { ...publicRoutineRun(run), situation_digest: run.situation_digest }
        : publicRoutineRun(run),
    })
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

const routineRunAnswer: ToolSpec = {
  name: 'routine_run_answer', scope: 'responsible writable squad Routine answer', min: 'member',
  args: '{ run_id: string, answer: string }',
  inputSchema: {
    type: 'object', properties: { run_id: id(), answer: string(4000) },
    required: ['run_id', 'answer'], additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!validId(args.run_id)) return fail(404, 'run_not_found')
    if (!boundedString(args.answer, 4000)) return fail(400, 'invalid_answer')
    const result = await answerRoutineRun(env, routinePrincipal(auth), args.run_id, args.answer)
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

const reportRunUsage: ToolSpec = {
  name: 'report_run_usage',
  scope: 'self (the run\'s assigned agent reports its own measured token usage)',
  min: 'member',
  args: '{ run_id: string, model: string, input: number, output: number, cache_read?: number, cache_write?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: id(),
      model: { type: 'string', maxLength: 120 },
      input: { type: 'integer', minimum: 0 },
      output: { type: 'integer', minimum: 0 },
      cache_read: { type: 'integer', minimum: 0 },
      cache_write: { type: 'integer', minimum: 0 },
    },
    required: ['run_id', 'model', 'input', 'output'],
    additionalProperties: false,
  },
  // WHY THIS IS A POST-HOC WRITE, and not a field on routine_proposal_submit:
  // token usage is only known once the runtime subprocess EXITS, which happens after the
  // model has already called routine_proposal_submit — and that call auto-lands the flight
  // via landControlFlight. So the cost necessarily arrives after the landing. Accepting it
  // on the proposal would mean asking a model to self-report its own usage before it has
  // finished producing it, which is a number it cannot know and would therefore invent.
  //
  // The measurement itself comes from the harness, not the model: prime-agent emits real
  // {input, output, cacheRead, cacheWrite} plus the true model name on every turn_end, and
  // prime-responder.py captures it. See #896 for the full chain this replaces — hardcoded
  // 1250/380 at dispatch, cost 0 at landing, and a dashboard rendering the constants as
  // measured usage.
  async run(auth, env, args) {
    if (!validId(args.run_id)) return fail(404, 'run_not_found')
    const run = await getRoutineRun(env, routinePrincipal(auth), args.run_id)
    if (!run) return fail(404, 'run_not_found')

    // Same predicate routine_proposal_submit enforces (routines/actions.ts): only the
    // assigned agent may speak for this run. An operator principal (boundAgentId null)
    // must never match — cost is agent-attributed, and an unattributed cost is not a cost.
    if (typeof auth.boundAgentId !== 'string'
      || run.assigned_agent_id === null
      || auth.boundAgentId !== run.assigned_agent_id) {
      return fail(403, 'assigned_agent_mismatch')
    }
    if (!run.flight_id) return fail(409, 'run_has_no_flight')

    const priced = priceUsage(args.model as string, {
      input: args.input as number,
      output: args.output as number,
      cacheRead: (args.cache_read as number | undefined) ?? 0,
      cacheWrite: (args.cache_write as number | undefined) ?? 0,
    })
    // Unknown model => refuse. Recording 0 here would be indistinguishable from "this run
    // was free", which is exactly the ambiguity that made cost_micro_usd meaningless.
    if (priced === null) {
      return fail(400, 'model_not_priced', {
        detail: 'no rate for this model; add it to src/economy/prices.ts with a cited source',
        model: args.model,
      })
    }

    // SET, not accumulate: the harness reports one measured total per run. Repeating the
    // same call writes the same number, so this is idempotent for identical input; a later
    // call with different usage is a corrected measurement and last-write-wins is correct.
    // Lands on the flight even after status='landed' — this is an accounting correction,
    // and refusing it would mean the only flights we can price are ones that never finished.
    await env.DB.prepare(
      `UPDATE flights SET cost_micro_usd = ?3 WHERE id = ?1 AND tenant = ?2`,
    ).bind(run.flight_id, env.TENANT_SLUG, priced).run()

    // Keep the run consistent with its flights. routine_runs.cost_micro_usd is defined
    // elsewhere (actions.ts) as SUM over the run's flights; recompute with the same shape
    // rather than assigning `priced` directly, so a multi-flight run stays correct.
    await env.DB.prepare(
      `UPDATE routine_runs SET cost_micro_usd = (
         SELECT COALESCE(SUM(f.cost_micro_usd), 0) FROM flights f
          WHERE f.tenant = routine_runs.tenant AND (
            f.id = routine_runs.flight_id OR f.id IN (
              SELECT ref_id FROM routine_run_refs WHERE run_id = routine_runs.id AND ref_type = 'flight'
            )
          )
       ), updated_at = ?3
       WHERE id = ?1 AND tenant = ?2`,
    ).bind(run.id, env.TENANT_SLUG, new Date().toISOString()).run()

    return done({ run_id: run.id, flight_id: run.flight_id, cost_micro_usd: priced, model: args.model })
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
  routineRunNow, routineRunList, routineRunGet, routineRunAnswer, routineRunCancel, routineProposalSubmit, reportRunUsage, needsYouList,
]
