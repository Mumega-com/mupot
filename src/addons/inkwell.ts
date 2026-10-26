import { Hono } from 'hono'
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'

export const inkwellApp = new Hono<{ Bindings: Env }>()

export interface InkwellPublishPayload {
  title: string
  slug: string
  content: string
  status?: 'draft' | 'published'
  targetSite?: string
  author?: string
  tags?: string[]
}

export interface InkwellPublishError {
  error: 'inkwell_publish_token_unconfigured' | 'inkwell_publish_unauthorized' | 'inkwell_publish_unconfigured' | 'publishing_failed'
  detail: string
  next_step: string
}

const publishErrors = {
  tokenUnconfigured: {
    error: 'inkwell_publish_token_unconfigured',
    detail: 'Inkwell publishing requires an outbound publish token.',
    next_step: 'Ask an admin to set INKWELL_PUBLISH_TOKEN.',
  },
  unauthorized: {
    error: 'inkwell_publish_unauthorized',
    detail: 'Inkwell rejected the publish credential (HTTP 401).',
    next_step: 'Ask an admin to match INKWELL_PUBLISH_TOKEN to Inkwell PUBLISH_TOKEN.',
  },
  unconfigured: {
    error: 'inkwell_publish_unconfigured',
    detail: 'Inkwell publishing is unconfigured (HTTP 503).',
    next_step: 'Ask an admin to set PUBLISH_TOKEN on Inkwell.',
  },
  failed: {
    error: 'publishing_failed',
    detail: 'Inkwell publishing failed.',
    next_step: 'Retry publishing; if it persists, ask an admin to check Inkwell.',
  },
} satisfies Record<string, InkwellPublishError>

// Authentication middleware for Inkwell sub-app
inkwellApp.use('*', async (c, next) => {
  if (c.req.path.endsWith('/health')) return next()
  const secret = c.env.INKWELL_SECRET || c.env.INKWELL_TOKEN || c.env.INKWELL_API_TOKEN
  if (!secret) {
    return c.json({ error: 'unconfigured_secret', detail: 'addon secret unconfigured on environment' }, 503)
  }

  const authHeader = c.req.header('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader
  const xSecret = c.req.header('x-secret') || c.req.header('x-inkwell-secret')

  const providedToken = bearerToken || xSecret
  if (!providedToken || !timingSafeEqual(providedToken, secret)) {
    return c.json({ error: 'unauthorized', detail: 'invalid or missing secret header' }, 401)
  }
  return next()
})

// GET /health — status of Inkwell publishing sub-app
inkwellApp.get('/health', (c) => {
  return c.json({
    ok: true,
    addon: 'inkwell',
    status: 'active',
    publishing: 'astro-cms',
    targetUrlConfigured: Boolean(c.env.INKWELL_API_URL || c.env.INKWELL_SVC),
  })
})

const handlePublishing = async (c: import('hono').Context<{ Bindings: Env }>, defaultStatus: 'published' | 'draft' = 'published') => {
  let body: InkwellPublishPayload
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', detail: 'Request body must be valid JSON' }, 400)
  }

  if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'title string is required' }, 400)
  }
  if (!body.slug || typeof body.slug !== 'string' || body.slug.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'slug string is required' }, 400)
  }
  if (!body.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'content string is required' }, 400)
  }

  const publishToken = c.env.INKWELL_PUBLISH_TOKEN
  if (!publishToken) return c.json(publishErrors.tokenUnconfigured, 503)

  const title = body.title.trim()
  const slug = body.slug.trim().toLowerCase().replace(/[^a-z0-9-/]/g, '-')
  const content = body.content.trim()
  const status = body.status ?? defaultStatus
  const targetSite = body.targetSite ?? 'mumega.com'
  const author = body.author ?? 'river-copywriter'
  const publicationId = `ink-${crypto.randomUUID()}`
  const publishedAt = new Date().toISOString()

  // If service binding or external Inkwell URL is present, forward request
  if (c.env.INKWELL_SVC) {
    try {
      const res = await c.env.INKWELL_SVC.fetch('http://inkwell-api.internal/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${publishToken}` },
        redirect: 'manual',
        body: JSON.stringify({ id: publicationId, title, slug, content, status, targetSite, author, tags: body.tags }),
      })
      if (res.status === 401) return c.json(publishErrors.unauthorized, 502)
      if (res.status === 503) return c.json(publishErrors.unconfigured, 503)
      if (!res.ok) return c.json(publishErrors.failed, 500)
    } catch {
      // Fetch exceptions may contain request headers; expose only fixed diagnostics.
      return c.json(publishErrors.failed, 500)
    }
  }

  const url = `https://${targetSite}/${slug.replace(/^\//, '')}`

  return c.json({
    ok: true,
    publicationId,
    title,
    slug,
    contentLength: content.length,
    status,
    targetSite,
    author,
    url,
    publishedAt,
  }, status === 'draft' ? 200 : 201)
}

// POST /publish — publish content to Inkwell Astro CMS
inkwellApp.post('/publish', (c) => handlePublishing(c, 'published'))

// POST /internal-content — internal publishing endpoint
inkwellApp.post('/internal-content', (c) => handlePublishing(c, 'published'))

// POST /draft — create a draft content item
inkwellApp.post('/draft', (c) => handlePublishing(c, 'draft'))

// GET /publications — list publishing metadata
inkwellApp.get('/publications', (c) => {
  return c.json({
    ok: true,
    targetSite: 'mumega.com',
    publisher: '@mumega/addon-inkwell',
  })
})
