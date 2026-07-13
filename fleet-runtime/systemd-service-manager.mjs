import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { definitionSha256 } from './service-context.mjs'

let temporaryFileNumber = 0

function systemdDirectiveArgument(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t').replaceAll('%', '%%')}"`
}

function systemdExecArgument(value) {
  return systemdDirectiveArgument(value).replaceAll('$', '$$')
}

function resultFor(service, state, extra = {}) {
  return {
    key: service.key,
    name: service.systemdUnit,
    definitionPath: service.definitionPath,
    ...state,
    ...extra,
  }
}

function errorMessage(response, command) {
  return response.stderr || response.stdout || `${command} exited ${response.code}`
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${temporaryFileNumber += 1}.tmp`
  await writeFile(temporaryPath, content)
  await rename(temporaryPath, path)
}

function parseServiceState(response) {
  if (response.code !== 0) {
    return { loaded: null, enabled: null, running: null, pid: null, error: errorMessage(response, 'systemctl show') }
  }
  const [loadState = '', unitFileState = '', activeState = '', mainPid = ''] = String(response.stdout).trimEnd().split(/\r?\n/)
  const loaded = loadState === 'loaded'
  const enabled = unitFileState === 'enabled'
  const pid = /^[1-9][0-9]*$/.test(mainPid) ? Number(mainPid) : null
  const running = activeState === 'active' && pid !== null
  return { loaded, enabled, running, pid: running ? pid : null }
}

function nextSteps(linger) {
  return linger.enabled === false
    ? ['run loginctl enable-linger <username> with suitable host privileges, then rerun status']
    : []
}

function lingerEnableResult(response, linger) {
  if (response === null) return null
  return {
    attempted: true,
    command_succeeded: response.code === 0,
    confirmed_enabled: linger.enabled === true,
    error: response.code === 0 ? null : errorMessage(response, 'loginctl enable-linger'),
  }
}

export function renderSystemd(context) {
  return context.services.map((service) => Object.freeze({
    key: service.key,
    name: service.systemdUnit,
    path: service.definitionPath,
    content: [
      '[Unit]',
      `Description=Pot fleet ${service.key === 'heartbeat' ? 'daemon (signed presence heartbeat)' : 'control daemon (signed runtime open/close)'}`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${systemdDirectiveArgument(context.runtimeDir)}`,
      `ExecStart=${service.argv.map(systemdExecArgument).join(' ')}`,
      'Restart=on-failure',
      'RestartSec=10',
      'NoNewPrivileges=true',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  }))
}

export async function readLingerState(context, runner) {
  const response = await runner(['loginctl', 'show-user', context.username, '-p', 'Linger', '--value'])
  if (response.code !== 0) return { enabled: null, raw: null, error: errorMessage(response, 'loginctl show-user') }
  const raw = String(response.stdout).trim().replace(/^Linger=/i, '').toLowerCase()
  return { enabled: raw === 'yes' ? true : raw === 'no' ? false : null, raw }
}

export async function statusSystemd(context, runner) {
  const services = []
  for (const service of context.services) {
    const response = await runner([
      'systemctl',
      '--user',
      'show',
      service.systemdUnit,
      '--property=LoadState,UnitFileState,ActiveState,MainPID',
      '--value',
    ])
    services.push(resultFor(service, parseServiceState(response)))
  }
  const linger = await readLingerState(context, runner)
  return {
    ok: services.every((service) => service.loaded !== null) && linger.enabled !== null,
    services,
    linger,
    next_steps: nextSteps(linger),
  }
}

function lifecycleResult(service, response, operation, definition) {
  return resultFor(service, {
    definitionSha256: definition ? definitionSha256(definition.content) : undefined,
    [operation]: response.code === 0,
    error: response.code === 0 ? undefined : errorMessage(response, `systemctl ${operation}`),
  })
}

export async function installSystemd(context, runner, opts = {}) {
  const definitions = renderSystemd(context)
  for (const definition of definitions) await atomicWrite(definition.path, definition.content)

  const reloaded = await runner(['systemctl', '--user', 'daemon-reload'])
  const services = []
  for (const [index, service] of context.services.entries()) {
    const response = reloaded.code === 0
      ? await runner(['systemctl', '--user', 'enable', '--now', service.systemdUnit])
      : reloaded
    services.push(lifecycleResult(service, response, 'enabled', definitions[index]))
  }

  const enableLinger = opts.enableLinger === true
    ? await runner(['loginctl', 'enable-linger', context.username])
    : null
  const linger = await readLingerState(context, runner)
  const linger_enable = lingerEnableResult(enableLinger, linger)
  return {
    ok: reloaded.code === 0
      && services.every((service) => service.enabled)
      && (linger_enable === null || (linger_enable.command_succeeded && linger_enable.confirmed_enabled)),
    services,
    linger,
    linger_enable,
    next_steps: nextSteps(linger),
  }
}

export async function reloadSystemd(context, runner) {
  const definitions = renderSystemd(context)
  for (const definition of definitions) await atomicWrite(definition.path, definition.content)

  const reloaded = await runner(['systemctl', '--user', 'daemon-reload'])
  const services = []
  for (const [index, service] of context.services.entries()) {
    const response = reloaded.code === 0
      ? await runner(['systemctl', '--user', 'restart', service.systemdUnit])
      : reloaded
    services.push(lifecycleResult(service, response, 'restarted', definitions[index]))
  }
  return { ok: reloaded.code === 0 && services.every((service) => service.restarted), services }
}

export async function uninstallSystemd(context, runner) {
  const services = []
  for (const service of context.services) {
    const response = await runner(['systemctl', '--user', 'disable', '--now', service.systemdUnit])
    if (response.code === 0) await rm(service.definitionPath, { force: true })
    services.push(lifecycleResult(service, response, 'removed'))
  }
  const reloaded = await runner(['systemctl', '--user', 'daemon-reload'])
  return { ok: reloaded.code === 0 && services.every((service) => service.removed), services }
}
