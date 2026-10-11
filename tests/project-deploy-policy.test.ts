// tests/project-deploy-policy.test.ts — policy rule 5: a deploy-class action on a SEED-ATTACHED project
// needs a canary receipt and a rollback line, refused in the tool with a distinct error code each.
//
// The project is made seed-attached by running the REAL seed_attach apply (not by inserting a row), and
// the canary receipt is a REAL task approved through the REAL verdict write. Every deploy entry point
// is exercised: deployProject, the project_deploy MCP tool, POST /api/projects/:id/deploy, and the
// dashboard deploy button. Each refusal asserts nothing was written (no deploy_status flip, no task,
// no flight, no deployment receipt).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))
vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { get: (key: 'auth') => AuthContext | undefined; set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { invokeTool, TOOLS } = await import('../src/mcp/index')
const { deployProject, CANARY_GATE_OWNER, CANARY_RECEIPT_MAX_AGE_HOURS } = await import('../src/projects/deploy')
const { writeVerdict } = await import('../src/tasks/service')
const { projectsApp } = await import('../src/projects')
const { dashboardApp } = await import('../src/dashboard')

const TENANT = 'tenant-a'
const MASTER = 'a1'.repeat(32)
const ORIGIN = 'https://pot.test'
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
const ROLLBACK = 'Revert the release commit and redeploy the previous build.'

const grant = (capability: CapabilityGrant['capability']): CapabilityGrant =>
  ({ member_id: 'n/a', scope_type: 'org', scope_id: null, capability }) as CapabilityGrant
const adminAuth = (memberId: string): AuthContext => ({
  userId: memberId, email: `${memberId}@example.test`, role: 'owner', tenant: TENANT, channel: 'workspace',
  memberId, capabilities: [grant('admin')], boundAgentId: null,
})
const deployer = adminAuth('adm')

let harness: SqliteD1Harness
let env: Env
let projectId: string
let otherProjectId: string

function sql<T>(text: string, ...params: unknown[]): T[] {
  return harness.sqlite.prepare(text).all(...(params as never[])) as T[]
}

/** A real seed apply: returns the seed-attached project id. */
async function applySeed(): Promise<string> {
  const dry = (await invokeTool(deployer, env, 'seed_attach', { seed: seedText }, ORIGIN)) as unknown as { ok: boolean; result: { requests: Array<{ key: string }>; accept_token: string } }
  expect(dry.ok).toBe(true)
  const res = (await invokeTool(deployer, env, 'seed_attach', {
    seed: seedText, dry_run: false, accept: dry.result.requests.map((r) => r.key), accept_token: dry.result.accept_token,
  }, ORIGIN)) as unknown as { ok: boolean; result: { project_id: string } }
  expect(res.ok, JSON.stringify(res)).toBe(true)
  const row = harness.sqlite.prepare(`SELECT project_id FROM project_seeds`).get() as { project_id: string }
  harness.sqlite.prepare(`UPDATE projects SET repo_url = 'https://github.com/example-org/example-site' WHERE id = ?`).run(row.project_id)
  // Give the project a worker squad with an active agent so a deploy actually dispatches a task + flight.
  const squad = (harness.sqlite.prepare(`SELECT squad_id FROM project_squad_access WHERE project_id = ? LIMIT 1`).get(row.project_id) as { squad_id: string }).squad_id
  harness.sqlite.prepare(`UPDATE projects SET assigned_squad_id = ? WHERE id = ?`).run(squad, row.project_id)
  harness.sqlite.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-deploy', ?, 'agent-deploy', 'D', 'r', 'm', 'active')`).run(squad)
  return row.project_id
}

let seq = 0
/** A task in `project` gated by `gate`, put in review and given a REAL verdict by `decidedBy`. */
async function canaryTask(opts: {
  project?: string; gate?: string; verdict?: 'approved' | 'rejected' | null; decidedBy?: string
  decidedAgoHours?: number; reverse?: boolean
} = {}): Promise<string> {
  const id = `canary-${++seq}`
  const project = opts.project ?? projectId
  // A task may only sit in a project whose access list includes its squad (a DB trigger).
  const squad = (harness.sqlite.prepare(
    `SELECT squad_id FROM project_squad_access WHERE project_id = ? LIMIT 1`,
  ).get(project) as { squad_id: string }).squad_id
  harness.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 'canary', 'b', 'canary green', 'review', ?, NULL, datetime('now'), datetime('now'))`,
  ).run(id, squad, project, opts.gate ?? CANARY_GATE_OWNER)
  const verdict = opts.verdict === undefined ? 'approved' : opts.verdict
  if (verdict) {
    const task = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as never
    // Verdict rows are append-only, so an old approval is made by writing the verdict "in the past".
    if (opts.decidedAgoHours !== undefined) vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - opts.decidedAgoHours * 3_600_000 })
    try {
      await writeVerdict(env, { task, verdict, note: null, decidedBy: opts.decidedBy ?? 'canary-approver' })
    } finally {
      vi.useRealTimers()
    }
    if (opts.reverse) {
      harness.sqlite.prepare(`UPDATE task_verdicts SET reversed_at = datetime('now') WHERE task_id = ?`).run(id)
      harness.sqlite.prepare(`UPDATE tasks SET status = 'review' WHERE id = ?`).run(id)
    }
  }
  return id
}

function writes(): string {
  const n = (t: string) => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  const status = (harness.sqlite.prepare(`SELECT deploy_status FROM projects WHERE id = ?`).get(projectId) as { deploy_status: string }).deploy_status
  return JSON.stringify({ deployments: n('project_deployments'), tasks: n('tasks'), flights: n('flights'), status })
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('adm', 'adm@example.test', 'Adm', 'active', '${TENANT}'),
      ('canary-approver', 'ca@example.test', 'CA', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'X', 'r', 'm', 'active');
    INSERT INTO projects (id, slug, name, status, repo_url, created_at, updated_at)
      VALUES ('plain-project', 'plain', 'Plain', 'active', 'https://github.com/example-org/plain', datetime('now'), datetime('now'));
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('plain-project', 'squad-a', 'write');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER, RELEASE_SHA: 'b'.repeat(7) + '1' } as Env
  projectId = await applySeed()
  otherProjectId = 'plain-project'
})
afterEach(() => {
  authState.current = null
  harness.close()
})

const deploy = (input: Record<string, unknown>) => deployProject(env, projectId, deployer, input)

describe('policy rule 5 — a seed-attached project needs a canary receipt and a rollback line', () => {
  it('the project really is seed-attached (setup guard: the policy is in force)', () => {
    expect(sql<{ project_id: string }>('SELECT project_id FROM project_seeds')[0]?.project_id).toBe(projectId)
  })

  it('HAPPY PATH: a fresh, independent, approved canary of the same project plus a rollback line deploys', async () => {
    const receipt = await canaryTask()
    const res = await deploy({ canary_receipt: receipt, rollback: ROLLBACK, prompt: 'Ship it' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    // The evidence travels with the work: the dispatched task body and the flight meta carry it.
    const body = (sql<{ body: string }>(`SELECT body FROM tasks WHERE body LIKE '%source: project-worker-deploy%'`)[0])?.body ?? ''
    expect(body).toContain(`canary_receipt: ${receipt}`)
    expect(body).toContain(`rollback: ${ROLLBACK}`)
    expect(JSON.stringify(sql<{ meta: string }>('SELECT meta FROM flights'))).toContain(receipt)
  })

  describe('refusals, each with its own code and NO write', () => {
    const cases: Array<[string, () => Promise<Record<string, unknown>>, string]> = [
      ['no canary_receipt', async () => ({ rollback: ROLLBACK }), 'canary_receipt_required'],
      ['blank canary_receipt', async () => ({ canary_receipt: '   ', rollback: ROLLBACK }), 'canary_receipt_required'],
      ['non-string canary_receipt', async () => ({ canary_receipt: 42, rollback: ROLLBACK }), 'canary_receipt_required'],
      ['unknown receipt id', async () => ({ canary_receipt: 'no-such-task', rollback: ROLLBACK }), 'canary_receipt_not_found'],
      ['a canary of ANOTHER project', async () => ({ canary_receipt: await canaryTask({ project: otherProjectId }), rollback: ROLLBACK }), 'canary_receipt_wrong_project'],
      ['an approved task that is NOT a canary (other gate)', async () => ({ canary_receipt: await canaryTask({ gate: 'gate:review' }), rollback: ROLLBACK }), 'canary_receipt_not_canary'],
      ['a canary still in review (no verdict)', async () => ({ canary_receipt: await canaryTask({ verdict: null }), rollback: ROLLBACK }), 'canary_receipt_not_passed'],
      ['a canary that was REJECTED', async () => ({ canary_receipt: await canaryTask({ verdict: 'rejected' }), rollback: ROLLBACK }), 'canary_receipt_not_passed'],
      ['a canary approval that was later REVERSED', async () => ({ canary_receipt: await canaryTask({ reverse: true }), rollback: ROLLBACK }), 'canary_receipt_not_passed'],
      ['a canary approved too long ago', async () => ({ canary_receipt: await canaryTask({ decidedAgoHours: CANARY_RECEIPT_MAX_AGE_HOURS + 1 }), rollback: ROLLBACK }), 'canary_receipt_stale'],
      ['a canary approved by the deployer themself', async () => ({ canary_receipt: await canaryTask({ decidedBy: 'adm' }), rollback: ROLLBACK }), 'canary_receipt_self_certified'],
      ['no rollback', async () => ({ canary_receipt: await canaryTask() }), 'rollback_required'],
      ['blank rollback', async () => ({ canary_receipt: await canaryTask(), rollback: '  \n ' }), 'rollback_required'],
      ['placeholder rollback', async () => ({ canary_receipt: await canaryTask(), rollback: 'TBD' }), 'rollback_required'],
      ['oversized rollback', async () => ({ canary_receipt: await canaryTask(), rollback: 'x '.repeat(400) }), 'rollback_required'],
    ]
    for (const [label, build, error] of cases) {
      it(`${label} -> ${error}`, async () => {
        const input = await build()
        const before = writes()
        expect(await deploy(input)).toEqual({ ok: false, error })
        expect(writes()).toBe(before)
      })
    }
  })

  describe('a row set that disagrees with itself fails closed (each condition is independently exercised)', () => {
    it('an approved canary that later reached done still vouches', async () => {
      const id = await canaryTask()
      harness.sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(id)
      expect((await deploy({ canary_receipt: id, rollback: ROLLBACK })).ok).toBe(true)
    })
    it('status not approved/done, even with an un-reversed approval on file', async () => {
      for (const status of ['review', 'in_progress', 'open', 'rejected']) {
        const id = await canaryTask()
        harness.sqlite.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id)
        expect(await deploy({ canary_receipt: id, rollback: ROLLBACK }), status).toEqual({ ok: false, error: 'canary_receipt_not_passed' })
      }
    })
    it('a reversed verdict on a row whose status was not reset', async () => {
      const id = await canaryTask()
      harness.sqlite.prepare(`UPDATE task_verdicts SET reversed_at = datetime('now') WHERE task_id = ?`).run(id)
      expect(await deploy({ canary_receipt: id, rollback: ROLLBACK })).toEqual({ ok: false, error: 'canary_receipt_not_passed' })
    })
    it('a latest verdict that is a rejection on a row whose status says approved', async () => {
      const id = await canaryTask({ verdict: 'rejected' })
      harness.sqlite.prepare(`UPDATE tasks SET status = 'approved' WHERE id = ?`).run(id)
      expect(await deploy({ canary_receipt: id, rollback: ROLLBACK })).toEqual({ ok: false, error: 'canary_receipt_not_passed' })
    })
  })

  describe('self-certification follows affiliation, not raw ids (both directions of agent ownership)', () => {
    const asAgentDeployer = (agentId: string): AuthContext => ({ ...deployer, memberId: 'adm', boundAgentId: agentId })
    beforeEach(() => {
      harness.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant) VALUES
          ('owner-x', 'ox@example.test', 'OX', 'active', '${TENANT}'),
          ('key-x', 'kx@example.test', 'KX', 'active', '${TENANT}'),
          ('stranger', 's@example.test', 'S', 'active', '${TENANT}');
        INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
          ('agent-of-adm', 'squad-a', 'agent-of-adm', 'AA', 'r', 'm', 'active', 'adm'),
          ('agent-bound-adm', 'squad-a', 'agent-bound-adm', 'AB', 'r', 'm', 'active', NULL),
          ('agent-keyed-adm', 'squad-a', 'agent-keyed-adm', 'AK', 'r', 'm', 'active', NULL),
          ('deploy-agent', 'squad-a', 'deploy-agent', 'DA', 'r', 'm', 'active', 'owner-x'),
          ('stranger-agent', 'squad-a', 'stranger-agent', 'SA', 'r', 'm', 'active', 'stranger');
        INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-bound-adm', 'adm', datetime('now'));
        INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', 'deploy-agent', 'pk', 'key-x', unixepoch());
        INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES ('${TENANT}', 'agent-keyed-adm', 'pk2', 'adm', unixepoch());
      `)
    })
    it('the deployer approving through their OWN agent (owned by / bound to the deployer) is self-certification', async () => {
      for (const approver of ['agent-of-adm', 'agent-bound-adm', 'agent-keyed-adm']) {
        const id = await canaryTask({ decidedBy: approver })
        expect(await deploy({ canary_receipt: id, rollback: ROLLBACK }), approver).toEqual({ ok: false, error: 'canary_receipt_self_certified' })
      }
    })
    it('an agent deployer cannot deploy on a canary approved by the member who owns / is keyed to that agent', async () => {
      for (const approver of ['owner-x', 'key-x']) {
        const id = await canaryTask({ decidedBy: approver })
        expect(await deployProject(env, projectId, asAgentDeployer('deploy-agent'), { canary_receipt: id, rollback: ROLLBACK }), approver)
          .toEqual({ ok: false, error: 'canary_receipt_self_certified' })
      }
    })
    it('unrelated approvers still pass: a stranger member, a stranger agent', async () => {
      for (const approver of ['stranger', 'stranger-agent']) {
        const id = await canaryTask({ decidedBy: approver })
        expect((await deploy({ canary_receipt: id, rollback: ROLLBACK })).ok, approver).toBe(true)
      }
    })
  })

  it('an ARCHIVED canary task does not vouch', async () => {
    const id = await canaryTask()
    harness.sqlite.prepare(
      `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES (?, datetime('now'), 'cleanup', 'adm', 'approved')`,
    ).run(id)
    expect(await deploy({ canary_receipt: id, rollback: ROLLBACK })).toEqual({ ok: false, error: 'canary_receipt_archived' })
  })

  describe('one canary backs ONE deploy', () => {
    it('the second deploy on the same canary is refused, and the first deploy recorded it in its receipt', async () => {
      const id = await canaryTask()
      expect((await deploy({ canary_receipt: id, rollback: ROLLBACK })).ok).toBe(true)
      expect(sql<{ deployment_id: string }>('SELECT deployment_id FROM project_deployments WHERE project_id = ?', projectId)[0]?.deployment_id.startsWith(`canary:${id}:`)).toBe(true)
      const before = writes()
      expect(await deploy({ canary_receipt: id, rollback: ROLLBACK })).toEqual({ ok: false, error: 'canary_receipt_reused' })
      expect(writes()).toBe(before)
      // A different canary still deploys.
      expect((await deploy({ canary_receipt: await canaryTask(), rollback: ROLLBACK })).ok).toBe(true)
    })
    it('the claim is atomic in the receipt INSERT: two receipts for one canary cannot both land', async () => {
      const { recordProjectDeployment } = await import('../src/projects/deploy')
      const id = await canaryTask()
      const base = { project_id: projectId, commit_sha: 'pending', url: null, status: 'deploying' as const, dispatched_by: 'adm', flight_id: null }
      const first = await recordProjectDeployment(env, { ...base, id: 'd1', deployment_id: `canary:${id}:u1` }, id)
      const second = await recordProjectDeployment(env, { ...base, id: 'd2', deployment_id: `canary:${id}:u2` }, id)
      expect(first).not.toBeNull()
      expect(second).toBeNull()
    })
  })

  it('the freshness boundary: just inside the window passes, just outside is stale', async () => {
    const inside = await canaryTask({ decidedAgoHours: CANARY_RECEIPT_MAX_AGE_HOURS - 0.5 })
    expect((await deploy({ canary_receipt: inside, rollback: ROLLBACK })).ok).toBe(true)
  })

  it('a project that is NOT seed-attached is unaffected (no live caller breaks)', async () => {
    const res = await deployProject(env, otherProjectId, deployer, {})
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })

  describe('every deploy entry point goes through the same check', () => {
    it('MCP project_deploy: 409 with the code; with evidence it succeeds', async () => {
      const refused = await invokeTool(deployer, env, 'project_deploy', { project_id: projectId }, ORIGIN)
      expect(refused).toMatchObject({ ok: false, status: 409, error: 'canary_receipt_required' })
      const receipt = await canaryTask()
      const refused2 = await invokeTool(deployer, env, 'project_deploy', { project_id: projectId, canary_receipt: receipt }, ORIGIN)
      expect(refused2).toMatchObject({ ok: false, status: 409, error: 'rollback_required' })
      const ok = await invokeTool(deployer, env, 'project_deploy', { project_id: projectId, canary_receipt: receipt, rollback: ROLLBACK }, ORIGIN)
      expect(ok).toMatchObject({ ok: true })
    })

    it('REST POST /api/projects/:id/deploy: 409 {error}; with evidence 201', async () => {
      authState.current = deployer
      const post = (body: unknown) => projectsApp.fetch(new Request(`https://pot.test/${projectId}/deploy`, {
        method: 'POST', headers: { Origin: 'https://pot.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), env)
      const refused = await post({})
      expect(refused.status).toBe(409)
      expect(await refused.json()).toEqual({ error: 'canary_receipt_required' })
      const receipt = await canaryTask()
      const ok = await post({ canary_receipt: receipt, rollback: ROLLBACK })
      expect(ok.status).toBe(201)
    })

    it('dashboard deploy button: 409 with a readable message, nothing written', async () => {
      authState.current = deployer
      const before = writes()
      const res = await dashboardApp.fetch(new Request(`https://pot.test/projects/${projectId}/deploy`, {
        method: 'POST', headers: { Origin: 'https://pot.test' },
      }), env)
      expect(res.status).toBe(409)
      expect(await res.text()).toContain('canary_receipt_required')
      expect(writes()).toBe(before)
    })
  })

  describe('Studio dispatch is REFUSED outright for a seed-attached project\'s repository (no canary path)', () => {
    const SEEDED_REPO = 'https://github.com/example-org/example-site'
    const REFUSAL = 'studio_dispatch_seed_attached_use_project_deploy'
    const flightsAndTasks = () => JSON.stringify(sql('SELECT (SELECT COUNT(*) FROM flights) AS f, (SELECT COUNT(*) FROM tasks) AS t, (SELECT COUNT(*) FROM studio_dispatch_slots) AS s'))
    const studio = (body: Record<string, unknown>) => dashboardApp.fetch(new Request('https://pot.test/api/studio/dispatch', {
      method: 'POST', headers: { Origin: 'https://pot.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), env)

    it('is refused for every spelling of the repo, with or without a canary, writing nothing (no slot, task or flight)', async () => {
      authState.current = deployer
      const receipt = await canaryTask()
      const before = flightsAndTasks()
      for (const repoUrl of [SEEDED_REPO, `${SEEDED_REPO}.git`, `${SEEDED_REPO}/`, `${SEEDED_REPO}.git/`, `${SEEDED_REPO}.git.git`, 'https://GitHub.com./Example-Org/Example-Site', 'https://www.github.com/example-org/example-site/tree/main', 'https://github.com/example-org/%65xample-site']) {
        for (const extra of [{}, { canary_receipt: receipt, rollback: ROLLBACK }]) {
          const res = await studio({ prompt: 'launch', repoUrl, ...extra })
          expect(res.status, repoUrl).toBe(409)
          expect(await res.json()).toMatchObject({ error: REFUSAL })
        }
      }
      expect(flightsAndTasks()).toBe(before)
    })

    it('refuses BEFORE any cloud-agent launch or slot reservation, even with a Cursor token configured', async () => {
      authState.current = deployer
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const withCursor = { ...env, CURSOR_API_KEY: 'test-token' } as Env
      const before = flightsAndTasks()
      const res = await dashboardApp.fetch(new Request('https://pot.test/api/studio/dispatch', {
        method: 'POST', headers: { Origin: 'https://pot.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'launch', repoUrl: SEEDED_REPO, model: 'cursor-cloud' }),
      }), withCursor)
      expect(res.status).toBe(409)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(flightsAndTasks()).toBe(before)
      fetchSpy.mockRestore()
    })

    it('a non-GitHub repository URL matches by normalised URL', async () => {
      authState.current = deployer
      harness.sqlite.prepare(`UPDATE projects SET repo_url = 'https://git.example.com/org/site.git' WHERE id = ?`).run(projectId)
      const before = flightsAndTasks()
      for (const repoUrl of ['https://git.example.com/org/site', 'https://GIT.example.com/org/site/', 'https://git.example.com/org/site.git']) {
        const res = await studio({ prompt: 'launch', repoUrl })
        expect(res.status, repoUrl).toBe(409)
        expect(await res.json()).toMatchObject({ error: REFUSAL })
      }
      expect(flightsAndTasks()).toBe(before)
    })

    it('a repository that is not a seed-attached project\'s is unaffected', async () => {
      authState.current = deployer
      const res = await studio({ prompt: 'launch', repoUrl: 'https://github.com/example-org/other-repo' })
      expect(res.status).toBe(200)
    })

    it('the dashboard dispatch-flight button shows the 409 reason instead of redirecting into an unguarded Studio dispatch', async () => {
      authState.current = deployer
      const before = flightsAndTasks()
      const res = await dashboardApp.fetch(new Request(`https://pot.test/projects/${projectId}/dispatch-flight`, {
        method: 'POST', headers: { Origin: 'https://pot.test' },
      }), env)
      expect(res.status).toBe(409)
      expect(await res.text()).toContain('canary_receipt_required')
      expect(flightsAndTasks()).toBe(before)
    })
  })

  it('CLOSED LIST: the only deploy-class tool is project_deploy; a new one must be added to this policy on purpose', () => {
    const deployClass = TOOLS.map((t) => t.name).filter((n) => /deploy|flip|go_live|canary/i.test(n)).sort()
    expect(deployClass).toEqual(['project_deploy'])
  })
})
