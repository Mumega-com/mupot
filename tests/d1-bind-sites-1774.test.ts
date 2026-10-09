import { afterEach, describe, expect, it } from 'vitest'
import { D1_MAX_BOUND_PARAMETERS } from '../src/lib/d1-in-list'
import { listRunners } from '../src/runners/service'
import { syncCiResultToTask, syncTaskStatusFromIssue } from '../src/tasks/service'
import { loadLiveKeysForAgents } from '../src/dashboard/enroll'
import { COLLABORATION_ROW_CAP, loadCollaborationPanel } from '../src/dashboard/agent-profile'
import { soleSquadGrant } from '../src/im/index'
import { loadScopeNames, type ConsentableAgent } from '../src/mcp/oauth-authorize'
import { canManageProject } from '../src/dashboard/projects'
import { anySquadHasProjectWrite, hasProjectWriteForSquads } from '../src/projects/access'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { strictD1 } from './helpers/strict-d1'

// mupot#1774 — D1 refuses a statement with more than 100 bound parameters; the sqlite double
// does not. Each site below binds a list that scales with caller data (squad grants, task rows
// for one issue URL, peers, agents). strictD1 refuses what production refuses, so a reverted
// chunking turns these red. 250 > 2 chunks of 90, so the second and third chunk are exercised.

const TENANT = 'mumega'
const N = 250

const pad = (i: number): string => String(i).padStart(3, '0')
const squadId = (i: number): string => `sq-${pad(i)}`
const agentId = (i: number): string => `ag-${pad(i)}`

let open: SqliteD1Harness | null = null
afterEach(() => { open?.close(); open = null })

function fixture(squads = N, agents = 0) {
  const harness = createSqliteD1()
  open = harness
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept');`)
  const insSquad = harness.sqlite.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?, 'dept-1', ?, ?)`)
  for (let i = 0; i < squads; i += 1) insSquad.run(squadId(i), squadId(i), `Squad ${i}`)
  const insAgent = harness.sqlite.prepare(
    `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?, ?, ?, ?, 'active')`,
  )
  for (let i = 0; i < agents; i += 1) insAgent.run(agentId(i), squadId(0), agentId(i), `Agent ${i}`)
  const strict = strictD1(harness.db)
  const env = { DB: strict.db, TENANT_SLUG: TENANT } as unknown as Env
  return { harness, env, maxBound: strict.maxBound }
}

describe('mupot#1774 bind-ceiling sites', () => {
  it('listRunners merges the newest rows across squad chunks and honours limit', async () => {
    const f = fixture(N, 1)
    const ins = f.harness.sqlite.prepare(
      `INSERT INTO runner_receipts (id, tenant, seat_agent_id, squad_id, name, task, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'r', 't', 'running', ?, ?, ?)`,
    )
    // created_at rises with the squad index, so the newest rows live in the LAST chunk.
    for (let i = 0; i < N; i += 1) ins.run(`run-${pad(i)}`, TENANT, agentId(0), squadId(i), i, i, i)
    const rows = await listRunners(f.env, { squad_ids: Array.from({ length: N }, (_, i) => squadId(i)), limit: 5 })
    expect(rows.map((r) => r.id)).toEqual([249, 248, 247, 246, 245].map((i) => `run-${i}`))
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('syncTaskStatusFromIssue closes every task linked to the issue (150 > one chunk)', async () => {
    const f = fixture(1)
    const url = 'https://github.com/o/r/issues/9'
    const ins = f.harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, github_issue_url) VALUES (?, ?, 't', '', 'd', 'open', ?)`,
    )
    for (let i = 0; i < 150; i += 1) ins.run(`task-${pad(i)}`, squadId(0), url)
    expect(await syncTaskStatusFromIssue(f.env, url, 'closed')).toEqual({ updated: true })
    expect(f.harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'`).get()).toEqual({ n: 150 })
    expect(await syncTaskStatusFromIssue(f.env, url, 'reopened')).toEqual({ updated: true })
    expect(f.harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'`).get()).toEqual({ n: 150 })
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('syncCiResultToTask writes the note on every PR-linked task (150 > one chunk)', async () => {
    const f = fixture(1)
    const ins = f.harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, github_issue_url) VALUES (?, ?, 't', '', 'd', 'review', 'https://github.com/o/r/pull/7')`,
    )
    for (let i = 0; i < 150; i += 1) ins.run(`task-${pad(i)}`, squadId(0))
    expect(await syncCiResultToTask(f.env, 7, 'failure')).toEqual({ updated: true })
    expect(f.harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'in_progress' AND result = 'CI: failure'`).get())
      .toEqual({ n: 150 })
    expect(await syncCiResultToTask(f.env, 7, 'success')).toEqual({ updated: true })
    expect(f.harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE result = 'CI: success'`).get()).toEqual({ n: 150 })
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('loadLiveKeysForAgents returns keys for agents beyond the first chunk', async () => {
    const f = fixture(1, 150)
    const insMember = f.harness.sqlite.prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, 'M', 'active', ?)`,
    )
    for (let i = 0; i < 150; i += 1) insMember.run(`m-${i}`, `m${i}@x.test`, TENANT)
    const bind = f.harness.sqlite.prepare(
      `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, datetime('now'))`,
    )
    for (let i = 0; i < 150; i += 1) bind.run(TENANT, agentId(i), `m-${i}`)
    const ins = f.harness.sqlite.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES (?, ?, ?, ?, 'workspace', ?, ?, ?)`,
    )
    for (let i = 0; i < 150; i += 1) ins.run(`tok-${i}`, `m-${i}`, `hash-${i}`, `k${i}`, '2026-01-01 00:00:00', agentId(i), TENANT)
    const ids = Array.from({ length: 150 }, (_, i) => agentId(i))
    const map = await loadLiveKeysForAgents(f.env, ids)
    expect(map.size).toBe(150)
    expect(map.get(agentId(149))?.[0]?.label).toBe('k149')
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('loadCollaborationPanel names peers beyond the first chunk (fails soft otherwise)', async () => {
    const f = fixture(1, 150)
    const ins = f.harness.sqlite.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body) VALUES (?, ?, ?, ?, 'm', 'hi')`,
    )
    for (let i = 1; i < 150; i += 1) ins.run(`msg-${i}`, TENANT, agentId(0), agentId(i))
    expect(150).toBeLessThan(COLLABORATION_ROW_CAP)
    const panel = await loadCollaborationPanel(f.env, agentId(0))
    expect(panel.state).toBe('ready')
    const names = new Set(panel.data?.collaborators.map((c) => c.name))
    expect(names.size).toBe(149)
    expect(names.has('Agent 149')).toBe(true)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('soleSquadGrant counts non-home squads across chunks', async () => {
    const f = fixture(N)
    // Every squad is a home squad except the last, which lives in the third chunk.
    f.harness.sqlite.exec(`UPDATE squads SET kind = 'home' WHERE id != '${squadId(N - 1)}'`)
    const grants: CapabilityGrant[] = Array.from({ length: N }, (_, i) => ({
      member_id: 'm', scope_type: 'squad', scope_id: squadId(i), capability: 'member',
    }))
    expect(await soleSquadGrant(f.env, grants)).toBe(squadId(N - 1))
    f.harness.sqlite.exec(`UPDATE squads SET kind = 'work' WHERE id = '${squadId(0)}'`)
    expect(await soleSquadGrant(f.env, grants)).toBeNull() // two non-home squads, in different chunks
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('loadScopeNames labels squads beyond the first chunk (fails soft otherwise)', async () => {
    const f = fixture(N)
    const agent: ConsentableAgent = {
      id: 'a', slug: 'a', name: 'A', squad_id: squadId(0), squad_name: 'S', autonomy: 'supervised',
      budget_cap_cents: null, budget_window: 'month',
      capabilities: Array.from({ length: N }, (_, i) => ({
        member_id: 'm', scope_type: 'squad', scope_id: squadId(i), capability: 'member',
      })),
    }
    const names = await loadScopeNames(f.env, [agent])
    expect(names.squads.size).toBe(N)
    expect(names.squads.get(squadId(N - 1))).toBe(`Squad ${N - 1}`)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('project squad-access checks see a writable squad in a later chunk', async () => {
    const f = fixture(N)
    f.harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'p1', 'P1', 'active');
    `)
    const insAccess = f.harness.sqlite.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', ?, ?)`,
    )
    const all = Array.from({ length: N }, (_, i) => squadId(i))
    for (const id of all) insAccess.run(id, id === squadId(N - 1) ? 'write' : 'read')
    expect(await anySquadHasProjectWrite(f.env, 'proj-1', all)).toBe(true)
    expect(await hasProjectWriteForSquads(f.env, 'proj-1', all)).toBe(false) // 249 observers
    f.harness.sqlite.exec(`UPDATE project_squad_access SET access_level = 'write'`)
    expect(await hasProjectWriteForSquads(f.env, 'proj-1', all)).toBe(true)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('canManageProject authorizes through a squad grant beyond the first chunk', async () => {
    const f = fixture(N)
    f.harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'p1', 'P1', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', '${squadId(N - 1)}', 'write');
    `)
    const auth = {
      userId: 'm', memberId: 'm', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
      boundAgentId: null,
      capabilities: Array.from({ length: N }, (_, i) => ({
        member_id: 'm', scope_type: 'squad', scope_id: squadId(i), capability: 'member',
      })),
    } as unknown as AuthContext // minimal AuthContext fixture; only the fields projectAccess reads
    expect(await canManageProject(f.env, auth, 'proj-1')).toBe(true)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })
})
