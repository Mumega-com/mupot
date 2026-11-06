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
