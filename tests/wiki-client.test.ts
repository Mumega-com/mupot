// tests/wiki-client.test.ts — src/projects/wiki-client.ts against a FAKE
// double of mumega.com PR #1278's internal wiki service path
// (tests/helpers/fake-internal-wiki.ts, confirmed against round 2, head
// 81839e85, plus an announced successor contract — see
// SERVICE_WRITE_KEY/fake-internal-wiki.ts). The fake enforces the same
// refusals the real route does — this suite asserts wiki-client.ts maps
// each of those refusals to the right typed outcome, never leaking the
// bearer or the raw upstream body.
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() —
// this file imports production code (src/projects/wiki-client.ts), so per
// scripts/check-test-schema-source.mjs it must build its schema from the
// committed migration chain, never a hand-rolled D1-shaped mock.

import { describe, expect, it } from 'vitest'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  getProjectWikiGraph,
  upsertProjectWikiTopic,
  WikiClientError,
  WikiConflictError,
  WikiRequestError,
} from '../src/projects/wiki-client'
import { FakeInternalWiki, SERVICE_WRITE_KEY } from './helpers/fake-internal-wiki'

const MASTER_KEY = '22'.repeat(32)
const TENANT = 'mumega'
const CONNECTOR_ID = 'connector-inkwell-pot'
const SECRET = 'wiki-secret-abc123'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

/**
 * A pot-wide 'inkwell' connector row, seeded via a real INSERT against the
 * full migration chain's `connectors` table — matches resolveConnector's
 * exact query shape (tenant=?1, type=?2, scope_id=?3, scope_type IN
 * ('agent','squad','pot')). wiki-client.ts resolves this EXPLICITLY pot-wide
 * (resolveConnector(env, 'pot', 'inkwell') — see P3 in the file header), so
 * this row's scope_type='pot'/scope_id=NULL is matched unconditionally
 * regardless of what literal string the caller passes as scope_id.
 */
async function makeEnv(harness: SqliteD1Harness, overrides: Partial<Env> = {}): Promise<Env> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  harness.sqlite.exec(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES ('${CONNECTOR_ID}', '${TENANT}', 'inkwell', 'Inkwell wiki', '${encrypted}', NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  )
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    CONNECTOR_MASTER_KEY: MASTER_KEY,
    INKWELL_API_URL: 'https://inkwell-api.test',
    ...overrides,
  } as Env
}

describe('getProjectWikiGraph', () => {
  it('returns the project graph on the happy path', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'overview', title: 'Overview' })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['overview'])
  })

  it('empty project (no topics) returns an empty graph, not an error', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'no-topics-yet', fake.fetch.bind(fake))
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it('a topic under a DIFFERENT project is never returned (cross-project isolation)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'overview', title: 'Overview' })
    fake.seed({ tenantSlug: TENANT, project: 'dgd-dme', slug: 'other-project-topic', title: 'Other' })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['overview'])
  })

  it('round-2 contract: a keychain-gated topic is absent from the graph', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'public-page', title: 'Public' })
    fake.seed({
      tenantSlug: TENANT,
      project: 'stemminds',
      slug: 'gated-page',
      title: 'Gated',
      requiredKeys: ['founder-only'],
    })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['public-page'])
  })

  it('round-2 contract: an unpublished topic is absent from the graph', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'draft-page', title: 'Draft', published: false })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes).toEqual([])
  })

  it('round-2 contract: an edge to a keychain-gated (but published) topic is writable, then dropped from reads', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    // Edge-target gating is NOT checked at write time (only published is) —
    // so this edge write succeeds, exercising the READ-side drop, not a
    // write refusal.
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'hidden-b', title: 'Hidden B', requiredKeys: ['x'] })
    const env = await makeEnv(makeHarness())
    const result = await upsertProjectWikiTopic(
      env,
      'stemminds',
      { slug: 'visible-a', title: 'Visible A', edges: [{ to_slug: 'hidden-b' }] },
      fake.fetch.bind(fake),
    )
    expect(result.edges_upserted).toBe(1)

    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['visible-a']) // hidden-b itself absent
    expect(graph.edges).toEqual([]) // and the edge naming it is dropped too
  })

  it('P0: a service-written topic carries the reserved required_keys marker and stays visible via the service GET', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    await upsertProjectWikiTopic(env, 'stemminds', { slug: 'card', title: 'Card' }, fake.fetch.bind(fake))
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes).toHaveLength(1)
    // The reserved marker is what hides this topic from Inkwell's PUBLIC
    // reads (a real end-user's keychain never holds it) while the internal
    // service channel — this client — still sees it.
    expect(graph.nodes[0].required_keys).toEqual([SERVICE_WRITE_KEY])
  })

  it('P0: this client only ever calls /api/internal/wiki/* — never a public wiki.ts route', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    await upsertProjectWikiTopic(env, 'stemminds', { slug: 'card', title: 'Card' }, fake.fetch.bind(fake))
    await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(fake.requests.length).toBeGreaterThan(0)
    expect(fake.requests.every((r) => r.path.startsWith('/api/internal/wiki/'))).toBe(true)
  })

  it('wrong bearer -> WikiClientError, never leaks the secret or the upstream body', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: 'a-completely-different-secret' })
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiClientError)
    expect((caught as WikiClientError).reason).toBe('wiki_unavailable')
    expect((caught as Error).message).not.toContain(SECRET)
    expect((caught as Error).message).not.toContain('a-completely-different-secret')
  })

  it('missing tenant configuration (no secret at all for this tenant) -> WikiClientError, no crash', async () => {
    const fake = new FakeInternalWiki({}) // no tenant configured at all
    const env = await makeEnv(makeHarness())
    await expect(getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
  })

  it('a raw 403 (auth-adjacent) also collapses to WikiClientError, not WikiRequestError', async () => {
    const raw403 = (async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    await expect(getProjectWikiGraph(env, 'stemminds', raw403)).rejects.toBeInstanceOf(WikiClientError)
  })

  it('no INKWELL_API_URL configured on this pot -> WikiClientError (fail-closed, not a crash)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness(), { INKWELL_API_URL: undefined })
    await expect(getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
  })

  it('an invalid project slug is refused locally, before any network call', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    await expect(getProjectWikiGraph(env, 'NOT A SLUG!', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
    expect(fake.requests).toEqual([])
  })

  it("an uppercase-containing project id is lowercased before it is sent — Inkwell's project regex is lowercase-only", async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    // Seeded lowercase, as the real store always is (project ids are
    // crypto.randomUUID(), already lowercase). The fake does an EXACT,
    // case-sensitive match on `project` — so this only finds the seeded
    // topic if the client actually lowercased 'STEMMINDS' before sending;
    // an un-lowercased send would silently return zero nodes instead.
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'overview', title: 'Overview' })
    const env = await makeEnv(makeHarness())
    const graph = await getProjectWikiGraph(env, 'STEMMINDS', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['overview'])
    expect(graph.project).toBe('stemminds')
  })

  it('P2: the fake itself refuses a request missing tenant_slug entirely with 400, not 401', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const res = await fake.fetch(
      new Request('https://inkwell-api.test/api/internal/wiki/graph?project=stemminds', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'tenant_slug required' })
  })
})

describe('upsertProjectWikiTopic', () => {
  it('creates a new topic (happy path); the body sends no `published` field (round 2: no such field exists)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    const result = await upsertProjectWikiTopic(
      env,
      'stemminds',
      { slug: 'project-card', title: 'Stemminds' },
      fake.fetch.bind(fake),
    )
    expect(result.created).toBe(true)
    const putRequest = fake.requests.find((r) => r.method === 'PUT')
    expect(putRequest).toBeDefined()
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['project-card'])
  })

  it("an uppercase-containing project id is lowercased in the PUT body's `project` — Inkwell's regex is lowercase-only", async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    await upsertProjectWikiTopic(env, 'STEMMINDS', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake))
    // The fake matches `project` exactly and case-sensitively — the topic is
    // only found under the lowercase key if the client lowercased it.
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['project-card'])
  })

  it('idempotent update of a service-written topic succeeds — the service marker never trips topic_is_keychain_gated', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    const first = await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'V1' }, fake.fetch.bind(fake))
    expect(first.created).toBe(true)
    const second = await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'V2' }, fake.fetch.bind(fake))
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('a slug owned by a DIFFERENT project -> WikiConflictError(topic_owned_by_other_project)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'other-project', slug: 'project-card', title: 'Other Card' })
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiConflictError)
    expect((caught as WikiConflictError).code).toBe('topic_owned_by_other_project')
    expect((caught as WikiConflictError).existingProject).toBe('other-project')
  })

  it('a pre-existing REAL keychain-gated topic -> WikiConflictError(topic_is_keychain_gated), never silently stripped', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'project-card', title: 'Gated', requiredKeys: ['x'] })
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toMatchObject({ code: 'topic_is_keychain_gated' })
  })

  it('an edge to an UNPUBLISHED target is refused (400) -> WikiRequestError, and the topic write does not go through', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'draft-target', title: 'Draft', published: false })
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(
        env,
        'stemminds',
        { slug: 'new-topic', title: 'New Topic', edges: [{ to_slug: 'draft-target' }] },
        fake.fetch.bind(fake),
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiRequestError)
    expect((caught as WikiRequestError).status).toBe(400)
    expect((caught as WikiRequestError).code).toBe('edge_target_unpublished')

    // The all-or-nothing write never created new-topic at all.
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual([])
  })

  it('more than 50 edges in one write -> WikiRequestError(too_many_edges)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv(makeHarness())
    const edges = Array.from({ length: 51 }, (_, i) => ({ to_slug: `target-${i}` }))
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'many-edges', title: 'Many Edges', edges }, fake.fetch.bind(fake)),
    ).rejects.toBeInstanceOf(WikiRequestError)
  })

  it('round-2 P2-5: a raw 409 topic_write_conflict (TOCTOU race) maps to WikiConflictError with no existingProject', async () => {
    // This is a single-request concurrency outcome the synchronous
    // FakeInternalWiki cannot reproduce naturally — exercised directly with
    // a raw fetchImpl instead, asserting only wiki-client.ts's OWN mapping.
    const raw409 = (async () => new Response(JSON.stringify({ error: 'topic_write_conflict' }), { status: 409 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, raw409)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiConflictError)
    expect((caught as WikiConflictError).code).toBe('topic_write_conflict')
    expect((caught as WikiConflictError).existingProject).toBeUndefined()
  })

  it('ANY 409 is a typed conflict, even an unrecognized future code (error names have already been renamed once upstream)', async () => {
    const raw409 = (async () => new Response(JSON.stringify({ error: 'some_future_code_we_do_not_know' }), { status: 409 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, raw409)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiConflictError)
    expect((caught as WikiConflictError).code).toBe('some_future_code_we_do_not_know')
  })

  it('a 409 with a malformed/missing body still becomes a typed conflict, not WikiClientError', async () => {
    const raw409 = (async () => new Response('not json', { status: 409 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, raw409)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiConflictError)
    expect((caught as WikiConflictError).code).toBe('unknown_conflict')
  })

  it('ANY other 4xx is a typed WikiRequestError carrying whatever code the upstream returned', async () => {
    const raw400 = (async () => new Response(JSON.stringify({ error: 'some_new_validation_code' }), { status: 400 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    let caught: unknown
    try {
      await upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, raw400)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WikiRequestError)
    expect((caught as WikiRequestError).status).toBe(400)
    expect((caught as WikiRequestError).code).toBe('some_new_validation_code')
  })

  it('wrong bearer on write -> WikiClientError, and nothing is written', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: 'different-secret' })
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toBeInstanceOf(WikiClientError)
  })
})
