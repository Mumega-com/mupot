// node --test install.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReceipt, parseArgs, summarize } from './install.mjs'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-fleet-install-'))
}

function mode(path) {
  return statSync(path).mode & 0o777
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

test('install receipt creates runtime layout, templates, logs/state, and rendered systemd units', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')

  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir }, { platformName: 'linux' })

  assert.equal(receipt.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(receipt.status, 'warn')
  assert.equal(receipt.summary.failed, 0)
  assert.ok(existsSync(join(prefix, 'runtime', 'fleet-daemon.mjs')))
  assert.ok(existsSync(join(prefix, 'runtime', 'cutover-probe.mjs')))
  assert.ok(existsSync(join(prefix, 'daemon.json')))
  assert.ok(existsSync(join(prefix, 'inbox-handler.json')))
  assert.ok(existsSync(join(prefix, 'control.json')))
  assert.ok(existsSync(join(prefix, 'flights.json')))
  assert.ok(existsSync(join(systemdDir, 'fleet-daemon.service')))
  assert.ok(existsSync(join(systemdDir, 'fleet-control-daemon.service')))
  assert.equal(mode(prefix), 0o700)
  assert.equal(mode(join(prefix, 'runtime')), 0o700)
  assert.equal(mode(join(prefix, 'agents')), 0o700)
  assert.equal(mode(join(prefix, 'logs')), 0o700)
  assert.equal(mode(join(prefix, 'state')), 0o700)
  assert.equal(mode(join(prefix, 'daemon.json')), 0o600)
  assert.ok(receipt.checks.some((c) => c.check === 'config_needs_edit' && c.ok === null))
  assert.ok(receipt.next_steps.some((s) => s.includes('host-receipt.mjs')))
  assert.equal(receipt.inputs.service_manager.requested, 'auto')
  assert.equal(receipt.inputs.service_manager.resolved, 'systemd')
  assert.equal(receipt.outputs.logs_dir, join(prefix, 'logs'))
  assert.equal(receipt.outputs.state_dir, join(prefix, 'state'))
  assert.deepEqual(receipt.outputs.service_definitions.map((definition) => definition.service), ['heartbeat', 'control'])
})

test('installer preserves existing configs unless forceConfig is set', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')

  await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir }, { platformName: 'linux' })
  writeFileSync(join(prefix, 'daemon.json'), '{"custom":true}\n')

  const preserved = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir }, { platformName: 'linux' })
  assert.equal(readFileSync(join(prefix, 'daemon.json'), 'utf8'), '{"custom":true}\n')
  assert.ok(preserved.checks.some((c) => c.check === 'config_preserved' && c.path.endsWith('/daemon.json')))

  const forced = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, forceConfig: true }, { platformName: 'linux' })
  assert.notEqual(readFileSync(join(prefix, 'daemon.json'), 'utf8'), '{"custom":true}\n')
  assert.ok(forced.checks.some((c) => c.check === 'config_template_copied' && c.path.endsWith('/daemon.json')))
})

test('dry run reports planned actions without writing files', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')
  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, dryRun: true }, { platformName: 'linux' })

  assert.equal(receipt.status, 'warn')
  assert.equal(existsSync(prefix), false)
  assert.ok(receipt.checks.some((c) => c.check === 'runtime_file_copied' && c.dry_run === true))
  assert.ok(receipt.checks.some((c) => c.check === 'service_definition_rendered' && c.dry_run === true))
})

test('installer reruns tighten every existing managed directory to mode 0700', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')
  const managed = [
    prefix,
    join(prefix, 'runtime'),
    join(prefix, 'agents'),
    join(prefix, 'handlers'),
    join(prefix, 'inbox'),
    join(prefix, 'logs'),
    join(prefix, 'state'),
    join(prefix, 'receipts'),
    systemdDir,
  ]
  for (const path of managed) {
    mkdirSync(path, { recursive: true })
    chmodSync(path, 0o755)
  }

  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, serviceManager: 'systemd' }, { platformName: 'linux' })

  for (const path of managed) {
    assert.equal(mode(path), 0o700, path)
    assert.equal(receipt.checks.some((check) => check.path === path && check.check.endsWith('_dir_ready') && check.ok === true && check.mode === '700'), true, path)
  }
})

test('installer dry run does not tighten existing managed directory modes', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')
  const managed = [prefix, join(prefix, 'runtime'), join(prefix, 'logs'), systemdDir]
  for (const path of managed) {
    mkdirSync(path, { recursive: true })
    chmodSync(path, 0o755)
  }

  await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, serviceManager: 'systemd', dryRun: true }, {
    platformName: 'linux',
    chmodSync: () => { throw new Error('dry run attempted chmod') },
  })

  for (const path of managed) assert.equal(mode(path), 0o755, path)
})

test('installer fails the directory readiness check when chmod fails', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const logsDir = join(prefix, 'logs')
  mkdirSync(logsDir, { recursive: true })
  chmodSync(logsDir, 0o755)

  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, serviceManager: 'none' }, {
    platformName: 'linux',
    chmodSync: (path, requestedMode) => {
      if (path === logsDir) throw new Error('chmod denied')
      chmodSync(path, requestedMode)
    },
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.checks.some((check) => check.check === 'logs_dir_ready' && check.ok === false && check.reason === 'chmod denied'), true)
})

test('installer resolves launchd from an injected platform and honors custom node and definition directory', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const launchdDir = join(root, 'LaunchAgents')
  const receipt = await buildReceipt({
    sourceDir: SOURCE_DIR,
    prefix,
    serviceManager: 'auto',
    launchdDir,
    nodePath: '/opt/mupot/node',
  }, { platformName: 'darwin', uid: 501, username: 'fleet', homeDir: root })

  assert.equal(receipt.inputs.service_manager.requested, 'auto')
  assert.equal(receipt.inputs.service_manager.resolved, 'launchd')
  assert.equal(receipt.inputs.node_path, '/opt/mupot/node')
  assert.equal(receipt.inputs.service_definition_dir, launchdDir)
  assert.equal(receipt.outputs.service_definitions.every((definition) => existsSync(definition.path)), true)
})

test('installer warns without service definitions when none is explicitly selected', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, serviceManager: 'none' }, { platformName: 'freebsd' })

  assert.equal(receipt.status, 'warn')
  assert.equal(receipt.inputs.service_manager.resolved, 'none')
  assert.equal(receipt.inputs.service_definition_dir, null)
  assert.deepEqual(receipt.outputs.service_definitions, [])
})

test('auto defers launchd directory validation until installer platform resolution', async () => {
  const root = tmpDir()
  const opts = parseArgs([
    '--source', SOURCE_DIR,
    '--prefix', join(root, 'fleet'),
    '--service-manager', 'auto',
    '--launchd-dir', join(root, 'LaunchAgents'),
  ], 'darwin')

  assert.equal(opts.serviceManager, 'auto')
  assert.equal(opts.launchdDirExplicit, true)
  const mac = await buildReceipt(opts, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  const linux = await buildReceipt(opts, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })
  assert.notEqual(mac.status, 'fail')
  assert.equal(mac.inputs.service_manager.resolved, 'launchd')
  assert.equal(linux.status, 'fail')
  assert.match(linux.checks[0].reason, /launchd-dir requires launchd/)
})

test('auto defers systemd directory validation until installer platform resolution', async () => {
  const root = tmpDir()
  const opts = parseArgs([
    '--source', SOURCE_DIR,
    '--prefix', join(root, 'fleet'),
    '--service-manager', 'auto',
    '--systemd-dir', join(root, 'systemd'),
  ], 'linux')

  assert.equal(opts.serviceManager, 'auto')
  assert.equal(opts.systemdDirExplicit, true)
  const linux = await buildReceipt(opts, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })
  const mac = await buildReceipt(opts, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  assert.notEqual(linux.status, 'fail')
  assert.equal(linux.inputs.service_manager.resolved, 'systemd')
  assert.equal(mac.status, 'fail')
  assert.match(mac.checks[0].reason, /systemd-dir requires systemd/)
})

test('auto defers enable-linger validation until installer platform resolution', async () => {
  const root = tmpDir()
  const opts = parseArgs([
    '--source', SOURCE_DIR,
    '--prefix', join(root, 'fleet'),
    '--service-manager', 'auto',
    '--enable-linger',
  ], 'linux')

  assert.equal(opts.serviceManager, 'auto')
  assert.equal(opts.enableLinger, true)
  const linux = await buildReceipt(opts, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })
  const mac = await buildReceipt(opts, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  assert.notEqual(linux.status, 'fail')
  assert.equal(linux.inputs.service_manager.resolved, 'systemd')
  assert.equal(mac.status, 'fail')
  assert.match(mac.checks[0].reason, /enable-linger requires systemd/)
})

test('direct installer calls infer explicit service-manager options', async () => {
  const root = tmpDir()
  const launchdDir = join(root, 'LaunchAgents')
  const systemdDir = join(root, 'systemd')
  const common = { sourceDir: SOURCE_DIR, prefix: join(root, 'fleet') }

  const mac = await buildReceipt({ ...common, serviceManager: 'auto', launchdDir }, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  const linux = await buildReceipt({ ...common, serviceManager: 'auto', systemdDir, enableLinger: true }, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })
  const wrongLaunchd = await buildReceipt({ ...common, prefix: join(root, 'wrong-launchd'), serviceManager: 'auto', launchdDir }, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })
  const wrongSystemd = await buildReceipt({ ...common, prefix: join(root, 'wrong-systemd'), serviceManager: 'auto', systemdDir }, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  const wrongLinger = await buildReceipt({ ...common, prefix: join(root, 'wrong-linger'), serviceManager: 'auto', enableLinger: true }, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })
  const conflictingSkip = await buildReceipt({ ...common, prefix: join(root, 'skip-conflict'), serviceManager: 'launchd', skipSystemd: true }, { platformName: 'darwin', homeDir: root, uid: 501, username: 'fleet' })

  assert.notEqual(mac.status, 'fail')
  assert.notEqual(linux.status, 'fail')
  assert.match(wrongLaunchd.checks[0].reason, /launchd-dir requires launchd/)
  assert.match(wrongSystemd.checks[0].reason, /systemd-dir requires systemd/)
  assert.match(wrongLinger.checks[0].reason, /enable-linger requires systemd/)
  assert.match(conflictingSkip.checks[0].reason, /conflicts/)
})

test('direct installer calls reject relative Node paths consistently with the CLI', async () => {
  const root = tmpDir()
  const receipt = await buildReceipt({
    sourceDir: SOURCE_DIR,
    prefix: join(root, 'fleet'),
    serviceManager: 'none',
    nodePath: './node',
  }, { platformName: 'darwin' })

  assert.equal(receipt.status, 'fail')
  assert.match(receipt.checks[0].reason, /--node requires an absolute path/)
  assert.throws(() => parseArgs(['--node', './node']), /--node requires an absolute path/)
})

test('installer rejects secret-looking configured paths without serializing markers', async () => {
  const marker = 'mupot_abcdefghijklmnop'
  const cases = [
    { field: 'sourceDir', serviceManager: 'none', platformName: 'darwin' },
    { field: 'prefix', serviceManager: 'none', platformName: 'darwin' },
    { field: 'launchdDir', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'systemdDir', serviceManager: 'systemd', platformName: 'linux' },
    { field: 'nodePath', serviceManager: 'none', platformName: 'darwin' },
    { field: 'homeDir', serviceManager: 'none', platformName: 'darwin' },
  ]

  for (const { field, serviceManager, platformName } of cases) {
    const receipt = await buildReceipt({
      sourceDir: SOURCE_DIR,
      prefix: join(tmpDir(), 'fleet'),
      serviceManager,
      dryRun: true,
      [field]: `/tmp/${marker}`,
    }, { platformName })
    assert.equal(receipt.status, 'fail', field)
    assert.equal(receipt.checks[0].reason, 'configured path contains a prohibited secret-like value', field)
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(marker), field)
  }
  assert.throws(
    () => parseArgs(['--source', `/tmp/${marker}`], 'darwin'),
    (error) => error.message === 'configured path contains a prohibited secret-like value' && !error.message.includes(marker),
  )
})

test('installer parsing resolves auto manager conflicts for the supplied platform and keeps help usable', () => {
  assert.throws(() => parseArgs(['--service-manager', 'auto', '--systemd-dir', '/tmp/systemd'], 'darwin'), /systemd-dir requires systemd/)
  assert.throws(() => parseArgs(['--service-manager', 'auto', '--launchd-dir', '/tmp/LaunchAgents'], 'linux'), /launchd-dir requires launchd/)
  assert.throws(() => parseArgs(['--service-manager', 'auto', '--enable-linger'], 'darwin'), /enable-linger requires systemd/)
  assert.equal(parseArgs(['--service-manager', 'auto', '--launchd-dir', '/tmp/LaunchAgents'], 'darwin').serviceManager, 'auto')
  assert.equal(parseArgs(['--service-manager', 'auto', '--systemd-dir', '/tmp/systemd', '--enable-linger'], 'linux').serviceManager, 'auto')
  assert.equal(parseArgs(['--help', '--service-manager', 'auto', '--systemd-dir', '/tmp/systemd'], 'darwin').help, true)
})

test('activation runs only after definition rendering succeeds and nests failed service receipts', async () => {
  const root = tmpDir()
  const prefix = join(root, 'fleet')
  const systemdDir = join(root, 'systemd')
  let activatedAfterDefinitions = false
  const receipt = await buildReceipt({ sourceDir: SOURCE_DIR, prefix, systemdDir, activate: true }, {
    platformName: 'linux',
    buildServiceReceipt: async (opts) => {
      activatedAfterDefinitions = opts.action === 'install' && existsSync(join(systemdDir, 'fleet-daemon.service'))
      return { receipt_type: 'mupot-fleet-service-receipt/v1', status: 'fail', next_steps: ['retry service install'] }
    },
  })

  assert.equal(activatedAfterDefinitions, true)
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.activation.status, 'fail')
  assert.deepEqual(receipt.next_steps.filter((step) => step === 'retry service install'), ['retry service install'])
})

test('installer shell-quotes the exact next lifecycle command', async () => {
  const root = tmpDir()
  const prefix = join(root, "fleet owner's host")
  const systemdDir = join(root, "systemd user's units")
  const nodePath = "/opt/Mupot Node's/bin/node"

  const receipt = await buildReceipt({
    sourceDir: SOURCE_DIR,
    prefix,
    systemdDir,
    nodePath,
    serviceManager: 'systemd',
    enableLinger: true,
  }, { platformName: 'linux', homeDir: root, uid: 1001, username: 'fleet' })

  const expected = `${shellQuote(nodePath)} ${shellQuote(join(prefix, 'runtime', 'service-manager.mjs'))} ${shellQuote('install')} --service-manager ${shellQuote('systemd')} --prefix ${shellQuote(prefix)} --systemd-dir ${shellQuote(systemdDir)} --node ${shellQuote(nodePath)} --enable-linger`
  assert.equal(receipt.next_steps.includes(expected), true)
})

test('activation exceptions use a complete redacted service failure envelope', async () => {
  const root = tmpDir()
  const prefix = join(root, "fleet owner's host")
  const systemdDir = join(root, "systemd user's units")
  const nodePath = "/opt/Mupot Node's/bin/node"
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ'

  const receipt = await buildReceipt({
    sourceDir: SOURCE_DIR,
    prefix,
    systemdDir,
    nodePath,
    serviceManager: 'systemd',
    activate: true,
    enableLinger: true,
  }, {
    platformName: 'linux',
    homeDir: root,
    uid: 1001,
    username: 'fleet',
    buildServiceReceipt: async () => { throw new Error(`systemctl unavailable: ${secret}`) },
  })

  const expected = `${shellQuote(nodePath)} ${shellQuote(join(prefix, 'runtime', 'service-manager.mjs'))} ${shellQuote('install')} --service-manager ${shellQuote('systemd')} --prefix ${shellQuote(prefix)} --systemd-dir ${shellQuote(systemdDir)} --node ${shellQuote(nodePath)} --enable-linger`
  assert.equal(receipt.status, 'fail')
  assert.deepEqual(Object.keys(receipt.activation), [
    'receipt_type', 'generated_at', 'status', 'platform', 'service_manager', 'action',
    'definitions', 'services', 'linger', 'commands', 'preserved_data', 'next_steps', 'checks',
  ])
  assert.equal(receipt.activation.receipt_type, 'mupot-fleet-service-receipt/v1')
  assert.equal(receipt.activation.status, 'fail')
  assert.deepEqual(receipt.activation.definitions, receipt.outputs.service_definitions)
  assert.deepEqual(receipt.activation.services, [])
  assert.equal(receipt.activation.linger, null)
  assert.deepEqual(receipt.activation.commands, [])
  assert.deepEqual(receipt.activation.preserved_data, { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true })
  assert.deepEqual(receipt.activation.next_steps, [expected])
  assert.deepEqual(receipt.activation.checks, [
    { ok: false, check: 'service_operation_failed', reason: 'systemctl unavailable: [REDACTED:openai_api_key]' },
    { ok: false, check: 'command_output_secret_free' },
  ])
  assert.equal(receipt.checks.some((check) => check.check === 'service_activation' && check.ok === false && check.reason === 'systemctl unavailable: [REDACTED:openai_api_key]'), true)
  assert.equal(receipt.next_steps.filter((step) => step === expected).length, 1)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret))
})

test('parseArgs and summarize cover install options', () => {
  const opts = parseArgs([
    '--source', './fleet-runtime',
    '--prefix', './tmp-fleet',
    '--systemd-dir', './tmp-systemd',
    '--service-manager', 'systemd',
    '--node', '/opt/mupot/node',
    '--enable-linger',
    '--activate',
    '--force-config',
    '--dry-run',
  ])

  assert.ok(opts.sourceDir.endsWith('/fleet-runtime'))
  assert.ok(opts.prefix.endsWith('/tmp-fleet'))
  assert.ok(opts.systemdDir.endsWith('/tmp-systemd'))
  assert.equal(opts.skipSystemd, false)
  assert.equal(opts.forceConfig, true)
  assert.equal(opts.dryRun, true)
  assert.equal(opts.serviceManager, 'systemd')
  assert.equal(opts.nodePath, '/opt/mupot/node')
  assert.equal(opts.enableLinger, true)
  assert.equal(opts.activate, true)
  assert.deepEqual(summarize([{ ok: true }, { ok: null }]), { status: 'warn', passed: 1, failed: 0, warnings: 1 })
  assert.throws(() => parseArgs(['--prefix']), /requires a value/)
  assert.throws(() => parseArgs(['--service-manager', 'launchd', '--systemd-dir', './units']), /systemd-dir/)
  assert.throws(() => parseArgs(['--service-manager', 'systemd', '--launchd-dir', './agents']), /launchd-dir/)
})
