import { describe, expect, it, beforeEach } from 'vitest'
import { mirrorApp } from '../src/addons/mirror'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega.com',
    MIRROR_SECRET: 'test-mirror-secret-123',
  } as Env
})

describe('Mirror Persistent Agent Memory REST API Suite (B-001)', () => {
  const authHeaders = {
    'Content-Type': 'application/json',
    'X-Mirror-Secret': 'test-mirror-secret-123',
  }

  it('1) POST /memory/store creates a new memory engram', async () => {
    const res = await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          agent_id: 'river',
          text: 'Master Constitution v6 ratified with 3 council signatures',
          concepts: ['constitution', 'ratification'],
        }),
      },
      env
    )

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.entry.agent_id).toBe('river')
  })

  it('2) POST /memory/search returns matching engrams', async () => {
    await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          agent_id: 'river',
          text: 'Master Constitution v6 ratified with 3 council signatures',
          concepts: ['constitution', 'ratification'],
        }),
      },
      env
    )

    const res = await mirrorApp.request(
      '/memory/search',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          query: 'Constitution',
          agent_id: 'river',
        }),
      },
      env
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.results.length).toBeGreaterThan(0)
  })

  it('3) GET /memory/:id returns a specific memory engram', async () => {
    const storeRes = await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          agent_id: 'river',
          text: 'Sample engram for GET by ID',
          concepts: ['sample'],
        }),
      },
      env
    )

    const storeJson = await storeRes.json()
    const entryId = storeJson.entry.id

    const res = await mirrorApp.request(`/memory/${entryId}`, { headers: authHeaders }, env)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.entry.id).toBe(entryId)
  })

  it('4) POST /memory/forget removes a memory engram', async () => {
    const storeRes = await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          agent_id: 'river',
          text: 'Sample engram for forget',
        }),
      },
      env
    )

    const storeJson = await storeRes.json()
    const entryId = storeJson.entry.id

    const forgetRes = await mirrorApp.request(
      '/memory/forget',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ id: entryId, agent_id: 'river' }),
      },
      env
    )

    expect(forgetRes.status).toBe(200)

    const getRes = await mirrorApp.request(`/memory/${entryId}`, { headers: authHeaders }, env)
    expect(getRes.status).toBe(404)
  })

  it('5) GET /memory lists engrams for an agent', async () => {
    const res = await mirrorApp.request('/memory?agent_id=river', { headers: authHeaders }, env)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
  })
})
