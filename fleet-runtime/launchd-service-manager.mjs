import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { definitionSha256 } from './service-context.mjs'

const PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
let temporaryFileNumber = 0

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function launchctlTarget(context, service) {
  return `${context.domain}/${service.launchdLabel}`
}

function logPath(context, service, suffix) {
  return `${context.logsDir}/${service.key === 'heartbeat' ? 'fleet-daemon' : 'fleet-control-daemon'}${suffix}`
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${temporaryFileNumber += 1}.tmp`
  await writeFile(temporaryPath, content)
  await rename(temporaryPath, path)
}

async function readDefinition(path) {
  try {
    const content = await readFile(path)
    return { content, sha256: definitionSha256(content) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: null, sha256: null }
    throw error
  }
}

async function restoreDefinition(path, previous) {
  if (previous.content === null) {
    await rm(path, { force: true })
    return
  }
  await atomicWrite(path, previous.content)
}

async function bootstrapPriorLoaded(context, indexes, previous, runner) {
  const recovered = new Map()
  for (const index of indexes) {
    if (previous[index].content === null) {
      recovered.set(index, false)
      continue
    }
    const response = await runner(['launchctl', 'bootstrap', context.domain, context.services[index].definitionPath])
    recovered.set(index, response.code === 0)
  }
  return recovered
}

async function bootoutServices(context, indexes, runner) {
  for (const index of indexes) {
    const response = await runner(['launchctl', 'bootout', launchctlTarget(context, context.services[index])])
    if (response.code !== 0 && response.code !== 113) continue
  }
}

function parseTopLevelPid(stdout) {
  let depth = 0
  for (const line of String(stdout).split(/\r?\n/)) {
    if (depth === 1) {
      const match = line.match(/^\s*pid = ([0-9]+)\s*$/)
      if (match) return Number(match[1])
    }
    for (const character of line) {
      if (character === '{') depth += 1
      if (character === '}') depth = Math.max(0, depth - 1)
    }
  }
  return null
}

function resultFor(service, state, extra = {}) {
  return {
    key: service.key,
    name: service.launchdLabel,
    definitionPath: service.definitionPath,
    ...state,
    ...extra,
  }
}

export function renderLaunchd(context) {
  const environment = Object.freeze({ HOME: context.homeDir, PATH })
  return context.services.map((service) => {
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${xml(service.launchdLabel)}</string>`,
      `<key>ProgramArguments</key><array>${service.argv.map((argument) => `<string>${xml(argument)}</string>`).join('')}</array>`,
      `<key>WorkingDirectory</key><string>${xml(context.runtimeDir)}</string>`,
      '<key>RunAtLoad</key><true/>',
      '<key>KeepAlive</key><true/>',
      '<key>ProcessType</key><string>Background</string>',
      `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(environment.HOME)}</string><key>PATH</key><string>${xml(environment.PATH)}</string></dict>`,
      `<key>StandardOutPath</key><string>${xml(logPath(context, service, '.log'))}</string>`,
      `<key>StandardErrorPath</key><string>${xml(logPath(context, service, '.err.log'))}</string>`,
      '</dict></plist>',
    ].join('\n')
    return Object.freeze({
      key: service.key,
      label: service.launchdLabel,
      path: service.definitionPath,
      content,
      environment,
    })
  })
}

export async function statusLaunchd(context, runner) {
  const states = []
  for (const service of context.services) {
    const response = await runner(['launchctl', 'print', launchctlTarget(context, service)])
    if (response.code === 113) {
      states.push(resultFor(service, { loaded: false, enabled: false, running: false, pid: null }))
      continue
    }
    if (response.code !== 0) {
      states.push(resultFor(service, { loaded: null, enabled: null, running: null, pid: null, error: response.stderr || response.stdout || `launchctl print exited ${response.code}` }))
      continue
    }
    const pid = parseTopLevelPid(response.stdout)
    states.push(resultFor(service, { loaded: true, enabled: true, running: pid !== null, pid }))
  }
  return states
}

export async function installLaunchd(context, runner) {
  const definitions = renderLaunchd(context)
  for (const definition of definitions) await atomicWrite(definition.path, definition.content)

  const statuses = await statusLaunchd(context, runner)
  const services = []
  for (const [index, service] of context.services.entries()) {
    const status = statuses[index]
    if (status.loaded !== false) {
      services.push({
        ...status,
        definitionSha256: definitionSha256(definitions[index].content),
        bootstrapped: status.loaded === true ? undefined : false,
      })
      continue
    }
    const response = await runner(['launchctl', 'bootstrap', context.domain, service.definitionPath])
    services.push({
      ...status,
      definitionSha256: definitionSha256(definitions[index].content),
      bootstrapped: response.code === 0,
      error: response.code === 0 ? undefined : (response.stderr || response.stdout || `launchctl bootstrap exited ${response.code}`),
    })
  }
  return { ok: services.every((service) => service.bootstrapped !== false), services }
}

export async function reloadLaunchd(context, runner) {
  const definitions = renderLaunchd(context)
  const previous = await Promise.all(definitions.map((definition) => readDefinition(definition.path)))
  const statuses = await statusLaunchd(context, runner)
  const services = []
  if (statuses.some((status) => status.loaded === null)) {
    return {
      ok: false,
      services: statuses.map((status, index) => ({
        ...status,
        definitionSha256: previous[index].sha256,
        bootstrapped: false,
      })),
    }
  }

  const previouslyLoaded = []

  for (const [index, service] of context.services.entries()) {
    if (!statuses[index].loaded) continue
    const response = await runner(['launchctl', 'bootout', launchctlTarget(context, service)])
    if (response.code !== 0) {
      const recovered = await bootstrapPriorLoaded(context, previouslyLoaded, previous, runner)
      services.push(...statuses.map((status, statusIndex) => ({
        ...status,
        definitionSha256: previous[statusIndex].sha256,
        bootedOut: statusIndex === index ? false : previouslyLoaded.includes(statusIndex),
        rollback: previouslyLoaded.includes(statusIndex) ? recovered.get(statusIndex) : undefined,
        error: statusIndex === index ? (response.stderr || response.stdout || `launchctl bootout exited ${response.code}`) : undefined,
      })))
      return { ok: false, services }
    }
    previouslyLoaded.push(index)
  }

  for (const definition of definitions) await atomicWrite(definition.path, definition.content)

  const newlyBootstrapped = []
  for (const [index, service] of context.services.entries()) {
    const response = await runner(['launchctl', 'bootstrap', context.domain, service.definitionPath])
    if (response.code === 0) {
      newlyBootstrapped.push(index)
      services.push({ ...statuses[index], bootstrapped: true, definitionSha256: definitionSha256(definitions[index].content) })
      continue
    }

    await bootoutServices(context, [...new Set([...newlyBootstrapped, index])], runner)
    await Promise.all(definitions.map((definition, definitionIndex) => restoreDefinition(definition.path, previous[definitionIndex])))
    const recovered = await bootstrapPriorLoaded(context, previouslyLoaded, previous, runner)
    return {
      ok: false,
      services: statuses.map((status, statusIndex) => ({
        ...status,
        definitionSha256: previous[statusIndex].sha256,
        bootstrapped: statusIndex === index ? false : undefined,
        rollback: previouslyLoaded.includes(statusIndex) ? recovered.get(statusIndex) : undefined,
        error: statusIndex === index ? (response.stderr || response.stdout || `launchctl bootstrap exited ${response.code}`) : undefined,
      })),
    }
  }

  return { ok: true, services }
}

export async function uninstallLaunchd(context, runner) {
  const statuses = await statusLaunchd(context, runner)
  if (statuses.some((status) => status.loaded === null)) {
    return {
      ok: false,
      services: statuses.map((status) => ({ ...status, removed: false })),
    }
  }
  const services = []
  for (const [index, service] of context.services.entries()) {
    const status = statuses[index]
    if (status.loaded) {
      const response = await runner(['launchctl', 'bootout', launchctlTarget(context, service)])
      if (response.code !== 0) {
        services.push({ ...status, bootedOut: false, removed: false, error: response.stderr || response.stdout || `launchctl bootout exited ${response.code}` })
        continue
      }
    }
    await rm(service.definitionPath, { force: true })
    services.push({ ...status, bootedOut: status.loaded, removed: true })
  }
  return { ok: services.every((service) => service.removed), services }
}
