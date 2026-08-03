#!/usr/bin/env node
// Supervise one exact Codex-thread endpoint as a separately named host service.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { buildServiceReceipt, shellQuote } from './service-manager.mjs'
import { resolveServiceManager } from './service-context.mjs'
import { validateConfig } from './codex-thread-endpoint.mjs'

const ACTIONS = new Set(['install', 'reload', 'status', 'uninstall'])

function expandHome(value) {
  return value === '~' ? homedir() : value?.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

function absolutePath(value, name) {
  const expanded = expandHome(value)
  if (typeof expanded !== 'string' || !isAbsolute(expanded)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return resolve(expanded)
}

function threadHash(threadId) {
  return createHash('sha256').update(threadId).digest('hex').slice(0, 16)
}

export function parseCodexThreadServiceArgs(argv, platformName = process.platform) {
  const options = {
    action: null,
    configPath: null,
    serviceManager: 'auto',
    prefix: join(homedir(), '.fleet'),
    nodePath: process.execPath,
    launchdDir: join(homedir(), 'Library', 'LaunchAgents'),
    systemdDir: join(homedir(), '.config', 'systemd', 'user'),
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }
    if (!arg.startsWith('-')) {
      if (options.action !== null || !ACTIONS.has(arg)) throw new Error(`unsupported action: ${arg}`)
      options.action = arg
    } else if (arg === '--config') options.configPath = absolutePath(next(), '--config')
    else if (arg === '--service-manager') options.serviceManager = next()
    else if (arg === '--prefix') options.prefix = absolutePath(next(), '--prefix')
    else if (arg === '--node') options.nodePath = absolutePath(next(), '--node')
    else if (arg === '--launchd-dir') options.launchdDir = absolutePath(next(), '--launchd-dir')
    else if (arg === '--systemd-dir') options.systemdDir = absolutePath(next(), '--systemd-dir')
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.help) return options
  if (!options.action) throw new Error('one lifecycle action is required')
  if (!options.configPath) throw new Error('--config is required')
  const manager = resolveServiceManager(options.serviceManager, platformName)
  if (manager === 'none') throw new Error('service manager must be launchd or systemd')
  return { ...options, manager }
}

export function createCodexThreadServiceContext(options, deps = {}) {
  const configPath = absolutePath(options.configPath, 'configPath')
  const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')))
  const manager = options.manager ?? resolveServiceManager(options.serviceManager ?? 'auto', deps.platformName)
  const prefix = absolutePath(options.prefix ?? join(homedir(), '.fleet'), 'prefix')
  const runtimeDir = join(prefix, 'runtime')
  const logsDir = join(prefix, 'logs')
  const stateDir = join(prefix, 'state')
  const homeDir = absolutePath(options.homeDir ?? deps.homeDir ?? homedir(), 'homeDir')
  const nodePath = absolutePath(options.nodePath ?? process.execPath, 'nodePath')
  const definitionDir = absolutePath(
    manager === 'launchd'
      ? options.launchdDir ?? join(homeDir, 'Library', 'LaunchAgents')
      : options.systemdDir ?? join(homeDir, '.config', 'systemd', 'user'),
    'definitionDir',
  )
  const account = userInfo()
  const uid = options.uid ?? deps.uid ??
    (typeof process.getuid === 'function' ? process.getuid() : account.uid)
  const hash = threadHash(config.thread_id)
  const launchdLabel = `com.mumega.mupot-codex-thread.${hash}`
  const systemdUnit = `mupot-codex-thread-${hash}.service`
  const definitionPath = join(
    definitionDir,
    manager === 'launchd' ? `${launchdLabel}.plist` : systemdUnit,
  )
  const scriptPath = join(runtimeDir, 'codex-thread-endpoint.mjs')
  const service = Object.freeze({
    key: `codex_endpoint_${hash}`,
    name: manager === 'launchd' ? launchdLabel : systemdUnit,
    launchdLabel,
    systemdUnit,
    scriptPath,
    configPath,
    definitionPath,
    argv: Object.freeze([nodePath, scriptPath, configPath]),
    logStem: `codex-thread-${hash}`,
    description: `Mupot exact Codex thread endpoint (${config.local_source_id})`,
  })
  const command = (action) => {
    const definitionFlag = manager === 'launchd' ? '--launchd-dir' : '--systemd-dir'
    return [
      shellQuote(nodePath),
      shellQuote(join(runtimeDir, 'codex-thread-service.mjs')),
      shellQuote(action),
      '--config',
      shellQuote(configPath),
      '--service-manager',
      shellQuote(manager),
      '--prefix',
      shellQuote(prefix),
      definitionFlag,
      shellQuote(definitionDir),
      '--node',
      shellQuote(nodePath),
    ].join(' ')
  }
  return Object.freeze({
    manager,
    prefix,
    runtimeDir,
    logsDir,
    stateDir,
    definitionDir,
    nodePath,
    homeDir,
    uid,
    username: options.username ?? deps.username ?? account.username,
    domain: manager === 'launchd' ? `gui/${uid}` : 'user',
    services: Object.freeze([service]),
    lifecycleCommand: command,
  })
}

export async function buildCodexThreadServiceReceipt(options, deps = {}) {
  const context = deps.context ?? createCodexThreadServiceContext(options, deps)
  return await buildServiceReceipt({
    action: options.action,
    serviceManager: context.manager,
    prefix: context.prefix,
    runtimeDir: context.runtimeDir,
    logsDir: context.logsDir,
    stateDir: context.stateDir,
    launchdDir: context.manager === 'launchd' ? context.definitionDir : undefined,
    systemdDir: context.manager === 'systemd' ? context.definitionDir : undefined,
    nodePath: context.nodePath,
    dryRun: options.dryRun,
    homeDir: context.homeDir,
    uid: context.uid,
    username: context.username,
  }, { ...deps, context })
}

function usage() {
  return [
    'Usage: node fleet-runtime/codex-thread-service.mjs <install|reload|status|uninstall> --config <path> [options]',
    '',
    'Options:',
    '  --service-manager <auto|launchd|systemd>',
    '  --prefix <path>',
    '  --launchd-dir <path>',
    '  --systemd-dir <path>',
    '  --node <absolute-path>',
    '  --dry-run',
  ].join('\n')
}

async function main() {
  try {
    const options = parseCodexThreadServiceArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(`${usage()}\n`)
      return
    }
    const receipt = await buildCodexThreadServiceReceipt(options)
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.status === 'fail') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`codex-thread-service: ${error?.message ?? error}\n${usage()}\n`)
    process.exitCode = 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
