#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  STARTER_ARTIFACT_ROLES,
  STARTER_CHECKS,
  STARTER_RECEIPT_TYPE,
  isPortableStarterPath,
  validateStarterManifest as validateContractManifest,
  validateStarterReceipt,
} from './starter-contract.mjs'
import { normalizeStarterEvidence } from './receipt-bundle.mjs'
import { SECRET_VALUE_PATTERNS } from './service-context.mjs'

const EXPECTED_TYPES = Object.freeze({
  install: 'mupot-fleet-install-receipt/v1',
  service: 'mupot-fleet-service-receipt/v1',
  host: 'mupot-fleet-host-receipt/v1',
  continuous: 'mupot-fleet-continuous-runtime-receipt/v1',
  runtime_inbox: 'mupot-fleet-runtime-receipt/v1',
  lifecycle_control_start: 'mupot-fleet-control-receipt/v1',
  lifecycle_control_stop: 'mupot-fleet-control-receipt/v1',
  receipt_bundle_manifest: 'mupot-fleet-receipt-bundle/v1',
})

const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function containsSecret(value, key = '') {
  if (SECRET_FIELD_RE.test(key)) return true
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some(([, pattern]) => pattern.test(value))
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry))
  if (!isPlainObject(value)) return false
  if (typeof value.kty === 'string' && typeof value.d === 'string') return true
  return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function containedRelativeFile(bundleDir, declaredPath) {
  if (!isPortableStarterPath(declaredPath)) throw new TypeError('starter evidence paths must be portable relative paths')
  const root = realpathSync(bundleDir)
  const path = resolve(root, declaredPath)
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('starter evidence path escapes the bundle')
  return { root, path }
}

function readContainedFile(bundleDir, declaredPath) {
  const { root, path } = containedRelativeFile(bundleDir, declaredPath)
  let fd = null
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const named = lstatSync(path)
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new TypeError('starter evidence must be a regular unlinked file')
    }
    const real = realpathSync(path)
    const rel = relative(root, real)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('starter evidence file escapes the bundle')
    return readFileSync(fd)
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError(`starter evidence is not a readable regular bundle file: ${basename(declaredPath)}`)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
  }
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (!isPlainObject(value)) throw new Error('not an object')
    return value
  } catch {
    throw new TypeError(`${label} must contain a JSON object`)
  }
}

export function validateStarterManifest(raw) {
  return validateContractManifest(raw)
}

function selectedAgents(manifest, requested) {
  const available = new Map(manifest.agents.map((agent) => [agent.agent_id, agent]))
  const ids = requested?.length ? requested : manifest.agents.map((agent) => agent.agent_id)
  if (new Set(ids).size !== ids.length) throw new TypeError('starter plan agent filters must be unique')
  const selected = ids.map((id) => {
    const agent = available.get(id)
    if (!agent) throw new TypeError(`unknown agent: ${id}`)
    return agent
  })
  if (selected.length === 0) throw new TypeError('starter plan requires at least one agent')
  return selected
}

function envSuffix(agentId) {
  return agentId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

export function renderStarterPlan(rawManifest, opts = {}) {
  const manifest = validateStarterManifest(rawManifest)
  const agents = selectedAgents(manifest, opts.agents)
  const manager = manifest.service_manager
  const manifestPath = opts.manifestPath || 'fleet-runtime/starter.example.json'
  const lines = [
    'Mupot forkable two-agent starter plan',
    '',
    `Tenant: ${manifest.tenant}`,
    `Base URL: ${manifest.base_url}`,
    `Service manager: ${manager}`,
    `Host agents: ${agents.map((agent) => agent.agent_id).join(', ')}`,
    `Control consumer: ${manifest.control_consumer_agent_id}`,
    '',
    'Keep credential values in the host secret manager. The names below are references only and must not be written to configs, receipts, service definitions, or this plan:',
    ...agents.map((agent) => `- \${MUPOT_AGENT_TOKEN_${envSuffix(agent.agent_id)}} for ${agent.agent_id}`),
    '- ${MUPOT_OWNER_TOKEN} for governed lifecycle requests',
    '',
    '1. Install the runtime layout without replacing operator-owned configuration and save its receipt:',
    commandLine(['mkdir', '-p', '~/.fleet/receipts']),
    commandLine(['node', 'fleet-runtime/install.mjs', '--service-manager', manager], ' > ~/.fleet/receipts/install.json'),
    '',
    '2. edit ~/.fleet/daemon.json, ~/.fleet/inbox-handler.json, ~/.fleet/control.json, and ~/.fleet/flights.json for this tenant and only the selected host agents.',
    commandLine(['node', 'fleet-runtime/trust-bootstrap.mjs', '--base-url', manifest.base_url]),
    '',
    '3. Activate user services and collect current service status:',
    commandLine(['node', 'fleet-runtime/service-manager.mjs', 'install', '--service-manager', manager]),
    commandLine(['node', 'fleet-runtime/service-manager.mjs', 'status', '--service-manager', manager], ' > ~/.fleet/receipts/service.json'),
  ]

  for (const agent of agents) {
    const agentId = agent.agent_id
    const agentTokenEnv = `MUPOT_AGENT_TOKEN_${envSuffix(agentId)}`
    const outDir = `~/.fleet/receipts/${agentId}`
    const exportDir = `${outDir}-attach`
    const commonBundle = ['node', 'fleet-runtime/receipt-bundle.mjs', '--agent', agentId, '--out-dir', outDir, '--require-control-verb', 'start,stop']
    const copyDefinitions = [
      'const fs=require("node:fs"),p=require("node:path"),r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
      'for(const d of r.definitions)fs.copyFileSync(d.path,p.join(process.argv[2],p.basename(d.path)))',
    ].join('')
    const artifactArgs = [
      ['install', 'install.json'],
      ['service', 'service.json'],
      ['host', 'host.json'],
      ['continuous', 'continuous.json'],
      ['runtime_inbox', `runtime-${agentId}.json`],
      ['lifecycle_control_start', 'control-start.json'],
      ['lifecycle_control_stop', 'control-stop.json'],
      ['receipt_bundle_manifest', 'prior-bundle-manifest.json'],
    ].flatMap(([role, path]) => ['--artifact', `${role}=${path}`])

    lines.push(
      '',
      `4. Collect governed Host-Go evidence for ${agentId}:`,
      commandLine(['mkdir', '-p', outDir]),
      commandLine(['node', 'fleet-runtime/host-receipt.mjs', '--require-services', '--service-manager', manager], ` > ${shellQuote(`${outDir}/host.json`)}`),
      commandLine([...commonBundle, '--install-receipt', '~/.fleet/receipts/install.json', '--skip-host', '--skip-runtime', '--skip-control']),
      '# Requires MUPOT_AGENT_TOKEN and MUPOT_OWNER_TOKEN in the environment.',
      commandLine(['node', 'fleet-runtime/cutover-probe.mjs', '--base-url', manifest.base_url, '--agent', agentId, '--agent-token-env', agentTokenEnv, '--queue-inbox', '--control', 'start'], ` > ${shellQuote(`${outDir}/probe-start.json`)}`),
      commandLine([...commonBundle, '--probe-receipt', `${outDir}/probe-start.json`, '--skip-host', '--control-label', 'start']),
      '# Requires MUPOT_OWNER_TOKEN in the environment.',
      commandLine(['node', 'fleet-runtime/cutover-probe.mjs', '--base-url', manifest.base_url, '--agent', agentId, '--control', 'stop'], ` > ${shellQuote(`${outDir}/probe-stop.json`)}`),
      commandLine([...commonBundle, '--probe-receipt', `${outDir}/probe-stop.json`, '--skip-host', '--skip-runtime', '--control-label', 'stop']),
      commandLine([...commonBundle, '--verify-only']),
      commandLine(['cp', `${outDir}/manifest.json`, `${outDir}/prior-bundle-manifest.json`]),
      '',
      `5. Bind ${agentId}'s complete evidence into a verified starter receipt:`,
      commandLine(['cp', manifestPath, `${outDir}/starter.example.json`]),
      commandLine(['cp', '~/.fleet/receipts/service.json', `${outDir}/service.json`]),
      commandLine(['node', '-e', copyDefinitions, `${outDir}/service.json`, outDir]),
      commandLine(['node', 'fleet-runtime/continuous-runtime-receipt.mjs', '--agent', agentId, '--service-manager', manager, '--require-control', 'start', '--require-control', 'stop'], ` > ${shellQuote(`${outDir}/continuous.json`)}`),
      commandLine(['node', 'fleet-runtime/starter-manifest.mjs', '--verify', '--bundle-dir', outDir, ...artifactArgs], ` > ${shellQuote(`${outDir}/starter-receipt.json`)}`),
      commandLine([...commonBundle, '--service-receipt', `${outDir}/service.json`, '--continuous-receipt', `${outDir}/continuous.json`, '--starter-receipt', `${outDir}/starter-receipt.json`, '--verify-only', '--force']),
      '',
      `6. Export and independently check ${agentId}'s attachable starter:`,
      commandLine(['node', 'fleet-runtime/receipt-bundle.mjs', '--export', '--out-dir', outDir, '--export-dir', exportDir]),
      commandLine(['node', 'fleet-runtime/receipt-bundle.mjs', '--check-manifest', '--out-dir', exportDir]),
    )
  }

  lines.push(
    '',
    '7. Data-preserving rollback:',
    commandLine(['node', 'fleet-runtime/service-manager.mjs', 'uninstall', '--service-manager', manager]),
    '',
    '8. Recovery reinstall and fresh advancement proof:',
    commandLine(['node', 'fleet-runtime/install.mjs', '--activate', '--service-manager', manager]),
    ...agents.map((agent) => commandLine(['node', 'fleet-runtime/continuous-runtime-receipt.mjs', '--agent', agent.agent_id, '--service-manager', manager, '--require-control', 'start', '--require-control', 'stop'])),
  )
  return `${lines.join('\n')}\n`
}

export function verifyStarterBundle(opts = {}) {
  const bundleDir = resolve(opts.bundleDir ?? '')
  if (!opts.bundleDir) throw new TypeError('starter verification requires a bundle directory')
  const manifestPath = opts.manifestPath ?? 'starter.example.json'
  const manifestBytes = readContainedFile(bundleDir, manifestPath)
  const manifest = validateStarterManifest(parseJson(manifestBytes, 'starter manifest'))
  if (!isPlainObject(opts.artifacts)) throw new TypeError('starter verification requires artifact paths')
  if (Object.keys(opts.artifacts).length !== STARTER_ARTIFACT_ROLES.length || STARTER_ARTIFACT_ROLES.some((role) => !Object.hasOwn(opts.artifacts, role))) {
    throw new TypeError('starter verification requires every exact evidence role')
  }

  const declaredPaths = [manifestPath, ...STARTER_ARTIFACT_ROLES.map((role) => opts.artifacts[role])]
  if (new Set(declaredPaths).size !== declaredPaths.length) throw new TypeError('starter evidence paths must be unique')
  const artifacts = []
  const receipts = {}
  for (const role of STARTER_ARTIFACT_ROLES) {
    const path = opts.artifacts[role]
    const bytes = readContainedFile(bundleDir, path)
    const receipt = parseJson(bytes, role)
    if (receipt.receipt_type !== EXPECTED_TYPES[role] || receipt.status !== 'pass') throw new TypeError(`${role} evidence must have the expected passing receipt type`)
    if (containsSecret(receipt)) throw new TypeError(`${role} evidence contains secret material`)
    receipts[role] = receipt
    artifacts.push({ role, path, sha256: sha256(bytes) })
  }

  const now = opts.now ?? (() => new Date())
  const receipt = validateStarterReceipt({
    receipt_type: STARTER_RECEIPT_TYPE,
    generated_at: now().toISOString(),
    status: 'pass',
    manifest: { path: manifestPath, sha256: sha256(manifestBytes) },
    artifacts,
    checks: STARTER_CHECKS.map((check) => ({ check, ok: true })),
  })
  const agentId = receipts.continuous?.agent?.agent_id
  const evidence = typeof agentId === 'string' && normalizeStarterEvidence({
    serviceReceipt: receipts.service,
    continuousReceipt: receipts.continuous,
    starterReceipt: receipt,
    hostReceipt: receipts.host,
    agents: [agentId],
    starterPath: join(bundleDir, 'starter-receipt.json'),
  })
  if (!evidence) throw new TypeError('starter evidence contracts or cross-bindings are invalid')
  return receipt
}

export function usage() {
  return [
    'Usage: node fleet-runtime/starter-manifest.mjs --validate|--plan|--verify [options]',
    '',
    'Modes:',
    '  --validate                validate and print a sterile starter manifest',
    '  --plan                    print a host-filtered starter lifecycle plan',
    '  --verify                  verify evidence and print a starter receipt',
    '',
    'Options:',
    '  --manifest <path>         starter manifest path',
    '  --bundle-dir <path>       root directory for portable evidence',
    '  --agent <agent-id>        host agent to include; repeatable',
    '  --artifact <role=path>    evidence path for --verify; repeatable',
    '  -h, --help                show this help',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = { mode: '', manifestPath: '', bundleDir: '', agents: [], artifacts: {}, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new TypeError(`${arg} requires a value`)
      return argv[index]
    }
    if (['--validate', '--plan', '--verify'].includes(arg)) {
      if (opts.mode) throw new TypeError('choose exactly one starter mode')
      opts.mode = arg.slice(2)
    } else if (arg === '--manifest') opts.manifestPath = next()
    else if (arg === '--bundle-dir') opts.bundleDir = next()
    else if (arg === '--agent') opts.agents.push(next())
    else if (arg === '--artifact') {
      const value = next()
      const separator = value.indexOf('=')
      if (separator <= 0 || separator === value.length - 1) throw new TypeError('--artifact requires role=path')
      const role = value.slice(0, separator)
      if (Object.hasOwn(opts.artifacts, role)) throw new TypeError(`duplicate artifact role: ${role}`)
      opts.artifacts[role] = value.slice(separator + 1)
    } else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new TypeError(`unknown argument: ${arg}`)
  }
  return opts
}

function readManifestForCli(path) {
  if (!path) throw new TypeError('--manifest is required')
  return parseJson(readFileSync(path), 'starter manifest')
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (!opts.mode) throw new TypeError('choose --validate, --plan, or --verify')
  if (opts.mode === 'validate') process.stdout.write(`${JSON.stringify(validateStarterManifest(readManifestForCli(opts.manifestPath)), null, 2)}\n`)
  if (opts.mode === 'plan') process.stdout.write(renderStarterPlan(readManifestForCli(opts.manifestPath), { agents: opts.agents, manifestPath: opts.manifestPath }))
  if (opts.mode === 'verify') process.stdout.write(`${JSON.stringify(verifyStarterBundle({ bundleDir: opts.bundleDir, ...(opts.manifestPath ? { manifestPath: opts.manifestPath } : {}), artifacts: opts.artifacts }), null, 2)}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
