// GET / (and any dashboard GET) for a signed-in principal with zero capability
// — mupot#1436 A4.
//
// The capability-floor gate (src/dashboard/index.ts, FLIGHT-001 F2) already
// content-negotiates: an HTML-navigating browser gets a rendered deny page,
// a JSON caller gets a stable {error:'forbidden', need:'capability'} 403. A4
// only changes the HTML copy — it must name the signed-in identity and point
// at a concrete remedy (an admin-issued invite link) — and must NOT touch the
// JSON branch at all.
//
// Schema via createSqliteD1 + applyAllMigrations — no hand-written CREATE TABLE.

import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const ZERO_CAP_EMAIL = 'nobody@pot.test'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

function envFor(harness: SqliteD1Harness, sessions: Record<string, string>): Env {
  const store = new Map<string, string>(Object.entries(sessions))
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function sessionRecord(email: string): string {
  return JSON.stringify({ userId: `u-${email}`, email, role: 'member', createdAt: '2026-01-01T00:00:00Z' })
}

function dashboardGet(path: string, sessionId: string, headers: Record<string, string> = {}) {
  const hdrs = new Headers(headers)
  hdrs.set('Cookie', `mupot_session=${sessionId}`)
  return new Request(`${ORIGIN}${path}`, { headers: hdrs })
}

describe('dashboard capability-floor deny page (mupot#1436 A4)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('HTML: names the signed-in email and points at an invite link, not the old copy', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord(ZERO_CAP_EMAIL) })

    const res = await dashboardApp.fetch(dashboardGet('/', 's-zero'), env)

    expect(res.status).toBe(403)
    const body = await res.text()
    const normalized = body.replace(/\s+/g, ' ')
    expect(normalized).toContain(`Signed in as <strong>${ZERO_CAP_EMAIL}</strong>`)
    expect(normalized).toContain('No access in this org yet. Ask an admin for an invite link.')
    // The old copy must be gone, not just superseded — a stale message left in
    // place would confuse whichever branch renders first.
    expect(normalized).not.toContain("doesn't hold any capability grant")
    expect(normalized).not.toContain('ask an admin to add you to a squad')
  })

  it('JSON (?format=json): unchanged stable shape, no copy change leaks into it', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord(ZERO_CAP_EMAIL) })

    const res = await dashboardApp.fetch(dashboardGet('/?format=json', 's-zero'), env)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', need: 'capability' })
  })

  it('JSON (Accept: application/json): unchanged stable shape', async () => {
    harness = makeHarness()
    const env = envFor(harness, { 'sess:s-zero': sessionRecord(ZERO_CAP_EMAIL) })

    const res = await dashboardApp.fetch(
      dashboardGet('/', 's-zero', { Accept: 'application/json' }),
      env,
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', need: 'capability' })
  })
})
