// ProjectOffice contract (src/projects/office-contract.ts) and the two fixture mappings:
// a GitHub pull_request.opened delivery and a Linear Issue update both land as the same Notice shape.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NOTICE_KINDS,
  buildNotice,
  canonicalNoticeString,
  isDoorbell,
  isStale,
  noticeHash,
  type Doorbell,
  type Notice,
  type NoticeFields,
} from '../src/projects/office-contract'
import { githubNotice, linearNotice, type NoticeSource } from '../src/projects/office-notice-map'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'office', name), 'utf8'))
}

const GH_SRC: NoticeSource = { tenant: 'pot-a', connection: 'gh-install-4242', eventId: '72d3162e-cc78-11e3-81ab-4c9367dc0958' }
const LIN_SRC: NoticeSource = { tenant: 'pot-a', connection: 'linear-conn-1', eventId: 'lin-delivery-0001' }

describe('GitHub pull_request.opened → Notice', () => {
  it('maps every field of the contract', async () => {
    const n = await githubNotice(GH_SRC, 'pull_request', fixture('github-pull-request-opened.json'))
    expect(n).not.toBeNull()
    expect(n).toMatchObject({
      tenant: 'pot-a',
      connection: 'gh-install-4242',
      provider: 'github',
      item_id: 'PR_kwDOExample2113',
      event_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      // a PR's version is its head sha: a new push is a new version
      version: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
      kind: 'pr',
      url: 'https://github.com/mumega/mupot/pull/2113',
      title: 'feat(office): ProjectOffice spike',
      actor: 'kasra-code',
      updated_at: '2026-10-22T08:15:30.000Z',
    })
    expect(n?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stamps the tenant from the receiving pot, never from the payload', async () => {
    const payload = { ...(fixture('github-pull-request-opened.json') as object), tenant: 'attacker-pot' }
    const n = await githubNotice(GH_SRC, 'pull_request', payload)
    expect(n?.tenant).toBe('pot-a')
  })

  it('carries no body text: a comment event keeps the thread title and drops the comment text', async () => {
    const n = await githubNotice(GH_SRC, 'issue_comment', {
      action: 'created',
      issue: { title: 'Thread title' },
      comment: { node_id: 'IC_1', html_url: 'https://github.com/o/r/issues/1#c1', body: 'SECRET BODY', updated_at: '2026-10-22T08:00:00Z' },
      sender: { login: 'someone' },
    })
    expect(n?.kind).toBe('comment')
    expect(n?.title).toBe('Thread title')
    expect(JSON.stringify(n)).not.toContain('SECRET BODY')
  })

  it.each([
    ['an event type the office does not follow', 'push', fixture('github-pull-request-opened.json')],
    ['an action it does not follow', 'pull_request', { ...(fixture('github-pull-request-opened.json') as object), action: 'review_requested' }],
    ['a payload with no pull_request', 'pull_request', { action: 'opened', sender: { login: 'x' } }],
    ['no sender', 'pull_request', { ...(fixture('github-pull-request-opened.json') as object), sender: undefined }],
    ['a non-object payload', 'pull_request', 'nope'],
    ['an unparseable updated_at', 'pull_request', { action: 'opened', sender: { login: 'x' }, pull_request: { node_id: 'n', html_url: 'u', title: 't', updated_at: 'yesterday', head: { sha: 's' } } }],
  ])('returns null for %s', async (_label, eventName, payload) => {
    expect(await githubNotice(GH_SRC, eventName, payload)).toBeNull()
  })
})

describe('Linear Issue update → Notice', () => {
  it('maps every field of the contract', async () => {
    const n = await linearNotice(LIN_SRC, fixture('linear-issue-updated.json'))
    expect(n).toMatchObject({
      tenant: 'pot-a',
      connection: 'linear-conn-1',
      provider: 'linear',
      item_id: '5f0c7b9e-1111-4222-8333-444455556666',
      event_id: 'lin-delivery-0001',
      version: '2026-10-22T09:02:10.812Z',
      kind: 'issue',
      url: 'https://linear.app/mumega/issue/MUM-77/doorbell-contract',
      title: 'Doorbell contract',
      actor: 'Hadi',
      updated_at: '2026-10-22T09:02:10.812Z',
    })
    expect(n?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['an unfollowed entity type', { ...(fixture('linear-issue-updated.json') as object), type: 'Project' }],
    ['a remove action', { ...(fixture('linear-issue-updated.json') as object), action: 'remove' }],
    ['no data', { action: 'update', type: 'Issue' }],
    ['a non-object payload', null],
  ])('returns null for %s', async (_label, payload) => {
    expect(await linearNotice(LIN_SRC, payload)).toBeNull()
  })

  it('both providers produce the same Notice key set (one contract)', async () => {
    const gh = await githubNotice(GH_SRC, 'pull_request', fixture('github-pull-request-opened.json'))
    const lin = await linearNotice(LIN_SRC, fixture('linear-issue-updated.json'))
    expect(Object.keys(gh ?? {}).sort()).toEqual(Object.keys(lin ?? {}).sort())
    expect(Object.keys(gh ?? {}).sort()).toEqual(
      ['actor', 'connection', 'event_id', 'hash', 'item_id', 'kind', 'provider', 'tenant', 'title', 'updated_at', 'url', 'version'],
    )
    expect(NOTICE_KINDS).toContain(gh?.kind)
    expect(NOTICE_KINDS).toContain(lin?.kind)
  })
})

describe('Notice hash', () => {
  const base: NoticeFields = {
    tenant: 'pot-a', connection: 'c', provider: 'github', item_id: 'i', event_id: 'e1', version: 'v',
    kind: 'pr', url: 'https://x.test/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }

  it('is stable, and a redelivery (new event_id, same item version) hashes identically', async () => {
    expect(await noticeHash(base)).toBe(await noticeHash({ ...base }))
    expect(await noticeHash({ ...base, event_id: 'e2' })).toBe(await noticeHash(base))
  })

  it.each(['tenant', 'connection', 'provider', 'item_id', 'version', 'kind', 'url', 'title', 'actor', 'updated_at'] as const)(
    'changes when %s changes',
    async (field) => {
      const changed = { ...base, [field]: field === 'provider' ? 'linear' : field === 'kind' ? 'issue' : `${base[field]}x` }
      expect(await noticeHash(changed)).not.toBe(await noticeHash(base))
    },
  )

  it('cannot be forged by shifting text between neighbouring fields', async () => {
    const a = await noticeHash({ ...base, title: 'a', actor: 'b' })
    const b = await noticeHash({ ...base, title: 'a","b', actor: '' })
    expect(a).not.toBe(b)
    expect(canonicalNoticeString({ ...base, title: 'a\nb' })).not.toContain('\n')
  })

  it('buildNotice attaches exactly the hash of its own fields', async () => {
    const n = await buildNotice(base)
    expect(n.hash).toBe(await noticeHash(base))
  })
})

describe('ordering: an old webhook cannot overwrite newer state', () => {
  it('isStale compares updated_at only', () => {
    expect(isStale({ updated_at: '2026-10-22T10:00:00Z' }, { updated_at: '2026-10-22T09:00:00Z' })).toBe(true)
    expect(isStale({ updated_at: '2026-10-22T10:00:00Z' }, { updated_at: '2026-10-22T10:00:00Z' })).toBe(false)
    expect(isStale({ updated_at: '2026-10-22T10:00:00Z' }, { updated_at: '2026-10-22T11:00:00Z' })).toBe(false)
  })
})

describe('Doorbell envelope: pointers only', () => {
  const ok: Doorbell = {
    project: 'proj-1', task_id: 'task-1', attempt: 1, event: 'assigned', version: 'v1',
    hash: 'a'.repeat(64),
  }

  it('accepts exactly {project, task_id, attempt, event, version, hash}', () => {
    expect(isDoorbell(ok)).toBe(true)
  })

  it.each([
    ['an extra field (content or authority smuggled in)', { ...ok, body: 'text' }],
    ['an extra grant-looking field', { ...ok, capability: 'admin' }],
    ['a missing field', { ...ok, version: undefined }],
    ['an unknown event', { ...ok, event: 'approved' }],
    ['a fractional attempt', { ...ok, attempt: 1.5 }],
    ['a negative attempt', { ...ok, attempt: -1 }],
    ['a short hash', { ...ok, hash: 'abc' }],
    ['an empty task id', { ...ok, task_id: '' }],
    ['null', null],
    ['an array', [ok]],
  ])('rejects %s', (_label, v) => {
    expect(isDoorbell(v)).toBe(false)
  })

  it('a Notice is not a Doorbell and vice versa', async () => {
    const n: Notice = await buildNotice({
      tenant: 't', connection: 'c', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
      kind: 'pr', url: 'u', title: 't', actor: 'a', updated_at: '2026-10-22T00:00:00Z',
    })
    expect(isDoorbell(n)).toBe(false)
  })
})
