import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  SERVICE_SPECS,
  createServiceContext,
  definitionSha256,
  resolveServiceManager,
  summarizeServiceStates,
  validateServiceOptions,
} from './service-context.mjs'

test('auto selects launchd on macOS and systemd on Linux', () => {
  assert.equal(resolveServiceManager('auto', 'darwin'), 'launchd')
  assert.equal(resolveServiceManager('auto', 'linux'), 'systemd')
  assert.throws(() => resolveServiceManager('auto', 'freebsd'), /unsupported platform/)
  assert.equal(resolveServiceManager('none', 'freebsd'), 'none')
})

test('legacy and manager-specific options fail closed', () => {
  assert.equal(validateServiceOptions({ skipSystemd: true }).serviceManager, 'none')
  assert.throws(() => validateServiceOptions({ skipSystemd: true, serviceManager: 'launchd', serviceManagerExplicit: true }), /conflicts/)
  assert.throws(() => validateServiceOptions({ serviceManager: 'launchd', systemdDir: '/tmp/systemd', systemdDirExplicit: true }), /systemd-dir/)
  assert.throws(() => validateServiceOptions({ serviceManager: 'launchd', enableLinger: true }), /enable-linger/)
})

test('context contains only absolute non-secret execution paths', () => {
  const context = createServiceContext({
    manager: 'launchd',
    prefix: '/tmp/Mupot Host/.fleet',
    definitionDir: '/tmp/Launch Agents',
    nodePath: '/opt/homebrew/bin/node',
    homeDir: '/Users/example',
    uid: 501,
    username: 'example',
  })
  assert.equal(context.domain, 'gui/501')
  assert.equal(context.services[0].argv[1], join(context.prefix, 'runtime', 'fleet-daemon.mjs'))
  assert.match(JSON.stringify(context), /Mupot Host/)
  assert.doesNotMatch(JSON.stringify(context), /token|private_key|authorization/i)
})

test('service definitions and context records are immutable', () => {
  const context = createServiceContext({
    manager: 'systemd',
    prefix: '/tmp/fleet',
    definitionDir: '/tmp/systemd',
    nodePath: '/usr/local/bin/node',
    homeDir: '/Users/example',
    uid: 501,
    username: 'example',
  })

  assert.equal(SERVICE_SPECS.length, 2)
  assert.equal(context.services[1].name, 'fleet-control-daemon.service')
  assert.equal(context.services[1].definitionPath, '/tmp/systemd/fleet-control-daemon.service')
  assert.ok(Object.isFrozen(context))
  assert.ok(Object.isFrozen(context.services[0].argv))
})

test('service state summaries redact definition content and normalize unknown booleans', () => {
  const summary = summarizeServiceStates([{
    key: 'heartbeat',
    name: 'com.mumega.mupot-fleet-daemon',
    definitionPath: '/tmp/LaunchAgents/com.mumega.mupot-fleet-daemon.plist',
    definition: '<plist>private_key</plist>',
    loaded: true,
    running: false,
    pid: 123,
  }])

  assert.deepEqual(summary, [{
    key: 'heartbeat',
    name: 'com.mumega.mupot-fleet-daemon',
    definition_path: '/tmp/LaunchAgents/com.mumega.mupot-fleet-daemon.plist',
    definition_sha256: definitionSha256('<plist>private_key</plist>'),
    loaded: true,
    enabled: null,
    running: false,
    pid: 123,
  }])
  assert.doesNotMatch(JSON.stringify(summary), /private_key/)
})
