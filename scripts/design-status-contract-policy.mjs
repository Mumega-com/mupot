import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Design-status contract policy (#603).
 *
 * Rule:
 * - Root JSON objects with contract id (`name/vN`) and `status: "design"` are
 *   allowed only in an explicit design-only location or with the approved
 *   machine-readable marker.
 * - Runtime/release registry paths must never carry `status: "design"`.
 *
 * Allowed design locations/markers:
 * - path under `docs/design-contracts/`
 * - top-level `"designOnly": true`
 *
 * Nested `status` fields (e.g. unmetDependencies) are ignored — only the
 * contract root status is policy-relevant.
 */

const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9-]*\/v[0-9]+$/
const DESIGN_STATUS = 'design'
const DESIGN_ONLY_DIR = 'docs/design-contracts/'
const DESIGN_ONLY_MARKER = 'designOnly'

const RUNTIME_RELEASE_PREFIXES = [
  'src/',
  'fleet-runtime/',
  'plugin/',
  'packs/',
  'deploy/',
  'connectors/',
  'docs/releases/',
]

const RUNTIME_RELEASE_FILES = new Set(['pots.manifest.json'])

const ALLOWED_LOCATIONS_HELP =
  'docs/design-contracts/** or top-level "designOnly": true'

const RUNTIME_HELP =
  'src/, fleet-runtime/, plugin/, packs/, deploy/, connectors/, docs/releases/, pots.manifest.json'

function parseRoot(args) {
  if (args.length === 0) return process.cwd()
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1])
  throw new Error('usage: node scripts/design-status-contract-policy.mjs [--root <repository>]')
}

function trackedFiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function displayPath(path) {
  return path.replaceAll('\r', '\\r').replaceAll('\n', '\\n')
}

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function isContractArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.id !== 'string' || typeof value.status !== 'string') return false
  return CONTRACT_ID_PATTERN.test(value.id)
}

function isRuntimeOrReleasePath(path) {
  const normalized = normalizePath(path)
  if (RUNTIME_RELEASE_FILES.has(normalized)) return true
  return RUNTIME_RELEASE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function isDesignOnlyLocation(path) {
  return normalizePath(path).startsWith(DESIGN_ONLY_DIR)
}

function hasDesignOnlyMarker(contract) {
  return contract[DESIGN_ONLY_MARKER] === true
}

function formatRuntimeViolation(path, contractId) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${DESIGN_STATUS}' in a runtime/release registry path.`,
    `  Runtime/release paths (${RUNTIME_HELP}) must not contain status '${DESIGN_STATUS}'.`,
    `  Remediation: remove this contract from the registry, or change status after implementation/gate evidence lands.`,
  ].join('\n')
}

function formatUnauthorizedDesignViolation(path, contractId) {
  return [
    `${displayPath(path)}: contract '${contractId}' has status '${DESIGN_STATUS}' but is not explicitly design-only.`,
    `  Allowed locations/markers: ${ALLOWED_LOCATIONS_HELP}.`,
    `  Remediation: move to ${DESIGN_ONLY_DIR} or set "${DESIGN_ONLY_MARKER}": true; promote status before shipping in runtime/release registries.`,
  ].join('\n')
}

function evaluateContract(path, contract) {
  if (contract.status !== DESIGN_STATUS) return null

  if (isRuntimeOrReleasePath(path)) {
    return formatRuntimeViolation(path, contract.id)
  }

  if (isDesignOnlyLocation(path) || hasDesignOnlyMarker(contract)) {
    return null
  }

  return formatUnauthorizedDesignViolation(path, contract.id)
}

function scanFile(path, text) {
  if (!normalizePath(path).endsWith('.json')) return []

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  if (!isContractArtifact(parsed)) return []

  const finding = evaluateContract(path, parsed)
  return finding === null ? [] : [finding]
}

function scan(root) {
  const findings = []

  for (const path of trackedFiles(root)) {
    const absolutePath = resolve(root, path)
    if (!lstatSync(absolutePath).isFile()) continue

    const text = decodeText(readFileSync(absolutePath))
    if (text === null) continue

    findings.push(...scanFile(path, text))
  }

  return findings
}

try {
  const root = parseRoot(process.argv.slice(2))
  const findings = scan(root)
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding)
    console.error(`design-status policy violations: ${findings.length}`)
    process.exitCode = 1
  } else {
    console.log('design-status contract policy: ok')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`design-status contract policy failed: ${message}`)
  process.exitCode = 2
}
