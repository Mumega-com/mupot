import { createHash } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export const SERVICE_SPECS = Object.freeze([
  Object.freeze({ key: 'heartbeat', launchdLabel: 'com.mumega.mupot-fleet-daemon', systemdUnit: 'fleet-daemon.service', script: 'fleet-daemon.mjs', config: 'daemon.json' }),
  Object.freeze({ key: 'control', launchdLabel: 'com.mumega.mupot-fleet-control', systemdUnit: 'fleet-control-daemon.service', script: 'fleet-control-daemon.mjs', config: 'control.json' }),
])

export function resolveServiceManager(requested = 'auto', platformName = platform()) {
  if (!['auto', 'systemd', 'launchd', 'none'].includes(requested)) throw new Error(`unsupported service manager: ${requested}`)
  if (requested !== 'auto') return requested
  if (platformName === 'darwin') return 'launchd'
  if (platformName === 'linux') return 'systemd'
  throw new Error(`unsupported platform for automatic service manager: ${platformName}`)
}

export function validateServiceOptions(input = {}) {
  const explicit = input.serviceManagerExplicit === true
  if (input.skipSystemd && explicit && input.serviceManager !== 'none') throw new Error('--skip-systemd conflicts with an explicit non-none --service-manager')
  const serviceManager = input.skipSystemd ? 'none' : (input.serviceManager ?? 'auto')
  if (serviceManager !== 'systemd' && input.systemdDirExplicit) throw new Error('--systemd-dir requires systemd')
  if (serviceManager !== 'launchd' && input.launchdDirExplicit) throw new Error('--launchd-dir requires launchd')
  if (serviceManager !== 'systemd' && input.enableLinger) throw new Error('--enable-linger requires systemd')
  return { ...input, serviceManager }
}

function resolvePath(path, name, homeDir) {
  if (typeof path !== 'string' || !path) throw new Error(`${name} must be a non-empty path`)
  const expanded = path === '~' ? homeDir : path.startsWith('~/') ? join(homeDir, path.slice(2)) : path
  const absolute = resolve(expanded)
  if (!absolute.startsWith('/')) throw new Error(`${name} must resolve to an absolute path`)
  return absolute
}

function defaultDefinitionDir(manager, homeDir, platformName) {
  if (manager === 'launchd' || (manager === 'none' && platformName === 'darwin')) {
    return join(homeDir, 'Library', 'LaunchAgents')
  }
  return join(homeDir, '.config', 'systemd', 'user')
}

function definitionPath(manager, definitionDir, spec) {
  if (manager === 'launchd') return join(definitionDir, `${spec.launchdLabel}.plist`)
  return join(definitionDir, spec.systemdUnit)
}

function serviceName(manager, spec) {
  return manager === 'launchd' ? spec.launchdLabel : spec.systemdUnit
}

function freezeService(service) {
  return Object.freeze({ ...service, argv: Object.freeze(service.argv) })
}

export function createServiceContext(opts = {}) {
  const platformName = opts.platformName ?? platform()
  const manager = resolveServiceManager(opts.manager ?? opts.serviceManager ?? 'auto', platformName)
  const resolvedHomeDir = resolvePath(opts.homeDir ?? homedir(), 'homeDir', homedir())
  const prefix = resolvePath(opts.prefix ?? join(resolvedHomeDir, '.fleet'), 'prefix', resolvedHomeDir)
  const runtimeDir = resolvePath(opts.runtimeDir ?? join(prefix, 'runtime'), 'runtimeDir', resolvedHomeDir)
  const logsDir = resolvePath(opts.logsDir ?? join(prefix, 'logs'), 'logsDir', resolvedHomeDir)
  const stateDir = resolvePath(opts.stateDir ?? join(prefix, 'state'), 'stateDir', resolvedHomeDir)
  const definitionDir = resolvePath(
    opts.definitionDir ?? defaultDefinitionDir(manager, resolvedHomeDir, platformName),
    'definitionDir',
    resolvedHomeDir,
  )
  const nodePath = resolvePath(opts.nodePath ?? process.execPath, 'nodePath', resolvedHomeDir)
  const account = userInfo()
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : account.uid)
  if (!Number.isInteger(uid) || uid < 0) throw new Error('uid must be a non-negative integer')
  const username = opts.username ?? account.username
  if (typeof username !== 'string' || !username) throw new Error('username must be a non-empty string')

  const services = Object.freeze(SERVICE_SPECS.map((spec) => {
    const scriptPath = join(runtimeDir, spec.script)
    const configPath = join(prefix, spec.config)
    return freezeService({
      key: spec.key,
      name: serviceName(manager, spec),
      launchdLabel: spec.launchdLabel,
      systemdUnit: spec.systemdUnit,
      scriptPath,
      configPath,
      definitionPath: definitionPath(manager, definitionDir, spec),
      argv: [nodePath, scriptPath, configPath],
    })
  }))

  return Object.freeze({
    manager,
    prefix,
    runtimeDir,
    logsDir,
    stateDir,
    definitionDir,
    nodePath,
    homeDir: resolvedHomeDir,
    uid,
    username,
    domain: manager === 'launchd' ? `gui/${uid}` : manager === 'systemd' ? 'user' : null,
    services,
  })
}

export function definitionSha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function nullableBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function nullablePid(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

export function summarizeServiceStates(states = []) {
  const entries = Array.isArray(states) ? states : Object.values(states)
  return entries.map((state) => {
    const definition = state.definition ?? state.definitionContent
    return {
      key: state.key,
      name: state.name,
      definition_path: state.definitionPath ?? state.definition_path ?? null,
      definition_sha256: state.definitionSha256 ?? state.definition_sha256 ?? (definition === undefined ? null : definitionSha256(definition)),
      loaded: nullableBoolean(state.loaded),
      enabled: nullableBoolean(state.enabled),
      running: nullableBoolean(state.running),
      pid: nullablePid(state.pid),
    }
  })
}
