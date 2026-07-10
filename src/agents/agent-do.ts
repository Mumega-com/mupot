// mupot — AgentDO: the agent runtime core. One Durable Object per agent row.
//
// Holds the agent's runtime state in its own embedded SQLite (ctx.storage.sql),
// hibernates between alarms, and runs a "cortex cycle" when woken — either by an
// alarm (scheduled metabolism) or a `wake` fetch. A cycle: load context (recall
// via the memory port) → think (model call via Workers AI) → decide → emit
// actions to the bus (chiefly: create tasks).
//
// Isolation: a DO instance is addressed by the agent id, so its SQLite is private
// to that agent. We still re-verify the agent row (tenant + status) on every wake
// so a stale/cross-tenant id can never drive a cycle.

import { DurableObject } from 'cloudflare:workers'
import type { Env, Agent, Task, MemoryPort, ModelMessage } from '../types'
import { createMemory } from '../memory'
import { createModel } from '../model'
import { createTask } from '../tasks/service'
import { runTaskExecution, resolveTaskId } from './execute'
import { runGoalCycle } from './loop'
import { COOLDOWN_EXTENSION_MS } from './observer'
import { resolveAgentIdentity } from './identity'

// Wake request body — who/why woke this agent, and how hard it may work.
//
// Two shapes arrive at /wake: a plain WakeInput (from the agents API and the
// squad coordinator) and a full BusEvent (from the Queue consumer, which posts
// the raw event). We read the structured fields we know from either: a top-level
// `task_id` (execute mode) OR `payload.task_id` (when woken by a task.* event).
interface WakeInput {
  // Logical Mupot agent id. Durable Object ids are opaque and cannot be used to
  // re-load the corresponding D1 row, so the first internal wake binds this id.
  agent_id?: string
  reason?: string
  squad_id?: string
  // optional inline context (e.g. a dispatched lead/task) to seed the cycle
  context?: string
  // safety cap on actions emitted in one cycle
  maxActions?: number
  // EXECUTE MODE: when set, the cycle DOES this task (load → think → persist the
  // result) instead of proposing new tasks. The task must belong to this agent's
  // squad (fail-closed) or the cycle is a no-op.
  task_id?: string
  // present only when the body is a raw BusEvent (Queue path). We read task_id
  // out of it so a task.* dispatch can drive execute mode.
  payload?: unknown
}

interface WakeResult {
  ok: boolean
  agent_id: string
  cycle: number
  decided: string
  actions: number
  error?: string
  // execute-mode telemetry (present only when the wake carried a task_id)
  task_id?: string
  task_status?: Task['status']
  // S2: true when wake() already scheduled the next alarm itself (cooldown
  // extension or ensureAlarm). alarm() must NOT re-arm in that case, or it would
  // overwrite the cooldown backoff with the default interval.
  rescheduled?: boolean
}

interface AgentStatus {
  agent_id: string
  initialized: boolean
  cycles: number
  last_woke_at: string | null
  last_decision: string | null
  next_alarm_at: string | null
}

// How often a healthy active agent metabolizes on its own (ms). Conservative —
// the bus/squad coordinator is the primary driver; the alarm is the heartbeat.
const ALARM_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_MAX_ACTIONS = 3
const RECALL_LIMIT = 5

// Minimal shape we ask the model to return. The model is a cheap CF model, so we
// parse defensively and fall back to a no-op decision rather than throwing.
interface Decision {
  summary: string
  // each action becomes a bus emit (currently only task creation is wired).
  // #142 capsule keystone: done_when is optional here (cheap models may omit it)
  // — the creation path falls back to a sentinel; callers should backfill later.
  tasks: { title: string; body: string; done_when?: string }[]
}

export class AgentDO extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    // Runtime state table is private to this DO (this agent). Created lazily.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `)
  }

  // ── HTTP surface (called via stub.fetch from agentsApp / squad coordinator) ──
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    switch (url.pathname) {
      case '/wake': {
        const input = (await this.readJson<WakeInput>(req)) ?? {}
        const result = await this.wake(input)
        return Response.json(result, { status: result.ok ? 200 : 409 })
      }
      case '/status': {
        return Response.json(await this.status())
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }

  // ── Scheduled metabolism: the hibernation heartbeat ──
  async alarm(): Promise<void> {
    // Self-driven cycle. If the agent is paused/missing this becomes a no-op and
    // we stop rescheduling (no zombie alarms burning quota).
    const result = await this.wake({ reason: 'alarm' })
    // Only re-arm at the default interval if wake() did NOT already schedule the
    // next alarm itself. The goal/cortex paths self-schedule (incl. the S2 cooldown
    // extension); re-arming here would clobber that backoff. Execute-mode + paths
    // that don't self-schedule still get the heartbeat re-arm.
    if (result.ok && !result.rescheduled) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
    }
  }

  // ── Core: run one cortex cycle ──
  private async wake(input: WakeInput): Promise<WakeResult> {
    const identity = resolveAgentIdentity(this.get('agent_id'), input.agent_id)
    if (!identity.ok) {
      return {
        ok: false,
        agent_id: this.get('agent_id') ?? this.ctx.id.toString(),
        cycle: this.getCycles(),
        decided: '',
        actions: 0,
        error: identity.error,
      }
    }
    if (identity.bind) this.put('agent_id', identity.agentId)

    const agent = await this.loadAgent(identity.agentId)
    if (!agent) {
      return { ok: false, agent_id: identity.agentId, cycle: this.getCycles(), decided: '', actions: 0, error: 'agent_not_found' }
    }
    if (agent.status !== 'active') {
      return { ok: false, agent_id: agent.id, cycle: this.getCycles(), decided: '', actions: 0, error: 'agent_paused' }
    }

    // EXECUTE MODE — a wake carrying a task_id (top-level or in a BusEvent payload)
    // means "do this task", not "propose tasks". Delegate to the execution core
    // (testable, DO-independent) and record the cycle. The standard cortex cycle
    // never runs alongside execution.
    const taskId = resolveTaskId(input)
    if (taskId) {
      const cycle = this.getCycles() + 1
      const r = await runTaskExecution(this.env, agent, taskId)
      this.recordCycle(cycle, `execute: ${r.decided || r.error || 'no-op'}`)
      return {
        ok: r.ok,
        agent_id: agent.id,
        cycle,
        decided: r.decided,
        actions: r.task_status === 'done' ? 1 : 0,
        error: r.error,
        task_id: r.task_id,
        task_status: r.task_status,
      }
    }

    const cycle = this.getCycles() + 1

    // GOAL-SEEKING PATH: when the agent has an OKR, run the goal cycle instead
    // of (not alongside) the generic cortex propose-cycle. Goal-less agents
    // continue to run the original cortex propose-cycle below unchanged.
    if (agent.okr && agent.okr.trim().length > 0) {
      try {
        // Thread the DO runtime state (cycles, last_woke_at, last_decision, wake
        // reason) into the sensorium so the agent reads its self-state each cycle.
        const goalResult = await runGoalCycle(this.env, agent, {
          sensoriumRuntime: {
            cycles: cycle,
            last_woke_at: this.get('last_woke_at'),
            last_decision: this.get('last_decision'),
            wake_reason: input.reason ?? null,
          },
        })
        const decided = goalResult.decided + (goalResult.error ? `: ${goalResult.error}` : '')
        this.recordCycle(cycle, `goal: ${decided}`)

        // S2: consume observer signals from the goal cycle.
        // cooldown=true → extend the next alarm so the agent backs off instead of
        //   busy-looping on an identical situation every 15 min.
        // escalate=true → TODO: emit a single operator notification via the
        //   approval/notification seam (see loops/notifications or tasks gate_owner).
        //   Left as a result field for now — the surface to wire it onto is S3 scope.
        const obs = goalResult.observer
        if (obs?.cooldown) {
          // Extend alarm by COOLDOWN_EXTENSION_MS on top of the standard interval.
          // The agent backs off instead of busy-looping on an identical situation.
          await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS + COOLDOWN_EXTENSION_MS)
        } else {
          await this.ensureAlarm()
        }
        // obs?.escalate → TODO: emit a single operator notification via approval/notification
        // seam. Surface: return it in the result for now; S3 wires the actual emit.

        return {
          ok: goalResult.ok,
          agent_id: agent.id,
          cycle,
          decided: `goal:${decided}`,
          actions: goalResult.spawned,
          error: goalResult.error,
          // wake() set the alarm itself above (cooldown extension or ensureAlarm).
          rescheduled: true,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'goal_cycle_failed'
        this.recordCycle(cycle, `goal-error: ${msg}`)
        return { ok: false, agent_id: agent.id, cycle, decided: '', actions: 0, error: msg }
      }
    }

    // GENERIC CORTEX PATH: agent has no goal — propose tasks from context (unchanged).
    const memory = createMemory(this.env)

    try {
      // 1. Load context — semantic recall around the wake reason/context.
      const query = input.context?.trim() || input.reason || agent.role
      const hits = await memory.recall(agent.id, query, RECALL_LIMIT)
      const recalled = hits.map((h) => `- ${h.text}`).join('\n')

      // 2. Think — the model call, abstracted.
      const prompt = this.buildPrompt(agent, input, recalled)
      const raw = await this.think(agent.model, prompt)
      const decision = this.parseDecision(raw)

      // 3. Decide + 4. Act — emit to the bus. Chiefly: create tasks.
      const squadId = input.squad_id ?? agent.squad_id
      const cap = input.maxActions ?? DEFAULT_MAX_ACTIONS
      const toEmit = decision.tasks.slice(0, Math.max(0, cap))
      for (const t of toEmit) {
        await createTask(this.env, {
          squad_id: squadId,
          title: t.title,
          body: t.body,
          // #142: use model-supplied predicate; fall back to a named sentinel.
          done_when: t.done_when ?? '(agent-generated — set via task update)',
        }, {
          actor: { kind: 'agent', id: agent.id },
        })
      }

      // 5. Remember — persist the cycle outcome so future recalls compound.
      await this.rememberOutcome(memory, agent.id, decision, toEmit.length)

      // 6. Persist runtime state + ensure the next heartbeat is scheduled.
      this.recordCycle(cycle, decision.summary)
      await this.ensureAlarm()

      // ensureAlarm() above already scheduled the heartbeat — don't let alarm() re-arm.
      return { ok: true, agent_id: agent.id, cycle, decided: decision.summary, actions: toEmit.length, rescheduled: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'cycle_failed'
      this.recordCycle(cycle, `error: ${msg}`)
      return { ok: false, agent_id: agent.id, cycle, decided: '', actions: 0, error: msg }
    }
  }

  // ── think: the model call, routed through the ModelPort ──
  // Goes through createModel(env), which routes by the org's chosen provider
  // (AI Gateway: anthropic|openai|google) or falls back to Workers AI. The agent
  // row's model id is passed as the preferred model; the port decides how to use
  // it (Workers AI model id, or provider model override). Behavior is unchanged.
  private async think(model: string, prompt: string): Promise<string> {
    const messages: ModelMessage[] = [
      {
        role: 'system',
        content:
          'You are an autonomous org agent. Respond ONLY with a compact JSON object: ' +
          '{"summary": string, "tasks": [{"title": string, "body": string, "done_when": string}]}. ' +
          'done_when must be a short, checkable success predicate (e.g. "test X passes", "PR merged"). ' +
          'Propose at most 3 concrete tasks. If nothing is warranted, return an empty tasks array.',
      },
      { role: 'user', content: prompt },
    ]
    return createModel(this.env).chat(messages, { model })
  }

  private buildPrompt(agent: Agent, input: WakeInput, recalled: string): string {
    const lines = [
      `Agent: ${agent.name} (role: ${agent.role})`,
      `Squad: ${agent.squad_id}`,
      `Wake reason: ${input.reason ?? 'unspecified'}`,
    ]
    if (input.context) lines.push(`Context:\n${input.context}`)
    if (recalled) lines.push(`Relevant memory:\n${recalled}`)
    lines.push('Decide what tasks (if any) advance the squad. Output JSON only.')
    return lines.join('\n\n')
  }

  // Defensive parse — cheap models drift from the schema. Never throw on bad JSON.
  private parseDecision(raw: string): Decision {
    const empty: Decision = { summary: 'no-op', tasks: [] }
    if (!raw) return empty
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return { summary: raw.slice(0, 200), tasks: [] }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
      if (typeof parsed !== 'object' || parsed === null) return empty
      const obj = parsed as { summary?: unknown; tasks?: unknown }
      const summary = typeof obj.summary === 'string' ? obj.summary : 'decided'
      const tasks = Array.isArray(obj.tasks)
        ? obj.tasks
            .filter((t): t is { title: string; body?: string; done_when?: string } => typeof t === 'object' && t !== null && typeof (t as { title?: unknown }).title === 'string')
            .map((t) => ({
              title: String(t.title).slice(0, 200),
              body: typeof t.body === 'string' ? t.body.slice(0, 4000) : '',
              done_when: typeof t.done_when === 'string' && t.done_when.trim().length > 0 ? t.done_when.trim().slice(0, 500) : undefined,
            }))
        : []
      return { summary: summary.slice(0, 500), tasks }
    } catch {
      return { summary: raw.slice(0, 200), tasks: [] }
    }
  }

  private async rememberOutcome(memory: MemoryPort, agentId: string, decision: Decision, emitted: number): Promise<void> {
    const note = `Cortex cycle: ${decision.summary} (emitted ${emitted} task(s)).`
    try {
      await memory.remember(agentId, note, ['cycle', 'decision'])
    } catch {
      // memory write is best-effort; a recall miss next cycle is acceptable, a
      // failed cycle is not. Swallow.
    }
  }

  // ── DB: resolve the agent row (tenant-scoped re-verification on every wake) ──
  private async loadAgent(id: string): Promise<Agent | null> {
    // Load the FULL work-unit row (0009): the goal loop reads okr/kpi/effort/autonomy
    // and the spend gate reads budget_cap_cents/budget_window. Omitting these columns
    // silently disables the goal loop (no okr → falls through to cortex) AND the
    // dollar cap (undefined cap → branch skipped). They MUST be selected here.
    const row = await this.env.DB.prepare(
      `SELECT id, squad_id, slug, name, role, model, status,
              okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window,
              created_at
         FROM agents WHERE id = ?`,
    )
      .bind(id)
      .first<Agent>()
    return row ?? null
  }

  // ── runtime state (private SQLite) ──
  private getCycles(): number {
    const r = this.sql.exec(`SELECT v FROM runtime WHERE k = 'cycles'`).toArray()[0] as { v?: string } | undefined
    return r?.v ? Number(r.v) || 0 : 0
  }

  private recordCycle(cycle: number, decision: string): void {
    const now = new Date().toISOString()
    this.put('cycles', String(cycle))
    this.put('last_woke_at', now)
    this.put('last_decision', decision)
  }

  private put(k: string, v: string): void {
    this.sql.exec(`INSERT INTO runtime (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v)
  }

  private get(k: string): string | null {
    const r = this.sql.exec(`SELECT v FROM runtime WHERE k = ?`, k).toArray()[0] as { v?: string } | undefined
    return r?.v ?? null
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
    }
  }

  private async status(): Promise<AgentStatus> {
    const next = await this.ctx.storage.getAlarm()
    const cycles = this.getCycles()
    return {
      agent_id: this.get('agent_id') ?? this.ctx.id.toString(),
      initialized: cycles > 0 || this.get('last_woke_at') !== null,
      cycles,
      last_woke_at: this.get('last_woke_at'),
      last_decision: this.get('last_decision'),
      next_alarm_at: next === null ? null : new Date(next).toISOString(),
    }
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
