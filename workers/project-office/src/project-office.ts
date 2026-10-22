// mupot — ProjectOffice: one Durable Object per project (the "project back office",
// docs/plan-project-back-office-20261022), built on the Cloudflare Agents SDK, in its OWN Worker.
//
// STATUS: Phase 0 skeleton. INERT.
//   - Gated by env.PROJECT_OFFICE (default off) AND the PROJECT_OFFICE_DO binding.
//   - Nothing in the main Worker's request path, no cron and no workflow calls an office; the only caller
//     is the test suite. With the flag off, every entry point refuses.
//   - The seven functions are empty stubs. Their shape is fixed (office-contract.ts), their behaviour is Phase 1.
//
// SHAPE: a FACADE over an SDK Agent.
//   The exported class `ProjectOffice` is a plain Durable Object whose public methods are exactly the office's
//   own. The SDK `Agent` (OfficeAgent below) is a private field, constructed only AFTER the project -> tenant
//   check passes. Why:
//     - Workers RPC exposes every public method of a Durable Object's prototype chain. An exported `Agent`
//       subclass would expose `schedule`, `setState`, `sql`, `destroy`, `_cf_*` and the rest of the SDK
//       surface to anyone holding a stub, ahead of any guard of ours. The facade has none of them.
//     - The Agent constructor runs DDL (its own cf_agents_* tables) on every wake. Built lazily, an object
//       named for a foreign tenant or an unknown project creates no tables at all.
//
// The office holds a WORKING SET, never authority: D1 is the authority (identity, grants, assignments,
// verdicts, receipts). The office's SQLite is a projection plus source cursors and dedup, and must be
// reconstructible - see rebuildWorkingSet and the destroy-and-rebuild test.
//
// Keyed `<tenant>:<project id>`. The name verified is `ctx.id.name` (the platform's), never `Agent#name`,
// which the SDK can derive from a request header. On every wake, and again before every function once the
// verification is older than VERIFY_TTL_MS, the project -> tenant link is re-read from D1; a project that was
// archived or removed stops being served and its recurring clock is cancelled.
//
// Not used on purpose: setState()/state sync, identity frames, MCP frames, sub-agents, client sockets.
// "Sync only what each viewer may see" - the SDK's broadcast is indiscriminate, so none of it is reachable.

import { DurableObject } from 'cloudflare:workers'
import { Agent, type Connection } from 'agents'
import {
  ensureOfficeSchema,
  isPermanentBindingFailure,
  rebuildWorkingSet,
  verifyOfficeBinding,
  type OfficeBinding,
  type OfficeEnv,
  type OfficeFunction,
  type OfficeSql,
  type OfficeStubResult,
  type RebuildResult,
} from '../../../src/projects/office-core'
import type { Notice } from '../../../src/projects/office-contract'

/** A verified binding is trusted for this long, then re-read from D1 before the next function. */
export const VERIFY_TTL_MS = 30_000

/** WebSocket policy-violation close code. The office serves no client sockets in Phase 0. */
const WS_POLICY_VIOLATION = 1008

/** Callback name of the recurring supervisor clock. */
const TICK_CALLBACK = 'followUpTick'

type Unbound = Extract<OfficeStubResult, { error: 'unbound' }>

function unbound(b: Extract<OfficeBinding, { ok: false }>): Unbound {
  return { ok: false, error: 'unbound', reason: b.reason }
}

/**
 * The SDK half. Private to this module and never exported, so no stub can name it. Every entry from outside
 * goes through ProjectOffice, which has already verified the binding.
 */
class OfficeAgent extends Agent<OfficeEnv> {
  // No identity frame on connect: it would leak the instance name to a connecting client.
  static override options = { sendIdentityOnConnect: false }

  /** Set by the facade: re-verifies the binding (cached for VERIFY_TTL_MS). Closed until then. */
  gate: () => Promise<OfficeBinding> = async () => ({ ok: false, reason: 'flag_off' })

  officeSql(): OfficeSql {
    const storage = this.ctx.storage.sql
    return {
      exec: (query, ...binds) => {
        storage.exec(query, ...binds)
      },
      all: (query, ...binds) => storage.exec(query, ...binds).toArray(),
    }
  }

  override async onStart(): Promise<void> {
    ensureOfficeSchema(this.officeSql())
  }

  // The SDK's own client-facing surface, shut: no protocol frames (identity / state / MCP), read-only, no sockets.
  override shouldSendProtocolMessages(): boolean {
    return false
  }
  override shouldConnectionBeReadonly(): boolean {
    return true
  }
  override onConnect(connection: Connection): void {
    connection.close(WS_POLICY_VIOLATION, 'project_office_serves_no_sockets')
  }
  // `/sub/<class>/<name>` routing to child agents: there are none, and none may be reached.
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response('not found', { status: 404 })
  }
  override onRequest(): Response {
    return Response.json({ error: 'not_implemented' }, { status: 501 })
  }

  /** An office is always top-level. A non-empty parent path means the object is a facet of something else. */
  isTopLevel(): boolean {
    return this.parentPath.length === 0
  }

  async armFollowUpClock(intervalSeconds: number): Promise<void> {
    await this.scheduleEvery(intervalSeconds, TICK_CALLBACK)
  }

  /** Cancel every recurring clock this office armed. Idempotent. */
  async cancelClocks(): Promise<number> {
    const clocks = await this.listSchedules({ type: 'interval' })
    let cancelled = 0
    for (const s of clocks) if (s.callback === TICK_CALLBACK && (await this.cancelSchedule(s.id))) cancelled++
    return cancelled
  }

  /** Alarm callback (invoked by name by the SDK). Re-verifies itself: it does not trust the path that woke it. */
  async followUpTick(): Promise<void> {
    const b = await this.gate()
    if (!b.ok) {
      // Unbound for good (project archived, flag off, ...): stop the clock, or it recurs forever against D1.
      if (isPermanentBindingFailure(b.reason)) await this.cancelClocks()
      return
    }
    const sql = this.officeSql()
    sql.exec(
      `INSERT INTO office_meta (key, value) VALUES ('ticks', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    )
    // followUp is a stub in Phase 0: nothing to do after the tick is counted.
  }

  async rebuild(binding: Extract<OfficeBinding, { ok: true }>): Promise<RebuildResult> {
    return rebuildWorkingSet(this.env, this.officeSql(), binding, new Date().toISOString())
  }

  snapshot(): { project: Record<string, unknown>[]; tasks: Record<string, unknown>[] } {
    const sql = this.officeSql()
    return {
      project: sql.all('SELECT project_id, name, status, goal FROM office_project_view'),
      tasks: sql.all(
        'SELECT task_id, status, assignee_agent_id, assignee_member_id, gate_owner FROM office_tasks ORDER BY task_id',
      ),
    }
  }
}

export class ProjectOffice extends DurableObject<OfficeEnv> {
  private binding: OfficeBinding = { ok: false, reason: 'flag_off' }
  private verifiedAtMs = 0
  private officeAgent: OfficeAgent | null = null

  /** Verify against the platform's name for this object, never a header-derived one. */
  private async verify(): Promise<OfficeBinding> {
    const next = await verifyOfficeBinding(this.env, this.ctx.id.name)
    this.binding = next
    this.verifiedAtMs = Date.now()
    return next
  }

  /** Every entry goes through here: a stale or failed binding is re-verified, never trusted. */
  private async requireBinding(): Promise<OfficeBinding> {
    const fresh = this.binding.ok && Date.now() - this.verifiedAtMs < VERIFY_TTL_MS
    return fresh ? this.binding : this.verify()
  }

  /** Build (once) and start the SDK half. Callers have already passed requireBinding, or are cleaning up. */
  private async agent(): Promise<OfficeAgent> {
    if (this.officeAgent === null) {
      const a = new OfficeAgent(this.ctx, this.env)
      a.gate = () => this.requireBinding()
      this.officeAgent = a
    }
    await this.officeAgent.__unsafe_ensureInitialized()
    return this.officeAgent
  }

  /** Verified agent, or the refusal. Also refuses a sub-agent object. */
  private async openAgent(): Promise<{ agent: OfficeAgent; binding: Extract<OfficeBinding, { ok: true }> } | Unbound> {
    const b = await this.requireBinding()
    if (!b.ok) return unbound(b)
    const agent = await this.agent()
    if (!agent.isTopLevel()) return unbound({ ok: false, reason: 'sub_agent' })
    return { agent, binding: b }
  }

  // ── the seven functions: empty stubs (Phase 0) ─────────────────────────────

  private async stub(fn: OfficeFunction): Promise<OfficeStubResult> {
    const b = await this.requireBinding()
    if (!b.ok) return unbound(b)
    return { ok: false, error: 'not_implemented', fn }
  }

  /** 1. notice: ingest a normalized Notice from an adapter. */
  async notice(_notice: Notice): Promise<OfficeStubResult> {
    return this.stub('notice')
  }

  /** 2. prepare: write the source-linked brief for an item. */
  async prepare(): Promise<OfficeStubResult> {
    return this.stub('prepare')
  }

  /** 3. dispatch and wake: ring the doorbell for an assignment that D1 already holds. */
  async dispatch(): Promise<OfficeStubResult> {
    return this.stub('dispatch')
  }

  /** 4. follow up and route stuck work by kind. */
  async followUp(): Promise<OfficeStubResult> {
    return this.stub('followUp')
  }

  /** 5. gate: bind review evidence to the exact submitted version. */
  async gate(): Promise<OfficeStubResult> {
    return this.stub('gate')
  }

  /** 6. remember: write approved pages to project memory. */
  async remember(): Promise<OfficeStubResult> {
    return this.stub('remember')
  }

  /** 7. report: the daily note. */
  async report(): Promise<OfficeStubResult> {
    return this.stub('report')
  }

  // ── supervisor clock, rebuild, read-only view ──────────────────────────────

  /** Arm the follow-up clock. Called by nothing in Phase 0 except the tests. Idempotent in the SDK. */
  async armFollowUpClock(intervalSeconds: number): Promise<Unbound | { ok: true }> {
    const o = await this.openAgent()
    if ('error' in o) return o
    await o.agent.armFollowUpClock(intervalSeconds)
    return { ok: true }
  }

  /** Re-read the D1-derived working set. Safe any time; replaces, never merges. */
  async rebuild(): Promise<RebuildResult | Unbound> {
    const o = await this.openAgent()
    if ('error' in o) return o
    return o.agent.rebuild(o.binding)
  }

  /** Read-only snapshot of the working set, for tests and the future report function. */
  async snapshot(): Promise<ReturnType<OfficeAgent['snapshot']> | Unbound> {
    const o = await this.openAgent()
    if ('error' in o) return o
    return o.agent.snapshot()
  }

  // ── platform handlers (not callable over RPC) ──────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const b = await this.requireBinding()
    // Refused (flag off, wrong tenant, unknown or archived project): no SDK, no tables, no detail.
    if (!b.ok) return Response.json({ error: 'not_found' }, { status: 404 })
    const o = await this.openAgent()
    if ('error' in o) return Response.json({ error: 'not_found' }, { status: 404 })
    return o.agent.fetch(request)
  }

  async alarm(): Promise<void> {
    const b = await this.requireBinding()
    // An alarm exists only on an office that was once valid, so its SDK tables exist. If it is no longer valid
    // for good, cancel its clock instead of running it; if D1 is merely unreachable, run and let the tick no-op.
    const agent = await this.agent()
    if (!b.ok && isPermanentBindingFailure(b.reason)) {
      await agent.cancelClocks()
      return
    }
    await agent.alarm()
  }

  // Hibernating-WebSocket handlers. The office closes every client on connect, so these only ever see the close.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.forwardSocketEvent('webSocketMessage', ws, message)
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.forwardSocketEvent('webSocketClose', ws, code, reason, wasClean)
  }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.forwardSocketEvent('webSocketError', ws, error)
  }

  private async forwardSocketEvent(handler: string, ...args: unknown[]): Promise<void> {
    const b = await this.requireBinding()
    if (!b.ok) return
    const agent = await this.agent()
    // The SDK defines these handlers on the Agent at runtime without declaring them in its public types.
    const fn = (agent as unknown as Record<string, unknown>)[handler]
    if (typeof fn === 'function') await (fn as (...a: unknown[]) => Promise<void>).apply(agent, args)
  }
}
