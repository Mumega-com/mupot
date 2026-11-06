import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { MAINTENANCE_CRON, MAINTENANCE_FIRING_MINUTES, maintenanceSlot } from '../src/scheduled/slots'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({ OAuthProvider: class {} }))
const { default: worker } = await import('../src/index')

// Derive a firing minute from the actual array, then execute the actual scheduled handler.
// Renumbering maintenance entries cannot silently turn this into a test of a different job.
async function tick(env: Env, label: string): Promise<void> {
  const source=readFileSync(new URL('../src/index.ts', import.meta.url),'utf8')
  const array=source.slice(source.indexOf('const maintenance:'),source.indexOf('const heartbeat = maintenance'))
  const labels=[...array.matchAll(/\['([^']+)',/g)].map(m=>m[1])
  expect(labels).toContain(label)
  const index=labels.indexOf(label)
  const minute=MAINTENANCE_FIRING_MINUTES.find(m=>maintenanceSlot(m,labels.length)===index)
  expect(minute).toBeDefined()
  const work:Promise<unknown>[]=[]
  await worker.scheduled({scheduledTime:Date.UTC(2026,10,6,16,minute!),cron:MAINTENANCE_CRON} as ScheduledController,env,{waitUntil(p:Promise<unknown>){work.push(p)}} as ExecutionContext)
  await Promise.all(work)
}

describe('maintenance lifecycle exits',()=>{
  it('expires elevation requests from its reachable maintenance slot without any list or decision request',async()=>{
    const h=createSqliteD1();applyAllMigrations(h.sqlite)
    const env={DB:h.db,TENANT_SLUG:'tenant'} as Env
    try {
      h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D');
        INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S');
        INSERT INTO agents(id,squad_id,slug,name,status) VALUES('a','s','a','A','active');
        INSERT INTO members(id,tenant,display_name,status) VALUES('m','tenant','M','active');
        INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('tenant','a','m',datetime('now'));
        INSERT INTO member_tokens(id,tenant,member_id,agent_id,token_hash,channel) VALUES('t','tenant','m','a','fixture-hash','workspace');`)
      const {createAgentSession}=await import('../src/auth/agent-sessions')
      const session=await createAgentSession(env,{tenant:'tenant',agentId:'a',memberId:'m',authKind:'workspace_token',credentialId:'t'})
      h.sqlite.prepare(`INSERT INTO elevation_requests(id,tenant,agent_session_id,agent_id,member_id,requested_actions_json,requested_scope_type,requested_scope_id,requested_duration_minutes,reason,status,created_at,decision_expires_at)
        VALUES('cron-expired','tenant',?,'a','m','["action:manage_access"]','squad','s',60,'expiry','pending','2020-01-01T00:00:00.000Z','2020-01-01T00:10:00.000Z')`).run(session.id)
      await tick(env,'elevation-expiry')
      expect(h.sqlite.prepare("SELECT status FROM elevation_requests WHERE id='cron-expired'").get()).toEqual({status:'expired'})
      await tick(env,'elevation-expiry')
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM elevation_grants').get()).toEqual({n:0})
    } finally {h.close()}
  })

  it('expires stale proposals from its reachable maintenance slot without archiving tasks',async()=>{
    const h=createSqliteD1();applyAllMigrations(h.sqlite)
    try {
      h.sqlite.prepare(`INSERT INTO archive_proposals(id,tenant,task_id,proposed_by_agent_id,reason,task_status_at_proposal,created_at) VALUES('old','tenant','task','agent','old','open','2020-01-01T00:00:00.000Z')`).run()
      await tick({DB:h.db,TENANT_SLUG:'tenant'} as Env,'archive-proposal-expiry')
      expect(h.sqlite.prepare("SELECT decision,decided_at FROM archive_proposals WHERE id='old'").get()).toEqual({decision:'expired',decided_at:expect.any(String)})
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM tasks_archive_state').get()).toEqual({n:0})
      await tick({DB:h.db,TENANT_SLUG:'tenant'} as Env,'archive-proposal-expiry')
      expect(h.sqlite.prepare("SELECT count(*) AS n FROM archive_proposals WHERE decision='expired'").get()).toEqual({n:1})
    } finally {h.close()}
  })
})
