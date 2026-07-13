// node --test host-receipt.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildReceipt, hasPlaceholder, parseArgs, summarize } from './host-receipt.mjs'
import { createServiceContext } from './service-context.mjs'
import { renderLaunchd } from './launchd-service-manager.mjs'
import { renderSystemd } from './systemd-service-manager.mjs'

const PANEL_PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'bqjg1QCM1_F1Oe4xxjDidrEkNzkgwbAUk65dJUYFaLI',
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'mupot-host-receipt-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function touch(path, mode = 0o600) {
  writeFileSync(path, '{}\n', { mode })
  chmodSync(path, mode)
}

function fixture(overrides = {}) {
  const root = tmp()
  const keys = join(root, 'keys')
  mkdirSync(keys)
  const daemonPath = join(root, 'daemon.json')
  const inboxPath = join(root, 'inbox.json')
  const controlPath = join(root, 'control.json')
  const panelPublicKey = join(root, 'panel.pub.jwk')
  const flightsConfig = join(root, 'flights.json')
  const flightScript = join(root, 'flight.mjs')

  const daemon = {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    interval_sec: 75,
    agents: [
      {
        agent_id: 'agent-one',
        type: 'builder',
        runtime: 'codex',
        probe: 'true',
        inbox: { command: 'node ~/.fleet/runtime/inbox-handler.mjs ~/.fleet/inbox-handler.json', limit: 20 },
      },
    ],
  }
  const inbox = {
    spool_dir: join(root, 'spool'),
    agents: [
      { agent_id: 'agent-one', command: 'true', run_for: ['request'] },
    ],
  }
  const control = {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    consumer_agent_id: 'fleet-consumer',
    panel_public_key: panelPublicKey,
    flights_config: flightsConfig,
    flight_script: flightScript,
  }

  writeJson(daemonPath, overrides.daemon ?? daemon)
  writeJson(inboxPath, overrides.inbox ?? inbox)
  writeJson(controlPath, overrides.control ?? control)
  touch(join(keys, 'agent-one.key'))
  touch(join(keys, 'fleet-consumer.key'))
  writeJson(panelPublicKey, overrides.panelPublicKey ?? PANEL_PUBLIC_JWK)
  touch(flightsConfig)
  touch(flightScript, 0o755)

  return {
    root,
    daemonPath,
    inboxPath,
    controlPath,
    keyPathFor: (agentId) => join(keys, `${agentId}.key`),
  }
}

function serviceFixture(overrides = {}) {
  const f = fixture()
  const manager = overrides.manager ?? 'systemd'
  const platformName = manager === 'launchd' ? 'darwin' : 'linux'
  const runtimeDir = join(f.root, 'runtime')
  const definitionDir = join(f.root, manager)
  mkdirSync(runtimeDir)
  mkdirSync(definitionDir)
  const nodePath = '/usr/local/bin/node'
  const context = createServiceContext({
    manager,
    platformName,
    homeDir: f.root,
    prefix: f.root,
    runtimeDir,
    definitionDir,
    nodePath,
    uid: 501,
    username: 'operator',
  })
  const rendered = manager === 'launchd' ? renderLaunchd(context) : renderSystemd(context)
  for (const definition of rendered) writeFileSync(definition.path, definition.content)
  const receipt = {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: '2026-07-13T20:00:00.000Z',
    status: 'pass',
    platform: platformName,
    service_manager: manager,
    action: 'status',
    definitions: rendered.map((definition) => ({
      service: definition.key,
      path: definition.path,
      sha256: createHash('sha256').update(definition.content).digest('hex'),
    })),
    services: context.services.map((service) => ({
      key: service.key,
      name: service.name,
      loaded: true,
      enabled: true,
      running: true,
      pid: service.key === 'heartbeat' ? 101 : 102,
    })),
    linger: manager === 'systemd' ? { enabled: true, raw: 'yes' } : null,
    commands: manager === 'systemd'
      ? [
          ...context.services.map((service) => ({ executable: 'systemctl', argv: ['--user', 'show', service.systemdUnit, '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value'], code: 0, stdout_summary: '', stderr_summary: '' })),
          { executable: 'loginctl', argv: ['show-user', 'operator', '-p', 'Linger', '--value'], code: 0, stdout_summary: 'yes', stderr_summary: '' },
        ]
      : context.services.map((service) => ({ executable: 'launchctl', argv: ['print', `${context.domain}/${service.launchdLabel}`], code: 0, stdout_summary: '', stderr_summary: '' })),
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: [],
    checks: [
      { ok: true, check: 'services_loaded_and_running' },
      { ok: true, check: 'command_output_secret_free' },
    ],
  }
  if (overrides.mutateReceipt) overrides.mutateReceipt(receipt)
  if (overrides.mutateDefinitions) overrides.mutateDefinitions({ context, receipt, rendered })
  return {
    ...f,
    runtimeDir,
    definitionDir,
    nodePath,
    context,
    receipt,
  }
}

async function requiredServiceReceipt(f) {
  const manager = f.context.manager
  const platformName = manager === 'launchd' ? 'darwin' : 'linux'
  return buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
    requireServices: true,
    serviceManager: manager,
    serviceDefinitionDir: f.definitionDir,
    runtimeDir: f.runtimeDir,
    nodePath: f.nodePath,
    homeDir: f.root,
    uid: 501,
    username: 'operator',
    platformName,
    buildServiceReceipt: async (opts) => {
      assert.equal(opts.action, 'status')
      assert.equal(opts.serviceManager, manager)
      return f.receipt
    },
  })
}

test('host receipt passes for a complete local host layout without executing probes', async () => {
  const f = fixture()
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.receipt_type, 'mupot-fleet-host-receipt/v1')
  assert.equal(receipt.status, 'pass', JSON.stringify(receipt.checks.filter((check) => check.component === 'host-services'), null, 2))
  assert.equal(receipt.summary.failed, 0)
  assert.deepEqual(receipt.target, {
    base_url: 'https://pot.example.org',
    tenant: 'tenant-a',
    daemon_agents: ['agent-one'],
    control_consumer_agent: 'fleet-consumer',
  })
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'agent_private_key_present_0600' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'inbox-handler' && c.check === 'daemon_inbox_agent_has_handler_config' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'consumer_private_key_present_0600' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-control-daemon' && c.check === 'panel_public_key_public_only' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'host-receipt' && c.check === 'daemon_control_base_url_match' && c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'host-receipt' && c.check === 'daemon_control_tenant_match' && c.ok))
  assert.equal(receipt.checks.some((c) => c.check === 'service_definitions_current'), false)
  assert.deepEqual(receipt.inputs, {
    daemon_config: f.daemonPath,
    inbox_handler_config: f.inboxPath,
    control_config: f.controlPath,
    exec_probes: false,
  })
})

test('host service proof accepts exact current launchd definitions and status', async () => {
  const f = serviceFixture({ manager: 'launchd' })
  const receipt = await requiredServiceReceipt(f)

  assert.equal(receipt.status, 'pass', JSON.stringify(receipt.checks.filter((check) => check.component === 'host-services'), null, 2))
  assert.deepEqual(
    receipt.checks.filter((check) => check.component === 'host-services').map((check) => check.check),
    ['service_definitions_current', 'heartbeat_service_running', 'control_service_running', 'systemd_linger_enabled'],
  )
})

test('host service proof rejects semantic renderer drift even when argv and receipt hashes match disk', async () => {
  const f = serviceFixture({
    mutateDefinitions({ receipt, rendered }) {
      const changed = rendered[0].content.replace('Restart=on-failure', 'Restart=always')
      writeFileSync(rendered[0].path, changed)
      receipt.definitions[0].sha256 = createHash('sha256').update(changed).digest('hex')
    },
  })

  const receipt = await requiredServiceReceipt(f)
  assert.equal(receipt.status, 'fail')
  assert.equal(receipt.checks.find((check) => check.check === 'service_definitions_current').ok, false)
})

test('host service proof rejects malformed, fabricated, duplicate, extra, and secret-bearing envelopes', async (t) => {
  const cases = [
    ['wrong manager/platform', (receipt) => { receipt.service_manager = 'launchd'; receipt.platform = 'darwin' }],
    ['duplicate service', (receipt) => { receipt.services[1] = { ...receipt.services[0] } }],
    ['extra service', (receipt) => { receipt.services.push({ key: 'other', name: 'other.service', loaded: true, enabled: true, running: true, pid: 103 }) }],
    ['non-positive pid', (receipt) => { receipt.services[0].pid = 0 }],
    ['unknown field', (receipt) => { receipt.fabricated = true }],
    ['secret field', (receipt) => { receipt.authorization = 'Bearer abcdefghijklmnopqrstuvwxyz' }],
    ['fabricated producer check', (receipt) => { receipt.checks.push({ ok: true, check: 'fabricated' }) }],
    ['extra command record', (receipt) => { receipt.commands.push({ executable: 'true', argv: [], code: 0, stdout_summary: '', stderr_summary: '' }) }],
  ]
  for (const [name, mutateReceipt] of cases) {
    await t.test(name, async () => {
      const f = serviceFixture({ mutateReceipt })
      const receipt = await requiredServiceReceipt(f)
      assert.equal(receipt.status, 'fail')
      assert.equal(receipt.checks.filter((check) => check.component === 'host-services').every((check) => check.ok === false), true)
    })
  }
})

test('host receipt requires current running services and enabled systemd linger', async () => {
  const receipt = await requiredServiceReceipt(serviceFixture())

  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.inputs.service_manager, 'systemd')
  assert.ok(receipt.inputs.service_definition_dir.endsWith('/systemd'))
  assert.deepEqual(
    receipt.checks.filter((check) => check.component === 'host-services').map((check) => check.check),
    ['service_definitions_current', 'heartbeat_service_running', 'control_service_running', 'systemd_linger_enabled'],
  )
  assert.equal(receipt.checks.filter((check) => check.component === 'host-services').every((check) => check.ok === true), true)
})

test('host receipt fails closed for missing, stale, or misconfigured service definitions', async (t) => {
  const cases = [
    {
      name: 'missing definition',
      mutateDefinitions: ({ rendered }) => rmSync(rendered[0].path),
    },
    {
      name: 'definition hash mismatch',
      mutateDefinitions: ({ rendered }) => writeFileSync(rendered[0].path, `${rendered[0].content}\n# drift\n`),
    },
    {
      name: 'wrong node execution argument',
      mutateDefinitions: ({ receipt, rendered }) => {
        const content = rendered[0].content.replace('/usr/local/bin/node', '/wrong/node')
        writeFileSync(rendered[0].path, content)
        receipt.definitions[0].sha256 = createHash('sha256').update(content).digest('hex')
      },
    },
    {
      name: 'wrong runtime execution argument',
      mutateDefinitions: ({ receipt, rendered }) => {
        const content = rendered[0].content.replace('/runtime/fleet-daemon.mjs', '/other/fleet-daemon.mjs')
        writeFileSync(rendered[0].path, content)
        receipt.definitions[0].sha256 = createHash('sha256').update(content).digest('hex')
      },
    },
    {
      name: 'wrong config execution argument',
      mutateDefinitions: ({ receipt, rendered }) => {
        const content = rendered[1].content.replace('/control.json', '/wrong-control.json')
        writeFileSync(rendered[1].path, content)
        receipt.definitions[1].sha256 = createHash('sha256').update(content).digest('hex')
      },
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const receipt = await requiredServiceReceipt(serviceFixture(entry))
      assert.equal(receipt.status, 'fail')
      assert.ok(receipt.checks.some((check) => check.check === 'service_definitions_current' && check.ok === false))
    })
  }
})

test('host receipt fails required mode for unloaded or stopped services and disabled linger', async (t) => {
  const cases = [
    {
      name: 'unloaded heartbeat',
      check: 'heartbeat_service_running',
      mutateReceipt: (receipt) => { receipt.services[0].loaded = false },
    },
    {
      name: 'stopped control',
      check: 'control_service_running',
      mutateReceipt: (receipt) => { receipt.services[1].running = false },
    },
    {
      name: 'disabled systemd linger',
      check: 'systemd_linger_enabled',
      mutateReceipt: (receipt) => { receipt.linger = { enabled: false, raw: 'no' } },
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const receipt = await requiredServiceReceipt(serviceFixture(entry))
      assert.equal(receipt.status, 'fail')
      assert.ok(receipt.checks.some((check) => check.check === entry.check && check.ok === false))
    })
  }
})

test('host receipt parses and documents service requirement options', () => {
  const opts = parseArgs([
    '--require-services',
    '--service-manager', 'launchd',
    '--service-definition-dir', './LaunchAgents',
  ])
  const help = execFileSync(process.execPath, [fileURLToPath(new URL('./host-receipt.mjs', import.meta.url)), '--help'], { encoding: 'utf8' })

  assert.equal(opts.requireServices, true)
  assert.equal(opts.serviceManager, 'launchd')
  assert.ok(opts.serviceDefinitionDir.endsWith('/LaunchAgents'))
  assert.match(help, /--require-services/)
  assert.match(help, /--service-manager <auto\|systemd\|launchd>/)
  assert.match(help, /--service-definition-dir <path>/)
  assert.throws(() => parseArgs(['--service-manager', 'none']), /auto\|systemd\|launchd/)
  assert.throws(() => parseArgs(['--service-manager']), /requires a value/)
  assert.throws(() => parseArgs(['--service-manager', '']), /requires a value/)
  assert.throws(() => parseArgs(['--service-definition-dir', '--skip-control']), /requires a value/)
  assert.throws(() => parseArgs(['--service-manager', 'systemd']), /require --require-services/)
  assert.throws(() => parseArgs(['--service-definition-dir', './systemd']), /require --require-services/)
  assert.throws(() => parseArgs(['--require-services', '--skip-control']), /conflicts with --skip-control/)
})

test('host receipt fails when daemon inbox agents have no handler config', async () => {
  const f = fixture({ inbox: { spool_dir: join(tmp(), 'spool'), agents: [{ agent_id: 'other-agent' }] } })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'inbox-handler' &&
    c.check === 'daemon_inbox_agent_has_handler_config' &&
    c.agent_id === 'agent-one' &&
    c.ok === false
  ))
})

test('host receipt fails placeholder base_url and tenant values', async () => {
  const f = fixture({
    daemon: {
      base_url: 'https://YOUR-POT.example.com',
      tenant: 'YOUR_TENANT_SLUG',
      agents: [{ agent_id: 'agent-one', probe: 'true' }],
    },
  })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: true,
    skipControl: true,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'base_url_real' && !c.ok))
  assert.ok(receipt.checks.some((c) => c.component === 'fleet-daemon' && c.check === 'tenant_real' && !c.ok))
})

test('host receipt fails when daemon and control config target different pots', async () => {
  const f = fixture({
    control: {
      base_url: 'https://staging-pot.example.org',
      tenant: 'tenant-b',
      consumer_agent_id: 'fleet-consumer',
      panel_public_key: join(tmp(), 'panel.pub.jwk'),
      flights_config: join(tmp(), 'flights.json'),
      flight_script: join(tmp(), 'flight.mjs'),
    },
  })
  const control = JSON.parse(readFileSync(f.controlPath, 'utf8'))
  touch(control.panel_public_key)
  touch(control.flights_config)
  touch(control.flight_script, 0o755)

  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'host-receipt' &&
    c.check === 'daemon_control_base_url_match' &&
    c.ok === false &&
    c.daemon_base_url === 'https://pot.example.org' &&
    c.control_base_url === 'https://staging-pot.example.org'
  ))
  assert.ok(receipt.checks.some((c) =>
    c.component === 'host-receipt' &&
    c.check === 'daemon_control_tenant_match' &&
    c.ok === false &&
    c.daemon_tenant === 'tenant-a' &&
    c.control_tenant === 'tenant-b'
  ))
})

test('host receipt fails when panel public key contains private JWK material', async () => {
  const f = fixture({ panelPublicKey: { ...PANEL_PUBLIC_JWK, d: 'private-scalar' } })
  const receipt = await buildReceipt({
    daemonPath: f.daemonPath,
    inboxPath: f.inboxPath,
    controlPath: f.controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: false,
    keyPathFor: f.keyPathFor,
  })

  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.checks.some((c) =>
    c.component === 'fleet-control-daemon' &&
    c.check === 'panel_public_key_public_only' &&
    c.ok === false &&
    /PUBLIC Ed25519 OKP JWK/.test(c.reason)
  ))
})

test('summary and placeholder helpers keep receipt status deterministic', () => {
  assert.equal(hasPlaceholder('https://YOUR-POT.example.com'), true)
  assert.equal(hasPlaceholder('https://sub.example.com/runtime'), true)
  assert.equal(hasPlaceholder('https://pot.example.org'), false)
  assert.equal(hasPlaceholder('https://example.com.evil.invalid'), false)
  assert.equal(hasPlaceholder('https://notexample.com/runtime'), false)
  assert.deepEqual(summarize([{ ok: true }, { ok: null }]), { status: 'warn', passed: 1, failed: 0, warnings: 1 })
  assert.deepEqual(summarize([{ ok: true }, { ok: false }]), { status: 'fail', passed: 1, failed: 1, warnings: 0 })
})
