// mupot — Control Tower API. Agents board / advance their cross-project flights; anyone in the
// pot can read the departures board. The rendered board page lives on the dashboard (/coordination).
//
//   POST  /api/coordination        board a flight (agent-bound token)  → {project, goal?, gate?, eta_ms?}
//   PATCH /api/coordination/:id     advance/exit OWN flight             → {status?, goal?, gate?, eta_ms?}
//   GET   /api/coordination?scope=live|all&limit=N   the departures board (JSON cards)
//
// Auth: pot member-token (bearer). Boarding/advancing REQUIRES an agent-bound token — the agent
// identity is the token weld (boundAgentId), NEVER read from the body (no one can fly as another).
// Reading the board needs only a valid member-token (colony-visible). Inbound only; tenant from env.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { boardJourney, updateJourney, listJourneys, buildDepartureBoard, type UpdateInput, type JourneyStatus } from './journeys'

const MAX_BODY_BYTES = 4096

export const coordinationApp = new Hono<{ Bindings: Env }>()

async function readBody(c: { req: { header: (k: string) => string | undefined; text: () => Promise<string> } }): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: 413 | 400 }
> {
  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, status: 413 }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return { ok: false, status: 400 }
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { ok: false, status: 413 }
  if (raw.length === 0) return { ok: true, body: {} }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ok: false, status: 400 }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400 }
  }
}

// POST /api/coordination — board a flight.
coordinationApp.post('/', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  const parsed = await readBody(c)
  if (!parsed.ok) return c.json({ error: parsed.status === 413 ? 'payload_too_large' : 'invalid_body' }, parsed.status)
  const b = parsed.body
  const project = typeof b.project === 'string' ? b.project : ''
  const eta = typeof b.eta_ms === 'number' ? b.eta_ms : undefined

  const res = await boardJourney(c.env, {
    agent: id.boundAgentId,
    project,
    goal: typeof b.goal === 'string' ? b.goal : undefined,
    gate: typeof b.gate === 'string' ? b.gate : undefined,
    eta,
  })
  if (!res.ok) {
    if (res.reason === 'db_error') return c.json({ error: res.reason }, 500)
    return c.json({ error: res.reason, detail: res.detail }, 400)
  }
  return c.json({ ok: true, id: res.id }, 201)
})

// PATCH /api/coordination/:id — advance/exit OWN flight.
coordinationApp.patch('/:id', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  const parsed = await readBody(c)
  if (!parsed.ok) return c.json({ error: parsed.status === 413 ? 'payload_too_large' : 'invalid_body' }, parsed.status)
  const b = parsed.body
  const patch: UpdateInput = {
    status: typeof b.status === 'string' ? (b.status as JourneyStatus) : undefined,
    goal: typeof b.goal === 'string' ? b.goal : undefined,
    gate: typeof b.gate === 'string' ? b.gate : undefined,
    eta: typeof b.eta_ms === 'number' ? b.eta_ms : undefined,
  }
  const res = await updateJourney(c.env, c.req.param('id'), id.boundAgentId, patch)
  if (!res.ok) {
    if (res.reason === 'db_error') return c.json({ error: res.reason }, 500)
    if (res.reason === 'not_found') return c.json({ error: res.reason }, 404)
    return c.json({ error: res.reason, detail: res.detail }, 400)
  }
  return c.json({ ok: true })
})

// GET /api/coordination — the departures board (JSON cards).
coordinationApp.get('/', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  const scope = c.req.query('scope') === 'all' ? 'all' : 'live'
  let limit: number | undefined
  const limitQ = c.req.query('limit')
  if (limitQ !== undefined) {
    const n = Number(limitQ)
    if (!Number.isFinite(n)) return c.json({ error: 'invalid_limit' }, 400)
    limit = n
  }
  try {
    const rows = await listJourneys(c.env, { scope, limit })
    return c.json({ ok: true, board: buildDepartureBoard(rows, Date.now()), scope })
  } catch {
    // Explicit db_error — never silently return an empty board on a read failure (no fake-green).
    return c.json({ error: 'db_error' }, 500)
  }
})
