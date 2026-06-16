#!/usr/bin/env node
// mupot-update — push the current mupot core to a pot (or all pots).
//
// The thing that makes "we deployed → pots updated" true. Each pot is a separate
// CF Worker; this orchestrates the per-pot deploy + migrations from one command.
//
//   node scripts/mupot-update.mjs <slug|--all> [--apply] [--force] [--json]
//
// SAFE BY DEFAULT — a bare run is a DRY RUN: it reports each pot's pending D1
// migrations + the deploy target and does NOTHING. Pass --apply to actually apply
// migrations + deploy. A pending migration with a DESTRUCTIVE statement (DROP /
// DELETE FROM / TRUNCATE / RENAME / DROP COLUMN) ABORTS that pot unless --force —
// the digid/viamar D1-drift landmine, codified.
//
// Customer pots: deploying them is the owner's call. This is a deliberate tool,
// never auto. Run it, read the dry-run, then --apply.

import { readFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESTRUCTIVE = /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bRENAME\s+TO\b/i
// Bindings the current core REQUIRES at runtime. A config missing any of these can
// still `wrangler deploy` + pass /health while OAuth/MCP/DO paths are broken — so
// we preflight the config text. (OAuthProvider needs OAUTH_KV; the DOs + workflow
// are class-bound; the rest are resource bindings.)
const REQUIRED_BINDINGS = ['DB', 'VEC', 'BUS', 'SESSIONS', 'OAUTH_KV', 'BLOBS', 'AI', 'AGENT', 'SQUAD', 'TASK_WORKFLOW']
const ALLOWED_REF = 'main'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const FORCE = args.includes('--force')
const ALLOW_DIRTY = args.includes('--allow-dirty')
const JSON_OUT = args.includes('--json')
const target = args.includes('--all') ? '--all' : args.find((a) => !a.startsWith('--'))

function die(msg) {
  console.error(`✘ ${msg}`)
  process.exit(1)
}
function sh(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { cwd: REPO, encoding: 'utf8', ...opts })
}

if (!target) die('usage: mupot-update <slug|--all> [--apply] [--force] [--json]')

const manifest = JSON.parse(readFileSync(join(REPO, 'pots.manifest.json'), 'utf8'))
const all = manifest.pots
const targets = target === '--all' ? all : all.filter((p) => p.slug === target)
if (targets.length === 0) die(`unknown pot '${target}'. Known: ${all.map((p) => p.slug).join(', ')}`)

// ── source-state guard (BLOCK-2): never push a dirty tree or a non-main ref to a
// customer pot without an explicit override. Reported in dry-run + apply.
function gitState() {
  const branch = (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim()
  const sha = (sh('git', ['rev-parse', '--short', 'HEAD']).stdout || '').trim()
  const dirty = ((sh('git', ['status', '--porcelain']).stdout || '').trim().length) > 0
  return { branch, sha, dirty }
}
const GIT = gitState()

if (APPLY) {
  if (GIT.dirty && !ALLOW_DIRTY) {
    die(`refusing to --apply with a DIRTY working tree (${GIT.branch}@${GIT.sha}). Commit/stash, or pass --allow-dirty.`)
  }
  if (GIT.branch !== ALLOWED_REF && !ALLOW_DIRTY) {
    die(`refusing to --apply from ref '${GIT.branch}' (not '${ALLOWED_REF}'). Switch to ${ALLOWED_REF}, or pass --allow-dirty to override.`)
  }
}

// ── binding preflight (BLOCK-1): a config missing a required current-core binding
// can deploy + pass /health while OAuth/MCP/DO paths break. Read the config text.
function missingBindings(configPath) {
  if (!configPath) return [] // mumega: the repo default wrangler.toml is canonical.
  let text
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return ['<config_unreadable>']
  }
  return REQUIRED_BINDINGS.filter((b) => !text.includes(`"${b}"`))
}

const localMigrations = readdirSync(join(REPO, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()

/** Applied migration names on the remote DB (via the d1_migrations table). */
function appliedMigrations(db, config) {
  const cfg = config ? ['--config', config] : []
  const r = sh('npx', [
    'wrangler', 'd1', 'execute', db, '--remote', '--json',
    ...cfg, '--command', 'SELECT name FROM d1_migrations ORDER BY id',
  ])
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').slice(-400) }
  // wrangler prints a banner before the JSON — extract the array.
  const s = r.stdout
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON in d1 output (db may be empty/new)' }
  try {
    const out = JSON.parse(s.slice(start, end + 1))
    return { ok: true, names: (out[0]?.results ?? []).map((x) => x.name) }
  } catch {
    return { ok: false, error: 'could not parse d1_migrations json' }
  }
}

function classifyPending(pending) {
  const destructive = pending.filter((f) => DESTRUCTIVE.test(readFileSync(join(REPO, 'migrations', f), 'utf8')))
  return { pending, destructive }
}

/** Copy a tenant config into the repo root so relative main/migrations_dir resolve. */
function withConfig(config, fn) {
  if (!config) return fn(null) // mumega: default wrangler.toml
  const tmp = join(REPO, '.mupot-update.tmp.toml')
  copyFileSync(resolve(REPO, config), tmp)
  try {
    return fn(tmp)
  } finally {
    rmSync(tmp, { force: true })
  }
}

const report = []
for (const pot of targets) {
  const line = { slug: pot.slug, db: pot.db }
  const applied = appliedMigrations(pot.db, pot.config ? resolve(REPO, pot.config) : null)
  if (!applied.ok) {
    line.status = 'migration_check_failed'
    line.detail = applied.error
    report.push(line)
    continue
  }
  const pending = localMigrations.filter((f) => !applied.names.includes(f))
  const { destructive } = classifyPending(pending)
  const missing = missingBindings(pot.config ? resolve(REPO, pot.config) : null)
  line.applied = applied.names.length
  line.pending = pending
  line.destructive = destructive
  line.missingBindings = missing

  if (!APPLY) {
    // --apply ALWAYS redeploys the code; migrations only when pending. We can't
    // yet detect code-version drift (no version marker in /health — a follow-up),
    // so we never claim "up-to-date": --apply will push current code regardless.
    line.status = missing.length
      ? 'BLOCKED_missing_bindings'
      : pending.length
        ? 'would-migrate+deploy'
        : 'would-deploy'
    report.push(line)
    continue
  }
  // BLOCK-1 guard: a config missing required bindings would deploy + pass /health
  // while OAuth/MCP/DO break. Refuse unless explicitly forced.
  if (missing.length && !FORCE) {
    line.status = 'ABORTED_missing_bindings'
    line.hint = `config is missing required binding(s): ${missing.join(', ')} — fix the tenant config (or --force)`
    report.push(line)
    continue
  }
  if (destructive.length && !FORCE) {
    line.status = 'ABORTED_destructive'
    line.hint = 'destructive pending migration — verify the D1 manually, then re-run with --force'
    report.push(line)
    continue
  }

  // APPLY: migrations → deploy → verify.
  const ok = withConfig(pot.config, (tmp) => {
    const cfg = tmp ? ['--config', tmp] : []
    if (pending.length) {
      const m = sh('npx', ['wrangler', 'd1', 'migrations', 'apply', pot.db, '--remote', ...cfg], {
        input: 'y\n', stdio: ['pipe', 'inherit', 'inherit'],
      })
      if (m.status !== 0) return { ok: false, step: 'migrations' }
    }
    const d = sh('npx', ['wrangler', 'deploy', ...cfg], { stdio: ['ignore', 'inherit', 'inherit'] })
    if (d.status !== 0) return { ok: false, step: 'deploy' }
    return { ok: true }
  })
  if (!ok.ok) {
    line.status = `FAILED_${ok.step}`
    report.push(line)
    continue
  }
  // health verify
  try {
    const res = await fetch(pot.health, { signal: AbortSignal.timeout(12000) })
    const body = await res.json().catch(() => ({}))
    line.status = res.ok && body.ok ? 'updated' : 'deployed_unhealthy'
    line.health = `${res.status} tenant=${body.tenant ?? '?'}`
  } catch {
    line.status = 'deployed_health_unreachable'
  }
  report.push(line)
}

if (JSON_OUT) {
  console.log(JSON.stringify({ apply: APPLY, git: GIT, report }, null, 2))
} else {
  const gitLabel = `${GIT.branch}@${GIT.sha}${GIT.dirty ? ' (DIRTY)' : ''}`
  console.log(`\nmupot-update — ${APPLY ? 'APPLY' : 'DRY RUN'} · source ${gitLabel} · ${targets.length} pot${targets.length === 1 ? '' : 's'}\n`)
  for (const r of report) {
    const p = r.pending ? `${r.pending.length} pending${r.destructive?.length ? ` (${r.destructive.length} DESTRUCTIVE)` : ''}` : '—'
    const miss = r.missingBindings?.length ? ` · MISSING: ${r.missingBindings.join(',')}` : ''
    console.log(`  ${r.slug.padEnd(10)} ${String(r.status).padEnd(28)} migrations: ${p}${miss}${r.health ? ` · health ${r.health}` : ''}${r.detail ? ` · ${r.detail}` : ''}`)
  }
  if (!APPLY) console.log(`\n(dry run — pass --apply to apply migrations + deploy)`)
}

const failed = report.some((r) => /FAILED|ABORTED|failed|unhealthy/.test(r.status))
process.exit(failed ? 1 : 0)
