#!/usr/bin/env node
// fleet-runtime installer — non-destructive host layout bootstrap.
//
// This lays down the host-side runtime scripts, systemd user units, and editable
// config templates under ~/.fleet. It does not register keys, write secrets, or
// claim host readiness. Run host-receipt.mjs after editing the generated config.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

const CONFIG_TEMPLATES = [
  ['daemon.example.json', 'daemon.json'],
  ['inbox-handler.example.json', 'inbox-handler.json'],
  ['control.example.json', 'control.json'],
  ['flights.example.json', 'flights.json'],
]

const SERVICE_FILES = [
  'fleet-daemon.service',
  'fleet-control-daemon.service',
]

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function defaultPaths() {
  return {
    sourceDir: DEFAULT_SOURCE_DIR,
    prefix: join(homedir(), '.fleet'),
    systemdDir: join(homedir(), '.config', 'systemd', 'user'),
  }
}

function parseArgs(argv) {
  const defaults = defaultPaths()
  const opts = {
    sourceDir: defaults.sourceDir,
    prefix: defaults.prefix,
    systemdDir: defaults.systemdDir,
    skipSystemd: false,
    forceConfig: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return pathArg(argv[i])
    }
    if (arg === '--source') opts.sourceDir = next()
    else if (arg === '--prefix') opts.prefix = next()
    else if (arg === '--systemd-dir') opts.systemdDir = next()
    else if (arg === '--skip-systemd') opts.skipSystemd = true
    else if (arg === '--force-config') opts.forceConfig = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/install.mjs [options]',
    '',
    'Options:',
    '  --source <path>       fleet-runtime source directory (default: this script directory)',
    '  --prefix <path>       fleet runtime home (default: ~/.fleet)',
    '  --systemd-dir <path>  systemd user unit directory (default: ~/.config/systemd/user)',
    '  --skip-systemd        do not install systemd user unit files',
    '  --force-config        overwrite existing daemon/control/inbox/flights config files',
    '  --dry-run             print planned actions without writing files',
    '  -h, --help            show this help',
    '',
    'After install, edit ~/.fleet/*.json, place keys, then run host-receipt.mjs.',
  ].join('\n')
}

function summarize(checks) {
  const failed = checks.filter((c) => c.ok === false)
  const warnings = checks.filter((c) => c.ok === null)
  return {
    status: failed.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    passed: checks.length - failed.length - warnings.length,
    failed: failed.length,
    warnings: warnings.length,
  }
}

function modeOf(path) {
  try {
    return (statSync(path).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

function ensureDir(path, mode, checks, opts, label) {
  try {
    const existed = existsSync(path)
    if (!opts.dryRun) {
      mkdirSync(path, { recursive: true, mode })
      if (!existed) chmodSync(path, mode)
    }
    checks.push({
      ok: true,
      component: 'fleet-install',
      check: `${label}_dir_ready`,
      path,
      mode: opts.dryRun ? mode.toString(8) : modeOf(path),
      existed,
      dry_run: Boolean(opts.dryRun),
    })
  } catch (err) {
    checks.push({
      ok: false,
      component: 'fleet-install',
      check: `${label}_dir_ready`,
      path,
      reason: String(err && err.message ? err.message : err),
    })
  }
}

function copyFile(src, dest, checks, opts, label, mode = 0o644) {
  try {
    if (!opts.dryRun) {
      copyFileSync(src, dest)
      chmodSync(dest, mode)
    }
    checks.push({
      ok: true,
      component: 'fleet-install',
      check: `${label}_copied`,
      source: src,
      path: dest,
      mode: opts.dryRun ? mode.toString(8) : modeOf(dest),
      dry_run: Boolean(opts.dryRun),
    })
  } catch (err) {
    checks.push({
      ok: false,
      component: 'fleet-install',
      check: `${label}_copied`,
      source: src,
      path: dest,
      reason: String(err && err.message ? err.message : err),
    })
  }
}

function runtimeFiles(sourceDir) {
  try {
    return readdirSync(sourceDir)
      .filter((name) => name.endsWith('.mjs'))
      .filter((name) => !name.endsWith('.test.mjs'))
      .sort()
  } catch {
    return []
  }
}

function collectSourceChecks(sourceDir, checks) {
  let ok = true
  try {
    const st = statSync(sourceDir)
    ok = st.isDirectory()
  } catch {
    ok = false
  }
  checks.push({
    ok,
    component: 'fleet-install',
    check: 'source_dir_present',
    path: sourceDir,
  })
  return ok
}

export async function buildReceipt(opts) {
  const checks = []
  const sourceDir = pathArg(opts.sourceDir ?? DEFAULT_SOURCE_DIR)
  const prefix = pathArg(opts.prefix ?? join(homedir(), '.fleet'))
  const systemdDir = pathArg(opts.systemdDir ?? join(homedir(), '.config', 'systemd', 'user'))
  const runtimeDir = join(prefix, 'runtime')
  const agentsDir = join(prefix, 'agents')
  const handlersDir = join(prefix, 'handlers')
  const inboxDir = join(prefix, 'inbox')
  const receiptsDir = join(prefix, 'receipts')

  const sourceOk = collectSourceChecks(sourceDir, checks)
  ensureDir(prefix, 0o700, checks, opts, 'fleet_home')
  ensureDir(runtimeDir, 0o700, checks, opts, 'runtime')
  ensureDir(agentsDir, 0o700, checks, opts, 'agents')
  ensureDir(handlersDir, 0o700, checks, opts, 'handlers')
  ensureDir(inboxDir, 0o700, checks, opts, 'inbox')
  ensureDir(receiptsDir, 0o700, checks, opts, 'receipts')
  if (!opts.skipSystemd) ensureDir(systemdDir, 0o700, checks, opts, 'systemd_user')

  const installedRuntime = []
  if (sourceOk) {
    const files = runtimeFiles(sourceDir)
    checks.push({
      ok: files.length > 0,
      component: 'fleet-install',
      check: 'runtime_files_discovered',
      count: files.length,
    })
    for (const name of files) {
      const src = join(sourceDir, name)
      const dest = join(runtimeDir, name)
      copyFile(src, dest, checks, opts, 'runtime_file', 0o644)
      installedRuntime.push(dest)
    }

    for (const [srcName, destName] of CONFIG_TEMPLATES) {
      const src = join(sourceDir, srcName)
      const dest = join(prefix, destName)
      if (existsSync(dest) && !opts.forceConfig) {
        checks.push({
          ok: true,
          component: 'fleet-install',
          check: 'config_preserved',
          source: src,
          path: dest,
        })
        continue
      }
      copyFile(src, dest, checks, opts, 'config_template', 0o600)
      checks.push({
        ok: null,
        component: 'fleet-install',
        check: 'config_needs_edit',
        path: dest,
        reason: 'template_contains_placeholders',
      })
    }

    if (opts.skipSystemd) {
      checks.push({ ok: null, component: 'fleet-install', check: 'systemd_skipped' })
    } else {
      for (const name of SERVICE_FILES) {
        copyFile(join(sourceDir, name), join(systemdDir, name), checks, opts, 'systemd_unit', 0o644)
      }
    }
  }

  const summary = summarize(checks)
  return {
    receipt_type: 'mupot-fleet-install-receipt/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      source_dir: sourceDir,
      prefix,
      systemd_dir: opts.skipSystemd ? null : systemdDir,
      skip_systemd: Boolean(opts.skipSystemd),
      force_config: Boolean(opts.forceConfig),
      dry_run: Boolean(opts.dryRun),
    },
    outputs: {
      runtime_dir: runtimeDir,
      agents_dir: agentsDir,
      handlers_dir: handlersDir,
      inbox_dir: inboxDir,
      receipts_dir: receiptsDir,
      runtime_files: installedRuntime,
    },
    next_steps: [
      `edit ${join(prefix, 'daemon.json')}, ${join(prefix, 'inbox-handler.json')}, ${join(prefix, 'control.json')}, and ${join(prefix, 'flights.json')}`,
      `place agent private keys under ${agentsDir} with chmod 600`,
      `place the panel public key at ${join(prefix, 'panel.pub.jwk')}`,
      `run node ${join(runtimeDir, 'host-receipt.mjs')} --daemon ${join(prefix, 'daemon.json')} --inbox ${join(prefix, 'inbox-handler.json')} --control ${join(prefix, 'control.json')}`,
    ],
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`fleet-install: ${err && err.message ? err.message : err}`)
    console.error(usage())
    process.exit(2)
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const receipt = await buildReceipt(opts)
  console.log(JSON.stringify(receipt, null, 2))
  process.exit(receipt.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { CONFIG_TEMPLATES, SERVICE_FILES, defaultPaths, parseArgs, summarize }
