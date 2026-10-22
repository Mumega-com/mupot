// ProjectOffice contract (src/projects/office-contract.ts) and the two fixture mappings:
// a GitHub pull_request.opened delivery and a Linear Issue update both land as the same Notice shape.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NOTICE_CONTRACT_VERSION,
  NOTICE_CONTRACT_VERSIONS_ACCEPTED,
  JOINER_ALLOWED_FIELDS,
  hasUnsafeTextAllowingJoiners,
  NOTICE_KINDS,
  NOTICE_STATES,
  buildNotice,
  canonicalNoticeString,
  NOTICE_MAX_FUTURE_SKEW_MS,
  checkNotice,
  hasUnsafeText,
  isNotice,
  isSafeNoticeUrl,
  noticeFieldsProblem,
  stripUnsafeText,
  isDoorbell,
  DOORBELL_LIMITS,
  NOTICE_LIMITS,
  isStale,
  noticeHash,
  noticeOrder,
  type Doorbell,
  type Notice,
  type NoticeFields,
} from '../src/projects/office-contract'
import { followsGithubAction, githubNotice, linearNotice, type NoticeSource } from '../src/projects/office-notice-map'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'office', name), 'utf8'))
}

const GH_SRC: NoticeSource = { tenant: 'pot-a', connection: 'gh-install-4242', eventId: '72d3162e-cc78-11e3-81ab-4c9367dc0958', repoKey: 'github:mumega/mupot' }
const LIN_SRC: NoticeSource = { tenant: 'pot-a', connection: 'linear-conn-1', eventId: 'lin-delivery-0001' }

describe('GitHub pull_request.opened → Notice', () => {
  it('maps every field of the contract', async () => {
    const n = await githubNotice(GH_SRC, 'pull_request', fixture('github-pull-request-opened.json'))
    expect(n).not.toBeNull()
    expect(n).toMatchObject({
      contract: NOTICE_CONTRACT_VERSION,
      tenant: 'pot-a',
      connection: 'gh-install-4242',
      scope: 'github:mumega/mupot',
      provider: 'github',
      item_id: 'PR_kwDOExample2113',
      event_id: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      // a PR's version is its head sha: a new push is a new version
      version: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
      kind: 'pr',
      state: 'open',
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

  it.each(['labeled', 'unlabeled'])('follows label %s on a pull request and on an issue', async (action) => {
    const pr = await githubNotice(GH_SRC, 'pull_request', { ...(fixture('github-pull-request-opened.json') as object), action })
    expect(pr?.kind).toBe('pr')
    const issue = await githubNotice(GH_SRC, 'issues', {
      action,
      issue: { node_id: 'I_1', html_url: 'https://github.com/o/r/issues/1', title: 'T', updated_at: '2026-10-22T08:00:00Z' },
      sender: { login: 'x' },
    })
    expect(issue?.kind).toBe('issue')
  })

  it('actions are per event: `created` is a comment action, not a pull_request one', async () => {
    expect(await githubNotice(GH_SRC, 'pull_request', { ...(fixture('github-pull-request-opened.json') as object), action: 'created' })).toBeNull()
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
      contract: NOTICE_CONTRACT_VERSION,
      tenant: 'pot-a',
      connection: 'linear-conn-1',
      scope: 'linear:team-mum',
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

  it('maps a Comment by its issueId (the documented payload has no parent title) and copies no body', async () => {
    const n = await linearNotice(LIN_SRC, fixture('linear-comment-created.json'))
    expect(n).toMatchObject({
      kind: 'comment',
      item_id: 'c1c1c1c1-1111-4222-8333-444455556666',
      title: 'Comment on issue 5f0c7b9e-1111-4222-8333-444455556666',
      actor: 'Hadi',
    })
    expect(JSON.stringify(n)).not.toContain('COMMENT BODY')
  })

  it('a Comment with no issue reference at all is not a Notice', async () => {
    const f = fixture('linear-comment-created.json') as { data: Record<string, unknown> }
    expect(await linearNotice(LIN_SRC, { ...f, data: { ...f.data, issueId: undefined } })).toBeNull()
  })

  it('returns null for a payload whose fields exceed the Notice caps', async () => {
    const f = fixture('linear-issue-updated.json') as { data: Record<string, unknown> }
    expect(await linearNotice(LIN_SRC, { ...f, data: { ...f.data, title: 'x'.repeat(NOTICE_LIMITS.title + 1) } })).toBeNull()
  })

  it('both providers produce the same Notice key set (one contract)', async () => {
    const gh = await githubNotice(GH_SRC, 'pull_request', fixture('github-pull-request-opened.json'))
    const lin = await linearNotice(LIN_SRC, fixture('linear-issue-updated.json'))
    expect(Object.keys(gh ?? {}).sort()).toEqual(Object.keys(lin ?? {}).sort())
    expect(Object.keys(gh ?? {}).sort()).toEqual(
      ['actor', 'connection', 'contract', 'event_id', 'hash', 'item_id', 'kind', 'provider', 'scope', 'state', 'tenant', 'title', 'updated_at', 'url', 'version'],
    )
    expect(NOTICE_KINDS).toContain(gh?.kind)
    expect(NOTICE_KINDS).toContain(lin?.kind)
  })
})

describe('Notice hash', () => {
  const base: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e1', version: 'v',
    kind: 'pr', state: 'open', url: 'https://x.test/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }

  it('is stable, and a redelivery (new event_id, same item version) hashes identically', async () => {
    expect(await noticeHash(base)).toBe(await noticeHash({ ...base }))
    expect(await noticeHash({ ...base, event_id: 'e2' })).toBe(await noticeHash(base))
  })

  it.each(['tenant', 'connection', 'scope', 'provider', 'item_id', 'version', 'kind', 'url', 'title', 'actor', 'updated_at'] as const)(
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
  const at = (updated_at: string, version = 'v1') => ({ updated_at, version })
  const T10 = '2026-10-22T10:00:00.000Z'

  it('orders by updated_at', () => {
    expect(noticeOrder(at(T10), at('2026-10-22T09:00:00.000Z'))).toBe('older')
    expect(noticeOrder(at(T10), at('2026-10-22T11:00:00.000Z'))).toBe('newer')
    expect(isStale(at(T10), at('2026-10-22T09:00:00.000Z'))).toBe(true)
    expect(isStale(at(T10), at('2026-10-22T11:00:00.000Z'))).toBe(false)
  })

  it('equal timestamp, equal version is a redelivery: stale, nothing to apply', () => {
    expect(noticeOrder(at(T10, 'v1'), at(T10, 'v1'))).toBe('same')
    expect(isStale(at(T10, 'v1'), at(T10, 'v1'))).toBe(true)
  })

  it('equal timestamp, different version is a TIE, in either arrival order: no field the sender picked decides it', () => {
    // GitHub timestamps have one-second resolution: two pushes in the same second share updated_at. A head sha can be
    // ground to sort high, so `version` must not pick the winner (#2130).
    const a = at(T10, 'aaa111')
    const b = at(T10, 'bbb222')
    expect(noticeOrder(a, b)).toBe('tie')
    expect(noticeOrder(b, a)).toBe('tie')
    expect(isStale(a, b)).toBe(true) // the holder keeps what it has
    expect(isStale(b, a)).toBe(true)
  })

  it('equal timestamp and version but DIFFERENT content (hash) is a tie, not a redelivery', () => {
    const held = { ...at(T10, 'v1'), hash: 'a'.repeat(64) }
    expect(noticeOrder(held, { ...at(T10, 'v1'), hash: 'b'.repeat(64) })).toBe('tie')
    expect(isStale(held, { ...at(T10, 'v1'), hash: 'b'.repeat(64) })).toBe(true) // kept, not applied
    expect(noticeOrder(held, { ...at(T10, 'v1'), hash: 'a'.repeat(64) })).toBe('same')
    expect(noticeOrder(held, at(T10, 'v1'))).toBe('same') // without both hashes only the version can be compared
  })

  it.each(['yesterday', '', 'Invalid Date', '2026-13-45T00:00:00Z'])('fails closed on an unparseable timestamp %j (either side)', (bad) => {
    expect(noticeOrder(at(T10), at(bad))).toBe('invalid')
    expect(noticeOrder(at(bad), at(T10))).toBe('invalid')
    expect(isStale(at(T10), at(bad))).toBe(true)
    expect(isStale(at(bad), at(T10))).toBe(true)
  })
})

describe('buildNotice validates what it signs', () => {
  const ok: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
    kind: 'pr', state: 'open', url: 'https://x.test/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }
  const bad = (over: Record<string, unknown>) => buildNotice({ ...ok, ...over } as unknown as NoticeFields)

  it('accepts a well-formed notice', async () => {
    expect((await buildNotice(ok)).hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it.each([
    ['provider', { provider: 'jirra' }],
    ['kind', { kind: 'epic' }],
    ['updated_at', { updated_at: 'yesterday' }],
    ['updated_at', { updated_at: '2026-10-22T00:00:00Z' }], // parseable but not the canonical spelling
    ['updated_at', { updated_at: '2026-10-22 00:00:00' }],
    ['title', { title: '' }],
    ['actor', { actor: '' }],
    ['version', { version: '' }],
    ['url', { url: 'x'.repeat(NOTICE_LIMITS.url + 1) }],
    ['title', { title: 'x'.repeat(NOTICE_LIMITS.title + 1) }],
    ['item_id', { item_id: 7 }],
  ])('rejects a bad %s', async (field, over) => {
    await expect(bad(over)).rejects.toThrow(`notice_invalid:${field}`)
  })
  it('accepts values exactly at the cap', async () => {
    await expect(bad({ title: 'x'.repeat(NOTICE_LIMITS.title) })).resolves.toBeDefined()
  })
})

describe('state: open | closed | merged, mapped from the source', () => {
  const base = fixture('github-pull-request-opened.json') as Record<string, Record<string, unknown>>
  const withPr = (over: Record<string, unknown>, action = 'synchronize') => ({ ...base, action, pull_request: { ...base.pull_request, ...over } })

  it('PR: open, closed, and merged (closed + merged:true)', async () => {
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({})))?.state).toBe('open')
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({ state: 'closed' }, 'closed')))?.state).toBe('closed')
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({ state: 'closed', merged: true }, 'closed')))?.state).toBe('merged')
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({}, 'closed')))?.state).toBe('closed') // the action says so
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({ merged: true })))?.state).toBe('merged')
  })

  it('issue and comment take the thread’s state; Linear completed/canceled are closed', async () => {
    const issue = (state: string, action = 'edited') => ({ action, sender: { login: 'x' }, issue: { node_id: 'I', html_url: 'https://github.com/o/r/issues/1', title: 'T', updated_at: '2026-10-22T08:00:00Z', state } })
    expect((await githubNotice(GH_SRC, 'issues', issue('open')))?.state).toBe('open')
    expect((await githubNotice(GH_SRC, 'issues', issue('closed', 'closed')))?.state).toBe('closed')
    const comment = (state: string) => ({ action: 'created', sender: { login: 'x' }, issue: { title: 'T', state }, comment: { node_id: 'C', html_url: 'https://github.com/o/r/issues/1#c', updated_at: '2026-10-22T08:00:00Z' } })
    expect((await githubNotice(GH_SRC, 'issue_comment', comment('closed')))?.state).toBe('closed')
    const lin = fixture('linear-issue-updated.json') as { data: Record<string, unknown> }
    for (const [type, want] of [['completed', 'closed'], ['canceled', 'closed'], ['started', 'open'], [undefined, 'open']] as const) {
      const n = await linearNotice(LIN_SRC, { ...lin, data: { ...lin.data, state: type ? { type } : undefined } })
      expect(n?.state, String(type)).toBe(want)
    }
  })

  it('state is part of the hash and of the strict key set; a bad state is refused', async () => {
    const f: NoticeFields = {
      tenant: 't', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
      kind: 'pr', state: 'open', url: 'https://x.test/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
    }
    expect(await noticeHash(f)).not.toBe(await noticeHash({ ...f, state: 'closed' }))
    expect(NOTICE_STATES).toEqual(['open', 'closed', 'merged'])
    expect(noticeFieldsProblem({ ...f, state: 'deleted' as never })).toBe('state')
    const n = await buildNotice(f)
    const { state: _s, ...noState } = n
    expect(await checkNotice(noState)).toEqual({ ok: false, problem: 'keys' })
    expect(await checkNotice({ ...n, state: 'closed' })).toEqual({ ok: false, problem: 'hash' })
  })
})

describe('the office follows only some actions (decided before any I/O)', () => {
  it('follows what the mapper maps, and nothing else', () => {
    for (const a of ['opened', 'synchronize', 'closed', 'reopened', 'edited', 'labeled', 'unlabeled', 'ready_for_review']) expect(followsGithubAction('pull_request', a), a).toBe(true)
    for (const a of ['assigned', 'review_requested', 'locked', 'converted_to_draft', 'auto_merge_enabled', '', 5, null, undefined]) expect(followsGithubAction('pull_request', a), String(a)).toBe(false)
    expect(followsGithubAction('issues', 'opened')).toBe(true)
    expect(followsGithubAction('issues', 'synchronize')).toBe(false) // a PR action, not an issue one
    expect(followsGithubAction('push', 'opened')).toBe(false)
  })
})

describe('title and actor lose control and bidi characters in the mapper (#2130)', () => {
  const RLO = '\u202e' // right-to-left override
  const ZWSP = '\u200b'
  const base = fixture('github-pull-request-opened.json') as Record<string, Record<string, unknown>>

  it('strips them from title and actor and keeps the visible text', async () => {
    const payload = {
      ...base,
      pull_request: { ...base.pull_request, title: `fix${RLO}gpj.exe${ZWSP}\u0007 now\n` },
      sender: { ...base.sender, login: `kas\u0000ra${RLO}` },
    }
    const n = await githubNotice(GH_SRC, 'pull_request', payload)
    expect(n?.title).toBe('fixgpj.exe now')
    expect(n?.actor).toBe('kasra')
    expect(hasUnsafeText(n?.title ?? '')).toBe(false)
  })

  it('a title that is only hidden characters drops the event', async () => {
    const payload = { ...base, pull_request: { ...base.pull_request, title: `${RLO}${ZWSP}\u2028` } }
    expect(await githubNotice(GH_SRC, 'pull_request', payload)).toBeNull()
  })

  it('keeps ZWNJ and ZWJ: a Persian title and an emoji sequence survive the mapper and the strict check', async () => {
    const persian = 'می\u200cخواهم یک پیام' // ZWNJ between "mi" and "khaham"
    const family = '\u{1F469}\u200d\u{1F469}\u200d\u{1F467}' // woman ZWJ woman ZWJ girl
    const payload = { ...base, pull_request: { ...base.pull_request, title: `${persian} ${family}` } }
    const n = await githubNotice(GH_SRC, 'pull_request', payload)
    expect(n?.title).toBe(`${persian} ${family}`)
    expect(hasUnsafeTextAllowingJoiners(n?.title ?? '')).toBe(false)
    expect((await checkNotice(n, Date.parse('2026-10-22T09:00:00Z'))).ok).toBe(true)
    // ...while the neighbouring invisible characters stay refused
    expect(stripUnsafeText('a\u200bb\u200c\u200dc\u202ed\u2060e')).toBe('ab\u200c\u200dcde')
  })

  it('a javascript: or data: link drops the event instead of being mapped', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://github.com/x/y/pull/1', 'https://u:p@github.com/x']) {
      const payload = { ...base, pull_request: { ...base.pull_request, html_url: url } }
      expect(await githubNotice(GH_SRC, 'pull_request', payload), url).toBeNull()
    }
  })
})

describe('checkNotice: the strict boundary check (#2130)', () => {
  const fields: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
    kind: 'pr', state: 'open', url: 'https://github.com/o/r/pull/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }
  const NOW = Date.parse('2026-10-22T00:01:00.000Z')

  it('accepts exactly what buildNotice makes, and returns a clean copy', async () => {
    const n = await buildNotice(fields)
    const r = await checkNotice(n, NOW)
    expect(r).toEqual({ ok: true, notice: n })
    expect(await isNotice(n, NOW)).toBe(true)
    if (r.ok) expect(r.notice).not.toBe(n)
  })

  it.each([null, undefined, 'str', 7, [], [1, 2]])('refuses a non-object %j', async (v) => {
    expect((await checkNotice(v)).ok).toBe(false)
  })

  it('refuses an extra key, and a missing key', async () => {
    const n = await buildNotice(fields)
    expect(await checkNotice({ ...n, assignee: 'attacker' })).toEqual({ ok: false, problem: 'keys' })
    expect(await checkNotice({ ...n, __proto__: { x: 1 }, body: 'text' })).toEqual({ ok: false, problem: 'keys' })
    const { hash: _hash, ...noHash } = n
    expect(await checkNotice(noHash)).toEqual({ ok: false, problem: 'keys' })
  })

  it('refuses a hash that is not the recomputed one (edited after hashing, forged, or malformed)', async () => {
    const n = await buildNotice(fields)
    expect((await checkNotice({ ...n, title: 'edited after hashing' })).ok).toBe(false)
    expect(await checkNotice({ ...n, hash: 'a'.repeat(64) })).toEqual({ ok: false, problem: 'hash' })
    expect(await checkNotice({ ...n, hash: n.hash.toUpperCase() })).toEqual({ ok: false, problem: 'hash' })
    expect(await checkNotice({ ...n, hash: `${n.hash}0` })).toEqual({ ok: false, problem: 'hash' })
    expect(await checkNotice({ ...n, hash: `x${n.hash.slice(1)}` })).toEqual({ ok: false, problem: 'hash' })
    expect(await checkNotice({ ...n, hash: ` ${n.hash}` })).toEqual({ ok: false, problem: 'hash' })
    expect(await checkNotice({ ...n, hash: 7 })).toEqual({ ok: false, problem: 'hash' })
  })

  it('refuses a notice whose fields were swapped but whose hash was kept from another notice', async () => {
    const a = await buildNotice(fields)
    const b = await buildNotice({ ...fields, item_id: 'other' })
    expect((await checkNotice({ ...b, hash: a.hash })).ok).toBe(false)
  })

  it('url: https only', async () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://github.com/o/r', 'ftp://x/y', 'file:///etc/passwd', '//github.com/o', 'github.com/o/r', 'https://u:p@github.com/o/r', 'https://', 'https://github.com/a b', 'https://github.com/a\nb']) {
      expect(isSafeNoticeUrl(url), url).toBe(false)
      expect(noticeFieldsProblem({ ...fields, url }), url).toBe('url')
    }
    expect(isSafeNoticeUrl('https://github.com/o/r/pull/1')).toBe(true)
  })

  it('refuses control, format and bidi characters in every text field', async () => {
    for (const bad of ['\u202e', '\u2066', '\u200b', '\u200f', '\ufeff', '\u0000', '\u001b', '\u007f', '\u0085', '\u2028', '\u2029', '\u{e0041}']) {
      for (const key of ['title', 'actor', 'item_id', 'connection', 'version', 'event_id', 'tenant'] as const) {
        expect(noticeFieldsProblem({ ...fields, [key]: `a${bad}b` }), `${key} ${JSON.stringify(bad)}`).toBe(key)
      }
    }
    expect(hasUnsafeText('plain ascii and ünïcode and 日本語')).toBe(false)
    expect(stripUnsafeText(' a\u202eb\u200bc ')).toBe('abc')
  })

  it('skew clamp: refuses an updated_at more than the allowed skew ahead of the receiver, accepts the edge', async () => {
    const future = (ms: number) => new Date(NOW + ms).toISOString()
    expect(noticeFieldsProblem({ ...fields, updated_at: future(NOTICE_MAX_FUTURE_SKEW_MS) }, NOW)).toBeNull()
    expect(noticeFieldsProblem({ ...fields, updated_at: future(NOTICE_MAX_FUTURE_SKEW_MS + 1000) }, NOW)).toBe('updated_at_future')
    expect(noticeFieldsProblem({ ...fields, updated_at: '2999-01-01T00:00:00.000Z' }, NOW)).toBe('updated_at_future')
    const far = await buildNotice({ ...fields, updated_at: '2999-01-01T00:00:00.000Z' })
    expect(await checkNotice(far, NOW)).toEqual({ ok: false, problem: 'updated_at_future' })
    // without a clock the check is not made (the mapper has none); the office always passes one
    expect((await checkNotice(far)).ok).toBe(true)
  })
})

describe('Doorbell envelope: pointers only', () => {
  const ok: Doorbell = {
    project: 'proj-1', task_id: 'task-1', attempt: 1, event: 'assigned', version: 'v1',
    hash: 'a'.repeat(64),
  }

  it('accepts exactly {project, task_id, attempt, event, version, hash}', () => {
    expect(isDoorbell(ok)).toBe(true)
    expect(isDoorbell({ ...ok, attempt: DOORBELL_LIMITS.attempt, version: 'v'.repeat(DOORBELL_LIMITS.version) })).toBe(true)
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
    ['an empty version', { ...ok, version: '' }],
    ['an unbounded attempt', { ...ok, attempt: DOORBELL_LIMITS.attempt + 1 }],
    ['a huge attempt', { ...ok, attempt: Number.MAX_SAFE_INTEGER }],
    ['an over-long project', { ...ok, project: 'p'.repeat(DOORBELL_LIMITS.project + 1) }],
    ['an over-long task id', { ...ok, task_id: 't'.repeat(DOORBELL_LIMITS.task_id + 1) }],
    ['an over-long version', { ...ok, version: 'v'.repeat(DOORBELL_LIMITS.version + 1) }],
    ['an uppercase hash', { ...ok, hash: 'A'.repeat(64) }],
    ['null', null],
    ['an array', [ok]],
  ])('rejects %s', (_label, v) => {
    expect(isDoorbell(v)).toBe(false)
  })

  it('a Notice is not a Doorbell and vice versa', async () => {
    const n: Notice = await buildNotice({
      tenant: 't', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
      kind: 'pr', state: 'open', url: 'https://x.test/u', title: 't', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
    })
    expect(isDoorbell(n)).toBe(false)
  })
})

describe('ZWNJ and ZWJ: allowed in title and actor only (#2137 item 4)', () => {
  const ZWNJ = '\u200c'
  const ZWJ = '\u200d'
  const fields: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
    kind: 'pr', state: 'open', url: 'https://github.com/o/r/pull/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }
  const NOW = Date.parse('2026-10-22T00:01:00.000Z')

  it('the allow-list is exactly title and actor', () => {
    expect([...JOINER_ALLOWED_FIELDS].sort()).toEqual(['actor', 'title'])
  })

  it.each(['title', 'actor'] as const)('%s may carry ZWNJ and ZWJ, through the contract and the strict boundary check', async (key) => {
    const value = `می${ZWNJ}خواهم \u{1F469}${ZWJ}\u{1F469}`
    expect(noticeFieldsProblem({ ...fields, [key]: value })).toBeNull()
    expect((await checkNotice(await buildNotice({ ...fields, [key]: value }), NOW)).ok).toBe(true)
  })

  it.each(['url', 'tenant', 'connection', 'item_id', 'event_id', 'version', 'scope'] as const)('%s refuses ZWNJ and ZWJ', async (key) => {
    for (const j of [ZWNJ, ZWJ]) {
      const value = key === 'url' ? `https://github.com/o/r/pull/1${j}2` : key === 'scope' ? `github:o/r${j}x` : `a${j}b`
      expect(noticeFieldsProblem({ ...fields, [key]: value }), `${key} ${JSON.stringify(j)}`).toBe(key)
    }
  })

  it('isSafeNoticeUrl refuses a joiner on its own, not only through the field loop', () => {
    expect(isSafeNoticeUrl('https://github.com/o/r/pull/1')).toBe(true)
    expect(isSafeNoticeUrl(`https://github.com/o/r/pull/1${ZWNJ}`)).toBe(false)
    expect(isSafeNoticeUrl(`https://github.com/o${ZWJ}/r`)).toBe(false)
  })

  it('a hidden joiner cannot make two identifiers look alike: item_id with a joiner is refused, not folded', async () => {
    await expect(buildNotice({ ...fields, item_id: `PR_kw${ZWJ}DO` })).rejects.toThrow('notice_invalid:item_id')
  })

  it('the strict check refuses them too (a hand-built notice with a valid hash)', async () => {
    const bad = { ...fields, item_id: `i${ZWNJ}` }
    const hash = await noticeHash(bad)
    expect(await checkNotice({ ...bad, contract: NOTICE_CONTRACT_VERSION, hash }, NOW)).toEqual({ ok: false, problem: 'item_id' })
  })

  it('the helpers split exactly there: strict refuses joiners, the free-text variant does not, both refuse the rest', () => {
    expect(hasUnsafeText(`a${ZWNJ}b`)).toBe(true)
    expect(hasUnsafeText(`a${ZWJ}b`)).toBe(true)
    expect(hasUnsafeTextAllowingJoiners(`a${ZWNJ}${ZWJ}b`)).toBe(false)
    for (const bad of ['\u200b', '\u202e', '\u2060', '\ufeff', '\u0000', '\u2028']) {
      expect(hasUnsafeText(`a${bad}b`)).toBe(true)
      expect(hasUnsafeTextAllowingJoiners(`a${bad}b`)).toBe(true)
    }
  })

  it('mappers: a joiner in the GitHub item id or link drops the event; in title and actor it survives', async () => {
    const base = fixture('github-pull-request-opened.json') as Record<string, Record<string, unknown>>
    const withPr = (over: Record<string, unknown>) => ({ ...base, pull_request: { ...base.pull_request, ...over } })
    expect(await githubNotice(GH_SRC, 'pull_request', withPr({ node_id: `PR_kw${ZWJ}x` }))).toBeNull()
    expect(await githubNotice(GH_SRC, 'pull_request', withPr({ html_url: `https://github.com/mumega/mupot/pull/${ZWNJ}7` }))).toBeNull()
    expect((await githubNotice(GH_SRC, 'pull_request', withPr({ title: `a${ZWNJ}b` })))?.title).toBe(`a${ZWNJ}b`)
    const actor = await githubNotice(GH_SRC, 'pull_request', { ...base, sender: { ...base.sender, login: `u${ZWJ}v` } })
    expect(actor?.actor).toBe(`u${ZWJ}v`)
  })
})

describe('Notice contract version (#2137 item 6)', () => {
  const fields: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
    kind: 'pr', state: 'open', url: 'https://github.com/o/r/pull/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }
  const NOW = Date.parse('2026-10-22T00:01:00.000Z')

  it('buildNotice stamps the current version, which the office accepts', async () => {
    const n = await buildNotice(fields)
    expect(n.contract).toBe(NOTICE_CONTRACT_VERSION)
    expect(NOTICE_CONTRACT_VERSIONS_ACCEPTED).toContain(NOTICE_CONTRACT_VERSION)
  })

  it('the hash covers the version: the same fields under another version hash differently', async () => {
    expect(await noticeHash(fields, 2)).not.toBe(await noticeHash(fields, 3))
    expect(canonicalNoticeString(fields, 7).startsWith('[7,')).toBe(true)
  })

  it('pins the hash recipe: changing the field order, the key set or the encoding fails here, on purpose', async () => {
    expect(canonicalNoticeString(fields)).toBe(
      '[2,"pot-a","c","github:o/r","github","i","v","pr","open","https://github.com/o/r/pull/1","T","a","2026-10-22T00:00:00.000Z"]',
    )
    // sha-256 of that exact string, taken independently of the implementation (node:crypto)
    expect(await noticeHash(fields)).toBe('4750251106e7bb3688140472107873fb83de97ecd2beeb010083037a0ef822dd')
  })

  it('an unknown version is refused with its own reason, even when everything else about the notice is valid', async () => {
    const n = await buildNotice(fields)
    for (const contract of [3, 99, 0, 1, -1, 2.5, '2', null, undefined, true]) {
      expect(await checkNotice({ ...n, contract }, NOW), String(contract)).toEqual({ ok: false, problem: 'contract_unsupported' })
    }
    // ...including one a newer Worker signed correctly under ITS recipe
    const future = { ...fields, contract: 3 }
    expect(await checkNotice({ ...future, hash: await noticeHash(fields, 3) }, NOW)).toEqual({ ok: false, problem: 'contract_unsupported' })
  })

  it('a notice with no version (a Worker from before the field existed) is refused as contract_missing, not as "keys"', async () => {
    const n = await buildNotice(fields)
    const { contract: _c, ...noContract } = n
    expect(await checkNotice(noContract, NOW)).toEqual({ ok: false, problem: 'contract_missing' })
    const { contract: _c2, scope: _s, ...legacy } = n
    expect(await checkNotice(legacy, NOW)).toEqual({ ok: false, problem: 'contract_missing' })
  })

  it('the version is read before the shape: an unknown version with extra keys is still named by its version', async () => {
    const n = await buildNotice(fields)
    expect(await checkNotice({ ...n, contract: 3, extra: 1 }, NOW)).toEqual({ ok: false, problem: 'contract_unsupported' })
  })

  it('an accepted version still gets the full check', async () => {
    const n = await buildNotice(fields)
    expect(await checkNotice({ ...n, extra: 1 }, NOW)).toEqual({ ok: false, problem: 'keys' })
    expect(await checkNotice({ ...n, title: 'edited' }, NOW)).toEqual({ ok: false, problem: 'hash' })
  })
})

describe('scope: the source scope an item belongs to (#2137 item 2)', () => {
  const fields: NoticeFields = {
    tenant: 'pot-a', connection: 'c', scope: 'github:o/r', provider: 'github', item_id: 'i', event_id: 'e', version: 'v',
    kind: 'pr', state: 'open', url: 'https://github.com/o/r/pull/1', title: 'T', actor: 'a', updated_at: '2026-10-22T00:00:00.000Z',
  }

  it('must be provider-prefixed, non-empty and whitespace-free', () => {
    expect(noticeFieldsProblem(fields)).toBeNull()
    for (const scope of ['', 'o/r', 'linear:team', 'github:', 'github: o/r', 'github:o/r\n', 'url:host/o/r']) {
      expect(noticeFieldsProblem({ ...fields, scope }), JSON.stringify(scope)).toBe('scope')
    }
    expect(noticeFieldsProblem({ ...fields, scope: 'github:' + 'x'.repeat(NOTICE_LIMITS.scope) })).toBe('scope')
  })

  it('the GitHub mapper needs the routed repository key, and only a github one', async () => {
    const pr = fixture('github-pull-request-opened.json')
    expect(await githubNotice({ ...GH_SRC, repoKey: undefined }, 'pull_request', pr)).toBeNull()
    expect(await githubNotice({ ...GH_SRC, repoKey: 'url:git.example/o/r' }, 'pull_request', pr)).toBeNull()
    expect((await githubNotice({ ...GH_SRC, repoKey: 'github:o/other' }, 'pull_request', pr))?.scope).toBe('github:o/other')
  })

  it('the Linear mapper scopes by team and drops an event with no team', async () => {
    const f = fixture('linear-issue-updated.json') as { data: Record<string, unknown> }
    expect(await linearNotice(LIN_SRC, { ...f, data: { ...f.data, teamId: undefined } })).toBeNull()
    expect((await linearNotice(LIN_SRC, { ...f, data: { ...f.data, teamId: undefined, team: { id: 'team-x' } } }))?.scope).toBe('linear:team-x')
  })
})
