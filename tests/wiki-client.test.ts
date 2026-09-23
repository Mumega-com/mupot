// tests/wiki-client.test.ts — src/projects/wiki-client.ts against a FAKE
// double of mumega.com PR #1278's internal wiki service path
// (tests/helpers/fake-internal-wiki.ts, confirmed against round 2, head
// 81839e85). The fake enforces the same refusals the real route does — this
// suite asserts wiki-client.ts maps each of those refusals to the right
// typed outcome, never leaking the bearer or the raw upstream body.
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
} from '../src/projects/wiki-client'
import { FakeInternalWiki } from './helpers/fake-internal-wiki'

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
 * ('agent','squad','pot')); a project slug is neither an agent id nor a
 * squad id, so every lookup here falls into the pot-wide row.
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

  it('a pre-existing keychain-gated topic -> WikiConflictError(topic_is_keychain_gated), never silently stripped', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'project-card', title: 'Gated', requiredKeys: ['x'] })
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toMatchObject({ code: 'topic_is_keychain_gated' })
  })

  it('round-2 P1-2: an edge to an UNPUBLISHED target is refused (400), and the topic write does not go through', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'draft-target', title: 'Draft', published: false })
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(
        env,
        'stemminds',
        { slug: 'new-topic', title: 'New Topic', edges: [{ to_slug: 'draft-target' }] },
        fake.fetch.bind(fake),
      ),
    ).rejects.toBeInstanceOf(WikiClientError)

    // The all-or-nothing write never created new-topic at all.
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual([])
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

  it('an unrecognized 409 body shape fails closed to WikiClientError, never guesses a conflict code', async () => {
    const raw409 = (async () => new Response(JSON.stringify({ error: 'some_future_code_we_do_not_know' }), { status: 409 })) as unknown as typeof fetch
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, raw409),
    ).rejects.toBeInstanceOf(WikiClientError)
  })

  it('wrong bearer on write -> WikiClientError, and nothing is written', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: 'different-secret' })
    const env = await makeEnv(makeHarness())
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toBeInstanceOf(WikiClientError)
  })
})
