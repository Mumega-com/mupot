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

const { createProject, getProject } = await import('../src/projects/service')
const { deployProject, listProjectDeployments, recordProjectDeployment } = await import('../src/projects/deploy')
const { provisionDefaultClientProjects, DEFAULT_CLIENT_PROJECTS } = await import('../src/projects/client-bootstrap')
const { githubRepoSlug } = await import('../src/projects/urls')
const { projectsApp } = await import('../src/projects')
const { dashboardApp } = await import('../src/dashboard')
const { projectsPageBody, loadProjectsPage, loadProjectDetail, projectDetailBody } = await import('../src/dashboard/projects')
const { invokeTool, TOOLS } = await import('../src/mcp')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
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

describe('project worker platform — domain', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('creates a project with repo association and worker fields', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, {
      slug: 'client-one',
      name: 'Client One',
      repo_url: 'https://github.com/Mumega-com/mupot',
      live_url: 'https://mupot.mumega.com',
      worker_name: 'worker-alpha',
      assigned_squad_id: 'squad-a',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value).toMatchObject({
      slug: 'client-one',
      repo_url: 'https://github.com/Mumega-com/mupot',
      live_url: 'https://mupot.mumega.com',
      worker_name: 'worker-alpha',
      assigned_squad_id: 'squad-a',
      deploy_status: 'healthy',
    })
    expect(githubRepoSlug(created.value.repo_url)).toBe('Mumega-com/mupot')
    expect(await getProject(env, created.value.id)).toMatchObject({
      repo_url: 'https://github.com/Mumega-com/mupot',
      worker_name: 'worker-alpha',
    })
  })

  it('rejects invalid repo and worker names', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await expect(createProject(env, {
      slug: 'bad-repo', name: 'Bad', repo_url: 'http://github.com/x/y',
    })).resolves.toEqual({ ok: false, error: 'invalid_repo_url' })
    await expect(createProject(env, {
      slug: 'bad-worker', name: 'Bad', worker_name: 'Not A Worker',
    })).resolves.toEqual({ ok: false, error: 'invalid_worker_name' })
    await expect(createProject(env, {
      slug: 'missing-squad', name: 'Bad', assigned_squad_id: 'no-such-squad',
    })).resolves.toEqual({ ok: false, error: 'squad_not_found' })
  })

  it('logs an immutable deployment receipt and flips deploy_status', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, {
      slug: 'ship',
      name: 'Ship',
      repo_url: 'https://github.com/Mumega-com/mupot',
      live_url: 'https://mupot.mumega.com',
      worker_name: 'worker-beta',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const result = await deployProject(env, created.value.id, actor(), {
      commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      prompt: 'Ship the next feature flight',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.deployment).toMatchObject({
      project_id: created.value.id,
      commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      url: 'https://mupot.mumega.com',
      status: 'deploying',
      dispatched_by: 'member-a',
    })
    expect(result.project.deploy_status).toBe('deploying')
    expect(result.studio_url).toContain('/studio?repo=')

    const receipts = await listProjectDeployments(env, created.value.id)
    expect(receipts).toHaveLength(1)
    expect(receipts[0].id).toBe(result.deployment.id)

    await expect(env.DB.prepare(
      "UPDATE project_deployments SET status = 'healthy' WHERE id = ?",
    ).bind(result.deployment.id).run()).rejects.toThrow(/immutable/)
    await expect(env.DB.prepare(
      'DELETE FROM project_deployments WHERE id = ?',
    ).bind(result.deployment.id).run()).rejects.toThrow(/immutable/)
  })

  it('provisions Worker Alpha and Worker Beta onto squad-cursor', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const provisioned = await provisionDefaultClientProjects(env)
    expect(provisioned.squad_id).toBe('squad-cursor')
    expect(provisioned.projects.map((row) => row.project.slug).sort()).toEqual(['worker-alpha', 'worker-beta'])
    for (const spec of DEFAULT_CLIENT_PROJECTS) {
      const row = provisioned.projects.find((item) => item.project.slug === spec.slug)
      expect(row?.project).toMatchObject({
        name: spec.name,
        repo_url: spec.repo_url,
        live_url: spec.live_url,
        worker_name: spec.worker_name,
        assigned_squad_id: 'squad-cursor',
        deploy_status: 'healthy',
      })
    }
    const again = await provisionDefaultClientProjects(env)
    expect(again.projects.every((row) => row.created === false)).toBe(true)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE slug IN (?, ?)').bind('worker-alpha', 'worker-beta').first())
      .toEqual({ n: 2 })
  })
})

describe('project worker platform — routes', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders /projects cards with repo, live URL, squad, and dispatch button', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await provisionDefaultClientProjects(env)
    as(actor())

    const response = await dashboardApp.fetch(new Request('https://pot.test/projects'), env)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Worker Alpha')
    expect(body).toContain('Worker Beta')
    expect(body).toContain('Mumega-com/mupot')
    expect(body).toContain('https://mupot.mumega.com')
    expect(body).toContain('🟢 Healthy')
    expect(body).toContain('squad-cursor')
    expect(body).toContain('🚀 Dispatch Feature Flight')
    expect(body).toContain('/studio?repo=')

    const view = await loadProjectsPage(env, actor())
    const html = String(await projectsPageBody(view))
    expect(html).toContain('Dispatch Feature Flight')
    expect(html).toContain('Mumega-com/mupot')
  })

  it('renders /projects/:id worker platform band', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    await provisionDefaultClientProjects(env)
    as(actor())
    const alpha = await env.DB.prepare("SELECT id FROM projects WHERE slug = 'worker-alpha'").first<{ id: string }>()
    expect(alpha).toBeTruthy()

    const response = await dashboardApp.fetch(
      new Request(`https://pot.test/projects/${alpha!.id}`),
      env,
    )
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Worker platform')
    expect(body).toContain('Mumega-com/mupot')
    expect(body).toContain('https://mupot.mumega.com')
    expect(body).toContain('squad-cursor')
    expect(body).toContain('🚀 Dispatch Feature Flight')
    expect(body).toContain('Live preview')
    expect(body).toContain('Code / Logs')
    expect(body).toContain(`data-preview-iframe="${viamar!.id}"`)
    expect(body).toContain(`/preview/${viamar!.id}/`)

    const detail = await loadProjectDetail(env, actor(), alpha!.id)
    expect(detail?.assignedSquadName).toBe('squad-cursor')
    expect(String(await projectDetailBody(detail!))).toContain('Dispatch Feature Flight')
  })

  it('POST /api/projects/:id/deploy records a receipt for an admin and refuses a member', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, {
      slug: 'api-deploy',
      name: 'API Deploy',
      repo_url: 'https://github.com/Mumega-com/mupot',
      live_url: 'https://mupot.mumega.com',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    as(actor({
      role: 'member',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }))
    const denied = await projectsApp.fetch(
      request(`/${created.value.id}/deploy`, 'POST', {}),
      env,
    )
    expect(denied.status).toBe(403)

    as(actor({ role: 'admin' }))
    const allowed = await projectsApp.fetch(
      request(`/${created.value.id}/deploy`, 'POST', {
        commit_sha: 'cccccccccccccccccccccccccccccccccccccccc',
      }),
      env,
    )
    expect(allowed.status).toBe(201)
    const payload = await allowed.json() as {
      deployment: { commit_sha: string; status: string; project_id: string }
      project: { deploy_status: string }
      studio_url: string
    }
    expect(payload.deployment).toMatchObject({
      project_id: created.value.id,
      commit_sha: 'cccccccccccccccccccccccccccccccccccccccc',
      status: 'deploying',
    })
    expect(payload.project.deploy_status).toBe('deploying')
    expect(payload.studio_url).toContain('github.com')
    expect(await listProjectDeployments(env, created.value.id)).toHaveLength(1)
  })

  it('refuses deploy when the project has no repo', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, { slug: 'no-repo', name: 'No Repo' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    as(actor({ role: 'owner' }))
    const response = await projectsApp.fetch(
      request(`/${created.value.id}/deploy`, 'POST', {}),
      env,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'repo_required' })
  })

  it('exposes project_deploy over MCP for an org admin', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, {
      slug: 'mcp-deploy',
      name: 'MCP Deploy',
      repo_url: 'https://github.com/digidinc/dgd-dme',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const tool = TOOLS.find((candidate) => candidate.name === 'project_deploy')
    expect(tool?.min).toBe('admin')
    expect(tool?.inputSchema.additionalProperties).toBe(false)

    const admin = actor({
      capabilities: [{ member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const result = await invokeTool(admin, env, 'project_deploy', {
      project_id: created.value.id,
      prompt: 'Feature flight',
    }, 'https://pot.test')
    expect(result).toMatchObject({
      ok: true,
      result: {
        deployment: { project_id: created.value.id, status: 'deploying' },
        project: { deploy_status: 'deploying' },
      },
    })

    const member = actor({
      role: 'member',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    })
    await expect(invokeTool(member, env, 'project_deploy', {
      project_id: created.value.id,
    }, 'https://pot.test')).resolves.toMatchObject({ ok: false, status: 403 })
  })

  it('writes a raw receipt through the same immutable table the deploy path uses', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const created = await createProject(env, { slug: 'receipt', name: 'Receipt', repo_url: 'https://github.com/a/b' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const receipt = await recordProjectDeployment(env, {
      id: 'dep-1',
      project_id: created.value.id,
      commit_sha: 'dddddddddddddddddddddddddddddddddddddddd',
      deployment_id: 'cf-deploy-1',
      url: 'https://example.invalid',
      status: 'healthy',
      dispatched_by: 'member-a',
      flight_id: null,
    })
    expect(receipt).toMatchObject({ id: 'dep-1', status: 'healthy', commit_sha: 'dddddddddddddddddddddddddddddddddddddddd' })
  })
})
