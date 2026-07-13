import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServiceContext } from './service-context.mjs'
import {
  installSystemd,
  readLingerState,
  reloadSystemd,
  renderSystemd,
  statusSystemd,
  uninstallSystemd,
} from './systemd-service-manager.mjs'

async function fixtureContext() {
  const root = await mkdtemp(join(tmpdir(), 'mupot-systemd-'))
  return createServiceContext({
    manager: 'systemd',
    homeDir: join(root, 'home with spaces'),
    prefix: join(root, 'fleet with spaces'),
    runtimeDir: join(root, 'runtime with spaces'),
    definitionDir: join(root, 'definitions with spaces'),
    nodePath: join(root, 'bin with spaces', 'node'),
    uid: 1001,
    username: 'fleet',
  })
}

function response(stdout = '', code = 0, stderr = '') {
  return { code, stdout, stderr }
}

function runnerReturning(stdout) {
  return async () => response(stdout)
}

function recordingRunner({ show = 'loaded\nenabled\nactive\n123\n', linger = 'yes\n' } = {}) {
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    if (argv[0] === 'systemctl' && argv[2] === 'show') return response(show)
    if (argv[0] === 'loginctl' && argv[1] === 'show-user') return response(linger)
    return response()
  }
  return { calls, runner }
}

test('renderSystemd emits escaped absolute user-unit definitions', async () => {
  const context = await fixtureContext()
  const definitions = renderSystemd(context)

  assert.deepEqual(definitions.map((definition) => definition.name), [
    'fleet-daemon.service',
    'fleet-control-daemon.service',
  ])
  for (const [index, definition] of definitions.entries()) {
    const service = context.services[index]
    assert.equal(definition.path.startsWith('/'), true)
    assert.match(definition.content, new RegExp(`WorkingDirectory="${context.runtimeDir}"`))
    assert.match(definition.content, new RegExp(`ExecStart="${context.nodePath}" "${service.scriptPath}" "${service.configPath}"`))
    assert.match(definition.content, /Restart=on-failure/)
    assert.match(definition.content, /RestartSec=10/)
    assert.match(definition.content, /NoNewPrivileges=true/)
    assert.match(definition.content, /WantedBy=default.target/)
    assert.doesNotMatch(definition.content, /token|secret|password|private[_-]?key|authorization/i)
  }
})

test('readLingerState normalizes loginctl output', async () => {
  const context = await fixtureContext()

  assert.deepEqual(await readLingerState(context, runnerReturning('Linger=yes\n')), { enabled: true, raw: 'yes' })
  assert.deepEqual(await readLingerState(context, runnerReturning('Linger=no\n')), { enabled: false, raw: 'no' })
})

test('statusSystemd normalizes user service state without treating inactive services as running', async () => {
  const context = await fixtureContext()
  const { calls, runner } = recordingRunner({ show: 'loaded\nenabled\ninactive\n0\n', linger: 'no\n' })

  const result = await statusSystemd(context, runner)

  assert.deepEqual(result.services.map(({ key, name, loaded, enabled, running, pid }) => ({ key, name, loaded, enabled, running, pid })), [
    { key: 'heartbeat', name: 'fleet-daemon.service', loaded: true, enabled: true, running: false, pid: null },
    { key: 'control', name: 'fleet-control-daemon.service', loaded: true, enabled: true, running: false, pid: null },
  ])
  assert.deepEqual(result.linger, { enabled: false, raw: 'no' })
  assert.deepEqual(result.next_steps, ['run loginctl enable-linger <username> with suitable host privileges, then rerun status'])
  assert.deepEqual(calls.filter((call) => call[0] === 'systemctl').map((call) => call.slice(0, 5)), [
    ['systemctl', '--user', 'show', 'fleet-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID'],
    ['systemctl', '--user', 'show', 'fleet-control-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID'],
  ])
  assert.equal(calls.some((call) => call[0] === 'sudo'), false)
})

test('installSystemd writes both units, activates them, and only enables linger explicitly', async () => {
  const context = await fixtureContext()
  const withoutLinger = recordingRunner()

  const first = await installSystemd(context, withoutLinger.runner)

  assert.equal(first.ok, true)
  assert.deepEqual(withoutLinger.calls.filter((call) => call[0] === 'systemctl' && call[2] !== 'show'), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'fleet-daemon.service'],
    ['systemctl', '--user', 'enable', '--now', 'fleet-control-daemon.service'],
  ])
  assert.equal(withoutLinger.calls.some((call) => call[0] === 'loginctl' && call[1] === 'enable-linger'), false)
  for (const service of context.services) {
    assert.match(await readFile(service.definitionPath, 'utf8'), /\[Service\]/)
  }

  const withLinger = recordingRunner()
  await installSystemd(context, withLinger.runner, { enableLinger: true })
  assert.deepEqual(withLinger.calls.filter((call) => call[0] === 'loginctl'), [
    ['loginctl', 'enable-linger', 'fleet'],
    ['loginctl', 'show-user', 'fleet', '-p', 'Linger', '--value'],
  ])
  for (const calls of [withoutLinger.calls, withLinger.calls]) assert.equal(calls.some((call) => call[0] === 'sudo'), false)
})

test('reloadSystemd restarts both units and uninstallSystemd disables both units', async () => {
  const context = await fixtureContext()
  const reload = recordingRunner()

  const reloadResult = await reloadSystemd(context, reload.runner)

  assert.equal(reloadResult.ok, true)
  assert.deepEqual(reload.calls.filter((call) => call[0] === 'systemctl' && call[2] !== 'show'), [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'restart', 'fleet-daemon.service'],
    ['systemctl', '--user', 'restart', 'fleet-control-daemon.service'],
  ])

  const uninstall = recordingRunner()
  const uninstallResult = await uninstallSystemd(context, uninstall.runner)

  assert.equal(uninstallResult.ok, true)
  assert.deepEqual(uninstall.calls.filter((call) => call[0] === 'systemctl' && call[2] !== 'show'), [
    ['systemctl', '--user', 'disable', '--now', 'fleet-daemon.service'],
    ['systemctl', '--user', 'disable', '--now', 'fleet-control-daemon.service'],
    ['systemctl', '--user', 'daemon-reload'],
  ])
  for (const calls of [reload.calls, uninstall.calls]) assert.equal(calls.some((call) => call[0] === 'sudo'), false)
})
