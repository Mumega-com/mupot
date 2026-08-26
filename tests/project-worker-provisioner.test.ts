import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { createProject } = await import('../src/projects/service')
const {
  DEFAULT_PROJECT_WORKER_SQUAD,
  PROJECT_SANDBOX_QUICK_PROMPTS,
  PROJECT_WORKER_TEMPLATES,
  canProvisionProjectWorker,
  prepareProjectWorkerProvision,
  projectWorkerSubdomain,
  slugFromProjectName,
} = await import('../src/projects/provisioner')
const { isOrgAdmin } = await import('../src/auth/capability')
const { projectsApp } = await import('../src/projects')
const { dashboardApp } = await import('../src/dashboard')
const {
  loadProjectsPage,
  loadProjectDetail,
  projectsPageBody,
  projectDetailBody,
} = await import('../src/dashboard/projects')
const { projectLivePreviewSplitHtml } = await import('../src/platform/routes')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad A'),
      ('squad-cursor', 'dept-a', 'squad-cursor', 'squad-cursor');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: 'pot-a',
    BRAND: 'Mupot',
    RELEASE_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  } as Env
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: 'owner@pot.test',
    role: 'owner',
    tenant: 'pot-a',
    memberId: 'member-a',
    ...overrides,
  }
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: 'https://pot.test' }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function render(value: unknown): Promise<string> {
  return String(await value)
}

describe('project worker provisioner — slug and templates', () => {
  it('auto-generates a lowercase hyphenated slug from the project name', () => {
    expect(slugFromProjectName('Acme Storefront')).toBe('acme-storefront')
    expect(slugFromProjectName('  Next.js / Vite App!! ')).toBe('next-js-vite-app')
    expect(slugFromProjectName('Átomo Café')).toBe('atomo-cafe')
    expect(slugFromProjectName('---')).toBe('')
    expect(slugFromProjectName(12)).toBe('')
  })

  it('previews the custom worker subdomain from the slug', () => {
    expect(projectWorkerSubdomain('acme-storefront')).toBe(
      'https://acme-storefront.mupot.mumega.com',
    )
  })

  it('exposes the four worker templates', () => {
    expect(PROJECT_WORKER_TEMPLATES.map((template) => template.id)).toEqual([
      'custom',
      'next-vite',
      'hono',
      'astro',
    ])
    expect(PROJECT_WORKER_TEMPLATES.map((template) => template.label)).toEqual([
      'Custom Repo',
      'Next.js / Vite',
      'Cloudflare Worker Hono',
      'Static Astro',
    ])
  })
})

describe('project worker provisioner — API', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('creates a worker project via POST /api/projects with idle deploy status', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    as(actor({ role: 'admin' }))
    expect(isOrgAdmin(authState.current)).toBe(true)
    expect(canProvisionProjectWorker(authState.current!)).toBe(true)

    const response = await projectsApp.fetch(request('/', 'POST', {
      name: 'Acme Storefront',
      template: 'hono',
      repo_url: 'https://github.com/org/repo',
    }), env)
    expect(response.status).toBe(201)
    const payload = await response.json() as {
      ok: boolean
      project: {
        id: string
        slug: string
        name: string
        repo_url: string | null
        worker_name: string | null
        assigned_squad_id: string | null
        deploy_status: string
      }
      redirect_url: string
    }
    expect(payload).toMatchObject({
      ok: true,
      project: {
        name: 'Acme Storefront',
        slug: 'acme-storefront',
        repo_url: 'https://github.com/org/repo',
        worker_name: 'acme-storefront',
        assigned_squad_id: 'squad-cursor',
        deploy_status: 'idle',
      },
    })
    expect(payload.redirect_url).toBe(`/projects/${payload.project.id}`)
  })

  it('lets createProject derive a slug when the caller omits one', async () => {
    harness = makeHarness()
    const created = await createProject(envFor(harness), { name: 'Hello World Worker' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.slug).toBe('hello-world-worker')
    expect(created.value.deploy_status).toBe('idle')
  })

  it('defaults assigned squad to squad-cursor when the provisioner body omits it', async () => {
    harness = makeHarness()
    const prepared = await prepareProjectWorkerProvision(envFor(harness), {
      name: 'Cursor Default',
      template: 'astro',
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.value).toMatchObject({
      slug: 'cursor-default',
      worker_name: 'cursor-default',
      assigned_squad_id: DEFAULT_PROJECT_WORKER_SQUAD,
    })
  })

  it('refuses a member and a restricted owner capability set', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    as(actor({
      role: 'member',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }))
    expect(isOrgAdmin(authState.current)).toBe(false)
    const member = await projectsApp.fetch(request('/', 'POST', {
      name: 'Nope',
      slug: 'nope',
      template: 'custom',
    }), env)
    expect(member.status).toBe(403)
    await expect(member.json()).resolves.toEqual({ error: 'forbidden', need: 'admin' })

    as(actor({ role: 'owner', capabilities: [] }))
    const restricted = await projectsApp.fetch(request('/', 'POST', {
      name: 'Restricted',
      slug: 'restricted',
    }), env)
    expect(restricted.status).toBe(403)
  })

  it('rejects invalid name, slug, template, and repository URL', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    as(actor({ role: 'owner' }))

    const missingName = await projectsApp.fetch(request('/', 'POST', {
      template: 'custom',
    }), env)
    expect(missingName.status).toBe(400)
    await expect(missingName.json()).resolves.toEqual({ error: 'invalid_name' })

    const badSlug = await projectsApp.fetch(request('/', 'POST', {
      name: 'Valid',
      slug: 'Not A Slug',
    }), env)
    expect(badSlug.status).toBe(400)
    await expect(badSlug.json()).resolves.toEqual({ error: 'invalid_slug' })

    const badTemplate = await projectsApp.fetch(request('/', 'POST', {
      name: 'Valid',
      template: 'wordpress',
    }), env)
    expect(badTemplate.status).toBe(400)
    await expect(badTemplate.json()).resolves.toEqual({ error: 'invalid_template' })

    const badRepo = await projectsApp.fetch(request('/', 'POST', {
      name: 'Valid',
      template: 'custom',
      repo_url: 'http://github.com/org/repo',
    }), env)
    expect(badRepo.status).toBe(400)
    await expect(badRepo.json()).resolves.toEqual({ error: 'invalid_repo_url' })
  })

  it('keeps a legacy owner create response additive with ok and redirect_url', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))
    const response = await projectsApp.fetch(request('/', 'POST', {
      slug: 'legacy-create',
      name: 'Legacy Create',
    }), envFor(harness))
    expect(response.status).toBe(201)
    const payload = await response.json() as { ok: boolean; project: { slug: string }; redirect_url: string }
    expect(payload.ok).toBe(true)
    expect(payload.project.slug).toBe('legacy-create')
    expect(payload.redirect_url).toMatch(/^\/projects\//)
  })
})

describe('project worker provisioner — dashboard sandbox', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders the 1-click modal on /projects for an admin and hides it from members', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    as(actor({ role: 'owner' }))

    const allowed = await dashboardApp.fetch(new Request('https://pot.test/projects'), env)
    expect(allowed.status).toBe(200)
    const body = await allowed.text()
    expect(body).toContain('+ New Project Worker')
    expect(body).toContain('data-open-project-worker-modal')
    expect(body).toContain('data-project-worker-modal')
    expect(body).toContain('data-auto-slug')
    expect(body).toContain('data-subdomain-preview')
    expect(body).toContain('https://&lt;slug&gt;.mupot.mumega.com')
    expect(body).toContain('Custom Repo')
    expect(body).toContain('Next.js / Vite')
    expect(body).toContain('Cloudflare Worker Hono')
    expect(body).toContain('Static Astro')
    expect(body).toContain('value="squad-cursor"')
    expect(body).toContain("fetch('/api/projects'")
    expect(body).toContain('href="/projects/new"')

    const ownerView = await loadProjectsPage(env, actor({ role: 'owner' }))
    expect(await render(projectsPageBody(ownerView))).toContain('data-project-template')

    as(actor({
      role: 'member',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }))
    const denied = await dashboardApp.fetch(new Request('https://pot.test/projects'), env)
    const deniedBody = await denied.text()
    expect(deniedBody).not.toContain('+ New Project Worker')
    expect(deniedBody).not.toContain('data-project-worker-modal')
  })

  it('renders the split-screen sandbox studio with viewport toggles and Deep Chat', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, {
      name: 'Studio Canvas',
      slug: 'studio-canvas',
      repo_url: 'https://github.com/org/repo',
      worker_name: 'studio-canvas',
      assigned_squad_id: 'squad-cursor',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    as(actor({ role: 'owner' }))
    const response = await dashboardApp.fetch(
      new Request(`https://pot.test/projects/${created.value.id}`),
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('data-sandbox-studio')
    expect(body).toContain('data-preview-iframe')
    expect(body).toContain(`/preview/${created.value.id}/`)
    expect(body).toContain('data-viewport-toggle="desktop"')
    expect(body).toContain('data-viewport-toggle="tablet"')
    expect(body).toContain('data-viewport-toggle="mobile"')
    expect(body).toContain('data-preview-refresh')
    expect(body).toContain('Desktop')
    expect(body).toContain('Tablet')
    expect(body).toContain('Mobile')
    expect(body).toContain('Refresh')
    expect(body).toContain('<deep-chat')
    expect(body).toContain('data-project-repo="https://github.com/org/repo"')
    expect(body).toContain('Pre-focused on')
    expect(body).toContain('Quick Prompts')
    for (const prompt of PROJECT_SANDBOX_QUICK_PROMPTS) {
      expect(body).toContain(prompt)
      expect(body).toContain(`data-quick-prompt="${prompt}"`)
    }
    expect(body).toMatch(/Flight &amp; Deployment Stream|Flight & Deployment Stream/)
    expect(body).toContain('data-flight-stream')
    expect(body).toContain('Live preview')
    expect(body).toContain('Code / Logs')

    const detail = await loadProjectDetail(env, actor({ role: 'owner' }), created.value.id)
    expect(detail).not.toBeNull()
    const fragment = await render(projectDetailBody(detail!))
    expect(fragment).toContain('data-sandbox-studio')
    expect(fragment).toContain('aria-pressed="true"')
  })

  it('renders responsive viewport CSS and flight progress cards on the canvas helper', async () => {
    const html = String(projectLivePreviewSplitHtml({
      project: {
        id: 'proj-studio',
        name: 'Studio',
        slug: 'studio',
        repo_url: 'https://github.com/org/repo',
        live_url: null,
        worker_name: 'studio',
        deploy_status: 'deploying',
      },
      flights: [{ id: 'fl-1', goal: 'Ship contact form', status: 'running' }],
      deployments: [{
        id: 'dep-1',
        project_id: 'proj-studio',
        commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        deployment_id: 'cf-1',
        url: null,
        status: 'deploying',
        dispatched_by: 'member-a',
        flight_id: 'fl-1',
        created_at: '2026-08-26T00:00:00.000Z',
      }],
    }))

    expect(html).toContain('data-viewport-toggle="desktop"')
    expect(html).toContain('data-viewport-toggle="tablet"')
    expect(html).toContain('data-viewport-toggle="mobile"')
    expect(html).toContain('data-preview-refresh')
    expect(html).toContain('data-preview-external')
    expect(html).toContain('data-viewport-size')
    expect(html).toContain('Mobile · 375px')
    expect(html).toContain('Refresh Preview')
    expect(html).toContain('🖥️ Desktop')
    expect(html).toContain('📟 Tablet')
    expect(html).toContain('📱 Mobile')
    expect(html).toContain('[aria-pressed="true"]')
    expect(html).toContain('data-viewport="tablet"] iframe { max-width: 48rem; }')
    expect(html).toContain('data-viewport="mobile"] iframe { max-width: 23.4375rem; }')
    expect(html).toContain('data-flight-step')
    expect(html).toContain('Ship contact form')
    expect(html).toContain('data-deploy-step')
    expect(html).toContain('bbbbbbb')
    expect(html).toContain('<deep-chat')
    expect(html).not.toMatch(/width:\s*\d+px/)
  })
})
