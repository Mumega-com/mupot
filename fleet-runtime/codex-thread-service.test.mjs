import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderLaunchd } from './launchd-service-manager.mjs'
import { renderSystemd } from './systemd-service-manager.mjs'
import {
  buildCodexThreadServiceReceipt,
  createCodexThreadServiceContext,
  parseCodexThreadServiceArgs,
} from './codex-thread-service.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-codex-thread-service-'))
  const configPath = join(dir, 'endpoint.json')
  writeFileSync(configPath, JSON.stringify({
    schema: 'mupot.codex-thread-endpoint/v1',
    base_url: 'https://pot.example',
    token_file: join(dir, 'agent.token'),
    thread_id: '00000000-0000-4000-8000-000000000001',
    exclusive_thread: true,
    app_server_socket: join(dir, 'app-server.sock'),
    workdir: dir,
    node_id: 'node-local',
    local_source_id: 'sos-hadi-codex-session-0042',
    project_id: 'project-mupot',
    purpose: 'mupot-review',
    workspace: 'Mumega-com/mupot',
    allowed_senders: ['kasra'],
    poll_ms: 5000,
    lease_seconds: 300,
    timeout_ms: 600000,
    http_timeout_ms: 15000,
    shutdown_grace_ms: 5000,
    state_file: join(dir, 'state.json'),
    spool_dir: join(dir, 'spool'),
  }))
  return { dir, configPath }
}

test('one exact thread gets a stable separately named launchd service', () => {
  const { dir, configPath } = fixture()
  const context = createCodexThreadServiceContext({
    configPath,
    manager: 'launchd',
    prefix: dir,
    launchdDir: join(dir, 'LaunchAgents'),
    nodePath: '/usr/local/bin/node',
    homeDir: dir,
    uid: 501,
    username: 'tester',
  })
  const [service] = context.services
  assert.match(service.launchdLabel, /^com\.mumega\.mupot-codex-thread\.[a-f0-9]{16}$/)
  assert.deepEqual(service.argv, [
    '/usr/local/bin/node',
    join(dir, 'runtime', 'codex-thread-endpoint.mjs'),
    configPath,
  ])
  const [definition] = renderLaunchd(context)
  assert.match(definition.content, /codex-thread-[a-f0-9]{16}\.log/)
  assert.match(context.lifecycleCommand('reload'), /codex-thread-service\.mjs/)
  assert.match(context.lifecycleCommand('reload'), /--config/)
})

test('systemd service identifies the local source label without exposing credentials', () => {
  const { dir, configPath } = fixture()
  const context = createCodexThreadServiceContext({
    configPath,
    manager: 'systemd',
    prefix: dir,
    systemdDir: join(dir, 'systemd'),
    nodePath: '/usr/local/bin/node',
    homeDir: dir,
    uid: 1000,
    username: 'tester',
  })
  const [definition] = renderSystemd(context)
  assert.match(definition.content, /Mupot exact Codex thread endpoint \(sos-hadi-codex-session-0042\)/)
  assert.doesNotMatch(definition.content, /Bearer|mupot_|endpoint_capability/)
})

test('service CLI requires an exact config and produces a dry-run lifecycle receipt', async () => {
  const { dir, configPath } = fixture()
  assert.throws(
    () => parseCodexThreadServiceArgs(['install'], 'darwin'),
    /--config is required/,
  )
  const options = parseCodexThreadServiceArgs([
    'install',
    '--config', configPath,
    '--prefix', dir,
    '--launchd-dir', join(dir, 'LaunchAgents'),
    '--node', '/usr/local/bin/node',
    '--dry-run',
  ], 'darwin')
  const context = createCodexThreadServiceContext({
    ...options,
    homeDir: dir,
    uid: 501,
    username: 'tester',
  })
  const receipt = await buildCodexThreadServiceReceipt(options, {
    context,
    platformName: 'darwin',
  })
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.services.length, 1)
  assert.match(receipt.services[0].name, /^com\.mumega\.mupot-codex-thread\./)
})
