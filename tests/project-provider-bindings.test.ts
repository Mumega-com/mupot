import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import {
  getProjectBinding,
  listProjectBindings,
  removeProjectBinding,
  upsertProjectBinding,
} from '../src/projects/providers/bindings'
import { isProjectBoardProvider, PROJECT_BOARD_PROVIDERS } from '../src/projects/providers/port'
import { isConnectorType } from '../src/connectors/crypto'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const THROUGH = '0060_project_provider_bindings.sql'

function applyThrough(sqlite: { exec(sql: string): void }, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name <= throughFile).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

describe('project provider bindings', () => {
  it('exposes github_projects, linear, and notion as board providers', () => {
    expect(PROJECT_BOARD_PROVIDERS).toEqual(['github_projects', 'linear', 'notion'])
    expect(isProjectBoardProvider('notion')).toBe(true)
    expect(isConnectorType('notion')).toBe(true)
    expect(isConnectorType('linear')).toBe(true)
  })

  it('upserts and lists bindings on an active project', async () => {
    const { sqlite, db, close } = createSqliteD1()
    try {
      applyThrough(sqlite, THROUGH)
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj', 'Proj', 'active');
      `)
      const env = { DB: db } as never
      const created = await upsertProjectBinding(env, 'proj-1', {
        provider: 'github_projects',
        external_id: 'Mumega-com/12',
        meta: { agent_field: 'Agent' },
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.value.external_id).toBe('Mumega-com/12')
      const listed = await listProjectBindings(env, 'proj-1')
      expect(listed).toHaveLength(1)
      const got = await getProjectBinding(env, 'proj-1', 'github_projects')
      expect(got?.provider).toBe('github_projects')
      const removed = await removeProjectBinding(env, 'proj-1', 'github_projects')
      expect(removed.ok).toBe(true)
      expect(await listProjectBindings(env, 'proj-1')).toEqual([])
    } finally {
      close()
    }
  })

  it('rejects bindings on archived projects', async () => {
    const { sqlite, db, close } = createSqliteD1()
    try {
      applyThrough(sqlite, THROUGH)
      sqlite.exec(`
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'archived', 'Archived', 'archived');
      `)
      const env = { DB: db } as never
      const result = await upsertProjectBinding(env, 'proj-a', {
        provider: 'linear',
        external_id: 'ENG',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('archived_project')
    } finally {
      close()
    }
  })
})
