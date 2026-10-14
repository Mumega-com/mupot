import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { createSqliteD1 } from './sqlite-d1'
import { applyAllMigrationsUncached, captureMigrationSnapshot } from './migrations'

// A unique directory per invocation/shard prevents stale or cross-worktree reuse.
// No application globals or database instances are shared between isolated tests.
export default function setup(project: TestProject) {
  const directory = mkdtempSync(join(tmpdir(), 'mupot-test-schema-'))
  const path = join(directory, 'schema.json')
  function rebuild() {
    const harness = createSqliteD1()
    try {
      applyAllMigrationsUncached(harness.sqlite)
      writeFileSync(`${path}.next`, JSON.stringify(captureMigrationSnapshot(harness.sqlite)))
      renameSync(`${path}.next`, path)
    } finally {
      harness.close()
    }
  }
  try {
    rebuild()
    project.provide('mupotMigrationSnapshotPath', path)
    // Also rebuild between watch reruns; changing a migration cannot reuse old DDL.
    project.onTestsRerun(rebuild)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return () => rmSync(directory, { recursive: true, force: true })
}
