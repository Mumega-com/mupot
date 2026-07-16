// tests/executor-inkwell-cro-apply.test.ts — CRO apply-bridge (S5b).
//
// Unit coverage for the fetch-then-merge write path added to
// departments/executors/inkwell.ts:
//   A. fetchInkwellContent — the GET read, fail-closed on any error, null on 404.
//   B. mergeContentUpdate — pure field-merge logic, the hard-constraint deliverable
//      "a meta-only change preserves the article body".
//   C. inkwellContentApplyWrite — the full orchestrator: fetch (fail-closed) → merge
//      → write. Proves a fetch failure NEVER reaches the write call.
//   D. inkwellContentDispatch — kernel.ts's new call site, routes on payload.mode.
//
// The full propose→approve→execute integration (real gate dispatch through
// kernel.ts) lives in tests/cro-apply-loop.test.ts.

import { describe, it, expect, vi } from 'vitest'
import {
  fetchInkwellContent,
  mergeContentUpdate,
  inkwellContentApplyWrite,
  inkwellContentDispatch,
  inkwellContentWrite,
  InkwellExecutorError,
  type FetchedInkwellContent,
  type CroApplyMergePayload,
} from '../src/departments/executors/inkwell'

const cfg = { apiUrl: 'https://inkwell.test', token: 'tok', tenantSlug: 'mumega' }

function jsonFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

/** InkwellExecutorError's .message is the human-readable text, not the .reason code —
 *  assert on .reason directly rather than pattern-matching the message string. */
function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof InkwellExecutorError) return e.reason
    throw e
  }
  throw new Error('expected fn to throw')
}

const currentPost: FetchedInkwellContent = {
  title: 'Original Title',
  description: 'Original description',
  author: 'agent',
  tags: ['a', 'b'],
  status: 'published',
  content: 'The real article body — a CTA lives here: [Book a call](https://example.com/book).',
}

// ── A. fetchInkwellContent ──────────────────────────────────────────────────────

describe('fetchInkwellContent — fail-closed', () => {
  it('missing config → inkwell_not_configured', async () => {
    await expect(fetchInkwellContent({ apiUrl: '', token: '', tenantSlug: '' }, 'slug')).rejects.toMatchObject({
      reason: 'inkwell_not_configured',
    })
  })

  it('empty slug → invalid_payload', async () => {
    await expect(fetchInkwellContent(cfg, '', jsonFetch({}))).rejects.toMatchObject({ reason: 'invalid_payload' })
  })

  it('404 → returns null (no article to merge into)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })) as unknown as typeof fetch
    const result = await fetchInkwellContent(cfg, 'missing-slug', f)
    expect(result).toBeNull()
  })

  it('non-ok non-404 → inkwell_fetch_http_error', async () => {
    const f = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(fetchInkwellContent(cfg, 'slug', f)).rejects.toMatchObject({ reason: 'inkwell_fetch_http_error' })
  })

  it('network error → inkwell_unreachable', async () => {
    const f = vi.fn(async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    await expect(fetchInkwellContent(cfg, 'slug', f)).rejects.toMatchObject({ reason: 'inkwell_unreachable' })
  })

  it('malformed response (ok:true but no content field) → inkwell_fetch_bad_response', async () => {
    await expect(fetchInkwellContent(cfg, 'slug', jsonFetch({ ok: true }))).rejects.toMatchObject({
      reason: 'inkwell_fetch_bad_response',
    })
  })

  it('redirect response → inkwell_redirect_blocked, never followed', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch
    await expect(fetchInkwellContent(cfg, 'slug', f)).rejects.toMatchObject({ reason: 'inkwell_redirect_blocked' })
  })

  it('happy path: GETs the internal endpoint with tenant_slug + Bearer, returns split fields', async () => {
    const f = jsonFetch({
      ok: true,
      slug: 'existing-post',
      title: 'Original Title',
      description: 'Original description',
      author: 'agent',
      tags: ['a', 'b'],
      status: 'published',
      content: 'body text',
    })
    const result = await fetchInkwellContent(cfg, 'existing-post', f)
    expect(result).toEqual({
      title: 'Original Title',
      description: 'Original description',
      author: 'agent',
      tags: ['a', 'b'],
      status: 'published',
      content: 'body text',
    })
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('https://inkwell.test/api/internal/content/existing-post?tenant_slug=mumega')
    expect((call[1] as RequestInit).method).toBe('GET')
    expect((call[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' })
  })
})

// ── B. mergeContentUpdate — pure, the hard-constraint deliverable ───────────────

describe('mergeContentUpdate — preserves every field except the targeted one', () => {
  it('meta_title: changes ONLY title, body/description/tags/status untouched', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'meta_title',
      value: 'A Better AEO Title',
    }
    const { body, diff } = mergeContentUpdate(currentPost, merge)
    expect(body.title).toBe('A Better AEO Title')
    expect(body.content).toBe(currentPost.content) // ⭐ the hard constraint: body survives untouched
    expect(body.description).toBe(currentPost.description)
    expect(body.tags).toEqual(currentPost.tags)
    expect(body.status).toBe(currentPost.status)
    expect(body.slug).toBe('existing-post')
    expect(diff).toEqual({ changeType: 'meta_title', field: 'title', before: 'Original Title', after: 'A Better AEO Title' })
  })

  it('headline: also targets `title` (schema collision — see change-types.ts SCHEMA NOTE), body untouched', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'headline',
      value: 'A Bigger Headline Rewrite',
    }
    const { body, diff } = mergeContentUpdate(currentPost, merge)
    expect(body.title).toBe('A Bigger Headline Rewrite')
    expect(body.content).toBe(currentPost.content)
    expect(diff.field).toBe('title')
  })

  it('meta_description: changes ONLY description, title/body untouched', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'meta_description',
      value: 'A sharper meta description for AEO',
    }
    const { body, diff } = mergeContentUpdate(currentPost, merge)
    expect(body.description).toBe('A sharper meta description for AEO')
    expect(body.title).toBe(currentPost.title)
    expect(body.content).toBe(currentPost.content)
    expect(diff.field).toBe('description')
  })

  it('body_copy: replaces the whole content field (the change-type IS the body); other fields untouched', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'body_copy',
      value: 'A completely rewritten article body.',
    }
    const { body, diff } = mergeContentUpdate(currentPost, merge)
    expect(body.content).toBe('A completely rewritten article body.')
    expect(body.title).toBe(currentPost.title)
    expect(body.description).toBe(currentPost.description)
    expect(diff.field).toBe('content')
  })

  it('cta_text: replaces the exact matched substring only, rest of body untouched', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'cta_text',
      findText: '[Book a call](https://example.com/book)',
      value: '[Grab a slot now](https://example.com/book)',
    }
    const { body, diff } = mergeContentUpdate(currentPost, merge)
    expect(body.content).toBe('The real article body — a CTA lives here: [Grab a slot now](https://example.com/book).')
    expect(body.title).toBe(currentPost.title)
    expect(diff).toEqual({
      changeType: 'cta_text',
      field: 'content',
      before: '[Book a call](https://example.com/book)',
      after: '[Grab a slot now](https://example.com/book)',
    })
  })

  it('cta_text/internal_links: missing findText → merge_target_missing, fail-closed', () => {
    const merge = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'cta_text',
      value: 'new text',
    } as CroApplyMergePayload
    expect(reasonOf(() => mergeContentUpdate(currentPost, merge))).toBe('merge_target_missing')
  })

  it('cta_text: findText absent from body → merge_target_not_found, fail-closed', () => {
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'cta_text',
      findText: 'this text does not appear anywhere',
      value: 'replacement',
    }
    expect(reasonOf(() => mergeContentUpdate(currentPost, merge))).toBe('merge_target_not_found')
  })

  it('cta_text: findText appears MORE THAN ONCE → merge_target_ambiguous, fail-closed (never guesses)', () => {
    const repeated: FetchedInkwellContent = { ...currentPost, content: 'click here. Also, click here again.' }
    const merge: CroApplyMergePayload = {
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      slug: 'existing-post',
      changeType: 'internal_links',
      findText: 'click here',
      value: 'click now',
    }
    expect(reasonOf(() => mergeContentUpdate(repeated, merge))).toBe('merge_target_ambiguous')
  })
})

// ── C. inkwellContentApplyWrite — fetch-then-merge orchestration, fail-closed ───

describe('inkwellContentApplyWrite — fail-closed fetch-then-merge', () => {
  const mergePayload = {
    executor: 'inkwell-content',
    mode: 'cro-apply-merge',
    slug: 'existing-post',
    changeType: 'meta_title',
    value: 'A Better Title',
  }

  it('fetch network failure → throws, NO write call is ever made', async () => {
    const f = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(inkwellContentApplyWrite(cfg, mergePayload, f)).rejects.toMatchObject({ reason: 'inkwell_unreachable' })
    expect(f).toHaveBeenCalledTimes(1) // only the GET attempt — no POST followed
  })

  it('fetch 404 (article missing) → merge_source_not_found, NO write call', async () => {
    const f = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    await expect(inkwellContentApplyWrite(cfg, mergePayload, f)).rejects.toMatchObject({
      reason: 'merge_source_not_found',
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('invalid payload (missing slug) → invalid_payload, no fetch attempted', async () => {
    const f = vi.fn() as unknown as typeof fetch
    await expect(inkwellContentApplyWrite(cfg, { executor: 'inkwell-content', mode: 'cro-apply-merge' }, f)).rejects.toMatchObject({
      reason: 'invalid_payload',
    })
    expect(f).not.toHaveBeenCalled()
  })

  it('happy path: GET then POST, merged body preserves the untouched fields, returns diff', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const f = (vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit })
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            ok: true,
            slug: 'existing-post',
            title: 'Original Title',
            description: 'Original description',
            author: 'agent',
            tags: ['a', 'b'],
            status: 'published',
            content: 'The untouched real article body.',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ ok: true, slug: 'existing-post', url: '/blog/existing-post' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown) as typeof fetch

    const result = await inkwellContentApplyWrite(cfg, mergePayload, f)
    expect(result).toMatchObject({ ok: true, slug: 'existing-post', url: '/blog/existing-post' })
    expect(result.diff).toEqual({
      changeType: 'meta_title',
      field: 'title',
      before: 'Original Title',
      after: 'A Better Title',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://inkwell.test/api/internal/content/existing-post?tenant_slug=mumega')
    expect(calls[1].url).toBe('https://inkwell.test/api/internal/content/publish')
    const posted = JSON.parse(calls[1].init.body as string) as { title: string; content: string; description: string }
    expect(posted.title).toBe('A Better Title')
    // ⭐ THE hard constraint: a meta-only change never clobbers the real body.
    expect(posted.content).toBe('The untouched real article body.')
    expect(posted.description).toBe('Original description')
  })

  it('unknown/refused change-type never reaches toCroApplyMergePayload validity → invalid_payload, no fetch', async () => {
    const f = vi.fn() as unknown as typeof fetch
    const badPayload = { executor: 'inkwell-content', mode: 'cro-apply-merge', slug: 's', changeType: 'pricing', value: 'x' }
    await expect(inkwellContentApplyWrite(cfg, badPayload, f)).rejects.toMatchObject({ reason: 'invalid_payload' })
    expect(f).not.toHaveBeenCalled()
  })
})

// ── D. inkwellContentDispatch — routes on payload shape, not action string ─────

describe('inkwellContentDispatch', () => {
  it('mode:"cro-apply-merge" payload → routes to the merge path (fetch-then-merge)', async () => {
    const f = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({ ok: true, title: 't', description: 'd', author: 'a', tags: [], status: 'draft', content: 'body' }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await inkwellContentDispatch(
      cfg,
      { executor: 'inkwell-content', mode: 'cro-apply-merge', slug: 's', changeType: 'meta_title', value: 'v' },
      f,
    )
    expect(result.diff).toBeDefined()
    expect(f).toHaveBeenCalledTimes(2) // GET + POST — proves the merge path ran
  })

  it('a plain content-publish payload (no mode field) → routes to the UNCHANGED full-replace path, no GET fetch', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200 })) as unknown as typeof fetch
    const result = await inkwellContentDispatch(cfg, { title: 't', content: 'c' }, f)
    expect(result.diff).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1) // one POST only — never a GET
  })

  it('a seo-meta-fix payload (overwrite:true, no mode) is unaffected — same as calling inkwellContentWrite directly', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200 })) as unknown as typeof fetch
    const payload = { executor: 'inkwell-content', slug: 's', title: 't', content: 'c', overwrite: true }
    const viaDispatch = await inkwellContentDispatch(cfg, payload, f)
    const viaDirect = await inkwellContentWrite(cfg, payload, f)
    expect(viaDispatch).toEqual(viaDirect)
  })
})
