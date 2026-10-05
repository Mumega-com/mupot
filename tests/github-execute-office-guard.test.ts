// mupot#1660 — executeTaskAsPR's final UPDATE must carry the office-publish
// invariant + a status precondition in its own WHERE (real D1 via the sqlite
// harness, so the SQL is actually executed, not shape-matched).

import { beforeEach, describe, expect, it } from 'vitest'
import { executeTaskAsPR } from '../src/integrations/github-execute'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'office', 'Office');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 'site-operator', 'Site Operator');
  `)
})

function seed(status: string, gateOwner: string | null, claimed: boolean) {
  harness.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner)
    VALUES ('T1', 's1', 'Publish', 'b', '${status}', 'live', ${gateOwner ? `'${gateOwner}'` : 'NULL'});
  `)
  if (claimed) {
    harness.sqlite.exec(`
      INSERT INTO office_publish_freezes (task_id, payload_json, payload_sha256, installation_id, connector_id, site_origin, frozen_by, frozen_at, claimed_at)
      VALUES ('T1', '{}', 'deadbeef', 'i', 'c', 'https://wp.example.com', 'fx', datetime('now'), datetime('now'));
    `)
  }
}

function env(): Env {
  return { TENANT_SLUG: 't', DB: harness.db, GITHUB_TOKEN: 'ghp_x', GITHUB_PLAN_TIER: 'free' } as unknown as Env
}

function happyFetch() {
  let calls = 0
  const impl = (async (url: string, init?: RequestInit) => {
    calls++
    const u = String(url)
    if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'SHA' } }), { status: 200 })
    if (u.endsWith('/git/refs')) return new Response('{}', { status: 201 })
    if (u.includes('/contents/') && init?.method === undefined) return new Response('{}', { status: 404 })
    if (u.includes('/contents/')) return new Response(JSON.stringify({ commit: { html_url: 'https://x/c' } }), { status: 201 })
    if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: 7, html_url: 'https://x/pull/7' }), { status: 201 })
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  return { impl, count: () => calls }
}

const params = { taskId: 'T1', repo: 'o/r', branchName: 'f/t1', files: [{ path: 'a.ts', content: 'a' }], title: 'T' }
const row = () => harness.sqlite.prepare(`SELECT status, github_issue_url FROM tasks WHERE id='T1'`).get() as { status: string; github_issue_url: string | null }

describe('executeTaskAsPR office/status guard (#1660)', () => {
  it('open task still moves to review with the PR url', async () => {
    seed('open', null, false)
    const { impl } = happyFetch()
    const res = await executeTaskAsPR(env(), params, { fetchImpl: impl })
    expect(res.ok).toBe(true)
    expect(row()).toEqual({ status: 'review', github_issue_url: 'https://x/pull/7' })
  })

  it('approved gate:office task with an unresolved publish claim is refused before any GitHub call, row unchanged', async () => {
    seed('approved', 'gate:office', true)
    const f = happyFetch()
    const res = await executeTaskAsPR(env(), params, { fetchImpl: f.impl })
    expect(res).toEqual({ ok: false, error: 'office_publish_unresolved', stage: 'task' })
    expect(f.count()).toBe(0)
    expect(row()).toEqual({ status: 'approved', github_issue_url: null })
  })

  it('approved task (no claim) is refused as invalid_transition', async () => {
    seed('approved', null, false)
    const res = await executeTaskAsPR(env(), params, { fetchImpl: happyFetch().impl })
    expect(res).toEqual({ ok: false, error: 'invalid_transition', stage: 'task' })
    expect(row().status).toBe('approved')
  })

  it('writer WHERE holds when the claim lands AFTER the early check (race): refuses, row unchanged', async () => {
    seed('in_progress', 'gate:office', false)
    const f = happyFetch()
    // Inject the claim between the early read and the final UPDATE (at the PR call).
    const racing = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/pulls')) {
        harness.sqlite.exec(`
          INSERT INTO office_publish_freezes (task_id, payload_json, payload_sha256, installation_id, connector_id, site_origin, frozen_by, frozen_at, claimed_at)
          VALUES ('T1', '{}', 'deadbeef', 'i', 'c', 'https://wp.example.com', 'fx', datetime('now'), datetime('now'));
        `)
      }
      return f.impl(url, init)
    }) as unknown as typeof fetch
    const res = await executeTaskAsPR(env(), params, { fetchImpl: racing })
    expect(res).toEqual({ ok: false, error: 'office_publish_unresolved', stage: 'task' })
    expect(row()).toEqual({ status: 'in_progress', github_issue_url: null })
  })
})
