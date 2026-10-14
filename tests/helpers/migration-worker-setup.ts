import { readFileSync } from 'node:fs'
import { inject } from 'vitest'
import { useMigrationSnapshot } from './migrations'

declare module 'vitest' {
  export interface ProvidedContext {
    mupotMigrationSnapshotPath: string
  }
}

// Runs in each isolated test-file worker. Only immutable migration-derived DDL
// crosses the boundary; every test still owns its own in-memory SQLite database.
// Missing/unreadable/invalid snapshots fail the suite rather than bypass setup.
const path = inject('mupotMigrationSnapshotPath')
if (!path) throw new Error('global migration snapshot was not provided')
useMigrationSnapshot(JSON.parse(readFileSync(path, 'utf8')))
