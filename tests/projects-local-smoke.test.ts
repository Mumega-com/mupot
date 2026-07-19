import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const REPO_ROOT = join(__dirname, '..')
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations')
const SEED_PATH = join(REPO_ROOT, 'scripts', 'local-test-seed.sql')
const BROWSER_SMOKE_PATH = join(REPO_ROOT, 'scripts', 'local-browser-smoke.mjs')
const README_PATH = join(REPO_ROOT, 'README.md')

function createSeededDatabase() {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(readFileSync(SEED_PATH, 'utf8'))
  return harness
}

describe('local project workspace showcase', () => {
  it('seeds the signed inbox fence required by runtime conformance after browser evidence', () => {
    const harness = createSeededDatabase()
    try {
      const fence = harness.sqlite.prepare(`
        SELECT mode, generation, key_fingerprint, updated_by_member_id, reason
        FROM agent_inbox_fences
        WHERE tenant = 'local' AND agent_id = 'agent-conformance'
      `).get() as {
        mode: string
        generation: number
        key_fingerprint: string
        updated_by_member_id: string
        reason: string
      } | undefined
      const runtimeKey = harness.sqlite.prepare(`
        SELECT pubkey
        FROM agent_keys
        WHERE tenant = 'local' AND agent_id = 'agent-conformance'
      `).get() as { pubkey: string } | undefined

      if (!fence || !runtimeKey) throw new Error('local runtime conformance fixture is incomplete')

      const fingerprint = createHash('sha256').update(runtimeKey.pubkey).digest('hex')
      expect(fingerprint).toBe('6d4c5cc496a08ce3785f212e13b532c1fc7ee98a905c3d55debb48b1d13f690e')

      expect(fence).toEqual({
        mode: 'signed_only',
        generation: 1,
        key_fingerprint: fingerprint,
        updated_by_member_id: 'mbr-conformance-runtime',
        reason: expect.any(String),
      })
      expect(fence.reason).not.toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  it('seeds the exact Mumega root and child portfolio', () => {
    const harness = createSeededDatabase()
    try {
      const projects = harness.sqlite.prepare(`
        SELECT id, name, parent_project_id
        FROM projects
        ORDER BY id
      `).all()

      expect(projects).toEqual([
        { id: 'project-inkwell', name: 'Inkwell', parent_project_id: 'project-mumega-products' },
        { id: 'project-marketing-infrastructure', name: 'Marketing Infrastructure', parent_project_id: null },
        { id: 'project-mcpwp', name: 'MCPWP', parent_project_id: 'project-marketing-infrastructure' },
        { id: 'project-mirror', name: 'Mirror', parent_project_id: 'project-mumega-products' },
        { id: 'project-mumcp', name: 'MumCP', parent_project_id: 'project-marketing-infrastructure' },
        { id: 'project-mumega-products', name: 'Mumega Products', parent_project_id: null },
        { id: 'project-mupot', name: 'Mupot', parent_project_id: 'project-mumega-products' },
        { id: 'project-sos', name: 'SOS', parent_project_id: 'project-mumega-products' },
      ])
    } finally {
      harness.close()
    }
  })

  it('replays idempotently while enforcing one child level and explicit squad access', () => {
    const harness = createSeededDatabase()
    try {
      expect(() => harness.sqlite.exec(readFileSync(SEED_PATH, 'utf8'))).not.toThrow()

      expect(harness.sqlite.prepare(`
        SELECT id FROM projects WHERE parent_project_id IS NULL ORDER BY id
      `).all()).toEqual([
        { id: 'project-marketing-infrastructure' },
        { id: 'project-mumega-products' },
      ])
      expect(harness.sqlite.prepare(`
        WITH RECURSIVE project_depth(id, depth) AS (
          SELECT id, 0 FROM projects WHERE parent_project_id IS NULL
          UNION ALL
          SELECT child.id, parent.depth + 1
          FROM projects child
          JOIN project_depth parent ON child.parent_project_id = parent.id
        )
        SELECT COUNT(*) AS count FROM project_depth WHERE depth > 1
      `).get()).toEqual({ count: 0 })
      expect(harness.sqlite.prepare(`
        SELECT project_id, squad_id, access_level
        FROM project_squad_access
        ORDER BY project_id
      `).all()).toEqual([
        { project_id: 'project-inkwell', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-marketing-infrastructure', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mcpwp', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mirror', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mumcp', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mumega-products', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-mupot', squad_id: 'sq-growth', access_level: 'write' },
        { project_id: 'project-sos', squad_id: 'sq-growth', access_level: 'write' },
      ])
    } finally {
      harness.close()
    }
  })

  it('attributes representative governed work to Mupot and preserves nullable legacy rows', () => {
    const harness = createSeededDatabase()
    try {
      expect(harness.sqlite.prepare(`
        SELECT id, project_id FROM tasks
        WHERE id LIKE 'task-%-local'
        ORDER BY id
      `).all()).toEqual([
        { id: 'task-done-local', project_id: 'project-mupot' },
        { id: 'task-open-local', project_id: null },
        { id: 'task-progress-local', project_id: 'project-mupot' },
        { id: 'task-review-local', project_id: null },
      ])
      const flights = harness.sqlite.prepare(`
        SELECT id, project_id, meta FROM flights
        WHERE id LIKE 'flight-%-local'
        ORDER BY id
      `).all() as Array<{ id: string; project_id: string | null; meta: string }>
      expect(flights.map(({ id, project_id }) => ({ id, project_id }))).toEqual([
        { id: 'flight-landed-local', project_id: 'project-mupot' },
        { id: 'flight-running-local', project_id: 'project-mupot' },
        { id: 'flight-sleeping-local', project_id: null },
      ])
      expect(flights.filter((flight) => flight.project_id === 'project-mupot').map((flight) => {
        const meta = JSON.parse(flight.meta) as { schema: string; task_ids: string[] }
        return { id: flight.id, schema: meta.schema, task_ids: meta.task_ids }
      })).toEqual([
        {
          id: 'flight-landed-local',
          schema: 'mupot.flight.meta/v1',
          task_ids: ['task-done-local'],
        },
        {
          id: 'flight-running-local',
          schema: 'mupot.flight.meta/v1',
          task_ids: ['task-progress-local'],
        },
      ])
    } finally {
      harness.close()
    }
  })

  it('keeps the browser crawl and adds desktop and mobile project workspace checks', () => {
    const smoke = readFileSync(BROWSER_SMOKE_PATH, 'utf8')

    expect(smoke).toContain("'/projects'")
    expect(smoke).toContain("'/projects/project-mupot'")
    expect(smoke).toContain('Mumega Products')
    expect(smoke).toContain('Marketing Infrastructure')
    expect(smoke).toContain('/send?project_id=project-mupot')
    expect(smoke).toContain('/flights?project_id=project-mupot')
    expect(smoke).toContain("['Home', 'Projects', 'Work', 'Approvals']")
    expect(smoke).toContain('width: 390, height: 844')
    expect(smoke).toMatch(/scrollWidth\s*-\s*document\.documentElement\.clientWidth/)
    expect(smoke).toContain('await runProjectWorkspaceWorkflow()')
  })

  it('documents the pot and bounded project model without coupling Mupot to SOS', () => {
    const readme = readFileSync(README_PATH, 'utf8')

    expect(readme).toContain('## Pots and projects')
    expect(readme).toMatch(/one child level/i)
    expect(readme).toMatch(/provider-neutral/i)
    expect(readme).toMatch(/SOS is not (?:a|an) (?:runtime|architecture|architectural) dependency/i)
    expect(readme).toContain('npm test -- tests/projects-local-smoke.test.ts')
    expect(readme).toContain('npm run seed:local:test')
  })
})
