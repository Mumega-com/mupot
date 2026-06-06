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
import type { Env, Agent, Task, MemoryPort, ModelMessage, BusEvent } from '../types'
import { createMemory } from '../memory'
import { createModel } from '../model'
import { createTask } from '../tasks/service'
import { createBus } from '../bus'

// Wake request body — who/why woke this agent, and how hard it may work.
//
// Two shapes arrive at /wake: a plain WakeInput (from the agents API and the
// squad coordinator) and a full BusEvent (from the Queue consumer, which posts
// the raw event). We read the structured fields we know from either: a top-level
// `task_id` (execute mode) OR `payload.task_id` (when woken by a task.* event).
interface WakeInput {
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

// Hard ceiling on a persisted result (chars). Keeps a runaway model answer from
// bloating the row / GitHub mirror. ~16KB.
const MAX_RESULT_CHARS = 16 * 1024
// Tokens the execute call may spend. Conservative cap; the org's provider/model
// choice still applies (createModel routes by org settings).
const EXECUTE_MAX_TOKENS = 2048

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
  // each action becomes a bus emit (currently only task creation is wired)
  tasks: { title: string; body: string }[]
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
    if (result.ok) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
    }
  }

  // ── Core: run one cortex cycle ──
  private async wake(input: WakeInput): Promise<WakeResult> {
    const agent = await this.loadAgent()
    if (!agent) {
      return { ok: false, agent_id: this.ctx.id.toString(), cycle: 0, decided: '', actions: 0, error: 'agent_not_found' }
    }
    if (agent.status !== 'active') {
      return { ok: false, agent_id: agent.id, cycle: this.getCycles(), decided: '', actions: 0, error: 'agent_paused' }
    }

    // EXECUTE MODE — a wake carrying a task_id (top-level or in a BusEvent payload)
    // means "do this task", not "propose tasks". Branch here so the standard
    // cortex cycle never runs alongside execution.
    const taskId = this.resolveTaskId(input)
    if (taskId) {
      return this.executeTask(agent, taskId)
    }

    const cycle = this.getCycles() + 1
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
        }, {
          actor: { kind: 'agent', id: agent.id },
        })
      }

      // 5. Remember — persist the cycle outcome so future recalls compound.
      await this.rememberOutcome(memory, agent.id, decision, toEmit.length)

      // 6. Persist runtime state + ensure the next heartbeat is scheduled.
      this.recordCycle(cycle, decision.summary)
      await this.ensureAlarm()

      return { ok: true, agent_id: agent.id, cycle, decided: decision.summary, actions: toEmit.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'cycle_failed'
      this.recordCycle(cycle, `error: ${msg}`)
      return { ok: false, agent_id: agent.id, cycle, decided: '', actions: 0, error: msg }
    }
  }

  // ── EXECUTE MODE: do one task, persist the result ──────────────────────────
  //
  // Contract (spec §2):
  //  - load the task tenant + squad-scoped (must belong to THIS agent's squad);
  //  - idempotent: a task already 'done' is left alone (no re-run, no clobber);
  //  - mark in_progress + claim assignee (if unset) BEFORE the model call;
  //  - SUCCESS → status='done', result=<output>, completed_at=now, emit task.completed;
  //  - FAILURE → status='blocked', result=<short note>, completed_at=now, emit
  //    task.blocked. NEVER leave the task stuck in_progress — the model call is
  //    wrapped so any throw lands the task in 'blocked'.
  private async executeTask(agent: Agent, taskId: string): Promise<WakeResult> {
    const cycle = this.getCycles() + 1

    // Fail-closed scope: the task must exist AND live in this agent's squad. A
    // cross-squad / cross-tenant id (env.DB is already this tenant's DB) is a no-op.
    const task = await this.loadTaskForSquad(taskId, agent.squad_id)
    if (!task) {
      this.recordCycle(cycle, `execute: task ${taskId} not found in squad`)
      return { ok: false, agent_id: agent.id, cycle, decided: '', actions: 0, error: 'task_not_found', task_id: taskId }
    }

    // Idempotency: a finished task is never re-executed (the bus may redeliver).
    if (task.status === 'done') {
      this.recordCycle(cycle, `execute: task ${taskId} already done (skip)`)
      return { ok: true, agent_id: agent.id, cycle, decided: 'already_done', actions: 0, task_id: taskId, task_status: 'done' }
    }

    const now = new Date().toISOString()
    const assignee = task.assignee_agent_id ?? agent.id
    // Claim + mark working before spending the model budget, so a concurrent
    // reader/poller sees 'in_progress' and the assignee is attributed.
    await this.setTaskProgress(task.id, assignee, now)

    try {
      const charter = await this.loadSquadCharter(agent.squad_id)
      const system = this.buildExecuteSystem(agent, charter)
      const prompt = this.buildExecutePrompt(task)
      const output = await this.executeModelCall(agent.model, system, prompt)
      const result = this.capResult(output)
      const finishedAt = new Date().toISOString()
      await this.finishTask(task.id, 'done', result, finishedAt)
      await this.emitExecution('task.completed', agent, task, 'done')
      // best-effort memory so the agent's future recalls compound on what it did.
      await this.rememberExecution(agent.id, task, 'done')
      this.recordCycle(cycle, `execute: completed "${task.title}"`)
      return { ok: true, agent_id: agent.id, cycle, decided: `completed: ${task.title}`, actions: 1, task_id: task.id, task_status: 'done' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'execution_failed'
      const note = this.capResult(`Execution failed: ${msg}`)
      const finishedAt = new Date().toISOString()
      // NEVER leave in_progress stuck — land it in blocked with the error note.
      await this.finishTask(task.id, 'blocked', note, finishedAt)
      await this.emitExecution('task.blocked', agent, task, 'blocked')
      this.recordCycle(cycle, `execute: blocked "${task.title}" — ${msg}`)
      return { ok: false, agent_id: agent.id, cycle, decided: '', actions: 0, error: msg, task_id: task.id, task_status: 'blocked' }
    }
  }

  // Resolve a task id from either a plain WakeInput (top-level task_id) or a raw
  // BusEvent body (payload.task_id). Returns null when neither carries one.
  private resolveTaskId(input: WakeInput): string | null {
    if (typeof input.task_id === 'string' && input.task_id.length > 0) return input.task_id
    const payload = input.payload
    if (payload && typeof payload === 'object' && 'task_id' in payload) {
      const v = (payload as Record<string, unknown>).task_id
      if (typeof v === 'string' && v.length > 0) return v
    }
    return null
  }

  // Tenant scope is implicit (env.DB is this tenant's DB); we still constrain to
  // the agent's own squad so a wake can't drive this agent against another squad's
  // task. Returns null on miss / wrong squad.
  private async loadTaskForSquad(taskId: string, squadId: string): Promise<Task | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, created_at, updated_at
         FROM tasks WHERE id = ? AND squad_id = ? LIMIT 1`,
    )
      .bind(taskId, squadId)
      .first<Task>()
    return row ?? null
  }

  private async loadSquadCharter(squadId: string): Promise<string | null> {
    const row = await this.env.DB.prepare('SELECT charter FROM squads WHERE id = ? LIMIT 1')
      .bind(squadId)
      .first<{ charter: string | null }>()
    return row?.charter ?? null
  }

  private async setTaskProgress(taskId: string, assignee: string, updatedAt: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'in_progress', assignee_agent_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(assignee, updatedAt, taskId)
      .run()
  }

  private async finishTask(
    taskId: string,
    status: 'done' | 'blocked',
    result: string,
    completedAt: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE tasks SET status = ?, result = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(status, result, completedAt, completedAt, taskId)
      .run()
  }

  // System turn: grounds the agent in its identity, role, and the squad charter
  // (the tenant-authored culture/mandate) so the work reflects this org.
  private buildExecuteSystem(agent: Agent, charter: string | null): string {
    const lines = [
      `You are ${agent.name}, a ${agent.role} agent in this organization.`,
      'You have been assigned a task. Do it now and respond with the completed work',
      'itself — the answer, the draft, the analysis, the plan — not a description of',
      'how you would do it. Be direct and useful.',
    ]
    if (charter && charter.trim().length > 0) {
      lines.push('', `Your squad's charter (its mandate and culture):`, charter.trim())
    }
    return lines.join('\n')
  }

  // The user turn: the task itself. Prose answer, not the cortex JSON schema.
  private buildExecutePrompt(task: Task): string {
    const lines = [
      `Task: ${task.title}`,
      task.body ? `Details:\n${task.body}` : 'Details: (none provided)',
    ]
    return lines.join('\n\n')
  }

  // Run the model for execute mode: system (identity + charter) then the task.
  // Routed through ModelPort so the org's provider/model choice + the gateway
  // key-brokering all apply.
  private async executeModelCall(model: string, system: string, taskPrompt: string): Promise<string> {
    const messages: ModelMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: taskPrompt },
    ]
    const out = await createModel(this.env).chat(messages, { model, maxTokens: EXECUTE_MAX_TOKENS })
    return typeof out === 'string' ? out : ''
  }

  private capResult(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text
    return `${text.slice(0, MAX_RESULT_CHARS - 1)}…`
  }

  private async emitExecution(
    type: 'task.completed' | 'task.blocked',
    agent: Agent,
    task: Task,
    status: Task['status'],
  ): Promise<void> {
    const event: BusEvent<{ task_id: string; agent_id: string; status: Task['status']; title: string }> = {
      type,
      tenant: this.env.TENANT_SLUG,
      squad_id: task.squad_id,
      agent_id: agent.id,
      actor: { kind: 'agent', id: agent.id },
      payload: { task_id: task.id, agent_id: agent.id, status, title: task.title },
      ts: new Date().toISOString(),
    }
    try {
      await createBus(this.env).emit(event)
    } catch {
      // bus emit is observability for the execution; a failed emit must not undo
      // the persisted result. Swallow (the row is the source of truth).
    }
  }

  private async rememberExecution(agentId: string, task: Task, status: Task['status']): Promise<void> {
    try {
      const memory = createMemory(this.env)
      await memory.remember(agentId, `Executed task "${task.title}" → ${status}.`, ['task', 'execution'])
    } catch {
      // best-effort
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
          '{"summary": string, "tasks": [{"title": string, "body": string}]}. ' +
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
            .filter((t): t is { title: string; body?: string } => typeof t === 'object' && t !== null && typeof (t as { title?: unknown }).title === 'string')
            .map((t) => ({ title: String(t.title).slice(0, 200), body: typeof t.body === 'string' ? t.body.slice(0, 4000) : '' }))
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
  private async loadAgent(): Promise<Agent | null> {
    const id = this.ctx.id.toString()
    const row = await this.env.DB.prepare(
      `SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE id = ?`,
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
      agent_id: this.ctx.id.toString(),
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
