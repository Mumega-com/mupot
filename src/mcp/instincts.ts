// mupot — MCP instinct-memory tools (Module Kernel, Port 4 / ECC continuous-learning-v2.1).
//
// Design: docs/architecture/mupot-module-kernel.md (build-order item 3) +
// docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.5 / §3.
//
// Flow: hooks → instinct_observe → instinct_distill (cheap model) → instincts table
// → instinct_recall; project→global via instinct_promote (≥2 projects / avg≥0.8).
//
// AUTHZ:
//   - project_id gated through readAccess + readableProject (same chokepoint as
//     presence / project_remember) — no wrong-id vs no-access oracle.
//   - observe: project READ (capture is collaborative working context).
//   - distill / upsert-into-project: project WRITE + member floor on a squad that
//     actually holds project write (not observer-on-write-mapped-squad).
//   - promote: org:admin + shouldPromoteInstinct gate — no silent / direct global
//     upsert bypass.
//   - Identity for agent_id is server-derived (boundAgentId ?? memberId), never args.

import type { AuthContext, CapabilityGrant, Env } from '../types'
import { hasCapability } from '../auth/capability'
import { anySquadHasProjectWrite } from '../projects/access'
import { readAccess, readableProject } from './projects'
import { type ToolSpec, fail, done, str, hasWorkspaceAdmin } from './index'
import {
  INSTINCT_DECAY_HALF_LIFE_DAYS,
  defaultInstinctInjectOpts,
  filterInstinctsForInject,
  resolveInstinctPrecedence,
  shouldPromoteInstinct,
  summarizeInstinctsForInject,
  decayInstinctConfidence,
} from '../memory/instinct'
import {
  appendInstinctObservation,
  countObservations,
  isInstinctObservationEvent,
  listInstinctsById,
  listInstinctsForProject,
  listRecentObservations,
  promoteInstinctToGlobal,
  upsertDistilledCandidate,
} from '../memory/instinct-service'
import {
  defaultDistillModel,
  defaultInstinctChat,
  defaultMinObservations,
  distillInstinctsFromObservations,
} from '../memory/instinct-distill'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OBJECT_SCHEMA = { type: 'object' }
const NUMBER_SCHEMA = { type: 'number' }
const BOOLEAN_SCHEMA = { type: 'boolean' }

const OBSERVATION_EVENT_ENUM = [
  'tool_start',
  'tool_complete',
  'user_message',
  'correction',
  'note',
]

const OBSERVE_SCAN_LIMIT = 200

function callerIdentity(auth: AuthContext): string | null {
  return auth.boundAgentId ?? auth.memberId ?? null
}

/** Squad ids where the caller holds ≥ member (fixes observer-on-write-mapped-squad). */
function memberCapableSquadIds(auth: AuthContext): string[] {
  const grants: CapabilityGrant[] = auth.capabilities ?? []
  const access = readAccess(auth)
  return access.squadIds.filter((squadId) => hasCapability(grants, 'squad', squadId, 'member'))
}

async function gateProjectRead(
  auth: AuthContext,
  env: Env,
  projectId: string,
): Promise<ReturnType<typeof fail> | null> {
  const project = await readableProject(env, projectId, readAccess(auth))
  if (!project) return fail(404, 'project_not_found')
  return null
}

async function gateProjectInstinctWrite(
  auth: AuthContext,
  env: Env,
  projectId: string,
): Promise<ReturnType<typeof fail> | null> {
  const access = readAccess(auth)
  const project = await readableProject(env, projectId, access)
  if (!project) return fail(404, 'project_not_found')
  if (access.workspaceAdmin) return null
  const squads = memberCapableSquadIds(auth)
  if (!(await anySquadHasProjectWrite(env, projectId, squads))) {
    return fail(403, 'forbidden', { need: 'project_write', scope: 'project' })
  }
  return null
}

const toolInstinctObserve: ToolSpec = {
  name: 'instinct_observe',
  scope: 'project observations (hook auto-capture sink)',
  min: 'observer',
  args: '{ project_id: string, event: "tool_start"|"tool_complete"|"user_message"|"correction"|"note", payload?: object, session_id?: string|null }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      event: { type: 'string', enum: OBSERVATION_EVENT_ENUM },
      payload: OBJECT_SCHEMA,
      session_id: NULLABLE_STRING_SCHEMA,
    },
    required: ['project_id', 'event'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    if (!isInstinctObservationEvent(args.event)) {
      return fail(400, 'invalid_event', { accepted: OBSERVATION_EVENT_ENUM })
    }
    const readGate = await gateProjectRead(auth, env, projectId)
    if (readGate) return readGate

    const payload =
      args.payload === undefined
        ? {}
        : (args.payload !== null && typeof args.payload === 'object' && !Array.isArray(args.payload)
          ? args.payload as Record<string, unknown>
          : null)
    if (payload === null) return fail(400, 'invalid_payload', 'payload must be an object')

    const sessionId = args.session_id === undefined || args.session_id === null
      ? null
      : (str(args.session_id) ?? null)

    const saved = await appendInstinctObservation(env, {
      projectId,
      agentId: callerIdentity(auth),
      sessionId,
      event: args.event,
      payload,
      now: new Date().toISOString(),
    })
    if (!saved.ok) return fail(400, saved.error)

    const pending = await countObservations(env, projectId)
    return done({
      observation_id: saved.value.id,
      project_id: projectId,
      event: saved.value.event,
      pending_observations: pending,
      distill_ready: pending >= defaultMinObservations(),
    })
  },
}

const toolInstinctDistill: ToolSpec = {
  name: 'instinct_distill',
  scope: 'project instincts (cheap-model distill from observations)',
  min: 'member',
  args: '{ project_id: string, limit?: number, force?: boolean }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
      force: BOOLEAN_SCHEMA,
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const writeGate = await gateProjectInstinctWrite(auth, env, projectId)
    if (writeGate) return writeGate

    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit), 1), OBSERVE_SCAN_LIMIT)
      : OBSERVE_SCAN_LIMIT
    const force = args.force === true
    const minObs = force ? 1 : defaultMinObservations()

    const observations = await listRecentObservations(env, projectId, limit)
    const preferGateway = Boolean(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_TOKEN.length > 0)
    const distilled = await distillInstinctsFromObservations({
      projectId,
      observations,
      minObservations: minObs,
      chat: defaultInstinctChat(env),
      model: defaultDistillModel(preferGateway),
    })

    if (distilled.skipped) {
      return done({
        project_id: projectId,
        skipped: true,
        reason: distilled.reason,
        upserted: [],
      })
    }

    const now = new Date().toISOString()
    const agentId = callerIdentity(auth)
    const upserted = []
    for (const candidate of distilled.candidates) {
      const saved = await upsertDistilledCandidate(env, projectId, agentId, candidate, now)
      if (!saved.ok) return fail(400, saved.error, { candidate_id: candidate.id })
      upserted.push({
        id: saved.value.id,
        trigger: saved.value.trigger,
        confidence: saved.value.confidence,
        domain: saved.value.domain,
        scope: saved.value.scope,
      })
    }

    return done({
      project_id: projectId,
      skipped: false,
      reason: null,
      observation_count: observations.length,
      upserted,
    })
  },
}

const toolInstinctRecall: ToolSpec = {
  name: 'instinct_recall',
  scope: 'project + global instincts (confidence-decayed)',
  min: 'observer',
  args: '{ project_id: string, min_confidence?: number, limit?: number }',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: STRING_SCHEMA,
      min_confidence: NUMBER_SCHEMA,
      limit: NUMBER_SCHEMA,
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const projectId = str(args.project_id)
    if (!projectId) return fail(400, 'invalid_args', 'project_id required')
    const readGate = await gateProjectRead(auth, env, projectId)
    if (readGate) return readGate

    const opts = defaultInstinctInjectOpts()
    if (typeof args.min_confidence === 'number' && Number.isFinite(args.min_confidence)) {
      opts.minConfidence = args.min_confidence
    }
    if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
      opts.maxInjected = Math.min(Math.max(Math.floor(args.limit), 1), 50)
    }

    const now = new Date().toISOString()
    const raw = await listInstinctsForProject(env, projectId)
    const instincts = filterInstinctsForInject(
      resolveInstinctPrecedence(raw),
      opts,
      now,
      INSTINCT_DECAY_HALF_LIFE_DAYS,
    )
    const summary = summarizeInstinctsForInject(instincts)

    return done({
      project_id: projectId,
      instincts: instincts.map((instinct) => ({
        id: instinct.id,
        trigger: instinct.trigger,
        confidence: instinct.confidence,
        domain: instinct.domain,
        scope: instinct.scope,
        action: instinct.action,
        project_id: instinct.projectId,
        updated_at: instinct.updatedAt,
      })),
      summary,
    })
  },
}

const toolInstinctPromote: ToolSpec = {
  name: 'instinct_promote',
  scope: 'global instincts (FRC no-silent-promotion gate)',
  min: 'admin',
  args: '{ id: string }',
  inputSchema: {
    type: 'object',
    properties: { id: STRING_SCHEMA },
    required: ['id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!hasWorkspaceAdmin(auth)) {
      return fail(403, 'forbidden', { need: 'org:admin', scope: 'instinct_promote' })
    }
    const id = str(args.id)
    if (!id) return fail(400, 'invalid_args', 'id required')

    const rows = await listInstinctsById(env, id)
    const projectRows = rows.filter((r) => r.scope === 'project' && r.projectId !== null)
    if (projectRows.length === 0) return fail(404, 'instinct_not_found')

    if (!shouldPromoteInstinct(projectRows)) {
      return done({
        promoted: false,
        reason: 'promotion_gate_not_met',
        need: {
          min_projects: 2,
          min_avg_confidence: 0.8,
          projects_seen: new Set(projectRows.map((r) => r.projectId)).size,
          avg_confidence:
            projectRows.reduce((s, r) => s + r.confidence, 0) / projectRows.length,
        },
      })
    }

    // Promote the strongest project instance (highest confidence, then newest).
    const strongest = projectRows
      .slice()
      .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))[0]

    const now = new Date().toISOString()
    // Persist decayed confidence so global carries current weight.
    const confidence = decayInstinctConfidence(
      strongest.confidence,
      strongest.updatedAt,
      now,
      INSTINCT_DECAY_HALF_LIFE_DAYS,
    )
    const promoted = await promoteInstinctToGlobal(
      env,
      { ...strongest, confidence },
      now,
    )
    if (!promoted.ok) return fail(400, promoted.error)

    return done({
      promoted: true,
      instinct: {
        id: promoted.value.id,
        trigger: promoted.value.trigger,
        confidence: promoted.value.confidence,
        domain: promoted.value.domain,
        scope: promoted.value.scope,
        action: promoted.value.action,
      },
    })
  },
}

export const INSTINCT_TOOLS: ToolSpec[] = [
  toolInstinctObserve,
  toolInstinctDistill,
  toolInstinctRecall,
  toolInstinctPromote,
]
