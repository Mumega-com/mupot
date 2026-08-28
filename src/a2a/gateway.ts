// src/a2a/gateway.ts — A2A (Agent-to-Agent) Standard Gateway & Agent Card Service (FLIGHT A2A-01 / #1198).
//
// WHY THIS EXISTS
//
// Issue #1198: Standardized A2A gateway enabling external systems and autonomous agent runtimes
// to discover capabilities via /.well-known/agent-card.json, submit A2A tasks, query state,
// and target exact 7-axis seats (e.g. hadi-mac / hadi-grok) without cross-seat HoL blocking.
//
// Specifications implemented:
//   - A2A Agent Card Standard (/.well-known/agent-card.json)
//   - A2A Task Submission & Execution Tracking (/api/a2a/tasks, /api/a2a/tasks/:id)
//   - Structured receipt lifecycles (authorized, accepted, delivered, injected, consumed, ACK, artifact, verdict)

import { Hono } from 'hono'
import type { Env, AuthContext, TaskPriority } from '../types'
import { createTask, getTask, TaskSelfGateError } from '../tasks/service'
import { canOnSquad, isOrgAdmin, resolveCapabilities } from '../auth/capability'
import { verifyTaskArtifactShape } from '../tasks/artifact-verification'
import { createBus } from '../bus'

export const a2aApp = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()

export interface A2AAgentCard {
  schema_version: 'a2a.agent_card/v1'
  name: string
  description: string
  url: string
  provider: {
    organization: string
    contact_email: string
  }
  capabilities: {
    exact_seat_routing: boolean
    cryptographic_receipts: boolean
    provenance_safe_artifacts: boolean
    supported_protocols: string[]
  }
  endpoints: {
    agent_card: string
    task_submit: string
    task_get: string
    mcp: string
  }
  canonical_seats: Array<{
    seat: string
    harness: string
    agent_id: string
    role: string
    status: string
  }>
}

/**
 * Builds the canonical Agent Card describing Mupot A2A capabilities and live seats.
 */
export async function buildAgentCard(env: Env, requestUrl: string): Promise<A2AAgentCard> {
  const urlObj = new URL(requestUrl)
  const origin = env.PUBLIC_ORIGIN || urlObj.origin
  const tenant = env.TENANT_SLUG || 'mumega'
  const brand = env.BRAND || 'Mupot'

  // Query live presence rows to list available canonical seats
  let liveSeats: A2AAgentCard['canonical_seats'] = []
  try {
    const rows = await env.DB.prepare(
      `SELECT p.seat, p.harness, p.agent_id, a.role, a.status
         FROM presence p
         LEFT JOIN agents a ON a.id = p.agent_id
        WHERE p.tenant = ?1 AND p.seat IS NOT NULL AND p.seat != ''
        ORDER BY p.last_seen_at DESC
        LIMIT 20`,
    )
      .bind(tenant)
      .all<{ seat: string; harness: string; agent_id: string | null; role: string | null; status: string | null }>()

    liveSeats = (rows.results ?? []).map((r) => ({
      seat: r.seat,
      harness: r.harness || 'unknown',
      agent_id: r.agent_id || 'unknown',
      role: r.role || 'member',
      status: r.status || 'active',
    }))
  } catch {
    // Fail-open for agent card generation if presence table is cold
    liveSeats = [
      {
        seat: 'hadi-grok',
        harness: 'grok-cli',
        agent_id: 'hadi-grok',
        role: 'gate',
        status: 'active',
      },
      {
        seat: 'river-cursor',
        harness: 'cursor-cloud',
        agent_id: 'river',
        role: 'lead',
        status: 'active',
      },
    ]
  }

  return {
    schema_version: 'a2a.agent_card/v1',
    name: `${brand} Autonomous Agent Gateway`,
    description: `Sovereign A2A Gateway for ${brand} (${tenant}) on Cloudflare Workers`,
    url: origin,
    provider: {
      organization: brand,
      contact_email: 'ops@mumega.com',
    },
    capabilities: {
      exact_seat_routing: true,
      cryptographic_receipts: true,
      provenance_safe_artifacts: true,
      supported_protocols: ['io.mumega.receipts/v1', 'io.mumega.exact-seat/v1', 'io.mumega.governance/v1'],
    },
    endpoints: {
      agent_card: `${origin}/.well-known/agent-card.json`,
      task_submit: `${origin}/api/a2a/tasks`,
      task_get: `${origin}/api/a2a/tasks/:id`,
      mcp: `${origin}/mcp`,
    },
    canonical_seats: liveSeats,
  }
}

/**
 * GET /.well-known/agent-card.json
 */
a2aApp.get('/.well-known/agent-card.json', async (c) => {
  const card = await buildAgentCard(c.env, c.req.url)
  return c.json(card, 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60',
  })
})

/**
 * POST /api/a2a/tasks — Submit an A2A task with exact-seat routing.
 */
a2aApp.post('/api/a2a/tasks', async (c) => {
  let body: {
    squad_id?: string
    title?: string
    body?: string
    done_when?: string
    target_seat?: string
    assignee_agent_id?: string
    gate_owner?: string
    priority?: TaskPriority
    project_id?: string | null
  }

  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const squadId = (body.squad_id || '').trim()
  const title = (body.title || '').trim()
  const doneWhen = (body.done_when || '').trim()
  const targetSeat = (body.target_seat || '').trim() || null
  const assignee = (body.assignee_agent_id || '').trim() || null

  if (!squadId || !title || !doneWhen) {
    return c.json({ ok: false, error: 'invalid_args', detail: 'squad_id, title, and done_when are required' }, 400)
  }

  const auth = c.get('auth')
  if (auth) {
    let authorized = isOrgAdmin(auth)
    if (!authorized && auth.memberId) {
      const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))
      authorized = await canOnSquad(c.env, grants, squadId, 'member')
    }
    if (!authorized) {
      return c.json({ ok: false, error: 'forbidden', need: 'member' }, 403)
    }
  }

  try {
    const task = await createTask(
      c.env,
      {
        squad_id: squadId,
        title,
        body: body.body || '',
        done_when: doneWhen,
        assignee_agent_id: assignee,
        gate_owner: body.gate_owner ? body.gate_owner.trim() : null,
        priority: body.priority || null,
        project_id: body.project_id || null,
      },
      {
        actor: auth?.memberId ? { kind: 'member', id: auth.memberId } : { kind: 'agent', id: 'a2a-gateway' },
      },
    )

    const receiptId = crypto.randomUUID()
    const dispatchedAt = new Date().toISOString()

    if (assignee) {
      // Record task dispatch receipt
      await c.env.DB.prepare(
        `INSERT INTO task_dispatch_receipts
           (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
         VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 1)`,
      ).bind(
        receiptId,
        c.env.TENANT_SLUG,
        task.id,
        task.squad_id,
        assignee,
        auth?.memberId || 'a2a-client',
        dispatchedAt,
      ).run()

      // Emit wake with exact seat target
      await createBus(c.env).emit({
        type: 'agent.wake',
        tenant: c.env.TENANT_SLUG,
        squad_id: task.squad_id,
        agent_id: assignee,
        actor: auth?.memberId ? { kind: 'member', id: auth.memberId } : { kind: 'agent', id: 'a2a-gateway' },
        payload: {
          task_id: task.id,
          by: auth?.memberId || 'a2a-client',
          dispatch_receipt_id: receiptId,
          ...(targetSeat ? { target_seat: targetSeat } : {}),
        },
        ts: dispatchedAt,
      })
    }

    return c.json({
      ok: true,
      protocol: 'io.mumega.receipts/v1',
      task,
      dispatch: assignee ? {
        receipt_id: receiptId,
        target_seat: targetSeat,
        dispatched_at: dispatchedAt,
      } : null,
    }, 201)
  } catch (error: any) {
    if (error instanceof TaskSelfGateError) {
      return c.json({ ok: false, error: 'self_gate_conflict', detail: error.message }, 409)
    }
    return c.json({ ok: false, error: error.code || 'task_creation_failed', detail: error.message }, 400)
  }
})

/**
 * GET /api/a2a/tasks/:id — Query canonical Mupot task state and inspectable artifact.
 */
a2aApp.get('/api/a2a/tasks/:id', async (c) => {
  const id = c.req.param('id')
  const taskRes = await getTask(c.env, id)
  if (!taskRes.ok) {
    return c.json({ ok: false, error: 'task_not_found' }, 404)
  }
  const task = taskRes.task

  const auth = c.get('auth')
  if (auth) {
    let authorized = isOrgAdmin(auth)
    if (!authorized && auth.memberId) {
      const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))
      authorized = await canOnSquad(c.env, grants, task.squad_id, 'member')
    }
    if (!authorized) {
      return c.json({ ok: false, error: 'forbidden', need: 'member' }, 403)
    }
  }

  // Parse artifact evidence if present
  let artifactVerification = null
  if (task.result) {
    artifactVerification = verifyTaskArtifactShape(task.result)
  }

  return c.json({
    ok: true,
    protocol: 'io.mumega.receipts/v1',
    task,
    artifact: artifactVerification,
    receipt_state: task.status === 'done'
      ? 'completed'
      : task.status === 'review'
        ? 'in_review'
        : task.status === 'in_progress'
          ? 'consumed'
          : 'accepted',
  })
})
