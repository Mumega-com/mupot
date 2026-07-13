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

function recordingRunner({ show = 'loaded\nenabled\nactive\n123\n', linger = 'yes\n', respond } = {}) {
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    const customResponse = respond?.(argv, calls)
    if (customResponse) return customResponse
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
    assert.match(definition.content, new RegExp(`Environment="HOME=${context.homeDir}"`))
    assert.match(definition.content, /Environment="PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/)
    assert.match(definition.content, /Restart=on-failure/)
    assert.match(definition.content, /RestartSec=10/)
    assert.match(definition.content, /NoNewPrivileges=true/)
    assert.match(definition.content, /WantedBy=default.target/)
    assert.doesNotMatch(definition.content, /token|secret|password|private[_-]?key|authorization/i)
  }
})

test('renderSystemd preserves literal systemd specifiers and ExecStart dollar paths', () => {
  const context = createServiceContext({
    manager: 'systemd',
    homeDir: '/tmp/home %u ${HOME} "quoted" \\path',
    prefix: '/tmp/fleet %u ${HOME}',
    runtimeDir: '/tmp/runtime %u ${HOME}',
    definitionDir: '/tmp/definitions %u ${HOME}',
    nodePath: '/tmp/bin %u ${HOME}/node',
    uid: 1001,
    username: 'fleet',
  })

  const expectedExecStarts = [
    'ExecStart="/tmp/bin %%u $${HOME}/node" "/tmp/runtime %%u $${HOME}/fleet-daemon.mjs" "/tmp/fleet %%u $${HOME}/daemon.json"',
    'ExecStart="/tmp/bin %%u $${HOME}/node" "/tmp/runtime %%u $${HOME}/fleet-control-daemon.mjs" "/tmp/fleet %%u $${HOME}/control.json"',
  ]
  for (const [index, definition] of renderSystemd(context).entries()) {
    assert.equal(definition.content.split('\n').find((line) => line.startsWith('WorkingDirectory=')), 'WorkingDirectory="/tmp/runtime %%u ${HOME}"')
    assert.equal(definition.content.split('\n').find((line) => line.startsWith('ExecStart=')), expectedExecStarts[index])
    assert.equal(definition.content.split('\n').find((line) => line.startsWith('Environment="HOME=')), 'Environment="HOME=/tmp/home %%u ${HOME} \\"quoted\\" \\\\path"')
    assert.equal(definition.content.split('\n').find((line) => line.startsWith('Environment="PATH=')), 'Environment="PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"')
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

test('statusSystemd reports failed systemctl and loginctl queries without a successful status result', async () => {
  const context = await fixtureContext()
  const failedShow = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'show' ? response('', 1, 'show failed') : undefined,
  })

  const serviceFailure = await statusSystemd(context, failedShow.runner)

  assert.equal(serviceFailure.ok, false)
  assert.deepEqual(serviceFailure.services.map(({ loaded, enabled, running, pid, error }) => ({ loaded, enabled, running, pid, error })), [
    { loaded: null, enabled: null, running: null, pid: null, error: 'show failed' },
    { loaded: null, enabled: null, running: null, pid: null, error: 'show failed' },
  ])
  assert.deepEqual(serviceFailure.linger, { enabled: true, raw: 'yes' })

  const failedLinger = recordingRunner({
    respond: (argv) => argv[0] === 'loginctl' && argv[1] === 'show-user' ? response('', 1, 'linger failed') : undefined,
  })

  const lingerFailure = await statusSystemd(context, failedLinger.runner)

  assert.equal(lingerFailure.ok, false)
  assert.deepEqual(lingerFailure.linger, { enabled: null, raw: null, error: 'linger failed' })
  assert.deepEqual(lingerFailure.next_steps, [])
})

test('statusSystemd normalizes only confirmed absent units as unloaded', async () => {
  const context = await fixtureContext()
  const absent = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'show'
      ? argv[3] === 'fleet-daemon.service'
        ? response('not-found\ndisabled\ninactive\n0\n', 4, `Unit ${argv[3]} could not be found.`)
        : response('', 4, `Unit ${argv[3]} could not be found.`)
      : undefined,
  })

  const absentStatus = await statusSystemd(context, absent.runner)

  assert.equal(absentStatus.ok, true)
  assert.deepEqual(absentStatus.services.map(({ loaded, enabled, running, pid }) => ({ loaded, enabled, running, pid })), [
    { loaded: false, enabled: false, running: false, pid: null },
    { loaded: false, enabled: false, running: false, pid: null },
  ])

  const unrelatedFailure = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'show'
      ? response('', 4, 'Failed to connect to bus: Permission denied')
      : undefined,
  })

  const failedStatus = await statusSystemd(context, unrelatedFailure.runner)

  assert.equal(failedStatus.ok, false)
  assert.equal(failedStatus.services.every((service) => service.loaded === null), true)
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
  const withLingerResult = await installSystemd(context, withLinger.runner, { enableLinger: true })
  assert.deepEqual(withLinger.calls.filter((call) => call[0] === 'loginctl'), [
    ['loginctl', 'enable-linger', 'fleet'],
    ['loginctl', 'show-user', 'fleet', '-p', 'Linger', '--value'],
  ])
  assert.deepEqual(withLingerResult.linger_enable, {
    attempted: true,
    command_succeeded: true,
    confirmed_enabled: true,
    error: null,
  })
  for (const calls of [withoutLinger.calls, withLinger.calls]) assert.equal(calls.some((call) => call[0] === 'sudo'), false)
})

test('installSystemd fails requested linger enablement unless command and confirmation both succeed', async () => {
  const context = await fixtureContext()
  const commandFailure = recordingRunner({
    linger: 'no\n',
    respond: (argv) => argv[0] === 'loginctl' && argv[1] === 'enable-linger' ? response('', 1, 'permission denied') : undefined,
  })

  const failedCommand = await installSystemd(context, commandFailure.runner, { enableLinger: true })

  assert.equal(failedCommand.ok, false)
  assert.deepEqual(failedCommand.linger, { enabled: false, raw: 'no' })
  assert.deepEqual(failedCommand.linger_enable, {
    attempted: true,
    command_succeeded: false,
    confirmed_enabled: false,
    error: 'permission denied',
  })
  assert.deepEqual(failedCommand.next_steps, ['run loginctl enable-linger <username> with suitable host privileges, then rerun status'])

  const missingConfirmation = recordingRunner({ linger: 'no\n' })
  const unconfirmed = await installSystemd(context, missingConfirmation.runner, { enableLinger: true })

  assert.equal(unconfirmed.ok, false)
  assert.deepEqual(unconfirmed.linger_enable, {
    attempted: true,
    command_succeeded: true,
    confirmed_enabled: false,
    error: null,
  })
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

test('lifecycle operations report daemon-reload and partial mutation failures', async () => {
  const context = await fixtureContext()
  const failedReload = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'daemon-reload' ? response('', 1, 'reload failed') : undefined,
  })

  const reloadFailure = await installSystemd(context, failedReload.runner)

  assert.equal(reloadFailure.ok, false)
  assert.deepEqual(reloadFailure.services.map(({ enabled, error }) => ({ enabled, error })), [
    { enabled: false, error: 'reload failed' },
    { enabled: false, error: 'reload failed' },
  ])
  assert.equal(failedReload.calls.some((call) => call[2] === 'enable'), false)

  const partialEnable = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'enable' && argv[4] === 'fleet-control-daemon.service'
      ? response('', 1, 'enable failed')
      : undefined,
  })
  const enableFailure = await installSystemd(context, partialEnable.runner)
  assert.equal(enableFailure.ok, false)
  assert.deepEqual(enableFailure.services.map(({ enabled, error }) => ({ enabled, error })), [
    { enabled: true, error: undefined },
    { enabled: false, error: 'enable failed' },
  ])

  const partialRestart = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'restart' && argv[3] === 'fleet-control-daemon.service'
      ? response('', 1, 'restart failed')
      : undefined,
  })
  const restartFailure = await reloadSystemd(context, partialRestart.runner)
  assert.equal(restartFailure.ok, false)
  assert.deepEqual(restartFailure.services.map(({ restarted, error }) => ({ restarted, error })), [
    { restarted: true, error: undefined },
    { restarted: false, error: 'restart failed' },
  ])

  const partialDisable = recordingRunner({
    respond: (argv) => argv[0] === 'systemctl' && argv[2] === 'disable' && argv[4] === 'fleet-control-daemon.service'
      ? response('', 1, 'disable failed')
      : undefined,
  })
  const disableFailure = await uninstallSystemd(context, partialDisable.runner)
  assert.equal(disableFailure.ok, false)
  assert.deepEqual(disableFailure.services.map(({ removed, error }) => ({ removed, error })), [
    { removed: true, error: undefined },
    { removed: false, error: 'disable failed' },
  ])
})
