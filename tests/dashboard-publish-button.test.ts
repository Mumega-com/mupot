// tests/dashboard-publish-button.test.ts — the flight-1 gap fix: a "Publish"
// control on /approvals for tasks that already cleared the gate (status='approved',
// gate_owner='gate:content') but had NO operator-facing way to fire the real write.
//
// What this proves, end to end through the real dashboardApp route (not a
// hand-rolled render call), matching the convention in
// tests/execute-route-closes-task.test.ts / tests/s4-live-wiring.test.ts:
//   1. The button renders on GET /approvals for an owner/admin when an approved
//      gate:content task exists.
//   2. It targets the EXISTING admin-gated POST /admin/departments/:dept/execute/:gateId
//      route (dept='growth', gateId=task id) — no new write path introduced.
//   3. It does NOT render for a non-admin caller, even when the same approved
//      task exists in the DB (loadPublishable's server-side admin gate, not a
//      client-side hide).
//   4. It does NOT render when there is nothing approved-and-content-gated to publish.

import { describe, it, expect, vi } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { CONTENT_GATE_OWNER, CONTENT_DEPARTMENT_KEY } from '../src/agents/execute'
import type { Env } from '../src/types'

const PUBLISHABLE_ROW = {
  id: 'task-content-42',
  squad_id: 'sq-1',
  squad_name: 'Growth',
  title: 'Why mupot ships receipts',
  body: 'Draft body of the approved post.',
  gate_owner: CONTENT_GATE_OWNER,
  assignee_agent_id: 'agent-1',
  agent_name: 'Scribe',
  result: null,
  completed_at: '2026-07-14T10:00:00.000Z',
  created_at: '2026-07-14T09:00:00.000Z',
}

function makeStmt(rows: unknown[]) {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    all: async () => ({ results: rows }),
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
  }
  return stmt
}

// Models: 'review' query (loadApprovals) → always empty; 'approved'+gate_owner
// query (loadPublishable) → the given rows (only reached at all when the caller
// is owner/admin — loadPublishable short-circuits before querying otherwise).
function envForRole(role: 'owner' | 'admin' | 'member', publishRows: unknown[]): Env {
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: {
      prepare: vi.fn((sql: string) =>
        sql.includes("t.status = 'approved'") ? makeStmt(publishRows) : makeStmt([]),
      ),
    },
    SESSIONS: {
      get: vi.fn(async () =>
        JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' }),
      ),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

function getApprovals(): Request {
  return new Request('https://pot.test/approvals', {
    method: 'GET',
    headers: { Cookie: 'mupot_session=s' },
  })
}

describe('GET /approvals — Publish control (flight-1 gap fix)', () => {
  it('owner: renders a Publish button for an approved gate:content task, targeting the existing execute route', async () => {
    const res = await dashboardApp.fetch(getApprovals(), envForRole('owner', [PUBLISHABLE_ROW]))
    expect(res.status).toBe(200)
    const htmlBody = await res.text()

    expect(htmlBody).toContain('Ready to publish')
    expect(htmlBody).toContain('appr-publish')
    expect(htmlBody).toContain(PUBLISHABLE_ROW.title)
    // No new write path: the button's script targets the EXISTING admin-gated
    // execute route, dept hardcoded to CONTENT_DEPARTMENT_KEY ('growth').
    expect(htmlBody).toContain(`/admin/departments/${CONTENT_DEPARTMENT_KEY}/execute/`)
    expect(CONTENT_DEPARTMENT_KEY).toBe('growth')
    // gateId is read at click-time from data-task, which is stamped with the task id.
    expect(htmlBody).toContain(`data-task="${PUBLISHABLE_ROW.id}"`)
  })

  it('admin: same as owner', async () => {
    const res = await dashboardApp.fetch(getApprovals(), envForRole('admin', [PUBLISHABLE_ROW]))
    const htmlBody = await res.text()
    expect(htmlBody).toContain('Ready to publish')
    expect(htmlBody).toContain('appr-publish')
  })

  it('member (non-admin): the Publish section is absent even though an approved task exists in the DB', async () => {
    const res = await dashboardApp.fetch(getApprovals(), envForRole('member', [PUBLISHABLE_ROW]))
    expect(res.status).toBe(200)
    const htmlBody = await res.text()
    expect(htmlBody).not.toContain('Ready to publish')
    expect(htmlBody).not.toContain('appr-publish')
    expect(htmlBody).not.toContain('/admin/departments/')
  })

  it('owner: no Publish section when nothing is approved+gate:content', async () => {
    const res = await dashboardApp.fetch(getApprovals(), envForRole('owner', []))
    const htmlBody = await res.text()
    expect(htmlBody).not.toContain('Ready to publish')
    expect(htmlBody).not.toContain('appr-publish')
  })
})
