import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServiceContext } from './service-context.mjs'
import { buildFailedServiceReceipt, buildServiceReceipt, parseServiceArgs } from './service-manager.mjs'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-service-manager-'))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function fixtureContext(manager = 'launchd') {
  const root = tmpDir()
  return createServiceContext({
    manager,
    platformName: manager === 'launchd' ? 'darwin' : 'linux',
    homeDir: join(root, 'home'),
    prefix: join(root, 'fleet'),
    definitionDir: join(root, 'definitions'),
    nodePath: '/opt/mupot/node',
    uid: 501,
    username: 'fleet',
  })
}

function adapter(states = {}) {
  const definitions = (context) => context.services.map((service) => ({
    key: service.key,
    name: service.name,
    path: service.definitionPath,
    content: `definition:${service.key}`,
  }))
  const serviceStates = (context) => context.services.map((service) => ({
    key: service.key,
    name: service.name,
    definitionPath: service.definitionPath,
    loaded: true,
    enabled: true,
    running: true,
    pid: service.key === 'heartbeat' ? 11 : 12,
  }))
  return {
    render: definitions,
    install: async (context, runner) => {
      await runner(['manager', 'install'])
      return { ok: true, services: serviceStates(context) }
    },
    reload: async (context, runner) => {
      await runner(['manager', 'reload'])
      return { ok: true, services: serviceStates(context) }
    },
    status: async (context, runner) => {
      await runner(['manager', 'status'])
      return states.status ?? { ok: true, services: serviceStates(context), linger: null, next_steps: [] }
    },
    uninstall: async (context, runner) => {
      await runner(['manager', 'uninstall'])
      return { ok: true, services: serviceStates(context).map((service) => ({ ...service, loaded: false, enabled: false, running: false, pid: null })) }
    },
  }
}

test('parseServiceArgs accepts shared flags and rejects invalid lifecycle invocations', () => {
  const opts = parseServiceArgs([
    'install', '--service-manager', 'launchd', '--prefix', './fleet', '--launchd-dir', './agents',
    '--node', '/opt/mupot/node', '--dry-run',
  ])
  assert.equal(opts.action, 'install')
  assert.equal(opts.serviceManager, 'launchd')
  assert.ok(opts.prefix.endsWith('/fleet'))
  assert.ok(opts.launchdDir.endsWith('/agents'))
  assert.equal(opts.nodePath, '/opt/mupot/node')
  assert.equal(opts.dryRun, true)
  assert.throws(() => parseServiceArgs([]), /required action/)
  assert.throws(() => parseServiceArgs(['install', 'status']), /exactly one action/)
  assert.throws(() => parseServiceArgs(['install', '--service-manager', 'launchd', '--systemd-dir', '/tmp/systemd']), /systemd-dir/)
  assert.throws(() => parseServiceArgs(['install', '--service-manager', 'launchd', '--enable-linger']), /enable-linger/)
  assert.throws(() => parseServiceArgs(['install', '--service-manager', 'none']), /require launchd or systemd/)
  assert.throws(() => parseServiceArgs(['install', '--service-manager', 'auto', '--systemd-dir', '/tmp/systemd'], 'darwin'), /systemd-dir/)
})

test('service receipt resolves platform, records hashes, and requires running services', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'install', serviceManager: 'auto' }, {
    platformName: 'darwin',
    createServiceContext: () => context,
    launchd: adapter(),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-service-receipt/v1')
  assert.equal(receipt.platform, 'darwin')
  assert.equal(receipt.service_manager, 'launchd')
  assert.equal(receipt.status, 'pass')
  assert.deepEqual(receipt.services.map((service) => service.key), ['heartbeat', 'control'])
  assert.deepEqual(Object.keys(receipt.services[0]), ['key', 'name', 'loaded', 'enabled', 'running', 'pid'])
  assert.deepEqual(receipt.definitions.map((definition) => definition.path), context.services.map((service) => service.definitionPath))
  assert.equal(receipt.definitions.every((definition) => /^[a-f0-9]{64}$/.test(definition.sha256)), true)
  assert.deepEqual(receipt.preserved_data, { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true })
  assert.equal(receipt.commands[0].executable, 'manager')
})

test('reload receipt waits for bounded post-bootstrap service readiness', async () => {
  const context = fixtureContext()
  const delays = []
  let statusCalls = 0
  const launchd = adapter()
  launchd.status = async (current) => {
    statusCalls += 1
    const running = statusCalls >= 3
    return {
      ok: true,
      services: current.services.map((service, index) => ({
        key: service.key,
        name: service.name,
        definitionPath: service.definitionPath,
        loaded: true,
        enabled: true,
        running,
        pid: running ? index + 20 : null,
      })),
      linger: null,
      next_steps: [],
    }
  }

  const receipt = await buildServiceReceipt({ action: 'reload', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    createServiceContext: () => context,
    launchd,
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    sleep: async (milliseconds) => { delays.push(milliseconds) },
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(statusCalls, 3)
  assert.deepEqual(delays, [250, 750])
})

test('service receipt redacts secret-looking command output and fails closed', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    createServiceContext: () => context,
    launchd: adapter(),
    runner: async () => ({ code: 0, stdout: 'Bearer abcdefghijklmnop', stderr: '' }),
  })

  assert.equal(receipt.status, 'fail')
  assert.deepEqual(Object.keys(receipt.services[0]), ['key', 'name', 'loaded', 'enabled', 'running', 'pid'])
  assert.match(receipt.commands[0].stdout_summary, /\[REDACTED:bearer_token\]/)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop/)
})

test('launchctl print receipts omit inherited environment values', async () => {
  const context = fixtureContext()
  const marker = 'opaque-environment-credential-value'
  const launchd = adapter()
  launchd.status = async (current, runner) => {
    await runner([
      'launchctl',
      'print',
      `${current.domain}/${current.services[0].launchdLabel}`,
    ])
    return {
      ok: true,
      services: current.services.map((service, index) => ({
        key: service.key,
        name: service.name,
        definitionPath: service.definitionPath,
        loaded: true,
        enabled: true,
        running: true,
        pid: index + 11,
      })),
      linger: null,
      next_steps: [],
    }
  }
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    createServiceContext: () => context,
    launchd,
    runner: async () => ({
      code: 0,
      stdout: `state = running\ninherited environment = {\n  API_KEY_21ST => ${marker}\n}\npid = 11\n`,
      stderr: '',
    }),
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.commands[0].stdout_summary, '[launchctl print output omitted]')
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(marker))
})

test('service receipt caps ordinary command output summaries at 2000 characters', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    createServiceContext: () => context,
    launchd: adapter(),
    runner: async () => ({ code: 0, stdout: 'x'.repeat(2001), stderr: '' }),
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.commands[0].stdout_summary.length, 2000)
})

test('systemd status redacts secret stderr without projecting linger error metadata', async () => {
  const context = fixtureContext('systemd')
  const secret = 'mupot_abcdefghijklmnop'
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'systemd' }, {
    platformName: 'linux',
    context,
    runner: async (argv) => argv[0] === 'systemctl'
      ? { code: 0, stdout: 'loaded\nenabled\nactive\n123\n', stderr: '' }
      : { code: 1, stdout: '', stderr: `loginctl failed: ${secret}` },
  })

  assert.equal(receipt.status, 'fail')
  assert.deepEqual(receipt.linger, { enabled: null, raw: null })
  assert.deepEqual(Object.keys(receipt.linger), ['enabled', 'raw'])
  assert.match(receipt.commands.at(-1).stderr_summary, /\[REDACTED:mupot_token\]/)
  assert.equal(receipt.checks.some((check) => check.check === 'command_output_secret_free' && check.ok === false), true)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret))
})

test('systemd status redacts secret-looking unexpected linger stdout and nulls its raw projection', async () => {
  const context = fixtureContext('systemd')
  const secret = 'Bearer abcdefghijklmnop'
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'systemd' }, {
    platformName: 'linux',
    context,
    runner: async (argv) => argv[0] === 'systemctl'
      ? { code: 0, stdout: 'loaded\nenabled\nactive\n123\n', stderr: '' }
      : { code: 0, stdout: `${secret}\n`, stderr: '' },
  })

  assert.equal(receipt.status, 'fail')
  assert.deepEqual(receipt.linger, { enabled: null, raw: null })
  assert.deepEqual(Object.keys(receipt.linger), ['enabled', 'raw'])
  assert.match(receipt.commands.at(-1).stdout_summary, /\[REDACTED:bearer_token\]/)
  assert.equal(receipt.checks.some((check) => check.check === 'command_output_secret_free' && check.ok === false), true)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop/)
})

test('service receipt derives linger guidance without copying adapter error or next-step metadata', async () => {
  const context = fixtureContext('systemd')
  const secret = 'mupot_abcdefghijklmnop'
  const services = context.services.map((service, index) => ({
    key: service.key,
    name: service.name,
    definitionPath: service.definitionPath,
    loaded: true,
    enabled: true,
    running: true,
    pid: index + 10,
    error: secret,
  }))
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'systemd' }, {
    platformName: 'linux',
    context,
    systemd: adapter({
      status: {
        ok: true,
        services,
        linger: { enabled: false, raw: 'no', error: secret, next_steps: [secret] },
        next_steps: [secret],
      },
    }),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  })

  assert.equal(receipt.status, 'pass')
  assert.deepEqual(receipt.linger, { enabled: false, raw: 'no' })
  assert.deepEqual(receipt.next_steps, ['run loginctl enable-linger <username> with suitable host privileges, then rerun status'])
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret))
})

function assertFailedServiceReceipt(receipt, expectedRetry) {
  assert.equal(receipt.receipt_type, 'mupot-fleet-service-receipt/v1')
  assert.equal(receipt.status, 'fail')
  assert.equal(typeof receipt.generated_at, 'string')
  assert.deepEqual(receipt.preserved_data, { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true })
  assert.equal(receipt.next_steps.at(-1), expectedRetry)
}

test('service receipt contains a redacted failure envelope when definition rendering throws', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'install', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    context,
    launchd: { ...adapter(), render: () => { throw new Error('render failed: Bearer abcdefghijklmnop') } },
  })

  assertFailedServiceReceipt(receipt, `${shellQuote(context.nodePath)} ${shellQuote(join(context.runtimeDir, 'service-manager.mjs'))} ${shellQuote('install')} --service-manager ${shellQuote('launchd')} --prefix ${shellQuote(context.prefix)} --launchd-dir ${shellQuote(context.definitionDir)} --node ${shellQuote(context.nodePath)}`)
  assert.deepEqual(receipt.definitions, [])
  assert.deepEqual(receipt.services, [])
  assert.equal(receipt.linger, null)
  assert.deepEqual(receipt.commands, [])
  assert.equal(receipt.checks.some((check) => check.check === 'service_operation_failed' && check.ok === false && /\[REDACTED:bearer_token\]/.test(check.reason)), true)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop/)
})

test('service receipt contains a redacted failure envelope when a lifecycle operation throws', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'install', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    context,
    launchd: { ...adapter(), install: async () => { throw new Error('install failed: mupot_abcdefghijklmnop') } },
  })

  assertFailedServiceReceipt(receipt, `${shellQuote(context.nodePath)} ${shellQuote(join(context.runtimeDir, 'service-manager.mjs'))} ${shellQuote('install')} --service-manager ${shellQuote('launchd')} --prefix ${shellQuote(context.prefix)} --launchd-dir ${shellQuote(context.definitionDir)} --node ${shellQuote(context.nodePath)}`)
  assert.equal(receipt.checks.some((check) => check.check === 'service_operation_failed' && check.ok === false && /\[REDACTED:mupot_token\]/.test(check.reason)), true)
  assert.doesNotMatch(JSON.stringify(receipt), /abcdefghijklmnop/)
})

test('service receipt contains a failure envelope when status throws', async () => {
  const context = fixtureContext()
  const receipt = await buildServiceReceipt({ action: 'status', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    context,
    launchd: { ...adapter(), status: async () => { throw new Error('launchctl status unavailable') } },
  })

  assertFailedServiceReceipt(receipt, `${shellQuote(context.nodePath)} ${shellQuote(join(context.runtimeDir, 'service-manager.mjs'))} ${shellQuote('status')} --service-manager ${shellQuote('launchd')} --prefix ${shellQuote(context.prefix)} --launchd-dir ${shellQuote(context.definitionDir)} --node ${shellQuote(context.nodePath)}`)
  assert.equal(receipt.checks.some((check) => check.check === 'service_operation_failed' && check.ok === false && check.reason === 'launchctl status unavailable'), true)
})

test('direct lifecycle calls infer explicit manager-specific options', async () => {
  const root = tmpDir()
  const launchd = fixtureContext('launchd')
  const systemd = fixtureContext('systemd')

  const mac = await buildServiceReceipt({ action: 'status', serviceManager: 'auto', launchdDir: join(root, 'LaunchAgents'), dryRun: true }, {
    platformName: 'darwin', context: launchd,
  })
  const linux = await buildServiceReceipt({ action: 'status', serviceManager: 'auto', systemdDir: join(root, 'systemd'), enableLinger: true, dryRun: true }, {
    platformName: 'linux', context: systemd,
  })

  assert.equal(mac.status, 'pass')
  assert.equal(linux.status, 'pass')
  await assert.rejects(
    buildServiceReceipt({ action: 'status', serviceManager: 'auto', launchdDir: join(root, 'LaunchAgents'), dryRun: true }, { platformName: 'linux' }),
    /launchd-dir requires launchd/,
  )
  await assert.rejects(
    buildServiceReceipt({ action: 'status', serviceManager: 'auto', systemdDir: join(root, 'systemd'), dryRun: true }, { platformName: 'darwin' }),
    /systemd-dir requires systemd/,
  )
  await assert.rejects(
    buildServiceReceipt({ action: 'status', serviceManager: 'auto', enableLinger: true, dryRun: true }, { platformName: 'darwin' }),
    /enable-linger requires systemd/,
  )
  await assert.rejects(
    buildServiceReceipt({ action: 'status', serviceManager: 'launchd', skipSystemd: true, dryRun: true }, { platformName: 'darwin' }),
    /conflicts/,
  )
})

test('direct lifecycle calls reject invalid actions and relative Node paths as argument errors', async () => {
  await assert.rejects(
    buildServiceReceipt({ serviceManager: 'launchd' }, { platformName: 'darwin' }),
    /required action/,
  )
  await assert.rejects(
    buildServiceReceipt({ action: 'start', serviceManager: 'launchd' }, { platformName: 'darwin' }),
    /unsupported action/,
  )
  await assert.rejects(
    buildServiceReceipt({ action: 'status', serviceManager: 'launchd', nodePath: './node' }, { platformName: 'darwin' }),
    /--node requires an absolute path/,
  )
  assert.throws(() => parseServiceArgs(['status', '--node', './node']), /--node requires an absolute path/)
})

test('direct lifecycle calls reject secret-looking configured paths before receipt construction', async () => {
  const marker = 'mupot_abcdefghijklmnop'
  const cases = [
    { field: 'prefix', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'launchdDir', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'systemdDir', serviceManager: 'systemd', platformName: 'linux' },
    { field: 'nodePath', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'runtimeDir', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'logsDir', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'stateDir', serviceManager: 'launchd', platformName: 'darwin' },
    { field: 'homeDir', serviceManager: 'launchd', platformName: 'darwin' },
  ]

  for (const { field, serviceManager, platformName } of cases) {
    await assert.rejects(
      buildServiceReceipt({
        action: 'status',
        serviceManager,
        dryRun: true,
        [field]: `/tmp/${marker}`,
      }, { platformName }),
      (error) => error.message === 'configured path contains a prohibited secret-like value' && !error.message.includes(marker),
      field,
    )
  }
  assert.throws(
    () => parseServiceArgs(['status', '--prefix', `/tmp/${marker}`], 'darwin'),
    (error) => error.message === 'configured path contains a prohibited secret-like value' && !error.message.includes(marker),
  )
})

test('service receipt recursively redacts adapter-injected definition, service, and command fields', async () => {
  const context = fixtureContext('launchd')
  const marker = 'mupot_abcdefghijklmnop'
  const ordinaryLongArg = 'x'.repeat(2500)
  const services = context.services.map((service, index) => ({
    key: service.key,
    name: index === 0 ? `service-${marker}` : service.name,
    loaded: true,
    enabled: true,
    running: true,
    pid: index + 20,
  }))
  const taintedAdapter = {
    ...adapter(),
    render: (current) => current.services.map((service, index) => ({
      key: service.key,
      path: index === 0 ? `/tmp/${marker}/definition` : service.definitionPath,
      content: `definition:${service.key}`,
    })),
    install: async (_current, runner) => {
      await runner([`manager-${marker}`, `--value=${marker}`, ordinaryLongArg])
      return { ok: true }
    },
    status: async () => ({ ok: true, services, linger: null, next_steps: [] }),
  }

  const receipt = await buildServiceReceipt({ action: 'install', serviceManager: 'launchd' }, {
    platformName: 'darwin',
    context,
    launchd: taintedAdapter,
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  })

  assert.equal(receipt.status, 'fail')
  assert.match(receipt.definitions[0].path, /\[REDACTED:mupot_token\]/)
  assert.match(receipt.services[0].name, /\[REDACTED:mupot_token\]/)
  assert.match(receipt.commands[0].executable, /\[REDACTED:mupot_token\]/)
  assert.match(receipt.commands[0].argv[0], /\[REDACTED:mupot_token\]/)
  assert.equal(receipt.commands[0].argv[1], ordinaryLongArg)
  assert.equal(receipt.checks.some((check) => check.check === 'command_output_secret_free' && check.ok === false), true)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(marker))
})

test('failed service receipt recursively sanitizes fallback evidence without truncating ordinary strings', () => {
  const marker = 'mupot_abcdefghijklmnop'
  const ordinaryLongStep = 'x'.repeat(2500)
  const receipt = buildFailedServiceReceipt({
    platformName: 'linux',
    serviceManager: 'systemd',
    action: 'install',
    definitions: [{ service: 'heartbeat', path: `/tmp/${marker}`, sha256: 'a'.repeat(64) }],
    services: [{ key: 'heartbeat', name: `service-${marker}`, loaded: false, enabled: false, running: false, pid: null }],
    commands: [{ executable: `manager-${marker}`, argv: [marker], code: 1, stdout_summary: '', stderr_summary: '' }],
    nextSteps: [`retry ${marker}`, ordinaryLongStep],
    checks: [{ ok: false, check: 'adapter_evidence', reason: marker }],
    error: new Error('safe failure'),
  })

  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.next_steps[1], ordinaryLongStep)
  assert.equal(receipt.checks.some((check) => check.check === 'command_output_secret_free' && check.ok === false), true)
  assert.match(JSON.stringify(receipt), /\[REDACTED:mupot_token\]/)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(marker))
})

test('failed service receipt shell-quotes every retry command value', async () => {
  const root = tmpDir()
  const prefix = join(root, "fleet owner's host")
  const definitionDir = join(root, "systemd user's units")
  const nodePath = "/opt/Mupot Node's/bin/node"
  const context = createServiceContext({
    manager: 'systemd',
    platformName: 'linux',
    homeDir: root,
    prefix,
    definitionDir,
    nodePath,
    uid: 1001,
    username: 'fleet',
  })
  const stopped = context.services.map((service) => ({
    key: service.key,
    name: service.name,
    definitionPath: service.definitionPath,
    loaded: true,
    enabled: true,
    running: false,
    pid: null,
  }))

  const receipt = await buildServiceReceipt({ action: 'install', serviceManager: 'systemd', enableLinger: true }, {
    platformName: 'linux',
    context,
    systemd: adapter({ status: { ok: true, services: stopped, linger: { enabled: true, raw: 'yes' }, next_steps: [] } }),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  })

  const expected = `${shellQuote(nodePath)} ${shellQuote(join(context.runtimeDir, 'service-manager.mjs'))} ${shellQuote('install')} --service-manager ${shellQuote('systemd')} --prefix ${shellQuote(prefix)} --systemd-dir ${shellQuote(definitionDir)} --node ${shellQuote(nodePath)} --enable-linger`
  assert.equal(receipt.status, 'fail')
  assert.deepEqual(Object.keys(receipt.services[0]), ['key', 'name', 'loaded', 'enabled', 'running', 'pid'])
  assert.equal(receipt.next_steps.at(-1), expected)
})

test('uninstall receipt verifies definitions are absent and preserved runtime data remains', async () => {
  const context = fixtureContext('systemd')
  for (const path of [context.runtimeDir, join(context.prefix, 'agents'), join(context.prefix, 'handlers'), join(context.prefix, 'inbox'), context.logsDir, context.stateDir, join(context.prefix, 'receipts')]) mkdirSync(path, { recursive: true })
  const receipt = await buildServiceReceipt({ action: 'uninstall', serviceManager: 'systemd' }, {
    platformName: 'linux',
    createServiceContext: () => context,
    systemd: adapter({
      status: {
        ok: true,
        services: context.services.map((service) => ({
          key: service.key,
          name: service.name,
          definitionPath: service.definitionPath,
          loaded: false,
          enabled: false,
          running: false,
          pid: null,
        })),
        linger: { enabled: true, raw: 'yes' },
        next_steps: [],
      },
    }),
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.services.every((service) => service.loaded === false), true)
  assert.equal(receipt.checks.some((check) => check.check === 'definitions_absent' && check.ok), true)
  assert.equal(existsSync(context.runtimeDir), true)
})

test('systemd uninstall receipt passes with the actual adapter when removed units are absent', async () => {
  const context = fixtureContext('systemd')
  for (const path of [context.runtimeDir, join(context.prefix, 'agents'), join(context.prefix, 'handlers'), join(context.prefix, 'inbox'), context.logsDir, context.stateDir, join(context.prefix, 'receipts')]) mkdirSync(path, { recursive: true })
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    if (argv[0] === 'systemctl' && argv[2] === 'show') {
      return { code: 4, stdout: '', stderr: `Unit ${argv[3]} could not be found.` }
    }
    if (argv[0] === 'loginctl' && argv[1] === 'show-user') return { code: 0, stdout: 'yes\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  const receipt = await buildServiceReceipt({ action: 'uninstall', serviceManager: 'systemd' }, {
    platformName: 'linux',
    context,
    runner,
  })

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.services.every((service) => service.loaded === false && service.running === false && service.pid === null), true)
  assert.deepEqual(calls.filter((call) => call[0] === 'systemctl' && call[2] === 'disable').map((call) => call[4]), [
    'fleet-daemon.service',
    'fleet-control-daemon.service',
  ])
})
