// node --test receipt-bundle.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildBundle, checkBundleManifest, exportBundle, formatHostGoPlan, formatStatusSummary, inspectBundleStatus, parseArgs, safeName } from './receipt-bundle.mjs'
import { buildReceipt as buildHostReceipt } from './host-receipt.mjs'
import { createServiceContext } from './service-context.mjs'
import { renderLaunchd } from './launchd-service-manager.mjs'
import { renderSystemd } from './systemd-service-manager.mjs'
import { STARTER_ARTIFACT_ROLES, STARTER_CHECKS } from './starter-contract.mjs'
import { verifyStarterBundle } from './starter-manifest.mjs'

const POT_URL = 'https://pot.example.org'
const POT_TENANT = 'tenant-a'
const HEARTBEAT_DEFINITION = '[Service]\nExecStart=heartbeat\n'
const CONTROL_DEFINITION = '[Service]\nExecStart=control\n'
const STARTER_MANIFEST_VALUE = {
  version: 1,
  tenant: POT_TENANT,
  base_url: POT_URL,
  service_manager: 'auto',
  agents: [
    { agent_id: 'agent-one', runtime: 'codex', probe: 'pgrep -f codex', handler: 'node ~/.fleet/handlers/codex.mjs' },
    { agent_id: 'fleet-consumer', runtime: 'hermes', probe: 'pgrep -f hermes', handler: 'node ~/.fleet/handlers/hermes.mjs' },
  ],
  control_consumer_agent_id: 'fleet-consumer',
}
const STARTER_MANIFEST = `${JSON.stringify(STARTER_MANIFEST_VALUE, null, 2)}\n`
const digest = (value) => createHash('sha256').update(value).digest('hex')
const HEARTBEAT_SHA = digest(HEARTBEAT_DEFINITION)
const CONTROL_SHA = digest(CONTROL_DEFINITION)
const STARTER_SHA = digest(STARTER_MANIFEST)
const NEXT_STEP_ATTACH = 'attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)'
const NEXT_STEP_HOLD = 'do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass'
const HOST_PANEL_PUBLIC_KEY_CHECK = {
  ok: true,
  component: 'fleet-control-daemon',
  check: 'panel_public_key_public_only',
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-receipt-bundle-'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return path
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function summarizeFixture(checks) {
  const failed = checks.filter((check) => check.ok === false).length
  const warnings = checks.filter((check) => check.ok === null).length
  return {
    status: failed > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
    passed: checks.length - failed - warnings,
    failed,
    warnings,
  }
}

function checklistById(status, id) {
  return status.host_go_checklist.find((item) => item.id === id)
}

function installReceipt(status = 'warn') {
  const checks = status === 'pass'
    ? [
        { ok: true, component: 'fleet-install', check: 'source_dir_present', path: '/checkout/fleet-runtime' },
        ...['fleet_home', 'runtime', 'agents', 'handlers', 'inbox', 'logs', 'state', 'receipts', 'systemd_definition'].map((label) => ({
          ok: true,
          component: 'fleet-install',
          check: `${label}_dir_ready`,
          path: label === 'systemd_definition' ? '/home/operator/.config/systemd/user' : `/home/operator/.fleet/${label === 'fleet_home' ? '' : label}`,
          mode: '700',
          existed: true,
          dry_run: false,
        })),
        { ok: true, component: 'fleet-install', check: 'runtime_files_discovered', count: 1 },
        { ok: true, component: 'fleet-install', check: 'runtime_file_copied', source: '/checkout/fleet-runtime/host-receipt.mjs', path: '/home/operator/.fleet/runtime/host-receipt.mjs', mode: '644', dry_run: false },
        ...['daemon.json', 'inbox-handler.json', 'control.json', 'flights.json'].map((name) => ({
          ok: true,
          component: 'fleet-install',
          check: 'config_preserved',
          source: `/checkout/fleet-runtime/${name}`,
          path: `/home/operator/.fleet/${name}`,
        })),
        { ok: true, component: 'fleet-install', check: 'service_definition_rendered', service: 'heartbeat', path: '/home/operator/.config/systemd/user/fleet-daemon.service', sha256: HEARTBEAT_SHA, mode: '644', dry_run: false },
        { ok: true, component: 'fleet-install', check: 'service_definition_rendered', service: 'control', path: '/home/operator/.config/systemd/user/fleet-control-daemon.service', sha256: CONTROL_SHA, mode: '644', dry_run: false },
      ]
    : [
        { ok: null, component: 'fleet-install', check: 'config_needs_edit', path: '/home/operator/.fleet/daemon.json', reason: 'template_contains_placeholders' },
      ]
  return {
    receipt_type: 'mupot-fleet-install-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status,
    summary: summarizeFixture(checks),
    inputs: {
      source_dir: '/checkout/fleet-runtime', prefix: '/home/operator/.fleet', systemd_dir: '/home/operator/.config/systemd/user',
      skip_systemd: false, force_config: false, dry_run: false, node_path: '/usr/bin/node',
      service_manager: { requested: 'systemd', resolved: 'systemd' }, service_definition_dir: '/home/operator/.config/systemd/user',
      activation_requested: false, activation_performed: false, enable_linger: false,
    },
    outputs: {
      runtime_dir: '/home/operator/.fleet/runtime', agents_dir: '/home/operator/.fleet/agents', handlers_dir: '/home/operator/.fleet/handlers',
      inbox_dir: '/home/operator/.fleet/inbox', logs_dir: '/home/operator/.fleet/logs', state_dir: '/home/operator/.fleet/state',
      receipts_dir: '/home/operator/.fleet/receipts', runtime_files: ['/home/operator/.fleet/runtime/host-receipt.mjs'],
      service_definitions: [
        { service: 'heartbeat', path: '/home/operator/.config/systemd/user/fleet-daemon.service', sha256: HEARTBEAT_SHA },
        { service: 'control', path: '/home/operator/.config/systemd/user/fleet-control-daemon.service', sha256: CONTROL_SHA },
      ],
    },
    activation: null,
    next_steps: ['edit the installed sterile configuration before activation'],
    checks,
  }
}

function probeReceipt(status = 'pass') {
  const ok = status === 'pass'
  const checks = [
    { ok: true, component: 'cutover-probe', check: 'base_url_valid' },
    { ok: true, component: 'cutover-probe', check: 'target_agent_present', agent: 'agent-one' },
    { ok: true, component: 'cutover-probe', check: 'probe_action_selected' },
    { ok: true, component: 'cutover-probe', check: 'agent_token_present', env: 'MUPOT_AGENT_TOKEN' },
    { ok, component: 'cutover-probe', check: 'inbox_probe_queued', status: ok ? 202 : 500, response_ok: ok, error: ok ? undefined : 'failed', detail: undefined },
    { ok: true, component: 'cutover-probe', check: 'owner_token_present', env: 'MUPOT_OWNER_TOKEN' },
    { ok, component: 'cutover-probe', check: 'control_request_queued', agent_id: 'agent-one', verb: 'start', status: ok ? 202 : 500, response_ok: ok, error: ok ? undefined : 'failed', detail: undefined },
  ]
  return {
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-08T00:00:30.000Z',
    status,
    summary: { status, passed: checks.filter((check) => check.ok === true).length, failed: checks.filter((check) => check.ok === false).length, warnings: 0 },
    inputs: {
      base_url: POT_URL,
      agent: 'agent-one',
      queue_inbox: true,
      control_verbs: ['start'],
      inbox_kind: 'request',
      agent_token_env: 'MUPOT_AGENT_TOKEN',
      owner_token_env: 'MUPOT_OWNER_TOKEN',
    },
    actions: [
      { kind: 'inbox_probe', target_agent: 'agent-one', request_id: 'probe-1-inbox', status: ok ? 202 : 500, ok, response: { ok } },
      { kind: 'control_request', target_agent: 'agent-one', verb: 'start', status: ok ? 202 : 500, ok, nonce: ok ? 'nonce-1' : null, response: { ok } },
    ],
    checks,
  }
}

function hostReceipt(status = 'pass', opts = {}) {
  const checks = opts.checks ?? [
    { ...HOST_PANEL_PUBLIC_KEY_CHECK, ok: status === 'pass' },
  ]
  return {
    receipt_type: 'mupot-fleet-host-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status,
    summary: {
      status,
      passed: checks.filter((check) => check.ok === true).length,
      failed: checks.filter((check) => check.ok === false).length,
      warnings: checks.filter((check) => check.ok === null).length,
    },
    inputs: {
      daemon_config: '/config/daemon.json',
      inbox_handler_config: '/config/inbox.json',
      control_config: '/config/control.json',
      exec_probes: false,
    },
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      daemon_agents: ['agent-one'],
      control_consumer_agent: 'fleet-consumer',
    },
    checks,
  }
}

function runtimeReceipt(agentId, status = 'pass') {
  const checks = [
    { ok: true, component: 'runtime-receipt', check: 'daemon_config_valid', path: '/config/daemon.json' },
    { ok: true, component: 'runtime-receipt', check: 'agent_configured', agent_id: agentId },
    { ok: true, component: 'runtime-receipt', check: 'agent_private_key_loaded', agent_id: agentId },
    { ok: status === 'pass', component: 'fleet-daemon', check: 'probe_alive', agent_id: agentId },
    { ok: status === 'pass', component: 'fleet-daemon', check: 'signed_attach_ok', agent_id: agentId, status: 200 },
    { ok: status === 'pass', component: 'fleet-daemon', check: 'signed_inbox_handoff_consumed', agent_id: agentId, action: 'inbox_consumed', status: 200, messages: 1 },
  ]
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: '2026-07-08T00:01:00.000Z',
    status,
    summary: { status, passed: checks.filter((check) => check.ok === true).length, failed: checks.filter((check) => check.ok === false).length, warnings: 0 },
    inputs: { daemon_config: '/config/daemon.json', selected_agents: [agentId] },
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      agents: [agentId],
    },
    checks,
    agents: [{
      agent: agentId,
      probe: 'alive',
      heartbeat: { ok: true, status: 200 },
      inbox: { agent: agentId, ok: true, action: 'inbox_consumed', status: 200, messages: 1, remaining: 0, consumed: true },
    }],
  }
}

function controlReceipt(agentId, verb, status = 'pass') {
  const action = verb === 'start' ? 'open' : verb === 'stop' ? 'close' : 'restart_open'
  const checks = [
    { ok: true, component: 'control-receipt', check: 'control_config_valid', path: '/config/control.json' },
    { ok: true, component: 'control-receipt', check: 'consumer_private_key_loaded', agent_id: 'fleet-consumer' },
    { ok: true, component: 'control-receipt', check: 'panel_public_key_loaded', path: '/config/panel.pub.jwk' },
    { ok: status === 'pass', component: 'fleet-control-daemon', check: 'control_request_executed', agent_id: agentId, verb, action, status: 200, retry: null },
  ]
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: '2026-07-08T00:02:00.000Z',
    status,
    summary: { status, passed: checks.filter((check) => check.ok === true).length, failed: checks.filter((check) => check.ok === false).length, warnings: 0 },
    inputs: { control_config: '/config/control.json', consumer_agent: 'fleet-consumer' },
    target: {
      base_url: POT_URL,
      tenant: POT_TENANT,
      consumer_agent: 'fleet-consumer',
      executed_agents: [agentId],
    },
    checks,
    poll: { ok: true, action, request: { agent_id: agentId, verb } },
  }
}

function serviceReceipt(status = 'pass') {
  return {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: '2026-07-13T20:03:00.000Z',
    status,
    platform: 'linux',
    service_manager: 'systemd',
    action: 'status',
    definitions: [
      { service: 'heartbeat', path: '/home/operator/.config/systemd/user/fleet-daemon.service', sha256: HEARTBEAT_SHA },
      { service: 'control', path: '/home/operator/.config/systemd/user/fleet-control-daemon.service', sha256: CONTROL_SHA },
    ],
    services: [
      { key: 'heartbeat', name: 'fleet-daemon.service', loaded: true, enabled: true, running: true, pid: 101 },
      { key: 'control', name: 'fleet-control-daemon.service', loaded: true, enabled: true, running: true, pid: 102 },
    ],
    linger: { enabled: true, raw: 'yes' },
    commands: [
      { executable: 'systemctl', argv: ['--user', 'show', 'fleet-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value'], code: 0, stdout_summary: '', stderr_summary: '' },
      { executable: 'systemctl', argv: ['--user', 'show', 'fleet-control-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value'], code: 0, stdout_summary: '', stderr_summary: '' },
      { executable: 'loginctl', argv: ['show-user', 'operator', '-p', 'Linger', '--value'], code: 0, stdout_summary: 'yes', stderr_summary: '' },
    ],
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: [],
    checks: [
      { ok: true, check: 'services_loaded_and_running' },
      { ok: true, check: 'command_output_secret_free' },
    ],
  }
}

function continuousReceipt(status = 'pass', sourceService = serviceReceipt()) {
  const service = sourceService
  return {
    receipt_type: 'mupot-fleet-continuous-runtime-receipt/v1',
    generated_at: '2026-07-13T20:04:00.000Z',
    status,
    agent: { agent_id: 'agent-one', probe: 'alive', heartbeat_status: 204, inbox_count: 1, consume: 'consumed' },
    observation: {
      started_at: '2026-07-13T20:03:00.000Z',
      deadline_at: '2026-07-13T20:05:00.000Z',
      timed_out: false,
      heartbeat: { schema: 'mupot-fleet-daemon-state/v1', pid: 101, started_at: '2026-07-13T20:00:00.000Z', last_tick_at: '2026-07-13T20:04:00.000Z', interval_sec: 15, tick: { before: 40, after: 43 } },
      control: { schema: 'mupot-fleet-control-state/v1', pid: 102, started_at: '2026-07-13T20:00:00.000Z', last_poll_at: '2026-07-13T20:04:00.000Z', poll_sec: 2, last_outcome: { agent_id: null, verb: null, accepted: true, result: 'idle' }, poll: { before: 70, after: 72 } },
    },
    service: { status: 'pass', service_manager: service.service_manager, services: service.services, linger: service.linger, checks: service.checks.map(({ check, ok }) => ({ check, ok })) },
    next_steps: [],
    checks: [
      { check: 'linger_enabled', ok: status === 'pass' },
      { check: 'observation_completed_before_deadline', ok: status === 'pass' },
      { check: 'services_running', ok: status === 'pass' },
      { check: 'heartbeat_tick_advanced', ok: status === 'pass' },
      { check: 'control_poll_advanced', ok: status === 'pass' },
      { check: 'agent_probe_alive', ok: status === 'pass' },
      { check: 'signed_heartbeat_2xx', ok: status === 'pass' },
      { check: 'heartbeat_fresh_under_ttl', ok: status === 'pass' },
      { check: 'inbox_consume_not_failed', ok: status === 'pass' },
    ],
  }
}

function starterReceipt(status = 'pass', digests = {}) {
  const paths = {
    install: 'install.json',
    service: 'service.json',
    host: 'host.json',
    continuous: 'continuous.json',
    runtime_inbox: 'runtime-agent-one.json',
    lifecycle_control_start: 'control-start.json',
    lifecycle_control_stop: 'control-stop.json',
    receipt_bundle_manifest: 'prior-bundle-manifest.json',
  }
  return {
    receipt_type: 'mupot-fleet-starter-receipt/v1',
    generated_at: '2026-07-13T20:05:00.000Z',
    status,
    manifest: {
      path: 'starter.example.json',
      sha256: STARTER_SHA,
    },
    artifacts: STARTER_ARTIFACT_ROLES.map((role) => ({ role, path: paths[role], sha256: digests[role] ?? '0'.repeat(64) })),
    checks: STARTER_CHECKS.map((check) => ({ check, ok: status === 'pass' })),
  }
}

function serviceAwareHostReceipt(sourceService = serviceReceipt()) {
  const service = sourceService
  const definitionDir = dirname(service.definitions[0].path)
  const definitionEvidence = service.definitions.map((definition) => ({
    service: definition.service,
    path: definition.path,
    expected_sha256: definition.sha256,
    rendered_sha256: definition.sha256,
    actual_sha256: definition.sha256,
    argv: ['/usr/bin/node', definition.service === 'heartbeat' ? '/runtime/fleet-daemon.mjs' : '/runtime/fleet-control-daemon.mjs', definition.service === 'heartbeat' ? '/config/daemon.json' : '/config/control.json'],
    expected_argv: ['/usr/bin/node', definition.service === 'heartbeat' ? '/runtime/fleet-daemon.mjs' : '/runtime/fleet-control-daemon.mjs', definition.service === 'heartbeat' ? '/config/daemon.json' : '/config/control.json'],
    ok: true,
  }))
  const receipt = hostReceipt('pass', {
    checks: [
      { ok: true, component: 'fleet-daemon', check: 'config_valid', path: '/config/daemon.json' },
      { ok: true, component: 'fleet-daemon', kind: 'fleet-daemon', check: 'base_url_real' },
      { ok: true, component: 'fleet-daemon', kind: 'fleet-daemon', check: 'tenant_real' },
      { ok: true, component: 'fleet-daemon', check: 'heartbeat_cadence_under_ttl', interval_sec: 15 },
      { ok: true, component: 'fleet-daemon', check: 'agent_private_key_present_0600', agent_id: 'agent-one', label: 'key:agent-one', path: '/keys/agent-one.key', mode: '600', size: 32 },
      { ok: true, component: 'fleet-daemon', check: 'probe_configured', agent_id: 'agent-one', probe: 'pgrep -f codex' },
      { ok: true, component: 'inbox-handler', check: 'config_valid', path: '/config/inbox.json' },
      { ok: true, component: 'inbox-handler', check: 'daemon_inbox_agent_has_handler_config', agent_id: 'agent-one' },
      { ok: true, component: 'inbox-handler', check: 'spool_dir_configured', agent_id: 'agent-one', spool_dir: '/spool', command_configured: true },
      { ok: true, component: 'fleet-control-daemon', check: 'config_valid', path: '/config/control.json' },
      { ok: true, component: 'fleet-control-daemon', kind: 'fleet-control-daemon', check: 'base_url_real' },
      { ok: true, component: 'fleet-control-daemon', kind: 'fleet-control-daemon', check: 'tenant_real' },
      { ok: true, component: 'fleet-control-daemon', check: 'consumer_private_key_present_0600', agent_id: 'fleet-consumer', label: 'key:fleet-consumer', path: '/keys/fleet-consumer.key', mode: '600', size: 32 },
      { ok: true, component: 'fleet-control-daemon', check: 'panel_public_key_present', label: 'panel_public_key', path: '/config/panel.pub.jwk', mode: '600', size: 64 },
      { ...HOST_PANEL_PUBLIC_KEY_CHECK, path: '/config/panel.pub.jwk' },
      { ok: true, component: 'fleet-control-daemon', check: 'flights_config_present', label: 'flights_config', path: '/config/flights.json', mode: '600', size: 32 },
      { ok: true, component: 'fleet-control-daemon', check: 'flight_script_present', label: 'flight_script', path: '/runtime/flight.mjs', mode: '755', size: 32 },
      { ok: true, component: 'host-receipt', check: 'daemon_control_base_url_match', daemon_base_url: POT_URL, control_base_url: POT_URL },
      { ok: true, component: 'host-receipt', check: 'daemon_control_tenant_match', daemon_tenant: POT_TENANT, control_tenant: POT_TENANT },
      { ok: true, component: 'host-services', check: 'service_definitions_current', service_manager: 'systemd', definition_dir: definitionDir, definitions: definitionEvidence },
      { ok: true, component: 'host-services', check: 'heartbeat_service_running', service: service.services[0] },
      { ok: true, component: 'host-services', check: 'control_service_running', service: service.services[1] },
      { ok: true, component: 'host-services', check: 'systemd_linger_enabled', service_manager: 'systemd', applicable: true, linger: service.linger },
    ],
  })
  receipt.inputs = {
    daemon_config: '/config/daemon.json', inbox_handler_config: '/config/inbox.json', control_config: '/config/control.json',
    exec_probes: false, service_manager: 'systemd', service_definition_dir: definitionDir,
  }
  return receipt
}

function priorBundleManifest(status = 'pass', artifactDigests = {}) {
  const ok = status === 'pass'
  const meta = (path, receiptType, sha256 = digest(`prior:${path}`)) => ({ path, receipt_type: receiptType, status, sha256 })
  const checks = [
    { ok, component: 'receipt-bundle', check: 'selected_agents_present', agents: ['agent-one'] },
    { ok, component: 'receipt-bundle', check: 'install_receipt_status_non_fail', path: 'install.json', accepted: ['pass', 'warn'], actual: status },
    { ok, component: 'receipt-bundle', check: 'probe_receipt_present', count: 1 },
    { ok, component: 'receipt-bundle', check: 'host_candidate_selected', path: 'host.json' },
    { ok, component: 'receipt-bundle', check: 'runtime_candidate_selected', path: 'runtime-agent-one.json' },
    { ok, component: 'receipt-bundle', check: 'control_candidate_selected', path: 'control-start.json' },
    { ok, component: 'receipt-bundle', check: 'control_candidate_selected', path: 'control-stop.json' },
    { ok, component: 'receipt-bundle', check: 'cutover_gate_status_pass', path: 'cutover-gate.json', actual: status },
    { ok, component: 'receipt-bundle', check: 'manifest_written', path: 'manifest.json' },
  ]
  return {
    receipt_type: 'mupot-fleet-receipt-bundle/v1',
    generated_at: '2026-07-13T20:04:30.000Z',
    status,
    summary: { status, passed: ok ? checks.length : 0, failed: ok ? 0 : checks.length, warnings: 0 },
    integrity: { algorithm: 'sha256', covers: 'receipt artifact files', excludes: ['manifest.json'] },
    inputs: {
      agents: ['agent-one'], out_dir: '.', daemon_config: 'daemon.json', inbox_handler_config: 'inbox.json', control_config: 'control.json',
      install_receipt: 'install.json', probe_receipts: ['probe-start.json'], control_label: null, required_control_verbs: ['start', 'stop'],
      exec_probes: false, verify_only: true, skip_host: true, skip_runtime: true, skip_control: true,
    },
    artifacts: {
      out_dir: '.',
      install: meta('install.json', 'mupot-fleet-install-receipt/v1', artifactDigests.install),
      probes: [meta('probe-start.json', 'mupot-fleet-cutover-probe/v1')],
      host: meta('host.json', 'mupot-fleet-host-receipt/v1', artifactDigests.host),
      runtimes: [meta('runtime-agent-one.json', 'mupot-fleet-runtime-receipt/v1', artifactDigests.runtime_inbox)],
      controls: [
        meta('control-start.json', 'mupot-fleet-control-receipt/v1', artifactDigests.lifecycle_control_start),
        meta('control-stop.json', 'mupot-fleet-control-receipt/v1', artifactDigests.lifecycle_control_stop),
      ],
      cutover_gate: meta('cutover-gate.json', 'mupot-sos-cutover-gate/v1'),
      manifest: 'manifest.json',
    },
    next_steps: ['attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)'],
    checks,
  }
}

function seedCutoverEvidence(outDir, host = hostReceipt()) {
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), host)
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
}

function starterPaths(overrides = {}) {
  const sourceDir = overrides.sourceDir ?? tmpDir()
  const service = overrides.service ?? serviceReceipt()
  if (Array.isArray(service.definitions)) {
    for (const definition of service.definitions) {
      if (definition?.service === 'heartbeat') {
        if (!overrides.preserveServiceDefinitions) definition.path = join(sourceDir, 'fleet-daemon.service')
        if (!existsSync(definition.path)) writeFileSync(definition.path, HEARTBEAT_DEFINITION)
      } else if (definition?.service === 'control') {
        if (!overrides.preserveServiceDefinitions) definition.path = join(sourceDir, 'fleet-control-daemon.service')
        if (!existsSync(definition.path)) writeFileSync(definition.path, CONTROL_DEFINITION)
      }
    }
  }
  const install = overrides.install ?? installReceipt('pass')
  if (!overrides.preserveInstallDefinitionPaths) {
    for (const definition of install.outputs.service_definitions) {
      const observed = service.definitions.find((entry) => entry.service === definition.service)
      if (!observed) continue
      definition.path = observed.path
      install.checks.find((check) => check.check === 'service_definition_rendered' && check.service === definition.service).path = observed.path
      const activated = install.activation?.definitions?.find((entry) => entry.service === definition.service)
      if (activated) activated.path = observed.path
    }
  }
  const host = overrides.host ?? serviceAwareHostReceipt(service)
  const continuous = overrides.continuous ?? continuousReceipt('pass', service)
  const runtime = overrides.runtime ?? runtimeReceipt('agent-one')
  const controlStart = overrides.controlStart ?? controlReceipt('agent-one', 'start')
  const controlStop = overrides.controlStop ?? controlReceipt('agent-one', 'stop')
  writeFileSync(join(sourceDir, 'starter.example.json'), STARTER_MANIFEST)
  const evidencePaths = {
    install: writeJson(join(sourceDir, 'install.json'), install),
    service: writeJson(join(sourceDir, 'service.json'), service),
    host: writeJson(join(sourceDir, 'host.json'), host),
    continuous: writeJson(join(sourceDir, 'continuous.json'), continuous),
    runtime_inbox: writeJson(join(sourceDir, 'runtime-agent-one.json'), runtime),
    lifecycle_control_start: writeJson(join(sourceDir, 'control-start.json'), controlStart),
    lifecycle_control_stop: writeJson(join(sourceDir, 'control-stop.json'), controlStop),
  }
  const initialDigests = Object.fromEntries(Object.entries(evidencePaths).map(([role, path]) => [role, sha256(path)]))
  const priorManifest = overrides.priorManifest ?? priorBundleManifest('pass', initialDigests)
  evidencePaths.receipt_bundle_manifest = writeJson(join(sourceDir, 'prior-bundle-manifest.json'), priorManifest)
  const artifactDigests = Object.fromEntries(Object.entries(evidencePaths).map(([role, path]) => [role, sha256(path)]))
  const starter = overrides.starter ?? starterReceipt('pass', artifactDigests)
  return {
    sourceDir,
    evidence: { install, service, host, continuous, runtime, controlStart, controlStop, priorManifest, starter },
    serviceReceiptPath: evidencePaths.service,
    continuousReceiptPath: evidencePaths.continuous,
    starterReceiptPath: writeJson(join(sourceDir, 'starter.json'), starter),
  }
}

async function actualProducerStarterPaths(manager) {
  const sourceDir = tmpDir()
  const platformName = manager === 'launchd' ? 'darwin' : 'linux'
  const keysDir = join(sourceDir, 'keys')
  const runtimeDir = join(sourceDir, 'runtime')
  const definitionDir = join(sourceDir, manager)
  const spoolDir = join(sourceDir, 'spool')
  for (const path of [keysDir, runtimeDir, definitionDir, spoolDir]) mkdirSync(path)

  const daemonPath = writeJson(join(sourceDir, 'daemon.json'), {
    base_url: POT_URL,
    tenant: POT_TENANT,
    interval_sec: 15,
    agents: [
      { agent_id: 'agent-one', type: 'builder', runtime: 'codex', probe: 'true', inbox: { command: 'node inbox-handler.mjs', limit: 20 } },
      { agent_id: 'fleet-consumer', type: 'manager', runtime: 'hermes', probe: 'true', inbox: { command: 'node inbox-handler.mjs', limit: 20 } },
    ],
  })
  const inboxPath = writeJson(join(sourceDir, 'inbox-handler.json'), {
    spool_dir: spoolDir,
    agents: [
      { agent_id: 'agent-one', command: 'true', run_for: ['request'] },
      { agent_id: 'fleet-consumer', command: 'true', run_for: ['request'] },
    ],
  })
  const panelPublicKeyPath = writeJson(join(sourceDir, 'panel.pub.jwk'), {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'bqjg1QCM1_F1Oe4xxjDidrEkNzkgwbAUk65dJUYFaLI',
  })
  const flightsPath = writeJson(join(sourceDir, 'flights.json'), { flights: [] })
  const flightScriptPath = join(sourceDir, 'flight.mjs')
  writeFileSync(flightScriptPath, 'export default {}\n')
  chmodSync(flightScriptPath, 0o755)
  const controlPath = writeJson(join(sourceDir, 'control.json'), {
    base_url: POT_URL,
    tenant: POT_TENANT,
    consumer_agent_id: 'fleet-consumer',
    panel_public_key: panelPublicKeyPath,
    flights_config: flightsPath,
    flight_script: flightScriptPath,
  })
  for (const agentId of ['agent-one', 'fleet-consumer']) {
    const path = join(keysDir, `${agentId}.key`)
    writeFileSync(path, '{}\n')
    chmodSync(path, 0o600)
  }

  const context = createServiceContext({
    manager,
    platformName,
    homeDir: sourceDir,
    prefix: sourceDir,
    runtimeDir,
    definitionDir,
    nodePath: process.execPath,
    uid: 501,
    username: 'operator',
  })
  const rendered = manager === 'launchd' ? renderLaunchd(context) : renderSystemd(context)
  for (const definition of rendered) writeFileSync(definition.path, definition.content)
  const service = {
    receipt_type: 'mupot-fleet-service-receipt/v1',
    generated_at: '2026-07-13T20:03:00.000Z',
    status: 'pass',
    platform: platformName,
    service_manager: manager,
    action: 'status',
    definitions: rendered.map((definition) => ({ service: definition.key, path: definition.path, sha256: digest(definition.content) })),
    services: context.services.map((serviceEntry, index) => ({
      key: serviceEntry.key,
      name: serviceEntry.name,
      loaded: true,
      enabled: true,
      running: true,
      pid: 101 + index,
    })),
    linger: manager === 'systemd' ? { enabled: true, raw: 'yes' } : null,
    commands: manager === 'systemd'
      ? [
          ...context.services.map((serviceEntry) => ({ executable: 'systemctl', argv: ['--user', 'show', serviceEntry.systemdUnit, '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value'], code: 0, stdout_summary: '', stderr_summary: '' })),
          { executable: 'loginctl', argv: ['show-user', 'operator', '-p', 'Linger', '--value'], code: 0, stdout_summary: 'yes', stderr_summary: '' },
        ]
      : context.services.map((serviceEntry) => ({ executable: 'launchctl', argv: ['print', `${context.domain}/${serviceEntry.launchdLabel}`], code: 0, stdout_summary: '', stderr_summary: '' })),
    preserved_data: { configs: true, private_keys: true, runtime: true, inbox: true, receipts: true },
    next_steps: [],
    checks: [{ ok: true, check: 'services_loaded_and_running' }, { ok: true, check: 'command_output_secret_free' }],
  }
  const host = await buildHostReceipt({
    daemonPath,
    inboxPath,
    controlPath,
    skipInbox: false,
    skipControl: false,
    execProbes: true,
    keyPathFor: (agentId) => join(keysDir, `${agentId}.key`),
    requireServices: true,
    serviceManager: manager,
    serviceDefinitionDir: definitionDir,
    runtimeDir,
    nodePath: process.execPath,
    homeDir: sourceDir,
    uid: 501,
    username: 'operator',
    platformName,
    buildServiceReceipt: async () => service,
  })
  assert.equal(host.status, 'pass', JSON.stringify(host.checks, null, 2))

  const install = installReceipt('pass')
  install.inputs.systemd_dir = manager === 'systemd' ? definitionDir : null
  install.inputs.node_path = process.execPath
  install.inputs.service_manager = { requested: manager, resolved: manager }
  install.inputs.service_definition_dir = definitionDir
  install.outputs.runtime_dir = runtimeDir
  install.outputs.service_definitions = service.definitions
  for (const check of install.checks) {
    if (check.check === 'systemd_definition_dir_ready') {
      check.check = `${manager}_definition_dir_ready`
      check.path = definitionDir
    }
    if (check.check === 'service_definition_rendered') {
      const definition = service.definitions.find((entry) => entry.service === check.service)
      check.path = definition.path
      check.sha256 = definition.sha256
    }
  }

  return starterPaths({
    sourceDir,
    preserveServiceDefinitions: true,
    service,
    host,
    install,
    continuous: continuousReceipt('pass', service),
  })
}

function seedStarterEvidence(outDir, sources) {
  const evidence = sources.evidence
  writeJson(join(outDir, 'install.json'), evidence.install)
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), evidence.host)
  writeJson(join(outDir, 'runtime-agent-one.json'), evidence.runtime)
  writeJson(join(outDir, 'control-start.json'), evidence.controlStart)
  writeJson(join(outDir, 'control-stop.json'), evidence.controlStop)
}

const STARTER_ROLE_FILES = Object.freeze({
  install: 'install.json',
  service: 'service.json',
  host: 'host.json',
  continuous: 'continuous.json',
  runtime_inbox: 'runtime-agent-one.json',
  lifecycle_control_start: 'control-start.json',
  lifecycle_control_stop: 'control-stop.json',
  receipt_bundle_manifest: 'prior-bundle-manifest.json',
})

const STARTER_ROLE_EVIDENCE_KEYS = Object.freeze({
  install: 'install',
  service: 'service',
  host: 'host',
  continuous: 'continuous',
  runtime_inbox: 'runtime',
  lifecycle_control_start: 'controlStart',
  lifecycle_control_stop: 'controlStop',
  receipt_bundle_manifest: 'priorManifest',
})

function rewriteStarterReceipt(sources) {
  writeJson(sources.starterReceiptPath, sources.evidence.starter)
}

function rewriteStarterEvidence(sources, role) {
  const path = join(sources.sourceDir, STARTER_ROLE_FILES[role])
  const value = sources.evidence[STARTER_ROLE_EVIDENCE_KEYS[role]]
  writeJson(path, value)
  sources.evidence.starter.artifacts.find((artifact) => artifact.role === role).sha256 = sha256(path)
  rewriteStarterReceipt(sources)
}

function nestStarterSources(sources) {
  const manifestDir = join(sources.sourceDir, 'manifest')
  const evidenceDir = join(sources.sourceDir, 'evidence')
  mkdirSync(manifestDir)
  mkdirSync(evidenceDir)

  const oldManifestPath = join(sources.sourceDir, sources.evidence.starter.manifest.path)
  const newManifestPath = join(manifestDir, 'starter.example.json')
  copyFileSync(oldManifestPath, newManifestPath)
  rmSync(oldManifestPath)
  sources.evidence.starter.manifest.path = 'manifest/starter.example.json'

  for (const artifact of sources.evidence.starter.artifacts) {
    const oldPath = join(sources.sourceDir, artifact.path)
    const newRelativePath = `evidence/${artifact.path}`
    const newPath = join(sources.sourceDir, newRelativePath)
    copyFileSync(oldPath, newPath)
    rmSync(oldPath)
    artifact.path = newRelativePath
    if (artifact.role === 'service') sources.serviceReceiptPath = newPath
    if (artifact.role === 'continuous') sources.continuousReceiptPath = newPath
  }
  rewriteStarterReceipt(sources)
  return sources
}

function absoluteStrings(value, found = []) {
  if (typeof value === 'string' && value.startsWith('/')) found.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => absoluteStrings(entry, found))
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => absoluteStrings(entry, found))
  return found
}

test('receipt bundle writes host, runtime, control, cutover gate, and manifest', async () => {
  const outDir = tmpDir()
  const installPath = writeJson(join(tmpDir(), 'install.json'), installReceipt())
  const probePath = writeJson(join(tmpDir(), 'start-probe.json'), probeReceipt())
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    installReceiptPath: installPath,
    probeReceiptPaths: [probePath],
    controlLabel: 'restart',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'restart'),
  })

  assert.equal(bundle.receipt_type, 'mupot-fleet-receipt-bundle/v1')
  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.summary.failed, 0)
  assert.equal(bundle.artifacts.install.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(bundle.artifacts.install.status, 'warn')
  assert.equal(bundle.artifacts.probes.length, 1)
  assert.equal(bundle.artifacts.probes[0].receipt_type, 'mupot-fleet-cutover-probe/v1')
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.next_steps.some((s) => s.includes('SOS removal is permitted only for the proven agent')))
  assert.ok(existsSync(join(outDir, 'install.json')))
  assert.ok(existsSync(join(outDir, 'probe-start-probe.json')))
  assert.ok(existsSync(join(outDir, 'host.json')))
  assert.ok(existsSync(join(outDir, 'runtime-agent-one.json')))
  assert.ok(existsSync(join(outDir, 'control-restart.json')))
  assert.ok(existsSync(join(outDir, 'cutover-gate.json')))
  assert.ok(existsSync(join(outDir, 'manifest.json')))

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.status, 'pass')
  assert.equal(manifest.integrity.algorithm, 'sha256')
  assert.deepEqual(manifest.integrity.excludes, ['manifest.json'])
  assert.equal(manifest.artifacts.install.status, 'warn')
  assert.equal(manifest.artifacts.probes[0].status, 'pass')
  assert.equal(manifest.artifacts.install.sha256, sha256(join(outDir, 'install.json')))
  assert.equal(manifest.artifacts.probes[0].sha256, sha256(join(outDir, 'probe-start-probe.json')))
  assert.equal(manifest.artifacts.host.sha256, sha256(join(outDir, 'host.json')))
  assert.equal(manifest.artifacts.runtimes[0].sha256, sha256(join(outDir, 'runtime-agent-one.json')))
  assert.equal(manifest.artifacts.controls[0].sha256, sha256(join(outDir, 'control-restart.json')))
  assert.equal(manifest.artifacts.cutover_gate.sha256, sha256(join(outDir, 'cutover-gate.json')))
  assert.ok(manifest.next_steps.some((s) => s.includes('manifest.json and cutover-gate.json')))
  assert.ok(manifest.checks.some((c) => c.check === 'install_receipt_status_non_fail' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'probe_receipt_status_pass' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'cutover_gate_status_pass' && c.ok === true))
  assert.ok(manifest.checks.some((c) => c.check === 'manifest_written' && c.ok === true))
})

test('starter-ready bundle requires, exports, and summarizes service continuity evidence', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  const immutableSourcePaths = [
    sources.serviceReceiptPath,
    sources.continuousReceiptPath,
    sources.starterReceiptPath,
    join(sources.sourceDir, 'starter.example.json'),
    join(sources.sourceDir, 'prior-bundle-manifest.json'),
    join(sources.sourceDir, 'fleet-daemon.service'),
    join(sources.sourceDir, 'fleet-control-daemon.service'),
  ]
  const sourceBytes = new Map(immutableSourcePaths.map((path) => [path, readFileSync(path)]))
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    ...sources,
  })

  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.inputs.bundle_mode, 'starter-ready')
  assert.equal(bundle.artifacts.service.receipt_type, 'mupot-fleet-service-receipt/v1')
  assert.equal(bundle.artifacts.continuous.receipt_type, 'mupot-fleet-continuous-runtime-receipt/v1')
  assert.equal(bundle.artifacts.starter.receipt_type, 'mupot-fleet-starter-receipt/v1')
  const sourceCheck = checkBundleManifest({ outDir })
  assert.equal(sourceCheck.status, 'pass', JSON.stringify(sourceCheck.checks.filter((check) => check.ok === false), null, 2))

  const status = inspectBundleStatus({ outDir })
  const compact = formatStatusSummary(status)
  assert.equal(status.starter_ready.service_manager, 'systemd')
  assert.deepEqual(status.starter_ready.definition_hashes, {
    heartbeat: HEARTBEAT_SHA,
    control: CONTROL_SHA,
  })
  assert.deepEqual(status.starter_ready.observed_deltas, { heartbeat_tick: 3, control_poll: 2 })
  assert.equal(status.starter_ready.starter_manifest_sha256, STARTER_SHA)
  assert.match(compact, /Service manager: systemd/)
  assert.match(compact, new RegExp(`Definition hashes: heartbeat=${HEARTBEAT_SHA}, control=${CONTROL_SHA}`))
  assert.match(compact, /Observed deltas: heartbeat tick=3, control poll=2/)
  assert.match(compact, new RegExp(`Starter manifest: ${STARTER_SHA}`))

  const sourceManifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  const admittedSourcePaths = [
    join(outDir, 'manifest.json'),
    sourceManifest.artifacts.install.path,
    ...sourceManifest.artifacts.probes.map((artifact) => artifact.path),
    sourceManifest.artifacts.service.path,
    sourceManifest.artifacts.continuous.path,
    sourceManifest.artifacts.starter.path,
    sourceManifest.artifacts.host.path,
    ...sourceManifest.artifacts.runtimes.map((artifact) => artifact.path),
    ...sourceManifest.artifacts.controls.map((artifact) => artifact.path),
    sourceManifest.artifacts.cutover_gate.path,
    join(outDir, 'fleet-daemon.service'),
    join(outDir, 'fleet-control-daemon.service'),
    join(outDir, 'starter.example.json'),
    join(outDir, 'prior-bundle-manifest.json'),
  ]
  const admittedSourceBytes = new Map(admittedSourcePaths.map((path) => [basename(path), readFileSync(path)]))
  const sourceHashes = Object.fromEntries(
    ['install', 'service', 'host', 'continuous', 'starter'].map((role) => [role, sourceManifest.artifacts[role].sha256]),
  )
  const exportDir = tmpDir()
  const exportReceipt = exportBundle({ outDir, exportDir })
  assert.equal(exportReceipt.status, 'pass', JSON.stringify(exportReceipt.checks.filter((check) => check.ok === false), null, 2))
  for (const [path, before] of sourceBytes) assert.deepEqual(readFileSync(path), before, path)
  rmSync(outDir, { recursive: true })
  rmSync(sources.sourceDir, { recursive: true })
  const copiedCheck = checkBundleManifest({ outDir: exportDir })
  assert.equal(copiedCheck.status, 'pass')
  assert.equal(readFileSync(join(exportDir, 'manifest.json'), 'utf8').includes(outDir), false)
  assert.deepEqual(
    ['service.json', 'continuous.json', 'starter.json'].map((name) => existsSync(join(exportDir, name))),
    [true, true, true],
  )
  const exportedManifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'))
  assert.equal(exportedManifest.provenance.schema, 'mupot-fleet-portable-provenance/v1')
  assert.match(exportedManifest.provenance.source_path, /^provenance\/outer_manifest\/[^/]+$/)
  assert.equal(exportedManifest.provenance.source_sha256, digest(admittedSourceBytes.get('manifest.json')))
  assert.deepEqual(readFileSync(join(exportDir, exportedManifest.provenance.source_path)), admittedSourceBytes.get('manifest.json'))
  assert.ok(exportedManifest.provenance.projections.length >= 13)
  assert.equal(statSync(join(exportDir, 'provenance')).mode & 0o777, 0o700)
  for (const mapping of exportedManifest.provenance.projections) {
    assert.match(mapping.source_path, new RegExp(`^provenance/${mapping.role.replace(/[^A-Za-z0-9_.-]+/g, '_')}/[^/]+$`), mapping.role)
    const retainedPath = join(exportDir, mapping.source_path)
    assert.equal(lstatSync(retainedPath).isSymbolicLink(), false, mapping.role)
    assert.equal(statSync(dirname(retainedPath)).mode & 0o777, 0o700, mapping.role)
    assert.equal(statSync(retainedPath).mode & 0o777, 0o600, mapping.role)
    assert.deepEqual(readFileSync(retainedPath), admittedSourceBytes.get(mapping.path), mapping.role)
    const wrapper = JSON.parse(readFileSync(join(exportDir, mapping.path), 'utf8'))
    assert.equal(wrapper.source_path, mapping.source_path, mapping.role)
    assert.equal(wrapper.source_sha256, digest(readFileSync(retainedPath)), mapping.role)
  }
  const copiedService = JSON.parse(readFileSync(join(exportDir, 'service.json'), 'utf8'))
  assert.deepEqual(Object.keys(copiedService), ['receipt_type', 'role', 'source_receipt_type', 'source_path', 'source_sha256', 'projection_sha256', 'content'])
  assert.equal(copiedService.receipt_type, 'mupot-fleet-portable-evidence-projection/v1')
  assert.equal(copiedService.source_receipt_type, 'mupot-fleet-service-receipt/v1')
  assert.equal(copiedService.source_sha256, sourceHashes.service)
  assert.equal(copiedService.projection_sha256, digest(`${JSON.stringify(copiedService.content, null, 2)}\n`))
  for (const definition of copiedService.content.definitions) {
    assert.equal(sha256(join(exportDir, definition.path)), definition.sha256)
  }
  const copiedStarter = JSON.parse(readFileSync(join(exportDir, 'starter.json'), 'utf8'))
  assert.equal(copiedStarter.source_sha256, sourceHashes.starter)
  assert.equal(sha256(join(exportDir, copiedStarter.content.manifest.path)), copiedStarter.content.manifest.sha256)
  for (const artifact of copiedStarter.content.artifacts) {
    assert.equal(sha256(join(exportDir, artifact.path)), artifact.sha256, artifact.role)
  }
  const prior = copiedStarter.content.artifacts.find((artifact) => artifact.role === 'receipt_bundle_manifest')
  assert.notEqual(prior.path, 'manifest.json')
  const sterileProjection = JSON.parse(readFileSync(join(exportDir, copiedStarter.content.manifest.path), 'utf8'))
  assert.deepEqual(sterileProjection.content, STARTER_MANIFEST_VALUE)
  for (const name of readdirSync(exportDir).filter((entry) => entry.endsWith('.json'))) {
    assert.deepEqual(absoluteStrings(JSON.parse(readFileSync(join(exportDir, name), 'utf8'))), [], name)
  }
  assert.deepEqual(absoluteStrings(copiedCheck), [])
  assert.deepEqual(absoluteStrings(inspectBundleStatus({ outDir: exportDir })), [])
})

test('starter verifier shares the starter-ready deep evidence contract and CLI manifest default', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    ...sources,
  })
  assert.equal(bundle.status, 'pass')

  const artifacts = {
    install: 'install.json',
    service: 'service.json',
    host: 'host.json',
    continuous: 'continuous.json',
    runtime_inbox: 'runtime-agent-one.json',
    lifecycle_control_start: 'control-start.json',
    lifecycle_control_stop: 'control-stop.json',
    receipt_bundle_manifest: 'prior-bundle-manifest.json',
  }
  const receipt = verifyStarterBundle({
    bundleDir: outDir,
    artifacts,
    now: () => new Date('2026-07-13T20:06:00.000Z'),
  })
  assert.equal(receipt.receipt_type, 'mupot-fleet-starter-receipt/v1')
  assert.equal(receipt.status, 'pass')

  const args = ['fleet-runtime/starter-manifest.mjs', '--verify', '--bundle-dir', outDir]
  for (const [role, path] of Object.entries(artifacts)) args.push('--artifact', `${role}=${path}`)
  const cli = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).status, 'pass')
})

test('portable export preserves activated install evidence after source deletion', async () => {
  const outDir = tmpDir()
  const service = serviceReceipt()
  const install = installReceipt('pass')
  install.inputs.activation_requested = true
  install.inputs.activation_performed = true
  install.activation = structuredClone(service)
  install.activation.action = 'install'
  install.checks.push({ ok: true, component: 'fleet-install', check: 'service_activation', service_receipt: 'mupot-fleet-service-receipt/v1' })
  install.summary = summarizeFixture(install.checks)
  const sources = starterPaths({ service, install })
  seedStarterEvidence(outDir, sources)

  const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
  assert.equal(bundle.status, 'pass', JSON.stringify(bundle.checks.filter((check) => check.ok === false), null, 2))
  const exportDir = tmpDir()
  const exported = exportBundle({ outDir, exportDir })
  assert.equal(exported.status, 'pass', JSON.stringify(exported.checks.filter((check) => check.ok === false), null, 2))
  rmSync(outDir, { recursive: true })
  rmSync(sources.sourceDir, { recursive: true })

  const copiedCheck = checkBundleManifest({ outDir: exportDir })
  assert.equal(copiedCheck.status, 'pass', JSON.stringify(copiedCheck.checks.filter((check) => check.ok === false), null, 2))
})

test('starter-ready consumes actual systemd and launchd Host-Go producer receipts', async (t) => {
  for (const manager of ['systemd', 'launchd']) {
    await t.test(manager, async () => {
      const outDir = tmpDir()
      const sources = await actualProducerStarterPaths(manager)
      seedStarterEvidence(outDir, sources)

      const bundle = await buildBundle({
        outDir,
        agents: ['agent-one'],
        verifyOnly: true,
        ...sources,
      })
      const host = sources.evidence.host
      const hostCheckNames = host.checks.filter((check) => check.component === 'host-services').map((check) => check.check)

      assert.equal(bundle.status, 'pass', JSON.stringify(bundle.checks.filter((check) => check.ok === false), null, 2))
      assert.deepEqual(hostCheckNames, ['service_definitions_current', 'heartbeat_service_running', 'control_service_running', 'systemd_linger_enabled'])
      assert.equal(host.checks.filter((check) => check.check === 'agent_private_key_present_0600').length, 2)
      assert.equal(host.checks.filter((check) => check.check === 'probe_configured').length, 2)
      assert.equal(host.checks.filter((check) => check.check === 'probe_exec_alive').length, 2)
      const linger = host.checks.find((check) => check.check === 'systemd_linger_enabled')
      assert.equal(linger.applicable, manager === 'systemd')
      assert.equal(linger.linger, manager === 'systemd' ? sources.evidence.service.linger : null)

      const checked = checkBundleManifest({ outDir })
      assert.equal(checked.status, 'pass', JSON.stringify(checked.checks.filter((check) => check.ok === false), null, 2))
    })
  }
})

test('starter-ready requires recomputed passing evidence for every Task 8 category', async (t) => {
  const cases = [
    ['warning install receipt', (sources) => {
      sources.evidence.install = installReceipt('warn')
      rewriteStarterEvidence(sources, 'install')
    }],
    ['runtime top-level pass over failing summary', (sources) => {
      const receipt = sources.evidence.runtime
      receipt.checks[0] = { ...receipt.checks[0], ok: false, reason: 'fabricated_failure' }
      receipt.summary = summarizeFixture(receipt.checks)
      rewriteStarterEvidence(sources, 'runtime_inbox')
    }],
    ['lifecycle control top-level pass over failing summary', (sources) => {
      const receipt = sources.evidence.controlStart
      receipt.checks[0] = { ...receipt.checks[0], ok: false, reason: 'fabricated_failure' }
      receipt.summary = summarizeFixture(receipt.checks)
      rewriteStarterEvidence(sources, 'lifecycle_control_start')
    }],
    ['prior bundle top-level pass over failing summary', (sources) => {
      const receipt = sources.evidence.priorManifest
      receipt.checks[0].ok = false
      receipt.summary = summarizeFixture(receipt.checks)
      rewriteStarterEvidence(sources, 'receipt_bundle_manifest')
    }],
    ['self-authored empty prior bundle', (sources) => {
      const receipt = sources.evidence.priorManifest
      receipt.artifacts = { out_dir: '.', install: null, probes: [], host: null, runtimes: [], controls: [], cutover_gate: null, manifest: 'manifest.json' }
      receipt.checks = [{ ok: true, component: 'receipt-bundle', check: 'manifest_written', path: 'manifest.json' }]
      receipt.summary = summarizeFixture(receipt.checks)
      rewriteStarterEvidence(sources, 'receipt_bundle_manifest')
    }],
  ]

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const outDir = tmpDir()
      const sources = starterPaths()
      mutate(sources)
      seedStarterEvidence(outDir, sources)
      const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
      assert.equal(bundle.status, 'fail', JSON.stringify(bundle.checks.filter((check) => check.ok === false), null, 2))
      assert.ok(bundle.checks.some((check) => check.check === 'starter_evidence_contracts_valid' && check.ok === false))
    })
  }

  await t.test('probe top-level pass over failing summary', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    seedStarterEvidence(outDir, sources)
    const probe = probeReceipt()
    probe.checks[0].ok = false
    probe.summary = summarizeFixture(probe.checks)
    writeJson(join(outDir, 'probe-start.json'), probe)

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail', JSON.stringify(bundle.checks.filter((check) => check.ok === false), null, 2))
  })
})

test('starter-ready validates complete producer contracts and cross-receipt bindings', async (t) => {
  const launchdInstall = installReceipt('pass')
  launchdInstall.inputs.systemd_dir = null
  launchdInstall.inputs.service_manager = { requested: 'launchd', resolved: 'launchd' }
  launchdInstall.checks.find((check) => check.check === 'systemd_definition_dir_ready').check = 'launchd_definition_dir_ready'

  const mismatchedDefinitionInstall = installReceipt('pass')
  mismatchedDefinitionInstall.outputs.service_definitions[0].sha256 = 'f'.repeat(64)
  mismatchedDefinitionInstall.checks.find((check) => check.check === 'service_definition_rendered' && check.service === 'heartbeat').sha256 = 'f'.repeat(64)

  const mismatchedActivationInstall = installReceipt('pass')
  mismatchedActivationInstall.inputs.activation_requested = true
  mismatchedActivationInstall.inputs.activation_performed = true
  mismatchedActivationInstall.activation = serviceReceipt('pass')
  mismatchedActivationInstall.activation.action = 'install'
  mismatchedActivationInstall.activation.definitions[0].sha256 = 'e'.repeat(64)
  mismatchedActivationInstall.checks.push({ ok: true, component: 'fleet-install', check: 'service_activation', service_receipt: 'mupot-fleet-service-receipt/v1' })
  mismatchedActivationInstall.summary = summarizeFixture(mismatchedActivationInstall.checks)

  const mismatchedPathInstall = installReceipt('pass')
  mismatchedPathInstall.inputs.activation_requested = true
  mismatchedPathInstall.inputs.activation_performed = true
  mismatchedPathInstall.activation = serviceReceipt('pass')
  mismatchedPathInstall.activation.action = 'install'
  mismatchedPathInstall.checks.push({ ok: true, component: 'fleet-install', check: 'service_activation', service_receipt: 'mupot-fleet-service-receipt/v1' })
  for (const definition of mismatchedPathInstall.outputs.service_definitions) {
    const wrongPath = `/wrong/${basename(definition.path)}`
    definition.path = wrongPath
    mismatchedPathInstall.checks.find((check) => check.check === 'service_definition_rendered' && check.service === definition.service).path = wrongPath
    mismatchedPathInstall.activation.definitions.find((entry) => entry.service === definition.service).path = wrongPath
  }
  mismatchedPathInstall.summary = summarizeFixture(mismatchedPathInstall.checks)

  const cases = [
    ['negative heartbeat delta', { continuous: (() => { const r = continuousReceipt(); r.observation.heartbeat.tick.after = 39; return r })() }],
    ['zero control delta', { continuous: (() => { const r = continuousReceipt(); r.observation.control.poll.after = 70; return r })() }],
    ['wrong continuous agent', { continuous: (() => { const r = continuousReceipt(); r.agent.agent_id = 'other'; return r })() }],
    ['wrong manager', { continuous: (() => { const r = continuousReceipt(); r.service.service_manager = 'launchd'; r.service.linger = null; return r })() }],
    ['stopped service', { service: (() => { const r = serviceReceipt(); r.services[0].running = false; r.services[0].pid = null; return r })() }],
    ['duplicate definition', { service: (() => { const r = serviceReceipt(); r.definitions[1] = { ...r.definitions[0] }; return r })() }],
    ['unknown service field', { service: { ...serviceReceipt(), fabricated: true } }],
    ['unknown continuous field', { continuous: { ...continuousReceipt(), fabricated: true } }],
    ['arbitrary manifest digest', { starter: (() => { const r = starterReceipt(); r.manifest.sha256 = 'digest'; return r })() }],
    ['absolute starter artifact', { starter: (() => { const r = starterReceipt(); r.artifacts[0].path = '/tmp/starter.json'; return r })() }],
    ['duplicate starter artifact role', { starter: (() => { const r = starterReceipt(); r.artifacts[1].role = r.artifacts[0].role; return r })() }],
    ['unknown starter field', { starter: { ...starterReceipt(), fabricated: true } }],
    ['install manager differs from observed service manager', { install: launchdInstall }],
    ['install definition hash differs from observed service definition', { install: mismatchedDefinitionInstall }],
    ['install activation definition differs from observed service definition', { install: mismatchedActivationInstall }],
    ['install output and activation paths differ from observed service definitions', { install: mismatchedPathInstall, preserveInstallDefinitionPaths: true }],
  ]
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const outDir = tmpDir()
      const sources = starterPaths(overrides)
      seedStarterEvidence(outDir, sources)
      const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
      assert.equal(bundle.status, 'fail')
    })
  }

  await t.test('host definition hash mismatch', async () => {
    const host = serviceAwareHostReceipt()
    host.checks.find((check) => check.check === 'service_definitions_current').definitions[0].actual_sha256 = 'f'.repeat(64)
    const outDir = tmpDir()
    const sources = starterPaths({ host })
    seedStarterEvidence(outDir, sources)
    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
  })
})

test('starter-ready binds every Task 8 artifact digest to admitted bytes and excludes the outer manifest', async (t) => {
  await t.test('artifact digest drift', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    sources.evidence.starter.artifacts.find((artifact) => artifact.role === 'runtime_inbox').sha256 = '9'.repeat(64)
    rewriteStarterReceipt(sources)
    seedStarterEvidence(outDir, sources)

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
    assert.ok(bundle.checks.some((check) => check.check === 'starter_evidence_contracts_valid' && check.ok === false))
  })

  await t.test('prior bundle role cannot name the new outer manifest', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    const priorPath = writeJson(join(sources.sourceDir, 'manifest.json'), sources.evidence.priorManifest)
    const artifact = sources.evidence.starter.artifacts.find((entry) => entry.role === 'receipt_bundle_manifest')
    artifact.path = 'manifest.json'
    artifact.sha256 = sha256(priorPath)
    rewriteStarterReceipt(sources)
    seedStarterEvidence(outDir, sources)

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
  })
})

test('starter-ready enforces PID, identity, cadence, counter, outcome, and prior-status bindings', async (t) => {
  const cases = [
    ['heartbeat pid differs from service', 'continuous', (sources) => { sources.evidence.continuous.observation.heartbeat.pid = 999 }],
    ['control pid differs from service', 'continuous', (sources) => { sources.evidence.continuous.observation.control.pid = 999 }],
    ['heartbeat cadence below producer minimum', 'continuous', (sources) => { sources.evidence.continuous.observation.heartbeat.interval_sec = 14 }],
    ['control cadence above producer maximum', 'continuous', (sources) => { sources.evidence.continuous.observation.control.poll_sec = 121 }],
    ['negative heartbeat counter', 'continuous', (sources) => { sources.evidence.continuous.observation.heartbeat.tick.before = -1 }],
    ['fractional control counter', 'continuous', (sources) => { sources.evidence.continuous.observation.control.poll.after = 72.5 }],
    ['invalid accepted outcome tuple', 'continuous', (sources) => { sources.evidence.continuous.observation.control.last_outcome = { agent_id: 'agent-one', verb: 'start', accepted: true, result: 'close' } }],
    ['host service pid differs', 'host', (sources) => { sources.evidence.host.checks.find((check) => check.check === 'heartbeat_service_running').service.pid = 999 }],
    ['runtime targets another agent', 'runtime_inbox', (sources) => { sources.evidence.runtime.target.agents = ['other-agent']; sources.evidence.runtime.inputs.selected_agents = ['other-agent']; sources.evidence.runtime.agents[0].agent = 'other-agent' }],
    ['start control targets another agent', 'lifecycle_control_start', (sources) => { sources.evidence.controlStart.target.executed_agents = ['other-agent']; sources.evidence.controlStart.poll.request.agent_id = 'other-agent'; sources.evidence.controlStart.checks.at(-1).agent_id = 'other-agent' }],
    ['prior bundle reports fail', 'receipt_bundle_manifest', (sources) => { sources.evidence.priorManifest.status = 'fail'; sources.evidence.priorManifest.summary = { status: 'fail', passed: 0, failed: 1, warnings: 0 }; sources.evidence.priorManifest.checks[0].ok = false }],
  ]

  for (const [name, role, mutate] of cases) {
    await t.test(name, async () => {
      const outDir = tmpDir()
      const sources = starterPaths()
      mutate(sources)
      rewriteStarterEvidence(sources, role)
      seedStarterEvidence(outDir, sources)

      const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
      assert.equal(bundle.status, 'fail')
      assert.ok(bundle.checks.some((check) => check.check === 'starter_evidence_contracts_valid' && check.ok === false))
    })
  }
})

test('starter-ready deeply validates the Host-Go envelope and complete sterile manifest', async (t) => {
  await t.test('nested Host-Go unknown field', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    sources.evidence.host.target.fabricated = true
    rewriteStarterEvidence(sources, 'host')
    seedStarterEvidence(outDir, sources)
    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
  })

  await t.test('fabricated Host-Go summary', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    sources.evidence.host.summary.passed += 1
    rewriteStarterEvidence(sources, 'host')
    seedStarterEvidence(outDir, sources)
    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
  })

  await t.test('incomplete sterile manifest', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    const incomplete = { ...STARTER_MANIFEST_VALUE }
    delete incomplete.control_consumer_agent_id
    const manifestPath = join(sources.sourceDir, 'starter.example.json')
    writeFileSync(manifestPath, `${JSON.stringify(incomplete, null, 2)}\n`)
    sources.evidence.starter.manifest.sha256 = sha256(manifestPath)
    rewriteStarterReceipt(sources)
    seedStarterEvidence(outDir, sources)
    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
  })
})

test('starter-ready accepts producer-valid running but disabled service state', async () => {
  const service = serviceReceipt()
  for (const state of service.services) state.enabled = false
  const sources = starterPaths({ service })
  const outDir = tmpDir()
  seedStarterEvidence(outDir, sources)

  const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
  assert.equal(bundle.status, 'pass', JSON.stringify(bundle.checks.filter((check) => check.ok === false), null, 2))
})

test('starter option validation rejects malformed and partial roles before creating output', async () => {
  assert.throws(() => parseArgs(['--service-receipt', '--status']), /requires a value/)
  assert.throws(() => parseArgs(['--service-receipt', '']), /requires a value/)
  assert.throws(() => parseArgs(['--service-receipt', './service.json']), /exactly all three/)
  const parent = tmpDir()
  const outDir = join(parent, 'must-not-exist')
  await assert.rejects(
    buildBundle({ outDir, agents: ['agent-one'], serviceReceiptPath: join(parent, 'service.json') }),
    /exactly all three/,
  )
  assert.equal(existsSync(outDir), false)
})

test('starter-ready mode fails unless all three exact passing secret-free receipts are supplied', async (t) => {
  const cases = [
    {
      name: 'wrong service receipt type',
      paths: () => starterPaths({ service: { ...serviceReceipt(), receipt_type: 'mupot-fleet-continuous-runtime-receipt/v1' } }),
      failedCheck: 'service_receipt_type',
    },
    {
      name: 'failed continuous receipt',
      paths: () => starterPaths({ continuous: continuousReceipt('fail') }),
      failedCheck: 'continuous_receipt_status_pass',
    },
    {
      name: 'secret-bearing starter receipt',
      paths: () => starterPaths({
        starter: {
          ...starterReceipt(),
          leaked: { authorization: 'Bearer starter_secret_abcdefghijklmnopqrstuvwxyz' },
        },
      }),
      failedCheck: 'starter_receipt_no_secret_material',
    },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const outDir = tmpDir()
      const paths = entry.paths()
      seedStarterEvidence(outDir, paths)
      const bundle = await buildBundle({
        outDir,
        agents: ['agent-one'],
        daemonPath: '/tmp/daemon.json',
        inboxPath: '/tmp/inbox.json',
        controlPath: '/tmp/control.json',
        verifyOnly: true,
        ...paths,
      })

      assert.equal(bundle.status, 'fail')
      assert.ok(bundle.checks.some((check) => check.check === entry.failedCheck && check.ok === false))
    })
  }
})

test('starter-ready manifest check rejects hash drift and fabricated mode metadata', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    ...sources,
  })
  assert.equal(bundle.status, 'pass')

  const servicePath = join(outDir, 'service.json')
  writeJson(servicePath, { ...serviceReceipt(), generated_at: '2026-07-13T21:00:00.000Z' })
  const drift = checkBundleManifest({ outDir })
  assert.equal(drift.status, 'fail')
  assert.ok(drift.checks.some((check) => check.check === 'artifact_sha256_match' && check.artifact === 'service' && check.ok === false))

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.service.sha256 = sha256(servicePath)
  delete manifest.inputs.bundle_mode
  writeJson(manifestPath, manifest)
  const fabricated = checkBundleManifest({ outDir })
  assert.equal(fabricated.status, 'fail')
  assert.ok(fabricated.checks.some((check) => check.check === 'bundle_mode_matches_artifacts' && check.ok === false))
})

test('receipt bundle fails when an included probe receipt did not queue inputs', async () => {
  const outDir = tmpDir()
  const probePath = writeJson(join(tmpDir(), 'failed-probe.json'), probeReceipt('fail'))
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    probeReceiptPaths: [probePath],
    controlLabel: 'restart',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'restart'),
  })

  assert.equal(bundle.status, 'fail')
  assert.ok(bundle.checks.some((c) => c.check === 'probe_receipt_status_pass' && c.ok === false && c.actual === 'fail'))
  assert.deepEqual(bundle.next_steps, [NEXT_STEP_HOLD])
  assert.ok(inspectBundleStatus({ outDir, agents: ['agent-one'] }).next_steps.some((s) => s.includes('queue inbox and lifecycle inputs')))
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.artifacts.probes[0].status, 'fail')
  assert.ok(manifest.next_steps.some((s) => s.includes('do not remove SOS wiring yet')))
})

test('receipt bundle can reuse existing host, runtime, and control receipts', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))

  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    skipHost: true,
    skipRuntime: true,
    skipControl: true,
  })

  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.checks.some((c) => c.check === 'host_receipt_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'runtime_receipts_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'control_receipts_reused' && c.ok === true))
})

test('receipt bundle fails when reused host receipt lacks public-only panel key evidence', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt('pass', { checks: [] }))
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))

  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    skipHost: true,
    skipRuntime: true,
    skipControl: true,
  })

  assert.equal(bundle.status, 'fail')
  assert.ok(bundle.checks.some((c) =>
    c.check === 'host_receipt_required_check_pass' &&
    c.required_check === 'panel_public_key_public_only' &&
    c.ok === false
  ))
  assert.ok(bundle.checks.some((c) =>
    c.check === 'host_candidate_ignored' &&
    c.required_checks_pass === false
  ))
  assert.deepEqual(bundle.next_steps, [NEXT_STEP_HOLD])
  assert.ok(inspectBundleStatus({ outDir, agents: ['agent-one'] }).next_steps.some((s) => s.includes('panel_public_key_public_only')))
})

test('verify-only rechecks an existing bundle without live receipt builders', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))

  const liveBuilder = async () => {
    throw new Error('verify-only must not call live builders')
  }

  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    hostBuilder: liveBuilder,
    runtimeBuilder: liveBuilder,
    controlBuilder: liveBuilder,
  })

  assert.equal(bundle.status, 'pass')
  assert.equal(bundle.inputs.verify_only, true)
  assert.equal(bundle.inputs.skip_host, true)
  assert.equal(bundle.inputs.skip_runtime, true)
  assert.equal(bundle.inputs.skip_control, true)
  assert.equal(bundle.artifacts.cutover_gate.status, 'pass')
  assert.ok(bundle.checks.some((c) => c.check === 'host_receipt_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'runtime_receipts_reused' && c.ok === true))
  assert.ok(bundle.checks.some((c) => c.check === 'control_receipts_reused' && c.ok === true))

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.inputs.verify_only, true)
  assert.equal(manifest.artifacts.probes[0].sha256, sha256(join(outDir, 'probe-start.json')))
  assert.equal(manifest.artifacts.host.sha256, sha256(join(outDir, 'host.json')))
  assert.equal(manifest.artifacts.runtimes[0].sha256, sha256(join(outDir, 'runtime-agent-one.json')))
  assert.equal(manifest.artifacts.controls[0].sha256, sha256(join(outDir, 'control-start.json')))
  assert.equal(manifest.artifacts.cutover_gate.sha256, sha256(join(outDir, 'cutover-gate.json')))
  assert.ok(manifest.next_steps.some((s) => s.includes('attach manifest.json and cutover-gate.json')))
})

test('manifest check verifies copied bundle hashes without rewriting files', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const copiedDir = tmpDir()
  for (const name of readdirSync(outDir).filter((entry) => entry.endsWith('.json'))) {
    copyFileSync(join(outDir, name), join(copiedDir, name))
    chmodSync(join(copiedDir, name), 0o600)
  }

  const manifestPath = join(copiedDir, 'manifest.json')
  const before = readFileSync(manifestPath, 'utf8')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.receipt_type, 'mupot-fleet-receipt-bundle-check/v1')
  assert.equal(check.status, 'pass')
  assert.equal(check.manifest.sha256, sha256(manifestPath))
  assert.equal(readFileSync(manifestPath, 'utf8'), before)
  assert.ok(check.checks.some((c) => c.check === 'manifest_status_matches_checks' && c.ok === true))
  assert.ok(check.checks.some((c) => c.check === 'manifest_summary_matches_checks' && c.ok === true))
  assert.ok(check.checks.some((c) => c.check === 'next_steps_attach_when_ready' && c.ready === true && c.ok === true))
  assert.ok(check.checks.some((c) => c.check === 'next_steps_no_hold_when_ready' && c.ready === true && c.ok === true))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_sha256_match' &&
    c.artifact === 'host' &&
    c.checked_path === join(copiedDir, 'host.json') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_receipt_type_expected' &&
    c.artifact === 'cutover_gate' &&
    c.expected === 'mupot-sos-cutover-gate/v1' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_status_cutover_ready' &&
    c.artifact === 'host' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'selected_agents_recorded' &&
    c.agents.includes('agent-one') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'probe' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'runtime' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'probe_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_target_base_urls_match' &&
    c.base_urls.length === 1 &&
    c.base_urls[0] === POT_URL &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_target_tenants_match' &&
    c.tenants.length === 1 &&
    c.tenants[0] === POT_TENANT &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'runtime_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.expected_file === 'runtime-agent-one.json' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_agents_match_manifest' &&
    c.expected.includes('agent-one') &&
    c.actual.includes('agent-one') &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_required_control_verbs_match_manifest' &&
    c.expected.includes('start') &&
    c.expected.includes('stop') &&
    c.ok === true
  ))

  writeJson(join(copiedDir, 'host.json'), hostReceipt('fail'))
  const drift = checkBundleManifest({ manifestPath })

  assert.equal(drift.status, 'fail')
  assert.ok(drift.checks.some((c) =>
    c.check === 'artifact_sha256_match' &&
    c.artifact === 'host' &&
    c.checked_path === join(copiedDir, 'host.json') &&
    c.ok === false &&
    c.expected !== c.actual
  ))
  assert.ok(drift.checks.some((c) =>
    c.check === 'next_steps_no_attach_when_not_ready' &&
    c.ready === false &&
    c.ok === false
  ))
  assert.ok(drift.checks.some((c) =>
    c.check === 'next_steps_hold_when_not_ready' &&
    c.ready === false &&
    c.ok === false
  ))
})

test('export writes a clean self-contained attachable bundle', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })
  writeJson(join(outDir, 'daemon.json'), { note: 'operator working file, not evidence' })

  const exportDir = tmpDir()
  const receipt = exportBundle({ outDir, exportDir })

  assert.equal(receipt.receipt_type, 'mupot-fleet-receipt-bundle-export/v1')
  assert.equal(receipt.status, 'pass', JSON.stringify(receipt.checks.filter((check) => check.ok === false), null, 2))
  assert.equal(receipt.manifest_check.status, 'pass')
  assert.ok(receipt.artifacts.copied.some((artifact) => artifact.label === 'manifest'))
  assert.deepEqual(
    readdirSync(exportDir).sort(),
    [
      'control-start.json',
      'control-stop.json',
      'cutover-gate.json',
      'export-receipt.json',
      'host.json',
      'manifest-check.json',
      'manifest.json',
      'probe-start.json',
      'runtime-agent-one.json',
    ],
  )
  const exportReceiptText = readFileSync(join(exportDir, 'export-receipt.json'), 'utf8')
  const manifestCheckText = readFileSync(join(exportDir, 'manifest-check.json'), 'utf8')
  assert.equal(exportReceiptText.includes(outDir), false)
  assert.equal(exportReceiptText.includes(exportDir), false)
  assert.equal(manifestCheckText.includes(outDir), false)
  assert.equal(manifestCheckText.includes(exportDir), false)
  const exportReceipt = JSON.parse(readFileSync(join(exportDir, 'export-receipt.json'), 'utf8'))
  const manifestCheckReceipt = JSON.parse(readFileSync(join(exportDir, 'manifest-check.json'), 'utf8'))
  assert.equal(exportReceipt.receipt_type, 'mupot-fleet-receipt-bundle-export/v1')
  assert.equal(exportReceipt.status, 'pass')
  assert.equal(exportReceipt.manifest_check.status, 'pass')
  assert.equal(manifestCheckReceipt.receipt_type, 'mupot-fleet-receipt-bundle-check/v1')
  assert.equal(manifestCheckReceipt.status, 'pass')
  assert.equal(manifestCheckReceipt.manifest.sha256, sha256(join(exportDir, 'manifest.json')))
  const exportedManifestText = readFileSync(join(exportDir, 'manifest.json'), 'utf8')
  const exportedManifest = JSON.parse(exportedManifestText)
  assert.equal(exportedManifest.inputs.out_dir, '.')
  assert.equal(exportedManifest.artifacts.out_dir, '.')
  assert.equal(exportedManifest.artifacts.manifest, 'manifest.json')
  assert.equal(exportedManifest.artifacts.host.path, 'host.json')
  assert.equal(exportedManifest.artifacts.runtimes[0].path, 'runtime-agent-one.json')
  assert.equal(exportedManifest.artifacts.controls[0].path, 'control-start.json')
  assert.equal(exportedManifest.artifacts.host.receipt_type, 'mupot-fleet-host-receipt/v1')
  assert.equal(exportedManifestText.includes(outDir), false)
  assert.equal(existsSync(join(exportDir, 'daemon.json')), false)
  const copiedCheck = checkBundleManifest({ outDir: exportDir })
  assert.equal(copiedCheck.status, 'pass', JSON.stringify(copiedCheck.checks.filter((check) => check.ok === false), null, 2))
  assert.ok(copiedCheck.checks.some((c) =>
    c.check === 'export_sidecar_receipt_present' &&
    c.sidecar === 'export-receipt.json' &&
    c.ok === true
  ))
  assert.ok(copiedCheck.checks.some((c) =>
    c.check === 'export_sidecar_manifest_hash_matches' &&
    c.sidecar === 'manifest-check.json' &&
    c.ok === true
  ))
  assert.ok(copiedCheck.checks.some((c) =>
    c.check === 'export_sidecar_summary_matches_checks' &&
    c.sidecar === 'export-receipt.json' &&
    c.ok === true
  ))
  assert.ok(copiedCheck.checks.some((c) =>
    c.check === 'export_sidecar_summary_matches_checks' &&
    c.sidecar === 'manifest-check.json' &&
    c.ok === true
  ))
  const exportSidecarPath = join(exportDir, 'export-receipt.json')
  const exportSidecar = JSON.parse(readFileSync(exportSidecarPath, 'utf8'))
  exportSidecar.fabricated = true
  writeJson(exportSidecarPath, exportSidecar)
  const tamperedSidecar = checkBundleManifest({ outDir: exportDir })
  assert.equal(tamperedSidecar.status, 'fail')
  assert.ok(tamperedSidecar.checks.some((check) => check.check === 'export_sidecar_receipt_json_read' && check.sidecar === 'export-receipt.json' && check.ok === false))
  assert.equal(checkBundleManifest({ outDir }).status, 'fail')
})

test('manifest check fails when exported bundle sidecar receipts are missing', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const exportDir = tmpDir()
  const exported = exportBundle({ outDir, exportDir })
  assert.equal(exported.status, 'pass', JSON.stringify(exported.checks.filter((check) => check.ok === false), null, 2))
  rmSync(join(exportDir, 'export-receipt.json'))

  const check = checkBundleManifest({ outDir: exportDir })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'export_sidecar_receipt_present' &&
    c.sidecar === 'export-receipt.json' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'export_sidecar_receipt_present' &&
    c.sidecar === 'manifest-check.json' &&
    c.ok === true
  ))
})

test('manifest check fails when host receipt lacks public-only panel key evidence', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const hostPath = join(outDir, 'host.json')
  writeJson(hostPath, hostReceipt('pass', { checks: [] }))
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.host.sha256 = sha256(hostPath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_status_cutover_ready' &&
    c.artifact === 'host' &&
    c.ok === true
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'host_receipt_required_check_pass' &&
    c.artifact === 'host' &&
    c.required_check === 'panel_public_key_public_only' &&
    c.ok === false
  ))
})

test('manifest check fails when copied bundle is not self-contained', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const copiedDir = tmpDir()
  copyFileSync(join(outDir, 'manifest.json'), join(copiedDir, 'manifest.json'))
  const manifestPath = join(copiedDir, 'manifest.json')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_file_readable' &&
    c.artifact === 'host' &&
    c.ok === true &&
    c.checked_path === join(outDir, 'host.json')
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_file_in_bundle_dir' &&
    c.artifact === 'host' &&
    c.expected_path === join(copiedDir, 'host.json') &&
    c.ok === false
  ))

  const status = inspectBundleStatus({ outDir: copiedDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) =>
    c.check === 'copied_bundle_only_manifest_artifacts' &&
    c.ok === false &&
    c.failed > 0
  ))
  assert.ok(status.next_steps.some((step) => step.includes('copy only manifest.json')))
})

test('manifest check fails when copied bundle contains extra files', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  writeJson(join(outDir, 'daemon.json'), { base_url: POT_URL, token: 'redacted' })
  const manifestPath = join(outDir, 'manifest.json')
  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'bundle_directory_only_manifest_artifacts' &&
    c.ok === false &&
    c.unexpected.includes('daemon.json')
  ))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.next_steps.some((step) => step.includes('copy only manifest.json')))
})

test('manifest check fails when copied bundle contains secret material', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const rawSecret = 'Bearer mupot_host_secret_abcdefghijklmnopqrstuvwxyz'
  const runtimePath = join(outDir, 'runtime-agent-one.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.leaked = {
    authorization: rawSecret,
    privateKey: { kty: 'OKP', d: 'private-scalar' },
  }
  writeJson(runtimePath, runtime)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.runtimes[0].sha256 = sha256(runtimePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_no_secret_material' &&
    c.artifact === 'runtime:1' &&
    c.ok === false &&
    c.finding_count >= 2 &&
    c.findings.some((finding) => finding.reason === 'bearer_token') &&
    c.findings.some((finding) => finding.reason === 'jwk_private_key')
  ))
  assert.equal(JSON.stringify(check).includes(rawSecret), false)

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) =>
    c.check === 'copied_bundle_no_secret_material' &&
    c.ok === false &&
    c.failed > 0
  ))
  assert.ok(status.next_steps.some((step) => step.includes('redact secret material')))
})

test('status reports a complete host-go bundle as pass', async () => {
  const outDir = tmpDir()
  const installPath = writeJson(join(tmpDir(), 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    installReceiptPath: installPath,
    verifyOnly: true,
  })

  const status = inspectBundleStatus({ outDir })

  assert.equal(status.receipt_type, 'mupot-fleet-receipt-bundle-status/v1')
  assert.equal(status.status, 'pass')
  assert.deepEqual(status.inputs.agents, ['agent-one'])
  assert.deepEqual(status.inputs.required_control_verbs, ['start', 'stop'])
  assert.equal(status.manifest_check.status, 'pass')
  assert.equal(status.artifacts.install.receipt_type, 'mupot-fleet-install-receipt/v1')
  assert.equal(status.artifacts.cutover_gate.status, 'pass')
  assert.equal(status.host_go_checklist.every((item) => item.status === 'pass'), true)
  assert.equal(checklistById(status, 'selected_agents_named').agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'attachable_manifest_check_passed').manifest_check_status, 'pass')
  assert.equal(checklistById(status, 'attachable_bundle_safe').secret_scan_passed, true)
  assert.equal(checklistById(status, 'attachable_bundle_safe').directory_scope_passed, true)
  assert.ok(status.checks.some((c) => c.check === 'manifest_check_pass' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'copied_bundle_no_secret_material' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'copied_bundle_only_manifest_artifacts' && c.ok === true))
  assert.ok(status.next_steps.some((s) => s.includes('SOS removal is permitted only for the proven agent')))
})

test('status reports missing host-go evidence and next steps for a partial bundle', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt())

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })
  const summary = formatStatusSummary(status)

  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) => c.check === 'host_receipt_pass' && c.ok === true))
  assert.ok(status.checks.some((c) => c.check === 'install_receipt_present' && c.ok === false))
  assert.ok(status.checks.some((c) => c.check === 'probe_receipt_pass_present' && c.ok === false))
  assert.ok(status.checks.some((c) =>
    c.check === 'runtime_receipt_pass_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.ok === false
  ))
  assert.ok(status.checks.some((c) => c.check === 'manifest_check_pass' && c.ok === false))
  assert.equal(checklistById(status, 'bundle_directory_ready').status, 'pass')
  assert.equal(checklistById(status, 'install_receipt_saved').status, 'fail')
  assert.equal(checklistById(status, 'probe_receipts_passed_for_agents').missing_agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'runtime_receipts_passed_for_agents').missing_agents.includes('agent-one'), true)
  assert.equal(checklistById(status, 'control_receipts_passed_for_required_verbs').missing.includes('agent-one:start'), true)
  assert.equal(checklistById(status, 'control_receipts_passed_for_required_verbs').missing.includes('agent-one:stop'), true)
  assert.equal(checklistById(status, 'attachable_manifest_check_passed').status, 'fail')
  assert.equal(checklistById(status, 'attachable_bundle_safe').status, 'fail')
  assert.ok(summary.includes('Host-go status: fail'))
  assert.ok(summary.includes('[PASS] bundle_directory_ready'))
  assert.ok(summary.includes('[FAIL] install_receipt_saved'))
  assert.ok(summary.includes('missing: agent-one:start, agent-one:stop'))
  assert.ok(summary.includes('Next steps:'))
  assert.ok(status.next_steps.some((s) => s.includes('save installer output')))
  assert.ok(status.next_steps.some((s) => s.includes('queue inbox and lifecycle inputs')))
  assert.ok(status.next_steps.some((s) => s.includes('runtime-agent-one.json')))
  assert.ok(status.next_steps.some((s) => s.includes('do not remove SOS wiring yet')))
})

test('status reports stale host receipt missing public-only panel key evidence', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'host.json'), hostReceipt('pass', { checks: [] }))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })

  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) => c.check === 'host_receipt_pass' && c.ok === true))
  assert.ok(status.checks.some((c) =>
    c.check === 'host_receipt_required_check_pass' &&
    c.required_check === 'panel_public_key_public_only' &&
    c.ok === false
  ))
  assert.equal(checklistById(status, 'host_receipt_passed').status, 'fail')
  assert.ok(status.next_steps.some((s) => s.includes('panel_public_key_public_only')))
})

test('status reports missing lifecycle control verbs before the gate is rebuilt', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })

  assert.equal(status.status, 'fail')
  assert.ok(status.checks.some((c) => c.check === 'control_receipt_pass_present' && c.ok === true))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'start' &&
    c.matched_verb === 'start' &&
    c.ok === true
  ))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'stop' &&
    c.evidence_verbs.includes('start') &&
    c.ok === false
  ))
  assert.ok(status.next_steps.some((s) => s.includes('agent-one:stop')))
})

test('status treats restart control receipts as start and stop evidence', () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'install.json'), installReceipt())
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-restart.json'), controlReceipt('agent-one', 'restart'))

  const status = inspectBundleStatus({ outDir, agents: ['agent-one'] })

  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'start' &&
    c.matched_verb === 'restart' &&
    c.ok === true
  ))
  assert.ok(status.checks.some((c) =>
    c.check === 'control_verb_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.required_verb === 'stop' &&
    c.matched_verb === 'restart' &&
    c.ok === true
  ))
  assert.ok(!status.next_steps.some((s) => s.includes('queue missing lifecycle control evidence')))
})

test('manifest check fails when next_steps contradict readiness', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.next_steps = ['do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass']
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'next_steps_attach_when_ready' &&
    c.ready === true &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'next_steps_no_hold_when_ready' &&
    c.ready === true &&
    c.ok === false
  ))
})

test('manifest check enforces a closed ordered next_steps policy', async () => {
  const outDir = tmpDir()
  seedCutoverEvidence(outDir)
  await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true })
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.next_steps.push('leave SOS wiring installed forever')
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ outDir })
  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((entry) => entry.check.startsWith('next_steps_') && entry.ok === false))
})

test('manifest check rejects instructions before the sole non-ready hold step', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true })
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.next_steps = ['remove SOS wiring now despite the failed gate', NEXT_STEP_HOLD]
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ outDir })
  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((entry) => entry.check === 'next_steps_exact_policy' && entry.ok === false))
})

test('legacy SOS-only manifest check preserves the pre-Task-7 check surface', async () => {
  const outDir = tmpDir()
  seedCutoverEvidence(outDir)
  const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true })
  const check = checkBundleManifest({ outDir })

  assert.equal(Object.hasOwn(bundle.inputs, 'bundle_mode'), false)
  assert.equal(Object.hasOwn(bundle.artifacts, 'service'), false)
  assert.equal(
    check.checks.some((entry) => ['bundle_mode_valid', 'bundle_mode_matches_artifacts', 'artifact_role_paths_unique', 'manifest_schema_exact', 'manifest_permissions_0600', 'artifact_permissions_0600', 'bundle_directory_permissions_0700', 'next_steps_exact_policy'].includes(entry.check)),
    false,
    JSON.stringify(check.checks.filter((entry) => ['bundle_mode_valid', 'bundle_mode_matches_artifacts', 'artifact_role_paths_unique', 'manifest_schema_exact', 'manifest_permissions_0600', 'artifact_permissions_0600', 'bundle_directory_permissions_0700', 'next_steps_exact_policy'].includes(entry.check)), null, 2),
  )
})

test('manifest checking fails closed for malformed arrays and unknown artifact roles without throwing', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.probes = { fabricated: true }
  manifest.artifacts.unknown_role = { path: 'unknown.json', sha256: 'a'.repeat(64), receipt_type: 'unknown/v1', status: 'pass' }
  manifest.provenance = {}
  writeJson(manifestPath, manifest)

  let check
  assert.doesNotThrow(() => { check = checkBundleManifest({ outDir }) })
  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((entry) => entry.check === 'manifest_schema_exact' && entry.ok === false))
})

test('manifest checking fails closed for malformed portable projection entries without throwing', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.provenance = {
    schema: 'mupot-fleet-portable-provenance/v1',
    source_path: 'provenance/outer_manifest/manifest.json',
    source_sha256: 'a'.repeat(64),
    projections: [null],
  }
  writeJson(manifestPath, manifest)

  let check
  assert.doesNotThrow(() => { check = checkBundleManifest({ outDir }) })
  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((entry) => entry.check === 'manifest_schema_exact' && entry.ok === false))
})

test('bundle and export permissions are repaired and permissive drift fails verification', async () => {
  const outDir = tmpDir()
  const sources = starterPaths()
  seedStarterEvidence(outDir, sources)
  chmodSync(outDir, 0o755)
  chmodSync(join(outDir, 'host.json'), 0o644)
  await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, force: true, ...sources })
  assert.equal(statSync(outDir).mode & 0o777, 0o700)
  for (const name of readdirSync(outDir).filter((entry) => entry.endsWith('.json'))) {
    assert.equal(statSync(join(outDir, name)).mode & 0o777, 0o600, name)
  }

  chmodSync(join(outDir, 'host.json'), 0o644)
  const check = checkBundleManifest({ outDir })
  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((entry) => entry.check === 'artifact_permissions_0600' && entry.ok === false))
})

test('starter packaging creates safe nested parents and force repairs reused support files', async (t) => {
  await t.test('non-force rejects a permissive existing parent without mutation', async () => {
    const outDir = tmpDir()
    const sources = nestStarterSources(starterPaths())
    seedStarterEvidence(outDir, sources)
    mkdirSync(join(outDir, 'evidence'), { mode: 0o755 })
    chmodSync(join(outDir, 'evidence'), 0o755)

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(bundle.status, 'fail')
    assert.equal(statSync(join(outDir, 'evidence')).mode & 0o777, 0o755)
    assert.equal(existsSync(join(outDir, 'evidence', 'install.json')), false)
  })

  await t.test('nested relative support paths', async () => {
    const outDir = tmpDir()
    const sources = nestStarterSources(starterPaths())
    seedStarterEvidence(outDir, sources)

    const first = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    assert.equal(first.status, 'pass', JSON.stringify(first.checks.filter((check) => check.ok === false), null, 2))
    assert.equal(statSync(join(outDir, 'manifest', 'starter.example.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(outDir, 'evidence', 'install.json')).mode & 0o777, 0o600)
    const sourceCheck = checkBundleManifest({ outDir })
    assert.equal(sourceCheck.status, 'pass', JSON.stringify(sourceCheck.checks.filter((check) => check.ok === false), null, 2))

    chmodSync(join(outDir, 'evidence'), 0o755)
    const permissiveDirectoryCheck = checkBundleManifest({ outDir })
    assert.equal(permissiveDirectoryCheck.status, 'fail')
    assert.ok(permissiveDirectoryCheck.checks.some((check) => check.check === 'starter_directory_permissions_0700' && check.ok === false))
    chmodSync(join(outDir, 'evidence'), 0o700)

    const exportDir = tmpDir()
    const exported = exportBundle({ outDir, exportDir })
    assert.equal(exported.status, 'pass', JSON.stringify(exported.checks.filter((check) => check.ok === false), null, 2))
    const exportCheck = checkBundleManifest({ outDir: exportDir })
    assert.equal(exportCheck.status, 'pass', JSON.stringify(exportCheck.checks.filter((check) => check.ok === false), null, 2))

    chmodSync(join(outDir, 'evidence', 'install.json'), 0o644)
    chmodSync(join(outDir, 'evidence'), 0o755)
    const repaired = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, force: true, ...sources })
    assert.equal(repaired.status, 'pass', JSON.stringify(repaired.checks.filter((check) => check.ok === false), null, 2))
    assert.equal(statSync(join(outDir, 'evidence', 'install.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(outDir, 'evidence')).mode & 0o777, 0o700)
  })

  await t.test('symlinked nested parent', async () => {
    const outDir = tmpDir()
    const external = tmpDir()
    const sources = nestStarterSources(starterPaths())
    seedStarterEvidence(outDir, sources)
    symlinkSync(external, join(outDir, 'evidence'), 'dir')

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, force: true, ...sources })
    assert.equal(bundle.status, 'fail')
    assert.deepEqual(readdirSync(external), [])
  })
})

test('manifest verification rejects symlinked artifact files and bundle directories', async (t) => {
  await t.test('artifact file symlink', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    seedStarterEvidence(outDir, sources)
    await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    const hostPath = join(outDir, 'host.json')
    const external = join(tmpDir(), 'external-host.json')
    copyFileSync(hostPath, external)
    chmodSync(external, 0o600)
    rmSync(hostPath)
    symlinkSync(external, hostPath)

    const check = checkBundleManifest({ outDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'artifact_regular_file' && entry.artifact === 'host' && entry.ok === false))
  })

  await t.test('bundle directory symlink', async () => {
    const realDir = tmpDir()
    seedCutoverEvidence(realDir)
    await buildBundle({ outDir: realDir, agents: ['agent-one'], verifyOnly: true })
    const parent = tmpDir()
    const alias = join(parent, 'bundle-link')
    symlinkSync(realDir, alias, 'dir')

    const check = checkBundleManifest({ outDir: alias })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'bundle_directory_regular' && entry.ok === false))
  })
})

test('force and export reject symlink attacks without touching external targets', async (t) => {
  await t.test('force output file symlink', async () => {
    const outDir = tmpDir()
    writeJson(join(outDir, 'probe-start.json'), probeReceipt())
    writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
    writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
    writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
    const victim = join(tmpDir(), 'victim.json')
    const original = '{"do_not_touch":true}\n'
    writeFileSync(victim, original)
    symlinkSync(victim, join(outDir, 'host.json'))

    const bundle = await buildBundle({
      outDir,
      agents: ['agent-one'],
      force: true,
      skipRuntime: true,
      skipControl: true,
      hostBuilder: async () => hostReceipt(),
    })
    assert.equal(bundle.status, 'fail')
    assert.equal(readFileSync(victim, 'utf8'), original)
    assert.equal(lstatSync(join(outDir, 'host.json')).isSymbolicLink(), true)
  })

  await t.test('starter include source symlink', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    seedStarterEvidence(outDir, sources)
    const alias = join(sources.sourceDir, 'service-link.json')
    symlinkSync(sources.serviceReceiptPath, alias)
    sources.serviceReceiptPath = alias

    const bundle = await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, force: true, ...sources })
    assert.equal(bundle.status, 'fail')
    assert.ok(bundle.checks.some((entry) => entry.check === 'service_receipt_read' && entry.ok === false))
  })

  await t.test('export directory symlink', async () => {
    const outDir = tmpDir()
    seedCutoverEvidence(outDir)
    await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true })
    const external = tmpDir()
    const alias = join(tmpDir(), 'export-link')
    symlinkSync(external, alias, 'dir')

    const receipt = exportBundle({ outDir, exportDir: alias, force: true })
    assert.equal(receipt.status, 'fail')
    assert.deepEqual(readdirSync(external), [])
  })
})

test('recursive artifact and sidecar schemas reject unknown nested fields', async (t) => {
  await t.test('legacy runtime nested field', async () => {
    const outDir = tmpDir()
    seedCutoverEvidence(outDir)
    await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true })
    const runtimePath = join(outDir, 'runtime-agent-one.json')
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    runtime.target.fabricated = true
    writeJson(runtimePath, runtime)
    const manifestPath = join(outDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.artifacts.runtimes[0].sha256 = sha256(runtimePath)
    writeJson(manifestPath, manifest)

    const check = checkBundleManifest({ outDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'artifact_receipt_schema_exact' && entry.artifact === 'runtime:1' && entry.ok === false))
  })

  await t.test('starter export copied entry and check record fields', async () => {
    const outDir = tmpDir()
    const sources = starterPaths()
    seedStarterEvidence(outDir, sources)
    await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    const exportDir = tmpDir()
    const exportReceipt = exportBundle({ outDir, exportDir })
    assert.equal(exportReceipt.status, 'pass', JSON.stringify(exportReceipt.checks.filter((check) => check.ok === false), null, 2))

    const exportPath = join(exportDir, 'export-receipt.json')
    const exportSidecar = JSON.parse(readFileSync(exportPath, 'utf8'))
    exportSidecar.artifacts.copied[0].fabricated = true
    writeJson(exportPath, exportSidecar)
    let check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_schema_exact' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const nestedExport = JSON.parse(readFileSync(exportPath, 'utf8'))
    nestedExport.artifacts.sidecars[0].fabricated = true
    nestedExport.manifest_check.summary.fabricated = true
    writeJson(exportPath, nestedExport)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_schema_exact' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const checkPath = join(exportDir, 'manifest-check.json')
    const checkSidecar = JSON.parse(readFileSync(checkPath, 'utf8'))
    checkSidecar.checks[0].fabricated = true
    writeJson(checkPath, checkSidecar)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_schema_exact' && entry.sidecar === 'manifest-check.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const substitutedManifestCheck = JSON.parse(readFileSync(checkPath, 'utf8'))
    substitutedManifestCheck.checks[0] = { ...substitutedManifestCheck.checks[1] }
    writeJson(checkPath, substitutedManifestCheck)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'manifest-check.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const traversingManifestCheck = JSON.parse(readFileSync(checkPath, 'utf8'))
    const manifestPathCheck = traversingManifestCheck.checks.find((entry) => entry.path === 'manifest.json')
    manifestPathCheck.path = '../manifest.json'
    writeJson(checkPath, traversingManifestCheck)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'manifest-check.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const incompleteExport = JSON.parse(readFileSync(exportPath, 'utf8'))
    incompleteExport.artifacts.copied.pop()
    writeJson(exportPath, incompleteExport)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const substitutedExportCheck = JSON.parse(readFileSync(exportPath, 'utf8'))
    substitutedExportCheck.checks.find((entry) => entry.check === 'source_manifest_selected').path = 'fabricated.json'
    writeJson(exportPath, substitutedExportCheck)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const reorderedCopied = JSON.parse(readFileSync(exportPath, 'utf8'))
    ;[reorderedCopied.artifacts.copied[1], reorderedCopied.artifacts.copied[2]] = [reorderedCopied.artifacts.copied[2], reorderedCopied.artifacts.copied[1]]
    writeJson(exportPath, reorderedCopied)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const fabricatedSupportMeta = JSON.parse(readFileSync(exportPath, 'utf8'))
    const supportCopy = fabricatedSupportMeta.artifacts.copied.find((entry) => entry.label === 'definition:heartbeat')
    supportCopy.receipt_type = 'fabricated/v1'
    supportCopy.status = 'pass'
    writeJson(exportPath, fabricatedSupportMeta)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const reorderedSidecars = JSON.parse(readFileSync(exportPath, 'utf8'))
    reorderedSidecars.artifacts.sidecars.reverse()
    writeJson(exportPath, reorderedSidecars)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))

    assert.equal(exportBundle({ outDir, exportDir, force: true }).status, 'pass')
    const duplicatedSidecar = JSON.parse(readFileSync(exportPath, 'utf8'))
    duplicatedSidecar.artifacts.sidecars[1] = { ...duplicatedSidecar.artifacts.sidecars[0] }
    writeJson(exportPath, duplicatedSidecar)
    check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'export_sidecar_semantics_complete' && entry.sidecar === 'export-receipt.json' && entry.ok === false))
  })
})

test('portable checker rejects source and projection chain tampering', async (t) => {
  async function exportedStarterBundle() {
    const outDir = tmpDir()
    const sources = starterPaths()
    seedStarterEvidence(outDir, sources)
    await buildBundle({ outDir, agents: ['agent-one'], verifyOnly: true, ...sources })
    const exportDir = tmpDir()
    const exportReceipt = exportBundle({ outDir, exportDir })
    assert.equal(exportReceipt.status, 'pass', JSON.stringify(exportReceipt.checks.filter((check) => check.ok === false), null, 2))
    return exportDir
  }

  await t.test('source digest mapping mismatch', async () => {
    const exportDir = await exportedStarterBundle()
    const servicePath = join(exportDir, 'service.json')
    const projection = JSON.parse(readFileSync(servicePath, 'utf8'))
    projection.source_sha256 = '9'.repeat(64)
    writeJson(servicePath, projection)
    const manifestPath = join(exportDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.artifacts.service.sha256 = sha256(servicePath)
    manifest.provenance.projections.find((entry) => entry.role === 'service').artifact_sha256 = sha256(servicePath)
    writeJson(manifestPath, manifest)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'projection_chain_valid' && entry.artifact === 'service' && entry.ok === false))
  })

  await t.test('projection content digest mismatch', async () => {
    const exportDir = await exportedStarterBundle()
    const continuousPath = join(exportDir, 'continuous.json')
    const projection = JSON.parse(readFileSync(continuousPath, 'utf8'))
    projection.content.observation.heartbeat.tick.after += 1
    writeJson(continuousPath, projection)
    const manifestPath = join(exportDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.artifacts.continuous.sha256 = sha256(continuousPath)
    manifest.provenance.projections.find((entry) => entry.role === 'continuous').artifact_sha256 = sha256(continuousPath)
    writeJson(manifestPath, manifest)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'projection_content_sha256_match' && entry.artifact === 'continuous' && entry.ok === false))
  })

  await t.test('retained source preimage tampering', async () => {
    const exportDir = await exportedStarterBundle()
    const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'))
    const mapping = manifest.provenance.projections.find((entry) => entry.role === 'service')
    const sourcePath = join(exportDir, mapping.source_path)
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
    source.generated_at = '2026-07-13T23:59:59.000Z'
    writeJson(sourcePath, source)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_source_sha256_match' && entry.artifact === 'service' && entry.ok === false))
    assert.ok(check.checks.some((entry) => entry.check === 'projection_derived_from_retained_source' && entry.artifact === 'service' && entry.ok === false))
  })

  await t.test('coordinated source hash fields cannot replace projection derivation', async () => {
    const exportDir = await exportedStarterBundle()
    const manifestPath = join(exportDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const mapping = manifest.provenance.projections.find((entry) => entry.role === 'service')
    const sourcePath = join(exportDir, mapping.source_path)
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
    source.generated_at = '2026-07-13T23:59:58.000Z'
    writeJson(sourcePath, source)
    const changedSourceSha = sha256(sourcePath)
    mapping.source_sha256 = changedSourceSha
    const wrapperPath = join(exportDir, mapping.path)
    const wrapper = JSON.parse(readFileSync(wrapperPath, 'utf8'))
    wrapper.source_sha256 = changedSourceSha
    writeJson(wrapperPath, wrapper)
    mapping.artifact_sha256 = sha256(wrapperPath)
    manifest.artifacts.service.sha256 = mapping.artifact_sha256
    writeJson(manifestPath, manifest)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'projection_derived_from_retained_source' && entry.artifact === 'service' && entry.ok === false))
  })

  await t.test('coordinated definition replacement remains anchored to original source receipts', async () => {
    const exportDir = await exportedStarterBundle()
    const manifestPath = join(exportDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const mapping = manifest.provenance.projections.find((entry) => entry.role === 'service_definition_heartbeat')
    const sourcePath = join(exportDir, mapping.source_path)
    const changedDefinition = '[Service]\nExecStart=changed-heartbeat\n'
    writeFileSync(sourcePath, changedDefinition)

    const sourceSha = sha256(sourcePath)
    const content = { encoding: 'base64', data: Buffer.from(changedDefinition).toString('base64') }
    const projectionSha = digest(`${JSON.stringify(content, null, 2)}\n`)
    const wrapper = {
      receipt_type: 'mupot-fleet-portable-projection/v1',
      role: mapping.role,
      source_receipt_type: mapping.source_receipt_type,
      source_path: mapping.source_path,
      source_sha256: sourceSha,
      projection_sha256: projectionSha,
      content,
    }
    const wrapperPath = join(exportDir, mapping.path)
    writeJson(wrapperPath, wrapper)
    mapping.source_sha256 = sourceSha
    mapping.projection_sha256 = projectionSha
    mapping.artifact_sha256 = sha256(wrapperPath)
    writeJson(manifestPath, manifest)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_source_digest_graph_valid' && entry.ok === false))
  })

  await t.test('malformed retained outer manifest fails closed without throwing', async () => {
    const exportDir = await exportedStarterBundle()
    const manifestPath = join(exportDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const sourcePath = join(exportDir, manifest.provenance.source_path)
    writeJson(sourcePath, {})
    manifest.provenance.source_sha256 = sha256(sourcePath)
    writeJson(manifestPath, manifest)

    let check
    assert.doesNotThrow(() => { check = checkBundleManifest({ outDir: exportDir }) })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_source_manifest_schema_exact' && entry.ok === false))
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_source_digest_graph_valid' && entry.ok === false))
  })

  await t.test('symlinked retained preimage is rejected', async () => {
    const exportDir = await exportedStarterBundle()
    const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'))
    const mapping = manifest.provenance.projections.find((entry) => entry.role === 'service')
    const sourcePath = join(exportDir, mapping.source_path)
    const external = join(tmpDir(), 'service-source.json')
    copyFileSync(sourcePath, external)
    rmSync(sourcePath)
    symlinkSync(external, sourcePath)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_source_sha256_match' && entry.artifact === 'service' && entry.ok === false))
  })

  await t.test('permissive provenance directory mode is rejected', async () => {
    const exportDir = await exportedStarterBundle()
    const manifest = JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8'))
    const mapping = manifest.provenance.projections.find((entry) => entry.role === 'service')
    chmodSync(dirname(join(exportDir, mapping.source_path)), 0o755)

    const check = checkBundleManifest({ outDir: exportDir })
    assert.equal(check.status, 'fail')
    assert.ok(check.checks.some((entry) => entry.check === 'provenance_role_directory_exact' && entry.artifact === 'service' && entry.ok === false))
  })
})

test('manifest check fails when cutover gate inputs disagree with manifest evidence', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const gatePath = join(outDir, 'cutover-gate.json')
  const gate = JSON.parse(readFileSync(gatePath, 'utf8'))
  gate.inputs.agents = ['other-agent']
  gate.inputs.required_control_verbs = ['restart']
  gate.inputs.runtime_receipts = []
  writeJson(gatePath, gate)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.cutover_gate.sha256 = sha256(gatePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_agents_match_manifest' &&
    c.expected.includes('agent-one') &&
    c.actual.includes('other-agent') &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_required_control_verbs_match_manifest' &&
    c.expected.includes('start') &&
    c.actual.includes('restart') &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'cutover_gate_runtime_artifacts_match_manifest' &&
    c.expected.includes('runtime-agent-one.json') &&
    c.actual.length === 0 &&
    c.ok === false
  ))
})

test('manifest check fails when required evidence categories are missing', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.probes = []
  manifest.artifacts.host = null
  manifest.artifacts.runtimes = []
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'probe' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'host' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'required_artifact_present' &&
    c.artifact === 'runtime' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'runtime_artifact_for_agent' &&
    c.agent_id === 'agent-one' &&
    c.expected_file === 'runtime-agent-one.json' &&
    c.ok === false
  ))
})

test('manifest check fails when manifest status or summary disagrees with recorded checks', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const selected = manifest.checks.find((check) => check.check === 'host_candidate_selected')
  selected.ok = false
  manifest.status = 'pass'
  manifest.summary = { status: 'pass', passed: 999, failed: 0, warnings: 0 }
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'manifest_status_matches_checks' &&
    c.expected === 'fail' &&
    c.actual === 'pass' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'manifest_summary_matches_checks' &&
    c.expected.status === 'fail' &&
    c.actual.status === 'pass' &&
    c.ok === false
  ))
})

test('manifest check fails when manifest metadata disagrees with artifact content', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.host.status = 'warn'
  manifest.artifacts.host.receipt_type = 'wrong-receipt/v1'
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })

  assert.equal(check.status, 'fail')
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_receipt_type_matches_manifest' &&
    c.artifact === 'host' &&
    c.expected === 'wrong-receipt/v1' &&
    c.actual === 'mupot-fleet-host-receipt/v1' &&
    c.ok === false
  ))
  assert.ok(check.checks.some((c) =>
    c.check === 'artifact_status_matches_manifest' &&
    c.artifact === 'host' &&
    c.expected === 'warn' &&
    c.actual === 'pass' &&
    c.ok === false
  ))
})

test('manifest check fails when receipt target identity mixes pots', async () => {
  const outDir = tmpDir()
  writeJson(join(outDir, 'probe-start.json'), probeReceipt())
  writeJson(join(outDir, 'host.json'), hostReceipt())
  writeJson(join(outDir, 'runtime-agent-one.json'), runtimeReceipt('agent-one'))
  writeJson(join(outDir, 'control-start.json'), controlReceipt('agent-one', 'start'))
  writeJson(join(outDir, 'control-stop.json'), controlReceipt('agent-one', 'stop'))
  await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
  })

  const runtimePath = join(outDir, 'runtime-agent-one.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.target.base_url = 'https://staging-pot.example.org'
  writeJson(runtimePath, runtime)

  const manifestPath = join(outDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.artifacts.runtimes[0].sha256 = sha256(runtimePath)
  writeJson(manifestPath, manifest)

  const check = checkBundleManifest({ manifestPath })
  const mismatch = check.checks.find((c) => c.check === 'artifact_target_base_urls_match')

  assert.equal(check.status, 'fail')
  assert.equal(mismatch.ok, false)
  assert.deepEqual(mismatch.base_urls, [POT_URL, 'https://staging-pot.example.org'].sort())
})

test('receipt bundle fails when the final cutover gate lacks stop evidence', async () => {
  const outDir = tmpDir()
  const probePath = writeJson(join(tmpDir(), 'start-probe.json'), probeReceipt())
  const bundle = await buildBundle({
    outDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    probeReceiptPaths: [probePath],
    controlLabel: 'start',
    hostBuilder: async () => hostReceipt(),
    runtimeBuilder: async (opts) => runtimeReceipt(opts.agents[0]),
    controlBuilder: async () => controlReceipt('agent-one', 'start'),
  })

  assert.equal(bundle.status, 'fail')
  assert.ok(bundle.checks.some((c) => c.check === 'cutover_gate_status_pass' && c.ok === false && c.actual === 'fail'))
  assert.deepEqual(bundle.next_steps, [NEXT_STEP_HOLD])
  assert.ok(inspectBundleStatus({ outDir, agents: ['agent-one'] }).next_steps.some((s) => s.includes('agent-one:stop')))
  const gate = JSON.parse(readFileSync(join(outDir, 'cutover-gate.json'), 'utf8'))
  assert.ok(gate.checks.some((c) => c.check === 'control_verb_for_agent' && c.required_verb === 'stop' && c.ok === false))
})

test('parseArgs accepts bundle controls and safe filenames', () => {
  const opts = parseArgs([
    '--agent', 'agent-one,agent-two',
    '--out-dir', './receipts',
    '--daemon', './daemon.json',
    '--inbox', './inbox.json',
    '--control', './control.json',
    '--install-receipt', './install.json',
    '--probe-receipt', './probe-start.json,./probe-stop.json',
    '--control-label', 'start/pass',
    '--require-control-verb', 'restart',
    '--skip-host',
    '--skip-runtime',
    '--skip-control',
    '--exec-probes',
    '--force',
  ])

  assert.deepEqual(opts.agents, ['agent-one', 'agent-two'])
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.installReceiptPath.endsWith('/install.json'))
  assert.equal(opts.probeReceiptPaths.length, 2)
  assert.ok(opts.probeReceiptPaths[0].endsWith('/probe-start.json'))
  assert.ok(opts.probeReceiptPaths[1].endsWith('/probe-stop.json'))
  assert.equal(opts.controlLabel, 'start_pass')
  assert.deepEqual(opts.requiredControlVerbs, ['restart'])
  assert.equal(opts.skipHost, true)
  assert.equal(opts.skipRuntime, true)
  assert.equal(opts.skipControl, true)
  assert.equal(opts.execProbes, true)
  assert.equal(opts.force, true)
  assert.equal(safeName('a/b c'), 'a_b_c')
})

test('parseArgs accepts one receipt per starter-ready artifact role', () => {
  const opts = parseArgs([
    '--agent', 'agent-one',
    '--service-receipt', './service.json',
    '--continuous-receipt', './continuous.json',
    '--starter-receipt', './starter.json',
  ])

  assert.ok(opts.serviceReceiptPath.endsWith('/service.json'))
  assert.ok(opts.continuousReceiptPath.endsWith('/continuous.json'))
  assert.ok(opts.starterReceiptPath.endsWith('/starter.json'))
})

test('parseArgs rejects contradictory starter modes and duplicate artifact roles', () => {
  assert.throws(
    () => parseArgs(['--service-receipt', './service-a.json', '--service-receipt', './service-b.json']),
    /duplicate --service-receipt/,
  )
  assert.throws(
    () => parseArgs(['--service-receipt', './same.json', '--continuous-receipt', './same.json']),
    /artifact roles require distinct receipt paths/,
  )
  assert.throws(
    () => parseArgs(['--service-receipt', './service.json', '--continuous-receipt', './continuous.json', '--starter-receipt', './starter.json', '--status']),
    /starter receipt flags cannot be combined with read-only or plan modes/,
  )
})

test('parseArgs expands --verify-only to read-only reuse flags', () => {
  const opts = parseArgs(['--agent', 'agent-one', '--verify-only'])

  assert.deepEqual(opts.agents, ['agent-one'])
  assert.equal(opts.verifyOnly, true)
  assert.equal(opts.skipHost, true)
  assert.equal(opts.skipRuntime, true)
  assert.equal(opts.skipControl, true)
})

test('parseArgs accepts read-only manifest check options', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--manifest', './manifest.json', '--check-manifest'])

  assert.equal(opts.checkManifest, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.manifestPath.endsWith('/manifest.json'))
})

test('parseArgs accepts attachable bundle export options', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--export-dir', './attachable', '--export'])

  assert.equal(opts.export, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.ok(opts.exportDir.endsWith('/attachable'))
})

test('parseArgs accepts read-only host-go status', () => {
  const opts = parseArgs(['--out-dir', './receipts', '--agent', 'agent-one', '--status', '--status-summary'])

  assert.equal(opts.status, true)
  assert.equal(opts.statusSummary, true)
  assert.ok(opts.outDir.endsWith('/receipts'))
  assert.deepEqual(opts.agents, ['agent-one'])
})

test('parseArgs accepts host-go plan options', () => {
  const opts = parseArgs(['--agent', 'agent-one', '--out-dir', './receipts/agent-one', '--export-dir', './receipts/agent-one-attach', '--base-url', 'https://pot.example.org', '--host-go-plan'])

  assert.equal(opts.hostGoPlan, true)
  assert.equal(opts.baseUrl, 'https://pot.example.org')
  assert.ok(opts.outDir.endsWith('/receipts/agent-one'))
  assert.ok(opts.exportDir.endsWith('/receipts/agent-one-attach'))
  assert.deepEqual(opts.agents, ['agent-one'])
})

test('formatHostGoPlan prints the full #274 live-host command sequence without token values', () => {
  const plan = formatHostGoPlan({
    agents: ['agent-one'],
    outDir: '~/.fleet/receipts/agent-one',
    exportDir: '~/.fleet/receipts/agent-one-attach',
    installReceiptPath: '~/.fleet/receipts/install.json',
    baseUrl: 'https://pot.example.org',
    requiredControlVerbs: ['start', 'stop'],
  })

  assert.ok(plan.includes('Mupot host-go plan (#274)'))
  assert.ok(plan.includes('node fleet-runtime/install.mjs > ~/.fleet/receipts/install.json'))
  assert.ok(plan.includes('node ~/.fleet/runtime/receipt-bundle.mjs --agent agent-one --out-dir ~/.fleet/receipts/agent-one --require-control-verb start,stop --install-receipt ~/.fleet/receipts/install.json --skip-runtime --skip-control'))
  assert.ok(plan.includes('# Requires MUPOT_AGENT_TOKEN and MUPOT_OWNER_TOKEN in the environment.'))
  assert.ok(plan.includes('node ~/.fleet/runtime/cutover-probe.mjs --base-url https://pot.example.org --agent agent-one --queue-inbox --control start > ~/.fleet/receipts/agent-one/probe-start.json'))
  assert.ok(plan.includes('# Requires MUPOT_OWNER_TOKEN in the environment.'))
  assert.ok(plan.includes('node ~/.fleet/runtime/cutover-probe.mjs --base-url https://pot.example.org --agent agent-one --control stop > ~/.fleet/receipts/agent-one/probe-stop.json'))
  assert.doesNotMatch(plan, /MUPOT_(?:AGENT|OWNER)_TOKEN=/)
  assert.ok(plan.includes('--verify-only'))
  assert.ok(plan.includes('--export-dir ~/.fleet/receipts/agent-one-attach --export'))
  assert.ok(plan.includes('--out-dir ~/.fleet/receipts/agent-one-attach --check-manifest'))
  assert.ok(plan.includes('export-receipt.json, and manifest-check.json all report status "pass"'))
  assert.doesNotMatch(plan, /mupot_[A-Za-z0-9]/)
  assert.doesNotMatch(plan, /Bearer\s+[A-Za-z0-9]/)
})
