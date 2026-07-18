#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function fresh(value, nowMs, maxStaleMs) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp <= maxStaleMs
}

export function evaluateContainerReadiness({ heartbeat, control, childrenAlive, nowMs = Date.now(), maxStaleMs = 120000 }) {
  const reasons = []
  if (!childrenAlive) reasons.push('child_not_running')
  if (!heartbeat || heartbeat.schema !== 'mupot-fleet-daemon-state/v1') {
    reasons.push('heartbeat_invalid')
  } else {
    if (!fresh(heartbeat.last_tick_at, nowMs, maxStaleMs)) reasons.push('heartbeat_stale')
    const agents = Array.isArray(heartbeat.agents) ? heartbeat.agents : []
    if (!agents.some((agent) => agent?.probe === true && Number(agent.heartbeat_status) >= 200 && Number(agent.heartbeat_status) < 300)) {
      reasons.push('agent_unhealthy')
    }
  }
  if (!control || control.schema !== 'mupot-fleet-control-state/v1') {
    reasons.push('control_invalid')
  } else if (!fresh(control.last_poll_at, nowMs, maxStaleMs)) {
    reasons.push('control_stale')
  }
  return { ready: reasons.length === 0, reasons }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body) + '\n'
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

export async function main(options = {}) {
  const env = options.env ?? process.env
  const spawnImpl = options.spawnImpl ?? spawn
  const nodePath = options.nodePath ?? process.execPath
  const daemonConfig = env.MUPOT_DAEMON_CONFIG ?? '/etc/mupot/daemon.json'
  const controlConfig = env.MUPOT_CONTROL_CONFIG ?? '/etc/mupot/control.json'
  const stateDir = env.MUPOT_STATE_DIR ?? '/var/lib/mupot/state'
  const heartbeatPath = env.MUPOT_HEARTBEAT_STATE ?? join(stateDir, 'fleet-daemon.json')
  const controlPath = env.MUPOT_CONTROL_STATE ?? join(stateDir, 'fleet-control.json')
  const healthPort = Number(env.MUPOT_HEALTH_PORT ?? 8080)
  const maxStaleMs = Number(env.MUPOT_MAX_STALE_MS ?? 120000)
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) throw new Error('invalid MUPOT_HEALTH_PORT')
  if (!Number.isFinite(maxStaleMs) || maxStaleMs < 1000 || maxStaleMs > 600000) throw new Error('invalid MUPOT_MAX_STALE_MS')

  const children = [
    spawnImpl(nodePath, [join(HERE, 'fleet-daemon.mjs'), daemonConfig], { shell: false, stdio: 'inherit' }),
    spawnImpl(nodePath, [join(HERE, 'fleet-control-daemon.mjs'), controlConfig], { shell: false, stdio: 'inherit' }),
  ]
  let shuttingDown = false
  const alive = new Set(children)

  const server = createServer((request, response) => {
    if (request.url === '/live') {
      const live = alive.size === children.length
      return writeJson(response, live ? 200 : 503, { live })
    }
    if (request.url === '/ready') {
      const readiness = evaluateContainerReadiness({
        heartbeat: readJson(heartbeatPath),
        control: readJson(controlPath),
        childrenAlive: alive.size === children.length,
        maxStaleMs,
      })
      return writeJson(response, readiness.ready ? 200 : 503, readiness)
    }
    return writeJson(response, 404, { error: 'not_found' })
  })

  const stop = (signal = 'SIGTERM') => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    for (const child of children) {
      try { child.kill(signal) } catch { /* already stopped */ }
    }
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal))
  for (const child of children) {
    child.on('exit', (code) => {
      alive.delete(child)
      if (!shuttingDown) {
        process.exitCode = Number.isInteger(code) && code !== 0 ? code : 1
        stop('SIGTERM')
      }
    })
    child.on('error', () => {
      alive.delete(child)
      process.exitCode = 1
      stop('SIGTERM')
    })
  }
  server.listen(healthPort, '0.0.0.0')
  return { server, children, stop }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
