#!/usr/bin/env node
// scripts/backfill-repo-key.mjs — one-time backfill of projects.repo_key after migration 0253 (#2137 item 3).
//
// WHAT. Migration 0253 adds projects.repo_key and leaves every existing row PENDING (NULL): the canonical key
// (repoKeyFromUrl) cannot be computed in SQL. Until a row is canonicalized it still counts as an owner (the resolver
// canonicalizes it in memory at read time), so this backfill is about cost, not correctness: it moves the work off the
// read path. The maintenance cron also heals a bounded slice per tick (src/projects/repo-key-heal.ts); this script is the
// operator's way to finish in one go.
//
// SAME CANONICALIZER. The key comes from the repo's own `storedRepoKey` (src/projects/office-repo-owner.ts, which wraps
// repoKeyFromUrl), bundled on the fly with esbuild, never re-implemented here. Run it from the repo root after `npm ci`.
//
// SAFE TO RE-RUN. Each row is written with a compare-and-set on (id, repo_url, repo_key IS NULL): a row a project writer
// changed since it was read, or one already filled, is left exactly as it is. Pages by id (no OFFSET), so it is
// idempotent and may be interrupted. `--dry-run` reads and reports, writes nothing.
//
// Usage (the D1 database is NAMED, never defaulted; the wrangler config and token come from the environment):
//   node scripts/backfill-repo-key.mjs --db mupot --dry-run
//   node scripts/backfill-repo-key.mjs --db mupot [--config wrangler.toml] [--page-size 200]
//
// Deploy order for 0253 (also in the PR): apply the migration FIRST (`wrangler d1 migrations apply`), then deploy the
// Worker (its writers name repo_key), then run this backfill (optional: the cron would get there on its own).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A SQL string literal for SQLite: single-quoted, quotes doubled. SQLite strings have no backslash escapes. */
export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** Bundle the repo's canonicalizer and return its `storedRepoKey` (key, '' for no network identity, null for no URL). */
export async function loadCanonicalizer() {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'backfill-repo-key-'))
  try {
    const outfile = join(dir, 'canon.mjs')
    await esbuild.build({
      entryPoints: [join(ROOT, 'src/projects/office-repo-owner.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      logLevel: 'silent',
    })
    const mod = await import(pathToFileURL(outfile).href)
    return mod.storedRepoKey
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Walk the pending rows and give each its key.
 * `runSql(sql)` executes one SQL string against the database and resolves `{ rows, changes }` (rows of a SELECT,
 * rows changed by writes). Injected so the real run uses wrangler and the tests use a real SQLite.
 */
export async function backfill({ runSql, canonicalize, pageSize = 200, dryRun = false, log = () => {} }) {
  let after = ''
  const out = { scanned: 0, healed: 0, skipped: 0, dryRun }
  for (;;) {
    const { rows } = await runSql(
      `SELECT id, repo_url FROM projects WHERE repo_url IS NOT NULL AND repo_key IS NULL AND id > ${sqlString(after)} ORDER BY id LIMIT ${Number(pageSize)}`,
    )
    for (const row of rows) {
      out.scanned++
      const key = canonicalize(row.repo_url)
      if (key === null || key === undefined) {
        out.skipped++
        continue
      }
      if (dryRun) {
        log(`would set ${row.id} -> ${key === '' ? "''" : key}`)
        continue
      }
      const { changes } = await runSql(
        `UPDATE projects SET repo_key = ${sqlString(key)} WHERE id = ${sqlString(row.id)} AND repo_url = ${sqlString(row.repo_url)} AND repo_key IS NULL`,
      )
      if (changes > 0) out.healed++
      else out.skipped++
    }
    if (rows.length < pageSize) break
    after = rows[rows.length - 1].id
  }
  return out
}

function wranglerRunner(db, config) {
  return async (sql) => {
    const args = ['wrangler', 'd1', 'execute', db, '--remote', '--json', '--command', sql]
    if (config) args.push('--config', config)
    const raw = execFileSync('npx', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const parsed = JSON.parse(raw)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    return { rows: first?.results ?? [], changes: Number(first?.meta?.changes ?? 0) }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const db = flag('--db')
  if (!db) {
    console.error('usage: node scripts/backfill-repo-key.mjs --db <d1 database name> [--config <wrangler.toml>] [--page-size N] [--dry-run]')
    process.exit(2)
  }
  const result = await backfill({
    runSql: wranglerRunner(db, flag('--config')),
    canonicalize: await loadCanonicalizer(),
    pageSize: Number(flag('--page-size') ?? 200),
    dryRun: argv.includes('--dry-run'),
    log: (line) => console.log(line),
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
