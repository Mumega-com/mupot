#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createServiceContext as createDefaultServiceContext,
  definitionSha256,
  redactSecretValues,
  resolveServiceManager,
  summarizeServiceStates,
  validateServiceOptions,
} from './service-context.mjs'
import {
  installLaunchd,
  reloadLaunchd,
  renderLaunchd,
  statusLaunchd,
  uninstallLaunchd,
} from './launchd-service-manager.mjs'
import {
  installSystemd,
  reloadSystemd,
  renderSystemd,
  statusSystemd,
  uninstallSystemd,
} from './systemd-service-manager.mjs'

const SERVICE_ACTIONS = Object.freeze(['install', 'reload', 'status', 'uninstall'])
const LINGER_NEXT_STEP = 'run loginctl enable-linger <username> with suitable host privileges, then rerun status'
const READINESS_RETRY_DELAYS_MS = Object.freeze([250, 750, 1500, 2500])

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function pathArg(value) {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
}

export function parseServiceArgs(argv, platformName = process.platform) {
  const opts = {
    action: null,
    serviceManager: 'auto',
    serviceManagerExplicit: false,
    prefix: join(homedir(), '.fleet'),
    launchdDir: null,
    launchdDirExplicit: false,
    systemdDir: null,
    systemdDirExplicit: false,
    nodePath: process.execPath,
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
    if (!arg.startsWith('-')) {
      if (opts.action !== null) throw new Error('exactly one action is required')
      if (!SERVICE_ACTIONS.includes(arg)) throw new Error(`unsupported action: ${arg}`)
      opts.action = arg
    } else if (arg === '--service-manager') {
      opts.serviceManager = next()
      opts.serviceManagerExplicit = true
    } else if (arg === '--prefix') opts.prefix = pathArg(next())
    else if (arg === '--launchd-dir') {
      opts.launchdDir = pathArg(next())
      opts.launchdDirExplicit = true
    } else if (arg === '--systemd-dir') {
      opts.systemdDir = pathArg(next())
      opts.systemdDirExplicit = true
    } else if (arg === '--node') {
      const nodePath = next()
      if (!nodePath.startsWith('/')) throw new Error('--node requires an absolute path')
      opts.nodePath = nodePath
    } else if (arg === '--enable-linger') opts.enableLinger = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (opts.help) return opts
  return validateOptionsForPlatform(opts, platformName)
}

function validateOptionsForPlatform(input, platformName) {
  if (input.action === null || input.action === undefined) throw new Error('a required action is missing')
  if (!SERVICE_ACTIONS.includes(input.action)) throw new Error(`unsupported action: ${input.action}`)
  const requested = input.serviceManager ?? input.manager ?? 'auto'
  const validated = validateServiceOptions({
    ...input,
    serviceManager: requested,
  })
  const manager = resolveServiceManager(validated.serviceManager, platformName)
  if (manager === 'none') throw new Error('service lifecycle commands require launchd or systemd')
  validateServiceOptions(validated, manager)
  return validated
}

function usage() {
  return [
    'Usage: node fleet-runtime/service-manager.mjs <install|reload|status|uninstall> [options]',
    '',
    'Options:',
    '  --service-manager <auto|systemd|launchd>',
    '  --prefix <path>',
    '  --launchd-dir <path>',
    '  --systemd-dir <path>',
    '  --node <absolute-path>',
    '  --enable-linger',
    '  --dry-run',
    '  -h, --help',
  ].join('\n')
}

function defaultRunner(argv) {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolveResult({ code: 1, stdout, stderr: error.message }))
    child.once('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }))
  })
}

function adapterFor(manager, deps) {
  if (deps.adapters?.[manager]) return deps.adapters[manager]
  if (deps[manager]) return deps[manager]
  if (manager === 'launchd') {
    return { render: renderLaunchd, install: installLaunchd, reload: reloadLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd }
  }
  return { render: renderSystemd, install: installSystemd, reload: reloadSystemd, status: statusSystemd, uninstall: uninstallSystemd }
}

function redactedSummary(value) {
  const redacted = redactSecretValues(value)
  return { ...redacted, text: redacted.text.slice(0, 2000) }
}

function commandOutputSummary(argv, stream, value) {
  const redacted = redactedSummary(value)
  if (stream === 'stdout' && argv[0] === 'launchctl' && argv[1] === 'print') {
    return { ...redacted, text: '[launchctl print output omitted]' }
  }
  return redacted
}

function sanitizeReceiptValue(value) {
  if (typeof value === 'string') {
    const redacted = redactSecretValues(value)
    return { value: redacted.text, secretFound: redacted.secretFound }
  }
  if (Array.isArray(value)) {
    let secretFound = false
    const sanitized = value.map((entry) => {
      const result = sanitizeReceiptValue(entry)
      secretFound ||= result.secretFound
      return result.value
    })
    return { value: sanitized, secretFound }
  }
  if (value && typeof value === 'object') {
    let secretFound = false
    const sanitized = {}
    for (const [key, entry] of Object.entries(value)) {
      const result = sanitizeReceiptValue(entry)
      secretFound ||= result.secretFound
      sanitized[key] = result.value
    }
    return { value: sanitized, secretFound }
  }
  return { value, secretFound: false }
}

function finalizeServiceReceipt(receipt) {
  const sanitized = sanitizeReceiptValue(receipt)
  if (!sanitized.secretFound) return sanitized.value
  sanitized.value.status = 'fail'
  let outputCheckFound = false
  sanitized.value.checks = sanitized.value.checks.map((check) => {
    if (check.check !== 'command_output_secret_free') return check
    outputCheckFound = true
    return { ...check, ok: false }
  })
  if (!outputCheckFound) sanitized.value.checks.push({ ok: false, check: 'command_output_secret_free' })
  return sanitized.value
}

function normalizeStatus(result) {
  if (Array.isArray(result)) return { ok: true, services: result, linger: null, next_steps: [] }
  const linger = projectLinger(result?.linger)
  return {
    ok: result?.ok !== false,
    services: result?.services ?? [],
    linger,
    next_steps: linger?.enabled === false ? [LINGER_NEXT_STEP] : [],
  }
}

function servicesOperational(status, expectedCount) {
  return status.services.length === expectedCount &&
    status.services.every((service) => service.loaded === true && service.running === true)
}

async function readLifecycleStatus(adapter, context, runner, deps, manager, action, lifecycle) {
  let status = normalizeStatus(await adapter.status(context, runner))
  if (manager !== 'launchd' || !['install', 'reload'].includes(action) || lifecycle.ok === false) return status
  const sleep = deps.sleep ?? defaultSleep
  for (const delay of READINESS_RETRY_DELAYS_MS) {
    if (servicesOperational(status, context.services.length)) break
    await sleep(delay)
    status = normalizeStatus(await adapter.status(context, runner))
  }
  return status
}

function projectLinger(linger) {
  if (linger === null || linger === undefined) return null
  return {
    enabled: typeof linger.enabled === 'boolean' ? linger.enabled : null,
    raw: linger.raw === 'yes' || linger.raw === 'no' ? linger.raw : null,
  }
}

function projectServiceStates(states) {
  return summarizeServiceStates(states).map((service) => ({
    key: service.key,
    name: service.name,
    loaded: service.loaded,
    enabled: service.enabled,
    running: service.running,
    pid: service.pid,
  }))
}

export function buildFailedServiceReceipt({
  platformName = process.platform,
  serviceManager,
  action,
  definitions = [],
  services = [],
  linger = null,
  commands = [],
  nextSteps = [],
  checks = [],
  error,
  secretFound = false,
}) {
  const failure = redactedSummary(error?.message ?? String(error))
  const containsSecret = secretFound || failure.secretFound
  return finalizeServiceReceipt({
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: new Date().toISOString(),
    status: 'fail',
    platform: platformName,
    service_manager: serviceManager,
    action,
    definitions,
    services: projectServiceStates(services),
    linger: projectLinger(linger),
    commands,
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: [...nextSteps],
    checks: [
      ...checks,
      { ok: false, check: 'service_operation_failed', reason: failure.text },
      { ok: !containsSecret, check: 'command_output_secret_free' },
    ],
  })
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function serviceLifecycleCommand(context, action, opts = {}) {
  const definitionFlag = context.manager === 'launchd' ? '--launchd-dir' : '--systemd-dir'
  const linger = opts.enableLinger && context.manager === 'systemd' ? ' --enable-linger' : ''
  return `${shellQuote(context.nodePath)} ${shellQuote(join(context.runtimeDir, 'service-manager.mjs'))} ${shellQuote(action)} --service-manager ${shellQuote(context.manager)} --prefix ${shellQuote(context.prefix)} ${definitionFlag} ${shellQuote(context.definitionDir)} --node ${shellQuote(context.nodePath)}${linger}`
}

function retryCommand(context, action, opts) {
  return serviceLifecycleCommand(context, action, opts)
}

function preservationChecks(context) {
  const paths = [
    context.runtimeDir,
    join(context.prefix, 'agents'),
    join(context.prefix, 'handlers'),
    join(context.prefix, 'inbox'),
    context.logsDir,
    context.stateDir,
    join(context.prefix, 'receipts'),
  ]
  return paths.every((path) => existsSync(path))
}

export async function buildServiceReceipt(opts = {}, deps = {}) {
  const requested = opts.serviceManager ?? opts.manager ?? 'auto'
  const platformName = deps.platformName ?? process.platform
  const validated = validateOptionsForPlatform({
    ...opts,
    serviceManager: requested,
    serviceManagerExplicit: opts.serviceManagerExplicit ?? opts.serviceManager !== undefined,
  }, platformName)
  const manager = resolveServiceManager(validated.serviceManager, platformName)
  const contextFactory = deps.createServiceContext ?? createDefaultServiceContext
  const definitionDir = manager === 'launchd' ? opts.launchdDir : opts.systemdDir
  const context = deps.context ?? contextFactory({
    manager,
    platformName,
    homeDir: opts.homeDir ?? deps.homeDir,
    prefix: opts.prefix,
    runtimeDir: opts.runtimeDir,
    logsDir: opts.logsDir,
    stateDir: opts.stateDir,
    definitionDir,
    nodePath: opts.nodePath,
    uid: opts.uid ?? deps.uid,
    username: opts.username ?? deps.username,
  })
  const adapter = adapterFor(manager, deps)
  const commands = []
  let secretFound = false
  const runner = async (argv) => {
    let response
    try {
      response = await (deps.runner ?? defaultRunner)(argv)
    } catch (error) {
      response = { code: 1, stdout: '', stderr: error?.message ?? String(error) }
    }
    const stdout = commandOutputSummary(argv, 'stdout', response?.stdout)
    const stderr = commandOutputSummary(argv, 'stderr', response?.stderr)
    secretFound ||= stdout.secretFound || stderr.secretFound
    commands.push({
      executable: argv[0],
      argv: argv.slice(1),
      code: Number.isInteger(response?.code) ? response.code : 1,
      stdout_summary: stdout.text,
      stderr_summary: stderr.text,
    })
    return { code: Number.isInteger(response?.code) ? response.code : 1, stdout: response?.stdout ?? '', stderr: response?.stderr ?? '' }
  }

  const checks = []
  let lifecycle = { ok: true, services: [] }
  let status = { ok: true, services: [], linger: null, next_steps: [] }
  let definitions = []
  try {
    definitions = adapter.render(context).map((definition) => ({
      service: definition.key,
      path: definition.path,
      sha256: definitionSha256(definition.content),
    }))
    if (opts.dryRun) {
      checks.push({ ok: null, check: 'dry_run', action: opts.action })
      status = {
        ok: true,
        services: context.services.map((service) => ({ key: service.key, name: service.name, definitionPath: service.definitionPath, loaded: null, enabled: null, running: null, pid: null })),
        linger: null,
        next_steps: [],
      }
    } else if (opts.action === 'status') {
      status = normalizeStatus(await adapter.status(context, runner))
    } else {
      lifecycle = await adapter[opts.action](context, runner, { enableLinger: opts.enableLinger === true })
      status = await readLifecycleStatus(adapter, context, runner, deps, manager, opts.action, lifecycle)
    }
  } catch (error) {
    return buildFailedServiceReceipt({
      platformName,
      serviceManager: manager,
      action: opts.action,
      definitions,
      services: status.services,
      linger: status.linger,
      commands,
      nextSteps: [...status.next_steps, retryCommand(context, opts.action, opts)],
      checks,
      error,
      secretFound,
    })
  }

  const services = projectServiceStates(status.services)
  const operational = services.length === context.services.length && services.every((service) => service.loaded === true && service.running === true)
  const definitionsAbsent = definitions.every((definition) => !existsSync(definition.path))
  let actionOk
  if (opts.dryRun) actionOk = true
  else if (opts.action === 'uninstall') actionOk = lifecycle.ok !== false && services.every((service) => service.loaded === false) && definitionsAbsent && preservationChecks(context)
  else actionOk = lifecycle.ok !== false && status.ok !== false && operational

  checks.push({ ok: actionOk, check: opts.action === 'uninstall' ? 'services_uninstalled' : 'services_loaded_and_running' })
  if (opts.action === 'uninstall') {
    checks.push({ ok: definitionsAbsent, check: 'definitions_absent' })
    checks.push({ ok: preservationChecks(context), check: 'configured_data_preserved' })
  }
  if (secretFound) checks.push({ ok: false, check: 'command_output_secret_free' })
  else checks.push({ ok: true, check: 'command_output_secret_free' })

  const receipt = {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: new Date().toISOString(),
    status: actionOk && !secretFound ? 'pass' : 'fail',
    platform: platformName,
    service_manager: manager,
    action: opts.action,
    definitions,
    services,
    linger: projectLinger(status.linger),
    commands,
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: [...status.next_steps],
    checks,
  }
  if (receipt.status === 'fail') receipt.next_steps.push(retryCommand(context, opts.action, opts))
  return finalizeServiceReceipt(receipt)
}

async function main() {
  let opts
  try {
    opts = parseServiceArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fleet-service: ${error?.message ?? error}`)
    console.error(usage())
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  try {
    const receipt = await buildServiceReceipt(opts)
    console.log(JSON.stringify(receipt, null, 2))
    if (receipt.status === 'fail') process.exitCode = 1
  } catch (error) {
    console.error(`fleet-service: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
