import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-pmg'
const P1 = 'proj-1'
const P2 = 'proj-2'
const SQ_IN = 'squad-in'
const SQ_OUT = 'squad-out'

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function auth(squad: string): AuthContext {
  return {
    userId: 'm1', memberId: 'm1', email: null, role: 'member', tenant: TENANT,
    channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: 'm1', scope_type: 'squad', scope_id: squad, capability: 'observer' }],
  }
}

describe('project_memory_get / project_memory_list', () => {
  let h: SqliteD1Harness
  let env: Env
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d1','d','D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQ_IN}','d1','in','In'),('${SQ_OUT}','d1','out','Out');
      INSERT INTO projects (id, slug, name, status) VALUES ('${P1}','p1','P1','active'),('${P2}','p2','P2','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${P1}','${SQ_IN}','read');
    `)
  })
  afterEach(() => h.close())

  function put(id: string, scope: string, text: string, at = '2026-01-01 00:00:00') {
    h.sqlite.prepare('INSERT INTO engrams (id, agent_id, text, created_at) VALUES (?,?,?,?)').run(id, scope, text, at)
  }

  it('reader with project read gets full text and matching sha256', async () => {
    const text = 'héllo wörld ✓ 日本'
    put('e1', `project:${P1}`, text)
    const r = await invokeTool(auth(SQ_IN), env, 'project_memory_get', { project_id: P1, id: 'e1' }, 'test')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ id: 'e1', project_id: P1, text, utf8_bytes: new TextEncoder().encode(text).length, sha256: await sha(text) })
  })

  it('no project read -> 404 not_found', async () => {
    put('e1', `project:${P1}`, 'x')
    const r = await invokeTool(auth(SQ_OUT), env, 'project_memory_get', { project_id: P1, id: 'e1' }, 'test')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(404)
  })

  it('id from another project / agent-private / squad scope -> 404; missing -> same 404', async () => {
    put('other', `project:${P2}`, 's')
    put('priv', 'agent-a', 's')
    put('sq', `squad:${SQ_IN}`, 's')
    for (const id of ['other', 'priv', 'sq', 'nope']) {
      const r = await invokeTool(auth(SQ_IN), env, 'project_memory_get', { project_id: P1, id }, 'test')
      expect(r.ok, id).toBe(false)
      if (r.ok) return
      expect(r.status, id).toBe(404)
      expect(JSON.stringify(r)).not.toContain('"s"')
    }
  })

  it('46 KB text round-trips byte-exact', async () => {
    const text = ('abc é日本 line\n').repeat(3300).slice(0, 46_000)
    put('big', `project:${P1}`, text)
    const r = await invokeTool(auth(SQ_IN), env, 'project_memory_get', { project_id: P1, id: 'big' }, 'test')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as { text: string; utf8_bytes: number; sha256: string }
    expect(res.text === text).toBe(true)
    expect(res.utf8_bytes).toBe(new TextEncoder().encode(text).length)
    expect(res.utf8_bytes).toBeGreaterThan(46_000)
    expect(res.sha256).toBe(await sha(text))
  })

  it('list: newest first, fenced, gated, preview <=200 chars', async () => {
    put('a', `project:${P1}`, 'old', '2026-01-01 00:00:00')
    put('b', `project:${P1}`, 'z'.repeat(500), '2026-02-01 00:00:00')
    put('c', `project:${P2}`, 'foreign', '2026-03-01 00:00:00')
    const r = await invokeTool(auth(SQ_IN), env, 'project_memory_list', { project_id: P1 }, 'test')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const items = (r.result as { items: Array<{ id: string; preview: string; utf8_bytes: number }> }).items
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
    expect(items[0].preview.length).toBe(200)
    expect(items[0].utf8_bytes).toBe(500)
    const denied = await invokeTool(auth(SQ_OUT), env, 'project_memory_list', { project_id: P1 }, 'test')
    expect(denied.ok).toBe(false)
  })
})
