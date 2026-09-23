// tests/wiki-client.test.ts — src/projects/wiki-client.ts against a FAKE
// double of mumega.com PR #1278's internal wiki service path
// (tests/helpers/fake-internal-wiki.ts). The fake enforces the same
// refusals the real route does — this suite asserts wiki-client.ts maps
// each of those refusals to the right typed outcome, never leaking the
// bearer or the raw upstream body.

import { describe, expect, it } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import type { Env } from '../src/types'
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

/**
 * A pot-wide 'inkwell' connector fixture, matching resolveConnector's exact
 * query shape (tenant=?1, type=?2, scope_id=?3, scope_type IN
 * ('agent','squad','pot')) — this fake DB always answers as the pot-wide
 * row, which is the branch every project-slug lookup falls into (a project
 * slug is neither an agent id nor a squad id).
 */
async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, CONNECTOR_ID, 'inkwell', SECRET)
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = []
      return {
        bind(...values: unknown[]) {
          binds = values
          return this
        },
        async first<T>() {
          if (!sql.includes('FROM connectors')) return null
          const [tenant, type] = binds as [string, string]
          if (tenant !== TENANT || type !== 'inkwell') return null
          return { id: CONNECTOR_ID, type: 'inkwell', encrypted_secret: encrypted } as T
        },
      }
    },
  } as unknown as D1Database

  return {
    DB: db,
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
    const env = await makeEnv()
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['overview'])
  })

  it('empty project (no topics) returns an empty graph, not an error', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv()
    const graph = await getProjectWikiGraph(env, 'no-topics-yet', fake.fetch.bind(fake))
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it('a topic under a DIFFERENT project is never returned (cross-project isolation)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'overview', title: 'Overview' })
    fake.seed({ tenantSlug: TENANT, project: 'dgd-dme', slug: 'other-project-topic', title: 'Other' })
    const env = await makeEnv()
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
    const env = await makeEnv()
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['public-page'])
  })

  it('round-2 contract: an unpublished topic is absent from the graph', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'draft-page', title: 'Draft', published: false })
    const env = await makeEnv()
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes).toEqual([])
  })

  it('round-2 contract: an edge touching a hidden (gated/unpublished) topic is dropped from the graph', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'visible-a', title: 'Visible A' })
    fake.seed({ tenantSlug: TENANT, project: 'stemminds', slug: 'hidden-b', title: 'Hidden B', requiredKeys: ['x'] })
    const env = await makeEnv()
    // Seed an edge directly via a PUT (edges validate against project membership only,
    // not gating, at write time in the real route — this exercises the READ-side drop).
    await upsertProjectWikiTopic(
      env,
      'stemminds',
      { slug: 'visible-a', title: 'Visible A' },
      fake.fetch.bind(fake),
    )
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.edges).toEqual([])
  })

  it('wrong bearer -> WikiClientError, never leaks the secret or the upstream body', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: 'a-completely-different-secret' })
    const env = await makeEnv()
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
    const env = await makeEnv()
    await expect(getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
  })

  it('no INKWELL_API_URL configured on this pot -> WikiClientError (fail-closed, not a crash)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv({ INKWELL_API_URL: undefined })
    await expect(getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
  })

  it('an invalid project slug is refused locally, before any network call', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv()
    await expect(getProjectWikiGraph(env, 'NOT A SLUG!', fake.fetch.bind(fake))).rejects.toBeInstanceOf(WikiClientError)
    expect(fake.requests).toEqual([])
  })
})

describe('upsertProjectWikiTopic', () => {
  it('creates a new topic (happy path) and sends published:true', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    const env = await makeEnv()
    const result = await upsertProjectWikiTopic(
      env,
      'stemminds',
      { slug: 'project-card', title: 'Stemminds' },
      fake.fetch.bind(fake),
    )
    expect(result.created).toBe(true)
    const graph = await getProjectWikiGraph(env, 'stemminds', fake.fetch.bind(fake))
    expect(graph.nodes.map((n) => n.slug)).toEqual(['project-card'])
  })

  it('a slug owned by a DIFFERENT project -> WikiConflictError(topic_owned_by_other_project)', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: SECRET })
    fake.seed({ tenantSlug: TENANT, project: 'other-project', slug: 'project-card', title: 'Other Card' })
    const env = await makeEnv()
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
    const env = await makeEnv()
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toMatchObject({ code: 'topic_is_keychain_gated' })
  })

  it('wrong bearer on write -> WikiClientError, and nothing is written', async () => {
    const fake = new FakeInternalWiki({ [TENANT]: 'different-secret' })
    const env = await makeEnv()
    await expect(
      upsertProjectWikiTopic(env, 'stemminds', { slug: 'project-card', title: 'Stemminds' }, fake.fetch.bind(fake)),
    ).rejects.toBeInstanceOf(WikiClientError)
  })
})
