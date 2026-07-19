#!/usr/bin/env node
// Non-destructive fleet runtime layout bootstrap and service-definition renderer.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createServiceContext,
  definitionSha256,
  resolveServiceManager,
  validateServiceOptions,
} from './service-context.mjs'
import { renderLaunchd } from './launchd-service-manager.mjs'
import { renderSystemd } from './systemd-service-manager.mjs'
import {
  buildFailedServiceReceipt,
  buildServiceReceipt as buildDefaultServiceReceipt,
  serviceLifecycleCommand,
} from './service-manager.mjs'
import { normalizeAgentProfile } from './profile-contract.mjs'

const DEFAULT_SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

const CONFIG_TEMPLATES = [
  ['daemon.example.json', 'daemon.json'],
  ['inbox-handler.example.json', 'inbox-handler.json'],
  ['control.example.json', 'control.json'],
  ['flights.example.json', 'flights.json'],
]

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function defaultPaths() {
  const home = homedir()
  return {
    sourceDir: DEFAULT_SOURCE_DIR,
    prefix: join(home, '.fleet'),
    launchdDir: join(home, 'Library', 'LaunchAgents'),
    systemdDir: join(home, '.config', 'systemd', 'user'),
  }
}

function parseArgs(argv, platformName = process.platform) {
  const defaults = defaultPaths()
  const opts = {
    sourceDir: defaults.sourceDir,
    prefix: defaults.prefix,
    launchdDir: defaults.launchdDir,
    launchdDirExplicit: false,
    systemdDir: defaults.systemdDir,
    systemdDirExplicit: false,
    serviceManager: 'auto',
    serviceManagerExplicit: false,
    nodePath: process.execPath,
    skipSystemd: false,
    forceConfig: false,
    activate: false,
    enableLinger: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--source') opts.sourceDir = pathArg(next())
    else if (arg === '--prefix') opts.prefix = pathArg(next())
    else if (arg === '--launchd-dir') {
      opts.launchdDir = pathArg(next())
      opts.launchdDirExplicit = true
    } else if (arg === '--systemd-dir') {
      opts.systemdDir = pathArg(next())
      opts.systemdDirExplicit = true
    } else if (arg === '--service-manager') {
      opts.serviceManager = next()
      opts.serviceManagerExplicit = true
    } else if (arg === '--node') {
      const nodePath = next()
      if (!nodePath.startsWith('/')) throw new Error('--node requires an absolute path')
      opts.nodePath = nodePath
    } else if (arg === '--skip-systemd') opts.skipSystemd = true
    else if (arg === '--force-config') opts.forceConfig = true
    else if (arg === '--activate') opts.activate = true
    else if (arg === '--enable-linger') opts.enableLinger = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (opts.help) return opts
  const validated = validateServiceOptions(opts)
  const manager = resolveServiceManager(validated.serviceManager, platformName)
  validateServiceOptions(validated, manager)
  return validated
}

function usage() {
  return [
    'Usage: node fleet-runtime/install.mjs [options]',
    '',
    'Options:',
    '  --source <path>       fleet-runtime source directory (default: this script directory)',
    '  --prefix <path>       fleet runtime home (default: ~/.fleet)',
    '  --service-manager <auto|systemd|launchd|none>',
    '  --launchd-dir <path>  launchd user definition directory',
    '  --systemd-dir <path>  systemd user unit directory',
    '  --node <path>         absolute Node.js executable path',
    '  --activate            install and start rendered services after successful writes',
    '  --enable-linger       enable systemd user lingering during activation',
    '  --skip-systemd        deprecated alias for --service-manager none',
    '  --force-config        overwrite existing daemon/control/inbox/flights config files',
    '  --dry-run             print planned actions without writing files',
    '  -h, --help            show this help',
    '',
    'After install, edit ~/.fleet/*.json, place keys, then run host-receipt.mjs.',
  ].join('\n')
}

function summarize(checks) {
  const failed = checks.filter((check) => check.ok === false)
  const warnings = checks.filter((check) => check.ok === null)
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

function ensureDir(path, mode, checks, opts, label, deps = {}) {
  try {
    const existed = existsSync(path)
    const chmod = deps.chmodSync ?? chmodSync
    if (!opts.dryRun) {
      mkdirSync(path, { recursive: true, mode })
      chmod(path, mode)
    }
    checks.push({ ok: true, component: 'fleet-install', check: `${label}_dir_ready`, path, mode: opts.dryRun ? mode.toString(8) : modeOf(path), existed, dry_run: Boolean(opts.dryRun) })
  } catch (error) {
    checks.push({ ok: false, component: 'fleet-install', check: `${label}_dir_ready`, path, reason: String(error?.message ?? error) })
  }
}

function copyFile(src, dest, checks, opts, label, mode = 0o644) {
  try {
    if (!opts.dryRun) {
      copyFileSync(src, dest)
      chmodSync(dest, mode)
    }
    checks.push({ ok: true, component: 'fleet-install', check: `${label}_copied`, source: src, path: dest, mode: opts.dryRun ? mode.toString(8) : modeOf(dest), dry_run: Boolean(opts.dryRun) })
  } catch (error) {
    checks.push({ ok: false, component: 'fleet-install', check: `${label}_copied`, source: src, path: dest, reason: String(error?.message ?? error) })
  }
}

function writeDefinition(definition, checks, opts) {
  try {
    if (!opts.dryRun) {
      writeFileSync(definition.path, definition.content)
      chmodSync(definition.path, 0o644)
    }
    checks.push({
      ok: true,
      component: 'fleet-install',
      check: 'service_definition_rendered',
      service: definition.key,
      path: definition.path,
      sha256: definitionSha256(definition.content),
      mode: opts.dryRun ? '644' : modeOf(definition.path),
      dry_run: Boolean(opts.dryRun),
    })
  } catch (error) {
    checks.push({ ok: false, component: 'fleet-install', check: 'service_definition_rendered', service: definition.key, path: definition.path, reason: String(error?.message ?? error) })
  }
}

function runtimeFiles(sourceDir) {
  try {
    return readdirSync(sourceDir).filter((name) => name.endsWith('.mjs')).filter((name) => !name.endsWith('.test.mjs')).sort()
  } catch {
    return []
  }
}

function collectSourceChecks(sourceDir, checks) {
  let ok = true
  try {
    ok = statSync(sourceDir).isDirectory()
  } catch {
    ok = false
  }
  checks.push({ ok, component: 'fleet-install', check: 'source_dir_present', path: sourceDir })
  return ok
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeAgentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null
}

function collectProfileHashes(configPath, checks) {
  const hashes = []
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    checks.push({ ok: false, component: 'fleet-install', check: 'agent_profile_config_readable', path: configPath })
    return hashes
  }
  const agents = Array.isArray(config?.agents) ? config.agents : []
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || !Object.hasOwn(agent, 'profile')) continue
    const profile = normalizeAgentProfile(agent.profile)
    const agentId = safeAgentId(agent.agent_id)
    if (!profile || profile.agent_id !== agentId) {
      checks.push({ ok: false, component: 'fleet-install', check: 'agent_profile_valid', agent_id: agentId })
      continue
    }
    hashes.push({ agent_id: profile.agent_id, sha256: sha256(JSON.stringify(profile)) })
  }
  hashes.sort((left, right) => left.agent_id.localeCompare(right.agent_id))
  checks.push({
    ok: hashes.length > 0 ? true : null,
    component: 'fleet-install',
    check: hashes.length > 0 ? 'agent_profiles_hashed' : 'agent_profiles_missing',
    count: hashes.length,
    ...(hashes.length > 0 ? {} : { reason: 'no productized policy profiles were found' }),
  })
  return hashes
}

function resolvedOptions(input, platformName) {
  const defaults = defaultPaths()
  const requestedManager = input.serviceManager ?? 'auto'
  const validated = validateServiceOptions({
    ...input,
    sourceDir: input.sourceDir ?? defaults.sourceDir,
    prefix: input.prefix ?? defaults.prefix,
    launchdDir: input.launchdDir ?? defaults.launchdDir,
    systemdDir: input.systemdDir ?? defaults.systemdDir,
    serviceManager: requestedManager,
    serviceManagerExplicit: input.serviceManagerExplicit ?? input.serviceManager !== undefined,
    launchdDirExplicit: input.launchdDirExplicit ?? input.launchdDir !== undefined,
    systemdDirExplicit: input.systemdDirExplicit ?? input.systemdDir !== undefined,
    nodePath: input.nodePath ?? process.execPath,
  })
  const manager = resolveServiceManager(validated.serviceManager, platformName)
  validateServiceOptions(validated, manager)
  return { ...validated, manager }
}

function lifecycleCommand(context, opts = {}) {
  return serviceLifecycleCommand(context, 'install', opts)
}

export async function buildReceipt(input = {}, deps = {}) {
  const checks = []
  const platformName = deps.platformName ?? process.platform
  let opts
  try {
    opts = resolvedOptions(input, platformName)
  } catch (error) {
    checks.push({ ok: false, component: 'fleet-install', check: 'service_options_valid', reason: String(error?.message ?? error) })
    const summary = summarize(checks)
    return { receipt_type: 'mupot-fleet-install-receipt/v1', generated_at: new Date().toISOString(), status: summary.status, summary, inputs: {}, outputs: {}, next_steps: [], checks }
  }
  const sourceDir = pathArg(opts.sourceDir)
  const prefix = pathArg(opts.prefix)
  const runtimeDir = join(prefix, 'runtime')
  const agentsDir = join(prefix, 'agents')
  const handlersDir = join(prefix, 'handlers')
  const inboxDir = join(prefix, 'inbox')
  const logsDir = join(prefix, 'logs')
  const stateDir = join(prefix, 'state')
  const receiptsDir = join(prefix, 'receipts')
  const sourceOk = collectSourceChecks(sourceDir, checks)
  ensureDir(prefix, 0o700, checks, opts, 'fleet_home', deps)
  ensureDir(runtimeDir, 0o700, checks, opts, 'runtime', deps)
  ensureDir(agentsDir, 0o700, checks, opts, 'agents', deps)
  ensureDir(handlersDir, 0o700, checks, opts, 'handlers', deps)
  ensureDir(inboxDir, 0o700, checks, opts, 'inbox', deps)
  ensureDir(logsDir, 0o700, checks, opts, 'logs', deps)
  ensureDir(stateDir, 0o700, checks, opts, 'state', deps)
  ensureDir(receiptsDir, 0o700, checks, opts, 'receipts', deps)

  const installedRuntime = []
  let profileHashes = []
  if (sourceOk) {
    const files = runtimeFiles(sourceDir)
    checks.push({ ok: files.length > 0, component: 'fleet-install', check: 'runtime_files_discovered', count: files.length })
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
        checks.push({ ok: true, component: 'fleet-install', check: 'config_preserved', source: src, path: dest })
      } else {
        copyFile(src, dest, checks, opts, 'config_template', 0o600)
        checks.push({ ok: null, component: 'fleet-install', check: 'config_needs_edit', path: dest, reason: 'template_contains_placeholders' })
      }
    }
    const profileConfigPath = opts.dryRun
      ? join(sourceDir, 'inbox-handler.example.json')
      : join(prefix, 'inbox-handler.json')
    profileHashes = collectProfileHashes(profileConfigPath, checks)
  }

  let context = null
  let serviceDefinitions = []
  if (opts.manager === 'none') {
    checks.push({ ok: null, component: 'fleet-install', check: 'service_manager_none', reason: 'service definitions were not requested' })
  } else {
    const definitionDir = opts.manager === 'launchd' ? opts.launchdDir : opts.systemdDir
    ensureDir(definitionDir, 0o700, checks, opts, `${opts.manager}_definition`, deps)
    try {
      context = createServiceContext({
        manager: opts.manager,
        platformName,
        homeDir: input.homeDir ?? deps.homeDir,
        prefix,
        runtimeDir,
        logsDir,
        stateDir,
        definitionDir,
        nodePath: opts.nodePath,
        uid: input.uid ?? deps.uid,
        username: input.username ?? deps.username,
      })
      const render = opts.manager === 'launchd' ? renderLaunchd : renderSystemd
      serviceDefinitions = render(context)
      for (const definition of serviceDefinitions) writeDefinition(definition, checks, opts)
    } catch (error) {
      checks.push({ ok: false, component: 'fleet-install', check: 'service_definitions_rendered', reason: String(error?.message ?? error) })
    }
  }

  const definitionRecords = serviceDefinitions.map((definition) => ({ service: definition.key, path: definition.path, sha256: definitionSha256(definition.content) }))
  let activation = null
  const writesSucceeded = checks.every((check) => check.ok !== false)
  if (opts.activate && opts.manager !== 'none' && !opts.dryRun && writesSucceeded) {
    try {
      const buildServiceReceipt = deps.buildServiceReceipt ?? buildDefaultServiceReceipt
      activation = await buildServiceReceipt({
        action: 'install',
        serviceManager: opts.manager,
        prefix,
        runtimeDir,
        logsDir,
        stateDir,
        launchdDir: opts.manager === 'launchd' ? context.definitionDir : undefined,
        systemdDir: opts.manager === 'systemd' ? context.definitionDir : undefined,
        nodePath: opts.nodePath,
        enableLinger: opts.enableLinger,
        homeDir: input.homeDir ?? deps.homeDir,
        uid: input.uid ?? deps.uid,
        username: input.username ?? deps.username,
      }, deps)
      checks.push({ ok: activation.status === 'pass', component: 'fleet-install', check: 'service_activation', service_receipt: activation.receipt_type })
    } catch (error) {
      activation = buildFailedServiceReceipt({
        platformName,
        serviceManager: opts.manager,
        action: 'install',
        definitions: definitionRecords,
        nextSteps: [lifecycleCommand(context, opts)],
        error,
      })
      const failure = activation.checks.find((check) => check.check === 'service_operation_failed')
      checks.push({ ok: false, component: 'fleet-install', check: 'service_activation', reason: failure.reason })
    }
  } else if (opts.activate && opts.manager !== 'none') {
    checks.push({ ok: null, component: 'fleet-install', check: 'service_activation_skipped', reason: opts.dryRun ? 'dry_run' : 'render_or_write_failed' })
  }

  const summary = summarize(checks)
  const nextSteps = [
    `edit ${join(prefix, 'daemon.json')}, ${join(prefix, 'inbox-handler.json')}, ${join(prefix, 'control.json')}, and ${join(prefix, 'flights.json')}`,
    `place agent private keys under ${agentsDir} with chmod 600`,
    `place the panel public key at ${join(prefix, 'panel.pub.jwk')}`,
    `run node ${join(runtimeDir, 'host-receipt.mjs')} --daemon ${join(prefix, 'daemon.json')} --inbox ${join(prefix, 'inbox-handler.json')} --control ${join(prefix, 'control.json')}`,
  ]
  if (context && !opts.activate) nextSteps.push(lifecycleCommand(context, opts))
  if (activation?.next_steps) nextSteps.push(...activation.next_steps)
  return {
    receipt_type: 'mupot-fleet-install-receipt/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      source_dir: sourceDir,
      prefix,
      systemd_dir: opts.manager === 'systemd' ? opts.systemdDir : null,
      skip_systemd: Boolean(opts.skipSystemd),
      force_config: Boolean(opts.forceConfig),
      dry_run: Boolean(opts.dryRun),
      node_path: opts.nodePath,
      service_manager: { requested: opts.serviceManager, resolved: opts.manager },
      service_definition_dir: context?.definitionDir ?? null,
      activation_requested: Boolean(opts.activate),
      activation_performed: activation !== null,
      enable_linger: Boolean(opts.enableLinger),
    },
    outputs: {
      runtime_dir: runtimeDir,
      agents_dir: agentsDir,
      handlers_dir: handlersDir,
      inbox_dir: inboxDir,
      logs_dir: logsDir,
      state_dir: stateDir,
      receipts_dir: receiptsDir,
      runtime_files: installedRuntime,
      profile_hashes: profileHashes,
      service_definitions: definitionRecords,
    },
    activation,
    next_steps: nextSteps,
    checks,
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fleet-install: ${error?.message ?? error}`)
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const receipt = await buildReceipt(opts)
  console.log(JSON.stringify(receipt, null, 2))
  if (receipt.status === 'fail') process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

export { CONFIG_TEMPLATES, defaultPaths, parseArgs, summarize }
