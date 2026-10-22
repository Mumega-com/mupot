// mupot — ProjectOffice: one Agents-SDK Durable Object per project (the "project back office",
// docs/plan-project-back-office-20261022).
//
// STATUS: Phase 0 skeleton. INERT.
//   - Gated by env.PROJECT_OFFICE (default off) AND the PROJECT_OFFICE_DO binding.
//   - Nothing in the request path, no cron and no workflow calls getProjectOffice(); the only
//     caller is the test suite. With the flag off, every entry point here refuses.
//   - The seven functions are empty stubs. Their shape is fixed (office-contract.ts), their
//     behaviour is Phase 1.
//
// The office holds a WORKING SET, never authority: D1 is the authority (identity, grants,
// assignments, verdicts, receipts). The office's SQLite is a projection plus source cursors and
// dedup, and must be reconstructible — see rebuildWorkingSet and the destroy-and-rebuild test.
//
// Keyed `<tenant>:<project id>` (projectOfficeName). On every wake, and again before every
// function once the verification is older than VERIFY_TTL_MS, the project → tenant link is
// re-read from D1; a project that was archived or removed stops being served.
//
// Not used on purpose: setState()/state sync. "Sync only what each viewer may see" — the SDK's
// state broadcast is indiscriminate, so the office never calls it and refuses WebSocket clients.

import { Agent, getAgentByName, type Connection } from 'agents'
import type { Env } from '../types'
import type { Notice } from './office-contract'
import {
  ensureOfficeSchema,
  isProjectOfficeEnabled,
  projectOfficeName,
  rebuildWorkingSet,
  verifyOfficeBinding,
  type OfficeBinding,
  type OfficeFunction,
  type OfficeSql,
  type OfficeStubResult,
  type RebuildResult,
} from './office-core'

/** A verified binding is trusted for this long, then re-read from D1 before the next function. */
export const VERIFY_TTL_MS = 30_000

/** WebSocket policy-violation close code. The office serves no client sockets in Phase 0. */
const WS_POLICY_VIOLATION = 1008

export class ProjectOffice extends Agent<Env> {
  private binding: OfficeBinding = { ok: false, reason: 'flag_off' }
  private verifiedAtMs = 0

  private officeSql(): OfficeSql {
    const storage = this.ctx.storage.sql
    return {
      exec: (query, ...binds) => {
        storage.exec(query, ...binds)
      },
      all: (query, ...binds) => storage.exec(query, ...binds).toArray(),
    }
  }

  private async verify(): Promise<OfficeBinding> {
    let next: OfficeBinding
    try {
      next = await verifyOfficeBinding(this.env, this.name)
    } catch (err) {
      // D1 unreadable (or an id with no name): fail closed, keep serving nothing.
      console.error('project_office_verify_failed', err instanceof Error ? err.message : 'unknown')
      next = { ok: false, reason: 'verify_unavailable' }
    }
    this.binding = next
    this.verifiedAtMs = Date.now()
    return next
  }

  /** Every function goes through here: a stale or failed binding is re-verified, never trusted. */
  private async requireBinding(): Promise<Extract<OfficeBinding, { ok: true }> | Extract<OfficeStubResult, { error: 'unbound' }>> {
    const fresh = this.binding.ok && Date.now() - this.verifiedAtMs < VERIFY_TTL_MS
    const b = fresh ? this.binding : await this.verify()
    if (b.ok) return b
    return { ok: false, error: 'unbound', reason: b.reason }
  }

  async onStart(): Promise<void> {
    // Verify on EVERY wake. When the flag is off this stops at the first line of verifyOfficeBinding
    // and touches neither D1 nor SQLite.
    const b = await this.verify()
    if (b.ok) ensureOfficeSchema(this.officeSql())
  }

  onRequest(): Response {
    if (!isProjectOfficeEnabled(this.env)) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json({ error: 'not_implemented' }, { status: 501 })
  }

  onConnect(connection: Connection): void {
    connection.close(WS_POLICY_VIOLATION, 'project_office_serves_no_sockets')
  }

  // ── the seven functions: empty stubs (Phase 0) ─────────────────────────────

  private async stub(fn: OfficeFunction): Promise<OfficeStubResult> {
    const b = await this.requireBinding()
    if (!b.ok) return b
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

  // ── supervisor clock (alarms) ─────────────────────────────────────────────

  /**
   * Arm the follow-up clock. Called by nothing in Phase 0 except the spike test; the SDK's
   * scheduleEvery is idempotent per (callback, interval, payload), so re-arming on every wake
   * would not accumulate rows.
   */
  async armFollowUpClock(intervalSeconds: number): Promise<void> {
    const b = await this.requireBinding()
    if (!b.ok) return
    await this.scheduleEvery(intervalSeconds, 'followUpTick')
  }

  /** Alarm callback. Re-verifies, counts the tick, then hands off to the (stub) followUp. */
  async followUpTick(): Promise<void> {
    const b = await this.requireBinding()
    if (!b.ok) return
    const sql = this.officeSql()
    ensureOfficeSchema(sql)
    sql.exec(
      `INSERT INTO office_cursor (connection, cursor) VALUES ('__ticks', '1')
       ON CONFLICT(connection) DO UPDATE SET cursor = CAST(CAST(cursor AS INTEGER) + 1 AS TEXT)`,
    )
    await this.followUp()
  }

  // ── rebuild ───────────────────────────────────────────────────────────────

  /** Re-read the D1-derived working set. Safe to call any time; replaces, never merges. */
  async rebuild(): Promise<RebuildResult | { ok: false; error: 'unbound'; reason: string }> {
    const b = await this.requireBinding()
    if (!b.ok) return b
    return rebuildWorkingSet(this.env, this.officeSql(), b, new Date().toISOString())
  }

  /** Read-only snapshot of the working set, for tests and the future report function. */
  async snapshot(): Promise<{ project: Record<string, unknown>[]; tasks: Record<string, unknown>[] } | { ok: false; error: 'unbound'; reason: string }> {
    const b = await this.requireBinding()
    if (!b.ok) return b
    const sql = this.officeSql()
    ensureOfficeSchema(sql)
    return {
      project: sql.all('SELECT project_id, name, status, goal FROM office_project_view'),
      tasks: sql.all('SELECT task_id, status, assignee_agent_id, gate_owner FROM office_tasks ORDER BY task_id'),
    }
  }
}

/**
 * The RPC surface of an office, spelled out. `DurableObjectStub<ProjectOffice>` makes tsc give up
 * (TS2589, "excessively deep"): workerd's Rpc.Stub mapped type recurses through the Agents SDK
 * Agent base class, which has hundreds of members. Callers get this narrow interface instead,
 * which is also the surface they are allowed to use.
 */
export interface ProjectOfficeHandle {
  notice(notice: Notice): Promise<OfficeStubResult>
  prepare(): Promise<OfficeStubResult>
  dispatch(): Promise<OfficeStubResult>
  followUp(): Promise<OfficeStubResult>
  gate(): Promise<OfficeStubResult>
  remember(): Promise<OfficeStubResult>
  report(): Promise<OfficeStubResult>
  rebuild(): Promise<RebuildResult | { ok: false; error: 'unbound'; reason: string }>
}

/**
 * The ONE way to reach an office. Returns null unless PROJECT_OFFICE=1 and the namespace is
 * bound, so a caller that forgot to check the flag still cannot wake one.
 */
export async function getProjectOffice(env: Env, projectId: string): Promise<ProjectOfficeHandle | null> {
  const ns = env.PROJECT_OFFICE_DO
  if (!isProjectOfficeEnabled(env) || ns === undefined) return null
  // Both casts exist for the TS2589 described on ProjectOfficeHandle: instantiating the SDK's generics
  // with the concrete ProjectOffice class is what tsc cannot finish, so the namespace is passed as the base
  // Agent and the stub is narrowed to the handle. Runtime values are untouched.
  const stub = await getAgentByName<Env, Agent<Env>>(ns as unknown as DurableObjectNamespace<Agent<Env>>, projectOfficeName(env.TENANT_SLUG, projectId))
  return stub as unknown as ProjectOfficeHandle
}
