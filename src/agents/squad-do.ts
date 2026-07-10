// mupot — SquadCoordinatorDO: one Durable Object per squad.
//
// Tracks member presence (heartbeats), dispatches wakes to member AgentDOs, and
// holds squad-level advisory locks (so two agents don't both grab the same
// shared resource in one cycle). State lives in this DO's private SQLite.
//
// The coordinator is addressed by squad id, so its state is private to the squad.
// It is the primary driver of agent metabolism on a squad.dispatch event.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { resolveTaskId } from './execute'

interface Presence {
  agent_id: string
  last_seen: string // ISO
}

interface DispatchInput {
  reason?: string
  context?: string
  // restrict dispatch to a subset; default = all active members of the squad
  agent_ids?: string[]
  // EXECUTE MODE: a task_id forwarded to each woken agent so it does the task
  // (the AgentDO scopes it to its own squad, fail-closed). May arrive either as a
  // top-level field or in a BusEvent payload (the Queue posts the raw event).
  task_id?: string
  payload?: unknown
}

interface DispatchResult {
  ok: boolean
  squad_id: string
  dispatched: { agent_id: string; ok: boolean; error?: string }[]
}

interface LockInput {
  key: string
  agent_id: string
  ttl_ms?: number
}

interface LockResult {
  ok: boolean
  key: string
  holder: string | null
  expires_at: string | null
}

// presence is considered stale after this window with no heartbeat.
const PRESENCE_STALE_MS = 10 * 60 * 1000
const DEFAULT_LOCK_TTL_MS = 60 * 1000

export class SquadCoordinatorDO extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        agent_id  TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        key        TEXT PRIMARY KEY,
        holder     TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    switch (url.pathname) {
      case '/dispatch': {
        const input = (await this.readJson<DispatchInput>(req)) ?? {}
        return Response.json(await this.dispatch(input))
      }
      case '/heartbeat': {
        const body = await this.readJson<{ agent_id: string }>(req)
        if (!body?.agent_id) return new Response('agent_id required', { status: 400 })
        this.heartbeat(body.agent_id)
        return Response.json({ ok: true })
      }
      case '/presence': {
        return Response.json({ squad_id: this.squadId(), members: this.activePresence() })
      }
      case '/lock': {
        const body = await this.readJson<LockInput>(req)
        if (!body?.key || !body?.agent_id) return new Response('key + agent_id required', { status: 400 })
        return Response.json(this.acquireLock(body))
      }
      case '/unlock': {
        const body = await this.readJson<{ key: string; agent_id: string }>(req)
        if (!body?.key || !body?.agent_id) return new Response('key + agent_id required', { status: 400 })
        return Response.json(this.releaseLock(body.key, body.agent_id))
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }

  // ── dispatch: wake squad members via their AgentDOs ──
  private async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const squadId = this.squadId()

    // Resolve the target agents from D1 (tenant-scoped: agents under this squad).
    let targets: string[]
    if (input.agent_ids && input.agent_ids.length > 0) {
      // Constrain caller-supplied ids to actual active members of THIS squad —
      // never dispatch to an arbitrary id a caller passed in.
      const members = await this.activeMemberIds()
      const allowed = new Set(members)
      targets = input.agent_ids.filter((id) => allowed.has(id))
    } else {
      targets = await this.activeMemberIds()
    }

    // A task_id may arrive top-level or inside a BusEvent payload (Queue path).
    const taskId = resolveTaskId(input)

    const dispatched: DispatchResult['dispatched'] = []
    for (const agentId of targets) {
      try {
        const stub = this.env.AGENT.get(this.env.AGENT.idFromName(agentId))
        const res = await stub.fetch('https://agent/wake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent_id: agentId,
            reason: input.reason ?? 'squad.dispatch',
            squad_id: squadId,
            context: input.context,
            task_id: taskId ?? undefined,
          }),
        })
        dispatched.push({ agent_id: agentId, ok: res.ok })
      } catch (err) {
        dispatched.push({ agent_id: agentId, ok: false, error: err instanceof Error ? err.message : 'dispatch_failed' })
      }
    }
    return { ok: true, squad_id: squadId, dispatched }
  }

  private async activeMemberIds(): Promise<string[]> {
    const squadId = this.squadId()
    const { results } = await this.env.DB.prepare(
      `SELECT id FROM agents WHERE squad_id = ? AND status = 'active'`,
    )
      .bind(squadId)
      .all<{ id: string }>()
    return (results ?? []).map((r) => r.id)
  }

  // ── presence ──
  private heartbeat(agentId: string): void {
    this.sql.exec(
      `INSERT INTO presence (agent_id, last_seen) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_seen = excluded.last_seen`,
      agentId,
      new Date().toISOString(),
    )
  }

  private activePresence(): Presence[] {
    const rows = this.sql.exec(`SELECT agent_id, last_seen FROM presence`).toArray() as unknown as Presence[]
    const now = Date.now()
    return rows.filter((r) => now - Date.parse(r.last_seen) < PRESENCE_STALE_MS)
  }

  // ── squad-level advisory locks ──
  private acquireLock(input: LockInput): LockResult {
    const now = Date.now()
    const ttl = input.ttl_ms ?? DEFAULT_LOCK_TTL_MS
    const existing = this.sql.exec(`SELECT holder, expires_at FROM locks WHERE key = ?`, input.key).toArray()[0] as
      | { holder: string; expires_at: number }
      | undefined

    if (existing && existing.expires_at > now && existing.holder !== input.agent_id) {
      return { ok: false, key: input.key, holder: existing.holder, expires_at: new Date(existing.expires_at).toISOString() }
    }
    const expires = now + ttl
    this.sql.exec(
      `INSERT INTO locks (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
      input.key,
      input.agent_id,
      expires,
    )
    return { ok: true, key: input.key, holder: input.agent_id, expires_at: new Date(expires).toISOString() }
  }

  private releaseLock(key: string, agentId: string): LockResult {
    const existing = this.sql.exec(`SELECT holder, expires_at FROM locks WHERE key = ?`, key).toArray()[0] as
      | { holder: string; expires_at: number }
      | undefined
    if (existing && existing.holder !== agentId) {
      // not the holder — refuse, report current state
      return { ok: false, key, holder: existing.holder, expires_at: new Date(existing.expires_at).toISOString() }
    }
    this.sql.exec(`DELETE FROM locks WHERE key = ?`, key)
    return { ok: true, key, holder: null, expires_at: null }
  }

  private squadId(): string {
    return this.ctx.id.toString()
  }

  private async readJson<T>(req: Request): Promise<T | null> {
    if (req.method !== 'POST' && req.method !== 'PUT') return null
    try {
      return (await req.json()) as T
    } catch {
      return null
    }
  }
}
