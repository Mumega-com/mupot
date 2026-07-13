#!/usr/bin/env node
// fleet-runtime receipt bundle — resumable host-side evidence pack for SOS cutover.
//
// This command runs the existing receipt tools, saves their JSON output under one
// directory, and writes a final cutover-gate receipt plus manifest. It is intended
// for the live host rollout where start/stop control receipts may be gathered in
// separate operator steps.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { buildReceipt as buildHostReceipt } from './host-receipt.mjs'
import { buildReceipt as buildRuntimeReceipt } from './runtime-receipt.mjs'
import { buildReceipt as buildControlReceipt } from './control-receipt.mjs'
import { buildReceipt as buildCutoverReceipt, controlRuns } from './cutover-receipt.mjs'

const EXPECTED = {
  install: 'mupot-fleet-install-receipt/v1',
  probe: 'mupot-fleet-cutover-probe/v1',
  host: 'mupot-fleet-host-receipt/v1',
  runtime: 'mupot-fleet-runtime-receipt/v1',
  control: 'mupot-fleet-control-receipt/v1',
  cutover_gate: 'mupot-sos-cutover-gate/v1',
  service: 'mupot-fleet-service-receipt/v1',
  continuous: 'mupot-fleet-continuous-runtime-receipt/v1',
  starter: 'mupot-fleet-starter-receipt/v1',
}

const STARTER_RECEIPT_ROLES = Object.freeze([
  Object.freeze({ role: 'service', option: 'serviceReceiptPath', file: 'service.json' }),
  Object.freeze({ role: 'continuous', option: 'continuousReceiptPath', file: 'continuous.json' }),
  Object.freeze({ role: 'starter', option: 'starterReceiptPath', file: 'starter.json' }),
])

const NEXT_STEP_ATTACH = 'attach manifest.json and cutover-gate.json to the cutover record; SOS removal is permitted only for the proven agent(s)'
const NEXT_STEP_HOLD = 'do not remove SOS wiring yet; rerun until manifest.json and cutover-gate.json are status pass'
const EXPORT_RECEIPT_FILE = 'export-receipt.json'
const MANIFEST_CHECK_RECEIPT_FILE = 'manifest-check.json'
const SHA256_RE = /^[a-f0-9]{64}$/
const SERVICE_KEYS = ['heartbeat', 'control']
const STARTER_ARTIFACT_ROLES = ['starter_manifest', 'install', 'service', 'host', 'continuous', 'runtime_inbox', 'lifecycle_control', 'receipt_bundle_manifest']
const STARTER_CHECKS = ['starter_manifest_valid', 'install_receipt_pass', 'service_receipt_pass', 'host_receipt_pass', 'continuous_receipt_pass', 'runtime_inbox_receipts_pass', 'lifecycle_control_receipts_pass', 'receipt_bundle_manifest_pass', 'artifact_paths_portable', 'artifact_digests_valid']
const CONTINUOUS_CHECKS = ['linger_enabled', 'observation_completed_before_deadline', 'services_running', 'heartbeat_tick_advanced', 'control_poll_advanced', 'agent_probe_alive', 'signed_heartbeat_2xx', 'heartbeat_fresh_under_ttl', 'inbox_consume_not_failed']

const REQUIRED_HOST_RECEIPT_CHECKS = [
  { component: 'fleet-control-daemon', check: 'panel_public_key_public_only' },
]

const EXPORT_SIDECAR_RECEIPTS = [
  { file: EXPORT_RECEIPT_FILE, receipt_type: 'mupot-fleet-receipt-bundle-export/v1' },
  { file: MANIFEST_CHECK_RECEIPT_FILE, receipt_type: 'mupot-fleet-receipt-bundle-check/v1' },
]

const CONTROL_VERBS = new Set(['start', 'stop', 'restart'])
const SECRET_VALUE_PATTERNS = [
  ['private_pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]
const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i
const SECRET_REFERENCE_FIELD_RE = /(?:^|[_-])(env|name|ref|path|file|id)$/i

function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function pathArg(path) {
  return resolve(expandHome(path))
}

function defaultStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function splitValues(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

function safeName(v) {
  return String(v).replace(/[^A-Za-z0-9_.-]+/g, '_')
}

function validateStarterReceiptOptions(opts, { rejectReadOnlyModes = false } = {}) {
  const starterPaths = STARTER_RECEIPT_ROLES.map(({ option }) => opts[option]).filter(Boolean)
  if (new Set(starterPaths.map((path) => resolve(path))).size !== starterPaths.length) {
    throw new Error('starter artifact roles require distinct receipt paths')
  }
  if (starterPaths.length !== 0 && starterPaths.length !== STARTER_RECEIPT_ROLES.length) {
    throw new Error('starter-ready mode requires exactly all three receipt roles')
  }
  if (rejectReadOnlyModes && starterPaths.length > 0 && (opts.status || opts.hostGoPlan || opts.checkManifest || opts.export || opts.exportDir)) {
    throw new Error('starter receipt flags cannot be combined with read-only or plan modes')
  }
}

function parseArgs(argv) {
  const opts = {
    agents: [],
    daemonPath: join(homedir(), '.fleet', 'daemon.json'),
    inboxPath: join(homedir(), '.fleet', 'inbox-handler.json'),
    controlPath: join(homedir(), '.fleet', 'control.json'),
    installReceiptPath: '',
    probeReceiptPaths: [],
    serviceReceiptPath: '',
    continuousReceiptPath: '',
    starterReceiptPath: '',
    outDir: '',
    exportDir: '',
    controlLabel: '',
    manifestPath: '',
    requiredControlVerbs: ['start', 'stop'],
    skipHost: false,
    skipRuntime: false,
    skipControl: false,
    verifyOnly: false,
    execProbes: false,
    force: false,
  }
  const setReceiptPath = (option, flag, value) => {
    if (opts[option]) throw new Error(`duplicate ${flag}`)
    opts[option] = pathArg(value)
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length || argv[i] === '' || argv[i].startsWith('-')) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--agent') opts.agents.push(...splitValues(next()))
    else if (arg === '--daemon') opts.daemonPath = pathArg(next())
    else if (arg === '--inbox') opts.inboxPath = pathArg(next())
    else if (arg === '--control') opts.controlPath = pathArg(next())
    else if (arg === '--install-receipt') opts.installReceiptPath = pathArg(next())
    else if (arg === '--probe-receipt') opts.probeReceiptPaths.push(...splitValues(next()).map(pathArg))
    else if (arg === '--service-receipt') setReceiptPath('serviceReceiptPath', arg, next())
    else if (arg === '--continuous-receipt') setReceiptPath('continuousReceiptPath', arg, next())
    else if (arg === '--starter-receipt') setReceiptPath('starterReceiptPath', arg, next())
    else if (arg === '--out-dir') opts.outDir = pathArg(next())
    else if (arg === '--export-dir') opts.exportDir = pathArg(next())
    else if (arg === '--control-label') opts.controlLabel = safeName(next())
    else if (arg === '--manifest') opts.manifestPath = pathArg(next())
    else if (arg === '--require-control-verb') {
      const verbs = splitValues(next())
      for (const verb of verbs) {
        if (!CONTROL_VERBS.has(verb)) throw new Error(`unsupported control verb: ${verb}`)
      }
      opts.requiredControlVerbs = verbs
    } else if (arg === '--skip-host') opts.skipHost = true
    else if (arg === '--skip-runtime') opts.skipRuntime = true
    else if (arg === '--skip-control') opts.skipControl = true
    else if (arg === '--verify-only') {
      opts.verifyOnly = true
      opts.skipHost = true
      opts.skipRuntime = true
      opts.skipControl = true
    }
    else if (arg === '--exec-probes') opts.execProbes = true
    else if (arg === '--status') opts.status = true
    else if (arg === '--status-summary') {
      opts.status = true
      opts.statusSummary = true
    }
    else if (arg === '--host-go-plan') opts.hostGoPlan = true
    else if (arg === '--base-url') opts.baseUrl = next()
    else if (arg === '--check-manifest') opts.checkManifest = true
    else if (arg === '--export') opts.export = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  validateStarterReceiptOptions(opts, { rejectReadOnlyModes: true })
  return opts
}

function usage() {
  return [
    'Usage: node fleet-runtime/receipt-bundle.mjs --agent <id> [options]',
    '',
    'Options:',
    '  --agent <id>                  required; repeat or comma-separate for multiple agents',
    '  --out-dir <path>              bundle directory (default: ~/.fleet/receipts/<timestamp>)',
    '  --daemon <path>               fleet-daemon config (default: ~/.fleet/daemon.json)',
    '  --inbox <path>                inbox-handler config (default: ~/.fleet/inbox-handler.json)',
    '  --control <path>              fleet-control-daemon config (default: ~/.fleet/control.json)',
    '  --install-receipt <path>      optional install.mjs receipt to copy into install.json',
    '  --probe-receipt <path>        optional cutover-probe.mjs receipt; repeat or comma-separate',
    '  --service-receipt <path>      service status receipt for starter-ready mode',
    '  --continuous-receipt <path>   continuous runtime receipt for starter-ready mode',
    '  --starter-receipt <path>      starter verification receipt for starter-ready mode',
    '  --export-dir <path>           write a clean attachable copy, then check the copied manifest',
    '  --control-label <label>       filename label for this live control receipt, e.g. start or stop',
    '  --manifest <path>             manifest path for --check-manifest',
    '  --skip-host                   reuse existing host.json from the bundle directory',
    '  --skip-runtime                reuse existing runtime-*.json receipts from the bundle directory',
    '  --skip-control                do not run a live control poll; reuse existing control-*.json',
    '  --verify-only                 read-only recheck; reuse host/runtime/control receipts',
    '  --status                      read-only host-go evidence status for an in-progress bundle',
    '  --status-summary              with --status, print a compact text checklist instead of JSON',
    '  --host-go-plan                print the #274 live-host command plan; writes nothing',
    '  --base-url <url>              pot URL used in --host-go-plan probe commands',
    '  --check-manifest              read-only hash/status check; writes nothing',
    '  --export                      copy manifest, artifacts, and export/check sidecars to --export-dir and check it',
    '  --require-control-verb <verb> default: start,stop; values: start, stop, restart',
    '  --exec-probes                 pass through to host-receipt.mjs',
    '  --force                       overwrite same-name receipt files',
    '  -h, --help                    show this help',
    '',
    'Typical sequence:',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --agent my-agent --out-dir ~/.fleet/receipts/my-agent --install-receipt ~/.fleet/receipts/install.json --skip-runtime --skip-control',
    '  queue inbox + start with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-start.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-start.json --skip-host --control-label start',
    '  queue stop with cutover-probe.mjs > ~/.fleet/receipts/my-agent/probe-stop.json, then rerun with --probe-receipt ~/.fleet/receipts/my-agent/probe-stop.json --skip-host --skip-runtime --control-label stop',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --out-dir ~/.fleet/receipts/my-agent --export-dir ~/.fleet/receipts/my-agent-attach --export',
    '  node ~/.fleet/runtime/receipt-bundle.mjs --out-dir ~/.fleet/receipts/my-agent --check-manifest',
    '  npm run receipt:bundle:plan -- --agent my-agent --base-url https://mupot.example.com',
  ].join('\n')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

function requiredControlVerbArgs(requiredControlVerbs = []) {
  return ['--require-control-verb', requiredControlVerbs.join(',')]
}

function hostGoPlanAgentOutDir(opts, agentId, multipleAgents) {
  if (opts.outDir && !multipleAgents) return opts.outDir
  if (opts.outDir && multipleAgents) return join(opts.outDir, safeName(agentId))
  return `~/.fleet/receipts/${safeName(agentId)}`
}

function formatHostGoPlan(opts = {}) {
  const agents = opts.agents?.length ? opts.agents : ['<agent_id>']
  const requiredControlVerbs = opts.requiredControlVerbs?.length ? opts.requiredControlVerbs : ['start', 'stop']
  const baseUrl = opts.baseUrl || process.env.MUPOT_BASE_URL || 'https://YOUR-POT.example.com'
  const installReceipt = opts.installReceiptPath || '~/.fleet/receipts/install.json'
  const multipleAgents = agents.length > 1
  const lines = []

  lines.push('Mupot host-go plan (#274)')
  lines.push('')
  lines.push('Manual prerequisites before running the live receipt steps:')
  lines.push('- Edit ~/.fleet/daemon.json, ~/.fleet/inbox-handler.json, ~/.fleet/control.json, and ~/.fleet/flights.json for the real pot/tenant.')
  lines.push('- Place agent private keys with 0600-style permissions and install the panel public key as public material only.')
  lines.push('- Export MUPOT_AGENT_TOKEN for inbox probes and MUPOT_OWNER_TOKEN for lifecycle control probes, or inject them from a secret manager. Do not paste token values into copied commands or receipt files.')
  lines.push('')
  lines.push('0. Install/update the runtime layout and save the installer receipt:')
  lines.push(commandLine(['mkdir', '-p', '~/.fleet/receipts']))
  lines.push(commandLine(['node', 'fleet-runtime/install.mjs'], ` > ${shellQuote(installReceipt)}`))
  lines.push('')

  for (const agentId of agents) {
    const outDir = hostGoPlanAgentOutDir(opts, agentId, multipleAgents)
    const exportDir = multipleAgents
      ? `${outDir}-attach`
      : opts.exportDir || `${outDir}-attach`
    const agentArgs = ['--agent', agentId]
    const commonReceiptArgs = ['node', '~/.fleet/runtime/receipt-bundle.mjs', ...agentArgs, '--out-dir', outDir, ...requiredControlVerbArgs(requiredControlVerbs)]

    lines.push(`${multipleAgents ? `Agent ${agentId}` : 'Agent evidence'}:`)
    lines.push('')
    lines.push('1. Create the bundle directory and collect install + host evidence:')
    lines.push(commandLine(['mkdir', '-p', outDir]))
    lines.push(commandLine([...commonReceiptArgs, '--install-receipt', installReceipt, '--skip-runtime', '--skip-control']))
    lines.push(commandLine(['node', '~/.fleet/runtime/receipt-bundle.mjs', ...agentArgs, '--out-dir', outDir, '--status', '--status-summary', ...requiredControlVerbArgs(requiredControlVerbs)]))
    lines.push('')

    requiredControlVerbs.forEach((verb, index) => {
      const probePath = join(outDir, `probe-${safeName(verb)}.json`)
      const queueArgs = ['node', '~/.fleet/runtime/cutover-probe.mjs', '--base-url', baseUrl, '--agent', agentId]
      if (index === 0) queueArgs.push('--queue-inbox')
      queueArgs.push('--control', verb)

      lines.push(`${index + 2}. Queue ${index === 0 ? 'inbox + ' : ''}${verb} evidence and collect the receipt:`)
      lines.push(index === 0
        ? '# Requires MUPOT_AGENT_TOKEN and MUPOT_OWNER_TOKEN in the environment.'
        : '# Requires MUPOT_OWNER_TOKEN in the environment.')
      lines.push(commandLine(queueArgs, ` > ${shellQuote(probePath)}`))
      lines.push(commandLine([
        ...commonReceiptArgs,
        '--probe-receipt',
        probePath,
        '--skip-host',
        ...(index === 0 ? [] : ['--skip-runtime']),
        '--control-label',
        safeName(verb),
      ]))
      lines.push(commandLine(['node', '~/.fleet/runtime/receipt-bundle.mjs', ...agentArgs, '--out-dir', outDir, '--status', '--status-summary', ...requiredControlVerbArgs(requiredControlVerbs)]))
      lines.push('')
    })

    lines.push(`${requiredControlVerbs.length + 2}. Rebuild the final gate and manifest from saved evidence:`)
    lines.push(commandLine([...commonReceiptArgs, '--verify-only']))
    lines.push('')
    lines.push(`${requiredControlVerbs.length + 3}. Export the attachable bundle and check the copied evidence:`)
    lines.push(commandLine(['node', '~/.fleet/runtime/receipt-bundle.mjs', '--out-dir', outDir, '--export-dir', exportDir, '--export']))
    lines.push(commandLine(['node', '~/.fleet/runtime/receipt-bundle.mjs', '--out-dir', exportDir, '--check-manifest']))
    lines.push('')
    lines.push('Attach only the exported directory after manifest.json, cutover-gate.json, export-receipt.json, and manifest-check.json all report status "pass".')
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function summarize(checks) {
  const failed = checks.filter((c) => c.ok === false)
  const warnings = checks.filter((c) => c.ok === null)
  return {
    status: failed.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    passed: checks.length - failed.length - warnings.length,
    failed: failed.length,
    warnings: warnings.length,
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function validServiceState(value, manager, key) {
  const names = manager === 'systemd'
    ? { heartbeat: 'fleet-daemon.service', control: 'fleet-control-daemon.service' }
    : { heartbeat: 'com.mumega.mupot-fleet-daemon', control: 'com.mumega.mupot-fleet-control' }
  return hasExactKeys(value, ['key', 'name', 'loaded', 'enabled', 'running', 'pid']) && value.key === key && value.name === names[key] &&
    value.loaded === true && value.enabled === true && value.running === true && Number.isInteger(value.pid) && value.pid > 0
}

function normalizePassingServiceReceipt(receipt) {
  const keys = ['receipt_type', 'generated_at', 'status', 'platform', 'service_manager', 'action', 'definitions', 'services', 'linger', 'commands', 'preserved_data', 'next_steps', 'checks']
  if (!hasExactKeys(receipt, keys) || receipt.receipt_type !== EXPECTED.service || receipt.status !== 'pass' || receipt.action !== 'status' || !validTimestamp(receipt.generated_at)) return null
  const manager = receipt.service_manager
  const platform = manager === 'systemd' ? 'linux' : manager === 'launchd' ? 'darwin' : null
  if (receipt.platform !== platform || !Array.isArray(receipt.definitions) || receipt.definitions.length !== 2 || !Array.isArray(receipt.services) || receipt.services.length !== 2) return null
  const definitions = {}
  for (const definition of receipt.definitions) {
    if (!hasExactKeys(definition, ['service', 'path', 'sha256']) || !SERVICE_KEYS.includes(definition.service) || definitions[definition.service] ||
      typeof definition.path !== 'string' || definition.path.length === 0 || !SHA256_RE.test(definition.sha256)) return null
    const expectedName = manager === 'systemd' ? (definition.service === 'heartbeat' ? 'fleet-daemon.service' : 'fleet-control-daemon.service') :
      `${definition.service === 'heartbeat' ? 'com.mumega.mupot-fleet-daemon' : 'com.mumega.mupot-fleet-control'}.plist`
    if (basename(definition.path) !== expectedName) return null
    definitions[definition.service] = definition.sha256
  }
  const services = {}
  for (const service of receipt.services) {
    if (!SERVICE_KEYS.includes(service?.key) || services[service.key] || !validServiceState(service, manager, service.key)) return null
    services[service.key] = service
  }
  if (!Array.isArray(receipt.commands) || receipt.commands.some((command) => !hasExactKeys(command, ['executable', 'argv', 'code', 'stdout_summary', 'stderr_summary']) ||
    typeof command.executable !== 'string' || !Array.isArray(command.argv) || command.argv.some((arg) => typeof arg !== 'string') || !Number.isInteger(command.code) ||
    typeof command.stdout_summary !== 'string' || typeof command.stderr_summary !== 'string')) return null
  const expectedCommands = manager === 'systemd'
    ? [
        ['systemctl', ['--user', 'show', 'fleet-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value']],
        ['systemctl', ['--user', 'show', 'fleet-control-daemon.service', '--property=LoadState,UnitFileState,ActiveState,MainPID', '--value']],
        ['loginctl', null],
      ]
    : [
        ['launchctl', ['print', null, 'com.mumega.mupot-fleet-daemon']],
        ['launchctl', ['print', null, 'com.mumega.mupot-fleet-control']],
      ]
  if (receipt.commands.length !== expectedCommands.length || receipt.commands.some((command, index) => {
    const expected = expectedCommands[index]
    if (command.executable !== expected[0] || command.code !== 0) return true
    if (manager === 'systemd' && index < 2) return JSON.stringify(command.argv) !== JSON.stringify(expected[1])
    if (manager === 'systemd') return command.argv.length !== 5 || command.argv[0] !== 'show-user' || typeof command.argv[1] !== 'string' || command.argv[1].length === 0 || JSON.stringify(command.argv.slice(2)) !== JSON.stringify(['-p', 'Linger', '--value'])
    return command.argv.length !== 2 || command.argv[0] !== 'print' || !command.argv[1].endsWith(`/${expected[1][2]}`)
  })) return null
  const preserved = ['configs', 'private_keys', 'runtime', 'inbox', 'receipts']
  if (!hasExactKeys(receipt.preserved_data, preserved) || preserved.some((key) => receipt.preserved_data[key] !== true) || !Array.isArray(receipt.next_steps) || receipt.next_steps.length !== 0) return null
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== 2 || receipt.checks.some((check, index) => !hasExactKeys(check, ['ok', 'check']) || check.ok !== true || check.check !== ['services_loaded_and_running', 'command_output_secret_free'][index])) return null
  if (manager === 'systemd') {
    if (!hasExactKeys(receipt.linger, ['enabled', 'raw']) || receipt.linger.enabled !== true || receipt.linger.raw !== 'yes') return null
  } else if (receipt.linger !== null) return null
  return { manager, platform, definitions, services, linger: receipt.linger }
}

function normalizeContinuousReceipt(receipt, agents, service) {
  if (!service || !hasExactKeys(receipt, ['receipt_type', 'generated_at', 'status', 'agent', 'observation', 'service', 'next_steps', 'checks']) ||
    receipt.receipt_type !== EXPECTED.continuous || receipt.status !== 'pass' || !validTimestamp(receipt.generated_at)) return null
  if (!hasExactKeys(receipt.agent, ['agent_id', 'probe', 'heartbeat_status', 'inbox_count', 'consume']) || !agents.includes(receipt.agent.agent_id) ||
    receipt.agent.probe !== 'alive' || !Number.isInteger(receipt.agent.heartbeat_status) || receipt.agent.heartbeat_status < 200 || receipt.agent.heartbeat_status >= 300 ||
    !Number.isInteger(receipt.agent.inbox_count) || receipt.agent.inbox_count < 0 || !['consumed', 'not_configured', 'not_attempted', 'inbox_empty', 'not_attempted_probe_dead', 'not_attempted_heartbeat_failed'].includes(receipt.agent.consume)) return null
  const observation = receipt.observation
  if (!hasExactKeys(observation, ['started_at', 'deadline_at', 'timed_out', 'heartbeat', 'control']) || !validTimestamp(observation.started_at) || !validTimestamp(observation.deadline_at) || observation.timed_out !== false) return null
  if (!hasExactKeys(observation.heartbeat, ['schema', 'pid', 'started_at', 'last_tick_at', 'interval_sec', 'tick']) || observation.heartbeat.schema !== 'mupot-fleet-daemon-state/v1' ||
    !Number.isInteger(observation.heartbeat.pid) || observation.heartbeat.pid <= 0 || !validTimestamp(observation.heartbeat.started_at) || !validTimestamp(observation.heartbeat.last_tick_at) ||
    !Number.isFinite(observation.heartbeat.interval_sec) || observation.heartbeat.interval_sec <= 0 || !hasExactKeys(observation.heartbeat.tick, ['before', 'after'])) return null
  if (!hasExactKeys(observation.control, ['schema', 'pid', 'started_at', 'last_poll_at', 'poll_sec', 'last_outcome', 'poll']) || observation.control.schema !== 'mupot-fleet-control-state/v1' ||
    !Number.isInteger(observation.control.pid) || observation.control.pid <= 0 || !validTimestamp(observation.control.started_at) || !validTimestamp(observation.control.last_poll_at) ||
    !Number.isFinite(observation.control.poll_sec) || observation.control.poll_sec <= 0 || !hasExactKeys(observation.control.poll, ['before', 'after']) || !hasExactKeys(observation.control.last_outcome, ['agent_id', 'verb', 'accepted', 'result'])) return null
  const outcome = observation.control.last_outcome
  const acceptedResults = { start: 'open', stop: 'close', restart: 'restart_open', status: 'status_noop' }
  const outcomeValid = (outcome.agent_id === null && outcome.verb === null && outcome.accepted === true && outcome.result === 'idle') ||
    (typeof outcome.agent_id === 'string' && Object.hasOwn(acceptedResults, outcome.verb) && outcome.accepted === true && outcome.result === acceptedResults[outcome.verb]) ||
    (outcome.accepted === false && typeof outcome.result === 'string' && ((outcome.agent_id === null && outcome.verb === null) || (typeof outcome.agent_id === 'string' && Object.hasOwn(acceptedResults, outcome.verb))))
  if (!outcomeValid) return null
  const heartbeatDelta = observation.heartbeat.tick.after - observation.heartbeat.tick.before
  const controlDelta = observation.control.poll.after - observation.control.poll.before
  if (!Number.isFinite(heartbeatDelta) || heartbeatDelta <= 0 || !Number.isFinite(controlDelta) || controlDelta <= 0) return null
  const serviceProjection = receipt.service
  if (!hasExactKeys(serviceProjection, ['status', 'service_manager', 'services', 'linger', 'checks']) || serviceProjection.status !== 'pass' || serviceProjection.service_manager !== service.manager ||
    !Array.isArray(serviceProjection.services) || serviceProjection.services.length !== 2 || SERVICE_KEYS.some((key) => {
      const state = serviceProjection.services.find((entry) => entry?.key === key)
      return !state || JSON.stringify(state) !== JSON.stringify(service.services[key])
    }) || JSON.stringify(serviceProjection.linger) !== JSON.stringify(service.linger) ||
    JSON.stringify(serviceProjection.checks) !== JSON.stringify([{ check: 'services_loaded_and_running', ok: true }, { check: 'command_output_secret_free', ok: true }])) return null
  const generatedAt = Date.parse(receipt.generated_at)
  const lastTickAt = Date.parse(observation.heartbeat.last_tick_at)
  if (!Number.isFinite(generatedAt - lastTickAt) || generatedAt < lastTickAt) return null
  if (!Array.isArray(receipt.next_steps) || receipt.next_steps.length !== 0 || !Array.isArray(receipt.checks) || ![CONTINUOUS_CHECKS.length, CONTINUOUS_CHECKS.length + 1].includes(receipt.checks.length) ||
    receipt.checks.slice(0, CONTINUOUS_CHECKS.length).some((check, index) => !hasExactKeys(check, ['check', 'ok']) || check.check !== CONTINUOUS_CHECKS[index] || check.ok !== true) ||
    (receipt.checks.length > CONTINUOUS_CHECKS.length && (!hasExactKeys(receipt.checks.at(-1), ['check', 'ok']) || receipt.checks.at(-1).check !== 'required_control_accepted' || receipt.checks.at(-1).ok !== true))) return null
  return { agent_id: receipt.agent.agent_id, heartbeat_delta: heartbeatDelta, control_delta: controlDelta }
}

function normalizeStarterReceipt(receipt) {
  if (!hasExactKeys(receipt, ['receipt_type', 'generated_at', 'status', 'manifest', 'artifacts', 'checks']) || receipt.receipt_type !== EXPECTED.starter || receipt.status !== 'pass' || !validTimestamp(receipt.generated_at)) return null
  if (!hasExactKeys(receipt.manifest, ['path', 'sha256']) || typeof receipt.manifest.path !== 'string' || receipt.manifest.path.length === 0 || isAbsolute(receipt.manifest.path) || !SHA256_RE.test(receipt.manifest.sha256)) return null
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== STARTER_ARTIFACT_ROLES.length) return null
  const roles = new Set()
  for (const artifact of receipt.artifacts) {
    if (!hasExactKeys(artifact, ['role', 'path', 'sha256']) || !STARTER_ARTIFACT_ROLES.includes(artifact.role) || roles.has(artifact.role) ||
      typeof artifact.path !== 'string' || artifact.path.length === 0 || isAbsolute(artifact.path) || artifact.path.includes('..') || !SHA256_RE.test(artifact.sha256)) return null
    roles.add(artifact.role)
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== STARTER_CHECKS.length || receipt.checks.some((check, index) => !hasExactKeys(check, ['check', 'ok']) || check.check !== STARTER_CHECKS[index] || check.ok !== true)) return null
  return { manifest_sha256: receipt.manifest.sha256 }
}

function normalizeStarterEvidence({ serviceReceipt, continuousReceipt, starterReceipt, hostReceipt, agents }) {
  const service = normalizePassingServiceReceipt(serviceReceipt)
  const continuous = normalizeContinuousReceipt(continuousReceipt, agents, service)
  const starter = normalizeStarterReceipt(starterReceipt)
  const requiredHostChecks = ['service_definitions_current', 'heartbeat_service_running', 'control_service_running', 'systemd_linger_enabled']
  const hostChecks = Array.isArray(hostReceipt?.checks) ? hostReceipt.checks : []
  const hostServiceChecks = requiredHostChecks.map((name) => hostChecks.filter((check) => check?.component === 'host-services' && check?.check === name && check?.ok === true))
  const definitionsCheck = hostServiceChecks[0]?.[0]
  const hostHashes = {}
  for (const definition of definitionsCheck?.definitions ?? []) {
    if (SERVICE_KEYS.includes(definition?.service) && definition?.ok === true && definition.actual_sha256 === definition.rendered_sha256 && definition.rendered_sha256 === definition.expected_sha256) hostHashes[definition.service] = definition.actual_sha256
  }
  const hostValid = hostReceipt?.receipt_type === EXPECTED.host && hostReceipt?.status === 'pass' && hostServiceChecks.every((matches) => matches.length === 1) &&
    definitionsCheck?.service_manager === service?.manager && SERVICE_KEYS.every((key) => hostHashes[key] === service?.definitions[key]) &&
    agents.every((agent) => hostReceipt?.target?.daemon_agents?.includes(agent))
  if (!service || !continuous || !starter || !hostValid) return null
  return { service_manager: service.manager, platform: service.platform, definition_hashes: service.definitions, observed_deltas: { heartbeat_tick: continuous.heartbeat_delta, control_poll: continuous.control_delta }, starter_manifest_sha256: starter.manifest_sha256, agent_id: continuous.agent_id, tenant: hostReceipt.target?.tenant ?? null }
}

function ensureDir(path, checks) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
    checks.push({ ok: true, component: 'receipt-bundle', check: 'out_dir_ready', path })
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'out_dir_ready', path, reason: String(err && err.message ? err.message : err) })
  }
}

function writeJson(path, value, opts, checks, label) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
    chmodSync(path, 0o600)
    checks.push({ ok: true, component: 'receipt-bundle', check: `${label}_receipt_written`, path })
    return true
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: `${label}_receipt_written`, path, reason: String(err && err.message ? err.message : err) })
    return false
  }
}

function writeJsonUnchecked(path, value, opts) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
  chmodSync(path, 0o600)
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function normalizeFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

function isSecretReferenceField(key) {
  const normalized = normalizeFieldName(key)
  return normalized.split('_').some((part) => SECRET_REFERENCE_FIELD_RE.test(part)) &&
    /(token|secret|private_key|api_key|password|authorization|bearer|cookie)/i.test(normalized)
}

function isSafeReferenceValue(value) {
  const raw = String(value).trim()
  return raw.length === 0 ||
    /^<[^>]+>$/.test(raw) ||
    /^\$\{[A-Z0-9_]+\}$/.test(raw) ||
    /^(redacted|\[redacted\]|placeholder|changeme|change-me)$/i.test(raw) ||
    (/^[A-Z][A-Z0-9_]{2,}$/.test(raw) && /(TOKEN|SECRET|KEY|AUTH|PASS|COOKIE)/.test(raw))
}

function fieldLooksSecret(key) {
  const normalized = normalizeFieldName(key)
  return SECRET_FIELD_RE.test(normalized) && !isSecretReferenceField(normalized)
}

function jsonPath(parent, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))) return `${parent}.${key}`
  return `${parent}[${JSON.stringify(String(key))}]`
}

function addSecretFinding(findings, finding) {
  const key = `${finding.path}:${finding.reason}`
  if (findings.some((existing) => `${existing.path}:${existing.reason}` === key)) return
  findings.push(finding)
}

function findSecretMaterial(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    for (const [reason, pattern] of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) addSecretFinding(findings, { path, reason })
    }
    return findings
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretMaterial(item, `${path}[${index}]`, findings))
    return findings
  }
  if (!value || typeof value !== 'object') return findings

  if (typeof value.kty === 'string' && typeof value.d === 'string') {
    addSecretFinding(findings, { path: jsonPath(path, 'd'), reason: 'jwk_private_key' })
  }

  for (const [key, item] of Object.entries(value)) {
    const childPath = jsonPath(path, key)
    if (typeof item === 'string' && fieldLooksSecret(key) && !isSafeReferenceValue(item)) {
      addSecretFinding(findings, { path: childPath, reason: 'secret_named_field', field: key })
    }
    findSecretMaterial(item, childPath, findings)
  }
  return findings
}

function secretFindingSummary(findings) {
  return findings.slice(0, 20).map((finding) => ({
    path: finding.path,
    reason: finding.reason,
    ...(finding.field ? { field: finding.field } : {}),
  }))
}

function secretScanChecks(manifestCheck) {
  return (manifestCheck?.checks ?? []).filter((check) =>
    check?.check === 'manifest_no_secret_material' ||
    check?.check === 'artifact_no_secret_material' ||
    check?.check === 'export_sidecar_no_secret_material'
  )
}

function hasSecretScanFailures(manifestCheck) {
  return secretScanChecks(manifestCheck).some((check) => check.ok === false)
}

function bundleScopeChecks(manifestCheck) {
  return (manifestCheck?.checks ?? []).filter((check) =>
    check?.check === 'bundle_directory_only_manifest_artifacts' ||
    check?.check === 'artifact_file_in_bundle_dir'
  )
}

function hasBundleScopeFailures(manifestCheck) {
  return bundleScopeChecks(manifestCheck).some((check) => check.ok === false)
}

function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function receiptMeta(path) {
  const receipt = readReceipt(path)
  return {
    path,
    receipt_type: receipt?.receipt_type ?? null,
    status: receipt?.status ?? null,
    sha256: fileSha256(path),
  }
}

function manifestPathForCheck(opts) {
  if (opts.manifestPath) return pathArg(opts.manifestPath)
  if (opts.outDir) return join(pathArg(opts.outDir), 'manifest.json')
  return ''
}

function starterModeSelected(opts = {}) {
  return STARTER_RECEIPT_ROLES.some(({ option }) => Boolean(opts[option]))
}

function manifestStarterMode(manifest) {
  return manifest?.inputs?.bundle_mode === 'starter-ready'
}

function resolveArtifactPath(manifestDir, declaredPath) {
  if (typeof declaredPath !== 'string' || declaredPath.length === 0) return ''
  const localPath = join(manifestDir, basename(declaredPath))
  if (existsSync(localPath)) return localPath
  if (declaredPath.startsWith('~/') || isAbsolute(declaredPath)) return pathArg(declaredPath)
  return resolve(manifestDir, declaredPath)
}

function bundleArtifactEntries(manifest) {
  const artifacts = manifest?.artifacts ?? {}
  const entries = []
  const add = (label, meta) => {
    if (!meta || typeof meta !== 'object') return
    entries.push({
      label,
      path: meta.path,
      sha256: meta.sha256 ?? null,
      receipt_type: meta.receipt_type ?? null,
      status: meta.status ?? null,
    })
  }

  add('install', artifacts.install)
  for (const [index, probe] of (Array.isArray(artifacts.probes) ? artifacts.probes : []).entries()) add(`probe:${index + 1}`, probe)
  add('service', artifacts.service)
  add('continuous', artifacts.continuous)
  add('starter', artifacts.starter)
  add('host', artifacts.host)
  for (const [index, runtime] of (Array.isArray(artifacts.runtimes) ? artifacts.runtimes : []).entries()) add(`runtime:${index + 1}`, runtime)
  for (const [index, control] of (Array.isArray(artifacts.controls) ? artifacts.controls : []).entries()) add(`control:${index + 1}`, control)
  add('cutover_gate', artifacts.cutover_gate)
  return entries
}

function expectedArtifactType(label) {
  if (label === 'install') return EXPECTED.install
  if (label.startsWith('probe:')) return EXPECTED.probe
  if (label === 'host') return EXPECTED.host
  if (label === 'service') return EXPECTED.service
  if (label === 'continuous') return EXPECTED.continuous
  if (label === 'starter') return EXPECTED.starter
  if (label.startsWith('runtime:')) return EXPECTED.runtime
  if (label.startsWith('control:')) return EXPECTED.control
  if (label === 'cutover_gate') return EXPECTED.cutover_gate
  return null
}

function artifactStatusOk(label, status) {
  if (label === 'install') return status === 'pass' || status === 'warn'
  return status === 'pass'
}

function receiptBaseUrl(label, receipt) {
  if (label.startsWith('probe:')) return receipt?.inputs?.base_url ?? null
  return receipt?.target?.base_url ?? null
}

function receiptTenant(label, receipt) {
  if (label.startsWith('probe:')) return null
  return receipt?.target?.tenant ?? null
}

function receiptTargetAgents(label, receipt) {
  const agents = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0) agents.push(value)
  }
  if (label.startsWith('probe:')) {
    add(receipt?.inputs?.agent)
    for (const action of receipt?.actions ?? []) {
      add(action?.target_agent)
      add(action?.agent_id)
    }
  } else if (label.startsWith('runtime:')) {
    for (const agent of receipt?.target?.agents ?? []) add(agent)
    for (const agent of receipt?.inputs?.selected_agents ?? []) add(agent)
    for (const result of receipt?.agents ?? []) add(result?.agent)
  } else if (label.startsWith('control:')) {
    for (const agent of receipt?.target?.executed_agents ?? []) add(agent)
    add(receipt?.poll?.request?.agent_id)
    for (const check of receipt?.checks ?? []) {
      if (check?.component === 'fleet-control-daemon' && check?.check === 'control_request_executed') {
        add(check?.agent_id)
      }
    }
  } else if (label === 'host') {
    for (const agent of receipt?.target?.daemon_agents ?? []) add(agent)
  }
  return sortStrings(agents)
}

function receiptHasPassingCheck(receipt, required) {
  return (receipt?.checks ?? []).some((check) =>
    check?.component === required.component &&
    check?.check === required.check &&
    check?.ok === true
  )
}

function hostReceiptRequiredChecksPass(receipt) {
  return REQUIRED_HOST_RECEIPT_CHECKS.every((required) => receiptHasPassingCheck(receipt, required))
}

function addHostReceiptRequiredChecks(checks, { component, receipt, extra = {} }) {
  for (const required of REQUIRED_HOST_RECEIPT_CHECKS) {
    checks.push({
      ok: Boolean(receipt && receiptHasPassingCheck(receipt, required)),
      component,
      check: 'host_receipt_required_check_pass',
      required_component: required.component,
      required_check: required.check,
      ...extra,
    })
  }
}

function addTargetConsistencyChecks(checks, manifestPath, entries, receiptRecords, agents) {
  const targetLabels = new Set(['host'])
  for (const entry of entries) {
    if (entry.label.startsWith('probe:') || entry.label.startsWith('runtime:') || entry.label.startsWith('control:')) {
      targetLabels.add(entry.label)
    }
  }

  const baseUrlRecords = []
  const tenantRecords = []
  for (const record of receiptRecords) {
    if (!targetLabels.has(record.label)) continue
    const baseUrl = receiptBaseUrl(record.label, record.receipt)
    const tenant = receiptTenant(record.label, record.receipt)
    checks.push({
      ok: typeof baseUrl === 'string' && baseUrl.length > 0,
      component: 'receipt-bundle-check',
      check: 'artifact_target_base_url_recorded',
      path: manifestPath,
      artifact: record.label,
      base_url: baseUrl,
    })
    if (baseUrl) baseUrlRecords.push({ label: record.label, value: baseUrl })

    if (!record.label.startsWith('probe:')) {
      checks.push({
        ok: typeof tenant === 'string' && tenant.length > 0,
        component: 'receipt-bundle-check',
        check: 'artifact_target_tenant_recorded',
        path: manifestPath,
        artifact: record.label,
        tenant,
      })
      if (tenant) tenantRecords.push({ label: record.label, value: tenant })
    }
  }

  const baseUrls = sortStrings(baseUrlRecords.map((entry) => entry.value))
  checks.push({
    ok: baseUrls.length === 1,
    component: 'receipt-bundle-check',
    check: 'artifact_target_base_urls_match',
    path: manifestPath,
    base_urls: baseUrls,
    artifacts: baseUrlRecords.map((entry) => entry.label),
  })

  const tenants = sortStrings(tenantRecords.map((entry) => entry.value))
  checks.push({
    ok: tenants.length === 1,
    component: 'receipt-bundle-check',
    check: 'artifact_target_tenants_match',
    path: manifestPath,
    tenants,
    artifacts: tenantRecords.map((entry) => entry.label),
  })

  const selected = new Set(agents)
  for (const record of receiptRecords) {
    const targetAgents = receiptTargetAgents(record.label, record.receipt)
    if (!(record.label.startsWith('probe:') || record.label.startsWith('runtime:') || record.label.startsWith('control:'))) continue
    checks.push({
      ok: targetAgents.length > 0 && targetAgents.every((agent) => selected.has(agent)),
      component: 'receipt-bundle-check',
      check: 'artifact_target_agents_selected',
      path: manifestPath,
      artifact: record.label,
      agents: targetAgents,
      selected_agents: sortStrings(agents),
    })
  }

  const passingProbeRecords = receiptRecords.filter((record) => record.label.startsWith('probe:') && record.receipt?.status === 'pass')
  for (const agentId of agents) {
    checks.push({
      ok: passingProbeRecords.some((record) => receiptTargetAgents(record.label, record.receipt).includes(agentId)),
      component: 'receipt-bundle-check',
      check: 'probe_artifact_for_agent',
      path: manifestPath,
      agent_id: agentId,
    })
  }
}

function sameSummary(actual, expected) {
  return actual?.status === expected?.status &&
    actual?.passed === expected?.passed &&
    actual?.failed === expected?.failed &&
    actual?.warnings === expected?.warnings
}

function nextSteps(manifest) {
  return Array.isArray(manifest?.next_steps) ? manifest.next_steps.filter((step) => typeof step === 'string') : []
}

function addNextStepChecks(checks, manifestPath, manifest, hardGateSummary) {
  const steps = nextSteps(manifest)
  const ready = hardGateSummary?.status === 'pass'
  const readySteps = []
  if (!manifest?.artifacts?.install) {
    const installPath = manifest?.inputs?.out_dir === '.' ? './install.json' : join(manifest?.inputs?.out_dir ?? '', 'install.json')
    readySteps.push(`optional: save installer output as ${installPath} and pass --install-receipt so install evidence travels with the bundle`)
  }
  readySteps.push(NEXT_STEP_ATTACH)
  const exactPolicy = ready ? JSON.stringify(steps) === JSON.stringify(readySteps) : steps.at(-1) === NEXT_STEP_HOLD
  checks.push({
    ok: Array.isArray(manifest?.next_steps),
    component: 'receipt-bundle-check',
    check: 'next_steps_present',
    path: manifestPath,
    count: steps.length,
  })
  checks.push({
    ok: !ready || steps.includes(NEXT_STEP_ATTACH),
    component: 'receipt-bundle-check',
    check: 'next_steps_attach_when_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: ready || !steps.includes(NEXT_STEP_ATTACH),
    component: 'receipt-bundle-check',
    check: 'next_steps_no_attach_when_not_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: ready || steps.includes(NEXT_STEP_HOLD),
    component: 'receipt-bundle-check',
    check: 'next_steps_hold_when_not_ready',
    path: manifestPath,
    ready,
  })
  checks.push({
    ok: (!ready || !steps.includes(NEXT_STEP_HOLD)) && (!ready || exactPolicy),
    component: 'receipt-bundle-check',
    check: 'next_steps_no_hold_when_ready',
    path: manifestPath,
    ready,
  })
  if (manifestStarterMode(manifest)) checks.push({ ok: exactPolicy, component: 'receipt-bundle-check', check: 'next_steps_exact_policy', path: manifestPath, ready })
}

function manifestSchemaExact(manifest) {
  const starter = manifestStarterMode(manifest)
  const topKeys = ['receipt_type', 'generated_at', 'status', 'summary', 'integrity', 'inputs', 'artifacts', 'next_steps', 'checks']
  const inputKeys = ['agents', 'out_dir', 'daemon_config', 'inbox_handler_config', 'control_config', 'install_receipt', 'probe_receipts', 'control_label', 'required_control_verbs', 'exec_probes', 'verify_only', 'skip_host', 'skip_runtime', 'skip_control', ...(starter ? ['bundle_mode'] : [])]
  const artifactKeys = ['out_dir', 'install', 'probes', 'host', 'runtimes', 'controls', 'cutover_gate', 'manifest', ...(starter ? ['service', 'continuous', 'starter'] : [])]
  const metaKeys = ['path', 'receipt_type', 'status', 'sha256']
  if (!hasExactKeys(manifest, topKeys) || !hasExactKeys(manifest.summary, ['status', 'passed', 'failed', 'warnings']) ||
    !hasExactKeys(manifest.integrity, ['algorithm', 'covers', 'excludes']) || !hasExactKeys(manifest.inputs, inputKeys) || !hasExactKeys(manifest.artifacts, artifactKeys) ||
    !Array.isArray(manifest.next_steps) || !Array.isArray(manifest.checks) || !Array.isArray(manifest.artifacts.probes) || !Array.isArray(manifest.artifacts.runtimes) || !Array.isArray(manifest.artifacts.controls)) return false
  const metas = [manifest.artifacts.install, ...manifest.artifacts.probes, manifest.artifacts.host, ...manifest.artifacts.runtimes, ...manifest.artifacts.controls, manifest.artifacts.cutover_gate,
    ...(starter ? [manifest.artifacts.service, manifest.artifacts.continuous, manifest.artifacts.starter] : [])].filter((meta) => meta !== null)
  return metas.every((meta) => hasExactKeys(meta, metaKeys))
}

function addStarterEvidenceValidation(checks, component, artifacts, agents, extra = {}) {
  const evidence = normalizeStarterEvidence({
    serviceReceipt: artifacts.service?.path ? readReceipt(artifacts.service.path) : null,
    continuousReceipt: artifacts.continuous?.path ? readReceipt(artifacts.continuous.path) : null,
    starterReceipt: artifacts.starter?.path ? readReceipt(artifacts.starter.path) : null,
    hostReceipt: artifacts.host?.path ? readReceipt(artifacts.host.path) : null,
    agents,
  })
  checks.push({ ok: Boolean(evidence), component, check: 'starter_evidence_contracts_valid', ...extra })
  return evidence
}

function manifestAgents(manifest) {
  return Array.isArray(manifest?.inputs?.agents) ? manifest.inputs.agents.filter(Boolean) : []
}

function manifestRequiredControlVerbs(manifest) {
  return Array.isArray(manifest?.inputs?.required_control_verbs)
    ? manifest.inputs.required_control_verbs.filter(Boolean)
    : ['start', 'stop']
}

function isPortableExportManifest(manifest) {
  return manifest?.inputs?.out_dir === '.' && manifest?.artifacts?.out_dir === '.'
}

function hasArtifact(entries, predicate) {
  return entries.some((entry) => predicate(entry))
}

function sortStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.length > 0))].sort()
}

function sameStringSet(a, b) {
  return JSON.stringify(sortStrings(a)) === JSON.stringify(sortStrings(b))
}

function artifactBasenames(entries, predicate) {
  return entries
    .filter((entry) => predicate(entry))
    .map((entry) => typeof entry.path === 'string' ? basename(entry.path) : '')
    .filter(Boolean)
}

function receiptInputBasenames(paths) {
  return (paths ?? [])
    .map((path) => typeof path === 'string' ? basename(path) : '')
    .filter(Boolean)
}

function addRequiredEvidenceChecks(checks, manifestPath, entries, agents) {
  const probeEntries = entries.filter((entry) => entry.label.startsWith('probe:'))
  const runtimeEntries = entries.filter((entry) => entry.label.startsWith('runtime:'))
  const controlEntries = entries.filter((entry) => entry.label.startsWith('control:'))
  checks.push({
    ok: agents.length > 0,
    component: 'receipt-bundle-check',
    check: 'selected_agents_recorded',
    path: manifestPath,
    agents,
  })
  checks.push({
    ok: hasArtifact(entries, (entry) => entry.label === 'host'),
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'host',
  })
  checks.push({
    ok: probeEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'probe',
    count: probeEntries.length,
  })
  checks.push({
    ok: runtimeEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'runtime',
    count: runtimeEntries.length,
  })
  checks.push({
    ok: controlEntries.length > 0,
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'control',
    count: controlEntries.length,
  })
  checks.push({
    ok: hasArtifact(entries, (entry) => entry.label === 'cutover_gate'),
    component: 'receipt-bundle-check',
    check: 'required_artifact_present',
    path: manifestPath,
    artifact: 'cutover_gate',
  })

  for (const agentId of agents) {
    const expectedRuntime = `runtime-${safeName(agentId)}.json`
    checks.push({
      ok: runtimeEntries.some((entry) => typeof entry.path === 'string' && basename(entry.path) === expectedRuntime),
      component: 'receipt-bundle-check',
      check: 'runtime_artifact_for_agent',
      path: manifestPath,
      agent_id: agentId,
      expected_file: expectedRuntime,
    })
  }
}

function addBundleModeChecks(checks, manifestPath, manifest, entries) {
  const declaredMode = manifest?.inputs?.bundle_mode
  const starterEntries = entries.filter((entry) => STARTER_RECEIPT_ROLES.some(({ role }) => role === entry.label))
  const hasStarterArtifacts = starterEntries.length > 0
  const validMode = declaredMode === undefined || declaredMode === 'starter-ready'
  checks.push({
    ok: validMode,
    component: 'receipt-bundle-check',
    check: 'bundle_mode_valid',
    path: manifestPath,
    actual: declaredMode ?? null,
    accepted: [null, 'starter-ready'],
  })
  checks.push({
    ok: validMode && ((declaredMode === 'starter-ready') === hasStarterArtifacts),
    component: 'receipt-bundle-check',
    check: 'bundle_mode_matches_artifacts',
    path: manifestPath,
    declared_mode: declaredMode ?? null,
    starter_artifacts: starterEntries.map((entry) => entry.label),
  })

  const declaredPaths = entries
    .map((entry) => typeof entry.path === 'string' && entry.path.length > 0 ? basename(entry.path) : null)
    .filter(Boolean)
  checks.push({
    ok: new Set(declaredPaths).size === declaredPaths.length,
    component: 'receipt-bundle-check',
    check: 'artifact_role_paths_unique',
    path: manifestPath,
    artifact_paths: declaredPaths,
  })

  if (declaredMode !== 'starter-ready' && !hasStarterArtifacts) return
  for (const { role } of STARTER_RECEIPT_ROLES) {
    checks.push({
      ok: entries.filter((entry) => entry.label === role).length === 1,
      component: 'receipt-bundle-check',
      check: 'required_artifact_present',
      path: manifestPath,
      artifact: role,
    })
  }
}

function addBundleDirectoryScopeChecks(checks, manifestPath, manifestDir, entries) {
  const allowed = new Set(['manifest.json'])
  for (const entry of entries) {
    if (typeof entry.path === 'string' && entry.path.length > 0) allowed.add(basename(entry.path))
  }
  for (const sidecar of EXPORT_SIDECAR_RECEIPTS) allowed.add(sidecar.file)
  for (const support of supportingEvidenceEntries(manifestDir, { artifacts: Object.fromEntries(entries.filter((entry) => ['service', 'starter'].includes(entry.label)).map((entry) => [entry.label, entry])) })) {
    allowed.add(basename(support.path))
  }

  let names = []
  try {
    names = readdirSync(manifestDir).sort()
    checks.push({
      ok: true,
      component: 'receipt-bundle-check',
      check: 'bundle_directory_read',
      path: manifestPath,
      directory: manifestDir,
      count: names.length,
    })
  } catch (err) {
    checks.push({
      ok: false,
      component: 'receipt-bundle-check',
      check: 'bundle_directory_read',
      path: manifestPath,
      directory: manifestDir,
      reason: String(err && err.message ? err.message : err),
    })
    return
  }

  const unexpected = names.filter((name) => !allowed.has(name))
  checks.push({
    ok: unexpected.length === 0,
    component: 'receipt-bundle-check',
    check: 'bundle_directory_only_manifest_artifacts',
    path: manifestPath,
    directory: manifestDir,
    allowed: [...allowed].sort(),
    unexpected,
  })
}

function supportingEvidenceEntries(bundleDir, manifest) {
  const entries = []
  const serviceMeta = manifest?.artifacts?.service
  const servicePath = serviceMeta?.path ? resolveArtifactPath(bundleDir, serviceMeta.path) : ''
  const service = servicePath ? readReceipt(servicePath) : null
  for (const definition of Array.isArray(service?.definitions) ? service.definitions : []) {
    if (SERVICE_KEYS.includes(definition?.service) && typeof definition.path === 'string') entries.push({ label: `definition:${definition.service}`, path: resolveArtifactPath(bundleDir, definition.path), sha256: definition.sha256 })
  }
  const starterMeta = manifest?.artifacts?.starter
  const starterPath = starterMeta?.path ? resolveArtifactPath(bundleDir, starterMeta.path) : ''
  const starter = starterPath ? readReceipt(starterPath) : null
  if (typeof starter?.manifest?.path === 'string') entries.push({ label: 'starter_manifest', path: resolveArtifactPath(bundleDir, starter.manifest.path), sha256: starter.manifest.sha256 })
  return entries
}

function addExportSidecarChecks(checks, manifestPath, manifestDir, manifest, opts = {}) {
  const requireSidecars = isPortableExportManifest(manifest) && !opts.allowMissingSidecars
  const manifestHash = fileSha256(manifestPath)

  for (const sidecar of EXPORT_SIDECAR_RECEIPTS) {
    const path = join(manifestDir, sidecar.file)
    const present = existsSync(path)
    if (requireSidecars) {
      checks.push({
        ok: present,
        component: 'receipt-bundle-check',
        check: 'export_sidecar_receipt_present',
        path: manifestPath,
        sidecar: sidecar.file,
        expected: sidecar.receipt_type,
      })
    }
    if (!present) continue

    const receipt = readReceipt(path)
    const expectedKeys = sidecar.file === MANIFEST_CHECK_RECEIPT_FILE
      ? ['receipt_type', 'generated_at', 'status', 'summary', 'inputs', 'manifest', 'checks']
      : ['receipt_type', 'generated_at', 'status', 'summary', 'inputs', 'artifacts', 'manifest_check', 'next_steps', 'checks']
    const nestedSchemaOk = sidecar.file === MANIFEST_CHECK_RECEIPT_FILE
      ? hasExactKeys(receipt?.inputs, ['manifest', 'out_dir']) && (receipt?.manifest === null || hasExactKeys(receipt?.manifest, ['path', 'receipt_type', 'status', 'generated_at', 'sha256']))
      : hasExactKeys(receipt?.inputs, ['manifest', 'out_dir', 'export_dir']) && hasExactKeys(receipt?.artifacts, ['copied', 'sidecars']) && Array.isArray(receipt?.next_steps)
    const schemaExact = hasExactKeys(receipt, expectedKeys) && nestedSchemaOk
    if (manifestStarterMode(manifest)) checks.push({ ok: schemaExact, component: 'receipt-bundle-check', check: 'export_sidecar_schema_exact', path: manifestPath, sidecar: sidecar.file, checked_path: path })
    let sidecarMode = null
    try { sidecarMode = statSync(path).mode & 0o777 } catch {}
    if (manifestStarterMode(manifest)) checks.push({ ok: sidecarMode === 0o600, component: 'receipt-bundle-check', check: 'export_sidecar_permissions_0600', path: manifestPath, sidecar: sidecar.file, mode: sidecarMode })
    checks.push({
      ok: Boolean(receipt) && schemaExact && sidecarMode === 0o600,
      component: 'receipt-bundle-check',
      check: 'export_sidecar_receipt_json_read',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
    })
    checks.push({
      ok: receipt?.receipt_type === sidecar.receipt_type,
      component: 'receipt-bundle-check',
      check: 'export_sidecar_receipt_type_expected',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      expected: sidecar.receipt_type,
      actual: receipt?.receipt_type ?? null,
    })
    checks.push({
      ok: receipt?.status === 'pass',
      component: 'receipt-bundle-check',
      check: 'export_sidecar_status_pass',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      actual: receipt?.status ?? null,
    })
    const sidecarChecks = Array.isArray(receipt?.checks) ? receipt.checks : null
    const sidecarSummary = sidecarChecks ? summarize(sidecarChecks) : null
    checks.push({
      ok: Boolean(sidecarChecks),
      component: 'receipt-bundle-check',
      check: 'export_sidecar_checks_present',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      count: sidecarChecks?.length ?? 0,
    })
    checks.push({
      ok: receipt?.status === sidecarSummary?.status,
      component: 'receipt-bundle-check',
      check: 'export_sidecar_status_matches_checks',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      expected: sidecarSummary?.status ?? null,
      actual: receipt?.status ?? null,
    })
    checks.push({
      ok: sameSummary(receipt?.summary, sidecarSummary),
      component: 'receipt-bundle-check',
      check: 'export_sidecar_summary_matches_checks',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      expected: sidecarSummary,
      actual: receipt?.summary ?? null,
    })

    const sidecarSecretFindings = receipt ? findSecretMaterial(receipt) : []
    checks.push({
      ok: receipt ? sidecarSecretFindings.length === 0 : null,
      component: 'receipt-bundle-check',
      check: 'export_sidecar_no_secret_material',
      path: manifestPath,
      sidecar: sidecar.file,
      checked_path: path,
      findings: secretFindingSummary(sidecarSecretFindings),
      finding_count: sidecarSecretFindings.length,
    })

    if (sidecar.file === MANIFEST_CHECK_RECEIPT_FILE) {
      checks.push({
        ok: receipt?.manifest?.sha256 === manifestHash,
        component: 'receipt-bundle-check',
        check: 'export_sidecar_manifest_hash_matches',
        path: manifestPath,
        sidecar: sidecar.file,
        checked_path: path,
        expected: manifestHash,
        actual: receipt?.manifest?.sha256 ?? null,
      })
    }
    if (sidecar.file === EXPORT_RECEIPT_FILE) {
      checks.push({
        ok: receipt?.manifest_check?.status === 'pass',
        component: 'receipt-bundle-check',
        check: 'export_sidecar_manifest_check_pass',
        path: manifestPath,
        sidecar: sidecar.file,
        checked_path: path,
        actual: receipt?.manifest_check?.status ?? null,
      })
    }
  }
}

function addCutoverGateConsistencyChecks(checks, manifestPath, manifest, entries, receipt) {
  const agents = manifestAgents(manifest)
  const requiredControlVerbs = manifestRequiredControlVerbs(manifest)
  const passingArtifact = (kind) => (entry) =>
    expectedArtifactType(entry.label) === kind && entry.status === 'pass'
  const expectedHost = artifactBasenames(entries, (entry) => entry.label === 'host' && passingArtifact(EXPECTED.host)(entry))
  const actualHost = receipt?.inputs?.host_receipt ? [basename(receipt.inputs.host_receipt)] : []
  const expectedRuntimes = artifactBasenames(entries, passingArtifact(EXPECTED.runtime))
  const actualRuntimes = receiptInputBasenames(receipt?.inputs?.runtime_receipts)
  const expectedControls = artifactBasenames(entries, passingArtifact(EXPECTED.control))
  const actualControls = receiptInputBasenames(receipt?.inputs?.control_receipts)

  checks.push({
    ok: sameStringSet(receipt?.inputs?.agents, agents),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_agents_match_manifest',
    path: manifestPath,
    expected: sortStrings(agents),
    actual: sortStrings(receipt?.inputs?.agents),
  })
  checks.push({
    ok: sameStringSet(receipt?.inputs?.required_control_verbs, requiredControlVerbs),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_required_control_verbs_match_manifest',
    path: manifestPath,
    expected: sortStrings(requiredControlVerbs),
    actual: sortStrings(receipt?.inputs?.required_control_verbs),
  })
  checks.push({
    ok: sameStringSet(actualHost, expectedHost),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_host_artifact_matches_manifest',
    path: manifestPath,
    expected: sortStrings(expectedHost),
    actual: sortStrings(actualHost),
  })
  checks.push({
    ok: sameStringSet(actualRuntimes, expectedRuntimes),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_runtime_artifacts_match_manifest',
    path: manifestPath,
    expected: sortStrings(expectedRuntimes),
    actual: sortStrings(actualRuntimes),
  })
  checks.push({
    ok: sameStringSet(actualControls, expectedControls),
    component: 'receipt-bundle-check',
    check: 'cutover_gate_control_artifacts_match_manifest',
    path: manifestPath,
    expected: sortStrings(expectedControls),
    actual: sortStrings(actualControls),
  })
}

function checkBundleManifest(opts = {}) {
  const checks = []
  const manifestPath = manifestPathForCheck(opts)
  const manifestDir = manifestPath ? dirname(manifestPath) : ''
  let manifest = null

  checks.push({
    ok: Boolean(manifestPath),
    component: 'receipt-bundle-check',
    check: 'manifest_path_selected',
    path: manifestPath || null,
  })

  if (manifestPath) {
    manifest = readReceipt(manifestPath)
    checks.push({
      ok: Boolean(manifest),
      component: 'receipt-bundle-check',
      check: 'manifest_read',
      path: manifestPath,
    })
  }

  if (manifest) {
    const schemaExact = manifestSchemaExact(manifest)
    if (manifestStarterMode(manifest)) checks.push({ ok: schemaExact, component: 'receipt-bundle-check', check: 'manifest_schema_exact', path: manifestPath })
    let manifestMode = null
    try { manifestMode = statSync(manifestPath).mode & 0o777 } catch {}
    if (manifestStarterMode(manifest)) checks.push({ ok: manifestMode === 0o600, component: 'receipt-bundle-check', check: 'manifest_permissions_0600', path: manifestPath, mode: manifestMode })
    const manifestChecks = Array.isArray(manifest.checks) ? manifest.checks : null
    const computedManifestSummary = manifestChecks ? summarize(manifestChecks) : null
    checks.push({
      ok: manifest.receipt_type === 'mupot-fleet-receipt-bundle/v1' && schemaExact && manifestMode === 0o600,
      component: 'receipt-bundle-check',
      check: 'manifest_receipt_type',
      path: manifestPath,
      expected: 'mupot-fleet-receipt-bundle/v1',
      actual: manifest.receipt_type ?? null,
    })
    checks.push({
      ok: manifest.status === 'pass',
      component: 'receipt-bundle-check',
      check: 'manifest_status_pass',
      path: manifestPath,
      actual: manifest.status ?? null,
    })
    checks.push({
      ok: manifest.integrity?.algorithm === 'sha256',
      component: 'receipt-bundle-check',
      check: 'manifest_integrity_algorithm',
      path: manifestPath,
      expected: 'sha256',
      actual: manifest.integrity?.algorithm ?? null,
    })
    checks.push({
      ok: Boolean(manifestChecks),
      component: 'receipt-bundle-check',
      check: 'manifest_checks_present',
      path: manifestPath,
      count: manifestChecks?.length ?? 0,
    })
    checks.push({
      ok: computedManifestSummary?.status === manifest.status,
      component: 'receipt-bundle-check',
      check: 'manifest_status_matches_checks',
      path: manifestPath,
      expected: computedManifestSummary?.status ?? null,
      actual: manifest.status ?? null,
    })
    checks.push({
      ok: sameSummary(manifest.summary, computedManifestSummary),
      component: 'receipt-bundle-check',
      check: 'manifest_summary_matches_checks',
      path: manifestPath,
      expected: computedManifestSummary,
      actual: manifest.summary ?? null,
    })
    const manifestSecretFindings = findSecretMaterial(manifest)
    checks.push({
      ok: manifestSecretFindings.length === 0,
      component: 'receipt-bundle-check',
      check: 'manifest_no_secret_material',
      path: manifestPath,
      findings: secretFindingSummary(manifestSecretFindings),
      finding_count: manifestSecretFindings.length,
    })
    const entries = bundleArtifactEntries(manifest)
    const agents = manifestAgents(manifest)
    const receiptRecords = []
    checks.push({
      ok: entries.length > 0,
      component: 'receipt-bundle-check',
      check: 'artifact_entries_present',
      path: manifestPath,
      count: entries.length,
    })
    if (manifestStarterMode(manifest) || entries.some((entry) => STARTER_RECEIPT_ROLES.some(({ role }) => role === entry.label))) {
      addBundleModeChecks(checks, manifestPath, manifest, entries)
    }
    addRequiredEvidenceChecks(checks, manifestPath, entries, agents)
    addBundleDirectoryScopeChecks(checks, manifestPath, manifestDir, entries)
    addExportSidecarChecks(checks, manifestPath, manifestDir, manifest, opts)
    if (manifestStarterMode(manifest)) {
      const supports = supportingEvidenceEntries(manifestDir, manifest)
      checks.push({ ok: supports.length === 3, component: 'receipt-bundle-check', check: 'portable_supporting_evidence_complete', path: manifestPath, count: supports.length })
      for (const support of supports) {
        let mode = null
        try { mode = statSync(support.path).mode & 0o777 } catch {}
        checks.push({ ok: SHA256_RE.test(support.sha256 ?? '') && fileSha256(support.path) === support.sha256, component: 'receipt-bundle-check', check: 'supporting_evidence_sha256_match', artifact: support.label, path: support.path })
        checks.push({ ok: mode === 0o600, component: 'receipt-bundle-check', check: 'supporting_evidence_permissions_0600', artifact: support.label, mode })
      }
    }

    for (const entry of entries) {
      const expectedLocalPath = typeof entry.path === 'string' && entry.path.length > 0
        ? join(manifestDir, basename(entry.path))
        : ''
      const checkedPath = resolveArtifactPath(manifestDir, entry.path)
      const receipt = checkedPath ? readReceipt(checkedPath) : null
      if (receipt) receiptRecords.push({ label: entry.label, receipt, checkedPath })
      const actual = checkedPath ? fileSha256(checkedPath) : null
      const expectedOk = typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)
      const expectedType = expectedArtifactType(entry.label)
      checks.push({
        ok: typeof entry.path === 'string' && entry.path.length > 0,
        component: 'receipt-bundle-check',
        check: 'artifact_path_recorded',
        artifact: entry.label,
        declared_path: entry.path ?? null,
      })
      checks.push({
        ok: expectedOk,
        component: 'receipt-bundle-check',
        check: 'artifact_sha256_recorded',
        artifact: entry.label,
        declared_path: entry.path ?? null,
      })
      checks.push({
        ok: Boolean(actual),
        component: 'receipt-bundle-check',
        check: 'artifact_file_readable',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
      })
      let artifactMode = null
      try { artifactMode = statSync(checkedPath).mode & 0o777 } catch {}
      if (manifestStarterMode(manifest)) checks.push({ ok: artifactMode === 0o600, component: 'receipt-bundle-check', check: 'artifact_permissions_0600', artifact: entry.label, mode: artifactMode })
      else checks.at(-1).ok = checks.at(-1).ok && artifactMode === 0o600
      checks.push({
        ok: Boolean(expectedLocalPath && checkedPath === expectedLocalPath && existsSync(expectedLocalPath)),
        component: 'receipt-bundle-check',
        check: 'artifact_file_in_bundle_dir',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected_path: expectedLocalPath || null,
      })
      checks.push({
        ok: expectedOk && actual === entry.sha256,
        component: 'receipt-bundle-check',
        check: 'artifact_sha256_match',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.sha256,
        actual,
      })
      checks.push({
        ok: Boolean(receipt),
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_json_read',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
      })
      checks.push({
        ok: receipt?.receipt_type === entry.receipt_type,
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_type_matches_manifest',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.receipt_type,
        actual: receipt?.receipt_type ?? null,
      })
      checks.push({
        ok: !expectedType || receipt?.receipt_type === expectedType,
        component: 'receipt-bundle-check',
        check: 'artifact_receipt_type_expected',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: expectedType,
        actual: receipt?.receipt_type ?? null,
      })
      checks.push({
        ok: receipt?.status === entry.status,
        component: 'receipt-bundle-check',
        check: 'artifact_status_matches_manifest',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        expected: entry.status,
        actual: receipt?.status ?? null,
      })
      checks.push({
        ok: artifactStatusOk(entry.label, receipt?.status),
        component: 'receipt-bundle-check',
        check: 'artifact_status_cutover_ready',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        actual: receipt?.status ?? null,
        accepted: entry.label === 'install' ? ['pass', 'warn'] : ['pass'],
      })
      const secretFindings = receipt ? findSecretMaterial(receipt) : []
      checks.push({
        ok: receipt ? secretFindings.length === 0 : null,
        component: 'receipt-bundle-check',
        check: 'artifact_no_secret_material',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        checked_path: checkedPath || null,
        findings: secretFindingSummary(secretFindings),
        finding_count: secretFindings.length,
      })
      if (entry.label === 'host') {
        addHostReceiptRequiredChecks(checks, {
          component: 'receipt-bundle-check',
          receipt,
          extra: {
            artifact: entry.label,
            declared_path: entry.path ?? null,
            checked_path: checkedPath || null,
          },
        })
      }
      if (entry.label === 'cutover_gate' && receipt) {
        addCutoverGateConsistencyChecks(checks, manifestPath, manifest, entries, receipt)
      }
    }

    addTargetConsistencyChecks(checks, manifestPath, entries, receiptRecords, agents)
    if (manifestStarterMode(manifest)) {
      const contractArtifacts = {}
      for (const role of ['host', 'service', 'continuous', 'starter']) {
        const record = receiptRecords.find((entry) => entry.label === role)
        if (record) contractArtifacts[role] = { path: record.checkedPath }
      }
      addStarterEvidenceValidation(checks, 'receipt-bundle-check', contractArtifacts, agents, { path: manifestPath })
    }
    let directoryMode = null
    try { directoryMode = statSync(manifestDir).mode & 0o777 } catch {}
    if (manifestStarterMode(manifest)) checks.push({ ok: directoryMode === 0o700, component: 'receipt-bundle-check', check: 'bundle_directory_permissions_0700', path: manifestPath, mode: directoryMode })
    else {
      const directoryCheck = checks.find((check) => check.check === 'bundle_directory_read')
      if (directoryCheck) directoryCheck.ok = directoryCheck.ok && directoryMode === 0o700
    }
    addNextStepChecks(checks, manifestPath, manifest, summarize(checks))
  }

  const summary = summarize(checks)
  const receipt = {
    receipt_type: 'mupot-fleet-receipt-bundle-check/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      manifest: manifestPath || null,
      out_dir: opts.outDir ? pathArg(opts.outDir) : null,
    },
    manifest: manifest ? {
      path: manifestPath,
      receipt_type: manifest.receipt_type ?? null,
      status: manifest.status ?? null,
      generated_at: manifest.generated_at ?? null,
      sha256: fileSha256(manifestPath),
    } : null,
    checks,
  }
  return isPortableExportManifest(manifest) ? portableEvidenceValue(receipt, [manifestDir]) : receipt
}

function copyEvidenceFile(source, dest, opts, checks, label) {
  try {
    writeFileSync(dest, readFileSync(source), { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
    chmodSync(dest, 0o600)
    checks.push({
      ok: true,
      component: 'receipt-bundle-export',
      check: `${label}_copied`,
      source,
      path: dest,
      sha256: fileSha256(dest),
    })
    return true
  } catch (err) {
    checks.push({
      ok: false,
      component: 'receipt-bundle-export',
      check: `${label}_copied`,
      source,
      path: dest,
      reason: String(err && err.message ? err.message : err),
    })
    return false
  }
}

function localPathField(key) {
  if (key === 'receipt_type' || String(key).endsWith('_type')) return false
  return /(^|_)(path|dir|directory|config|receipt|receipts|source|manifest)(_|$)/i.test(String(key))
}

function portablePathValue(value, key) {
  if (typeof value !== 'string') return value
  if (key === 'out_dir' || key === 'directory' || key === 'source_dir' || key === 'export_dir') return value ? '.' : value
  if (!localPathField(key)) return value
  if (!value || value === '.' || value.startsWith('<')) return value
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value
  if (value.includes('/') || value.startsWith('~')) return basename(value)
  return value
}

function portableManifestValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => portableManifestValue(item, key))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = portableManifestValue(childValue, childKey)
    }
    return out
  }
  return portablePathValue(value, key)
}

function portableEvidenceValue(value, sourcePrefixes = []) {
  if (Array.isArray(value)) return value.map((item) => portableEvidenceValue(item, sourcePrefixes))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = portableEvidenceValue(child, sourcePrefixes)
    return out
  }
  if (typeof value !== 'string' || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value
  let projected = value
  for (const prefix of sourcePrefixes.filter(Boolean)) projected = projected.split(prefix).join('.')
  if (isAbsolute(projected) || projected.startsWith('~/')) return basename(projected)
  return projected
}

function artifactMetaForLabel(manifest, label) {
  if (label.startsWith('probe:')) return manifest.artifacts.probes[Number(label.split(':')[1]) - 1]
  if (label.startsWith('runtime:')) return manifest.artifacts.runtimes[Number(label.split(':')[1]) - 1]
  if (label.startsWith('control:')) return manifest.artifacts.controls[Number(label.split(':')[1]) - 1]
  return manifest.artifacts[label]
}

function finalizePortableStarterExport(sourceManifest, sourceDir, exportDir, copied) {
  for (const item of copied) {
    if (item.label === 'manifest' || !item.path?.endsWith('.json')) continue
    const receipt = readReceipt(item.path)
    if (!receipt?.receipt_type) continue
    const portable = portableEvidenceValue(receipt, [sourceDir, exportDir])
    writeFileSync(item.path, JSON.stringify(portable, null, 2) + '\n', { mode: 0o600, flag: 'w' })
    chmodSync(item.path, 0o600)
    item.sha256 = fileSha256(item.path)
  }
  const manifest = portableManifestForExport(sourceManifest, sourceDir)
  for (const entry of bundleArtifactEntries(manifest)) {
    const item = copied.find((candidate) => candidate.label === entry.label)
    const meta = artifactMetaForLabel(manifest, entry.label)
    if (item && meta) {
      meta.path = basename(item.path)
      meta.sha256 = item.sha256
    }
  }
  const manifestPath = join(exportDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'w' })
  chmodSync(manifestPath, 0o600)
  const manifestItem = copied.find((item) => item.label === 'manifest')
  if (manifestItem) manifestItem.sha256 = fileSha256(manifestPath)
}

function replaceStringValue(value, needle, replacement) {
  if (Array.isArray(value)) return value.map((item) => replaceStringValue(item, needle, replacement))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = replaceStringValue(childValue, needle, replacement)
    }
    return out
  }
  if (typeof value === 'string' && needle) return value.split(needle).join(replacement)
  return value
}

function portableManifestForExport(manifest, sourceDir = '') {
  let portable = portableManifestValue(manifest)
  if (sourceDir) portable = replaceStringValue(portable, sourceDir, '.')
  if (portable?.artifacts && typeof portable.artifacts === 'object') {
    portable.artifacts.out_dir = '.'
    portable.artifacts.manifest = 'manifest.json'
  }
  if (portable?.inputs && typeof portable.inputs === 'object') {
    portable.inputs.out_dir = '.'
  }
  return portable
}

function writeExportManifest(sourceManifest, dest, opts, checks) {
  const portable = portableManifestForExport(sourceManifest, opts.sourceDir)
  try {
    writeFileSync(dest, JSON.stringify(portable, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
    chmodSync(dest, 0o600)
    checks.push({
      ok: true,
      component: 'receipt-bundle-export',
      check: 'manifest_copied',
      source: 'portable-manifest',
      path: dest,
      sha256: fileSha256(dest),
    })
    return true
  } catch (err) {
    checks.push({
      ok: false,
      component: 'receipt-bundle-export',
      check: 'manifest_copied',
      source: 'portable-manifest',
      path: dest,
      reason: String(err && err.message ? err.message : err),
    })
    return false
  }
}

function portableExportSidecarReceipt(receipt, opts = {}) {
  let portable = portableManifestValue(receipt)
  if (opts.sourceDir) portable = replaceStringValue(portable, opts.sourceDir, '.')
  if (opts.exportDir) portable = replaceStringValue(portable, opts.exportDir, '.')
  return portable
}

function writeExportSidecar(path, receipt, opts, checks, label) {
  try {
    const portable = portableExportSidecarReceipt(receipt, opts)
    writeFileSync(path, JSON.stringify(portable, null, 2) + '\n', { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
    chmodSync(path, 0o600)
    checks.push({
      ok: true,
      component: 'receipt-bundle-export',
      check: 'sidecar_receipt_written',
      sidecar: label,
      path,
      sha256: fileSha256(path),
    })
    return true
  } catch (err) {
    checks.push({
      ok: false,
      component: 'receipt-bundle-export',
      check: 'sidecar_receipt_written',
      sidecar: label,
      path,
      reason: String(err && err.message ? err.message : err),
    })
    return false
  }
}

function overwriteExportSidecar(path, receipt, opts = {}) {
  const portable = portableExportSidecarReceipt(receipt, opts)
  writeFileSync(path, JSON.stringify(portable, null, 2) + '\n', { mode: 0o600, flag: 'w' })
  chmodSync(path, 0o600)
}

function makeExportReceipt({ checks, manifestPath, opts, exportDir, copied, manifestCheck }) {
  const checkSnapshot = JSON.parse(JSON.stringify(checks))
  const summary = summarize(checkSnapshot)
  return {
    receipt_type: 'mupot-fleet-receipt-bundle-export/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      manifest: manifestPath || null,
      out_dir: opts.outDir ? pathArg(opts.outDir) : null,
      export_dir: exportDir || null,
    },
    artifacts: {
      copied,
      sidecars: exportDir ? [
        {
          label: 'export_receipt',
          path: join(exportDir, EXPORT_RECEIPT_FILE),
          receipt_type: 'mupot-fleet-receipt-bundle-export/v1',
        },
        {
          label: 'manifest_check',
          path: join(exportDir, MANIFEST_CHECK_RECEIPT_FILE),
          receipt_type: 'mupot-fleet-receipt-bundle-check/v1',
        },
      ] : [],
    },
    manifest_check: manifestCheck ? {
      status: manifestCheck.status,
      summary: manifestCheck.summary,
      manifest: manifestCheck.manifest,
    } : null,
    next_steps: summary.status === 'pass'
      ? [NEXT_STEP_ATTACH]
      : ['fix the source receipts or export directory, rerun receipt-bundle --export, then attach only the exported directory after it passes'],
    checks: checkSnapshot,
  }
}

function exportBundle(opts = {}) {
  const checks = []
  const manifestPath = manifestPathForCheck(opts)
  const sourceDir = manifestPath ? dirname(manifestPath) : ''
  const exportDir = opts.exportDir ? pathArg(opts.exportDir) : ''
  let manifest = null
  const copied = []

  checks.push({
    ok: Boolean(manifestPath),
    component: 'receipt-bundle-export',
    check: 'source_manifest_selected',
    path: manifestPath || null,
  })
  checks.push({
    ok: Boolean(exportDir),
    component: 'receipt-bundle-export',
    check: 'export_dir_selected',
    path: exportDir || null,
  })
  checks.push({
    ok: Boolean(manifestPath && exportDir && resolve(sourceDir) !== resolve(exportDir)),
    component: 'receipt-bundle-export',
    check: 'export_dir_separate_from_source',
    source_dir: sourceDir || null,
    export_dir: exportDir || null,
  })

  if (manifestPath) {
    manifest = readReceipt(manifestPath)
    checks.push({
      ok: Boolean(manifest),
      component: 'receipt-bundle-export',
      check: 'source_manifest_read',
      path: manifestPath,
    })
  }

  if (exportDir) ensureDir(exportDir, checks)

  if (manifest && exportDir && sourceDir && resolve(sourceDir) !== resolve(exportDir)) {
    const manifestDest = join(exportDir, 'manifest.json')
    if (writeExportManifest(manifest, manifestDest, { ...opts, sourceDir }, checks)) {
      copied.push({ label: 'manifest', source: manifestPath, path: manifestDest, sha256: fileSha256(manifestDest) })
    }

    for (const entry of bundleArtifactEntries(manifest)) {
      const fileName = typeof entry.path === 'string' && entry.path.length > 0 ? basename(entry.path) : ''
      const source = resolveArtifactPath(sourceDir, entry.path)
      const dest = fileName ? join(exportDir, fileName) : ''
      checks.push({
        ok: Boolean(fileName),
        component: 'receipt-bundle-export',
        check: 'artifact_export_name_selected',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        file_name: fileName || null,
      })
      checks.push({
        ok: Boolean(source && existsSync(source)),
        component: 'receipt-bundle-export',
        check: 'artifact_export_source_readable',
        artifact: entry.label,
        declared_path: entry.path ?? null,
        source: source || null,
      })
      if (!fileName || !source || !existsSync(source)) continue
      if (copyEvidenceFile(source, dest, opts, checks, `artifact_${safeName(entry.label)}`)) {
        copied.push({
          label: entry.label,
          source,
          path: dest,
          sha256: fileSha256(dest),
          receipt_type: entry.receipt_type ?? null,
          status: entry.status ?? null,
        })
      }
    }
    if (manifestStarterMode(manifest)) {
      for (const support of supportingEvidenceEntries(sourceDir, manifest)) {
        const dest = join(exportDir, basename(support.path))
        if (fileSha256(support.path) === support.sha256 && copyEvidenceFile(support.path, dest, opts, checks, `support_${safeName(support.label)}`)) {
          copied.push({ label: support.label, source: support.path, path: dest, sha256: fileSha256(dest) })
        } else {
          checks.push({ ok: false, component: 'receipt-bundle-export', check: 'supporting_evidence_sha256_match', artifact: support.label, path: support.path })
        }
      }
    }
    if (manifestStarterMode(manifest)) finalizePortableStarterExport(manifest, sourceDir, exportDir, copied)
  }

  let manifestCheck = exportDir ? checkBundleManifest({ outDir: exportDir, allowMissingSidecars: true }) : null
  checks.push({
    ok: manifestCheck?.status === 'pass',
    component: 'receipt-bundle-export',
    check: 'export_manifest_check_pass',
    export_dir: exportDir || null,
    status: manifestCheck?.status ?? null,
  })

  const exportReceiptPath = exportDir ? join(exportDir, EXPORT_RECEIPT_FILE) : ''
  const manifestCheckPath = exportDir ? join(exportDir, MANIFEST_CHECK_RECEIPT_FILE) : ''
  if (exportDir && manifestCheck) {
    const baseReceipt = makeExportReceipt({ checks, manifestPath, opts, exportDir, copied, manifestCheck })
    const sidecarOpts = { ...opts, sourceDir, exportDir }
    writeExportSidecar(manifestCheckPath, manifestCheck, sidecarOpts, checks, 'manifest_check')
    writeExportSidecar(exportReceiptPath, baseReceipt, sidecarOpts, checks, 'export_receipt')
    manifestCheck = checkBundleManifest({ outDir: exportDir })
    checks.push({
      ok: manifestCheck?.status === 'pass',
      component: 'receipt-bundle-export',
      check: 'export_manifest_check_with_sidecars_pass',
      export_dir: exportDir || null,
      status: manifestCheck?.status ?? null,
    })
  }

  let receipt = makeExportReceipt({ checks, manifestPath, opts, exportDir, copied, manifestCheck })
  if (exportDir && manifestCheck) {
    const sidecarOpts = { ...opts, sourceDir, exportDir }
    try {
      overwriteExportSidecar(manifestCheckPath, manifestCheck, sidecarOpts)
      overwriteExportSidecar(exportReceiptPath, receipt, sidecarOpts)
      checks.push({
        ok: true,
        component: 'receipt-bundle-export',
        check: 'sidecar_receipts_finalized',
        export_receipt: exportReceiptPath,
        manifest_check: manifestCheckPath,
      })
    } catch (err) {
      checks.push({
        ok: false,
        component: 'receipt-bundle-export',
        check: 'sidecar_receipts_finalized',
        export_receipt: exportReceiptPath,
        manifest_check: manifestCheckPath,
        reason: String(err && err.message ? err.message : err),
      })
    }
    receipt = makeExportReceipt({ checks, manifestPath, opts, exportDir, copied, manifestCheck })
    try {
      overwriteExportSidecar(exportReceiptPath, receipt, sidecarOpts)
    } catch {
      // The preceding finalization check captures sidecar write failures.
    }
  }

  return manifestStarterMode(manifest) ? portableEvidenceValue(receipt, [sourceDir, exportDir]) : receipt
}

function firstMeta(path) {
  return existsSync(path) ? receiptMeta(path) : null
}

function starterEvidence(artifacts, agents) {
  const service = artifacts.service?.path ? readReceipt(artifacts.service.path) : null
  const continuous = artifacts.continuous?.path ? readReceipt(artifacts.continuous.path) : null
  const starter = artifacts.starter?.path ? readReceipt(artifacts.starter.path) : null
  const host = artifacts.host?.path ? readReceipt(artifacts.host.path) : null
  return normalizeStarterEvidence({ serviceReceipt: service, continuousReceipt: continuous, starterReceipt: starter, hostReceipt: host, agents })
}

function statusCheck(checks, check, ok, extra = {}) {
  checks.push({ ok, component: 'receipt-bundle-status', check, ...extra })
}

function inferStatusAgents(opts, manifest, artifacts) {
  if ((opts.agents ?? []).length > 0) return sortStrings(opts.agents)
  const manifestIds = manifestAgents(manifest)
  if (manifestIds.length > 0) return sortStrings(manifestIds)

  const ids = []
  for (const meta of artifacts.runtimes ?? []) {
    const receipt = readReceipt(meta.path)
    for (const agent of receiptTargetAgents('runtime:status', receipt)) ids.push(agent)
  }
  for (const meta of artifacts.probes ?? []) {
    const receipt = readReceipt(meta.path)
    for (const agent of receiptTargetAgents('probe:status', receipt)) ids.push(agent)
  }
  return sortStrings(ids)
}

function hasPassingRuntimeMeta(artifacts, agentId) {
  const expected = `runtime-${safeName(agentId)}.json`
  return (artifacts.runtimes ?? []).some((meta) =>
    meta?.receipt_type === EXPECTED.runtime &&
    meta?.status === 'pass' &&
    typeof meta.path === 'string' &&
    basename(meta.path) === expected
  )
}

function passingProbeAgents(artifacts) {
  const agents = []
  for (const meta of artifacts.probes ?? []) {
    if (meta?.receipt_type !== EXPECTED.probe || meta?.status !== 'pass') continue
    const receipt = readReceipt(meta.path)
    agents.push(...receiptTargetAgents('probe:status', receipt))
  }
  return sortStrings(agents)
}

function passingMetaCount(items, expectedType) {
  return (items ?? []).filter((meta) => meta?.receipt_type === expectedType && meta?.status === 'pass').length
}

function requiredStatusControlVerbs(opts, manifest) {
  return sortStrings(manifest ? manifestRequiredControlVerbs(manifest) : (opts.requiredControlVerbs ?? ['start', 'stop']))
}

function controlEvidenceFromArtifacts(artifacts) {
  const receipts = []
  for (const meta of artifacts.controls ?? []) {
    if (meta?.receipt_type !== EXPECTED.control || meta?.status !== 'pass') continue
    const receipt = readReceipt(meta.path)
    if (receipt?.receipt_type === EXPECTED.control && receipt?.status === 'pass') receipts.push(receipt)
  }
  return controlRuns(receipts)
}

function hostReceiptMetaReady(meta) {
  if (meta?.receipt_type !== EXPECTED.host || meta?.status !== 'pass') return false
  return hostReceiptRequiredChecksPass(readReceipt(meta.path))
}

function controlRunSatisfiesRequiredVerb(run, requiredVerb) {
  if (run?.agent_id == null || run?.verb == null) return false
  if (requiredVerb === 'start') return run.verb === 'start' || run.verb === 'restart'
  if (requiredVerb === 'stop') return run.verb === 'stop' || run.verb === 'restart'
  return run.verb === requiredVerb
}

function controlEvidenceForAgent(controlEvidence, agentId) {
  return (controlEvidence ?? []).filter((run) => run?.agent_id === agentId)
}

function matchedControlEvidence(controlEvidence, agentId, requiredVerb) {
  return controlEvidenceForAgent(controlEvidence, agentId)
    .find((run) => controlRunSatisfiesRequiredVerb(run, requiredVerb))
}

function missingControlEvidenceForAgents({ agents, requiredControlVerbs, controlEvidence }) {
  const missing = []
  for (const agentId of agents ?? []) {
    for (const requiredVerb of requiredControlVerbs ?? []) {
      if (!matchedControlEvidence(controlEvidence, agentId, requiredVerb)) missing.push(`${agentId}:${requiredVerb}`)
    }
  }
  return sortStrings(missing)
}

function addHostGoStatusNextSteps(steps, { outDir, artifacts, agents, gateReceipt, manifestCheck, requiredControlVerbs, controlEvidence }) {
  const add = (text) => {
    if (!steps.includes(text)) steps.push(text)
  }
  if (!outDir) {
    add('rerun receipt-bundle --status with --out-dir <bundle>')
    return steps
  }
  if (!existsSync(outDir)) {
    add(`create the bundle with receipt-bundle.mjs --agent <agent_id> --out-dir ${outDir}`)
    return steps
  }
  if (artifacts.install?.receipt_type !== EXPECTED.install || !(artifacts.install.status === 'pass' || artifacts.install.status === 'warn')) {
    add(`save installer output as ${join(outDir, 'install.json')}`)
  }
  if (artifacts.host?.receipt_type !== EXPECTED.host || artifacts.host.status !== 'pass') {
    add('run receipt-bundle without --skip-host after editing host configs and placing keys')
  } else if (!hostReceiptMetaReady(artifacts.host)) {
    add('rerun host receipt with the current fleet-runtime so host.json includes panel_public_key_public_only evidence')
  }
  if (passingMetaCount(artifacts.probes, EXPECTED.probe) === 0) {
    add('queue inbox and lifecycle inputs with cutover-probe.mjs, save probe-*.json, then rerun receipt-bundle with --probe-receipt')
  }
  for (const agentId of agents) {
    if (!hasPassingRuntimeMeta(artifacts, agentId)) {
      add(`run receipt-bundle --skip-host --agent ${agentId} after a queued inbox probe until runtime-${safeName(agentId)}.json is status pass`)
    }
  }
  const missingControls = missingControlEvidenceForAgents({ agents, requiredControlVerbs, controlEvidence })
  if (missingControls.length > 0) {
    add(`queue missing lifecycle control evidence (${missingControls.join(', ')}) with cutover-probe.mjs, then rerun receipt-bundle with --probe-receipt and --control-label`)
  } else if (passingMetaCount(artifacts.controls, EXPECTED.control) === 0) {
    add('queue start and stop lifecycle controls with cutover-probe.mjs, then collect control receipts with --control-label start/stop')
  }
  if (artifacts.cutover_gate?.receipt_type !== EXPECTED.cutover_gate || gateReceipt?.status !== 'pass') {
    add('run receipt-bundle --verify-only after host/runtime/control receipts are present so cutover-gate.json is rebuilt')
  }
  if (artifacts.manifest?.receipt_type !== 'mupot-fleet-receipt-bundle/v1' || artifacts.manifest?.status !== 'pass') {
    add('run receipt-bundle --verify-only so manifest.json records the final evidence state')
  }
  if (artifacts.manifest?.status === 'pass' && manifestCheck?.status !== 'pass') {
    add('run receipt-bundle.mjs --check-manifest --out-dir <bundle> and fix any copied-bundle drift')
  }
  if (hasSecretScanFailures(manifestCheck)) {
    add('remove or redact secret material from receipt JSON, rerun receipt-bundle --verify-only, then rerun --check-manifest before attaching evidence')
  }
  if (hasBundleScopeFailures(manifestCheck)) {
    add('copy only manifest.json and its listed receipt artifacts into the attachable bundle directory, then rerun --check-manifest')
  }
  return steps
}

function hostGoChecklistItem(id, title, ok, nextAction, evidence = {}) {
  return {
    id,
    title,
    status: ok ? 'pass' : 'fail',
    next_action: ok ? null : nextAction,
    ...evidence,
  }
}

function hostGoStatusChecklist({ outDir, artifacts, agents, gateReceipt, manifestCheck, requiredControlVerbs, controlEvidence }) {
  const probeAgents = passingProbeAgents(artifacts)
  const missingProbeAgents = sortStrings((agents ?? []).filter((agentId) => !probeAgents.includes(agentId)))
  const missingRuntimeAgents = sortStrings((agents ?? []).filter((agentId) => !hasPassingRuntimeMeta(artifacts, agentId)))
  const missingControls = missingControlEvidenceForAgents({ agents, requiredControlVerbs, controlEvidence })
  const secretChecks = secretScanChecks(manifestCheck)
  const scopeChecks = bundleScopeChecks(manifestCheck)
  const secretSafe = manifestCheck ? secretChecks.length > 0 && secretChecks.every((check) => check.ok === true) : false
  const scopeSafe = manifestCheck ? scopeChecks.length > 0 && scopeChecks.every((check) => check.ok === true) : false
  const manifestPass = artifacts.manifest?.receipt_type === 'mupot-fleet-receipt-bundle/v1' && artifacts.manifest?.status === 'pass'
  const gatePass = artifacts.cutover_gate?.receipt_type === EXPECTED.cutover_gate && gateReceipt?.status === 'pass'
  const manifestCheckPass = manifestCheck?.status === 'pass'
  const installOk = artifacts.install?.receipt_type === EXPECTED.install && (artifacts.install?.status === 'pass' || artifacts.install?.status === 'warn')
  const hostOk = hostReceiptMetaReady(artifacts.host)

  return [
    hostGoChecklistItem(
      'bundle_directory_ready',
      'Bundle directory exists for the host-go run',
      Boolean(outDir && existsSync(outDir)),
      'Run receipt-bundle.mjs with --out-dir <bundle-dir> on the target host.',
      { path: outDir || null },
    ),
    hostGoChecklistItem(
      'selected_agents_named',
      'Selected agent(s) are named in the evidence',
      (agents ?? []).length > 0,
      'Pass --agent <agent_id> or rebuild the manifest so selected agents are recorded.',
      { agents },
    ),
    hostGoChecklistItem(
      'install_receipt_saved',
      'Installer receipt is saved with status pass or warn',
      installOk,
      'Run fleet-runtime/install.mjs or npm run fleet:install on the target host and save install.json.',
      { path: artifacts.install?.path ?? (outDir ? join(outDir, 'install.json') : null), receipt_type: artifacts.install?.receipt_type ?? null, receipt_status: artifacts.install?.status ?? null },
    ),
    hostGoChecklistItem(
      'host_receipt_passed',
      'Host config, keys, panel public key, and runtime layout pass host receipt checks',
      hostOk,
      'Edit daemon/control/inbox/flights config for the real pot, place keys, then rerun receipt-bundle without --skip-host.',
      { path: artifacts.host?.path ?? (outDir ? join(outDir, 'host.json') : null), receipt_type: artifacts.host?.receipt_type ?? null, receipt_status: artifacts.host?.status ?? null },
    ),
    hostGoChecklistItem(
      'probe_receipts_passed_for_agents',
      'Cutover probe queued inbox and lifecycle inputs for every selected agent',
      (agents ?? []).length > 0 && missingProbeAgents.length === 0,
      'Run cutover-probe.mjs for each selected agent, save probe-*.json, then rerun receipt-bundle with --probe-receipt.',
      { passing_agents: probeAgents, missing_agents: missingProbeAgents },
    ),
    hostGoChecklistItem(
      'runtime_receipts_passed_for_agents',
      'Runtime receipt proves signed attach and inbox handoff for every selected agent',
      (agents ?? []).length > 0 && missingRuntimeAgents.length === 0,
      'Run receipt-bundle after a queued inbox probe until runtime-<agent_id>.json is status pass for each selected agent.',
      { missing_agents: missingRuntimeAgents },
    ),
    hostGoChecklistItem(
      'control_receipts_passed_for_required_verbs',
      'Lifecycle control receipt evidence covers every required agent/verb',
      (agents ?? []).length > 0 && missingControls.length === 0,
      'Queue missing lifecycle controls with cutover-probe.mjs, then collect control receipts with --control-label.',
      { required_control_verbs: requiredControlVerbs, missing: missingControls },
    ),
    hostGoChecklistItem(
      'cutover_gate_passed',
      'cutover-gate.json reports status pass',
      gatePass,
      'Run receipt-bundle --verify-only after host/runtime/control receipts are present so cutover-gate.json is rebuilt.',
      { path: artifacts.cutover_gate?.path ?? (outDir ? join(outDir, 'cutover-gate.json') : null), receipt_status: gateReceipt?.status ?? null },
    ),
    hostGoChecklistItem(
      'manifest_passed',
      'manifest.json reports status pass',
      manifestPass,
      'Run receipt-bundle --verify-only so manifest.json records the final evidence state.',
      { path: artifacts.manifest?.path ?? (outDir ? join(outDir, 'manifest.json') : null), receipt_status: artifacts.manifest?.status ?? null },
    ),
    hostGoChecklistItem(
      'attachable_manifest_check_passed',
      'Read-only manifest check passes for the current evidence directory',
      manifestCheckPass,
      'Run receipt-bundle.mjs --export, then run --check-manifest against the exported attachable directory.',
      { manifest_check_status: manifestCheck?.status ?? null },
    ),
    hostGoChecklistItem(
      'attachable_bundle_safe',
      'Attachable bundle is self-contained and secret-free',
      manifestCheckPass && secretSafe && scopeSafe,
      'Attach only the exported directory after secret scan and self-contained directory checks pass.',
      {
        secret_scan_passed: secretSafe,
        directory_scope_passed: scopeSafe,
        secret_scan_failures: secretChecks.filter((check) => check.ok === false).length,
        directory_scope_failures: scopeChecks.filter((check) => check.ok === false).length,
      },
    ),
  ]
}

function formatStatusSummary(receipt) {
  const lines = []
  lines.push(`Host-go status: ${receipt?.status ?? 'unknown'}`)
  lines.push(`Bundle: ${receipt?.inputs?.out_dir ?? '<none>'}`)
  lines.push(`Agents: ${(receipt?.inputs?.agents ?? []).join(', ') || '<none>'}`)
  lines.push(`Required controls: ${(receipt?.inputs?.required_control_verbs ?? []).join(', ') || '<none>'}`)
  if (receipt?.starter_ready) {
    const definitionHashes = Object.entries(receipt.starter_ready.definition_hashes ?? {})
      .map(([service, digest]) => `${service}=${digest}`)
      .join(', ') || '<none>'
    lines.push(`Service manager: ${receipt.starter_ready.service_manager ?? '<none>'}`)
    lines.push(`Definition hashes: ${definitionHashes}`)
    lines.push(`Observed deltas: heartbeat tick=${receipt.starter_ready.observed_deltas?.heartbeat_tick ?? '<none>'}, control poll=${receipt.starter_ready.observed_deltas?.control_poll ?? '<none>'}`)
    lines.push(`Starter manifest: ${receipt.starter_ready.starter_manifest_sha256 ?? '<none>'}`)
  }
  lines.push('')
  lines.push('Checklist:')
  for (const item of receipt?.host_go_checklist ?? []) {
    const label = item.status === 'pass' ? 'PASS' : 'FAIL'
    lines.push(`- [${label}] ${item.id}: ${item.title}`)
    if (item.status !== 'pass' && item.next_action) lines.push(`  next: ${item.next_action}`)
    if (Array.isArray(item.missing) && item.missing.length > 0) lines.push(`  missing: ${item.missing.join(', ')}`)
    if (Array.isArray(item.missing_agents) && item.missing_agents.length > 0) lines.push(`  missing agents: ${item.missing_agents.join(', ')}`)
  }
  if ((receipt?.next_steps ?? []).length > 0) {
    lines.push('')
    lines.push('Next steps:')
    for (const step of receipt.next_steps) lines.push(`- ${step}`)
  }
  return `${lines.join('\n')}\n`
}

function inspectBundleStatus(opts = {}) {
  const checks = []
  const outDir = opts.outDir ? pathArg(opts.outDir) : ''
  statusCheck(checks, 'out_dir_selected', Boolean(outDir), { out_dir: outDir || null })
  statusCheck(checks, 'out_dir_exists', Boolean(outDir && existsSync(outDir)), { out_dir: outDir || null })

  const manifestPath = outDir ? join(outDir, 'manifest.json') : ''
  const manifest = manifestPath && existsSync(manifestPath) ? readReceipt(manifestPath) : null
  const starterFilesPresent = outDir && STARTER_RECEIPT_ROLES.some(({ file }) => existsSync(join(outDir, file)))
  const starterMode = manifestStarterMode(manifest) || Boolean(starterFilesPresent)
  const artifacts = {
    out_dir: outDir || null,
    install: outDir ? firstMeta(join(outDir, 'install.json')) : null,
    probes: outDir ? listReceiptFiles(outDir, 'probe-').map(receiptMeta) : [],
    host: outDir ? firstMeta(join(outDir, 'host.json')) : null,
    runtimes: outDir ? listReceiptFiles(outDir, 'runtime-').map(receiptMeta) : [],
    controls: outDir ? listReceiptFiles(outDir, 'control-').map(receiptMeta) : [],
    cutover_gate: outDir ? firstMeta(join(outDir, 'cutover-gate.json')) : null,
    manifest: outDir ? firstMeta(manifestPath) : null,
    ...(starterMode ? {
      service: outDir ? firstMeta(join(outDir, 'service.json')) : null,
      continuous: outDir ? firstMeta(join(outDir, 'continuous.json')) : null,
      starter: outDir ? firstMeta(join(outDir, 'starter.json')) : null,
    } : {}),
  }
  const agents = inferStatusAgents(opts, manifest, artifacts)
  const gateReceipt = outDir ? readReceipt(join(outDir, 'cutover-gate.json')) : null
  const manifestCheck = manifest ? checkBundleManifest({ manifestPath }) : null
  const requiredControlVerbs = requiredStatusControlVerbs(opts, manifest)
  const controlEvidence = controlEvidenceFromArtifacts(artifacts)
  const hostReceipt = artifacts.host?.path ? readReceipt(artifacts.host.path) : null

  statusCheck(checks, 'selected_agents_recorded', agents.length > 0, { agents })
  statusCheck(checks, 'install_receipt_present', artifacts.install?.receipt_type === EXPECTED.install, {
    path: artifacts.install?.path ?? join(outDir || '<out-dir>', 'install.json'),
    actual: artifacts.install?.receipt_type ?? null,
  })
  statusCheck(checks, 'install_receipt_non_fail', artifacts.install?.status === 'pass' || artifacts.install?.status === 'warn', {
    actual: artifacts.install?.status ?? null,
    accepted: ['pass', 'warn'],
  })
  statusCheck(checks, 'host_receipt_pass', artifacts.host?.receipt_type === EXPECTED.host && artifacts.host?.status === 'pass', {
    path: artifacts.host?.path ?? join(outDir || '<out-dir>', 'host.json'),
    receipt_type: artifacts.host?.receipt_type ?? null,
    status: artifacts.host?.status ?? null,
  })
  addHostReceiptRequiredChecks(checks, {
    component: 'receipt-bundle-status',
    receipt: hostReceipt,
    extra: { path: artifacts.host?.path ?? join(outDir || '<out-dir>', 'host.json') },
  })
  if (starterMode) {
    statusCheck(checks, 'bundle_mode_starter_ready', manifestStarterMode(manifest), {
      actual: manifest?.inputs?.bundle_mode ?? null,
    })
    for (const { role } of STARTER_RECEIPT_ROLES) {
      const meta = artifacts[role]
      statusCheck(checks, `${role}_receipt_pass`, meta?.receipt_type === EXPECTED[role] && meta?.status === 'pass', {
        path: meta?.path ?? join(outDir || '<out-dir>', `${role}.json`),
        receipt_type: meta?.receipt_type ?? null,
        status: meta?.status ?? null,
      })
    }
    addStarterEvidenceValidation(checks, 'receipt-bundle-status', artifacts, agents)
  }
  statusCheck(checks, 'probe_receipt_pass_present', passingMetaCount(artifacts.probes, EXPECTED.probe) > 0, {
    count: artifacts.probes.length,
    passing: passingMetaCount(artifacts.probes, EXPECTED.probe),
  })
  for (const agentId of agents) {
    statusCheck(checks, 'runtime_receipt_pass_for_agent', hasPassingRuntimeMeta(artifacts, agentId), {
      agent_id: agentId,
      expected_file: `runtime-${safeName(agentId)}.json`,
    })
  }
  statusCheck(checks, 'control_receipt_pass_present', passingMetaCount(artifacts.controls, EXPECTED.control) > 0, {
    count: artifacts.controls.length,
    passing: passingMetaCount(artifacts.controls, EXPECTED.control),
  })
  for (const agentId of agents) {
    const agentControlEvidence = controlEvidenceForAgent(controlEvidence, agentId)
    for (const requiredVerb of requiredControlVerbs) {
      const match = matchedControlEvidence(controlEvidence, agentId, requiredVerb)
      statusCheck(checks, 'control_verb_for_agent', Boolean(match), {
        agent_id: agentId,
        required_verb: requiredVerb,
        matched_verb: match?.verb ?? null,
        matched_action: match?.action ?? null,
        evidence_verbs: sortStrings(agentControlEvidence.map((run) => run.verb)),
      })
    }
  }
  statusCheck(checks, 'cutover_gate_pass', artifacts.cutover_gate?.receipt_type === EXPECTED.cutover_gate && gateReceipt?.status === 'pass', {
    path: artifacts.cutover_gate?.path ?? join(outDir || '<out-dir>', 'cutover-gate.json'),
    receipt_type: artifacts.cutover_gate?.receipt_type ?? null,
    status: gateReceipt?.status ?? null,
  })
  statusCheck(checks, 'manifest_pass', artifacts.manifest?.receipt_type === 'mupot-fleet-receipt-bundle/v1' && artifacts.manifest?.status === 'pass', {
    path: artifacts.manifest?.path ?? join(outDir || '<out-dir>', 'manifest.json'),
    receipt_type: artifacts.manifest?.receipt_type ?? null,
    status: artifacts.manifest?.status ?? null,
  })
  statusCheck(checks, 'manifest_check_pass', manifestCheck?.status === 'pass', {
    path: manifestPath || null,
    status: manifestCheck?.status ?? null,
  })
  const manifestSecretChecks = secretScanChecks(manifestCheck)
  statusCheck(checks, 'copied_bundle_no_secret_material', manifestCheck ? manifestSecretChecks.length > 0 && manifestSecretChecks.every((check) => check.ok === true) : null, {
    path: manifestPath || null,
    failed: manifestSecretChecks.filter((check) => check.ok === false).length,
    warnings: manifestSecretChecks.filter((check) => check.ok === null).length,
  })
  const manifestScopeChecks = bundleScopeChecks(manifestCheck)
  statusCheck(checks, 'copied_bundle_only_manifest_artifacts', manifestCheck ? manifestScopeChecks.length > 0 && manifestScopeChecks.every((check) => check.ok === true) : null, {
    path: manifestPath || null,
    failed: manifestScopeChecks.filter((check) => check.ok === false).length,
    warnings: manifestScopeChecks.filter((check) => check.ok === null).length,
  })

  const summary = summarize(checks)
  const next = buildNextSteps({
    artifacts,
    agents,
    gateReceipt,
    outDir: outDir || '<out-dir>',
    bundleStatus: summary.status,
    requiredControlVerbs,
    controlEvidence,
  })
  addHostGoStatusNextSteps(next, { outDir, artifacts, agents, gateReceipt, manifestCheck, requiredControlVerbs, controlEvidence })
  const hostGoChecklist = hostGoStatusChecklist({ outDir, artifacts, agents, gateReceipt, manifestCheck, requiredControlVerbs, controlEvidence })

  const receipt = {
    receipt_type: 'mupot-fleet-receipt-bundle-status/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    inputs: {
      out_dir: outDir || null,
      agents,
      required_control_verbs: requiredControlVerbs,
    },
    artifacts,
    manifest_check: manifestCheck ? {
      status: manifestCheck.status,
      summary: manifestCheck.summary,
      manifest: manifestCheck.manifest,
    } : null,
    host_go_checklist: hostGoChecklist,
    ...(starterMode ? { starter_ready: starterEvidence(artifacts, agents) } : {}),
    next_steps: next,
    checks,
  }
  return isPortableExportManifest(manifest) ? portableEvidenceValue(receipt, [outDir]) : receipt
}

function addReceiptStatusCheck(checks, label, path, receipt, expectedType) {
  checks.push({
    ok: receipt?.receipt_type === expectedType,
    component: 'receipt-bundle',
    check: `${label}_receipt_type`,
    path,
    expected: expectedType,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass',
    component: 'receipt-bundle',
    check: `${label}_receipt_status_pass`,
    path,
    actual: receipt?.status ?? null,
  })
}

function addInstallReceiptStatusChecks(checks, path, receipt) {
  checks.push({
    ok: receipt?.receipt_type === EXPECTED.install,
    component: 'receipt-bundle',
    check: 'install_receipt_type',
    path,
    expected: EXPECTED.install,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass' || receipt?.status === 'warn',
    component: 'receipt-bundle',
    check: 'install_receipt_status_non_fail',
    path,
    accepted: ['pass', 'warn'],
    actual: receipt?.status ?? null,
  })
}

function addProbeReceiptStatusChecks(checks, path, receipt) {
  checks.push({
    ok: receipt?.receipt_type === EXPECTED.probe,
    component: 'receipt-bundle',
    check: 'probe_receipt_type',
    path,
    expected: EXPECTED.probe,
    actual: receipt?.receipt_type ?? null,
  })
  checks.push({
    ok: receipt?.status === 'pass',
    component: 'receipt-bundle',
    check: 'probe_receipt_status_pass',
    path,
    actual: receipt?.status ?? null,
  })
}

async function runAndWrite(label, path, builder, builderOpts, opts, checks) {
  try {
    const receipt = await builder(builderOpts)
    const wrote = writeJson(path, receipt, opts, checks, label)
    if (wrote) addReceiptStatusCheck(checks, label, path, receipt, EXPECTED[label])
    return { path, receipt, wrote }
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: `${label}_receipt_build`, path, reason: String(err && err.message ? err.message : err) })
    return { path, receipt: null, wrote: false }
  }
}

function includeInstallReceipt(outDir, opts, checks) {
  const dest = join(outDir, 'install.json')
  const source = opts.installReceiptPath ? pathArg(opts.installReceiptPath) : ''
  if (!source) {
    if (!existsSync(dest)) return null
    const receipt = readReceipt(dest)
    checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_reused', path: dest })
    addInstallReceiptStatusChecks(checks, dest, receipt)
    return receiptMeta(dest)
  }

  let receipt = readReceipt(source)
  if (!receipt) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'install_receipt_read', path: source, reason: 'invalid_or_unreadable_json' })
    return { path: dest, receipt_type: null, status: null }
  }

  checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_read', path: source })

  if (resolve(source) === resolve(dest)) {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'install_receipt_reused', path: dest })
    addInstallReceiptStatusChecks(checks, dest, receipt)
    return receiptMeta(dest)
  }

  const wrote = writeJson(dest, receipt, opts, checks, 'install')
  if (!wrote) return existsSync(dest) ? receiptMeta(dest) : { path: dest, receipt_type: null, status: null }
  addInstallReceiptStatusChecks(checks, dest, receipt)
  return receiptMeta(dest)
}

function includeStarterReceipt(outDir, opts, checks, roleSpec) {
  const { role, option, file } = roleSpec
  const source = opts[option] ? pathArg(opts[option]) : ''
  const dest = join(outDir, file)
  checks.push({
    ok: Boolean(source),
    component: 'receipt-bundle',
    check: `${role}_receipt_present`,
    path: source || null,
  })
  if (!source) return null

  let receipt = readReceipt(source)
  checks.push({
    ok: Boolean(receipt),
    component: 'receipt-bundle',
    check: `${role}_receipt_read`,
    path: source,
  })
  if (!receipt) {
    addReceiptStatusCheck(checks, role, source, null, EXPECTED[role])
    checks.push({ ok: false, component: 'receipt-bundle', check: `${role}_receipt_no_secret_material`, path: source, findings: [], finding_count: 0 })
    return { path: dest, receipt_type: null, status: null, sha256: null }
  }

  if (role === 'service' && Array.isArray(receipt.definitions)) {
    const definitions = receipt.definitions.map((definition) => {
      const supportSource = typeof definition?.path === 'string' ? pathArg(definition.path) : ''
      const supportDest = supportSource ? join(outDir, basename(supportSource)) : ''
      const digestOk = Boolean(supportSource && fileSha256(supportSource) === definition.sha256)
      checks.push({ ok: digestOk, component: 'receipt-bundle', check: 'service_definition_source_sha256_match', service: definition?.service ?? null, path: supportSource || null })
      if (digestOk) copyEvidenceFile(supportSource, supportDest, { ...opts, force: true }, checks, `service_definition_${safeName(definition.service)}`)
      return { ...definition, path: supportDest ? basename(supportDest) : definition.path }
    })
    receipt = { ...receipt, definitions }
  }
  if (role === 'starter' && typeof receipt.manifest?.path === 'string') {
    const supportSource = resolve(dirname(source), receipt.manifest.path)
    const supportDest = join(outDir, basename(receipt.manifest.path))
    const digestOk = fileSha256(supportSource) === receipt.manifest.sha256
    checks.push({ ok: digestOk, component: 'receipt-bundle', check: 'starter_manifest_source_sha256_match', path: supportSource })
    if (digestOk) copyEvidenceFile(supportSource, supportDest, { ...opts, force: true }, checks, 'starter_manifest')
    receipt = { ...receipt, manifest: { ...receipt.manifest, path: basename(receipt.manifest.path) } }
  }

  if (resolve(source) === resolve(dest)) {
    checks.push({ ok: true, component: 'receipt-bundle', check: `${role}_receipt_reused`, path: dest })
  } else {
    writeJson(dest, receipt, opts, checks, role)
  }
  addReceiptStatusCheck(checks, role, source, receipt, EXPECTED[role])
  const secretFindings = findSecretMaterial(receipt)
  checks.push({
    ok: secretFindings.length === 0,
    component: 'receipt-bundle',
    check: `${role}_receipt_no_secret_material`,
    path: source,
    findings: secretFindingSummary(secretFindings),
    finding_count: secretFindings.length,
  })
  return existsSync(dest) ? receiptMeta(dest) : { path: dest, receipt_type: null, status: null, sha256: null }
}

function probeDestPath(outDir, source, index) {
  const raw = basename(source || `probe-${index + 1}.json`).replace(/\.json$/i, '')
  const safe = safeName(raw) || `probe-${index + 1}`
  const file = safe.startsWith('probe-') ? `${safe}.json` : `probe-${safe}.json`
  return join(outDir, file)
}

function includeProbeReceipts(outDir, opts, checks) {
  const sources = opts.probeReceiptPaths ?? []
  const metas = []
  if (sources.length === 0) {
    for (const path of listReceiptFiles(outDir, 'probe-')) {
      const receipt = readReceipt(path)
      checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_reused', path })
      addProbeReceiptStatusChecks(checks, path, receipt)
      metas.push(receiptMeta(path))
    }
    return metas
  }

  sources.forEach((source, index) => {
    const dest = probeDestPath(outDir, source, index)
    const receipt = readReceipt(source)
    if (!receipt) {
      checks.push({ ok: false, component: 'receipt-bundle', check: 'probe_receipt_read', path: source, reason: 'invalid_or_unreadable_json' })
      metas.push({ path: dest, receipt_type: null, status: null })
      return
    }
    checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_read', path: source })

    if (resolve(source) === resolve(dest)) {
      checks.push({ ok: true, component: 'receipt-bundle', check: 'probe_receipt_reused', path: dest })
      addProbeReceiptStatusChecks(checks, dest, receipt)
      metas.push(receiptMeta(dest))
      return
    }

    const wrote = writeJson(dest, receipt, opts, checks, 'probe')
    if (wrote) addProbeReceiptStatusChecks(checks, dest, receipt)
    metas.push(existsSync(dest) ? receiptMeta(dest) : { path: dest, receipt_type: null, status: null })
  })
  return metas
}

function listReceiptFiles(outDir, prefix) {
  if (!existsSync(outDir)) return []
  return readdirSync(outDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => join(outDir, name))
    .sort()
}

function secureBundleJsonFiles(outDir) {
  if (!existsSync(outDir)) return
  chmodSync(outDir, 0o700)
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.json')) chmodSync(join(outDir, name), 0o600)
  }
}

function passPaths(paths, expectedType, checks, label) {
  const selected = []
  for (const path of paths) {
    const meta = receiptMeta(path)
    const typeOk = meta.receipt_type === expectedType
    const passOk = meta.status === 'pass'
    const receipt = label === 'host' ? readReceipt(path) : null
    const requiredOk = label !== 'host' || hostReceiptRequiredChecksPass(receipt)
    if (label === 'host') {
      addHostReceiptRequiredChecks(checks, {
        component: 'receipt-bundle',
        receipt,
        extra: { path },
      })
    }
    if (typeOk && passOk && requiredOk) {
      selected.push(path)
      checks.push({ ok: true, component: 'receipt-bundle', check: `${label}_candidate_selected`, path })
    } else {
      checks.push({
        ok: null,
        component: 'receipt-bundle',
        check: `${label}_candidate_ignored`,
        path,
        receipt_type: meta.receipt_type,
        status: meta.status,
        required_checks_pass: requiredOk,
      })
    }
  }
  return selected
}

function hasPassingRuntimeForAgent(artifacts, agentId) {
  const expectedName = `runtime-${safeName(agentId)}.json`
  return (artifacts.runtimes ?? []).some((meta) =>
    meta?.status === 'pass' && typeof meta.path === 'string' && basename(meta.path) === expectedName
  )
}

function missingControlVerbs(gateReceipt) {
  const missing = []
  for (const check of gateReceipt?.checks ?? []) {
    if (check?.component !== 'cutover-receipt') continue
    if (check?.check !== 'control_verb_for_agent' || check?.ok !== false) continue
    const agent = check.agent_id ?? 'unknown-agent'
    const verb = check.required_verb ?? 'required-control'
    missing.push(`${agent}:${verb}`)
  }
  return [...new Set(missing)].sort()
}

function buildNextSteps({ artifacts, agents, gateReceipt, outDir, bundleStatus, requiredControlVerbs, controlEvidence }) {
  const steps = []
  const add = (text) => {
    if (!steps.includes(text)) steps.push(text)
  }

  if ((agents ?? []).length === 0) {
    add('rerun receipt-bundle with --agent <agent_id>')
  }

  if (!artifacts.install) {
    add(`optional: save installer output as ${join(outDir, 'install.json')} and pass --install-receipt so install evidence travels with the bundle`)
  } else if (artifacts.install.status !== 'pass' && artifacts.install.status !== 'warn') {
    add('rerun fleet-runtime/install.mjs and pass a valid mupot-fleet-install-receipt/v1 with status pass or warn')
  }

  if ((artifacts.probes ?? []).length === 0) {
    add('queue inbox and lifecycle evidence with cutover-probe.mjs, save probe-*.json, and rerun receipt-bundle with --probe-receipt')
  }
  for (const probe of artifacts.probes ?? []) {
    if (probe?.status !== 'pass') {
      add('rerun cutover-probe.mjs for the failed probe and pass the new receipt with --probe-receipt')
    }
  }

  if (artifacts.host?.receipt_type !== EXPECTED.host || artifacts.host?.status !== 'pass') {
    add('edit host configs, place keys, then rerun receipt-bundle without --skip-host until host.json is status pass')
  } else if (!hostReceiptMetaReady(artifacts.host)) {
    add('rerun host receipt with the current fleet-runtime so host.json includes panel_public_key_public_only evidence')
  }

  for (const agentId of agents ?? []) {
    if (!hasPassingRuntimeForAgent(artifacts, agentId)) {
      add(`queue an inbox probe for ${agentId}, then rerun receipt-bundle with --skip-host and --agent ${agentId} until runtime-${safeName(agentId)}.json is status pass`)
    }
  }

  const missingControls = sortStrings([
    ...missingControlVerbs(gateReceipt),
    ...missingControlEvidenceForAgents({ agents, requiredControlVerbs, controlEvidence }),
  ])
  if (missingControls.length > 0) {
    add(`queue missing lifecycle control evidence (${missingControls.join(', ')}) with cutover-probe.mjs, then rerun receipt-bundle with --probe-receipt and --control-label`)
  } else if ((artifacts.controls ?? []).length === 0) {
    add('queue lifecycle control with cutover-probe.mjs and rerun receipt-bundle with --control-label start/stop, or one restart receipt when acceptable')
  }

  if (bundleStatus !== 'pass' || gateReceipt?.status !== 'pass') {
    add(NEXT_STEP_HOLD)
  }

  if (bundleStatus === 'pass' && gateReceipt?.status === 'pass') {
    add(NEXT_STEP_ATTACH)
  }

  return steps
}

async function buildBundle(opts) {
  validateStarterReceiptOptions(opts, { rejectReadOnlyModes: true })
  const checks = []
  const stamp = opts.stamp ?? defaultStamp()
  const outDir = opts.outDir ? pathArg(opts.outDir) : join(homedir(), '.fleet', 'receipts', stamp)
  const agents = [...new Set(opts.agents ?? [])]
  const verifyOnly = Boolean(opts.verifyOnly)
  const starterMode = starterModeSelected(opts)
  const skipHost = Boolean(opts.skipHost || verifyOnly)
  const skipRuntime = Boolean(opts.skipRuntime || verifyOnly)
  const skipControl = Boolean(opts.skipControl || verifyOnly)
  checks.push({ ok: agents.length > 0, component: 'receipt-bundle', check: 'selected_agents_present', agents })
  ensureDir(outDir, checks)

  const hostBuilder = opts.hostBuilder ?? buildHostReceipt
  const runtimeBuilder = opts.runtimeBuilder ?? buildRuntimeReceipt
  const controlBuilder = opts.controlBuilder ?? buildControlReceipt
  const cutoverBuilder = opts.cutoverBuilder ?? buildCutoverReceipt

  const artifacts = {
    out_dir: outDir,
    install: null,
    probes: [],
    host: null,
    runtimes: [],
    controls: [],
    cutover_gate: null,
    manifest: join(outDir, 'manifest.json'),
    ...(starterMode ? { service: null, continuous: null, starter: null } : {}),
  }

  artifacts.install = includeInstallReceipt(outDir, opts, checks)
  artifacts.probes = includeProbeReceipts(outDir, opts, checks)
  if (starterMode) {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'starter_ready_mode_selected' })
    for (const roleSpec of STARTER_RECEIPT_ROLES) {
      artifacts[roleSpec.role] = includeStarterReceipt(outDir, opts, checks, roleSpec)
    }
  }
  checks.push({
    ok: artifacts.probes.some((probe) => probe?.status === 'pass'),
    component: 'receipt-bundle',
    check: 'probe_receipt_present',
    count: artifacts.probes.length,
  })

  if (!skipHost) {
    const path = join(outDir, 'host.json')
    const result = await runAndWrite('host', path, hostBuilder, {
      daemonPath: opts.daemonPath,
      inboxPath: opts.inboxPath,
      controlPath: opts.controlPath,
      skipInbox: false,
      skipControl: false,
      execProbes: Boolean(opts.execProbes),
      ...(opts.hostOptions ?? {}),
    }, opts, checks)
    artifacts.host = receiptMeta(result.path)
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'host_receipt_reused' })
    artifacts.host = receiptMeta(join(outDir, 'host.json'))
  }

  if (!skipRuntime) {
    for (const agentId of agents) {
      const path = join(outDir, `runtime-${safeName(agentId)}.json`)
      const result = await runAndWrite('runtime', path, runtimeBuilder, {
        daemonPath: opts.daemonPath,
        agents: [agentId],
        ...(opts.runtimeOptions ?? {}),
      }, opts, checks)
      artifacts.runtimes.push({ agent_id: agentId, ...receiptMeta(result.path) })
    }
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'runtime_receipts_reused' })
  }

  if (!skipControl) {
    const label = opts.controlLabel ? safeName(opts.controlLabel) : stamp
    const path = join(outDir, `control-${label}.json`)
    const result = await runAndWrite('control', path, controlBuilder, {
      controlPath: opts.controlPath,
      ...(opts.controlOptions ?? {}),
    }, opts, checks)
    artifacts.controls.push({ label, ...receiptMeta(result.path) })
  } else {
    checks.push({ ok: true, component: 'receipt-bundle', check: 'control_receipts_reused' })
  }

  const hostPaths = passPaths([join(outDir, 'host.json')].filter(existsSync), EXPECTED.host, checks, 'host')
  const runtimePaths = passPaths(listReceiptFiles(outDir, 'runtime-'), EXPECTED.runtime, checks, 'runtime')
  const controlPaths = passPaths(listReceiptFiles(outDir, 'control-'), EXPECTED.control, checks, 'control')
  artifacts.host = receiptMeta(join(outDir, 'host.json'))
  artifacts.runtimes = listReceiptFiles(outDir, 'runtime-').map((path) => {
    const meta = receiptMeta(path)
    return { ...meta }
  })
  artifacts.controls = listReceiptFiles(outDir, 'control-').map((path) => {
    const meta = receiptMeta(path)
    return { ...meta }
  })
  const requiredControlVerbs = opts.requiredControlVerbs ?? ['start', 'stop']

  const targetEntries = bundleArtifactEntries({ artifacts })
  const targetReceiptRecords = []
  for (const entry of targetEntries) {
    const receipt = readReceipt(entry.path)
    if (receipt) targetReceiptRecords.push({ label: entry.label, receipt, checkedPath: entry.path })
  }
  addTargetConsistencyChecks(checks, artifacts.manifest, targetEntries, targetReceiptRecords, agents)
  if (starterMode) addStarterEvidenceValidation(checks, 'receipt-bundle', artifacts, agents)

  const gatePath = join(outDir, 'cutover-gate.json')
  const gateReceipt = await cutoverBuilder({
    agents,
    hostPath: hostPaths[0] ?? '',
    runtimePaths,
    controlPaths,
    requiredControlVerbs,
  })
  writeJson(gatePath, gateReceipt, { ...opts, force: true }, checks, 'cutover')
  checks.push({
    ok: gateReceipt.status === 'pass',
    component: 'receipt-bundle',
    check: 'cutover_gate_status_pass',
    path: gatePath,
    actual: gateReceipt.status,
  })
  artifacts.cutover_gate = receiptMeta(gatePath)
  secureBundleJsonFiles(outDir)

  const summary = summarize(checks)
  const bundle = {
    receipt_type: 'mupot-fleet-receipt-bundle/v1',
    generated_at: new Date().toISOString(),
    status: summary.status,
    summary,
    integrity: {
      algorithm: 'sha256',
      covers: 'receipt artifact files',
      excludes: ['manifest.json'],
    },
    inputs: {
      agents,
      out_dir: outDir,
      daemon_config: opts.daemonPath,
      inbox_handler_config: opts.inboxPath,
      control_config: opts.controlPath,
      install_receipt: opts.installReceiptPath || null,
      probe_receipts: opts.probeReceiptPaths ?? [],
      control_label: opts.controlLabel || null,
      required_control_verbs: requiredControlVerbs,
      exec_probes: Boolean(opts.execProbes),
      verify_only: verifyOnly,
      skip_host: skipHost,
      skip_runtime: skipRuntime,
      skip_control: skipControl,
      ...(starterMode ? { bundle_mode: 'starter-ready' } : {}),
    },
    artifacts,
    next_steps: [],
    checks,
  }
  try {
    writeJsonUnchecked(artifacts.manifest, bundle, { ...opts, force: true })
    checks.push({ ok: true, component: 'receipt-bundle', check: 'manifest_written', path: artifacts.manifest })
  } catch (err) {
    checks.push({ ok: false, component: 'receipt-bundle', check: 'manifest_written', path: artifacts.manifest, reason: String(err && err.message ? err.message : err) })
  }
  const finalSummary = summarize(checks)
  bundle.summary = finalSummary
  bundle.status = finalSummary.status
  bundle.next_steps = buildNextSteps({
    artifacts,
    agents,
    gateReceipt,
    outDir,
    bundleStatus: finalSummary.status,
    requiredControlVerbs,
    controlEvidence: controlEvidenceFromArtifacts(artifacts),
  })
  try {
    writeJsonUnchecked(artifacts.manifest, bundle, { ...opts, force: true })
  } catch {
    // The recorded manifest_written check above already captures the failure.
  }
  return bundle
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`receipt-bundle: ${err && err.message ? err.message : err}`)
    console.error(usage())
    process.exit(2)
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  if (opts.hostGoPlan) {
    process.stdout.write(formatHostGoPlan(opts))
    return
  }
  if (opts.export || opts.exportDir) {
    const receipt = exportBundle(opts)
    console.log(JSON.stringify(receipt, null, 2))
    process.exit(receipt.status === 'fail' ? 1 : 0)
  }
  if (opts.checkManifest) {
    const receipt = checkBundleManifest(opts)
    console.log(JSON.stringify(receipt, null, 2))
    process.exit(receipt.status === 'fail' ? 1 : 0)
  }
  if (opts.status) {
    const receipt = inspectBundleStatus(opts)
    process.stdout.write(opts.statusSummary ? formatStatusSummary(receipt) : `${JSON.stringify(receipt, null, 2)}\n`)
    process.exit(receipt.status === 'fail' ? 1 : 0)
  }
  const bundle = await buildBundle(opts)
  console.log(JSON.stringify(bundle, null, 2))
  process.exit(bundle.status === 'fail' ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { buildBundle, checkBundleManifest, defaultStamp, exportBundle, formatHostGoPlan, formatStatusSummary, inspectBundleStatus, parseArgs, safeName, summarize }
